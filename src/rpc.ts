// opencode-session-sync · RPC contract (V2 plugin multi-part)
// Persona: server part (./) y RPC part (./rpc) lo exportan; TUI/GUI lo consumen vía ctx.client.rpc().
// Schemas en JSON Schema (sin deps). Los errores declarados viajan como resultado de error,
// NO como excepción cruzando la frontera RPC (ver docs RPC).
import { Rpc } from '@opencode/plugin/rpc';

const failedError = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};

/** Cancelación (Ctrl+C / context.signal abortado): SIN datos. */
const cancelledError = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** Copia/recursos no encontrados: incluye el nombre pedido (stamp) o el kind. */
const notFoundError = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

const notFoundKindError = {
  type: 'object',
  properties: { kind: { type: 'string' } },
  required: ['kind'],
  additionalProperties: false,
};

export const SessionSync = Rpc.define({
  id: 'opencode-session-sync',
  methods: {
    /** Informe completo de estado: { lines: texto multilínea localizado, info: { cfg, configDir, dataDir, last } } */
    status: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { lines: { type: 'string' }, info: { type: 'object' } },
        required: ['lines', 'info'],
      },
      errors: { failed: failedError },
    },
    /** Ejecuta un backup real del núcleo: { dryRun?: boolean } -> { message, info }
     *  Con provider github/gdrive: push automático del backup; si el push falla, el backup
     *  local se conserva y el message incluye el aviso del fallo de subida.
     *  Cancelable vía context.signal (Ctrl+C): error declarado 'cancelled' (sin datos);
     *  el motor limpia los outputs parciales antes de devolver. */
    backup: {
      input: {
        type: 'object',
        properties: { dryRun: { type: 'boolean' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { message: { type: 'string' }, info: { type: 'object' } },
        required: ['message'],
      },
      errors: { failed: failedError, cancelled: cancelledError },
    },
    /** Restore del núcleo: { from?: string, dryRun?: boolean, overwrite?: boolean } -> { message, res }
     *  `from`: stamp/nombre de UNA copia concreta (como aparece en listLocal) — con provider
     *  local resuelve el dir dentro del dir de copias (anti-traversal); con github/gdrive
     *  hace pull de ESE stamp; sin `from` restaura la copia más reciente. Compat: una ruta
     *  ABSOLUTA a un dir con manifest.json también se acepta. Copia inexistente -> error
     *  declarado 'not_found' con { name }. Con provider github y sin `from`: pull automático
     *  (manifest+parts) antes de restaurar; el plan dryRun también hace el pull.
     *  Cancelable vía context.signal: error 'cancelled'. */
    restore: {
      input: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          dryRun: { type: 'boolean' },
          overwrite: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { message: { type: 'string' }, res: { type: 'object' } },
        required: ['message'],
      },
      errors: { failed: failedError, cancelled: cancelledError, not_found: notFoundError },
    },
    /** Copias locales (provider/local.mjs list()): [{ dir, stamp, manifest }] — más nueva primero */
    listLocal: {
      input: {
        type: 'object',
        properties: { dir: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dir: { type: 'string' },
            stamp: { type: 'string' },
            manifest: {},
          },
        },
      },
      errors: { failed: failedError },
    },
    /** BORRA una copia local: { name } (stamp de listLocal o ruta absoluta de esa copia).
     *  Validación de seguridad: el path resuelto debe quedar dentro del dir de copias
     *  (anti-traversal). Solo borra manifest.json + part.NNN de ESA copia. Con provider
     *  gdrive también borra la copia remota (best-effort). -> { message } */
    deleteLocal: {
      input: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
      errors: { failed: failedError, not_found: notFoundError },
    },
    /** ABRE una carpeta en el explorador del SO: { kind: 'backups'|'config'|'data' }
     *  ENUM CERRADO (nunca un path arbitrario del cliente): 'backups' -> dir de copias
     *  local actual, 'config' -> configDir, 'data' -> dataDir. -> { message, dir } */
    reveal: {
      input: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['backups', 'config', 'data'] } },
        required: ['kind'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { message: { type: 'string' }, dir: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
      errors: { failed: failedError, not_found: notFoundKindError },
    },
    /** Extra (no en el contrato mínimo pedido): configura provider/parts/encrypt.
     *  provider 'github' + {owner, repo, token}: valida credenciales contra la API REST
     *  de GitHub antes de guardar (token SOLO en sync-auth.json, jamás en cfg/output).
     *  provider 'gdrive' + {clientId, clientSecret, refreshToken, folderName?}: valida
     *  contra la API de Google Drive (crea la carpeta raíz si falta) y guarda cfg
     *  {provider:'gdrive', folderId, user}; los secrets SOLO en sync-auth.json.
     *  `test: true` = conexión desde la GUI: EXIGE credenciales completas y las valida
     *  contra la API antes de persistir; sin credenciales completas es ERROR. Con
     *  provider 'local' verifica que el dir de copias existe y es ESCRIBIBLE. Sin
     *  `test` (CLI/env) se mantiene el flujo histórico: sin credenciales persiste + hint.
     *  `verified` lista los checks superados (p. ej. ['token','repo-push'] /
     *  ['auth','folder'] / ['writable']); vacío si no hubo validación.
     *  -> { lines, cfg, message?, login?, repo?, user?, folderId?, verified } */
    setup: {
      input: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['local', 'github', 'gdrive'] },
          parts: { type: 'string' },
          encrypt: { type: 'boolean' },
          owner: { type: 'string' },
          repo: { type: 'string' },
          passphrase: { type: 'string' },
          token: { type: 'string' },
          clientId: { type: 'string' },
          clientSecret: { type: 'string' },
          refreshToken: { type: 'string' },
          folderName: { type: 'string' },
          test: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          lines: { type: 'string' },
          cfg: { type: 'object' },
          message: { type: 'string' },
          login: { type: 'string' },
          repo: { type: 'string' },
          user: { type: 'string' },
          folderId: { type: 'string' },
          verified: { type: 'array', items: { type: 'string' } },
        },
        required: ['lines', 'cfg'],
      },
      errors: { failed: failedError },
    },
  },
  events: {
    /** Progreso real por bytes de backup/restore. Emitido con throttle desde el
     *  server part (index.mjs); la UI se suscribe a 'progress'. */
    progress: {
      schema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['backup', 'restore'] },
          phase: { type: 'string' },
          percent: { type: 'number' },
          bytes: { type: 'number' },
          total: { type: 'number' },
          detail: { type: 'string' },
        },
        required: ['op', 'phase', 'percent', 'bytes', 'total'],
        additionalProperties: false,
      },
    },
  },
});
