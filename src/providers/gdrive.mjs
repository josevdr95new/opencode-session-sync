// opencode-sync · proveedor GOOGLE DRIVE vía REST API (fetch global, cero deps)
// Igual que github.mjs en estilo: validate + push + pull (+ deleteRemote opcional).
// Credenciales OAuth {clientId, clientSecret, refreshToken} del usuario; el access
// token se refresca vía POST /token y se cachea EN MEMORIA mientras no expire.
// Uploads: resumable (POST init con metadata -> PUT binario a la Location header).
// Descargas: files.get?alt=media streaming a disco (Readable.fromWeb -> pipeline).
// El `fetch` es inyectable en TODAS las funciones (tests 100% offline, sin red).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_LANG, t } from '../i18n.mjs';
import { stampFor } from './local.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Carpeta raíz por defecto dentro de «Mi unidad» si el usuario no indica otra. */
export const DEFAULT_FOLDER_NAME = 'opencode-sync';

// ------------------------------------------------------------- access token

/** Cache en memoria: 'clientId::refreshToken' -> {token, expiresAt}. NUNCA en disco. */
const tokenCache = new Map();

/** Resetea la cache de tokens (tests). */
export function resetTokenCache() {
  tokenCache.clear();
}

function isBackupFile(name) {
  return name === 'manifest.json' || /^part\.\d{3}$/.test(name);
}

/** Escapa comillas/backslashes de un valor usado dentro de un q= de Drive. */
function escapeQuery(value) {
  return String(value).replace(/['\\]/g, '\\$&');
}

/**
 * gdriveAccessToken({clientId, clientSecret, refreshToken, lang, fetch}):
 * POST https://oauth2.googleapis.com/token (grant_type=refresh_token, form-urlencoded)
 * -> access_token. Cachea en memoria mientras no expire (margen 30s).
 * 400/401/403 -> err.gdrive_auth · red caída / otro HTTP -> err.gdrive_api.
 */
export async function gdriveAccessToken({ clientId, clientSecret, refreshToken, lang = DEFAULT_LANG, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!clientId || !clientSecret || !refreshToken) throw new Error(t(lang, 'err.gdrive_creds'));
  const cacheKey = `${clientId}::${refreshToken}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  let res;
  try {
    res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
  } catch (err) {
    throw new Error(t(lang, 'err.gdrive_api', { detail: String(err?.message || err) }));
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error(t(lang, 'err.gdrive_auth'));
  if (!res.ok) throw new Error(t(lang, 'err.gdrive_api', { detail: `HTTP ${res.status} (POST /token)` }));
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const token = body?.access_token;
  if (!token) throw new Error(t(lang, 'err.gdrive_auth'));
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 });
  return token;
}

/** fetch con Bearer + conversión de errores de red -> err.gdrive_api. */
async function driveFetch(doFetch, url, token, init, lang) {
  let res;
  try {
    res = await doFetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) } });
  } catch (err) {
    throw new Error(t(lang, 'err.gdrive_api', { detail: String(err?.message || err) }));
  }
  if (res.status === 401) throw new Error(t(lang, 'err.gdrive_auth'));
  return res;
}

async function expectOk(res, lang, detail) {
  if (!res.ok) throw new Error(t(lang, 'err.gdrive_api', { detail }));
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return body;
}

/** files.list con q= -> files[{id,name,createdTime}] (según fields). */
async function listFiles(doFetch, token, query, lang, signal, fields = 'files(id,name)') {
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&pageSize=100`;
  const res = await driveFetch(doFetch, url, token, { method: 'GET', signal }, lang);
  const body = await expectOk(res, lang, `HTTP ${res.status} (GET /files)`);
  return body?.files || [];
}

async function createFile(doFetch, token, metadata, lang, signal) {
  const res = await driveFetch(doFetch, `${DRIVE_API}/files`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(metadata),
    signal,
  }, lang);
  const body = await expectOk(res, lang, `HTTP ${res.status} (POST /files)`);
  return body?.id || null;
}

/** Busca una carpeta por nombre (y padre opcional); la CREA si no existe. -> id */
async function findOrCreateFolder(doFetch, token, name, lang, signal, parentId = null) {
  const clauses = [`name = '${escapeQuery(name)}'`, `mimeType = '${FOLDER_MIME}'`, 'trashed = false'];
  if (parentId) clauses.unshift(`'${parentId}' in parents`);
  const found = await listFiles(doFetch, token, clauses.join(' and '), lang, signal);
  if (found.length) return found[0].id;
  const metadata = { name, mimeType: FOLDER_MIME };
  if (parentId) metadata.parents = [parentId];
  return createFile(doFetch, token, metadata, lang, signal);
}

async function deleteFile(doFetch, token, fileId, lang, signal) {
  const res = await driveFetch(doFetch, `${DRIVE_API}/files/${encodeURIComponent(fileId)}`, token, {
    method: 'DELETE',
    signal,
  }, lang);
  // Drive devuelve 204 sin cuerpo en éxito.
  if (!res.ok && res.status !== 204) throw new Error(t(lang, 'err.gdrive_api', { detail: `HTTP ${res.status} (DELETE file)` }));
}

// ---------------------------------------------------------------- validate

/**
 * validateGDrive({clientId, clientSecret, refreshToken, folderName, lang, fetch, signal}):
 * 1) access token (POST /token) -> 4xx creds -> err.gdrive_auth
 * 2) GET /about?fields=user (401 -> err.gdrive_auth) -> user (displayName)
 * 3) busca la carpeta raíz por nombre y la CREA si falta (files.list / files.create)
 * -> { ok: true, user, folderId, folderName }. NUNCA incluye los secrets.
 */
export async function validateGDrive({ clientId, clientSecret, refreshToken, folderName, lang = DEFAULT_LANG, fetch: fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const token = await gdriveAccessToken({ clientId, clientSecret, refreshToken, lang, fetch: doFetch });
  const res = await driveFetch(doFetch, `${DRIVE_API}/about?fields=user`, token, { method: 'GET', signal }, lang);
  const about = await expectOk(res, lang, `HTTP ${res.status} (GET /about)`);
  const user = about?.user?.displayName || about?.user?.emailAddress || '';
  const name = folderName || DEFAULT_FOLDER_NAME;
  const folderId = await findOrCreateFolder(doFetch, token, name, lang, signal);
  if (!folderId) throw new Error(t(lang, 'err.gdrive_api', { detail: 'folder create returned no id' }));
  return { ok: true, user, folderId, folderName: name };
}

/** Máscara segura para UI: '1//0g…abcd' (prefijo 4 + últimos 4). Nunca el secreto completo. */
export function maskSecret(secret) {
  const s = String(secret || '');
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '…';
}

// ---------------------------------------------------------------- resumable upload

/**
 * Sube UN fichero con resumable upload:
 * 1) POST ?uploadType=resumable con metadata {name, parents:[folderId]} + X-Upload-Content-Length
 * 2) PUT binario a la cabecera Location (stream del disco con Readable.toWeb).
 */
async function uploadFileResumable(doFetch, token, folderId, filePath, name, lang, signal) {
  const size = fs.statSync(filePath).size;
  const res = await driveFetch(doFetch, `${UPLOAD_API}?uploadType=resumable`, token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({ name, parents: [folderId] }),
    signal,
  }, lang);
  const initBody = await expectOk(res, lang, `HTTP ${res.status} (POST upload init ${name})`);
  const location = res.headers?.get?.('location');
  if (!location) {
    void initBody;
    throw new Error(t(lang, 'err.gdrive_api', { detail: `missing upload Location header (${name})` }));
  }
  const put = await driveFetch(doFetch, location, token, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body: Readable.toWeb(fs.createReadStream(filePath)),
    duplex: 'half', // requerido por fetch cuando el body es un stream
    signal,
  }, lang);
  const out = await expectOk(put, lang, `HTTP ${put.status} (PUT upload ${name})`);
  return out?.id || null;
}

// ---------------------------------------------------------------- push

/**
 * push({dir, creds, folderId, stamp, lang, fetch, signal}): crea la subcarpeta
 * `<stamp>` dentro de folderId y sube manifest.json + part.NNN (resumable).
 * -> { ok: true, folderId: subId, folderWebUrl } (drive.google.com/drive/folders/<id>).
 */
export async function push({ dir, creds, folderId, stamp, lang = DEFAULT_LANG, fetch: fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!creds?.clientId || !creds?.clientSecret || !creds?.refreshToken) throw new Error(t(lang, 'err.gdrive_creds'));
  if (!folderId) throw new Error(t(lang, 'err.gdrive_api', { detail: 'missing folderId' }));
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error(t(lang, 'err.no_backup', { dir }));
  }
  const token = await gdriveAccessToken({ ...creds, lang, fetch: doFetch });
  const stampName = stamp || stampFor();
  const subId = await findOrCreateFolder(doFetch, token, stampName, lang, signal, folderId);
  if (!subId) throw new Error(t(lang, 'err.gdrive_api', { detail: 'folder create returned no id' }));
  const files = fs.readdirSync(dir).filter(isBackupFile).sort();
  for (const name of files) {
    if (signal?.aborted) throw new Error(t(lang, 'err.cancelled'));
    await uploadFileResumable(doFetch, token, subId, path.join(dir, name), name, lang, signal);
  }
  return { ok: true, folderId: subId, folderWebUrl: `https://drive.google.com/drive/folders/${subId}` };
}

// ---------------------------------------------------------------- pull

/**
 * pull({stamp|latest, creds, folderId, lang, fetch, signal}): localiza la subcarpeta
 * del stamp (o la más reciente por createdTime), descarga manifest.json + part.NNN
 * (files.get?alt=media streaming) a un tmp 'ocesync-gdrive-'.
 * -> { dir, cleanup(), stamp } — MISMO contrato que actions espera de los providers
 * async: actions borra el tmp vía cleanup() tras restaurar.
 * La copia no encontrada lanza error con .notFound (el RPC lo mapea a 'not_found').
 */
export async function pull({ stamp, creds, folderId, lang = DEFAULT_LANG, fetch: fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!creds?.clientId || !creds?.clientSecret || !creds?.refreshToken) throw new Error(t(lang, 'err.gdrive_creds'));
  if (!folderId) throw new Error(t(lang, 'err.gdrive_api', { detail: 'missing folderId' }));
  const token = await gdriveAccessToken({ ...creds, lang, fetch: doFetch });

  const notFound = (dir) => {
    const e = new Error(t(lang, 'err.no_backup', { dir }));
    e.notFound = true;
    e.resource = stamp || null;
    return e;
  };

  let subId = null;
  let stampName = stamp || null;
  if (stamp) {
    const found = await listFiles(
      doFetch, token,
      `'${folderId}' in parents and name = '${escapeQuery(stamp)}' and trashed = false`,
      lang, signal,
    );
    if (!found.length) throw notFound(`gdrive:/${folderId}/${stamp}`);
    subId = found[0].id;
  } else {
    // latest: carpetas hija, la más nueva por createdTime (orden también en cliente por si el API no ordena)
    const folders = await listFiles(
      doFetch, token,
      `'${folderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      lang, signal, 'files(id,name,createdTime)',
    );
    if (!folders.length) throw notFound(`gdrive:/${folderId}`);
    folders.sort((a, b) => (String(a.createdTime || '') < String(b.createdTime || '') ? 1 : -1));
    subId = folders[0].id;
    stampName = folders[0].name;
  }

  const children = await listFiles(doFetch, token, `'${subId}' in parents and trashed = false`, lang, signal);
  const wanted = children.filter((e) => isBackupFile(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (!wanted.some((e) => e.name === 'manifest.json')) throw notFound(`gdrive:/${stampName}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocesync-gdrive-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } };
  try {
    for (const entry of wanted) {
      if (signal?.aborted) throw new Error(t(lang, 'err.cancelled'));
      await downloadFile(doFetch, token, entry.id, path.join(tmp, entry.name), lang, signal);
    }
  } catch (err) {
    cleanup(); // no dejar tmp colgado si falla la descarga
    throw err;
  }
  return { dir: tmp, cleanup, stamp: stampName };
}

/** Descarga streaming de un file a disco (files.get?alt=media). */
async function downloadFile(doFetch, token, fileId, dest, lang, signal) {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await driveFetch(doFetch, url, token, { method: 'GET', signal }, lang);
  if (!res.ok) throw new Error(t(lang, 'err.gdrive_api', { detail: `HTTP ${res.status} (GET file ${fileId})` }));
  if (!res.body) throw new Error(t(lang, 'err.gdrive_api', { detail: `empty body (GET file ${fileId})` }));
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// ---------------------------------------------------------------- deleteRemote

/**
 * deleteRemote({stamp, creds, folderId, lang, fetch}): borra la subcarpeta del stamp.
 * Drive exige borrar file por file: lista los hijos, borra cada uno y luego la carpeta.
 * -> { ok: true, deleted } (ficheros + carpeta). 404 en el stamp -> error .notFound.
 */
export async function deleteRemote({ stamp, creds, folderId, lang = DEFAULT_LANG, fetch: fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!creds?.clientId || !creds?.clientSecret || !creds?.refreshToken) throw new Error(t(lang, 'err.gdrive_creds'));
  if (!folderId) throw new Error(t(lang, 'err.gdrive_api', { detail: 'missing folderId' }));
  const token = await gdriveAccessToken({ ...creds, lang, fetch: doFetch });
  const found = await listFiles(
    doFetch, token,
    `'${folderId}' in parents and name = '${escapeQuery(stamp)}' and trashed = false`,
    lang, signal,
  );
  if (!found.length) {
    const e = new Error(t(lang, 'err.no_backup', { dir: `gdrive:/${folderId}/${stamp}` }));
    e.notFound = true;
    e.resource = stamp;
    throw e;
  }
  const subId = found[0].id;
  const children = await listFiles(doFetch, token, `'${subId}' in parents and trashed = false`, lang, signal);
  let deleted = 0;
  for (const child of children) {
    await deleteFile(doFetch, token, child.id, lang, signal);
    deleted++;
  }
  await deleteFile(doFetch, token, subId, lang, signal);
  return { ok: true, deleted: deleted + 1 };
}

/** list offline: sin cache local de Drive -> [] (el status de gdrive no la usa). */
export function list() {
  return [];
}
