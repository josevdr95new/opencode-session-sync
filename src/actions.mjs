// opencode-sync · acciones compartidas por CLI y plugin OpenCode
// Orquesta config + motores + proveedores y devuelve mensajes localizados.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomPassphrase } from './crypto.mjs';
import { makeBackup, restoreBackup } from './backup.mjs';
import {
  detectConfigDir, detectDataDir, loadSyncConfig, loadAuth, parseSize,
  saveSyncConfig, saveAuth,
} from './config.mjs';
import { create, PROVIDER_NAMES } from './providers/index.mjs';
import { DEFAULT_LANG, detectLanguage, t } from './i18n.mjs';

export { PROVIDER_NAMES };

function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
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

/** makeBackup + push al proveedor. dryRun construye en temp sin subir. */
export function runBackup({
  lang,
  provider,
  output,
  dryRun = false,
  noEncrypt = false,
  env = process.env,
} = {}) {
  const L = lang || detectLanguage(env);
  const configDir = detectConfigDir(env);
  const dataDir = detectDataDir(env);
  const cfg = loadSyncConfig(configDir);
  const providerName = String(provider || cfg.provider || 'local').toLowerCase();
  const { encrypt, passphrase } = resolvePassphrase({ cfg, configDir, noEncrypt, env, lang: L });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocesync-'));
  let info;
  try {
    info = makeBackup({
      dataDir,
      configDir,
      passphrase,
      maxPartBytes: parseSize(cfg.parts),
      outDir: tmp,
      lang: L,
    });
    if (dryRun) {
      info.dryRun = true;
      info.dest = null;
      return { info, cfg, message: backupMessage(info, L, output) };
    }
    const prov = create(providerName);
    if (providerName === 'local') {
      const targetDir = output || cfg.localDir;
      info.dest = prov.push({ sourceDir: tmp, targetDir });
    } else if (providerName === 'github') {
      const auth = loadAuth(configDir, env);
      const token = env.OPENCODE_SYNC_TOKEN || auth.token;
      info.dest = `github.com/${cfg.owner}/${cfg.repo}`;
      prov.push({ sourceDir: tmp, owner: cfg.owner, repo: cfg.repo, token, lang: L });
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
  if (info.warnings?.includes('data_missing')) lines.push(t(lang, 'err.data_missing', { dir: '(dataDir)' }));
  if (info.warnings?.includes('config_missing')) lines.push(t(lang, 'err.config_missing', { dir: '(configDir)' }));
  for (const w of info.warnings || []) {
    if (w.startsWith('big_backup:')) {
      lines.push(t(lang, 'back.warning_big', { size: humanBytes(Number(w.split(':')[1])) }));
    }
  }
  return lines.join('\n');
}

/** pull desde el proveedor + restoreBackup. dryRun por defecto cuando no hay overwrite. */
export function runRestore({
  lang,
  from,
  dryRun,
  overwrite = false,
  env = process.env,
} = {}) {
  const L = lang || detectLanguage(env);
  const configDir = detectConfigDir(env);
  const dataDir = detectDataDir(env);
  const cfg = loadSyncConfig(configDir);
  const providerName = String(cfg.provider || 'local').toLowerCase();

  let sourceDir;
  if (from) {
    sourceDir = path.resolve(from);
    if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
      throw new Error(t(L, 'err.no_backup', { dir: sourceDir }));
    }
  } else {
    const prov = create(providerName);
    if (providerName === 'local') sourceDir = prov.pull(cfg.localDir, L);
    else if (providerName === 'github') {
      const auth = loadAuth(configDir, env);
      sourceDir = prov.pull({ owner: cfg.owner, repo: cfg.repo, token: env.OPENCODE_SYNC_TOKEN || auth.token, lang: L });
    } else {
      throw new Error(t(L, 'err.provider_unknown', { provider: providerName }));
    }
  }
  const { passphrase } = resolvePassphrase({ cfg, configDir, noEncrypt: false, env, lang: L });
  const shouldDryRun = dryRun === undefined || dryRun === null ? !overwrite : dryRun;
  const res = restoreBackup({
    sourceDir,
    targetDataDir: dataDir,
    targetConfigDir: configDir,
    passphrase,
    dryRun: shouldDryRun,
    overwrite,
    lang: L,
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
      back: cfg.provider === 'github' ? t(L, 'cli.status.github_repo', { repo: `${cfg.owner}/${cfg.repo}` }) : cfg.localDir,
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

/** setup: escribe sync.json (+sync-auth.json con passphrase generada si falta). */
export function runSetup({ lang, provider, parts, encrypt, env = process.env, answers = {} } = {}) {
  const L = lang || detectLanguage(env);
  const configDir = detectConfigDir(env);
  const prev = loadSyncConfig(configDir);
  const cfg = {
    ...prev,
    provider: provider || prev.provider,
  };
  if (parts) cfg.parts = parts;
  if (encrypt !== undefined) cfg.encrypt = encrypt;
  if (answers.owner) cfg.owner = answers.owner;
  if (answers.repo) cfg.repo = answers.repo;

  const authHandle = { ...loadAuth(configDir, env) };
  let generated = false;
  if (cfg.encrypt && answers.passphrase) authHandle.passphrase = answers.passphrase;
  if (cfg.encrypt && !authHandle.passphrase && !env.OPENCODE_SYNC_PASSPHRASE) {
    authHandle.passphrase = randomPassphrase();
    generated = true;
  }
  if (answers.token) authHandle.token = answers.token;

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
  if (generated) lines.push(t(L, 'cli.setup.pass_generated', { path: path.join(configDir, 'sync-auth.json') }));
  if (cfg.provider === 'github' && !authHandle.token && !env.OPENCODE_SYNC_TOKEN) {
    lines.push(t(L, 'cli.setup.token_hint', { path: path.join(configDir, 'sync-auth.json') }));
  }
  return { lines: lines.join('\n'), cfg, authHandle };
}

function saveBoth(cfg, auth, configDir) {
  saveSyncConfig(cfg, configDir);
  if (auth && (auth.passphrase || auth.token)) saveAuth(auth, configDir);
}

export { humanBytes };
