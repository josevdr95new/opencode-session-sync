// proveedor LOCAL: push/list/pull con stamp, todos sobre temp dirs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBackup } from '../../src/backup.mjs';
import { push, list, pull, stampFor } from '../../src/providers/local.mjs';
import { t } from '../../src/i18n.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-org-${n}-`));

async function makeFakeBackup(outDir, bytes = 4096) {
  const dataDir = mkTemp('o-data');
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(bytes));
  await makeBackup({ dataDir, configDir: mkTemp('o-cfg'), outDir, maxPartBytes: 80 * 1024 * 1024 });
  return outDir; // makeBackup devuelve un info {manifest, parts, ...}, no la ruta
}

test('push copia manifest.json + part.* a <targetDir>/<stamp>/', async () => {
  const outDir = mkTemp('push-src');
  await makeFakeBackup(outDir);
  const targetDir = mkTemp('push-target');
  const before = new Date();
  const dest = push({ sourceDir: outDir, targetDir, date: before });
  assert.ok(dest.startsWith(targetDir + path.sep));
  const stamp = dest.split(path.sep).pop();
  assert.equal(stamp, stampFor(before));
  assert.match(stamp, /^\d{8}T\d{6}Z$/);
  const copied = fs.readdirSync(dest);
  assert.ok(copied.includes('manifest.json'));
  assert.ok(copied.includes('part.000'));
  // push no borra el origen (puede ser reutilizado)
  assert.ok(fs.readdirSync(outDir).includes('manifest.json'));
});

test('list ordena más nuevo primero y lee manifest', async () => {
  const targetDir = mkTemp('list-target');
  const old = await makeFakeBackup(mkTemp('list-old'));
  push({ sourceDir: old, targetDir, date: new Date(Date.now() - 600000) });
  const neu = await makeFakeBackup(mkTemp('list-neu'));
  const dest = push({ sourceDir: neu, targetDir, date: new Date() });
  const all = list(targetDir);
  assert.equal(all.length, 2);
  assert.equal(all[0].dir, dest, 'el más nuevo primero');
  assert.ok(all[0].manifest && all[0].manifest.checksum);
});

test('pull devuelve el más reciente; error localizable si no hay nada', async () => {
  const empty = mkTemp('pull-empty');
  assert.throws(
    () => pull(empty),
    (e) => e.message === t('es', 'err.no_backup', { dir: empty })
  );
  const targetDir = mkTemp('pull-target');
  push({ sourceDir: await makeFakeBackup(mkTemp('p1')), targetDir, date: new Date(Date.now() - 1200000) });
  const newest = push({ sourceDir: await makeFakeBackup(mkTemp('p2')), targetDir, date: new Date() });
  assert.equal(pull(targetDir), newest);
});

test('push falla claramente si el sourceDir no contiene un respaldo', () => {
  const empty = mkTemp('not-a-backup');
  fs.writeFileSync(path.join(empty, 'algo.txt'), 'x');
  assert.throws(() => push({ sourceDir: empty, targetDir: mkTemp('t') }), /respaldo/i);
});
