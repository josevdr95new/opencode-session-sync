// opencode-sync · motor de respaldo: tar ustar + gzip + cifrado + troceado en parts
// Cero dependencias: node:fs / node:path / node:zlib / node:crypto / node:os
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DEFAULT_LANG, t } from './i18n.mjs';
import { encryptBuffer, decryptBuffer } from './crypto.mjs';

const BLOCK = 512;
const WARNING_BYTES = 500 * 1024 * 1024; // >500 MB -> aviso (sin truncar contenido)
/** Nombres excluidos en cualquier nivel al recopilar archivos. */
const EXCLUDE = new Set(['node_modules', '.git', 'sync-backup', 'sync.json', 'sync-auth.json']);

export function hexSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------- tar ustar

function align(n) { return Math.ceil(n / BLOCK) * BLOCK; }

/** Normaliza un nombre de entrada a separador '/' (incluso en Windows). */
function normalizeName(name) {
  let n = String(name).replace(/\\/g, '/').replace(/\/+/g, '/');
  n = n.replace(/^\.\//, '').replace(/^\/+/, '');
  return n.replace(/\/+$/, '');
}

/** Ustar: nombre > 100 chars se divide en prefix(<=155) + '/' + name(<=100). */
function splitName(name) {
  if (name.length <= 100) return { namePart: name, prefix: '' };
  if (name.length > 255) throw new Error(`tar: nombre demasiado largo (${name.length}): ${name}`);
  for (let i = Math.min(155, name.length - 1); i > 0; i--) {
    if (name[i] === '/' && name.length - i - 1 <= 100) {
      return { prefix: name.slice(0, i), namePart: name.slice(i + 1) };
    }
  }
  throw new Error(`tar: no se puede trocear el nombre: ${name}`);
}

function octalField(value, digits) {
  // `digits` cifras octales; el terminador (NUL/espacio) lo añade el llamador
  const s = value.toString(8).padStart(digits, '0');
  if (s.length > digits) throw new Error('tar: campo octal desbordado');
  return s;
}

/**
 * buildTar(entries: [{name, size, read}]) -> Buffer tar ustar clásico.
 * Se ordenan por nombre para salida determinista.
 */
export function buildTar(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks = [];
  for (const entry of sorted) {
    const name = normalizeName(entry.name);
    if (!name) throw new Error('tar: entrada sin nombre');
    const data = entry.read();
    if (!Buffer.isBuffer(data) || data.length !== entry.size) {
      throw new Error(`tar: tamaño incoherente para ${name}`);
    }
    const head = Buffer.alloc(BLOCK, 0);
    const { namePart, prefix } = splitName(name);
    head.write(namePart.padEnd(100, '\0'), 0, 100, 'utf8');
    head.write((octalField(0o644, 7) + '\0'), 100, 8, 'ascii'); // mode
    head.write('0000000\0', 108, 8, 'ascii'); // uid
    head.write('0000000\0', 116, 8, 'ascii'); // gid
    head.write(octalField(data.length, 11) + ' ', 124, 12, 'ascii'); // size (11 dígitos + espacio)
    head.write(octalField(Math.floor(Date.now() / 1000) % 0o77777777777, 11) + ' ', 136, 12, 'ascii'); // mtime
    head.write('        ', 148, 8, 'ascii'); // checksum provisional (spaces)
    head.write('0', 156, 1, 'ascii'); // typeflag: archivo regular
    head.write('\0'.repeat(100), 157, 100, 'ascii'); // linkname
    head.write('ustar\0', 257, 6, 'ascii');
    head.write('00', 263, 2, 'ascii');
    head.write('\0'.repeat(64), 265, 64, 'ascii'); // uname+gname
    head.write('\0'.repeat(16), 329, 16, 'ascii'); // devmajor+devminor
    head.write(prefix.padEnd(155, '\0'), 345, 155, 'utf8');
    let sum = 0;
    for (const b of head) sum += b;
    head.write((sum.toString(8).padStart(6, '0') + '\0 '), 148, 8, 'ascii');
    chunks.push(head, data);
    const pad = align(data.length) - data.length;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // fin de archivo: dos bloques cero
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- parse tar

function parseSizeField(field12) {
  if (field12[0] & 0x80) { // base-256 GNU
    let n = field12[0] & 0x7f;
    for (let i = 1; i < field12.length; i++) n = n * 256 + field12[i];
    return n;
  }
  const s = field12.toString('ascii').replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

/** parseTar(buf) -> [{name, size, data}] (solo archivos regulares; resto se consume). */
export function parseTar(buf, lang = DEFAULT_LANG) {
  const entries = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const block = buf.subarray(off, off + BLOCK);
    if (block.every((b) => b === 0)) break;
    const rawName = block.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const prefix = block.subarray(345, 500).toString('ascii').replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseSizeField(block.subarray(124, 136));
    const typeflag = block[156];
    // verificación de checksum
    const expect = parseSizeField(block.subarray(148, 156));
    const probe = Buffer.from(block); // copia mutable
    probe.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of probe) sum += b;
    if (sum !== expect) throw new Error(t(lang, 'err.tar_corrupt'));
    const dataStart = off + BLOCK;
    if (typeflag === 0 || typeflag === 0x30) {
      entries.push({ name, size, data: buf.subarray(dataStart, dataStart + size) });
    }
    off = dataStart + align(size);
  }
  return entries;
}

/** Rechaza rutas peligrosas ('..', absolutas, unidad Windows, '\\'). */
export function safeEntryName(name, lang = DEFAULT_LANG) {
  const n = String(name).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) throw new Error(t(lang, 'err.traverse', { entry: name }));
  const segments = n.split('/');
  if (segments.includes('..') || n.includes('\0')) {
    throw new Error(t(lang, 'err.traverse', { entry: name }));
  }
  return n.replace(/\/+$/, '');
}

// ---------------------------------------------------------------- recopilación

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** Recorre root de forma recursiva y devuelve entradas con prefijo 'config/' o 'data/'. */
function collectDir(root, prefix) {
  const entries = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      for (const child of fs.readdirSync(abs)) {
        if (EXCLUDE.has(child.toLowerCase())) continue;
        stack.push(rel ? path.join(rel, child) : child);
      }
    } else if (st.isFile()) {
      const base = path.basename(abs);
      if (EXCLUDE.has(base.toLowerCase())) continue;
      entries.push({
        name: `${prefix}/${normalizeName(rel)}`,
        size: st.size,
        read: () => fs.readFileSync(abs),
      });
    }
  }
  return entries;
}

/**
 * Recopila archivos de BOTH dirs según la especificación:
 * - configDir: todo salvo node_modules/.git/sync-backup/sync.json/sync-auth.json
 * - dataDir: opencode.db (shm/wal ignorados por consistencia) + storage/ recursivo
 */
export function collectFiles(dataDir, configDir) {
  const entries = [];
  const warnings = [];
  let configFound = false;
  let dbFound = false;

  if (isDir(configDir)) {
    configFound = true;
    entries.push(...collectDir(configDir, 'config'));
    // los excludes globales ya quitaron sync.json/sync-auth.json
  } else {
    warnings.push('config_missing');
  }

  if (isDir(dataDir)) {
    for (const child of fs.readdirSync(dataDir)) {
      const abs = path.join(dataDir, child);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      const lower = child.toLowerCase();
      if (lower === 'opencode.db' && st.isFile()) {
        dbFound = true;
        entries.push({ name: 'data/opencode.db', size: st.size, read: () => fs.readFileSync(abs) });
      } else if (lower === 'storage' && st.isDirectory()) {
        entries.push(...collectDir(abs, 'data/storage'));
      }
      // opencode.db-shm / opencode.db-wal: IGNORADOS deliberadamente
    }
  } else {
    warnings.push('data_missing');
  }
  return { entries, warnings, configFound, dbFound };
}

// ---------------------------------------------------------------- make backup

/**
 * makeBackup({dataDir, configDir, passphrase, maxPartBytes, outDir, lang}):
 * tar -> gzip(6) -> [cifrar] -> partir en part.000.. + manifest.json en outDir.
 * NO toca el db real salvo lectura directa pasada por detectDataDir (los tests
 * siempre usan temp dirs). Devuelve info {manifest, parts, warnings, ...}.
 */
export function makeBackup({
  dataDir, configDir,
  passphrase = null,
  maxPartBytes = 80 * 1024 * 1024,
  outDir,
  lang = DEFAULT_LANG,
}) {
  if (!(Number(maxPartBytes) > 0)) {
    throw new Error(t(lang, 'err.bad_part', { value: maxPartBytes }));
  }
  const { entries, warnings } = collectFiles(dataDir, configDir);
  const tar = buildTar(entries);
  const gz = zlib.gzipSync(tar, { level: 6 });
  const checksum = hexSha256(gz);
  const encrypted = Boolean(passphrase);
  const final = encrypted ? encryptBuffer(gz, passphrase) : gz;

  fs.mkdirSync(outDir, { recursive: true });
  const parts = Math.max(1, Math.ceil(final.length / maxPartBytes));
  const partFiles = [];
  for (let i = 0; i < parts; i++) {
    const name = `part.${String(i).padStart(3, '0')}`;
    const slice = final.subarray(i * maxPartBytes, Math.min((i + 1) * maxPartBytes, final.length));
    fs.writeFileSync(path.join(outDir, name), slice);
    partFiles.push(name);
  }
  const dataBytes = entries.reduce((a, e) => a + e.size, 0); // bytes de datos reales
  const manifest = {
    date: new Date().toISOString(),
    machine: os.hostname(),
    counts: { files: entries.length, bytes: dataBytes },
    parts,
    size: final.length,
    encrypted,
    checksum,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (tar.length > WARNING_BYTES) {
    warnings.push(`big_backup:${tar.length}`);
  }
  return { manifest, outDir, partFiles, warnings, encrypted, rawSize: tar.length };
}

// ---------------------------------------------------------------- restore

function joinPartFiles(sourceDir, parts, lang) {
  const bufs = [];
  for (let i = 0; i < parts; i++) {
    const name = `part.${String(i).padStart(3, '0')}`;
    const file = path.join(sourceDir, name);
    if (!fs.existsSync(file)) throw new Error(t(lang, 'err.part_missing', { part: name }));
    bufs.push(fs.readFileSync(file));
  }
  return Buffer.concat(bufs);
}

/**
 * restoreBackup({sourceDir, targetDataDir, targetConfigDir, passphrase, dryRun, overwrite, lang}):
 * lee manifest, concatena parts en orden, descifra si encrypted, gunzip y extrae
 * el tar en los destinos ('config/...' -> targetConfigDir, 'data/...' -> targetDataDir).
 * Rechaza path traversal. dryRun: solo reporta. Sin overwrite NO sobreescribe.
 */
export function restoreBackup({
  sourceDir,
  targetDataDir,
  targetConfigDir,
  passphrase = null,
  dryRun = false,
  overwrite = false,
  lang = DEFAULT_LANG,
}) {
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(t(lang, 'err.no_backup', { dir: sourceDir }));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(t(lang, 'err.tar_corrupt'));
  }
  const parts = Number(manifest.parts) || 1;
  let final = joinPartFiles(sourceDir, parts, lang);
  if (manifest.encrypted) {
    if (!passphrase) throw new Error(t(lang, 'err.pass_required'));
    final = decryptBuffer(final, passphrase, lang);
  }
  // checksum: sha256 del respaldo en claro (el gz), ANTES de descomprimir
  if (manifest.checksum && hexSha256(final) !== manifest.checksum) {
    throw new Error(t(lang, 'err.tar_corrupt'));
  }
  let tar;
  try {
    tar = zlib.gunzipSync(final);
  } catch {
    throw new Error(t(lang, 'err.tar_corrupt'));
  }
  const entries = parseTar(tar, lang);

  if (dryRun) {
    const plan = entries.map((e) => {
      const n = safeEntryName(e.name, lang);
      const isConfig = n.startsWith('config/');
      const rel = isConfig ? n.slice('config/'.length) : n.replace(/^data\//, '');
      const root = isConfig ? targetConfigDir : targetDataDir;
      return { name: n, size: e.size, dest: path.join(root, rel) };
    });
    let bytes = 0;
    for (const p of plan) bytes += p.size;
    return { dryRun: true, files: plan.length, bytes, plan, manifest };
  }

  let restored = 0, skipped = 0;
  for (const entry of entries) {
    const n = safeEntryName(entry.name, lang);
    const isConfig = n.startsWith('config/');
    if (!isConfig && !n.startsWith('data/')) {
      throw new Error(t(lang, 'err.traverse', { entry: entry.name }));
    }
    // 'config/<rel>' -> targetConfigDir, 'data/<rel>' -> targetDataDir (storage conserva anidación)
    const rel = isConfig ? n.slice('config/'.length) : n.replace(/^data\//, '');
    const root = isConfig ? targetConfigDir : targetDataDir;
    const dest = path.join(root, rel);
    if (fs.existsSync(dest) && !overwrite) { skipped++; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.data);
    restored++;
  }
  return { dryRun: false, files: restored, skipped, manifest };
}
