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
 * pull({owner, repo, token, lang}): cache en tmp; git init + fetch directo con
 * token en URL + reset --hard. El token no queda en git config.
 */
export function pull({ owner, repo, token, lang = DEFAULT_LANG }) {
  assertGit(lang);
  if (!token) throw new Error(t(lang, 'err.token_missing'));
  if (!owner || !repo) throw new Error(t(lang, 'err.creds_missing'));
  const cache = repoCacheDir(owner, repo);
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(path.join(cache, '.git'))) {
    if (runGit(['init'], cwd(cache)).status !== 0) throw new Error(t(lang, 'err.git_missing'));
  }
  const cwd = { cwd: cache };
  const fetch = runGit(['fetch', '--force', '--depth', '1', tokenUrl(owner, repo, token), 'main'], cwd);
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
  if (runGit(['reset', '--hard', 'FETCH_HEAD'], cwd).status !== 0) {
    throw new Error(t(lang, 'err.pull_failed', { detail: 'reset' }));
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
