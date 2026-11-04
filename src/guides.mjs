// opencode-sync · guías integradas: Google Drive y GitHub, localizadas
import { t, locale } from './i18n.mjs';

export const PROVIDERS = ['google', 'github'];

export function renderGuide(provider, lang) {
  const g = locale(lang).guide?.[provider];
  if (!g) return t(lang, 'setup.invalid_provider');
  const lines = [`[Guía] ${g.title}`];
  g.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push(`  Nota: ${g.note}`);
  lines.push(`  Enlace: ${g.link}`);
  return lines.join('\n');
}
