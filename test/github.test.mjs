// github: validación de credenciales vía API REST (fetch inyectable, sin red),
// setup con token SOLO en sync-auth.json, backup con push automático (fallback
// local si el push falla) y restore/dryRun con pull previo. Todo con temp dirs:
// NUNCA toca el opencode.db/config reales del usuario.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCreds, maskToken } from '../src/providers/github.mjs';
import { runSetup, runBackup, runRestore, getStatus } from '../src/actions.mjs';
import { makeBackup } from '../src/backup.mjs';
import { create as realCreate } from '../src/providers/index.mjs';
import { t } from '../src/i18n.mjs';
import { parseArgs, main } from '../src/cli.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-gh-${n}-`));

/** Entorno aislado: dataDir+configDir temporales con sync.json/sync-auth.json de mentira. */
function tempEnv({ cfg = {}, auth = {} } = {}) {
  const base = mkTemp('env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.alloc(128, 7));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({ encrypt: false, ...cfg }));
  if (Object.keys(auth).length) {
    fs.writeFileSync(path.join(configDir, 'sync-auth.json'), JSON.stringify(auth));
  }
  return { base, dataDir, configDir, env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir } };
}

/** fetch falso sin red: rutas por URL exacta, graba cada llamada (url + init). */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`url inesperada en el test: ${url}`);
    if (route.throw) throw route.throw;
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  };
  return { fetchImpl, calls };
}

const U = 'https://api.github.com/user';
const R = 'https://api.github.com/repos/octo/ses';
const userOK = { status: 200, body: { login: 'octo' } };
const repoOK = (push = true) => ({ status: 200, body: { full_name: 'octo/ses', permissions: { push } } });

// ---------------------------------------------------------------- validateCreds

test('validateCreds: ok -> {ok, login, repo} con headers/urls correctos y sin token en el resultado', async () => {
  const { fetchImpl, calls } = fakeFetch({ [U]: userOK, [R]: repoOK(true) });
  const v = await validateCreds({ owner: 'octo', repo: 'ses', token: 'ghp_abc12345', lang: 'es', fetch: fetchImpl });
  assert.deepEqual(v, { ok: true, login: 'octo', repo: 'octo/ses' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, U);
  assert.equal(calls[1].url, R);
  for (const c of calls) {
    assert.equal(c.init.headers.Authorization, 'Bearer ghp_abc12345');
    assert.equal(c.init.headers['User-Agent'], 'opencode-session-sync');
    assert.equal(c.init.headers.Accept, 'application/vnd.github+json');
  }
  assert.ok(!JSON.stringify(v).includes('ghp_abc12345'));
});

test('validateCreds: 401 en /user -> err.token_invalid (es y en)', async () => {
  for (const lang of ['es', 'en']) {
    const { fetchImpl, calls } = fakeFetch({ [U]: { status: 401, body: { message: 'Bad credentials' } } });
    await assert.rejects(
      validateCreds({ owner: 'octo', repo: 'ses', token: 'bad', lang, fetch: fetchImpl }),
      (e) => e.message === t(lang, 'err.token_invalid')
    );
    assert.equal(calls.length, 1); // no sigue a /repos si el token es inválido
  }
});

test('validateCreds: 404 en /repos -> err.repo_not_found; permissions.push != true -> err.no_push', async () => {
  const a = fakeFetch({ [U]: userOK, [R]: { status: 404, body: {} } });
  await assert.rejects(
    validateCreds({ owner: 'octo', repo: 'ses', token: 't', lang: 'es', fetch: a.fetchImpl }),
    (e) => e.message === t('es', 'err.repo_not_found', { repo: 'octo/ses' })
  );
  const b = fakeFetch({ [U]: userOK, [R]: repoOK(false) });
  await assert.rejects(
    validateCreds({ owner: 'octo', repo: 'ses', token: 't', lang: 'es', fetch: b.fetchImpl }),
    (e) => e.message === t('es', 'err.no_push', { repo: 'octo/ses' })
  );
});

test('validateCreds: red caída y HTTP 500 -> err.gh_api; sin token -> err.token_missing sin llamar a fetch', async () => {
  const net = fakeFetch({ [U]: { throw: new Error('ECONNREFUSED') } });
  await assert.rejects(
    validateCreds({ owner: 'octo', repo: 'ses', token: 't', lang: 'es', fetch: net.fetchImpl }),
    (e) => e.message === t('es', 'err.gh_api', { detail: 'ECONNREFUSED' })
  );
  const srv = fakeFetch({ [U]: { status: 500, body: {} } });
  await assert.rejects(
    validateCreds({ owner: 'octo', repo: 'ses', token: 't', lang: 'es', fetch: srv.fetchImpl }),
    (e) => e.message === t('es', 'err.gh_api', { detail: 'HTTP 500 (GET /user)' })
  );
  let fetchCalled = false;
  await assert.rejects(
    validateCreds({ owner: 'octo', repo: 'ses', lang: 'es', fetch: async () => { fetchCalled = true; return userOK; } }),
    (e) => e.message === t('es', 'err.token_missing')
  );
  assert.equal(fetchCalled, false);
});

test('maskToken: prefijo 4 + … + últimos 4; nunca el token completo', () => {
  assert.equal(maskToken('ghp_abcdef1234'), 'ghp_…1234');
  assert.equal(maskToken('corto'), '…');
  assert.equal(maskToken(undefined), '…');
});

// ---------------------------------------------------------------- runSetup

test('runSetup github: valida con validate inyectada, guarda cfg SIN token y authHandle CON token', async () => {
  const te = tempEnv();
  let validated = null;
  const validate = async (args) => { validated = args; return { ok: true, login: 'octo', repo: 'octo/ses' }; };
  const res = await runSetup({
    lang: 'es', provider: 'github', env: te.env,
    answers: { owner: 'octo', repo: 'ses', token: 'ghp_secret1234' },
    validate,
  });
  assert.deepEqual(validated, { owner: 'octo', repo: 'ses', token: 'ghp_secret1234', lang: 'es' });
  assert.equal(res.login, 'octo');
  assert.equal(res.repo, 'octo/ses');
  assert.equal(res.message, res.lines);
  assert.ok(res.message.includes('octo/ses'));
  const cfgOnDisk = JSON.parse(fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8'));
  assert.equal(cfgOnDisk.provider, 'github');
  assert.equal(cfgOnDisk.owner, 'octo');
  assert.equal(cfgOnDisk.repo, 'ses');
  assert.ok(!('token' in cfgOnDisk), 'sync.json NO debe contener el token');
  const authOnDisk = JSON.parse(fs.readFileSync(path.join(te.configDir, 'sync-auth.json'), 'utf8'));
  assert.equal(authOnDisk.token, 'ghp_secret1234');
  // shapes públicos (lines/cfg/login/repo) jamás exponen el token
  assert.ok(!JSON.stringify({ lines: res.lines, cfg: res.cfg, login: res.login, repo: res.repo }).includes('ghp_secret1234'));
});

test('runSetup github: credenciales inválidas -> lanza y NO persiste los cambios', async () => {
  const te = tempEnv(); // sync.json inicial ya existe (contenido previo conocido)
  const before = fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8');
  const validate = async () => { throw new Error(t('es', 'err.no_push', { repo: 'o/r' })); };
  await assert.rejects(
    runSetup({ lang: 'es', provider: 'github', env: te.env, answers: { owner: 'o', repo: 'r', token: 'x' }, validate }),
    (e) => e.message === t('es', 'err.no_push', { repo: 'o/r' })
  );
  assert.equal(
    fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8'),
    before,
    'sync.json queda intacto tras un setup fallido'
  );
  assert.ok(!fs.existsSync(path.join(te.configDir, 'sync-auth.json')));
});

test('runSetup local: sigue funcionando sin validar (retrocompat) y sin login/repo', async () => {
  const te = tempEnv();
  const res = await runSetup({ lang: 'es', provider: 'local', env: te.env, answers: {} });
  assert.equal(res.cfg.provider, 'local');
  assert.equal(res.login, null);
  assert.equal(res.repo, null);
  assert.ok(fs.existsSync(path.join(te.configDir, 'sync.json')));
});

// ---------------------------------------------------------------- runBackup

test('runBackup github: llama a push con sourceDir válido y message incluye "subido a GitHub owner/repo"', async () => {
  const te = tempEnv({ cfg: { provider: 'github', owner: 'octo', repo: 'ses' }, auth: { token: 'tok-1234' } });
  const pushes = [];
  // capturar el contenido del sourceDir DENTRO del push: runBackup borra el tmp en su finally
  const gh = {
    name: 'github',
    push: (args) => { pushes.push({ ...args, files: fs.readdirSync(args.sourceDir) }); return { pushed: true }; },
  };
  const res = await runBackup({
    lang: 'es', env: te.env,
    createProvider: (n) => (n === 'github' ? gh : realCreate(n)),
  });
  assert.equal(pushes.length, 1);
  const args = pushes[0];
  assert.equal(args.owner, 'octo');
  assert.equal(args.repo, 'ses');
  assert.equal(args.token, 'tok-1234');
  assert.ok(args.files.includes('manifest.json'), 'sourceDir contiene manifest.json');
  assert.ok(args.files.some((f) => /^part\.\d{3}$/.test(f)), 'sourceDir contiene part.*');
  assert.ok(res.message.includes(t('es', 'back.pushed_gh', { repo: 'octo/ses' })));
  assert.equal(res.info.dest, 'github.com/octo/ses');
  assert.equal(res.info.pushedTo, 'octo/ses');
});

test('runBackup github: push falla -> NO se pierde el backup (copia local en localDir) + aviso con la traza', async () => {
  const te = tempEnv({ cfg: { provider: 'github', owner: 'octo', repo: 'ses' }, auth: { token: 'tok-1234' } });
  const pushes = [];
  const gh = {
    name: 'github',
    push: (args) => { pushes.push(args); throw new Error('boom-detalle'); },
  };
  const res = await runBackup({
    lang: 'es', env: te.env,
    createProvider: (n) => (n === 'github' ? gh : realCreate(n)),
  });
  assert.equal(pushes.length, 1);
  const localDir = path.join(te.configDir, 'sync-backup');
  const stamps = fs.readdirSync(localDir);
  assert.equal(stamps.length, 1, 'la copia local quedó guardada en cfg.localDir');
  assert.ok(fs.existsSync(path.join(localDir, stamps[0], 'manifest.json')));
  assert.ok(fs.readdirSync(path.join(localDir, stamps[0])).some((f) => /^part\.\d{3}$/.test(f)));
  assert.equal(res.info.pushError, 'boom-detalle');
  assert.ok(res.message.includes(t('es', 'back.push_failed_warn', { detail: 'boom-detalle' })));
  assert.ok(res.message.includes('boom-detalle'), 'el message incluye la traza del error de subida');
  assert.equal(res.info.dest, path.join(localDir, stamps[0]));
});

// ---------------------------------------------------------------- runRestore

test('runRestore github: pull antes de restaurar (dryRun también) con {owner, repo, token, lang}', async () => {
  const te = tempEnv({ cfg: { provider: 'github', owner: 'octo', repo: 'ses' }, auth: { token: 'tok-1234' } });
  // "remoto": backup real construido en temp (mismos dataDir/configDir del entorno aislado)
  const remoteDir = mkTemp('remote');
  await makeBackup({ dataDir: te.dataDir, configDir: te.configDir, outDir: remoteDir, maxPartBytes: 256 * 1024 });
  const pulls = [];
  const gh = { name: 'github', pull: (args) => { pulls.push(args); return remoteDir; } };
  const fakeCreate = (n) => (n === 'github' ? gh : realCreate(n));

  // 1) plan dryRun: TAMBIÉN hace pull
  const plan = await runRestore({ lang: 'es', dryRun: true, env: te.env, createProvider: fakeCreate });
  assert.equal(pulls.length, 1);
  assert.deepEqual(pulls[0], { owner: 'octo', repo: 'ses', token: 'tok-1234', lang: 'es' });
  assert.ok(plan.message.includes('dry-run'));

  // 2) restauración real: segundo pull + archivos escritos en el dataDir temporal
  const res = await runRestore({ lang: 'es', dryRun: false, overwrite: true, env: te.env, createProvider: fakeCreate });
  assert.equal(pulls.length, 2);
  assert.ok(res.result.files >= 1);
  assert.ok(fs.existsSync(path.join(te.dataDir, 'opencode.db')));
});

// ---------------------------------------------------------------- status

test('status con provider github: info.cfg {provider, owner, repo}, sin token, línea "Proveedor: github"', () => {
  const te = tempEnv({ cfg: { provider: 'github', owner: 'octo', repo: 'ses' } });
  const { lines, info } = getStatus({ lang: 'es', env: te.env });
  assert.equal(info.cfg.provider, 'github');
  assert.equal(info.cfg.owner, 'octo');
  assert.equal(info.cfg.repo, 'ses');
  assert.ok(!('token' in info.cfg), 'status no expone token');
  assert.ok(lines.includes('github'));
  assert.ok(lines.includes('octo/ses'));
  assert.equal(info.configDir, te.configDir);
  assert.equal(info.dataDir, te.dataDir);
});

// ---------------------------------------------------------------- CLI

test('CLI: parseArgs reconoce --github owner/repo (espacio y =)', () => {
  const p = parseArgs(['setup', '--github', 'octo/ses', '--token', 'abc']);
  assert.equal(p.cmd, 'setup');
  assert.equal(p.flags.github, 'octo/ses');
  assert.equal(p.flags.token, 'abc');
  assert.equal(parseArgs(['setup', '--github=octo/ses']).flags.github, 'octo/ses');
});

test('CLI: setup --help imprime ayuda localizada y NO reescribe la config', async () => {
  const te = tempEnv(); // sync.json inicial ya existe por tempEnv
  const before = fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8');
  const prevCfg = process.env.OPENCODE_CONFIG_DIR;
  const prevData = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_CONFIG_DIR = te.configDir;
  process.env.OPENCODE_DATA_DIR = te.dataDir;
  try {
    const code = await main(['setup', '--help']);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8'), before, '--help no reescribe sync.json');
    assert.ok(!fs.existsSync(path.join(te.configDir, 'sync-auth.json')));
  } finally {
    if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = prevCfg;
    if (prevData === undefined) delete process.env.OPENCODE_DATA_DIR; else process.env.OPENCODE_DATA_DIR = prevData;
  }
});

test('CLI e2e offline: setup --github owner/repo guarda provider github sin token y sin red', async () => {
  const te = tempEnv();
  const prev = { ...process.env };
  process.env.OPENCODE_CONFIG_DIR = te.configDir;
  process.env.OPENCODE_DATA_DIR = te.dataDir;
  delete process.env.OPENCODE_SYNC_TOKEN; // garantizar cero validación de red
  delete process.env.OPENCODE_SYNC_PASSPHRASE;
  try {
    const code = await main(['setup', '--github', 'octo/ses', '--no-encrypt']);
    assert.equal(code, 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8'));
    assert.equal(cfg.provider, 'github');
    assert.equal(cfg.owner, 'octo');
    assert.equal(cfg.repo, 'ses');
    assert.ok(!('token' in cfg), 'sync.json sin token');
    // sin token y sin encrypt: no hay nada que guardar en sync-auth.json
    assert.ok(!fs.existsSync(path.join(te.configDir, 'sync-auth.json')));
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  }
});
