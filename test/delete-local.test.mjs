// F2: runDeleteLocal — borra SOLO la copia pedida (validación anti-traversal),
// RPC deleteLocal (ok/not_found), CLI delete <name> --yes y help. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeleteLocal } from '../src/actions.mjs';
import { main, parseArgs } from '../src/cli.mjs';
import plugin from '../src/index.mjs';
import { t } from '../src/i18n.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-del-${n}-`));

function craftCopy(localDir, stamp, content) {
  const dir = path.join(localDir, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    date: '2026-01-01T00:00:00Z', machine: 'test', counts: { files: 1, bytes: content.length },
    parts: 1, size: content.length, encrypted: false, checksum: 'x',
  }));
  fs.writeFileSync(path.join(dir, 'part.000'), content);
  return dir;
}

function tempEnv({ cfg = {} } = {}) {
  const base = mkTemp('env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  const localDir = path.join(base, 'copias');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.from('db'));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({
    provider: 'local', encrypt: false, localDir, parts: '80mb', ...cfg,
  }));
  return { base, dataDir, configDir, localDir, env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir } };
}

function withEnv(te, fn) {
  const prevCfg = process.env.OPENCODE_CONFIG_DIR;
  const prevData = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_CONFIG_DIR = te.configDir;
  process.env.OPENCODE_DATA_DIR = te.dataDir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = prevCfg;
      if (prevData === undefined) delete process.env.OPENCODE_DATA_DIR; else process.env.OPENCODE_DATA_DIR = prevData;
    });
}

test('runDeleteLocal: borra la copia pedida y NO toca las otras', async () => {
  const te = tempEnv();
  craftCopy(te.localDir, '20260101T000000Z', 'uno');
  craftCopy(te.localDir, '20260102T000000Z', 'dos');
  craftCopy(te.localDir, '20260103T000000Z', 'tres');
  const res = await runDeleteLocal({ name: '20260102T000000Z', lang: 'es', env: te.env });
  assert.equal(res.message, t('es', 'del.deleted', { name: '20260102T000000Z' }));
  assert.ok(!fs.existsSync(path.join(te.localDir, '20260102T000000Z')), 'la copia borrada desapareció');
  for (const stamp of ['20260101T000000Z', '20260103T000000Z']) {
    assert.ok(fs.existsSync(path.join(te.localDir, stamp, 'manifest.json')), `${stamp} intacto`);
    assert.ok(fs.existsSync(path.join(te.localDir, stamp, 'part.000')), `${stamp} part intacta`);
  }
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('runDeleteLocal: traversal rechazado (no toca nada fuera del dir de copias)', async () => {
  const te = tempEnv();
  craftCopy(te.localDir, 's1', 'uno');
  const fuga = path.join(te.base, 'fuga');
  fs.mkdirSync(fuga, { recursive: true });
  fs.writeFileSync(path.join(fuga, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(fuga, 'part.000'), 'secreto');
  for (const evil of ['../fuga', '..\\fuga', 's1/../../fuga', '..']) {
    await assert.rejects(
      runDeleteLocal({ name: evil, lang: 'es', env: te.env }),
      (err) => err.notFound === true && err.resource === evil,
      `traversal rechazado: ${evil}`,
    );
  }
  assert.ok(fs.existsSync(path.join(fuga, 'part.000')), 'el dir fuera de localDir quedó intacto');
  assert.ok(fs.existsSync(path.join(te.localDir, 's1', 'manifest.json')), 'copia local intacta');
  // ruta ABSOLUTA fuera del dir de copias también rechazada
  await assert.rejects(
    runDeleteLocal({ name: fuga, lang: 'es', env: te.env }),
    (err) => err.notFound === true,
  );
  assert.ok(fs.existsSync(path.join(fuga, 'manifest.json')));
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('runDeleteLocal: copia inexistente -> error not_found', async () => {
  const te = tempEnv();
  craftCopy(te.localDir, 's1', 'uno');
  await assert.rejects(
    runDeleteLocal({ name: 'noexiste', lang: 'es', env: te.env }),
    (err) => {
      assert.equal(err.notFound, true);
      assert.equal(err.message, t('es', 'del.not_found', { name: 'noexiste', dir: te.localDir }));
      assert.equal(t('en', 'del.not_found', { name: 'noexiste', dir: te.localDir }).includes('noexiste'), true);
      return true;
    },
  );
  assert.ok(fs.existsSync(path.join(te.localDir, 's1', 'manifest.json')), 'las demás copias intactas');
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('RPC deleteLocal: ok devuelve {message}; inexistente -> error not_found con {name}', async () => {
  const te = tempEnv();
  craftCopy(te.localDir, 's1', 'uno');
  craftCopy(te.localDir, 's2', 'dos');
  let registration = null;
  const ctx = {
    rpc: {
      register: async (_def, handlers) => {
        registration = { handlers, events: { emit: async () => {} } };
        return registration;
      },
    },
  };
  await withEnv(te, async () => {
    await plugin.setup(ctx);
    const fail = (type, message, data) => ({ type, message, data });
    const ok = await registration.handlers.deleteLocal({ name: 's1' }, { error: fail });
    assert.deepEqual(Object.keys(ok), ['message']);
    assert.equal(ok.message, t('es', 'del.deleted', { name: 's1' }));
    const nf = await registration.handlers.deleteLocal({ name: 'zzz' }, { error: fail });
    assert.equal(nf.type, 'not_found');
    assert.equal(nf.data.name, 'zzz', 'not_found viaja con {name}');
    assert.equal(fs.existsSync(path.join(te.localDir, 's2', 'manifest.json')), true, 's2 intacto');
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('CLI: parseArgs acepta delete/rm y --yes; delete --help imprime ayuda y sale 0', async () => {
  const p = parseArgs(['delete', '20260101T000000Z', '--yes']);
  assert.equal(p.cmd, 'delete');
  assert.equal(p.pos[1], '20260101T000000Z');
  assert.equal(p.flags.yes, true);
  assert.equal(parseArgs(['rm', 'x']).cmd, 'rm');
  const te = tempEnv();
  await withEnv(te, async () => {
    const code = await main(['delete', '--help']);
    assert.equal(code, 0);
    const code2 = await main(['delete']);
    assert.equal(code2, 1, 'delete sin name -> ayuda y código 1');
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('CLI e2e offline: delete <stamp> --yes borra ESA copia', async () => {
  const te = tempEnv();
  craftCopy(te.localDir, 'aaa', 'uno');
  craftCopy(te.localDir, 'bbb', 'dos');
  await withEnv(te, async () => {
    const code = await main(['delete', 'aaa', '--yes']);
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(path.join(te.localDir, 'aaa')), 'aaa borrada');
    assert.ok(fs.existsSync(path.join(te.localDir, 'bbb', 'manifest.json')), 'bbb intacta');
    // sin --yes y sin TTY: confirmación requerida, NO borra
    const code2 = await main(['delete', 'bbb']);
    assert.equal(code2, 1);
    assert.ok(fs.existsSync(path.join(te.localDir, 'bbb', 'manifest.json')), 'bbb sigue intacta');
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});
