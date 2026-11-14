// opencode-sync · registro/abstracción de proveedores {local, github, gdrive}
import { DEFAULT_LANG, t } from '../i18n.mjs';
import * as local from './local.mjs';
import * as github from './github.mjs';
import * as gdrive from './gdrive.mjs';

export const providers = { local, github, gdrive };

export const PROVIDER_NAMES = Object.keys(providers);

/** create('local'|'github'|'gdrive') -> módulo del proveedor + {name, cfg}. Error si no existe. */
export function create(provider, cfg = {}) {
  const mod = providers[provider];
  if (!mod) throw new Error(t(DEFAULT_LANG, 'err.provider_unknown', { provider }));
  return { ...mod, name: provider, cfg };
}
