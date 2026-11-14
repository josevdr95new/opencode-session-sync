// opencode-sync · motor de respaldo STREAMING: tar ustar + gzip + cifrado + troceado en parts
// Cero dependencias: node:fs / node:path / node:zlib / node:crypto / node:os / node:stream
// El tar se genera entrada a entrada (tarSource), gzip/cifrado van por pipeline
// (createGzip / createCipheriv) y el troceado en part.NNN es streaming: el motor
// mantiene ~buffers de tubería en RAM (nada del tamaño del backup).
// Progreso REAL por bytes vía onProgress({phase, percent, bytes, total, detail?}):
// - makeBackup: scan (0..2) · pack (2..85, bytes originales) · parts (85..100).
// - restoreBackup: read (0..45) · unpack (45..75) · extract (75..100).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { DEFAULT_LANG, t } from './i18n.mjs';
import { deriveKey, SALT_LEN, IV_LEN, TAG_LEN } from './crypto.mjs';

const BLOCK = 512;
const WARNING_BYTES = 500 * 1024 * 1024; // >500 MB -> aviso (sin truncar contenido)
/** Nombres excluidos en cualquier nivel al recopilar archivos. */
const EXCLUDE = new Set(['node_modules', '.git', 'sync-backup', 'sync.json', 'sync-auth.json']);
/** Formato binario de cifrado (ver src/crypto.mjs): MAGIC 'OCES1' + salt + iv + ct + tag. */
const MAGIC = Buffer.from('OCES1', 'ascii');
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN; // 33 bytes de cabecera
const COPY_CHUNK = 1024 * 1024; // 1 MiB por chunk en copias/troceado streaming
const ZERO_TAIL = Buffer.alloc(BLOCK * 2, 0);

export function hexSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Error de dominio: viaja intacto a través de pipelines (no se re-mapea a tar_corrupt). */
function domainError(message) {
  const e = new Error(message);
  e.localized = true;
  return e;
}

/** Error tipado 'cancelled' (misma técnica localized/domesticada que los i18n-errors).
 *  `signal.aborted` / AbortError del pipeline se convierten SIEMPRE en este error. */
export function cancelledError(lang) {
  const e = domainError(t(lang, 'err.cancelled'));
  e.cancelled = true;
  return e;
}

/** ¿Es una cancelación (AbortSignal abortado o AbortError del pipeline)? */
function isAbort(err, signal) {
  return Boolean(signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR');
}

/** Detector público (index.mjs mapea este error al tipo RPC 'cancelled'). */
export function isCancelledError(err) {
  return Boolean(err && (err.cancelled === true || err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

function clampPercent(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function noop() {}

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

/** Cabecera ustar de 512 bytes para un archivo regular (compartida sync/streaming). */
function headerBlock(name, size, mtimeSec) {
  const head = Buffer.alloc(BLOCK, 0);
  const { namePart, prefix } = splitName(name);
  head.write(namePart.padEnd(100, '\0'), 0, 100, 'utf8');
  head.write((octalField(0o644, 7) + '\0'), 100, 8, 'ascii'); // mode
  head.write('0000000\0', 108, 8, 'ascii'); // uid
  head.write('0000000\0', 116, 8, 'ascii'); // gid
  head.write(octalField(size, 11) + ' ', 124, 12, 'ascii'); // size (11 dígitos + espacio)
  head.write(octalField(mtimeSec, 11) + ' ', 136, 12, 'ascii'); // mtime
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
  return head;
}

/**
 * buildTar(entries: [{name, size, read}]) -> Buffer tar ustar clásico.
 * Se ordenan por nombre para salida determinista. (Compat: usado por tests/scripts;
 * el motor streaming usa tarSource(), que produce EXACTAMENTE los mismos bytes.)
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
    const mtimeSec = Math.floor(Date.now() / 1000) % 0o77777777777;
    chunks.push(headerBlock(name, data.length, mtimeSec), data);
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

/** parseTar(buf) -> [{name, size, data}] (solo archivos regulares; resto se consume).
 *  Compat: usado por tests; restoreBackup usa el extractor streaming (TarExtractor). */
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
        stream: () => fs.createReadStream(abs, { highWaterMark: COPY_CHUNK }),
      });
    }
  }
  return entries;
}

/**
 * Recopila archivos de BOTH dirs según la especificación:
 * - configDir: todo salvo node_modules/.git/sync-backup/sync.json/sync-auth.json
 * - dataDir: opencode.db (shm/wal ignorados por consistencia) + storage/ recursivo
 * Cada entrada trae read() (compat/sync) y stream() (motor streaming, sin cargar en RAM).
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
        entries.push({
          name: 'data/opencode.db',
          size: st.size,
          read: () => fs.readFileSync(abs),
          stream: () => fs.createReadStream(abs, { highWaterMark: COPY_CHUNK }),
        });
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

// ---------------------------------------------------------------- streaming crypto

/** Cipher OCES1 como Transform: primero MAGIC+salt+iv, luego ct, y en flush ct+tag.
 *  Produce EXACTAMENTE los bytes de encryptBuffer (compat con restores previos). */
function encryptTrailer(passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt).key, iv);
  let started = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        const out = started ? cipher.update(chunk) : Buffer.concat([header, cipher.update(chunk)]);
        started = true;
        cb(null, out);
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try { cb(null, Buffer.concat([cipher.final(), cipher.getAuthTag()])); }
      catch (e) { cb(e); }
    },
  });
}

/** Decipher OCES1 como Transform: parsea la cabecera al vuelo y retiene una ventana
 *  deslizante de los últimos TAG_LEN bytes (el tag GCM viaja al final del blob).
 *  Todo lo anterior SÍ es ciphertext definitivo y se emite descifrado al vuelo.
 *  Passphrase mala o blob alterado -> err.passphrase; cabecera mala -> err.corrupt. */
function decipherTrailer(passphrase, lang) {
  let decipher = null;
  let tail = Buffer.alloc(0); // últimos <=TAG_LEN bytes vistos (candidatos a tag)
  const feed = (chunk) => {
    const joined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    if (joined.length <= TAG_LEN) { tail = joined; return null; }
    const cut = joined.length - TAG_LEN;
    tail = joined.subarray(cut); // ventana final retenida
    return decipher.update(joined.subarray(0, cut)); // ciphertext definitivo
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (!decipher) {
          const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
          if (buf.length < HEADER_LEN) { tail = buf; return cb(); } // cabecera aún incompleta
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
            return cb(domainError(t(lang, 'err.corrupt')));
          }
          const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
          const iv = buf.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
          decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt).key, iv);
          tail = Buffer.alloc(0);
          const out = feed(buf.subarray(HEADER_LEN));
          cb(null, out && out.length ? out : undefined);
        } else {
          const out = feed(chunk);
          cb(null, out && out.length ? out : undefined);
        }
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (!decipher) return cb(domainError(t(lang, 'err.corrupt')));
        if (tail.length !== TAG_LEN) return cb(domainError(t(lang, 'err.corrupt')));
        decipher.setAuthTag(tail); // la ventana final ES el tag GCM
        const out = decipher.final();
        cb(null, out && out.length ? out : undefined);
      } catch {
        cb(domainError(t(lang, 'err.passphrase')));
      }
    },
  });
}

// ---------------------------------------------------------------- make backup (streaming)

/**
 * Generador del tar ENTRADA A ENTRADA (mismos bytes que buildTar): cabecera ustar,
 * datos en chunks (stream del disco; fallback entry.read()), padding y cierre.
 * Mientras consume bytes originales llama a report(packed) para el progreso de pack.
 */
async function* tarSource(sorted, mtimeSec, report, signal, lang) {
  let packed = 0;
  const pushData = function* (chunk) {
    if (signal?.aborted) throw cancelledError(lang); // cancelación por chunk
    packed += chunk.length;
    report(packed);
    yield chunk;
  };
  for (const entry of sorted) {
    if (signal?.aborted) throw cancelledError(lang); // cancelación por entrada
    const name = normalizeName(entry.name);
    if (!name) throw new Error('tar: entrada sin nombre');
    const head = headerBlock(name, entry.size, mtimeSec);
    yield head;
    if (typeof entry.stream === 'function') {
      let entryBytes = 0;
      for await (const chunk of entry.stream()) {
        if (signal?.aborted) throw cancelledError(lang);
        if (!Buffer.isBuffer(chunk)) continue;
        entryBytes += chunk.length;
        yield* pushData(chunk);
      }
      if (entryBytes !== entry.size) {
        throw new Error(`tar: tamaño incoherente para ${name}`);
      }
    } else {
      const data = entry.read();
      if (!Buffer.isBuffer(data) || data.length !== entry.size) {
        throw new Error(`tar: tamaño incoherente para ${name}`);
      }
      for (let off = 0; off < data.length; off += COPY_CHUNK) {
        yield* pushData(data.subarray(off, Math.min(off + COPY_CHUNK, data.length)));
      }
    }
    const pad = align(entry.size) - entry.size;
    if (pad) {
      yield Buffer.alloc(pad, 0);
    }
  }
  if (signal?.aborted) throw cancelledError(lang);
  yield ZERO_TAIL;
}

/**
 * makeBackup({dataDir, configDir, passphrase, maxPartBytes, outDir, lang, onProgress, signal}):
 * tar streaming -> gzip(6) -> [cifrar OCES1] -> pack.tmp -> trocear en part.000.. (streaming)
 * + manifest.json en outDir. NO mantiene en RAM nada del tamaño del backup.
 * Progreso: scan 0..2 · pack 2..85 (bytes originales) · parts 85..100 (bytes escritos).
 * El checksum sigue siendo el sha256 hex del gz EN CLARO (compat restores previos).
 * Cancelación: `signal?: AbortSignal` — se comprueba antes de cada fase y dentro de los
 * bucles/streams (pipeline con { signal }); al abortar LIMPIA los outputs parciales
 * (pack.tmp, part.NNN y manifest.json ya escritos en outDir) y lanza error tipado
 * 'cancelled' con mensaje i18n err.cancelled.
 */
export async function makeBackup({
  dataDir, configDir,
  passphrase = null,
  maxPartBytes = 80 * 1024 * 1024,
  outDir,
  lang = DEFAULT_LANG,
  onProgress,
  signal,
}) {
  if (signal?.aborted) throw cancelledError(lang); // cancelado antes de empezar
  if (!(Number(maxPartBytes) > 0)) {
    throw new Error(t(lang, 'err.bad_part', { value: maxPartBytes }));
  }
  const emit = typeof onProgress === 'function' ? onProgress : noop;
  const { entries, warnings } = collectFiles(dataDir, configDir);
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const totalData = entries.reduce((a, e) => a + e.size, 0);
  const mtimeSec = Math.floor(Date.now() / 1000) % 0o77777777777;

  fs.mkdirSync(outDir, { recursive: true });
  const tmpPack = path.join(outDir, 'pack.tmp');
  const encrypted = Boolean(passphrase);
  // Longitud EXACTA del tar: cabecera+datos+paddings por entrada + bloque doble de cierre.
  const rawSize = BLOCK * sorted.length + sorted.reduce((a, e) => a + align(e.size), 0) + BLOCK * 2;
  // pipeline(..., { signal }): cancelación streaming nativa de node:stream/promises.
  const pipeOpts = signal ? { signal } : {};

  try {
    emit({ phase: 'scan', percent: 0, bytes: 0, total: entries.length, detail: `${entries.length} ${t(lang, 'prog.files')}` });
    emit({ phase: 'scan', percent: 2, bytes: entries.length, total: entries.length, detail: `${entries.length} ${t(lang, 'prog.files')}` });
    if (signal?.aborted) throw cancelledError(lang); // cancelado antes de la fase pack
    // FASE pack: tar+gzip+[cifrar] en UNA pipeline; % por bytes ORIGINALES consumidos.
    const hash = crypto.createHash('sha256');
    const tally = new Transform({
      transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); }, // gz EN CLARO
    });
    const report = (packed) => emit({
      phase: 'pack',
      percent: clampPercent(totalData > 0 ? 2 + (83 * packed) / totalData : 85, 2, 85),
      bytes: packed,
      total: totalData,
    });
    const source = Readable.from(tarSource(sorted, mtimeSec, report, signal, lang));
    const packStages = encrypted
      ? [source, zlib.createGzip({ level: 6 }), tally, encryptTrailer(passphrase), fs.createWriteStream(tmpPack)]
      : [source, zlib.createGzip({ level: 6 }), tally, fs.createWriteStream(tmpPack)];
    await pipeline(...packStages, pipeOpts);
    const checksum = hash.digest('hex'); // sha256 del gz EN CLARO (compat)
    const finalSize = fs.statSync(tmpPack).size;

    emit({ phase: 'pack', percent: 85, bytes: totalData, total: totalData });

    // FASE parts: trocear streaming pack.tmp -> part.000.. (85..100 por bytes escritos).
    if (signal?.aborted) throw cancelledError(lang); // cancelado antes de la fase parts
    const parts = Math.max(1, Math.ceil(finalSize / maxPartBytes));
    const partFiles = [];
    let written = 0;
    for (let i = 0; i < parts; i++) {
      if (signal?.aborted) throw cancelledError(lang); // cancelado por parte
      const name = `part.${String(i).padStart(3, '0')}`;
      const start = i * maxPartBytes;
      const end = Math.min((i + 1) * maxPartBytes, finalSize) - 1;
      let done = 0;
      const len = end - start + 1;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          done += chunk.length;
          emit({
            phase: 'parts',
            percent: clampPercent(85 + (15 * (written + done)) / finalSize, 85, 100),
            bytes: written + done,
            total: finalSize,
            detail: name,
          });
          cb(null, chunk);
        },
      });
      await pipeline(
        fs.createReadStream(tmpPack, { start, end }),
        counter,
        fs.createWriteStream(path.join(outDir, name)),
        pipeOpts,
      );
      written += len;
      partFiles.push(name);
      emit({ phase: 'parts', percent: clampPercent(85 + (15 * written) / finalSize, 85, 100), bytes: written, total: finalSize, detail: name });
    }

    const manifest = {
      date: new Date().toISOString(),
      machine: os.hostname(),
      counts: { files: entries.length, bytes: totalData },
      parts,
      size: finalSize,
      encrypted,
      checksum,
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    if (rawSize > WARNING_BYTES) {
      warnings.push(`big_backup:${rawSize}`);
    }
    emit({ phase: 'parts', percent: 100, bytes: finalSize, total: finalSize });
    return { manifest, outDir, partFiles, warnings, encrypted, rawSize };
  } catch (err) {
    // AbortSignal/AbortError -> error tipado 'cancelled' (mensaje i18n, marca .cancelled).
    if (isAbort(err, signal)) throw cancelledError(lang);
    throw err;
  } finally {
    try { fs.rmSync(tmpPack, { force: true }); } catch { /* noop */ }
    if (signal?.aborted) cleanPartialOutput(outDir);
  }
}

/** Limpieza de outputs PARCIALES tras una cancelación: part.NNN + manifest.json de outDir. */
function cleanPartialOutput(outDir) {
  let names;
  try { names = fs.readdirSync(outDir); } catch { return; }
  for (const name of names) {
    if (name === 'manifest.json' || /^part\.\d{3}$/.test(name)) {
      try { fs.rmSync(path.join(outDir, name), { force: true }); } catch { /* noop */ }
    }
  }
}

// ---------------------------------------------------------------- restore

/**
 * Extractor tar STREAMING (Writable): procesa bloques ustar incrementales sin cargar
 * el tar completo en RAM. Entrega cada entrada por callbacks:
 * onBegin({name, size}) -> onData(chunk)* -> onEndEntry(). Respeta backpressure
 * (el callback de _write espera al trabajo async). State machine:
 * header (acumula 512B) -> data / skip (padding o entradas no regulares) -> done.
 */
class TarExtractor extends Writable {
  constructor({ onBegin, onData, onEndEntry, lang }) {
    super();
    this.onBegin = onBegin;
    this.onData = onData;
    this.onEndEntry = onEndEntry;
    this.lang = lang || 'es';
    this.queue = [];      // chunks pendientes
    this.queued = 0;
    this.state = 'header';
    this.remain = 0;
    this.pad = 0;
    this.cur = null;
  }

  _write(chunk, _enc, cb) {
    this.queue.push(chunk);
    this.queued += chunk.length;
    this.drain().then(() => cb(), (err) => cb(err));
  }

  async drain() {
    for (;;) {
      if (this.state === 'done') { this.queue = []; this.queued = 0; return; }
      if (this.state === 'header') {
        if (this.queued < BLOCK) return;
        const all = this.queue.length === 1 ? this.queue[0] : Buffer.concat(this.queue);
        const rest = all.subarray(BLOCK);
        this.queue = rest.length ? [rest] : [];
        this.queued = rest.length;
        const block = all.subarray(0, BLOCK);
        if (block.every((b) => b === 0)) { this.state = 'done'; return; } // fin de archivo
        // verificación de checksum (igual que parseTar)
        const expect = parseSizeField(block.subarray(148, 156));
        const probe = Buffer.from(block); // copia mutable
        probe.fill(0x20, 148, 156);
        let sum = 0;
        for (const b of probe) sum += b;
        if (sum !== expect) throw domainError(t(this.lang, 'err.tar_corrupt'));
        const rawName = block.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
        const prefix = block.subarray(345, 500).toString('ascii').replace(/\0.*$/, '');
        const name = prefix ? `${prefix}/${rawName}` : rawName;
        const size = parseSizeField(block.subarray(124, 136));
        const typeflag = block[156];
        if (typeflag === 0 || typeflag === 0x30) {
          this.cur = { name, size };
          this.remain = size;
          this.pad = align(size) - size;
          await this.onBegin(this.cur);
          this.state = size > 0 ? 'data' : (this.pad > 0 ? 'skip' : 'header');
          if (size === 0) {
            await this.onEndEntry(this.cur);
          }
        } else {
          this.remain = align(size);
          this.pad = 0;
          this.cur = null;
          this.state = this.remain > 0 ? 'skip' : 'header';
        }
        continue;
      }
      if (this.state === 'data' || this.state === 'skip') {
        if (!this.queue.length) return;
        const first = this.queue[0];
        const take = Math.min(first.length, this.remain);
        const piece = first.subarray(0, take);
        if (this.state === 'data') await this.onData(piece);
        if (take === first.length) this.queue.shift();
        else this.queue[0] = first.subarray(take);
        this.queued -= take;
        this.remain -= take;
        if (this.remain === 0) {
          if (this.state === 'data') await this.onEndEntry(this.cur);
          this.state = this.pad > 0 ? 'skip' : 'header';
          this.remain = this.pad;
          this.pad = 0;
        }
        continue;
      }
      return;
    }
  }
}

/** Sink de escritura de una entrada: createWriteStream + write/drain/end con await.
 *  Rechaza en lugar de colgarse si falla la E/S (disco lleno, permisos, etc.). */
function makeEntrySink(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ws = fs.createWriteStream(dest);
  let failed = null;
  ws.on('error', (e) => { failed = e; });
  const waitDrain = () => new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(e || failed || new Error('write failed')); };
    const cleanup = () => { ws.off('drain', onDrain); ws.off('error', onErr); };
    ws.once('drain', onDrain);
    ws.once('error', onErr);
  });
  return {
    async write(chunk) {
      if (failed) throw failed;
      if (!ws.write(chunk)) await waitDrain();
    },
    async end() {
      if (failed) throw failed;
      await new Promise((resolve, reject) => {
        const onErr = (e) => reject(e || failed || new Error('write failed'));
        ws.once('error', onErr);
        ws.end(() => { ws.off('error', onErr); resolve(); });
      });
    },
  };
}

function readManifest(sourceDir, lang) {
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(t(lang, 'err.no_backup', { dir: sourceDir }));
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(t(lang, 'err.tar_corrupt'));
  }
}

/**
 * restoreBackup({sourceDir, targetDataDir, targetConfigDir, passphrase, dryRun,
 * overwrite, lang, onProgress, signal}): TRES pasadas streaming (RAM acotada):
 * 1) read 0..45: concatena part.000.. -> tmp (bytes leídos / manifest.size)
 * 2) unpack 45..75: [descifrar OCES1] -> sha256 (verificación) -> gunzip -> tmp tar
 * 3) extract 75..100: parser tar streaming -> destino (bytes extraídos / tar total)
 * Rechaza path traversal; dryRun no escribe nada; sin overwrite NO sobreescribe.
 * Compat de checksum intacto: sha256 del gz EN CLARO tras descifrar, antes de gunzip.
 * Cancelación: `signal?: AbortSignal` — comprobada antes de cada fase y dentro del
 * bucle de parts/chunks (pipelines con { signal }); al abortar borra sus tmp
 * (concat.bin/tar.bin) en el finally y lanza error tipado 'cancelled' (err.cancelled).
 */
export async function restoreBackup({
  sourceDir,
  targetDataDir,
  targetConfigDir,
  passphrase = null,
  dryRun = false,
  overwrite = false,
  lang = DEFAULT_LANG,
  onProgress,
  signal,
}) {
  if (signal?.aborted) throw cancelledError(lang); // cancelado antes de empezar
  const emit = typeof onProgress === 'function' ? onProgress : noop;
  const manifest = readManifest(sourceDir, lang);
  const parts = Number(manifest.parts) || 1;
  const partPaths = [];
  let partsBytes = 0;
  for (let i = 0; i < parts; i++) {
    if (signal?.aborted) throw cancelledError(lang); // cancelado durante el escaneo de parts
    const name = `part.${String(i).padStart(3, '0')}`;
    const file = path.join(sourceDir, name);
    if (!fs.existsSync(file)) throw new Error(t(lang, 'err.part_missing', { part: name }));
    partPaths.push(file);
    partsBytes += fs.statSync(file).size;
  }
  const totalSize = Number(manifest.size) > 0 ? Number(manifest.size) : partsBytes;
  if (manifest.encrypted && !passphrase) throw new Error(t(lang, 'err.pass_required'));
  const pipeOpts = signal ? { signal } : {};

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oces-restore-'));
  const tmpConcat = path.join(tmp, 'concat.bin');
  const tmpTar = path.join(tmp, 'tar.bin');
  try {
    // ------------------------------------------------ FASE read (0..45)
    if (signal?.aborted) throw cancelledError(lang); // cancelado antes de la fase read
    emit({ phase: 'read', percent: 0, bytes: 0, total: totalSize });
    let readBytes = 0;
    const readCounter = new Transform({
      transform(chunk, _enc, cb) {
        readBytes += chunk.length;
        emit({ phase: 'read', percent: clampPercent((45 * readBytes) / totalSize, 0, 45), bytes: readBytes, total: totalSize });
        cb(null, chunk);
      },
    });
    async function* concatParts(paths) {
      for (const p of paths) {
        if (signal?.aborted) throw cancelledError(lang); // cancelado por parte
        for await (const chunk of fs.createReadStream(p, { highWaterMark: COPY_CHUNK })) {
          if (signal?.aborted) throw cancelledError(lang); // cancelado por chunk
          yield chunk;
        }
      }
    }
    await pipeline(Readable.from(concatParts(partPaths)), readCounter, fs.createWriteStream(tmpConcat), pipeOpts);
    emit({ phase: 'read', percent: 45, bytes: readBytes, total: totalSize });

    // ------------------------------------------------ FASE unpack (45..75)
    // [descifrar] -> sha256 del gz EN CLARO (verificación antes de gunzip, como antes)
    // -> gunzip -> tmpTar. % por bytes de entrada consumidos / manifest.size.
    if (signal?.aborted) throw cancelledError(lang); // cancelado antes de la fase unpack
    emit({ phase: 'unpack', percent: 45, bytes: 0, total: totalSize });
    const hash = crypto.createHash('sha256');
    let unpackBytes = 0;
    const unpackCounter = new Transform({
      transform(chunk, _enc, cb) {
        unpackBytes += chunk.length;
        emit({ phase: 'unpack', percent: clampPercent(45 + (30 * unpackBytes) / totalSize, 45, 75), bytes: unpackBytes, total: totalSize });
        cb(null, chunk);
      },
    });
    const tally = new Transform({
      transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); },
    });
    const stages = [fs.createReadStream(tmpConcat, { highWaterMark: COPY_CHUNK }), unpackCounter];
    if (manifest.encrypted) stages.push(decipherTrailer(passphrase, lang));
    stages.push(tally, zlib.createGunzip(), fs.createWriteStream(tmpTar), pipeOpts);
    try {
      await pipeline(...stages);
    } catch (err) {
      if (isAbort(err, signal)) throw cancelledError(lang); // cancelación, no corrupción
      if (err && err.localized) throw err;
      // Precedencia igual al motor buffer: con cifrado, gunzip solo recibe basura si
      // el tag GCM falló (passphrase mala o blob alterado) -> err.passphrase.
      if (manifest.encrypted) throw domainError(t(lang, 'err.passphrase'));
      throw domainError(t(lang, 'err.tar_corrupt'));
    }
    if (manifest.checksum && hash.digest('hex') !== manifest.checksum) {
      throw domainError(t(lang, 'err.tar_corrupt'));
    }
    emit({ phase: 'unpack', percent: 75, bytes: unpackBytes, total: totalSize });

    // ------------------------------------------------ FASE extract (75..100)
    // Parser tar streaming; % por bytes extraídos / bytes totales del tar.
    if (signal?.aborted) throw cancelledError(lang); // cancelado antes de la fase extract
    const tarSize = fs.statSync(tmpTar).size;
    emit({ phase: 'extract', percent: 75, bytes: 0, total: tarSize });
    let extracted = 0;
    let restored = 0;
    let skipped = 0;
    const plan = [];
    let sink = null;

    const extractor = new TarExtractor({
      lang,
      async onBegin(cur) {
        let n;
        try {
          n = safeEntryName(cur.name, lang); // rechaza traversal/absolutas
        } catch (e) {
          throw domainError(e.message); // viaja intacto a través del pipeline
        }
        if (dryRun) {
          const isConfig = n.startsWith('config/');
          const rel = isConfig ? n.slice('config/'.length) : n.replace(/^data\//, '');
          const root = isConfig ? targetConfigDir : targetDataDir;
          plan.push({ name: n, size: cur.size, dest: path.join(root, rel) });
          sink = null;
          return;
        }
        const isConfig = n.startsWith('config/');
        if (!isConfig && !n.startsWith('data/')) {
          throw domainError(t(lang, 'err.traverse', { entry: cur.name }));
        }
        // 'config/<rel>' -> targetConfigDir, 'data/<rel>' -> targetDataDir (storage conserva anidación)
        const rel = isConfig ? n.slice('config/'.length) : n.replace(/^data\//, '');
        const root = isConfig ? targetConfigDir : targetDataDir;
        const dest = path.join(root, rel);
        cur.dest = dest;
        if (fs.existsSync(dest) && !overwrite) { skipped++; sink = null; return; }
        sink = makeEntrySink(dest);
      },
      async onData(piece) {
        // progreso por bytes consumidos del tar (escritos o contados en dryRun/skip)
        extracted += piece.length;
        if (sink) await sink.write(piece);
        emit({
          phase: 'extract',
          percent: clampPercent(75 + (25 * extracted) / tarSize, 75, 100),
          bytes: extracted,
          total: tarSize,
        });
      },
      async onEndEntry(cur) {
        if (sink) {
          await sink.end();
          restored++;
        }
        sink = null;
        emit({
          phase: 'extract',
          percent: clampPercent(75 + (25 * extracted) / tarSize, 75, 100),
          bytes: extracted,
          total: tarSize,
          detail: path.basename(cur.dest || cur.name),
        });
      },
    });
    try {
      await pipeline(fs.createReadStream(tmpTar, { highWaterMark: COPY_CHUNK }), extractor, pipeOpts);
    } catch (err) {
      if (isAbort(err, signal)) throw cancelledError(lang); // cancelación, no corrupción
      if (err && err.localized) throw err;
      throw domainError(t(lang, 'err.tar_corrupt'));
    }
    emit({ phase: 'extract', percent: 100, bytes: extracted, total: tarSize });

    if (dryRun) {
      let bytes = 0;
      for (const p of plan) bytes += p.size;
      return { dryRun: true, files: plan.length, bytes, plan, manifest };
    }
    return { dryRun: false, files: restored, skipped, manifest };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
