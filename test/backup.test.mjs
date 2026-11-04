// backup: manifest, exclusión de archivos, multi-part, roundtrip por SHA-256,
// path traversal, dryRun, overwrite y tar determinista.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeBackup, restoreBackup, buildTar, parseTar } from '../src/backup.mjs';
import { t } from '../src/i18n.mjs';

const PART = 256 * 1024; // 256 KiB: fuerza multi-part de forma barata en tests
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-bk-${n}-`));

// dataDir fake: db incompresible ~1.5MB + storage con 2 json (+wal/shm a ignorar)
function buildDataDir() {
  const dataDir = mkTemp('data');
  fs.mkdirSync(path.join(dataDir, 'storage', 'session', 'abc'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(1536 * 1024));
  fs.writeFileSync(path.join(dataDir, 'opencode.db-wal'), 'IGNORED');
  fs.writeFileSync(path.join(dataDir, 'opencode.db-shm'), 'IGNORED');
  fs.writeFileSync(path.join(dataDir, 'storage', 'session', 'abc', 'msg-0.json'), '{"id":"0"}');
  fs.writeFileSync(path.join(dataDir, 'storage', 'session', 'abc', 'part-1.json'), '{"id":1}');
  return dataDir;
}

// configDir fake: 3 válidos + sync.json/sync-auth.json/node_modules excluidos
function buildConfigDir() {
  const configDir = mkTemp('cfg');
  fs.mkdirSync(path.join(configDir, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agent', 'default.md'), '# agent');
  fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), '{}');
  fs.writeFileSync(path.join(configDir, 'sync.json'), '{"provider":"local"}');
  fs.writeFileSync(path.join(configDir, 'sync-auth.json'), '{"passphrase":"x"}');
  fs.mkdirSync(path.join(configDir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'node_modules', 'x', 'i.js'), 'x');
  fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'skills', 'f.md'), 's');
  return configDir;
}

test('makeBackup: manifest correcto, excluye sync/auth/wal/shm, parts <= límite', () => {
  const dataDir = buildDataDir();
  const configDir = buildConfigDir();
  const outDir = mkTemp('out');
  const info = makeBackup({ dataDir, configDir, outDir, maxPartBytes: PART });

  const m = info.manifest;
  assert.equal(m.encrypted, false);
  assert.equal(m.counts.files, 6); // opencode.db + 2 storage + agent + jsonc + skills
  const expectedBytes = 1536 * 1024 + 10 + 8 + 7 + 2 + 1; // opencode.db + msg-0(10) + part-1(8) + agent(7) + jsonc(2) + skills(1)
  assert.equal(m.counts.bytes, expectedBytes);
  assert.ok(m.parts >= 5, `multi-part esperado, got ${m.parts}`);
  assert.match(m.checksum, /^[0-9a-f]{64}$/);
  assert.ok(Math.abs(new Date(m.date).getTime() - Date.now()) < 60_000);

  for (let i = 0; i < m.parts; i++) {
    const st = fs.statSync(path.join(outDir, `part.${String(i).padStart(3, '0')}`));
    if (i < m.parts - 1) assert.ok(st.size <= PART, `part ${i} excede el límite`);
  }
  assert.equal(fs.readdirSync(outDir).length, m.parts + 1); // parts + manifest.json
  const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(onDisk.checksum, m.checksum);
  assert.equal(onDisk.parts, m.parts);
});

test('makeBackup: cifrado activado manifiesto + roundtrip descifra igual', () => {
  const dataDir = mkTemp('enc-edge');
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.alloc(1024, 3));
  const outDir = mkTemp('enc-out');
  const info = makeBackup({ dataDir, configDir: mkTemp('enc-cfg'), passphrase: 'secreta', outDir, maxPartBytes: PART });
  assert.equal(info.encrypted, true);
  assert.equal(info.manifest.encrypted, true);
  const blob = fs.readFileSync(path.join(outDir, 'part.000'));
  assert.equal(blob.subarray(0, 5).toString('ascii'), 'OCES1');
  const tData = mkTemp('enc-td');
  const res = restoreBackup({
    sourceDir: outDir, targetDataDir: tData, targetConfigDir: mkTemp('enc-tc'),
    passphrase: 'secreta', overwrite: true,
  });
  assert.equal(res.files, 1);
  assert.equal(sha(fs.readFileSync(path.join(tData, 'opencode.db'))), sha(fs.readFileSync(path.join(dataDir, 'opencode.db'))));
});

test('restoreBackup roundtrip completo por SHA-256 (cifrado y multi-part)', () => {
  const dataDir = buildDataDir();
  const configDir = buildConfigDir();
  const outDir = mkTemp('enc-out');
  makeBackup({ dataDir, configDir, outDir, passphrase: 'frase-tests', maxPartBytes: PART });
  const targetData = mkTemp('tdata');
  const targetConfig = mkTemp('tcfg');
  const res = restoreBackup({
    sourceDir: outDir, targetDataDir: targetData, targetConfigDir: targetConfig,
    passphrase: 'frase-tests', overwrite: true,
  });
  assert.equal(res.files, 6);
  assert.equal(res.skipped, 0);
  const pairs = [
    [path.join(targetData, 'opencode.db'), path.join(dataDir, 'opencode.db')],
    [path.join(targetData, 'storage', 'session', 'abc', 'msg-0.json'), path.join(dataDir, 'storage', 'session', 'abc', 'msg-0.json')],
    [path.join(targetData, 'storage', 'session', 'abc', 'part-1.json'), path.join(dataDir, 'storage', 'session', 'abc', 'part-1.json')],
    [path.join(targetConfig, 'agent', 'default.md'), path.join(configDir, 'agent', 'default.md')],
    [path.join(targetConfig, 'opencode.jsonc'), path.join(configDir, 'opencode.jsonc')],
    [path.join(targetConfig, 'skills', 'f.md'), path.join(configDir, 'skills', 'f.md')],
  ];
  for (const [rest, orig] of pairs) {
    assert.ok(fs.existsSync(rest), `falta ${rest}`);
    assert.equal(sha(fs.readFileSync(rest)), sha(fs.readFileSync(orig)), rest);
  }
  // excluidos NO restaurados
  assert.ok(!fs.existsSync(path.join(targetConfig, 'sync.json')));
  assert.ok(!fs.existsSync(path.join(targetConfig, 'sync-auth.json')));
  assert.ok(!fs.existsSync(path.join(targetData, 'opencode.db-wal')));
  assert.ok(!fs.existsSync(path.join(targetData, 'opencode.db-shm')));
});

test('restoreBackup: passphrase errónea falla con mensaje localizable', () => {
  const dataDir = mkTemp('d2');
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.alloc(100, 1));
  const outDir = mkTemp('o2');
  makeBackup({ dataDir, configDir: mkTemp('c2'), passphrase: 'buena', outDir, maxPartBytes: PART });
  assert.throws(
    () => restoreBackup({
      sourceDir: outDir, targetDataDir: mkTemp('x'), targetConfigDir: mkTemp('y'), passphrase: 'mala',
    }),
    (e) => e.message === t('es', 'err.passphrase')
  );
});

// tar malicioso hecho a mano
function buildEvilTar(entries) {
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
  for (const [name, content] of entries) {
    const buf = Buffer.from(content);
    chunks.push(head(name, buf.length), buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

test('path traversal / rutas absolutas rechazados, nada se escribe', () => {
  const evils = ['/abs/evil.txt', 'data/../evil.txt', '../evil.txt', 'data/x/../../out.txt', 'C:\\users\\evil.txt'];
  for (const evilName of evils) {
    const sourceDir = mkTemp('evil-src');
    const targetData = mkTemp('evil-data');
    const targetConfig = mkTemp('evil-cfg');
    const outside = path.join(targetData, '..', 'evil.txt');
    if (fs.existsSync(outside)) fs.rmSync(outside);
    const gz = zlib.gzipSync(buildEvilTar([[evilName, 'malicioso']]));
    fs.writeFileSync(path.join(sourceDir, 'part.000'), gz);
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
      date: new Date().toISOString(), machine: 't', counts: { files: 1, bytes: 8 },
      parts: 1, size: gz.length, encrypted: false,
      checksum: crypto.createHash('sha256').update(gz).digest('hex'),
    }));
    let caught = null;
    try {
      restoreBackup({ sourceDir, targetDataDir: targetData, targetConfigDir: targetConfig, overwrite: true });
    } catch (e) { caught = e; }
    assert.ok(caught, `debería rechazar: ${evilName}`);
    assert.equal(caught.message, t('es', 'err.traverse', { entry: evilName }));
    assert.ok(!fs.existsSync(path.join(targetConfig, 'evil.txt')), `no escribió ${path.join(targetConfig, 'evil.txt')}`);
    assert.ok(!fs.existsSync(path.join(targetData, 'out.txt')), `no escribió fuera del destino`);
    assert.ok(!fs.existsSync(path.join(path.dirname(targetData), 'evil.txt')), 'no escribió fuera del destino (..)');
  }
});

test('dryRun: no escribe nada y reporta el plan', () => {
  const dataDir = buildDataDir();
  const configDir = mkTemp('cfgdry');
  fs.writeFileSync(path.join(configDir, 'agent.md'), '#');
  const outDir = mkTemp('dry-out');
  makeBackup({ dataDir, configDir, outDir, passphrase: 'p1', maxPartBytes: PART });
  const targetData = mkTemp('dry-data');
  const targetConfig = mkTemp('dry-cfg');
  const res = restoreBackup({
    sourceDir: outDir, targetDataDir: targetData, targetConfigDir: targetConfig,
    passphrase: 'p1', dryRun: true, overwrite: true,
  });
  assert.equal(res.dryRun, true);
  assert.equal(res.files, 4); // 3 del dataDir + agent.md
  assert.ok(res.bytes > 1536 * 1024);
  assert.equal(fs.readdirSync(targetData).length, 0);
  assert.equal(fs.readdirSync(targetConfig).length, 0);
});

test('sin overwrite: existentes skip, nuevos se escriben', () => {
  const dataDir = mkTemp('ow-data');
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.alloc(64, 5));
  fs.mkdirSync(path.join(dataDir, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'storage', 'a.json'), 'A');
  const outDir = mkTemp('ow-out');
  makeBackup({ dataDir, configDir: mkTemp('ow-cfg'), outDir, maxPartBytes: PART });
  const tData = mkTemp('ow-td');
  fs.mkdirSync(path.join(tData, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(tData, 'storage', 'a.json'), 'VIEJO-EXISTENTE');
  const res = restoreBackup({
    sourceDir: outDir, targetDataDir: tData, targetConfigDir: mkTemp('ow-tc'),
    passphrase: null, overwrite: false,
  });
  assert.equal(res.files, 1);
  assert.equal(res.skipped, 1);
  assert.equal(fs.readFileSync(path.join(tData, 'storage', 'a.json'), 'utf8'), 'VIEJO-EXISTENTE');
  assert.equal(fs.statSync(path.join(tData, 'opencode.db')).size, 64);
});

test('buildTar/parseTar: inversos, con paths Windows normalizados y orden determinista', () => {
  const entries = [
    { name: 'data/b.txt', size: 3, read: () => Buffer.from('bbb') },
    { name: 'config\\a\\b.txt', size: 3, read: () => Buffer.from('aaa') },
  ];
  const tar1 = buildTar(entries);
  const tar2 = buildTar(entries);
  assert.ok(tar1.equals(tar2), 'salida determinista');
  assert.equal(tar1.length % 512, 0);
  const parsed = parseTar(tar1);
  assert.deepEqual(parsed.map((e) => e.name), ['config/a/b.txt', 'data/b.txt']);
  assert.equal(parsed[0].data.toString(), 'aaa');
  assert.equal(parsed[1].data.toString(), 'bbb');
});

test('parts faltantes / manifest ausente -> errores claros', () => {
  const sourceDir = mkTemp('missing-part');
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ parts: 3, encrypted: false, checksum: 'x' }));
  assert.throws(
    () => restoreBackup({ sourceDir, targetDataDir: mkTemp('p1'), targetConfigDir: mkTemp('p2') }),
    /parte|part/i
  );
  const empty = mkTemp('no-manifest');
  assert.throws(
    () => restoreBackup({ sourceDir: empty, targetDataDir: mkTemp('p3'), targetConfigDir: mkTemp('p4') }),
    (e) => e.message === t('es', 'err.no_backup', { dir: empty })
  );
});
