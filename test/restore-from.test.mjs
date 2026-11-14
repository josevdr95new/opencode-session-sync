// Requisito añadido: RESTAURAR UNA COPIA SELECCIONADA (from = stamp de listLocal).
// restore con from=X toma ESA copia (dos copias con contenido distinto); from inexistente
// -> not_found; traversal rechazado; dryRun con from también; compat con ruta absoluta;
// github.pull con stamp (match de commit) y RPC restore ya consume input.from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRestore, getStatus } from '../src/actions.mjs';
import { makeBackup } from '../src/backup.mjs';
import { create as realCreate } from '../src/providers/index.mjs';
import { main, parseArgs } from '../src/cli.mjs';
import plugin from '../src/index.mjs';
import { SessionSync } from '../src/rpc.ts';
import { t } from '../src/i18n.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-from-${n}-`));

function tempEnv({ cfg = {} } = {}) {
  const base = mkTemp('env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.from('actual'));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({
    provider: 'local', encrypt: false, parts: '80mb', ...cfg,
  }));
  return { base, dataDir, configDir, env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir } };
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

/** Dos copias con contenido DISTINTO en el localDir default (configDir/sync-backup). */
async function craftTwoCopies(te) {
  const localDir = path.join(te.configDir, 'sync-backup');
  const dbA = path.join(te.base, 'dataA');
  const dbB = path.join(te.base, 'dataB');
  fs.mkdirSync(dbA, { recursive: true });
  fs.mkdirSync(dbB, { recursive: true });
  fs.writeFileSync(path.join(dbA, 'opencode.db'), Buffer.from('contenido-A'));
  fs.writeFileSync(path.join(dbB, 'opencode.db'), Buffer.from('contenido-B'));
  await makeBackup({ dataDir: dbA, configDir: te.configDir, outDir: path.join(localDir, 'aaa-2026'), maxPartBytes: 256 * 1024 });
  await makeBackup({ dataDir: dbB, configDir: te.configDir, outDir: path.join(localDir, 'bbb-2026'), maxPartBytes: 256 * 1024 });
  return { localDir };
}

test('restore con from=<stamp>: restaura ESA copia (contenido B), no la más reciente', async () => {
  const te = tempEnv();
  await craftTwoCopies(te);
  await withEnv(te, async () => {
    // from = la copia MÁS VIEJA (aaa): si tomara la última restauraría B
    const res = await runRestore({ lang: 'es', from: 'aaa-2026', dryRun: false, overwrite: true, env: te.env });
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'contenido-A', 'restauró la copia from (A)');
    assert.ok(res.result.files >= 1);
    // y la otra copia también funciona
    const resB = await runRestore({ lang: 'es', from: 'bbb-2026', dryRun: false, overwrite: true, env: te.env });
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'contenido-B');
    assert.ok(resB.result.files >= 1);
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('dryRun con from: el PLAN refleja la copia elegida y no escribe nada', async () => {
  const te = tempEnv();
  await craftTwoCopies(te);
  await withEnv(te, async () => {
    const plan = await runRestore({ lang: 'es', from: 'aaa-2026', dryRun: true, env: te.env });
    assert.ok(plan.result.dryRun === true);
    assert.ok(plan.result.files >= 1);
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'actual', 'dryRun no escribe');
    // el plan debe apuntar al dir de la copia aaa: comprobamos el shape (result.plan)
    assert.ok(Array.isArray(plan.result.plan));
    assert.ok(plan.result.plan.every((p) => p.dest.startsWith(te.dataDir) || p.dest.startsWith(te.configDir)));
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('restore from inexistente -> error .notFound; traversal rechazado; sin from -> la más reciente (compat)', async () => {
  const te = tempEnv();
  await craftTwoCopies(te);
  await withEnv(te, async () => {
    await assert.rejects(
      runRestore({ lang: 'es', from: 'zzz', env: te.env }),
      (err) => err.notFound === true && err.resource === 'zzz'
        && err.message === t('es', 'del.not_found', { name: 'zzz', dir: path.join(te.configDir, 'sync-backup') }),
    );
    // traversal: '..' y subpaths fuera del dir de copias
    const fuga = path.join(te.base, 'fuga');
    fs.mkdirSync(fuga, { recursive: true });
    fs.writeFileSync(path.join(fuga, 'manifest.json'), '{}');
    await assert.rejects(runRestore({ lang: 'es', from: '../fuga', env: te.env }), (err) => err.notFound === true);
    await assert.rejects(runRestore({ lang: 'es', from: 'aaa-2026/../../fuga', env: te.env }), (err) => err.notFound === true);
    assert.ok(fs.existsSync(path.join(fuga, 'manifest.json')), 'fuga intacta');
    // sin from -> la más reciente (bbb): compat del flujo actual
    const res = await runRestore({ lang: 'es', dryRun: false, overwrite: true, env: te.env });
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'contenido-B');
    assert.ok(res.result.files >= 1);
    // COMPAT: ruta absoluta a un dir con manifest.json (uso documentado --from <dir>)
    const external = mkTemp('external');
    const dbC = path.join(te.base, 'dataC');
    fs.mkdirSync(dbC, { recursive: true });
    fs.writeFileSync(path.join(dbC, 'opencode.db'), Buffer.from('contenido-C'));
    await makeBackup({ dataDir: dbC, configDir: te.configDir, outDir: external, maxPartBytes: 256 * 1024 });
    const resC = await runRestore({ lang: 'es', from: external, dryRun: false, overwrite: true, env: te.env });
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'contenido-C', 'ruta absoluta compat');
    assert.ok(resC.result.files >= 1);
    fs.rmSync(external, { recursive: true, force: true });
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('github.pull con from=<stamp>: pull de ESE stamp; mismatch -> .notFound (createProvider falso)', async () => {
  const te = tempEnv({ cfg: { provider: 'github', owner: 'octo', repo: 'ses' } });
  const remoteDir = mkTemp('gh-remote');
  await makeBackup({ dataDir: te.dataDir, configDir: te.configDir, outDir: remoteDir, maxPartBytes: 256 * 1024 });
  const pulls = [];
  const gh = {
    name: 'github',
    pull: (args) => {
      pulls.push(args);
      if (args.stamp && args.stamp !== 'bbb-2026') {
        const e = new Error(t('es', 'err.no_backup', { dir: 'github.com/octo/ses' }));
        e.notFound = true;
        e.resource = args.stamp;
        throw e;
      }
      return remoteDir;
    },
  };
  const create = (n) => (n === 'github' ? gh : realCreate(n));
  const res = await runRestore({ lang: 'es', from: 'bbb-2026', dryRun: false, overwrite: true, env: te.env, createProvider: create });
  assert.deepEqual(pulls.at(-1), { owner: 'octo', repo: 'ses', token: undefined, stamp: 'bbb-2026', lang: 'es' });
  assert.ok(res.result.files >= 1);
  await assert.rejects(
    runRestore({ lang: 'es', from: 'aaa-2026', env: te.env, createProvider: create }),
    (err) => err.notFound === true && err.resource === 'aaa-2026',
    'stamp que no es el commit descargado -> not_found',
  );
  fs.rmSync(te.base, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
});

// Nota: el path real de mismatch en github.pull (git log -1 --format=%s vs
// 'opencode-sync <stamp>') requiere fetch real con https://github.com — queda fuera de
// los tests offline por diseño (cero red); su contrato (.notFound tipado) está cubierto
// arriba con createProvider falso y en gdrive con su propio fake fetch.

test('CLI: --from <stamp> en restore y restore --dry-run; parseArgs lo mantiene', async () => {
  assert.equal(parseArgs(['restore', '--from', 'aaa-2026']).flags.from, 'aaa-2026');
  assert.equal(parseArgs(['restore', '--from=bbb-2026', '--dry-run']).flags.from, 'bbb-2026');
  const te = tempEnv();
  await craftTwoCopies(te);
  await withEnv(te, async () => {
    const code = await main(['restore', '--from', 'aaa-2026', '--dry-run']);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'actual', 'dry-run CLI no escribe');
    const code2 = await main(['restore', '--from', 'zzz', '--dry-run']).then(
      () => { throw new Error('debía fallar'); },
      (err) => err,
    );
    assert.equal(code2.notFound, true, 'from inexistente -> main rechaza con notFound');
    // restore REAL via CLI con --overwrite
    const code3 = await main(['restore', '--from', 'aaa-2026', '--overwrite']);
    assert.equal(code3, 0);
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'contenido-A');
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('RPC restore ya consume input.from: handler pasa from y mapea not_found con {name}', async () => {
  const te = tempEnv();
  await craftTwoCopies(te);
  let registration = null;
  const ctx = {
    rpc: {
      register: async (_def, handlers) => {
        registration = { handlers, events: { emit: async () => {} } };
        return registration;
      },
    },
  };
  // el schema declara from desde antes (verificación)
  assert.ok('from' in SessionSync.methods.restore.input.properties, 'input.from declarado en rpc.ts');
  await withEnv(te, async () => {
    await plugin.setup(ctx);
    const fail = (type, message, data) => ({ type, message, data });
    const ok = await registration.handlers.restore({ from: 'aaa-2026', overwrite: true }, { error: fail });
    assert.ok(ok.message.includes('✓'));
    assert.equal(fs.readFileSync(path.join(te.dataDir, 'opencode.db'), 'utf8'), 'contenido-A', 'handler restauró el stamp pedido');
    const nf = await registration.handlers.restore({ from: 'zzz' }, { error: fail });
    assert.equal(nf.type, 'not_found');
    assert.equal(nf.data.name, 'zzz');
  });
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('status no cambia para provider local (info.cfg/localDir intactos)', () => {
  const te = tempEnv();
  const { lines, info } = getStatus({ lang: 'es', env: te.env });
  assert.equal(info.cfg.provider, 'local');
  assert.ok(lines.includes('Proveedor: local'));
});
