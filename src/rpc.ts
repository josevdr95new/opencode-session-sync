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
    /** Ejecuta un backup real del núcleo: { dryRun?: boolean } -> { message, info } */
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
      errors: { failed: failedError },
    },
    /** Restore del núcleo: { from?: string, dryRun?: boolean, overwrite?: boolean } -> { message, res } */
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
      errors: { failed: failedError },
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
    /** Extra (no en el contrato mínimo pedido): configura provider/parts/encrypt vía runSetup del núcleo. */
    setup: {
      input: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['local', 'github'] },
          parts: { type: 'string' },
          encrypt: { type: 'boolean' },
          owner: { type: 'string' },
          repo: { type: 'string' },
          passphrase: { type: 'string' },
          token: { type: 'string' },
        },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { lines: { type: 'string' }, cfg: { type: 'object' } },
        required: ['lines', 'cfg'],
      },
      errors: { failed: failedError },
    },
  },
  events: {},
});
