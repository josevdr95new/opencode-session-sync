// F4: proveedor GOOGLE DRIVE — todo OFFLINE con fetch inyectado (fake, sin red).
// token refresh (ok/401/cache), validate (crea carpeta si falta), push resumable
// (2 fases: init + PUT con orden/tamaños), pull (descarga streaming + cleanup),
// deleteRemote (file por file), y acciones: runBackup gdrive (+fallback), runRestore
// gdrive (pull + cleanup), runSetup gdrive (secrets SOLO en sync-auth.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  gdriveAccessToken, validateGDrive, push, pull, deleteRemote, resetTokenCache, DEFAULT_FOLDER_NAME,
} from '../src/providers/gdrive.mjs';
import { runSetup, runBackup, runRestore, runDeleteLocal } from '../src/actions.mjs';
import { makeBackup } from '../src/backup.mjs';
import { create as realCreate } from '../src/providers/index.mjs';
import { t } from '../src/i18n.mjs';

const mkTemp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `oces-gd-${n}-`));

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const LIST_URL_PREFIX = 'https://www.googleapis.com/drive/v3/files?q=';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

// ---------------------------------------------------------------- fake fetch

const jsonRes = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
  body: undefined,
});

const binaryRes = (status, buffer) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => { throw new Error('sin json'); },
  body: Readable.toWeb(Readable.from([buffer])),
});

/** Lee el body de un init de fetch (Buffer | string | web stream). */
async function readBody(init = {}) {
  const b = init.body;
  if (b == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  if (typeof b.getReader === 'function') {
    const reader = b.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('body desconocido en el test');
}

/** routes: [{ match(url, init), throw?, res(url, init) }] — evalúa en orden. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, method: (init.method || 'GET').toUpperCase() });
    for (const r of routes) {
      if (r.match(String(url), init)) {
        if (r.throw) throw r.throw;
        return typeof r.res === 'function' ? r.res(String(url), init) : r.res;
      }
    }
    throw new Error(`url inesperada en el test: ${url}`);
  };
  return { fetchImpl, calls };
}

const route = (match, res, extra = {}) => ({ match, res: typeof res === 'function' ? res : () => res, ...extra });
const qOf = (url) => new URL(url).searchParams.get('q') || '';

// ---------------------------------------------------------------- token

test('gdriveAccessToken: ok con form-urlencoded correcto y CACHE en memoria (2ª llamada sin fetch)', async () => {
  resetTokenCache();
  const { fetchImpl, calls } = fakeFetch([
    route((u) => u === TOKEN_URL, jsonRes(200, { access_token: 'atok123', expires_in: 3600 })),
  ]);
  const creds = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rtok' };
  const token = await gdriveAccessToken({ ...creds, lang: 'es', fetch: fetchImpl });
  assert.equal(token, 'atok123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(calls[0].init.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('client_id'), 'cid');
  assert.equal(params.get('client_secret'), 'sec');
  assert.equal(params.get('refresh_token'), 'rtok');
  // cache: misma credencial -> cero llamadas extra
  const token2 = await gdriveAccessToken({ ...creds, lang: 'es', fetch: fetchImpl });
  assert.equal(token2, 'atok123');
  assert.equal(calls.length, 1);
  // credencial distinta -> nueva llamada
  await gdriveAccessToken({ ...creds, refreshToken: 'otro', lang: 'es', fetch: fetchImpl });
  assert.equal(calls.length, 2);
  resetTokenCache();
});

test('gdriveAccessToken: 400/401 -> err.gdrive_auth; red caída -> err.gdrive_api; sin creds -> err.gdrive_creds sin fetch', async () => {
  resetTokenCache();
  const bad = fakeFetch([route((u) => u === TOKEN_URL, jsonRes(400, { error: 'invalid_grant' }))]);
  await assert.rejects(
    gdriveAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', lang: 'es', fetch: bad.fetchImpl }),
    (e) => e.message === t('es', 'err.gdrive_auth'),
  );
  const unauth = fakeFetch([route((u) => u === TOKEN_URL, jsonRes(401, {}))]);
  await assert.rejects(
    gdriveAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', lang: 'en', fetch: unauth.fetchImpl }),
    (e) => e.message === t('en', 'err.gdrive_auth'),
  );
  const net = fakeFetch([route((u) => u === TOKEN_URL, null, { throw: new Error('ECONNREFUSED') })]);
  await assert.rejects(
    gdriveAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', lang: 'es', fetch: net.fetchImpl }),
    (e) => e.message === t('es', 'err.gdrive_api', { detail: 'ECONNREFUSED' }),
  );
  let called = false;
  await assert.rejects(
    gdriveAccessToken({ clientId: 'c', refreshToken: 'r', lang: 'es', fetch: async () => { called = true; return jsonRes(200, {}); } }),
    (e) => e.message === t('es', 'err.gdrive_creds'),
  );
  assert.equal(called, false);
  resetTokenCache();
});

// ---------------------------------------------------------------- validate

test('validateGDrive: ok con carpeta EXISTENTE (files.list, sin create) -> {ok, user, folderId}', async () => {
  resetTokenCache();
  const { fetchImpl, calls } = fakeFetch([
    route((u) => u === TOKEN_URL, jsonRes(200, { access_token: 'tk', expires_in: 3600 })),
    route((u) => u === ABOUT_URL, jsonRes(200, { user: { displayName: 'Ana', emailAddress: 'ana@x.com' } })),
    route((u) => u.startsWith(LIST_URL_PREFIX) && qOf(u).includes('MiBackups'), jsonRes(200, { files: [{ id: 'fold1', name: 'MiBackups' }] })),
  ]);
  const v = await validateGDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', folderName: 'MiBackups', lang: 'es', fetch: fetchImpl });
  assert.deepEqual(v, { ok: true, user: 'Ana', folderId: 'fold1', folderName: 'MiBackups' });
  const postCreate = calls.filter((c) => c.method === 'POST' && c.url === FILES_URL);
  assert.equal(postCreate.length, 0, 'la carpeta existía: sin create');
  const auth = calls[1].init.headers.Authorization;
  assert.equal(auth, 'Bearer tk');
  resetTokenCache();
});

test('validateGDrive: carpeta FALTANTE -> files.create con mimeType folder; sin folderName usa el default', async () => {
  resetTokenCache();
  let seenQ = null;
  const { fetchImpl, calls } = fakeFetch([
    route((u) => u === TOKEN_URL, jsonRes(200, { access_token: 'tk', expires_in: 3600 })),
    route((u) => u === ABOUT_URL, jsonRes(200, { user: { displayName: 'Beto' } })),
    route((u, init) => {
      if (!u.startsWith(LIST_URL_PREFIX) || init.method !== 'GET') return false;
      seenQ = qOf(u);
      return true;
    }, jsonRes(200, { files: [] })),
    route((u, init) => u === FILES_URL && init.method === 'POST',
      (u, init) => jsonRes(200, { id: `sub-${JSON.parse(init.body).name}` })),
  ]);
  const v = await validateGDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', lang: 'es', fetch: fetchImpl });
  assert.equal(v.folderId, `sub-${DEFAULT_FOLDER_NAME}`, 'id determinista de la carpeta creada');
  assert.equal(v.folderName, DEFAULT_FOLDER_NAME);
  assert.ok(seenQ.includes(`name = '${DEFAULT_FOLDER_NAME}'`), 'busca por el nombre default');
  assert.ok(seenQ.includes('trashed = false'));
  const createCall = calls.find((c) => c.method === 'POST' && c.url === FILES_URL);
  const meta = JSON.parse(createCall.init.body);
  assert.equal(meta.name, DEFAULT_FOLDER_NAME);
  assert.equal(meta.mimeType, 'application/vnd.google-apps.folder');
  assert.ok(!JSON.stringify(v).includes('sec'), 'resultado sin secrets');
  resetTokenCache();
});

test('validateGDrive: 401 en /about -> err.gdrive_auth; HTTP 500 -> err.gdrive_api', async () => {
  resetTokenCache();
  const unauth = fakeFetch([
    route((u) => u === TOKEN_URL, jsonRes(200, { access_token: 'tk', expires_in: 3600 })),
    route((u) => u === ABOUT_URL, jsonRes(401, {})),
  ]);
  await assert.rejects(
    validateGDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', lang: 'es', fetch: unauth.fetchImpl }),
    (e) => e.message === t('es', 'err.gdrive_auth'),
  );
  const srv = fakeFetch([
    route((u) => u === TOKEN_URL, jsonRes(200, { access_token: 'tk', expires_in: 3600 })),
    route((u) => u === ABOUT_URL, jsonRes(500, {})),
  ]);
  await assert.rejects(
    validateGDrive({ clientId: 'c', clientSecret: 's', refreshToken: 'r', lang: 'es', fetch: srv.fetchImpl }),
    (e) => e.message === t('es', 'err.gdrive_api', { detail: 'HTTP 500 (GET /about)' }),
  );
  resetTokenCache();
});

// ---------------------------------------------------------------- push resumable

function driveRoutes({ folders = {}, filesByFolder = {}, media = {}, listQLog } = {}) {
  // folders: { 'nombre': id } · filesByFolder: { folderId: [{id, name}] } · media: { fileId: Buffer }
  return [
    route((u) => u === TOKEN_URL, jsonRes(200, { access_token: 'tk', expires_in: 3600 })),
    route((u, init) => u.startsWith(LIST_URL_PREFIX) && init.method === 'GET', (u) => {
      const q = qOf(u);
      if (listQLog) listQLog.push(q);
      const parent = (q.match(/'([^']+)' in parents/) || [])[1] || null;
      const name = (q.match(/name = '([^']+)'/) || [])[1] || null;
      if (parent && name) {
        const hit = Object.prototype.hasOwnProperty.call(folders, name) ? folders[name] : null;
        return jsonRes(200, { files: hit ? [{ id: hit, name }] : [] });
      }
      if (parent && filesByFolder[parent]) return jsonRes(200, { files: filesByFolder[parent] });
      if (!parent && !name) {
        const all = Object.entries(folders).map(([n, id]) => ({ id, name: n, createdTime: '2026-01-01T00:00:00Z' }));
        return jsonRes(200, { files: all });
      }
      return jsonRes(200, { files: [] });
    }),
    route((u, init) => u === FILES_URL && init.method === 'POST',
      (u, init) => jsonRes(200, { id: `sub-${JSON.parse(init.body).name}` })),
    route((u, init) => u === UPLOAD_URL && init.method === 'POST', (u, init) => {
      const meta = JSON.parse(init.body);
      const id = `up-${meta.name}`;
      return jsonRes(200, { id }, { location: `https://upload.local/put/${id}` });
    }),
    route((u, init) => u.startsWith('https://upload.local/put/') && init.method === 'PUT',
      (u) => jsonRes(200, { id: u.split('/').pop() })),
    route((u) => /\/files\/[^/?]+\?alt=media$/.test(u), (u) => {
      const id = decodeURIComponent(u.match(/\/files\/([^/?]+)\?alt=media/)[1]);
      const buf = media[id];
      if (!buf) return jsonRes(404, {});
      return binaryRes(200, buf);
    }),
  ];
}

test('push resumable: 2 fases por fichero (init con metadata/length + PUT binario exacto), orden y folderWebUrl', async () => {
  resetTokenCache();
  const dir = mkTemp('src');
  const manifestBytes = Buffer.from(JSON.stringify({ parts: 2, size: 10 }));
  const partBytes = crypto.randomBytes(4096);
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(dir, 'part.000'), partBytes);
  fs.writeFileSync(path.join(dir, 'part.001'), partBytes);

  const { fetchImpl, calls } = fakeFetch(driveRoutes({ folders: { 'MiBackups': 'rootF' } }));
  const res = await push({
    dir, creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    folderId: 'rootF', stamp: '20260101T000000Z', lang: 'es', fetch: fetchImpl,
  });
  assert.deepEqual(res, { ok: true, folderId: 'sub-20260101T000000Z', folderWebUrl: 'https://drive.google.com/drive/folders/sub-20260101T000000Z' });

  // orden: token -> list(subcarpeta) -> create(subcarpeta) -> [init+PUT] x 3 en orden
  const methods = calls.map((c) => `${c.method} ${c.url.replace(/\?.*/, '')}${c.url.includes('uploadType') ? '?resumable' : ''}${c.url.includes('upload.local') ? c.url : ''}`);
  const inits = calls.filter((c) => c.method === 'POST' && c.url === UPLOAD_URL);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(inits.length, 3, 'un init por fichero (manifest + 2 parts)');
  assert.equal(puts.length, 3, 'un PUT por fichero');
  const names = inits.map((c) => JSON.parse(c.init.body).name);
  assert.deepEqual(names, ['manifest.json', 'part.000', 'part.001'], 'orden determinista');
  // metadata del init: parents=[subId] + X-Upload-Content-Length exacto
  assert.deepEqual(JSON.parse(inits[0].init.body), { name: 'manifest.json', parents: ['sub-20260101T000000Z'] });
  assert.equal(inits[0].init.headers['X-Upload-Content-Length'], String(manifestBytes.length));
  // PUT a la Location con EXACTAMENTE los bytes del fichero
  assert.equal(puts[0].url, `https://upload.local/put/up-manifest.json`);
  const putBody = await readBody(puts[0].init);
  assert.equal(putBody.length, manifestBytes.length);
  assert.ok(putBody.equals(manifestBytes), 'PUT body == manifest bytes');
  const putPart = await readBody(puts[1].init);
  assert.equal(putPart.length, 4096);
  assert.ok(putPart.equals(partBytes));
  assert.equal(inits[1].init.headers['X-Upload-Content-Length'], String(partBytes.length));
  resetTokenCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push: sin manifest.json -> err.no_backup; sin creds -> err.gdrive_creds (sin fetch)', async () => {
  resetTokenCache();
  const dir = mkTemp('src2');
  fs.writeFileSync(path.join(dir, 'part.000'), 'x');
  const { fetchImpl, calls } = fakeFetch(driveRoutes({ folders: { root: 'rf' } }));
  await assert.rejects(
    push({ dir, creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' }, folderId: 'rf', lang: 'es', fetch: fetchImpl }),
    (e) => e.message === t('es', 'err.no_backup', { dir }),
  );
  let called = false;
  await assert.rejects(
    push({ dir, creds: { clientId: 'c' }, folderId: 'rf', lang: 'es', fetch: async () => { called = true; return jsonRes(200, {}); } }),
    (e) => e.message === t('es', 'err.gdrive_creds'),
  );
  assert.equal(called, false);
  resetTokenCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pull

test('pull con stamp: descarga manifest+parts a tmp, bytes exactos y cleanup() borra el tmp', async () => {
  resetTokenCache();
  const manifestBytes = Buffer.from(JSON.stringify({ parts: 1, size: 5 }));
  const partBytes = crypto.randomBytes(2048);
  const { fetchImpl } = fakeFetch(driveRoutes({
    folders: { '20260101T000000Z': 'subA' },
    filesByFolder: { subA: [{ id: 'm1', name: 'manifest.json' }, { id: 'p1', name: 'part.000' }] },
    media: { m1: manifestBytes, p1: partBytes },
  }));
  const res = await pull({
    stamp: '20260101T000000Z', creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    folderId: 'rootF', lang: 'es', fetch: fetchImpl,
  });
  assert.equal(res.stamp, '20260101T000000Z');
  assert.ok(fs.readFileSync(path.join(res.dir, 'manifest.json')).equals(manifestBytes), 'manifest bytes exactos');
  assert.ok(fs.readFileSync(path.join(res.dir, 'part.000')).equals(partBytes), 'part bytes exactos');
  assert.equal(fs.readdirSync(res.dir).sort().length, 2);
  res.cleanup();
  assert.equal(fs.existsSync(res.dir), false, 'cleanup borra el tmp');
  resetTokenCache();
});

test('pull latest (sin stamp): elige la subcarpeta con createdTime MÁS RECIENTE', async () => {
  resetTokenCache();
  const routes = driveRoutes({ folders: {} });
  // sobreescribir la ruta de listado (latest: carpetas hija con createdTime)
  const { fetchImpl } = fakeFetch([
    routes[0],
    route((u, init) => u.startsWith(LIST_URL_PREFIX) && init.method === 'GET', (u) => {
      const q = qOf(u);
      if (q.includes('mimeType')) {
        return jsonRes(200, { files: [
          { id: 'old', name: '20260101T000000Z', createdTime: '2026-01-01T00:00:00Z' },
          { id: 'new', name: '20260105T000000Z', createdTime: '2026-01-05T00:00:00Z' },
        ] });
      }
      const parent = (q.match(/'([^']+)' in parents/) || [])[1] || null;
      if (parent === 'new') {
        return jsonRes(200, { files: [{ id: 'mn', name: 'manifest.json' }] });
      }
      return jsonRes(200, { files: [] });
    }),
    route((u) => /\/files\/mn\?alt=media$/.test(u), binaryRes(200, Buffer.from('latest-manifest'))),
  ]);
  const res = await pull({ creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' }, folderId: 'rootF', lang: 'es', fetch: fetchImpl });
  assert.equal(res.stamp, '20260105T000000Z', 'la más nueva por createdTime');
  assert.equal(fs.readFileSync(path.join(res.dir, 'manifest.json'), 'utf8'), 'latest-manifest');
  res.cleanup();
  resetTokenCache();
});

test('pull: stamp inexistente -> error .notFound (el RPC lo mapea a not_found)', async () => {
  resetTokenCache();
  const { fetchImpl } = fakeFetch(driveRoutes({ folders: { 'otro': 'subX' } }));
  await assert.rejects(
    pull({ stamp: 'noexiste', creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' }, folderId: 'rootF', lang: 'es', fetch: fetchImpl }),
    (e) => e.notFound === true && e.resource === 'noexiste',
  );
  resetTokenCache();
});

// ---------------------------------------------------------------- deleteRemote

test('deleteRemote: borra file por file y luego la carpeta (orden y total)', async () => {
  resetTokenCache();
  const deleted = [];
  const { fetchImpl, calls } = fakeFetch([
    route((u) => u === TOKEN_URL, jsonRes(200, { access_token: 'tk', expires_in: 3600 })),
    route((u, init) => u.startsWith(LIST_URL_PREFIX) && init.method === 'GET', (u) => {
      const q = qOf(u);
      const parent = (q.match(/'([^']+)' in parents/) || [])[1] || null;
      const name = (q.match(/name = '([^']+)'/) || [])[1] || null;
      if (name === '20260101T000000Z') return jsonRes(200, { files: [{ id: 'sub1', name }] });
      if (parent === 'sub1') return jsonRes(200, { files: [{ id: 'f1', name: 'manifest.json' }, { id: 'f2', name: 'part.000' }] });
      return jsonRes(200, { files: [] });
    }),
    route((u, init) => /\/files\/[^/?]+$/.test(u) && init.method === 'DELETE', (u) => {
      deleted.push(u.split('/files/')[1]);
      return jsonRes(204, null);
    }),
  ]);
  const res = await deleteRemote({ stamp: '20260101T000000Z', creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' }, folderId: 'rootF', lang: 'es', fetch: fetchImpl });
  assert.deepEqual(res, { ok: true, deleted: 3 });
  assert.deepEqual(deleted, ['f1', 'f2', 'sub1'], 'primero los ficheros, al final la carpeta');
  const nf = fakeFetch(driveRoutes({ folders: { 'otro': 'x' } }));
  await assert.rejects(
    deleteRemote({ stamp: 'noexiste', creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' }, folderId: 'rootF', lang: 'es', fetch: nf.fetchImpl }),
    (e) => e.notFound === true,
  );
  resetTokenCache();
});

// ---------------------------------------------------------------- acciones: runBackup

function tempEnv({ cfg = {}, auth = {} } = {}) {
  const base = mkTemp('env');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'opencode.db'), Buffer.alloc(256, 5));
  fs.writeFileSync(path.join(configDir, 'sync.json'), JSON.stringify({ encrypt: false, parts: '80mb', ...cfg }));
  if (Object.keys(auth).length) {
    fs.writeFileSync(path.join(configDir, 'sync-auth.json'), JSON.stringify(auth));
  }
  return { base, dataDir, configDir, env: { OPENCODE_DATA_DIR: dataDir, OPENCODE_CONFIG_DIR: configDir } };
}

test('runBackup gdrive: llama a push con {dir, creds, folderId, lang} y el message dice "subido a Google Drive"', async () => {
  const te = tempEnv({
    cfg: { provider: 'gdrive', folderId: 'rootF', user: 'Ana' },
    auth: { gdriveClientId: 'cid1', gdriveClientSecret: 'sec1', gdriveRefreshToken: 'rtok1' },
  });
  const pushes = [];
  const gd = {
    name: 'gdrive',
    push: async (args) => { pushes.push({ ...args, files: fs.readdirSync(args.dir) }); return { ok: true, folderWebUrl: 'https://drive.google.com/drive/folders/sub9' }; },
  };
  const res = await runBackup({ lang: 'es', env: te.env, createProvider: (n) => (n === 'gdrive' ? gd : realCreate(n)) });
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].creds, { clientId: 'cid1', clientSecret: 'sec1', refreshToken: 'rtok1' });
  assert.equal(pushes[0].folderId, 'rootF');
  assert.equal(pushes[0].lang, 'es');
  assert.ok(pushes[0].files.includes('manifest.json'));
  assert.ok(pushes[0].files.some((f) => /^part\.\d{3}$/.test(f)));
  assert.equal(res.info.pushedTo, 'gdrive');
  assert.equal(res.info.dest, 'https://drive.google.com/drive/folders/sub9');
  assert.ok(res.message.includes(t('es', 'back.pushed_gd')));
  assert.ok(res.message.includes('https://drive.google.com/drive/folders/sub9'));
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('runBackup gdrive: push falla -> fallback local (NO se pierde el backup) + aviso; cancel -> SIN fallback y tipado', async () => {
  const te = tempEnv({
    cfg: { provider: 'gdrive', folderId: 'rootF' },
    auth: { gdriveClientId: 'c', gdriveClientSecret: 's', gdriveRefreshToken: 'r' },
  });
  const gdFail = { name: 'gdrive', push: async () => { throw new Error('boom-detalle'); } };
  const res = await runBackup({ lang: 'es', env: te.env, createProvider: (n) => (n === 'gdrive' ? gdFail : realCreate(n)) });
  const localDir = path.join(te.configDir, 'sync-backup');
  const stamps = fs.readdirSync(localDir);
  assert.equal(stamps.length, 1, 'copia local guardada como fallback');
  assert.ok(fs.existsSync(path.join(localDir, stamps[0], 'manifest.json')));
  assert.equal(res.info.pushError, 'boom-detalle');
  assert.ok(res.message.includes(t('es', 'back.push_failed_warn', { detail: 'boom-detalle' })));

  // cancelación durante el push: el error .cancelled sube tipado y NO hay fallback
  const stampsBefore = fs.readdirSync(localDir).length;
  const cancelledErr = Object.assign(new Error(t('es', 'err.cancelled')), { cancelled: true });
  const gdCancel = { name: 'gdrive', push: async () => { throw cancelledErr; } };
  await assert.rejects(
    runBackup({ lang: 'es', env: te.env, createProvider: (n) => (n === 'gdrive' ? gdCancel : realCreate(n)) }),
    (err) => err.cancelled === true,
  );
  assert.equal(fs.readdirSync(localDir).length, stampsBefore, 'cancel: sin copia local extra');
  fs.rmSync(te.base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- acciones: runRestore

test('runRestore gdrive: pull (latest) antes de restaurar y cleanup() del tmp DESPUÉS; dryRun también pullea', async () => {
  const te = tempEnv({ cfg: { provider: 'gdrive', folderId: 'rootF' }, auth: { gdriveClientId: 'c', gdriveClientSecret: 's', gdriveRefreshToken: 'r' } });
  const remoteDir = mkTemp('remote');
  await makeBackup({ dataDir: te.dataDir, configDir: te.configDir, outDir: remoteDir, maxPartBytes: 256 * 1024 });
  const pulls = [];
  const cleanups = [];
  const gd = {
    name: 'gdrive',
    pull: async (args) => {
      pulls.push(args);
      const copy = mkTemp('pulled');
      for (const f of fs.readdirSync(remoteDir)) fs.copyFileSync(path.join(remoteDir, f), path.join(copy, f));
      return { dir: copy, cleanup: () => { cleanups.push(copy); fs.rmSync(copy, { recursive: true, force: true }); }, stamp: '20260101T000000Z' };
    },
  };
  const plan = await runRestore({ lang: 'es', dryRun: true, env: te.env, createProvider: (n) => (n === 'gdrive' ? gd : realCreate(n)) });
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].folderId, 'rootF');
  assert.equal(pulls[0].stamp, undefined, 'sin from: latest');
  assert.ok(plan.message.includes('dry-run'));
  assert.equal(cleanups.length, 1, 'cleanup del tmp tras el plan');

  const res = await runRestore({ lang: 'es', dryRun: false, overwrite: true, env: te.env, createProvider: (n) => (n === 'gdrive' ? gd : realCreate(n)) });
  assert.equal(pulls.length, 2);
  assert.equal(cleanups.length, 2, 'cleanup tras restore real');
  assert.ok(res.result.files >= 1);
  assert.ok(fs.existsSync(path.join(te.dataDir, 'opencode.db')));
  assert.ok(cleanups.every((c) => !fs.existsSync(c)), 'tmps de pull borrados');
  fs.rmSync(te.base, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
});

test('runRestore gdrive con from=<stamp>: pull de ESE stamp; inexistente -> error .notFound', async () => {
  const te = tempEnv({ cfg: { provider: 'gdrive', folderId: 'rootF' }, auth: { gdriveClientId: 'c', gdriveClientSecret: 's', gdriveRefreshToken: 'r' } });
  const remoteDir = mkTemp('remote2');
  await makeBackup({ dataDir: te.dataDir, configDir: te.configDir, outDir: remoteDir });
  const pulls = [];
  const gd = {
    name: 'gdrive',
    pull: async (args) => {
      pulls.push(args);
      if (args.stamp === 'viejo') {
        const e = new Error(t('es', 'err.no_backup', { dir: 'gdrive:/rootF/viejo' }));
        e.notFound = true;
        e.resource = 'viejo';
        throw e;
      }
      return { dir: remoteDir, cleanup: () => {}, stamp: args.stamp };
    },
  };
  const create = (n) => (n === 'gdrive' ? gd : realCreate(n));
  const res = await runRestore({ lang: 'es', from: '20260102T000000Z', dryRun: false, overwrite: true, env: te.env, createProvider: create });
  assert.deepEqual(pulls.at(-1).stamp, '20260102T000000Z', 'pull del stamp pedido');
  assert.ok(res.result.files >= 1);
  await assert.rejects(
    runRestore({ lang: 'es', from: 'viejo', env: te.env, createProvider: create }),
    (err) => err.notFound === true && err.resource === 'viejo',
    'stamp inexistente sube .notFound',
  );
  fs.rmSync(te.base, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- acciones: runSetup

test('runSetup gdrive: valida con validateGDrive inyectada, cfg SIN secrets y auth CON secrets', async () => {
  const te = tempEnv();
  let validated = null;
  const validateGDrive = async (args) => {
    validated = args;
    return { ok: true, user: 'Ana', folderId: 'fold9', folderName: 'MiBackups' };
  };
  const res = await runSetup({
    lang: 'es', provider: 'gdrive', env: te.env, validateGDrive,
    answers: { clientId: 'cid9', clientSecret: 'sec9', refreshToken: 'rtok9', folderName: 'MiBackups' },
  });
  assert.deepEqual(validated, { clientId: 'cid9', clientSecret: 'sec9', refreshToken: 'rtok9', folderName: 'MiBackups', lang: 'es' });
  assert.equal(res.user, 'Ana');
  assert.equal(res.folderId, 'fold9');
  assert.ok(res.message.includes('Ana') && res.message.includes('fold9'));
  const cfgOnDisk = JSON.parse(fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8'));
  assert.equal(cfgOnDisk.provider, 'gdrive');
  assert.equal(cfgOnDisk.folderId, 'fold9');
  assert.equal(cfgOnDisk.user, 'Ana');
  for (const k of ['clientId', 'clientSecret', 'refreshToken', 'gdriveClientId', 'gdriveClientSecret', 'gdriveRefreshToken']) {
    assert.ok(!(k in cfgOnDisk), `sync.json sin ${k}`);
  }
  const authOnDisk = JSON.parse(fs.readFileSync(path.join(te.configDir, 'sync-auth.json'), 'utf8'));
  assert.deepEqual(authOnDisk, { gdriveClientId: 'cid9', gdriveClientSecret: 'sec9', gdriveRefreshToken: 'rtok9' });
  // shapes públicos jamás exponen secrets
  assert.ok(!JSON.stringify({ lines: res.lines, cfg: res.cfg, user: res.user, folderId: res.folderId }).includes('sec9'));
  fs.rmSync(te.base, { recursive: true, force: true });
});

test('runSetup gdrive: validación falla -> lanza y NO persiste nada', async () => {
  const te = tempEnv();
  const before = fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8');
  const validateGDrive = async () => { throw new Error(t('es', 'err.gdrive_auth')); };
  await assert.rejects(
    runSetup({
      lang: 'es', provider: 'gdrive', env: te.env, validateGDrive,
      answers: { clientId: 'c', clientSecret: 's', refreshToken: 'r' },
    }),
    (e) => e.message === t('es', 'err.gdrive_auth'),
  );
  assert.equal(fs.readFileSync(path.join(te.configDir, 'sync.json'), 'utf8'), before, 'sync.json intacto');
  assert.ok(!fs.existsSync(path.join(te.configDir, 'sync-auth.json')), 'sin auth escrito');
  fs.rmSync(te.base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- runDeleteLocal + gdrive

test('runDeleteLocal con provider gdrive: borra local + remoto; solo remoto si no hay local; traversal SIEMPRE rechazado', async () => {
  const te = tempEnv({
    cfg: { provider: 'gdrive', folderId: 'rootF' },
    auth: { gdriveClientId: 'c', gdriveClientSecret: 's', gdriveRefreshToken: 'r' },
  });
  // localDir del cfg (default sync-backup) con una copia del stamp
  const localDir = path.join(te.configDir, 'sync-backup');
  fs.mkdirSync(path.join(localDir, 'aaa'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'aaa', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(localDir, 'aaa', 'part.000'), 'x');
  const deleted = [];
  const gd = {
    name: 'gdrive',
    deleteRemote: async (args) => {
      deleted.push(args);
      if (args.stamp === 'nadie') {
        const e = new Error('missing');
        e.notFound = true;
        e.resource = args.stamp;
        throw e;
      }
      return { ok: true, deleted: 2 };
    },
  };
  const create = (n) => (n === 'gdrive' ? gd : realCreate(n));

  // 1) local + remoto
  const res1 = await runDeleteLocal({ name: 'aaa', lang: 'es', env: te.env, createProvider: create });
  assert.ok(!fs.existsSync(path.join(localDir, 'aaa')), 'copia local borrada');
  assert.deepEqual(deleted.at(-1), { stamp: 'aaa', creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r' }, folderId: 'rootF', lang: 'es' });
  assert.ok(res1.message.includes(t('es', 'del.deleted', { name: 'aaa' })));
  assert.ok(res1.message.includes(t('es', 'del.remote_done')));

  // 2) SOLO remoto (no existe local)
  const res2 = await runDeleteLocal({ name: 'solo-remoto', lang: 'es', env: te.env, createProvider: create });
  assert.ok(res2.message.includes(t('es', 'del.deleted_remote_only', { name: 'solo-remoto' })));

  // 3) ni local ni remota -> not_found tipado
  await assert.rejects(
    runDeleteLocal({ name: 'nadie', lang: 'es', env: te.env, createProvider: create }),
    (err) => err.notFound === true && err.resource === 'nadie',
  );

  // 4) traversal SIEMPRE rechazado (aunque el provider sea gdrive)
  await assert.rejects(
    runDeleteLocal({ name: '../fuga', lang: 'es', env: te.env, createProvider: create }),
    (err) => err.notFound === true,
  );
  assert.equal(deleted.filter((d) => d.stamp === '../fuga').length, 0, 'traversal no llega al proveedor');
  fs.rmSync(te.base, { recursive: true, force: true });
});
