// opencode-sync · proveedor GITHUB vía git CLI (push/pull HTTPS con token en la URL)
// Cero dependencias. El token NUNCA se guarda en git config: se usa como URL
// efímera en push/fetch y se limpia el working dir temporal.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LANG, t } from '../i18n.mjs';
import { stampFor } from './local.mjs';

// ---------------------------------------------------------------- git helpers

function runGit(args, opts = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_EDITOR: 'true' };
  let res = spawnSync('git', args, { encoding: 'utf8', shell: false, ...opts, env });
  if ((res.error && res.error.code === 'ENOENT') || (res.status === null && !res.error)) {
    // Windows/shims: reintentar con shell ( scoop/instaladores .cmd )
    res = spawnSync('git', args, { encoding: 'utf8', shell: true, ...opts, env });
  }
  return res;
}

/** git CLI disponible? */
export function gitAvailable() {
  const r = runGit(['--version']);
  return r.status === 0;
}

function tokenUrl(owner, repo, token) {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

function sanitizeGitOutput(text, token) {
  return String(text || '').split(token).join('***');
}

function assertGit(lang) {
  if (!gitAvailable()) throw new Error(t(lang, 'err.git_missing'));
}

function commitMessage(date) {
  return `opencode-sync ${date ? stampFor(date) : stampFor()}`;
}

// ---------------------------------------------------------------- validate (API REST)

const GH_API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'opencode-session-sync',
    Accept: 'application/vnd.github+json',
  };
}

/**
 * validateCreds({owner, repo, token, lang, fetch}): valida credenciales contra
 * la API REST de GitHub usando fetch global (Node >= 18 / Bun). `fetch` es
 * inyectable para tests (sin red).
 * - GET /user           -> 401 => err.token_invalid; red falla => err.gh_api
 * - GET /repos/o/r      -> 404 => err.repo_not_found; permissions.push !== true => err.no_push
 * Devuelve { ok: true, login, repo }. NUNCA incluye el token en el resultado.
 */
export async function validateCreds({ owner, repo, token, lang = DEFAULT_LANG, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!token) throw new Error(t(lang, 'err.token_missing'));
  if (!owner || !repo) throw new Error(t(lang, 'err.creds_missing'));

  let res;
  try {
    res = await doFetch(`${GH_API}/user`, { headers: ghHeaders(token) });
  } catch (err) {
    throw new Error(t(lang, 'err.gh_api', { detail: String(err?.message || err) }));
  }
  if (res.status === 401) throw new Error(t(lang, 'err.token_invalid'));
  if (!res.ok) throw new Error(t(lang, 'err.gh_api', { detail: `HTTP ${res.status} (GET /user)` }));
  let user = null;
  try { user = await res.json(); } catch { user = null; }
  const login = user?.login;

  try {
    res = await doFetch(`${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: ghHeaders(token),
    });
  } catch (err) {
    throw new Error(t(lang, 'err.gh_api', { detail: String(err?.message || err) }));
  }
  if (res.status === 404) throw new Error(t(lang, 'err.repo_not_found', { repo: `${owner}/${repo}` }));
  if (!res.ok) throw new Error(t(lang, 'err.gh_api', { detail: `HTTP ${res.status} (GET /repos/${owner}/${repo})` }));
  let info = null;
  try { info = await res.json(); } catch { info = null; }
  if (info?.permissions?.push !== true) throw new Error(t(lang, 'err.no_push', { repo: `${owner}/${repo}` }));

  return { ok: true, login: login || owner, repo: info?.full_name || `${owner}/${repo}` };
}

/** Máscara segura para UI: 'ghp_…abcd' (prefijo 4 + últimos 4). Nunca el token completo. */
export function maskToken(token) {
  const s = String(token || '');
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '…';
}

// ---------------------------------------------------------------- push

/**
 * push({sourceDir, owner, repo, token, lang}): en un repo temporal, copia
 * parts+manifest, commit 'opencode-sync <stamp>' y push con token en la URL.
 * No deja credenciales en git config; el temp se borra en finally.
 */
export function push({ sourceDir, owner, repo, token, lang = DEFAULT_LANG, date }) {
  assertGit(lang);
  if (!token) throw new Error(t(lang, 'err.token_missing'));
  if (!owner || !repo) throw new Error(t(lang, 'err.creds_missing'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocesync-git-'));
  try {
    fs.copyFileSync(path.join(sourceDir, 'manifest.json'), path.join(tmp, 'manifest.json'));
    for (const f of fs.readdirSync(sourceDir).filter((n) => /^part\.\d{3}$/.test(n))) {
      fs.copyFileSync(path.join(sourceDir, f), path.join(tmp, f));
    }
    const cwd = { cwd: tmp };
    if (runGit(['init', '-b', 'main'], cwd).status !== 0) {
      if (runGit(['init'], cwd).status !== 0) throw new Error(t(lang, 'err.git_missing'));
      runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], cwd);
    }
    runGit(['config', 'user.email', 'opencode-sync@localhost'], cwd);
    runGit(['config', 'user.name', 'opencode-session-sync'], cwd);
    if (runGit(['add', '-A', '.'], cwd).status !== 0) throw new Error(t(lang, 'err.push_failed', { detail: 'add' }));
    const commit = runGit(['commit', '-m', commitMessage(date)], cwd);
    if (commit.status !== 0) {
      throw new Error(t(lang, 'err.push_failed', { detail: sanitizeGitOutput(commit.stderr, token) }));
    }
    const push = runGit(['push', tokenUrl(owner, repo, token), 'HEAD:refs/heads/main'], cwd);
    if (push.status !== 0) {
      const out = `${push.stderr || ''}${push.stdout || ''}`;
      if (/authentic|403|could not read username/i.test(out)) {
        throw new Error(t(lang, 'err.auth_failed'));
      }
      throw new Error(t(lang, 'err.push_failed', { detail: sanitizeGitOutput(out, token) }));
    }
    return { pushed: true, branch: 'main' };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------- pull

function repoCacheDir(owner, repo) {
  return path.join(os.tmpdir(), 'opencode-session-sync-cache', `${owner}--${repo}`);
}

/**
 * pull({owner, repo, token, stamp, lang}): cache en tmp; git init + fetch directo con
 * token en URL + reset --hard. El token no queda en git config.
 * Con `stamp`: verifica que el commit descargado ES esa copia (mensaje
 * 'opencode-sync <stamp>'); si no coincide -> error con .notFound (el RPC lo mapea a
 * 'not_found'). Limitación documentada: el fetch es shallow (--depth 1), solo puede
 * servir la copia MÁS RECIENTE del repo; stamps antiguos -> not_found.
 */
export function pull({ owner, repo, token, stamp, lang = DEFAULT_LANG }) {
  assertGit(lang);
  if (!token) throw new Error(t(lang, 'err.token_missing'));
  if (!owner || !repo) throw new Error(t(lang, 'err.creds_missing'));
  const cache = repoCacheDir(owner, repo);
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(path.join(cache, '.git'))) {
    if (runGit(['init'], cwd(cache)).status !== 0) throw new Error(t(lang, 'err.git_missing'));
  }
  const dir = { cwd: cache };
  const fetch = runGit(['fetch', '--force', '--depth', '1', tokenUrl(owner, repo, token), 'main'], dir);
  if (fetch.status !== 0) {
    const out = `${fetch.stderr || ''}${fetch.stdout || ''}`;
    if (/couldn't find remote ref|not found|empty repository/i.test(out)) {
      throw new Error(t(lang, 'err.no_backup', { dir: `github.com/${owner}/${repo}` }));
    }
    if (/authentic|403|could not read username|terminal prompts disabled/i.test(out)) {
      throw new Error(t(lang, 'err.auth_failed'));
    }
    throw new Error(t(lang, 'err.pull_failed', { detail: sanitizeGitOutput(out, token) }));
  }
  if (runGit(['reset', '--hard', 'FETCH_HEAD'], dir).status !== 0) {
    throw new Error(t(lang, 'err.pull_failed', { detail: 'reset' }));
  }
  if (stamp) {
    // pull de UNA copia concreta: el commit descargado debe ser ese stamp
    const subject = runGit(['log', '-1', '--format=%s'], dir);
    const want = `opencode-sync ${stamp}`; // mismo formato que commitMessage(stampFor())
    if (subject.status !== 0 || String(subject.stdout || '').trim() !== want) {
      const e = new Error(t(lang, 'err.no_backup', { dir: `github.com/${owner}/${repo} [${stamp}]` }));
      e.notFound = true;
      e.resource = stamp;
      throw e;
    }
  }
  return cache;
}

function cwd(dir) { return { cwd: dir }; }

/** list({owner}): solo imprime los stamps cacheados localmente (offline del fetch). */
export function list({ owner, repo }) {
  const cache = repoCacheDir(owner, repo);
  if (!fs.existsSync(path.join(cache, 'manifest.json'))) return [];
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(cache, 'manifest.json'), 'utf8')); } catch { /* */ }
  return [{ dir: cache, stamp: commitMessage(), manifest }];
}
