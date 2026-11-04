// opencode-sync · proveedor LOCAL: copia de parts+manifest a <targetDir>/<stamp>/ con cero config
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LANG, t } from '../i18n.mjs';

function isBackupFile(name) {
  return name === 'manifest.json' || /^part\.\d{3}$/.test(name);
}

/** Marca temporal tipo '20261030T081522Z': ordenable lexicográficamente. */
export function stampFor(date = new Date()) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * push({sourceDir, targetDir, date}): copia manifest.json + part.* a
 * <targetDir>/<stamp>/ y devuelve la carpeta destino.
 */
export function push({ sourceDir, targetDir, date, lang = DEFAULT_LANG }) {
  if (!fs.existsSync(sourceDir) || !isDir(sourceDir)) {
    throw new Error(t(lang, 'err.no_backup', { dir: sourceDir }));
  }
  const files = fs.readdirSync(sourceDir).filter(isBackupFile);
  if (!files.includes('manifest.json')) {
    throw new Error(t(lang, 'err.no_backup', { dir: sourceDir }));
  }
  const stamp = stampFor(date);
  const dest = path.join(targetDir, stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(sourceDir, f), path.join(dest, f));
  return dest;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/**
 * list(targetDir): subcarpetas con manifest.json, la más nueva primero.
 * -> [{dir, stamp, manifest}]
 */
export function list(targetDir) {
  if (!fs.existsSync(targetDir) || !isDir(targetDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(targetDir)) {
    const dir = path.join(targetDir, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!isDir(dir) || !fs.existsSync(manifestPath)) continue;
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { manifest = null; }
    out.push({ dir, stamp: name, manifest });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/** pull(targetDir): carpeta de la copia más reciente; error localizable si no hay. */
export function pull(targetDir, lang = DEFAULT_LANG) {
  const all = list(targetDir);
  if (!all.length) throw new Error(t(lang, 'err.no_backup', { dir: targetDir }));
  return all[0].dir;
}
