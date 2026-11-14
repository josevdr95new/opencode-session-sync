#!/usr/bin/env node
// opencode-session-sync · CLI independiente (setup | backup | restore | delete | status | menu)
// Cero dependencias. Códigos de salida: 0 éxito, 1 error, 130 cancelado (SIGINT/Ctrl+C).
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import readline from 'node:readline/promises';
import { runBackup, runRestore, runDeleteLocal, getStatus, runSetup, PROVIDER_NAMES, humanBytes } from './actions.mjs';
import { authFilePath } from './config.mjs';
import { detectLanguage, t } from './i18n.mjs';

const VALUE_FLAGS = new Set(['--lang', '--provider', '--output', '--from', '--parts', '--owner', '--repo', '--token', '--github', '--client-id', '--client-secret', '--refresh-token']);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let [key, ...rest] = a.replace(/^--/, '').split('=');
      if (rest.length) {
        flags[key] = rest.join('=');
      } else if (VALUE_FLAGS.has(a)) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  const cmd = pos[0] === 'm' ? 'menu' : (pos[0] || 'help');
  return { flags, pos, cmd };
}

function print(msg, stream = process.stdout) {
  stream.write(msg.endsWith('\n') ? msg : `${msg}\n`);
}

function usage(lang) {
  print(t(lang, 'cli.usage'));
  print('');
  print(t(lang, 'cli.help_line'));
}

// ------------------------------------------------------------------ menu

function menuText(lang) {
  const opts = [1, 2, 3, 4, 5].map((n) => `  ${n}) ${t(lang, `cli.menu.option${n}`)}`);
  return [
    t(lang, 'cli.menu.title'),
    '',
    ...opts,
    `  q) ${t(lang, 'cli.menu.goodbye')}`,
  ].join('\n');
}

async function menuRestore(lang, flags, rl) {
  // Seguro por defecto: primero el plan (dry-run implícito), luego pregunta.
  await runRestoreCmd(lang, flags, false, true);
  const answer = (await rl.question(t(lang, 'cli.menu.restore_confirm'))).trim();
  if (/^(s|si|sí|y|yes)$/i.test(answer)) {
    await runRestoreCmd(lang, flags, true, undefined); // segunda llamada: sobreescribir
  } else {
    print(t(lang, 'cli.menu.restore_cancelled'));
  }
}

async function menuInteractive(lang, flags, langDefault) {
  const openReadline = () => readline.createInterface({ input: process.stdin, output: process.stdout });
  let rl = openReadline();
  try {
    for (;;) {
      print(menuText(lang));
      const raw = (await rl.question(t(lang, 'cli.menu.prompt'))).trim();
      const choice = raw.toLowerCase();
      if (!choice) continue; // Enter vacío: reimprimir menú
      if (choice === 'q' || choice === 'salir' || choice === 'exit' || choice === '0') return 0;
      const n = Number.parseInt(choice, 10);
      try {
        if (n === 1) {
          await runStatusCmd(lang);
        } else if (n === 2) {
          await runBackupCmd(lang, flags);
        } else if (n === 3) {
          await menuRestore(lang, flags, rl);
        } else if (n === 4) {
          // setup ya es interactivo: cerramos el readline del menú mientras corre
          rl.close();
          try {
            await runSetupCmd({ flags, lang, langDefault });
          } finally {
            rl = openReadline();
          }
        } else if (n === 5) {
          usage(lang);
        } else {
          throw new Error(t(lang, 'cli.menu.unknown_option', { option: raw }));
        }
      } catch (err) {
        print(`✗ ${err && err.message ? err.message : String(err)}`, process.stderr);
      }
    }
  } finally {
    rl.close();
  }
}

// ------------------------------------------------------------------ cancelación (SIGINT)

/** AbortController cableado a SIGINT (Ctrl+C): Ctrl+C cancela LIMPIO — el motor
 *  borra los outputs parciales, lanza err.cancelled ('Operación cancelada') y la
 *  CLI sale con código 130. dispose() desregistra el listener (commands reusables). */
function sigintSignal() {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  return { signal: controller.signal, dispose: () => process.off('SIGINT', onSigint) };
}

// ------------------------------------------------------------------ comando helpers

/** '--github owner/repo' -> {owner, repo}; devuelve null si el flag no viene. */
function parseGithubFlag(value) {
  if (!value || value === true) return null;
  const [owner, repo = ''] = String(value).split('/');
  if (!owner) return null;
  return { owner: owner.trim(), repo: repo.trim() || undefined };
}

async function runSetupCmd({ flags, lang, langDefault }) {
  if (flags.help || flags.h) {
    print(t(lang, 'cli.setup.help'));
    return 0;
  }
  const interactive = await interactiveSetup({ flags, lang });
  const plan = interactive
    ? { ...interactive, wideAnswers: { ...interactive.wideAnswers, parts: flags.parts, encrypt: flags['no-encrypt'] ? false : undefined } }
    : nonInteractiveSetup(flags, process.env, langDefault);
  const gh = parseGithubFlag(flags.github); // setup --github owner/repo
  if (gh) {
    plan.provider = 'github';
    plan.wideAnswers.owner = plan.wideAnswers.owner || gh.owner;
    plan.wideAnswers.repo = plan.wideAnswers.repo || gh.repo;
  }
  if (flags.gdrive) {
    // setup --gdrive (+ --client-id/--client-secret/--refresh-token o preguntas interactivas;
    // el refresh token también llega por env OPENCODE_GDRIVE_REFRESH — lo mezcla nonInteractive)
    plan.provider = 'gdrive';
    plan.wideAnswers.clientId = plan.wideAnswers.clientId || flags['client-id'];
    plan.wideAnswers.clientSecret = plan.wideAnswers.clientSecret || flags['client-secret'];
    plan.wideAnswers.refreshToken = plan.wideAnswers.refreshToken || flags['refresh-token'];
    plan.wideAnswers.folderName = plan.wideAnswers.folderName || flags['folder-name'];
  }
  const { lines, cfg } = await runSetup({
    lang: plan.langOverride || plan.lang,
    provider: plan.provider,
    parts: plan.wideAnswers.parts,
    encrypt: plan.wideAnswers.encrypt,
    answers: plan.wideAnswers,
    env: process.env,
  });
  print(lines);
  if (plan.provider === 'github' && (process.stdin.isTTY) && (!cfg.owner || !cfg.repo)) {
    print(t(plan.langOverride || plan.lang, 'cli.setup.github_hint', { path: authFilePath() }));
  }
  return 0;
}

// ------------------------------------------------------------------ progreso (TTY)

/** Barra ASCII de ~24 caracteres: [███████░░░░]. */
function progressBar(percent, width = 24) {
  const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** onProgress para CLI: pinta UNA línea con \r (solo si stdout es TTY).
 *  `[backup] [████░░░] 42% · comprimiendo (112 MB / 267 MB)`; al 100 imprime la
 *  línea completa + \n. En non-TTY devuelve undefined (pipes/tests sin ruido). */
function progressPainter(op, lang) {
  if (!process.stdout.isTTY) return undefined;
  let lastLine = '';
  return (p) => {
    if (!p) return;
    const label = t(lang, `prog.${p.phase}`);
    const sizes = p.phase !== 'scan' && Number(p.total) > 0
      ? ` (${humanBytes(p.bytes)} / ${humanBytes(p.total)})`
      : (p.detail ? ` (${p.detail})` : '');
    const line = `[${op}] [${progressBar(p.percent)}] ${Math.floor(Number(p.percent) || 0)}% · ${label}${sizes}`;
    if (Math.floor(Number(p.percent) || 0) >= 100) {
      // limpiar la línea anterior y dejar la final fija con salto de línea
      process.stdout.write(`\r${' '.repeat(lastLine.length)}\r${line}\n`);
      lastLine = '';
    } else {
      process.stdout.write(`\r${line}`);
      lastLine = line;
    }
  };
}

async function runBackupCmd(lang, flags) {
  print(t(lang, 'cli.backup.running'));
  const { signal, dispose } = sigintSignal(); // Ctrl+C cancela LIMPIO (engine limpia parciales)
  try {
    const { message } = await runBackup({
      lang,
      provider: flags.provider,
      output: flags.output,
      dryRun: Boolean(flags['dry-run']),
      noEncrypt: flags['no-encrypt'] === true,
      env: process.env,
      onProgress: progressPainter('backup', lang),
      signal,
    });
    print(message);
    return 0;
  } finally {
    dispose();
  }
}

async function runRestoreCmd(lang, flags, overwrite, dryRun) {
  print(t(lang, 'cli.restore.running'));
  const { signal, dispose } = sigintSignal();
  try {
    const { message } = await runRestore({
      lang,
      from: flags.from, // stamp de la copia (o ruta absoluta compat) — sin esto: la más reciente
      dryRun, // sin --dry-run: se decide por --overwrite
      overwrite,
      env: process.env,
      onProgress: progressPainter('restore', lang),
      signal,
    });
    print(message);
    return 0;
  } finally {
    dispose();
  }
}

/** delete <name>: borra UNA copia local (stamp de listLocal). --yes no pregunta;
 *  sin --yes pide confirmación por readline 's/n' (exige TTY para no colgarse). */
async function runDeleteCmd(lang, flags, pos) {
  const name = pos[1];
  if (flags.help || flags.h || !name) {
    print(t(lang, 'cli.delete.help'));
    return flags.help || flags.h ? 0 : 1;
  }
  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      print(t(lang, 'cli.delete.confirm_required'), process.stderr);
      return 1;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(t(lang, 'cli.delete.confirm', { name }))).trim();
      if (!/^(s|si|sí|y|yes)$/i.test(answer)) {
        print(t(lang, 'cli.delete.aborted'));
        return 0;
      }
    } finally {
      rl.close();
    }
  }
  const { message } = await runDeleteLocal({ lang, name, env: process.env });
  print(message);
  return 0;
}

function runStatusCmd(lang) {
  const { lines } = getStatus({ lang });
  print(lines);
  return 0;
}

// ------------------------------------------------------------------ setup

async function interactiveSetup(opts) {
  const { flags, lang } = opts;
  if (!process.stdin.isTTY || flags.provider || flags.github || flags.gdrive) return null; // no interactivo
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers = {};
    const qLang = await rl.question(t(lang, 'cli.setup.q_lang'));
    answers.lang = (qLang.trim() || 'es').toLowerCase().startsWith('en') ? 'en' : 'es';
    const mergedLang = flags.lang || answers.lang;
    const qProvider = await rl.question(t(mergedLang, 'cli.setup.q_provider'));
    answers.provider = (qProvider.trim() || 'local').toLowerCase();
    const provider = PROVIDER_NAMES.includes(answers.provider) ? answers.provider : 'local';
    if (provider === 'github') {
      answers.owner = (await rl.question(t(mergedLang, 'cli.setup.q_owner'))).trim();
      answers.repo = (await rl.question(t(mergedLang, 'cli.setup.q_repo'))).trim() || 'opencode-sessions';
      const tok = await rl.question(t(mergedLang, 'cli.setup.q_token'));
      answers.token = tok.trim() || undefined;
    } else if (provider === 'gdrive') {
      answers.clientId = (await rl.question(t(mergedLang, 'cli.setup.q_gdrive_client'))).trim() || undefined;
      answers.clientSecret = (await rl.question(t(mergedLang, 'cli.setup.q_gdrive_secret'))).trim() || undefined;
      const refresh = await rl.question(t(mergedLang, 'cli.setup.q_gdrive_refresh'));
      answers.refreshToken = refresh.trim() || process.env.OPENCODE_GDRIVE_REFRESH || undefined;
      const folder = await rl.question(t(mergedLang, 'cli.setup.q_gdrive_folder'));
      answers.folderName = folder.trim() || undefined;
    }
    const pass = await rl.question(t(mergedLang, 'cli.setup.q_pass'));
    answers.passphrase = pass.trim() || undefined;
    return { lang: mergedLang, provider, wideAnswers: answers };
  } finally {
    rl.close();
  }
}

function nonInteractiveSetup(flags, env, langDefault) {
  const lang = flags.lang || langDefault;
  const provider = flags.gdrive ? 'gdrive' : (flags.provider || 'local');
  if (!PROVIDER_NAMES.includes(provider)) {
    throw new Error(t(lang, 'err.provider_unknown', { provider }));
  }
  return {
    lang,
    provider,
    wideAnswers: {
      owner: flags.owner, repo: flags.repo, token: flags.token,
      passphrase: flags.passphrase, parts: flags.parts,
      encrypt: flags['no-encrypt'] ? false : undefined,
      clientId: flags['client-id'] || env.OPENCODE_GDRIVE_CLIENT_ID,
      clientSecret: flags['client-secret'] || env.OPENCODE_GDRIVE_CLIENT_SECRET,
      refreshToken: flags['refresh-token'] || env.OPENCODE_GDRIVE_REFRESH,
      folderName: flags['folder-name'],
    },
    langOverride: lang !== langDefault ? lang : undefined,
  };
}

// ------------------------------------------------------------------ main

async function main(argv) {
  const { flags, pos, cmd: parsedCmd } = parseArgs(argv);
  const langDefault = detectLanguage(process.env);
  const lang = flags.lang || langDefault;
  const dryRun = Boolean(flags['dry-run']);
  const overwrite = Boolean(flags.overwrite);
  // Sin comando y terminal interactiva → abrir el menú directamente
  const cmd = pos.length === 0 && process.stdin.isTTY ? 'menu' : parsedCmd;

  switch (cmd) {
    case 'menu': case 'm': {
      // non-TTY: menú de solo lectura (sin loop, para pipes/demos)
      if (!process.stdin.isTTY) {
        print(menuText(lang));
        print('');
        print(t(lang, 'cli.menu.readonly_note'));
        return 0;
      }
      return menuInteractive(lang, flags, langDefault);
    }
    case 'setup': {
      return runSetupCmd({ flags, lang, langDefault });
    }
    case 'backup': {
      return runBackupCmd(lang, flags);
    }
    case 'restore': {
      return runRestoreCmd(lang, flags, overwrite, dryRun ? true : undefined);
    }
    case 'delete':
    case 'rm': {
      return runDeleteCmd(lang, flags, pos);
    }
    case 'status': {
      return runStatusCmd(lang);
    }
    case 'help':
    case '--help':
    case '-h':
    default: {
      if (!['help', '--help', '-h'].includes(cmd)) print(t(lang, 'cli.unknown_cmd', { cmd }), process.stderr);
      usage(lang);
      return ['help', '--help', '-h'].includes(cmd) ? 0 : 1;
    }
  }
}

// Ejecutar como binario; no al importarse como librería.
// realpathSync resuelve junctions/symlinks (npm link en Windows): Node resuelve
// import.meta.url a la ruta REAL mientras process.argv[1] puede ser la ruta del
// junction (AppData\Roaming\npm\node_modules\...). Comparando rutas resueltas,
// ambos lados coinciden.
function entryHref(arg) {
  if (!arg) return null;
  try {
    arg = realpathSync(arg); // si no existe o falla, comparar igual con lo que hay
  } catch { /* noop */ }
  return pathToFileURL(arg).href;
}
const isEntry = Boolean(process.argv[1]) && import.meta.url === entryHref(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      const lang = detectLanguage(process.env);
      print(`✗ ${err && err.message ? err.message : String(err)}`, process.stderr);
      if (err && err.cancelled) {
        // Ctrl+C / cancelación: mensaje i18n (err.cancelled) y código de salida 130.
        process.exitCode = 130;
        return;
      }
      print(t(lang, 'err.help_hint'), process.stderr);
      process.exitCode = 1;
    });
}

export { main, parseArgs, menuText, entryHref };
