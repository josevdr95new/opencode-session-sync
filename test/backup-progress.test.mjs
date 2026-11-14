// backup/restore STREAMING: progreso real por bytes, compatibilidad de checksum con
// el motor buffer anterior, roundtrip cifrado multi-part y path traversal en el
// extractor streaming. Todo con temp dirs: NUNCA toca el opencode.db real.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeBackup, restoreBackup, collectFiles, buildTar, hexSha256 } from '../src/backup.mjs';
import { t } from '../src/i18n.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-prog-${n}-`));

// fixture pequeño: db incompresible + storage + config (como buildDataDir de backup.test)
function buildFixture() {
  const dataDir = mkTemp('data');
  fs.mkdirSync(path.join(dataDir, 'storage', 'session', 'xyz'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(300 * 1024));
  fs.writeFileSync(path.join(dataDir, 'storage', 'session', 'xyz', 'msg.json'), '{"m":1}');
  const configDir = mkTemp('cfg');
  fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), '{}');
  fs.writeFileSync(path.join(configDir, 'agent.md'), '# agente');
  return { dataDir, configDir };
}

/** Camino LEGACY (motor buffer anterior) para comparar checksum/bytes: misma semántica
 *  que el makeBackup viejo: collectFiles -> buildTar -> gzipSync(6) -> [encrypt] */
function legacyFinalBlob(dataDir, configDir, passphrase) {
  const { entries } = collectFiles(dataDir, configDir);
  const tar = buildTar(entries);
  const gz = zlib.gzipSync(tar, { level: 6 });
  if (!passphrase) return gz;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  return Buffer.concat([Buffer.from('OCES1', 'ascii'), salt, iv, ct, cipher.getAuthTag()]);
}

/** Congela Date.now para que el campo mtime del tar sea idéntico en ambos motores. */
function withFrozenClock(fn) {
  const real = Date.now;
  Date.now = () => 1700000000000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test('onProgress makeBackup: fases scan→pack→parts en orden, percent monótono, último 100 y bytes<=total', async () => {
  const { dataDir, configDir } = buildFixture();
  const outDir = mkTemp('prog-out');
  const events = [];
  const info = await makeBackup({
    dataDir, configDir, outDir, maxPartBytes: 64 * 1024,
    onProgress: (p) => events.push({ ...p }),
  });
  assert.ok(events.length >= 4, 'hay eventos de progreso');
  // fases en orden correcto, sin repetirse en bloques desordenados
  const phaseOrder = [];
  for (const e of events) {
    if (phaseOrder[phaseOrder.length - 1] !== e.phase) phaseOrder.push(e.phase);
  }
  assert.deepEqual(phaseOrder, ['scan', 'pack', 'parts']);
  // percent monótono no-decreciente y en [0,100]
  let prev = -1;
  for (const e of events) {
    assert.ok(e.percent >= prev, `percent monótono: ${prev} -> ${e.percent}`);
    assert.ok(e.percent >= 0 && e.percent <= 100, `percent en rango: ${e.percent}`);
    assert.ok(e.bytes <= e.total, `bytes<=total: ${e.bytes}/${e.total}`);
    prev = e.percent;
  }
  // fines de fase exactos y final 100
  assert.equal(events[0].percent, 0);
  assert.ok(events.some((e) => e.phase === 'scan' && e.percent === 2), 'fin de scan en 2');
  assert.ok(events.some((e) => e.phase === 'pack' && e.percent === 85), 'fin de pack en 85');
  const last = events[events.length - 1];
  assert.equal(last.percent, 100);
  assert.equal(last.phase, 'parts');
  assert.equal(last.bytes, info.manifest.size);
});

test('checksum compat: el motor streaming produce el MISMO sha256 (y bytes) que el motor buffer viejo', () => {
  const { dataDir, configDir } = buildFixture();
  // congelar el reloj: el mtime vive DENTRO del tar, ambos motores deben coincidir
  const legacy = withFrozenClock(() => legacyFinalBlob(dataDir, configDir, null));
  const legacySha = sha(legacy);
  const outDir = mkTemp('compat-out');
  const info = withFrozenClock(() => makeBackup({
    dataDir, configDir, outDir, maxPartBytes: 64 * 1024,
  }));
  return info.then((res) => {
    assert.equal(res.manifest.checksum, legacySha, 'manifest.checksum == sha256 del gz en claro del motor viejo');
    // evidencia extra: los parts concatenados son BYTE A BYTE el blob final legacy
    const chunks = [];
    for (let i = 0; i < res.manifest.parts; i++) {
      chunks.push(fs.readFileSync(path.join(outDir, `part.${String(i).padStart(3, '0')}`)));
    }
    const joined = Buffer.concat(chunks);
    assert.equal(res.manifest.size, legacy.length);
    assert.ok(joined.equals(legacy), 'blob final byte-idéntico al motor buffer (gzip determinista)');
    assert.equal(hexSha256(joined), res.manifest.checksum.replace(/^/, '')); // sha de los bytes == manifest
    assert.equal(joined.length, Buffer.concat(chunks).length);
  });
});

test('roundtrip streaming con cifrado y EXACTAMENTE 2 parts: contenido restaurado idéntico', async () => {
  const { dataDir, configDir } = buildFixture();
  // probe cifrado con reloj congelado: tamaño determinista (gz + 49B de OCES1) para
  // elegir maxPartBytes = size/2 y forzar parts===2 exacto
  const probeDir = mkTemp('probe');
  const probe = await withFrozenClock(() => makeBackup({
    dataDir, configDir, outDir: probeDir, passphrase: 'dos-partes', maxPartBytes: 64 * 1024,
  }));
  const exactPart = Math.ceil(probe.manifest.size / 2);
  const outDir = mkTemp('rt-out');
  const info = await withFrozenClock(() => makeBackup({
    dataDir, configDir, outDir, passphrase: 'dos-partes', maxPartBytes: exactPart,
  }));
  assert.equal(info.manifest.parts, 2, `parts exactamente 2, got ${info.manifest.parts}`);
  assert.equal(info.manifest.encrypted, true);
  const targetData = mkTemp('rt-data');
  const targetConfig = mkTemp('rt-cfg');
  const res = await restoreBackup({
    sourceDir: outDir, targetDataDir: targetData, targetConfigDir: targetConfig,
    passphrase: 'dos-partes', overwrite: true,
  });
  assert.equal(res.files, 4); // db + msg.json + jsonc + agent.md
  assert.equal(res.skipped, 0);
  const pairs = [
    [path.join(targetData, 'opencode.db'), path.join(dataDir, 'opencode.db')],
    [path.join(targetData, 'storage', 'session', 'xyz', 'msg.json'), path.join(dataDir, 'storage', 'session', 'xyz', 'msg.json')],
    [path.join(targetConfig, 'opencode.jsonc'), path.join(configDir, 'opencode.jsonc')],
    [path.join(targetConfig, 'agent.md'), path.join(configDir, 'agent.md')],
  ];
  for (const [rest, orig] of pairs) {
    assert.equal(sha(fs.readFileSync(rest)), sha(fs.readFileSync(orig)), rest);
  }
});

test('onProgress restoreBackup: fases read→unpack→extract, monótono, último 100', async () => {
  const { dataDir, configDir } = buildFixture();
  const outDir = mkTemp('rp-out');
  await makeBackup({ dataDir, configDir, outDir, passphrase: 'progreso-r', maxPartBytes: 64 * 1024 });
  const targetData = mkTemp('rp-data');
  const targetConfig = mkTemp('rp-cfg');
  const events = [];
  const res = await restoreBackup({
    sourceDir: outDir, targetDataDir: targetData, targetConfigDir: targetConfig,
    passphrase: 'progreso-r', overwrite: true,
    onProgress: (p) => events.push({ ...p }),
  });
  assert.equal(res.files, 4);
  assert.ok(events.length >= 4, 'hay eventos de restore');
  const phaseOrder = [];
  for (const e of events) {
    if (phaseOrder[phaseOrder.length - 1] !== e.phase) phaseOrder.push(e.phase);
  }
  assert.deepEqual(phaseOrder, ['read', 'unpack', 'extract']);
  let prev = -1;
  for (const e of events) {
    assert.ok(e.percent >= prev, `percent monótono: ${prev} -> ${e.percent}`);
    assert.ok(e.percent >= 0 && e.percent <= 100);
    assert.ok(e.bytes <= e.total, `bytes<=total: ${e.bytes}/${e.total}`);
    prev = e.percent;
  }
  assert.equal(events[events.length - 1].percent, 100);
  assert.equal(events[events.length - 1].phase, 'extract');
});

// tar a mano con dos entradas: la primera legítima, la segunda maliciosa
function buildMixedTar() {
  const head = (name, size) => {
    const h = Buffer.alloc(512, 0);
    h.write(name.padEnd(100, '\0'), 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
    h.write('                ', 136, 12, 'ascii'); // mtime
    h.write('        ', 148, 8, 'ascii');
    h.write('0', 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write((sum.toString(8).padStart(6, '0') + '\0 '), 148, 8, 'ascii');
    return h;
  };
  const chunks = [];
  for (const [name, content] of [['data/good.txt', 'contenido-ok'], ['/abs/evil.txt', 'malicioso']]) {
    const buf = Buffer.from(content);
    chunks.push(head(name, buf.length), buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

test('extractor streaming: path traversal rechazado vía pipeline (error localiza intacto); la entrada previa válida sí se escribió', async () => {
  const sourceDir = mkTemp('trav-src');
  const targetData = mkTemp('trav-data');
  const targetConfig = mkTemp('trav-cfg');
  const gz = zlib.gzipSync(buildMixedTar());
  fs.writeFileSync(path.join(sourceDir, 'part.000'), gz);
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
    date: new Date().toISOString(), machine: 't', counts: { files: 2, bytes: 20 },
    parts: 1, size: gz.length, encrypted: false,
    checksum: crypto.createHash('sha256').update(gz).digest('hex'),
  }));
  await assert.rejects(
    () => restoreBackup({ sourceDir, targetDataDir: targetData, targetConfigDir: targetConfig, overwrite: true }),
    (e) => e.message === t('es', 'err.traverse', { entry: '/abs/evil.txt' })
  );
  // la entrada válida anterior SÍ quedó escrita (mismo comportamiento que el bucle viejo)
  assert.equal(fs.readFileSync(path.join(targetData, 'good.txt'), 'utf8'), 'contenido-ok');
  // y NADA fuera del destino
  assert.ok(!fs.existsSync(path.join(targetConfig, 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(path.dirname(targetData), 'evil.txt')));
});

test('extractor streaming en dryRun: el plan también rechaza traversal y no escribe nada', async () => {
  const sourceDir = mkTemp('trav-dry-src');
  const targetData = mkTemp('trav-dry-data');
  const targetConfig = mkTemp('trav-dry-cfg');
  const gz = zlib.gzipSync(buildMixedTar());
  fs.writeFileSync(path.join(sourceDir, 'part.000'), gz);
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
    date: new Date().toISOString(), machine: 't', counts: { files: 2, bytes: 20 },
    parts: 1, size: gz.length, encrypted: false,
    checksum: crypto.createHash('sha256').update(gz).digest('hex'),
  }));
  await assert.rejects(
    () => restoreBackup({ sourceDir, targetDataDir: targetData, targetConfigDir: targetConfig, dryRun: true }),
    (e) => e.message === t('es', 'err.traverse', { entry: '/abs/evil.txt' })
  );
  assert.equal(fs.readdirSync(targetData).length, 0);
  assert.equal(fs.readdirSync(targetConfig).length, 0);
});

test('runBackup/runRestore aceptan onProgress y lo pasan al motor (shapes de retorno intactos)', async () => {
  const { runBackup, runRestore } = await import('../src/actions.mjs');
  const base = mkTemp('act-env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.alloc(256, 9));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({ provider: 'local', encrypt: false, localDir: path.join(base, 'copias'), parts: '80mb' }));
  const localDir = path.join(base, 'copias');
  const env = { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir };
  const seen = [];
  const res = await runBackup({
    lang: 'es', provider: 'local', output: localDir, env,
    onProgress: (p) => seen.push(p),
  });
  assert.ok(res.message.includes('✓'), 'message shape intacto');
  assert.ok(res.info.manifest.checksum);
  assert.ok(seen.some((e) => e.phase === 'parts' && e.percent === 100), 'onProgress llegó al motor');
  const seenR = [];
  const plan = await runRestore({
    lang: 'es', from: res.info.dest, dryRun: true, env,
    onProgress: (p) => seenR.push(p),
  });
  assert.ok(plan.message.includes('dry-run'), 'dry-run message intacto');
  assert.ok(seenR.some((e) => e.phase === 'extract'), 'restore onProgress llegó al motor');
});
