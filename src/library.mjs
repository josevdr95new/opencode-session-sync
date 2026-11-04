// opencode-instance-sync · librería pública del paquete (API no-plugin)
// Contenido íntegro del antiguo src/index.mjs: comandos del plugin llamado como librería.
// El server part de OpenCode vive ahora en src/index.mjs (default export Plugin.define).
import { detectLanguage, t } from './i18n.mjs';
import { renderGuide, PROVIDERS } from './guides.mjs';
import { runBackup, runRestore, getStatus } from './actions.mjs';

export const name = 'opencode-session-sync';
export const version = '0.3.0';

export function createPlugin(env = process.env) {
  const lang = detectLanguage(env);

  const commands = {
    'sync-setup': {
      description: t(lang, 'cmd.sync_setup.desc') + ' · ' + t(lang, 'cli.setup.summary', {
        provider: 'local|github', localDir: '<configDir>/sync-backup', parts: '80mb',
        encrypt: 'AES-256-GCM',
      }),
      run(args = []) {
        const provider = String(args[0] || '').toLowerCase();
        if (!PROVIDERS.includes(provider)) return t(lang, 'setup.choose_provider');
        return renderGuide(provider, lang);
      },
    },
    'sync-login': {
      description: t(lang, 'cmd.sync_login.desc'),
      run() {
        try {
          const { last } = getStatus({ lang, env }).info;
          return last ? t(lang, 'status.connected', { provider: 'provider', user: 'sync-auth.json' })
            : t(lang, 'status.disconnected');
        } catch {
          return t(lang, 'status.disconnected');
        }
      },
    },
    'sync-logout': {
      description: t(lang, 'cmd.sync_logout.desc'),
      run() {
        return t(lang, 'sync.logout');
      },
    },
    'sync-status': {
      description: t(lang, 'cmd.sync_status.desc'),
      run() {
        try {
          const { lines } = getStatus({ lang, env });
          return lines;
        } catch (err) {
          return `✗ ${err.message}`;
        }
      },
    },
    'sync-now': {
      description: t(lang, 'cmd.sync_now.desc'),
      run() {
        try {
          const { message } = runBackup({ lang, env });
          return message;
        } catch (err) {
          return `✗ ${err.message}`;
        }
      },
    },
    'sync-restore': {
      description: t(lang, 'cmd.sync_restore.desc'),
      run(args = []) {
        try {
          const overwrite = args.includes('--overwrite');
          const { message } = runRestore({
            lang,
            from: args.find((a) => a.startsWith('--from='))?.split('=')?.[1],
            overwrite,
            env,
          });
          return message;
        } catch (err) {
          return `✗ ${err.message}`;
        }
      },
    },
  };

  commands['sync-help'] = {
    description: t(lang, 'cmd.sync_help.desc'),
    run() {
      const entries = Object.entries(commands)
        .map(([cmd, def]) => `  /${cmd} — ${def.description}`);
      return [t(lang, 'help.title'), ...entries, t(lang, 'help.lang_note')].join('\n');
    },
  };

  return { name, version, lang, commands };
}
