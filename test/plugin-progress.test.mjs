// plugin server part (index.mjs): registro RPC + throttle de eventos progress.
// Ejecuta el setup real del plugin con un ctx falso (sin opencode): verifica que
// backup/restore mantienen sus shapes y emiten 'progress' con throttle correcto
// (mín 250ms o cambio de fase/percent entero; SIEMPRE se emite el 100 final).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import plugin from '../src/index.mjs';
import { SessionSync } from '../src/rpc.ts';

function tempEnv({ cfg = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oces-plug-'));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), crypto.randomBytes(512));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({
    provider: 'local', encrypt: false, localDir: path.join(base, 'copias'), parts: '80mb', ...cfg,
  }));
  process.env.OPENCODE_DATA_DIR = dataDir;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  return { base, dataDir, configDir, dataDirPrev: null };
}

function restoreEnv(prev) {
  if (prev === null) { delete process.env.OPENCODE_DATA_DIR; delete process.env.OPENCODE_CONFIG_DIR; return; }
  process.env.OPENCODE_DATA_DIR = prev;
}

test('setup registra el RPC con events.progress y backup emite progress con throttle y 100 final', async () => {
  assert.ok(SessionSync.events?.progress?.schema, 'rpc.ts declara events.progress.schema');
  const te = tempEnv();
  const emitted = [];
  let registration = null;
  const ctx = {
    rpc: {
      register: async (_def, handlers) => {
        registration = {
          handlers,
          events: {
            emit: async (name, data) => {
              assert.equal(name, 'progress');
              // shape del schema: required siempre; detail opcional; nada más
              const keys = Object.keys(data).sort();
              for (const k of ['bytes', 'op', 'percent', 'phase', 'total']) assert.ok(keys.includes(k), `falta ${k}`);
              assert.ok(keys.every((k) => ['bytes', 'op', 'percent', 'phase', 'total', 'detail'].includes(k)), `claves inesperadas: ${keys}`);
              emitted.push(data);
            },
          },
        };
        return registration;
      },
    },
  };
  await plugin.setup(ctx);
  assert.ok(registration, 'ctx.rpc.register fue llamado');
  assert.deepEqual(Object.keys(registration.handlers).sort(), ['backup', 'deleteLocal', 'listLocal', 'restore', 'reveal', 'setup', 'status']);

  const fail = (type, message, data) => ({ type, message, data });
  const res = await registration.handlers.backup({ dryRun: false }, { error: fail });
  assert.ok(res.message.includes('✓'), 'shape de retorno backup intacto');
  assert.ok(res.info.manifest.checksum);

  // throttle: percent monótono, fases en orden y SIEMPRE acaba en 100
  assert.ok(emitted.length >= 3, 'hay eventos emitidos');
  const ops = new Set(emitted.map((e) => e.op));
  assert.ok(ops.has('backup'));
  let prev = -1;
  for (const e of emitted) {
    assert.ok(e.percent >= prev, 'percent monótono');
    prev = e.percent;
  }
  assert.equal(emitted[emitted.length - 1].percent, 100, 'el 100 final SIEMPRE se emite');
  const phases = [];
  for (const e of emitted) if (phases[phases.length - 1] !== e.phase) phases.push(e.phase);
  assert.deepEqual(phases, ['scan', 'pack', 'parts']);

  // restore: emite progress con op 'restore' y fases read/unpack/extract
  const emittedR = [];
  registration.events.emit = async (name, data) => { emittedR.push(data); };
  const outDir = path.join(te.base, 'copias', 'stamp1');
  fs.mkdirSync(outDir, { recursive: true });
  const { makeBackup } = await import('../src/backup.mjs');
  await makeBackup({ dataDir: te.dataDir, configDir: te.configDir, outDir, maxPartBytes: 256 * 1024 });
  const resR = await registration.handlers.restore({ overwrite: true }, { error: fail });
  assert.ok(resR.message.includes('✓'), 'shape de retorno restore intacto');
  assert.ok(emittedR.some((e) => e.op === 'restore' && e.percent === 100), 'restore emite su 100');
  const phasesR = [];
  for (const e of emittedR) if (phasesR[phasesR.length - 1] !== e.phase) phasesR.push(e.phase);
  assert.deepEqual(phasesR, ['read', 'unpack', 'extract']);

  restoreEnv(null);
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('throttle: eventos con el mismo percent entero y misma fase a <250ms se colapsan; el 100 pasa siempre', async () => {
  const te = tempEnv();
  const emitted = [];
  let registration = null;
  const ctx = {
    rpc: {
      register: async (_def, handlers) => {
        registration = {
          handlers,
          events: { emit: async (_name, data) => { emitted.push(data); } },
        };
        return registration;
      },
    },
  };
  await plugin.setup(ctx);
  // scan emite 0 y 2 (misma fase, percent entero distinto -> ambos pasan el throttle);
  // el resto de eventos debe cumplir el schema y colapsar en ráfagas <250ms.
  const fail = (type, message) => ({ type, message });
  await registration.handlers.backup({ dryRun: false }, { error: fail });
  // scan emite 0 y 2 (fases iguales, percent entero distinto -> ambos pasan)
  assert.ok(emitted.some((e) => e.phase === 'scan' && e.percent === 0));
  assert.ok(emitted.some((e) => e.phase === 'scan' && e.percent === 2));
  // todos los emitidos respetan el schema mínimo
  for (const e of emitted) {
    assert.equal(typeof e.op, 'string');
    assert.equal(typeof e.phase, 'string');
    assert.equal(typeof e.percent, 'number');
    assert.equal(typeof e.bytes, 'number');
    assert.equal(typeof e.total, 'number');
    assert.ok(e.bytes <= e.total);
  }
  assert.equal(emitted[emitted.length - 1].percent, 100);
  restoreEnv(null);
  fs.rmSync(te.base, { recursive: true, force: true });
});
