// opencode-sync · localización de directorios + configuración (sync.json / sync-auth.json)
// Cero dependencias: node:fs / node:os / node:path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- directorios

/**
 * Data dir de OpenCode (sesiones, storage, opencode.db).
 * Prioridad: OPENCODE_DATA_DIR (tests/temp) > %USERPROFILE%\.local\share\opencode
 * en Windows, ~/.local/share/opencode en el resto.
 * NO crea el directorio; status/backup deben reportarlo si falta.
 */
export function detectDataDir(env = process.env) {
  if (env.OPENCODE_DATA_DIR) return path.resolve(env.OPENCODE_DATA_DIR);
  const home = process.platform === 'win32' ? (env.USERPROFILE || os.homedir()) : os.homedir();
  return path.join(home, '.local', 'share', 'opencode');
}

/** Config dir de OpenCode: OPENCODE_CONFIG_DIR > ~/.config/opencode */
export function detectConfigDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
  const home = process.platform === 'win32' ? (env.USERPROFILE || os.homedir()) : os.homedir();
  return path.join(home, '.config', 'opencode');
}

// ---------------------------------------------------------------- configuración

export const CONFIG_FILE = 'sync.json';
export const AUTH_FILE = 'sync-auth.json';

export function defaultSyncConfig(configDir = detectConfigDir()) {
  return {
    provider: 'local',
    localDir: path.join(configDir, 'sync-backup'),
    parts: '80mb',
    encrypt: true,
  };
}

/**
 * Carga <configDir>/sync.json sobre los defaults. `overrides` (de flags CLI)
 * se aplican al final. Defaults se resuelven SIEMPRE contra configDir dado.
 */
export function loadSyncConfig(configDir = detectConfigDir(), overrides = {}) {
  const base = defaultSyncConfig(configDir);
  let stored = {};
  const file = path.join(configDir, CONFIG_FILE);
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      stored = {}; // sync.json corrupto -> defaults (no rompemos el CLI)
    }
  }
  const cfg = { ...base, ...stored };
  // localDir vacío/relativo del storage viejo: reanclar a configDir
  if (!cfg.localDir) cfg.localDir = path.join(configDir, 'sync-backup');
  if (!path.isAbsolute(String(cfg.localDir))) cfg.localDir = path.join(configDir, String(cfg.localDir));
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined && v !== null) cfg[k] = v;
  }
  return cfg;
}

/** Guarda la config en <configDir>/sync.json (crea configDir si falta). */
export function saveSyncConfig(cfg, configDir = detectConfigDir()) {
  fs.mkdirSync(configDir, { recursive: true });
  const copy = { ...cfg };
  delete copy.localDirRelative; // nunca persistir campos internos de presentación
  fs.writeFileSync(path.join(configDir, CONFIG_FILE), JSON.stringify(copy, null, 2) + '\n', 'utf8');
  return path.join(configDir, CONFIG_FILE);
}

// ---------------------------------------------------------------- credenciales

/** Ruta del archivo de credenciales: <configDir>/sync-auth.json */
export function authFilePath(configDir = detectConfigDir()) {
  return path.join(configDir, AUTH_FILE);
}

/** Carga credenciales: file + overrides por env (OPENCODE_SYNC_TOKEN / _PASSPHRASE
 *  / OPENCODE_GDRIVE_CLIENT_ID / _CLIENT_SECRET / OPENCODE_GDRIVE_REFRESH). */
export function loadAuth(configDir = detectConfigDir(), env = process.env) {
  const out = {};
  const file = authFilePath(configDir);
  if (fs.existsSync(file)) {
    try {
      Object.assign(out, JSON.parse(fs.readFileSync(file, 'utf8')) || {});
    } catch {
      out._corrupt = true;
    }
  }
  if (env.OPENCODE_SYNC_TOKEN) out.token = env.OPENCODE_SYNC_TOKEN;
  else if (out.token === undefined) delete out.token;
  if (env.OPENCODE_SYNC_PASSPHRASE) out.passphrase = env.OPENCODE_SYNC_PASSPHRASE;
  if (env.OPENCODE_GDRIVE_CLIENT_ID) out.gdriveClientId = env.OPENCODE_GDRIVE_CLIENT_ID;
  if (env.OPENCODE_GDRIVE_CLIENT_SECRET) out.gdriveClientSecret = env.OPENCODE_GDRIVE_CLIENT_SECRET;
  if (env.OPENCODE_GDRIVE_REFRESH) out.gdriveRefreshToken = env.OPENCODE_GDRIVE_REFRESH;
  return out;
}

/** Guarda credenciales con chmod 600 cuando el SO lo admite (POSIX). */
export function saveAuth(data, configDir = detectConfigDir()) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = authFilePath(configDir);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* fs no lo soporta: seguir */ }
  }
  return file;
}

// ---------------------------------------------------------------- utilidades

/** '80mb' | '1.5gb' | '512kb' | '4096' -> bytes (default 80 MiB). */
export function parseSize(str, fallback = 80 * 1024 * 1024) {
  if (str == null) return fallback;
  const m = String(str).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, undefined: 1 }[m[2] ?? 'b'] ?? 1;
  return Math.floor(n * mult);
}
