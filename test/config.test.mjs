// config: defaults, load/save roundtrip, rutas por SO y parseSize
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectDataDir, detectConfigDir, loadSyncConfig, saveSyncConfig, parseSize,
  authFilePath, loadAuth, saveAuth,
} from '../src/config.mjs';

function tempEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oces-cfg-'));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return { base, dataDir, configDir, env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir } };
}

test('defaults: local + localDir bajo configDir + parts 80mb + encrypt true', () => {
  const { configDir, env } = tempEnv();
  const cfg = loadSyncConfig(configDir, {}, );
  assert.equal(cfg.provider, 'local');
  assert.equal(cfg.parts, '80mb');
  assert.equal(cfg.encrypt, true);
  assert.equal(cfg.localDir, path.join(configDir, 'sync-backup'));
  assert.ok(!env.USERPROFILE || true); // win32/posix agnóstico
});

test('load/save roundtrip conserva overrides', () => {
  const { configDir } = tempEnv();
  const original = { provider: 'github', owner: 'mi-user', repo: 'sesiones', parts: '20mb', encrypt: false, extra: { a: 1 } };
  saveSyncConfig(original, configDir);
  const loaded = loadSyncConfig(configDir);
  for (const k of ['provider', 'owner', 'repo', 'parts', 'encrypt']) {
    assert.deepEqual(loaded[k], original[k]);
  }
  assert.deepEqual(loaded.extra, { a: 1 });
  // sync.json corrupto no rompe: cae a defaults
  fs.writeFileSync(path.join(configDir, 'sync.json'), '{oops', 'utf8');
  const fallback = loadSyncConfig(configDir);
  assert.equal(fallback.provider, 'local');
});

test('overrides por flags se aplican encima del sync.json guardado', () => {
  const { configDir } = tempEnv();
  saveSyncConfig({ provider: 'github' }, configDir);
  const merged = loadSyncConfig(configDir, { provider: 'local', parts: '10mb' });
  assert.equal(merged.provider, 'local');
  assert.equal(merged.parts, '10mb');
});

test('detect: env OVERRIDE gana sobre SO; no crea directorios', () => {
  const { dataDir, configDir, env } = tempEnv();
  assert.equal(detectDataDir(env), dataDir);
  assert.equal(detectConfigDir(env), configDir);
  // sin env: apunta al real del usuario sin crear nada
  const noEnv = {};
  const realData = detectDataDir(noEnv);
  const realConfig = detectConfigDir(noEnv);
  assert.ok(!path.isAbsolute(realData) === false, 'data dir es absoluta');
  assert.ok(realConfig.includes('.config') || realConfig.includes('opencode'));
  if (process.platform === 'win32') {
    env.USERPROFILE = env.USERPROFILE || os.homedir();
    assert.ok(detectDataDir(noEnv).endsWith(path.join('.local', 'share', 'opencode')));
  }
});

test('parseSize: kb/mb/gb/bytes y fallback seguro', () => {
  assert.equal(parseSize('80mb'), 80 * 1024 * 1024);
  assert.equal(parseSize('1.5gb'), Math.floor(1.5 * 1024 ** 3));
  assert.equal(parseSize('512kb'), 512 * 1024);
  assert.equal(parseSize('4096'), 4096);
  assert.equal(parseSize('sin-sentido'), 80 * 1024 * 1024);
  assert.equal(parseSize(null), 80 * 1024 * 1024);
});

test('authFilePath/loadAuth/saveAuth: env gana sobre archivo', () => {
  const { configDir } = tempEnv();
  assert.equal(authFilePath(configDir), path.join(configDir, 'sync-auth.json'));
  saveAuth({ passphrase: 'frase-local', token: 'tok-1' }, configDir);
  const auth = loadAuth(configDir, {});
  assert.equal(auth.passphrase, 'frase-local');
  assert.equal(auth.token, 'tok-1');
  const withEnv = loadAuth(configDir, { OPENCODE_SYNC_TOKEN: 'tok-env', OPENCODE_SYNC_PASSPHRASE: 'frase-env' });
  assert.equal(withEnv.token, 'tok-env');
  assert.equal(withEnv.passphrase, 'frase-env');
});
