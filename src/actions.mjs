// opencode-sync · acciones compartidas por CLI y plugin OpenCode
// Orquesta config + motores + proveedores y devuelve mensajes localizados.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomPassphrase } from './crypto.mjs';
import { cancelledError, makeBackup, restoreBackup } from './backup.mjs';
import {
  detectConfigDir, detectDataDir, loadSyncConfig, loadAuth, parseSize,
  saveSyncConfig, saveAuth,
} from './config.mjs';
import { create, PROVIDER_NAMES } from './providers/index.mjs';
import { validateCreds as validateGithubCreds, maskToken } from './providers/github.mjs';
import { validateGDrive as validateGDriveCreds, DEFAULT_FOLDER_NAME } from './providers/gdrive.mjs';
import { DEFAULT_LANG, detectLanguage, t } from './i18n.mjs';

export { PROVIDER_NAMES };

function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Credenciales gdrive desde sync-auth.json (loadAuth ya mezcla los overrides por env). */
function gdriveCreds(auth) {
  return {
    clientId: auth?.gdriveClientId,
    clientSecret: auth?.gdriveClientSecret,
    refreshToken: auth?.gdriveRefreshToken,
  };
}

/** Lanza el error tipado .notFound con la clave i18n del.not_found. */
function notFoundError(lang, name, dir) {
  const e = new Error(t(lang, 'del.not_found', { name: String(name), dir }));
  e.notFound = true;
  e.resource = String(name);
  return e;
}

/**
 * Resolución de `from` para restore (dual, compat documentada):
 * 1) stamp o ruta DENTRO del dir de copias (validación anti-traversal estricta).
 * 2) compat: ruta ABSOLUTA a un dir de copia existente (restore --from <dir> que ya
 *    documentaba el repo y usaban tests/CLI; el motor igualmente rechaza traversal
 *    dentro del tar). Cualquier otra cosa -> .notFound.
 */
function resolveRestoreSource({ from, cfg, lang }) {
  const base = path.resolve(cfg.localDir);
  const raw = String(from);
  const inside = path.resolve(base, raw);
  if (inside === base || inside.startsWith(base + path.sep)) {
    if (fs.existsSync(path.join(inside, 'manifest.json'))) return inside;
    throw notFoundError(lang, raw, base);
  }
  const abs = path.resolve(raw);
  if (path.isAbsolute(raw) && fs.existsSync(path.join(abs, 'manifest.json'))) return abs;
  throw notFoundError(lang, raw, base);
}

/** AbortSignal ya consumido fuera del motor -> mismo error tipado 'cancelled'. */
function assertNotAborted(signal, lang) {
  if (signal?.aborted) throw cancelledError(lang);
}

/** Resuelve passphrase si el cifrado está activo; lanza error localizable si falta. */
function resolvePassphrase({ cfg, configDir, noEncrypt, env = process.env, lang = DEFAULT_LANG }) {
  const encrypt = Boolean(cfg.encrypt) && !noEncrypt;
  if (!encrypt) return { encrypt: false, passphrase: null };
  const auth = loadAuth(configDir, env);
  const passphrase = env.OPENCODE_SYNC_PASSPHRASE || auth.passphrase;
  if (!passphrase) throw new Error(t(lang, 'err.pass_missing'));
  return { encrypt: true, passphrase };
}

/** makeBackup + push al proveedor. dryRun construye en temp sin subir.
 *  GitHub/gDrive: si el push falla, el backup local NO se pierde — se guarda copia
 *  local y se avisa. La cancelación (signal) NO dispara fallback: sube tipada.
 *  `createProvider` es inyectable (tests sin red/git).
 *  `onProgress` se pasa tal cual al motor (throttle NO aquí: lo decide el emisor). */
export async function runBackup({
  lang,
  provider,
  output,
  dryRun = false,
  noEncrypt = false,
  env = process.env,
  createProvider = create,
  onProgress,
  signal,
} = {}) {
  const L = lang || detectLanguage(env);
  assertNotAborted(signal, L);
  const configDir = detectConfigDir(env);
  const dataDir = detectDataDir(env);
  const cfg = loadSyncConfig(configDir);
  const providerName = String(provider || cfg.provider || 'local').toLowerCase();
  const { encrypt, passphrase } = resolvePassphrase({ cfg, configDir, noEncrypt, env, lang: L });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocesync-'));
  let info;
  try {
    assertNotAborted(signal, L);
    info = await makeBackup({
      dataDir,
      configDir,
      passphrase,
      maxPartBytes: parseSize(cfg.parts),
      outDir: tmp,
      lang: L,
      onProgress,
      signal,
    });
    if (dryRun) {
      info.dryRun = true;
      info.dest = null;
      return { info, cfg, message: backupMessage(info, L, output) };
    }
    assertNotAborted(signal, L);
    const prov = createProvider(providerName);
    if (providerName === 'local') {
      const targetDir = output || cfg.localDir;
      info.dest = await prov.push({ sourceDir: tmp, targetDir });
    } else if (providerName === 'github') {
      const auth = loadAuth(configDir, env);
      const token = env.OPENCODE_SYNC_TOKEN || auth.token;
      const ghRepo = `${cfg.owner}/${cfg.repo}`;
      try {
        await prov.push({ sourceDir: tmp, owner: cfg.owner, repo: cfg.repo, token, lang: L });
        info.pushedTo = ghRepo;
        info.dest = `github.com/${ghRepo}`;
      } catch (err) {
        if (err?.cancelled) throw err; // cancelación: sube tipada, SIN fallback
        assertNotAborted(signal, L);
        // El push falla, pero el backup local NO se tira: guardar copia local + avisar.
        const localProv = createProvider('local');
        info.dest = await localProv.push({ sourceDir: tmp, targetDir: output || cfg.localDir });
        info.pushError = String(err?.message || err);
      }
    } else if (providerName === 'gdrive') {
      const auth = loadAuth(configDir, env);
      try {
        const pushed = await prov.push({ dir: tmp, creds: gdriveCreds(auth), folderId: cfg.folderId, lang: L, signal });
        info.pushedTo = 'gdrive';
        info.dest = pushed?.folderWebUrl || 'Google Drive';
      } catch (err) {
        if (err?.cancelled) throw err; // cancelación: sube tipada, SIN fallback
        assertNotAborted(signal, L);
        // El push falla, pero el backup local NO se tira: guardar copia local + avisar.
        const localProv = createProvider('local');
        info.dest = await localProv.push({ sourceDir: tmp, targetDir: output || cfg.localDir });
        info.pushError = String(err?.message || err);
      }
    } else {
      throw new Error(t(L, 'err.provider_unknown', { provider: providerName }));
    }
    return { info, cfg, message: backupMessage(info, L, null) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function backupMessage(info, lang, dryHint) {
  const enc = info.encrypted ? t(lang, 'back.encrypted_true') : t(lang, 'back.encrypted_false');
  const lines = [
    t(lang, 'back.summary', {
      files: info.manifest.counts.files,
      bytes: humanBytes(info.manifest.counts.bytes),
      parts: info.manifest.parts,
      size: humanBytes(info.manifest.size),
      checksum: info.manifest.checksum.slice(0, 12),
      encrypted: enc,
    }),
  ];
  if (dryHint) lines.push(t(lang, 'back.dryrun_build'));
  if (info.dest) lines.push(t(lang, 'back.dest', { dest: info.dest }));
  if (info.pushedTo === 'gdrive') lines.push(t(lang, 'back.pushed_gd'));
  else if (info.pushedTo) lines.push(t(lang, 'back.pushed_gh', { repo: info.pushedTo }));
  if (info.pushError) lines.push(t(lang, 'back.push_failed_warn', { detail: info.pushError }));
  if (info.warnings?.includes('data_missing')) lines.push(t(lang, 'err.data_missing', { dir: '(dataDir)' }));
  if (info.warnings?.includes('config_missing')) lines.push(t(lang, 'err.config_missing', { dir: '(configDir)' }));
  for (const w of info.warnings || []) {
    if (w.startsWith('big_backup:')) {
      lines.push(t(lang, 'back.warning_big', { size: humanBytes(Number(w.split(':')[1])) }));
    }
  }
  return lines.join('\n');
}

/** pull desde el proveedor + restoreBackup. dryRun por defecto cuando no hay overwrite.
 *  El pull (provider github/gdrive) ocurre SIEMPRE antes del plan/restore, también en dryRun.
 *  `from`: stamp/nombre de la copia (listLocal) a restaurar EN CONCRETO — para provider
 *  local resuelve el dir dentro de cfg.localDir con validación anti-traversal; para
 *  github/gdrive hace pull de ESE stamp. Sin `from`: la copia más reciente, como siempre.
 *  Compat: `from` con ruta ABSOLUTA a un dir con manifest.json sigue funcionando.
 *  Copia no encontrada -> error .notFound (el RPC lo mapea a 'not_found').
 *  `signal` se forwarda al motor y al pull (gdrive); cancelación sube tipada.
 *  `createProvider` es inyectable (tests sin red/git). */
export async function runRestore({
  lang,
  from,
  dryRun,
  overwrite = false,
  env = process.env,
  createProvider = create,
  onProgress,
  signal,
} = {}) {
  const L = lang || detectLanguage(env);
  assertNotAborted(signal, L);
  const configDir = detectConfigDir(env);
  const dataDir = detectDataDir(env);
  const cfg = loadSyncConfig(configDir);
  const providerName = String(cfg.provider || 'local').toLowerCase();

  let sourceDir;
  let cleanupPull = null;
  try {
    if (from) {
      if (providerName === 'local') {
        // stamp dentro del dir de copias (o ruta absoluta compat)
        sourceDir = resolveRestoreSource({ from, cfg, lang: L });
      } else if (providerName === 'github') {
        const auth = loadAuth(configDir, env);
        sourceDir = await createProvider('github').pull({
          owner: cfg.owner, repo: cfg.repo, token: env.OPENCODE_SYNC_TOKEN || auth.token, stamp: from, lang: L,
        });
      } else if (providerName === 'gdrive') {
        const auth = loadAuth(configDir, env);
        const pulled = await createProvider('gdrive').pull({
          creds: gdriveCreds(auth), folderId: cfg.folderId, stamp: from, lang: L, signal,
        });
        sourceDir = pulled.dir;
        cleanupPull = pulled.cleanup || null;
      } else {
        throw new Error(t(L, 'err.provider_unknown', { provider: providerName }));
      }
    } else {
      const prov = createProvider(providerName);
      if (providerName === 'local') sourceDir = await prov.pull(cfg.localDir, L);
      else if (providerName === 'github') {
        const auth = loadAuth(configDir, env);
        sourceDir = await prov.pull({ owner: cfg.owner, repo: cfg.repo, token: env.OPENCODE_SYNC_TOKEN || auth.token, lang: L });
      } else if (providerName === 'gdrive') {
        const auth = loadAuth(configDir, env);
        const pulled = await prov.pull({ creds: gdriveCreds(auth), folderId: cfg.folderId, lang: L, signal });
        sourceDir = pulled.dir;
        cleanupPull = pulled.cleanup || null;
      } else {
        throw new Error(t(L, 'err.provider_unknown', { provider: providerName }));
      }
    }
    const { passphrase } = resolvePassphrase({ cfg, configDir, noEncrypt: false, env, lang: L });
    const shouldDryRun = dryRun === undefined || dryRun === null ? !overwrite : dryRun;
    const res = await restoreBackup({
      sourceDir,
      targetDataDir: dataDir,
      targetConfigDir: configDir,
      passphrase,
      dryRun: shouldDryRun,
      overwrite,
      lang: L,
      onProgress,
      signal,
    });
    if (shouldDryRun) {
      return {
        result: res,
        message: t(L, 'back.dryrun', {
          files: res.files,
          bytes: humanBytes(res.bytes),
          dataDir,
          configDir,
        }),
      };
    }
    const lines = [
      t(L, 'back.restored', { files: res.files, skipped: res.skipped }),
      t(L, 'back.restore_targets', { dataDir, configDir }),
    ];
    if (res.skipped > 0) lines.push(t(L, 'back.skipped_hint'));
    return { result: res, message: lines.join('\n') };
  } finally {
    if (cleanupPull) { try { cleanupPull(); } catch { /* noop */ } }
  }
}

/** Informe de status: rutas, proveedor, última copia y cifrado. */
export function getStatus({ lang, env = process.env } = {}) {
  const L = lang || detectLanguage(env);
  const configDir = detectConfigDir(env);
  const dataDir = detectDataDir(env);
  const cfg = loadSyncConfig(configDir);
  const auth = loadAuth(configDir, env);
  const lines = [
    t(L, 'cli.status.data_dir', { dir: dataDir, ok: fs.existsSync(dataDir) ? '✓' : '✗' }),
    t(L, 'cli.status.config_dir', { dir: configDir }),
    t(L, 'cli.status.provider', {
      provider: cfg.provider,
      back: cfg.provider === 'github'
        ? t(L, 'cli.status.github_repo', { repo: `${cfg.owner}/${cfg.repo}` })
        : cfg.provider === 'gdrive'
          ? (cfg.user || cfg.folderId || DEFAULT_FOLDER_NAME)
          : cfg.localDir,
    }),
    t(L, 'cli.status.parts', { parts: cfg.parts }),
    t(L, 'cli.status.encrypt', { encrypt: cfg.encrypt ? t(L, 'cli.status.on') : t(L, 'cli.status.off') }),
    t(L, 'cli.status.auth', { auth: auth.token || auth.passphrase ? t(L, 'cli.status.on') : t(L, 'cli.status.off') }),
  ];
  let last = null;
  const prov = create(cfg.provider === 'github' ? 'github' : 'local');
  try {
    if (cfg.provider === 'github') {
      const cache = path.join(os.tmpdir(), 'opencode-session-sync-cache', `${cfg.owner}--${cfg.repo}`);
      const manifestPath = path.join(cache, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        last = { dir: cache, stamp: `github.com/${cfg.owner}/${cfg.repo}`, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
      }
    } else {
      const list = prov.list(cfg.localDir);
      if (list.length) last = list[0];
    }
  } catch { last = null; }
  if (!last) lines.push(t(L, 'cli.status.none'));
  else {
    const m = last.manifest || {};
    lines.push(t(L, 'cli.status.last', {
      stamp: last.stamp || '-', parts: m.parts ?? '-', size: humanBytes(m.size ?? 0),
      date: m.date || '-', encrypted: m.encrypted ? t(L, 'cli.status.on') : t(L, 'cli.status.off'),
      dir: last.dir || '',
    }));
  }
  return { lines: lines.join('\n'), info: { cfg, configDir, dataDir, last } };
}

/** setup: escribe sync.json (+sync-auth.json con passphrase generada si falta).
 *  provider 'github' con {owner, repo, token}: valida credenciales contra la API REST
 *  de GitHub ANTES de persistir (`validate` inyectable para tests). El token se guarda
 *  SOLO en sync-auth.json, nunca en sync.json ni en el resultado.
 *  provider 'gdrive' con {clientId, clientSecret, refreshToken, folderName?}: valida
 *  contra la API de Google Drive (`validateGDrive` inyectable) y guarda cfg {provider,
 *  folderId, user}; los secrets SOLO viven en sync-auth.json.
 *  `test` (opt-in, conexión desde la GUI): modo ESTRICTO — EXIGE credenciales completas
 *  y las valida contra la API ANTES de persistir; sin credenciales completas es ERROR
 *  (nada se escribe en disco). local+test: verifica que el dir de copias existe y es
 *  ESCRIBIBLE (fichero sonda .write-test). Sin `test` (CLI/env): flujo histórico intacto
 *  (sin creds persiste + hint, sin validar).
 *  Devuelve { lines, message, cfg, login?, repo?, user?, folderId?, verified, authHandle }.
 *  `verified` lista los checks superados: ['token','repo-push'] | ['auth','folder'] | ['writable']. */
export async function runSetup({
  lang, provider, parts, encrypt, env = process.env, answers = {},
  test = false,
  validate = validateGithubCreds, validateGDrive = validateGDriveCreds,
} = {}) {
  const L = lang || detectLanguage(env);
  const configDir = detectConfigDir(env);
  const prev = loadSyncConfig(configDir);
  const providerName = String(provider || prev.provider || 'local').toLowerCase();
  if (!PROVIDER_NAMES.includes(providerName)) {
    throw new Error(t(L, 'err.provider_unknown', { provider: providerName }));
  }
  const cfg = { ...prev, provider: providerName };
  if (parts) cfg.parts = parts;
  if (encrypt !== undefined) cfg.encrypt = encrypt;
  if (answers.owner) cfg.owner = answers.owner;
  if (answers.repo) cfg.repo = answers.repo;
  delete cfg.token; // defensa: el token NUNCA vive en sync.json
  // defensa: los secrets de gdrive NUNCA viven en sync.json
  for (const k of ['clientId', 'clientSecret', 'refreshToken', 'gdriveClientId', 'gdriveClientSecret', 'gdriveRefreshToken']) {
    delete cfg[k];
  }

  const authHandle = { ...loadAuth(configDir, env) };
  let generated = false;
  if (cfg.encrypt && answers.passphrase) authHandle.passphrase = answers.passphrase;
  if (cfg.encrypt && !authHandle.passphrase && !env.OPENCODE_SYNC_PASSPHRASE) {
    authHandle.passphrase = randomPassphrase();
    generated = true;
  }
  if (answers.token) authHandle.token = answers.token;

  // GitHub: validar credenciales vía API REST antes de escribir nada en disco.
  // Con `test` (GUI): credenciales completas OBLIGATORIAS — si falta algo es ERROR.
  let login = null, repoFull = null, tail = null;
  const verified = [];
  if (providerName === 'github') {
    const token = authHandle.token || env.OPENCODE_SYNC_TOKEN;
    if (test) {
      if (!cfg.owner || !cfg.repo || !token) {
        throw new Error(t(L, 'err.setup_incomplete'));
      }
      const v = await validate({ owner: cfg.owner, repo: cfg.repo, token, lang: L });
      login = v.login;
      repoFull = v.repo || `${cfg.owner}/${cfg.repo}`;
      tail = maskToken(token);
      verified.push('token', 'repo-push');
    } else if (token && cfg.owner && cfg.repo) {
      const v = await validate({ owner: cfg.owner, repo: cfg.repo, token, lang: L });
      login = v.login;
      repoFull = v.repo || `${cfg.owner}/${cfg.repo}`;
      tail = maskToken(token);
    }
  }

  // Google Drive: validar credenciales vía API antes de escribir nada en disco.
  // cfg guarda SOLO {provider, folderId, user}; secrets en sync-auth.json.
  // Sin credenciales completas NO valida (como github con token_hint): persiste y avisa.
  // Con `test` (GUI): credenciales completas OBLIGATORIAS — si falta algo es ERROR.
  let gdUser = null, gdFolderId = null, gdFolderName = null;
  if (providerName === 'gdrive') {
    const creds = {
      clientId: answers.clientId || authHandle.gdriveClientId,
      clientSecret: answers.clientSecret || authHandle.gdriveClientSecret,
      refreshToken: answers.refreshToken || authHandle.gdriveRefreshToken,
    };
    gdFolderName = answers.folderName || undefined;
    if (test) {
      if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
        throw new Error(t(L, 'err.gdrive_creds'));
      }
      const v = await validateGDrive({ ...creds, folderName: gdFolderName, lang: L });
      gdUser = v.user;
      gdFolderId = v.folderId;
      gdFolderName = v.folderName || gdFolderName || DEFAULT_FOLDER_NAME;
      cfg.folderId = v.folderId;
      cfg.user = v.user || null;
      authHandle.gdriveClientId = creds.clientId;
      authHandle.gdriveClientSecret = creds.clientSecret;
      authHandle.gdriveRefreshToken = creds.refreshToken;
      verified.push('auth', 'folder');
    } else if (creds.clientId && creds.clientSecret && creds.refreshToken) {
      const v = await validateGDrive({ ...creds, folderName: gdFolderName, lang: L });
      gdUser = v.user;
      gdFolderId = v.folderId;
      gdFolderName = v.folderName || gdFolderName || DEFAULT_FOLDER_NAME;
      cfg.folderId = v.folderId;
      cfg.user = v.user || null;
      authHandle.gdriveClientId = creds.clientId;
      authHandle.gdriveClientSecret = creds.clientSecret;
      authHandle.gdriveRefreshToken = creds.refreshToken;
    }
  }

  // Local + `test` (GUI): validación REAL de escritura del dir de copias, ANTES de
  // persistir (si falla, NADA se escribe en disco). Crea el dir si falta y comprueba
  // que se puede escribir con un fichero sonda (.write-test): escribir, leer y borrar.
  let localDirVerified = null;
  if (providerName === 'local' && test) {
    const dir = path.resolve(cfg.localDir);
    const probe = path.join(dir, '.write-test');
    const CONTENT = 'opencode-session-sync .write-test';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, CONTENT, 'utf8');
      const readBack = fs.readFileSync(probe, 'utf8');
      if (readBack !== CONTENT) throw new Error('write-test: contenido leído no coincide');
      verified.push('writable');
      localDirVerified = dir;
    } catch (err) {
      throw new Error(t(L, 'err.local_not_writable', { dir }));
    } finally {
      try { fs.rmSync(probe, { force: true }); } catch { /* noop */ }
    }
  }

  const cfgPath = path.join(configDir, 'sync.json');
  saveBoth(cfg, authHandle, configDir);
  const lines = [
    t(L, 'cli.setup.done', { path: cfgPath }),
    t(L, 'cli.setup.summary', {
      provider: cfg.provider,
      localDir: cfg.localDir,
      parts: cfg.parts,
      encrypt: cfg.encrypt ? t(L, 'cli.status.on') : t(L, 'cli.status.off'),
    }),
  ];
  if (login) lines.push(t(L, 'cli.setup.gh_validated', { login, repo: repoFull, tail }));
  if (gdUser !== null || gdFolderId) {
    lines.push(t(L, 'cli.setup.gd_validated', {
      user: gdUser || '?',
      folder: gdFolderName || DEFAULT_FOLDER_NAME,
      folderId: gdFolderId || '?',
    }));
  }
  // Mensaje de éxito enriquecido (solo tras `test` SUPERADO): qué se verificó, explícito.
  if (verified.length) {
    if (providerName === 'github') {
      lines.push(t(L, 'back.setup_verified_gh', { owner: cfg.owner, repo: repoFull || cfg.repo }));
    } else if (providerName === 'gdrive') {
      lines.push(t(L, 'back.setup_verified_gd', {
        user: gdUser || '?',
        folder: gdFolderName || gdFolderId || DEFAULT_FOLDER_NAME,
      }));
    } else {
      lines.push(t(L, 'back.setup_verified_local', { dir: localDirVerified || cfg.localDir }));
    }
  }
  if (generated) lines.push(t(L, 'cli.setup.pass_generated', { path: path.join(configDir, 'sync-auth.json') }));
  if (cfg.provider === 'github' && !authHandle.token && !env.OPENCODE_SYNC_TOKEN) {
    lines.push(t(L, 'cli.setup.token_hint', { path: path.join(configDir, 'sync-auth.json') }));
  }
  if (cfg.provider === 'gdrive' && !authHandle.gdriveRefreshToken && !env.OPENCODE_GDRIVE_REFRESH) {
    lines.push(t(L, 'cli.setup.gd_hint', { path: path.join(configDir, 'sync-auth.json') }));
  }
  const message = lines.join('\n');
  return { lines: message, message, cfg, login, repo: repoFull, user: gdUser, folderId: gdFolderId, verified, authHandle };
}

function saveBoth(cfg, auth, configDir) {
  saveSyncConfig(cfg, configDir);
  if (auth && (auth.passphrase || auth.token || auth.gdriveRefreshToken || auth.gdriveClientId)) saveAuth(auth, configDir);
}

/** BORRA una copia: runDeleteLocal({name, lang, env, createProvider}).
 *  `name` es el stamp/nombre de la copia tal como aparece en listLocal (o la ruta
 *  absoluta de esa copia dentro del dir de copias). Validación de seguridad SIEMPRE:
 *  el path resuelto DEBE quedar DENTRO de cfg.localDir (path.resolve + startsWith + sep)
 *  — traversal/ruta fuera -> not_found, haya o no proveedor remoto.
 *  Borra SOLAMENTE manifest.json + part.NNN de esa copia y el dir si queda vacío.
 *  Con provider gdrive TAMBIÉN borra la copia remota (deleteRemote): si existe local
 *  borra ambas; si NO existe local borra solo la remota; si borra remota falla,
 *  devuelve el message con un aviso (no lanza), salvo que tampoco hubiera local
 *  (entonces el not_found del stamp remoto sube tipado). -> { message, deleted? } */
export async function runDeleteLocal({ name, lang, env = process.env, createProvider = create } = {}) {
  const L = lang || detectLanguage(env);
  const configDir = detectConfigDir(env);
  const cfg = loadSyncConfig(configDir);
  const providerName = String(cfg.provider || 'local').toLowerCase();
  const raw = String(name ?? '');
  if (!raw) throw notFoundError(L, raw, cfg.localDir);
  const base = path.resolve(cfg.localDir);
  const inside = path.resolve(base, raw);
  const isInside = inside !== base && inside.startsWith(base + path.sep);
  if (!isInside) throw notFoundError(L, raw, base); // traversal / ruta fuera: rechazada SIEMPRE
  const hasLocal = fs.existsSync(path.join(inside, 'manifest.json'));
  const isGdrive = providerName === 'gdrive';
  if (!hasLocal && !isGdrive) throw notFoundError(L, raw, base);

  let deletedLocal = false;
  if (hasLocal) {
    const files = fs.readdirSync(inside).filter((f) => f === 'manifest.json' || /^part\.\d{3}$/.test(f));
    for (const f of files) {
      try { fs.rmSync(path.join(inside, f), { force: true }); } catch { /* noop */ }
    }
    try { fs.rmdirSync(inside); } catch { /* no vacía (ajenos a la copia): se deja */ }
    deletedLocal = true;
  }

  let message = t(L, 'del.deleted', { name: raw });
  if (isGdrive) {
    try {
      const auth = loadAuth(configDir, env);
      await createProvider('gdrive').deleteRemote({
        stamp: raw, creds: gdriveCreds(auth), folderId: cfg.folderId, lang: L,
      });
      message = deletedLocal
        ? message + '\n' + t(L, 'del.remote_done')
        : t(L, 'del.deleted_remote_only', { name: raw });
    } catch (err) {
      if (!deletedLocal && err?.notFound) throw err; // ni local ni remota: not_found tipado
      // la copia local SÍ se borró; el fallo remoto se informa como aviso
      message += '\n' + t(L, 'del.remote_warn', { detail: String(err?.message || err) });
    }
  }
  return deletedLocal ? { message, deleted: inside } : { message };
}

const REVEAL_KINDS = ['backups', 'config', 'data'];

/** ABRE una carpeta del sistema (reveal): runReveal({kind, lang, env, spawnFn}).
 *  `kind` es un ENUM CERRADO ('backups' | 'config' | 'data') — JAMÁS un path del cliente:
 *  'backups' -> cfg.localDir · 'config' -> configDir · 'data' -> dataDir.
 *  Dir inexistente -> error .notFound. Lanza el opener detachado según plataforma
 *  (explorer.exe/open/xdg-open) con spawn inyectable para tests. -> { message, dir } */
export function runReveal({ kind, lang, env = process.env, spawnFn = nodeSpawn } = {}) {
  const L = lang || detectLanguage(env);
  if (!REVEAL_KINDS.includes(kind)) {
    throw new Error(t(L, 'del.bad_kind', { kind: String(kind) }));
  }
  const configDir = detectConfigDir(env);
  const dataDir = detectDataDir(env);
  const cfg = loadSyncConfig(configDir);
  const dir = kind === 'backups'
    ? path.resolve(cfg.localDir)
    : kind === 'config' ? path.resolve(configDir) : path.resolve(dataDir);
  if (!fs.existsSync(dir)) {
    const e = new Error(t(L, 'del.reveal_missing', { dir }));
    e.notFound = true;
    e.resource = String(kind);
    throw e;
  }
  const openers = { win32: ['explorer.exe'], darwin: ['open'], linux: ['xdg-open'] };
  const [cmd] = openers[process.platform] || openers.linux;
  const child = spawnFn(cmd, [dir], { detached: true, stdio: 'ignore' });
  if (child && typeof child.unref === 'function') child.unref();
  return { message: t(L, 'del.revealed', { dir }), dir, platform: process.platform, cmd };
}

export { humanBytes };
