// runSetup con `test` (modo ESTRICTO opt-in para el botón Conectar de la GUI):
// github/gdrive EXIGEN credenciales completas y las validan contra la API (inyectable,
// sin red) ANTES de persistir; local verifica escritura REAL del dir de copias (fichero
// sonda .write-test). SIN `test` el flujo CLI/env queda intacto (persiste + hint).
// Todo con temp dirs: NUNCA toca el opencode.db/config reales del usuario.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetup } from '../src/actions.mjs';
import { t } from '../src/i18n.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-testmode-${n}-`));

/** Entorno aislado: dataDir+configDir temporales con sync.json de mentira.
 *  env SIN OPENCODE_SYNC_TOKEN/_GDRIVE_*: cero credenciales heredadas del proceso. */
function tempEnv({ cfg = {} } = {}) {
  const base = mkTemp('env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.alloc(128, 7));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({ encrypt: false, ...cfg }));
  return {
    base, dataDir, configDir,
    env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir },
    syncJson: () => fs.readFileSync(path.join(configDir, 'sync.json'), 'utf8'),
    authJson: () => path.join(configDir, 'sync-auth.json'),
  };
}

const cleanup = (te) => fs.rmSync(te.base, { recursive: true, force: true });

// ------------------------------------------------------- github + test

test('(a) github test:true SIN token -> err.setup_incomplete y NADA persistido', async () => {
  for (const answers of [{ owner: 'octo', repo: 'ses' }, { repo: 'ses', token: 't' }, {}]) {
    const te = tempEnv();
    const before = te.syncJson();
    const validate = async () => { throw new Error('NO debe llamarse a validate sin credenciales completas'); };
    await assert.rejects(
      runSetup({ lang: 'es', provider: 'github', env: te.env, answers, test: true, validate }),
      (e) => e.message === t('es', 'err.setup_incomplete'),
    );
    assert.equal(te.syncJson(), before, 'sync.json intacto: nada persistido');
    assert.ok(!fs.existsSync(te.authJson()), 'sync-auth.json no creado');
    // paridad en
    const teEn = tempEnv();
    await assert.rejects(
      runSetup({ lang: 'en', provider: 'github', env: teEn.env, answers, test: true, validate }),
      (e) => e.message === t('en', 'err.setup_incomplete'),
    );
    cleanup(te);
    cleanup(teEn);
  }
});

test('(b) github test:true con validate ok -> persiste, verified ["token","repo-push"] y message "validada"', async () => {
  const te = tempEnv();
  let validated = null;
  const validate = async (args) => {
    validated = args;
    return { ok: true, login: 'octo', repo: 'octo/ses' };
  };
  const res = await runSetup({
    lang: 'es', provider: 'github', env: te.env, test: true, validate,
    answers: { owner: 'octo', repo: 'ses', token: 'ghp_secret1234' },
  });
  assert.deepEqual(validated, { owner: 'octo', repo: 'ses', token: 'ghp_secret1234', lang: 'es' });
  assert.deepEqual(res.verified, ['token', 'repo-push']);
  assert.ok(res.message.includes('validada'), 'message dice explícitamente que se validó');
  assert.ok(res.message.includes('octo/ses'));
  // persistido SOLO tras validar
  const cfgOnDisk = JSON.parse(te.syncJson());
  assert.equal(cfgOnDisk.provider, 'github');
  assert.equal(cfgOnDisk.owner, 'octo');
  assert.equal(cfgOnDisk.repo, 'ses');
  assert.ok(!('token' in cfgOnDisk), 'sync.json sin token');
  const authOnDisk = JSON.parse(fs.readFileSync(te.authJson(), 'utf8'));
  assert.equal(authOnDisk.token, 'ghp_secret1234');
  // shapes públicos jamás exponen el token
  assert.ok(!JSON.stringify({ lines: res.lines, cfg: res.cfg, verified: res.verified }).includes('ghp_secret1234'));
  cleanup(te);
});

test('(b2) github test:true con validate FALLIDA -> error y NADA persistido', async () => {
  const te = tempEnv();
  const before = te.syncJson();
  const validate = async () => { throw new Error(t('es', 'err.no_push', { repo: 'octo/ses' })); };
  await assert.rejects(
    runSetup({
      lang: 'es', provider: 'github', env: te.env, test: true, validate,
      answers: { owner: 'octo', repo: 'ses', token: 'ghp_x' },
    }),
    (e) => e.message === t('es', 'err.no_push', { repo: 'octo/ses' }),
  );
  assert.equal(te.syncJson(), before, 'sync.json intacto tras validación fallida');
  assert.ok(!fs.existsSync(te.authJson()), 'sync-auth.json no creado');
  cleanup(te);
});

// ------------------------------------------------------- gdrive + test

test('(c) gdrive test:true con validateGDrive ok -> verified ["auth","folder"], persiste', async () => {
  const te = tempEnv();
  let validated = null;
  const validateGDrive = async (args) => {
    validated = args;
    return { ok: true, user: 'Ana', folderId: 'fold9', folderName: 'MiBackups' };
  };
  const res = await runSetup({
    lang: 'es', provider: 'gdrive', env: te.env, test: true, validateGDrive,
    answers: { clientId: 'cid9', clientSecret: 'sec9', refreshToken: 'rtok9', folderName: 'MiBackups' },
  });
  assert.deepEqual(validated, { clientId: 'cid9', clientSecret: 'sec9', refreshToken: 'rtok9', folderName: 'MiBackups', lang: 'es' });
  assert.deepEqual(res.verified, ['auth', 'folder']);
  assert.ok(res.verified.includes('folder'));
  assert.ok(res.message.includes('validada'));
  assert.ok(res.message.includes('Ana') && res.message.includes('MiBackups'));
  const cfgOnDisk = JSON.parse(te.syncJson());
  assert.equal(cfgOnDisk.provider, 'gdrive');
  assert.equal(cfgOnDisk.folderId, 'fold9');
  const authOnDisk = JSON.parse(fs.readFileSync(te.authJson(), 'utf8'));
  assert.deepEqual(authOnDisk, { gdriveClientId: 'cid9', gdriveClientSecret: 'sec9', gdriveRefreshToken: 'rtok9' });
  assert.ok(!JSON.stringify({ lines: res.lines, cfg: res.cfg, verified: res.verified }).includes('sec9'));
  cleanup(te);
});

test('(c2) gdrive test:true SIN creds completas -> err.gdrive_creds y NADA persistido', async () => {
  const te = tempEnv();
  const before = te.syncJson();
  const validateGDrive = async () => { throw new Error('NO debe llamarse sin credenciales completas'); };
  await assert.rejects(
    runSetup({
      lang: 'es', provider: 'gdrive', env: te.env, test: true, validateGDrive,
      answers: { clientId: 'cid', clientSecret: 'sec' }, // falta refreshToken
    }),
    (e) => e.message === t('es', 'err.gdrive_creds'),
  );
  assert.equal(te.syncJson(), before, 'sync.json intacto');
  assert.ok(!fs.existsSync(te.authJson()), 'sync-auth.json no creado');
  cleanup(te);
});

// ------------------------------------------------------- local + test (escritura REAL)

// helper: tempEnv con sync.json ya reescrito (los tests (d)/(e) necesitan localDir custom)
test('(d) local test:true con localDir escribible -> verified ["writable"], crea el dir y limpia la sonda', async () => {
  const te = tempEnv();
  const localDir = path.join(te.base, 'copias-nuevas'); // NO existe aún: debe crearse
  fs.writeFileSync(path.join(te.configDir, 'sync.json'), JSON.stringify({ encrypt: false, localDir }));
  const res = await runSetup({ lang: 'es', provider: 'local', env: te.env, test: true, answers: {} });
  assert.deepEqual(res.verified, ['writable']);
  assert.ok(res.message.includes('validada'), 'message dice explícitamente que se validó');
  assert.ok(res.message.includes('copias-nuevas'), 'message menciona el dir verificado');
  assert.ok(fs.existsSync(localDir), 'el dir de copias fue creado');
  assert.ok(!fs.existsSync(path.join(localDir, '.write-test')), 'fichero sonda .write-test borrado');
  const cfgOnDisk = JSON.parse(te.syncJson());
  assert.equal(cfgOnDisk.provider, 'local');
  cleanup(te);
});

test('(e) local test:true con dir NO escribible (un FILE como localDir) -> err.local_not_writable', async () => {
  const te = tempEnv();
  const fileAsDir = path.join(te.base, 'esto-es-un-fichero');
  fs.writeFileSync(fileAsDir, 'no soy un directorio', 'utf8');
  fs.writeFileSync(path.join(te.configDir, 'sync.json'), JSON.stringify({ encrypt: false, localDir: fileAsDir }));
  const before = fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8');
  await assert.rejects(
    runSetup({ lang: 'es', provider: 'local', env: te.env, test: true, answers: {} }),
    (e) => e.message === t('es', 'err.local_not_writable', { dir: path.resolve(fileAsDir) }),
  );
  assert.equal(fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8'), before, 'sync.json intacto');
  assert.ok(!fs.existsSync(te.authJson()), 'sync-auth.json no creado');
  // paridad en
  const teEn = tempEnv();
  const fileAsDirEn = path.join(teEn.base, 'file-as-dir');
  fs.writeFileSync(fileAsDirEn, 'x');
  fs.writeFileSync(path.join(teEn.configDir, 'sync.json'), JSON.stringify({ encrypt: false, localDir: fileAsDirEn }));
  await assert.rejects(
    runSetup({ lang: 'en', provider: 'local', env: teEn.env, test: true, answers: {} }),
    (e) => e.message === t('en', 'err.local_not_writable', { dir: path.resolve(fileAsDirEn) }),
  );
  cleanup(te);
  cleanup(teEn);
});

// ------------------------------------------------------- SIN test: flujo CLI intacto

test('(f) SIN test: github sin creds PERSISTE sin validar (hint), como siempre', async () => {
  const te = tempEnv();
  let validateCalled = false;
  const validate = async () => { validateCalled = true; return { ok: true, login: 'x', repo: 'x/y' }; };
  const res = await runSetup({
    lang: 'es', provider: 'github', env: te.env, validate, answers: { owner: 'octo', repo: 'ses' }, // SIN token
  });
  assert.equal(validateCalled, false, 'sin test y sin token NO se llama a validate');
  assert.deepEqual(res.verified, []);
  assert.ok(!res.message.includes('validada'), 'sin mensaje de éxito validado');
  assert.ok(res.message.includes(t('es', 'cli.setup.token_hint', { path: te.authJson() })), 'hint presente');
  const cfgOnDisk = JSON.parse(te.syncJson());
  assert.equal(cfgOnDisk.provider, 'github', 'persiste igual (flujo CLI offline intacto)');
  assert.ok(!fs.existsSync(te.authJson()), 'sin token no hay auth file');
  cleanup(te);
});

test('(f2) SIN test: gdrive sin creds PERSISTE sin validar (hint) y local sigue igual', async () => {
  const te = tempEnv();
  let gdCalled = false;
  const validateGDrive = async () => { gdCalled = true; return { ok: true, user: 'x', folderId: 'f' }; };
  const res = await runSetup({
    lang: 'es', provider: 'gdrive', env: te.env, validateGDrive, answers: {},
  });
  assert.equal(gdCalled, false);
  assert.deepEqual(res.verified, []);
  assert.ok(res.message.includes(t('es', 'cli.setup.gd_hint', { path: te.authJson() })), 'hint gdrive');
  assert.equal(JSON.parse(te.syncJson()).provider, 'gdrive', 'persiste sin validar');
  cleanup(te);

  const te2 = tempEnv();
  const res2 = await runSetup({ lang: 'es', provider: 'local', env: te2.env, answers: {} });
  assert.deepEqual(res2.verified, []);
  assert.ok(!res2.message.includes('validada'));
  assert.equal(JSON.parse(te2.syncJson()).provider, 'local');
  cleanup(te2);
});
