// opencode-session-sync · SERVER PART (plugin OpenCode V2)
// El `.` export del paquete. Registra el RPC 'opencode-session-sync' que reutiliza
// las acciones del núcleo (src/actions.mjs) tal cual, sin duplicar lógica.
// La API de librería anterior sigue disponible como named exports (compatibilidad, main=./src/index.mjs).
import { Plugin } from '@opencode/plugin';
import { SessionSync } from './rpc.ts';
import { detectLanguage } from './i18n.mjs';
import { getStatus, runBackup, runRestore, runSetup } from './actions.mjs';
import { list as listLocal } from './providers/local.mjs';
import { loadSyncConfig } from './config.mjs';

// Compatibilidad: antes estos eran los exports del paquete.
export { name, version, createPlugin } from './library.mjs';

export default Plugin.define({
  id: 'opencode-session-sync',
  async setup(ctx) {
    // El server part corre en el proceso del server: el idioma se detecta de su entorno
    // (OPENCODE_LANG|LANG|LANGUAGE, fallback 'es'), igual que la CLI.
    const lang = detectLanguage(process.env);

    const fail = (context, err) =>
      context.error('failed', String(err?.message || err), { message: String(err?.message || err) });

    await ctx.rpc.register(SessionSync, {
      status: async (_input, context) => {
        try {
          const { lines, info } = getStatus({ lang });
          return { lines, info };
        } catch (err) {
          return fail(context, err);
        }
      },

      backup: async (input, context) => {
        try {
          const { message, info } = runBackup({
            lang,
            dryRun: Boolean(input?.dryRun),
            env: process.env,
          });
          return { message, info };
        } catch (err) {
          return fail(context, err);
        }
      },

      restore: async (input, context) => {
        try {
          const { result, message } = runRestore({
            lang,
            from: input?.from,
            dryRun: input?.dryRun,
            overwrite: Boolean(input?.overwrite),
            env: process.env,
          });
          return { message, res: result };
        } catch (err) {
          return fail(context, err);
        }
      },

      listLocal: async (input, context) => {
        try {
          const dir =
            typeof input?.dir === 'string' && input.dir
              ? input.dir
              : loadSyncConfig(/* configDir auto desde ENV del server */).localDir;
          return listLocal(dir);
        } catch (err) {
          return fail(context, err);
        }
      },

      setup: async (input, context) => {
        try {
          const { lines, cfg } = runSetup({
            lang,
            provider: input?.provider,
            parts: input?.parts,
            encrypt: input?.encrypt,
            env: process.env,
            answers: { owner: input?.owner, repo: input?.repo, passphrase: input?.passphrase, token: input?.token },
          });
          return { lines, cfg };
        } catch (err) {
          return fail(context, err);
        }
      },
    });
  },
});
