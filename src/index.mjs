// opencode-session-sync · SERVER PART (plugin OpenCode V2)
// El `.` export del paquete. Registra el RPC 'opencode-session-sync' que reutiliza
// las acciones del núcleo (src/actions.mjs) tal cual, sin duplicar lógica.
// La API de librería anterior sigue disponible como named exports (compatibilidad, main=./src/index.mjs).
import { Plugin } from '@opencode/plugin';
import { SessionSync } from './rpc.ts';
import { detectLanguage } from './i18n.mjs';
import { getStatus, runBackup, runRestore, runSetup, runDeleteLocal, runReveal } from './actions.mjs';
import { isCancelledError } from './backup.mjs';
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

    // Cancelación (Ctrl+C / context.signal abortado): error tipado 'cancelled', SIN datos.
    const cancelled = (context, err) =>
      context.error('cancelled', String(err?.message || err), {});

    // Recurso no encontrado: { name } (stamp) o { kind } según el recurso.
    const notFound = (context, err, key) => {
      const data = {};
      data[key] = String(err?.resource ?? '');
      return context.error('not_found', String(err?.message || err), data);
    };

    // Mapa común: cancelled -> 'cancelled' · notFound -> 'not_found' · resto -> 'failed'.
    const mapError = (context, err, notFoundKey = 'name') => {
      if (isCancelledError(err)) return cancelled(context, err);
      if (err?.notFound) return notFound(context, err, notFoundKey);
      return fail(context, err);
    };

    // Throttle del progreso hacia la UI: emitir si pasó >=250ms desde la última
    // emisión, O cambió la fase, O avanzó el percent entero (>=1 punto), O es el
    // final (100). SIEMPRE se emite el último evento (el 100 sale garantizado).
    let registration = null;
    const makeProgressEmit = (op) => {
      let lastSentAt = 0;
      let lastPhase = null;
      let lastInt = -1;
      return (p) => {
        if (!registration || !p) return;
        const percent = Number(p.percent) || 0;
        const intPercent = Math.floor(percent);
        const phaseChanged = p.phase !== lastPhase;
        const intChanged = intPercent !== lastInt;
        const isFinal = intPercent >= 100;
        const now = Date.now();
        if (!isFinal && !phaseChanged && !intChanged && now - lastSentAt < 250) return;
        lastSentAt = now;
        lastPhase = p.phase;
        lastInt = intPercent;
        const data = {
          op,
          phase: String(p.phase),
          percent,
          bytes: Number(p.bytes) || 0,
          total: Number(p.total) || 0,
        };
        if (p.detail !== undefined && p.detail !== null) data.detail = String(p.detail);
        // emit es async (Promise<void>): capturar rechazos para no ensuciar el proceso
        void Promise.resolve(registration.events.emit('progress', data)).catch(() => {});
      };
    };

    registration = await ctx.rpc.register(SessionSync, {
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
          // 'The second argument includes signal for cancellation' (docs RPC): el
          // motor limpia los outputs parciales y lanza err.cancelled al abortar.
          const { message, info } = await runBackup({
            lang,
            dryRun: Boolean(input?.dryRun),
            env: process.env,
            onProgress: makeProgressEmit('backup'),
            signal: context?.signal,
          });
          return { message, info };
        } catch (err) {
          return mapError(context, err);
        }
      },

      restore: async (input, context) => {
        try {
          const { result, message } = await runRestore({
            lang,
            from: input?.from,
            dryRun: input?.dryRun,
            overwrite: Boolean(input?.overwrite),
            env: process.env,
            onProgress: makeProgressEmit('restore'),
            signal: context?.signal,
          });
          return { message, res: result };
        } catch (err) {
          return mapError(context, err, 'name');
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

      deleteLocal: async (input, context) => {
        try {
          const { message } = await runDeleteLocal({ name: input?.name, lang });
          return { message };
        } catch (err) {
          return mapError(context, err, 'name');
        }
      },

      reveal: async (input, context) => {
        try {
          const { message, dir } = runReveal({ kind: input?.kind, lang });
          return { message, dir };
        } catch (err) {
          return mapError(context, err, 'kind');
        }
      },

      setup: async (input, context) => {
        try {
          const { lines, cfg, message, login, repo, user, folderId, verified } = await runSetup({
            lang,
            provider: input?.provider,
            parts: input?.parts,
            encrypt: input?.encrypt,
            // `test: true` (Conectar en la GUI): validación ESTRICTA — exige credenciales
            // completas y las valida contra la API antes de persistir; sin ellas es ERROR.
            test: input?.test === true,
            env: process.env,
            answers: {
              owner: input?.owner,
              repo: input?.repo,
              passphrase: input?.passphrase,
              token: input?.token,
              clientId: input?.clientId,
              clientSecret: input?.clientSecret,
              refreshToken: input?.refreshToken,
              folderName: input?.folderName,
            },
          });
          // Nunca se devuelven secrets: solo lines/message/cfg (sin secrets) y metadatos.
          const out = { lines, cfg, message: message || lines, verified: verified || [] };
          if (login) out.login = login;
          if (repo) out.repo = repo;
          if (user) out.user = user;
          if (folderId) out.folderId = folderId;
          return out;
        } catch (err) {
          return fail(context, err);
        }
      },
    });
  },
});
