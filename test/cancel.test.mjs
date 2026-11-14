// F1: cancelación de backup/restore en curso (AbortSignal).
// (a) abort por timer a mitad de pack -> outDir SIN part files NI manifest, error 'cancelled'
// (b) abort determinista en fase parts / unpack (vía onProgress) -> parciales y tmp limpios
// (c) RPC handler con context.signal abortado -> error tipado 'cancelled'
// Todo con temp dirs; NUNCA toca los datos reales del usuario.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeBackup, restoreBackup, isCancelledError } from '../src/backup.mjs';
import { runBackup } from '../src/actions.mjs';
import plugin from '../src/index.mjs';
import { SessionSync } from '../src/rpc.ts';
import { t } from '../src/i18n.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-cancel-${n}-`));

function tempEnv({ cfg = {} } = {}) {
  const base = mkTemp('env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(512));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({
    provider: 'local', encrypt: false, localDir: path.join(base, 'copias'), parts: '80mb', ...cfg,
  }));
  return { base, dataDir, configDir, env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir } };
}

function restoreEnv() {
  delete process.env.OPENCODE_DATA_DIR;
  delete process.env.OPENCODE_CONFIG_DIR;
}

function listDir(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

test('makeBackup: abort por TIMER a mitad de pack -> error cancelled y outDir SIN part/manifest/pack.tmp', async () => {
  const base = mkTemp('pack');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // 64 MB aleatorios (comprimen ~1:1): el pack dura bastante más que el timer de 25ms
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(64 * 1024 * 1024));
  const outDir = path.join(base, 'out');
  const signal = AbortSignal.timeout(25);
  await assert.rejects(
    makeBackup({ dataDir, configDir, outDir, lang: 'es', signal }),
    (err) => {
      assert.equal(err.cancelled, true, 'error tipado cancelled');
      assert.equal(isCancelledError(err), true, 'isCancelledError lo detecta');
      assert.equal(err.message, t('es', 'err.cancelled'), 'mensaje i18n es');
      assert.equal(t('en', 'err.cancelled'), 'Operation cancelled', 'clave err.cancelled con paridad en');
      return true;
    },
  );
  const rest = listDir(outDir);
  assert.deepEqual(rest.filter((n) => /^part\.\d{3}$/.test(n)), [], 'sin part files');
  assert.ok(!rest.includes('manifest.json'), 'sin manifest.json');
  assert.ok(!rest.includes('pack.tmp'), 'sin pack.tmp');
  fs.rmSync(base, { recursive: true, force: true });
});

test('makeBackup: abort determinista al entrar en fase PARTS -> part.000 parcial eliminada, sin manifest', async () => {
  const base = mkTemp('parts');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(2 * 1024 * 1024));
  const outDir = path.join(base, 'out');
  const controller = new AbortController();
  await assert.rejects(
    makeBackup({
      dataDir, configDir, outDir, lang: 'es', maxPartBytes: 256 * 1024,
      signal: controller.signal,
      onProgress: (p) => { if (p && p.phase === 'parts') controller.abort(); },
    }),
    (err) => err.cancelled === true && err.message === t('es', 'err.cancelled'),
  );
  const rest = listDir(outDir);
  assert.deepEqual(rest.filter((n) => /^part\.\d{3}$/.test(n)), [], 'sin part files (la parcial también se limpia)');
  assert.ok(!rest.includes('manifest.json'), 'sin manifest.json');
  fs.rmSync(base, { recursive: true, force: true });
});

test('restoreBackup: abort a mitad de UNPACK -> error cancelled y tmp de restore LIMPIO', async () => {
  const base = mkTemp('restore');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(1024 * 1024));
  const sourceDir = path.join(base, 'source');
  await makeBackup({ dataDir, configDir, outDir: sourceDir, maxPartBytes: 256 * 1024 });

  // sandbox: os.tmpdir apuntado a un dir propio para verificar que el mkdtemp de restore
  // deja CERO restos al cancelar (concat.bin/tar.bin incluidos)
  const sandbox = mkTemp('sandbox');
  const realTmp = os.tmpdir;
  os.tmpdir = () => sandbox;
  try {
    const controller = new AbortController();
    await assert.rejects(
      restoreBackup({
        sourceDir, targetDataDir: dataDir, targetConfigDir: configDir, overwrite: true, lang: 'es',
        signal: controller.signal,
        onProgress: (p) => { if (p && p.phase === 'unpack') controller.abort(); },
      }),
      (err) => err.cancelled === true && err.message === t('es', 'err.cancelled'),
    );
    assert.deepEqual(fs.readdirSync(sandbox), [], 'sin tmp oces-restore-* residual');
  } finally {
    os.tmpdir = realTmp;
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('restoreBackup: signal YA abortado al llamar -> cancelled inmediato, sin tmp y sin tocar destino', async () => {
  const base = mkTemp('preabort');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.from('original'));
  const sourceDir = path.join(base, 'source');
  await makeBackup({ dataDir, configDir, outDir: sourceDir });
  const marker = path.join(dataDir, 'opencode.db');

  const sandbox = mkTemp('sandbox');
  const realTmp = os.tmpdir;
  os.tmpdir = () => sandbox;
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      restoreBackup({ sourceDir, targetDataDir: dataDir, targetConfigDir: configDir, overwrite: true, lang: 'en', signal: controller.signal }),
      (err) => err.cancelled === true && err.message === t('en', 'err.cancelled'),
    );
    assert.deepEqual(fs.readdirSync(sandbox), [], 'sin tmp creado');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'original', 'destino intacto');
  } finally {
    os.tmpdir = realTmp;
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('runBackup: forwarda el signal; con signal abortado NO llama al push y sube el error tipado sin envolver', async () => {
  const te = tempEnv({ cfg: { provider: 'github', owner: 'octo', repo: 'ses' } });
  let pushes = 0;
  const gh = { name: 'github', push: () => { pushes++; return { pushed: true }; } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runBackup({ lang: 'es', env: te.env, createProvider: (n) => (n === 'github' ? gh : undefined), signal: controller.signal }),
    (err) => {
      assert.equal(err.cancelled, true, 'el error sube tipado (sin envolver en failed)');
      assert.equal(err.message, t('es', 'err.cancelled'));
      return true;
    },
  );
  assert.equal(pushes, 0, 'cancelado antes del push: cero llamadas al proveedor');
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('rpc.ts declara errors.cancelled en backup/restore y errors.not_found en restore', () => {
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  assert.deepEqual(SessionSync.methods?.backup?.errors?.cancelled, empty);
  assert.deepEqual(SessionSync.methods?.restore?.errors?.cancelled, empty);
  assert.deepEqual(
    SessionSync.methods?.restore?.errors?.not_found,
    { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  );
  // failed sigue en ambos
  assert.ok(SessionSync.methods.backup.errors.failed && SessionSync.methods.restore.errors.failed);
});

test('RPC handler backup/restore con context.signal abortado -> error declarado cancelled (sin datos)', async () => {
  const te = tempEnv();
  process.env.OPENCODE_DATA_DIR = te.dataDir;
  process.env.OPENCODE_CONFIG_DIR = te.configDir;
  let registration = null;
  const ctx = {
    rpc: {
      register: async (_def, handlers) => {
        registration = { handlers, events: { emit: async () => {} } };
        return registration;
      },
    },
  };
  try {
    await plugin.setup(ctx);
    const ac = new AbortController();
    ac.abort();
    const fail = (type, message, data) => ({ type, message, data });
    const resB = await registration.handlers.backup({ dryRun: false }, { error: fail, signal: ac.signal });
    assert.equal(resB.type, 'cancelled');
    assert.equal(resB.message, t('es', 'err.cancelled'));
    assert.deepEqual(resB.data, {}, 'cancelled viaja SIN datos (schema vacío)');

    const resR = await registration.handlers.restore({ overwrite: true }, { error: fail, signal: ac.signal });
    assert.equal(resR.type, 'cancelled');
    assert.deepEqual(resR.data, {});
  } finally {
    restoreEnv();
    fs.rmSync(te.base, { recursive: true, force: true });
  }
});
