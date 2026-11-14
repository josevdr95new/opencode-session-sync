// F3: runReveal — ENUM cerrado {backups|config|data}, comando por plataforma con spawn
// INYECTADO (nunca se abren ventanas reales en tests), not_found con dir inexistente.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReveal } from '../src/actions.mjs';
import plugin from '../src/index.mjs';
import { t } from '../src/i18n.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-reveal-${n}-`));

function tempEnv({ cfg = {}, makeDirs = true } = {}) {
  const base = mkTemp('env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  const localDir = path.join(base, 'copias');
  if (makeDirs) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({
      provider: 'local', encrypt: false, localDir, parts: '80mb', ...cfg,
    }));
  }
  return { base, dataDir, configDir, localDir, env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir } };
}

/** Mock de process.platform (restauración garantizada en finally). */
async function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

/** spawnFn falso: graba (cmd, args, opts) y devuelve un child con unref contable. */
function fakeSpawn() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const child = { unrefCount: 0, unref() { this.unrefCount++; } };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawnFn, calls };
}

test('runReveal win32: explorer.exe con el dir de copias, detachado y unref', async () => {
  const te = tempEnv();
  const { spawnFn, calls } = fakeSpawn();
  await withPlatform('win32', async () => {
    const res = runReveal({ kind: 'backups', lang: 'es', env: te.env, spawnFn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'explorer.exe');
    assert.deepEqual(calls[0].args, [te.localDir]);
    assert.deepEqual(calls[0].opts, { detached: true, stdio: 'ignore' });
    assert.equal(calls[0].child.unrefCount, 1, 'child.unref() llamado');
    assert.equal(res.message, t('es', 'del.revealed', { dir: te.localDir }));
    assert.equal(res.dir, te.localDir);
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('runReveal darwin/linux: open y xdg-open con configDir/dataDir según kind', async () => {
  const te = tempEnv();
  {
    const { spawnFn, calls } = fakeSpawn();
    await withPlatform('darwin', async () => {
      const res = runReveal({ kind: 'config', lang: 'en', env: te.env, spawnFn });
      assert.equal(calls[0].cmd, 'open');
      assert.deepEqual(calls[0].args, [te.configDir]);
      assert.equal(res.message, t('en', 'del.revealed', { dir: te.configDir }));
    });
  }
  {
    const { spawnFn, calls } = fakeSpawn();
    await withPlatform('linux', async () => {
      runReveal({ kind: 'data', lang: 'es', env: te.env, spawnFn });
      assert.equal(calls[0].cmd, 'xdg-open');
      assert.deepEqual(calls[0].args, [te.dataDir]);
    });
  }
  // plataforma desconocida -> fallback linux
  {
    const { spawnFn, calls } = fakeSpawn();
    await withPlatform('sunos', async () => {
      runReveal({ kind: 'backups', lang: 'es', env: te.env, spawnFn });
      assert.equal(calls[0].cmd, 'xdg-open');
    });
  }
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('runReveal: ENUM cerrado — kind arbitrario/PATH rechazado y spawn NUNCA llamado', async () => {
  const te = tempEnv();
  const { spawnFn, calls } = fakeSpawn();
  for (const bad of ['C:\\Users\\x\\secreto', 'config/../data', '', 'otro']) {
    await assert.rejects(
      async () => runReveal({ kind: bad, lang: 'es', env: te.env, spawnFn }),
      (err) => {
        assert.equal(err.message, t('es', 'del.bad_kind', { kind: String(bad) }));
        assert.equal(t('en', 'del.bad_kind', { kind: String(bad) }).length > 0, true, 'paridad en');
        return true;
      },
      `kind rechazado: ${bad}`,
    );
  }
  assert.equal(calls.length, 0, 'ningún spawn para kinds inválidos');
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('runReveal: dir inexistente -> error not_found (resource = kind) y sin spawn', async () => {
  const te = tempEnv({ makeDirs: false }); // dataDir NO existe
  fs.mkdirSync(te.configDir, { recursive: true });
  fs.writeFileSync(path.join(te.configDir, 'sync.json'), JSON.stringify({
    provider: 'local', encrypt: false, localDir: te.localDir,
  }));
  const { spawnFn, calls } = fakeSpawn();
  await assert.rejects(
    async () => runReveal({ kind: 'data', lang: 'es', env: te.env, spawnFn }),
    (err) => {
      assert.equal(err.notFound, true);
      assert.equal(err.resource, 'data');
      assert.equal(err.message, t('es', 'del.reveal_missing', { dir: te.dataDir }));
      return true;
    },
  );
  assert.equal(calls.length, 0);
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('RPC reveal: not_found mapea a error declarado con {kind} (sin spawn real)', async () => {
  const te = tempEnv({ makeDirs: false }); // dataDir NO existe -> not_found ANTES de spawn
  fs.mkdirSync(te.configDir, { recursive: true });
  fs.writeFileSync(path.join(te.configDir, 'sync.json'), JSON.stringify({ provider: 'local' }));
  let registration = null;
  const ctx = {
    rpc: {
      register: async (_def, handlers) => {
        registration = { handlers, events: { emit: async () => {} } };
        return registration;
      },
    },
  };
  const prevCfg = process.env.OPENCODE_CONFIG_DIR;
  const prevData = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_CONFIG_DIR = te.configDir;
  process.env.OPENCODE_DATA_DIR = te.dataDir;
  try {
    await plugin.setup(ctx);
    const fail = (type, message, data) => ({ type, message, data });
    const nf = await registration.handlers.reveal({ kind: 'data' }, { error: fail });
    assert.equal(nf.type, 'not_found');
    assert.equal(nf.data.kind, 'data');
    assert.equal(nf.message, t('es', 'del.reveal_missing', { dir: te.dataDir }));
    // kind fuera del ENUM -> failed (sin spawn)
    const bad = await registration.handlers.reveal({ kind: 'C:\\arbitrario' }, { error: fail });
    assert.equal(bad.type, 'failed');
  } finally {
    if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = prevCfg;
    if (prevData === undefined) delete process.env.OPENCODE_DATA_DIR; else process.env.OPENCODE_DATA_DIR = prevData;
    fs.rmSync(te.base, { recursive: true, force: true });
  }
});
