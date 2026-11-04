// opencode-sync · i18n: carga de locales, detección de idioma e interpolación
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadLocale(file) {
  return JSON.parse(readFileSync(join(__dirname, 'locales', file), 'utf8'));
}

const LOCALES = { es: loadLocale('es.json'), en: loadLocale('en.json') };

export const DEFAULT_LANG = 'es';
export const AVAILABLE_LANGS = Object.keys(LOCALES);

export function detectLanguage(env = {}) {
  const cand = (env.OPENCODE_LANG || env.LANG || env.LANGUAGE || '').toLowerCase();
  if (cand.startsWith('es')) return 'es';
  if (cand.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

function resolve(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

export function t(lang, key, params = {}) {
  const loc = LOCALES[lang] || LOCALES[DEFAULT_LANG];
  let text = resolve(loc, key) ?? resolve(LOCALES[DEFAULT_LANG], key) ?? key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

export function locale(lang) {
  return LOCALES[lang] || LOCALES[DEFAULT_LANG];
}
