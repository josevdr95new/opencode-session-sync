// opencode-sync · prueba funcional (smoke test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_LANGS, detectLanguage, t, locale } from '../src/i18n.mjs';
import { renderGuide } from '../src/guides.mjs';
import { createPlugin } from '../src/library.mjs';

function collectKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' ? collectKeys(v, path) : [path];
  }).sort();
}

test('locales es/en cargan y tienen paridad de claves', () => {
  assert.deepEqual([...AVAILABLE_LANGS].sort(), ['en', 'es']);
  assert.deepEqual(collectKeys(locale('es')), collectKeys(locale('en')));
});

test('interpolación de parámetros en t()', () => {
  assert.equal(
    t('es', 'status.connected', { provider: 'GitHub', user: 'ana' }),
    'Conectado a GitHub como ana'
  );
  assert.equal(
    t('en', 'status.connected', { provider: 'Google Drive', user: 'bob' }),
    'Connected to Google Drive as bob'
  );
});

test('guías integradas: Google (5 pasos) y GitHub (4 pasos) en es y en', () => {
  for (const lang of ['es', 'en']) {
    const google = renderGuide('google', lang);
    const github = renderGuide('github', lang);
    assert.equal((google.match(/\n  \d\. /g) || []).length, 5);
    assert.equal((github.match(/\n  \d\. /g) || []).length, 4);
    assert.ok(google.includes('https://console.cloud.google.com'));
    assert.ok(github.includes('https://github.com/settings'));
  }
});

test('detección de idioma con respaldo', () => {
  assert.equal(detectLanguage({ OPENCODE_LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(detectLanguage({ LANG: 'es_CO.UTF-8' }), 'es');
  assert.equal(detectLanguage({ LANG: 'fr_FR.UTF-8' }), 'es'); // fallback
});

test('registro de comandos del plugin', () => {
  const plugin = createPlugin({ OPENCODE_LANG: 'es' });
  assert.equal(plugin.name, 'opencode-session-sync');
  assert.ok(plugin.commands['sync-setup']);
  const githubGuide = plugin.commands['sync-setup'].run(['github']);
  assert.ok(githubGuide.includes('Fine-grained'));
  assert.ok(plugin.commands['sync-setup'].run(['xyz']).includes('/sync-setup'));
  const help = plugin.commands['sync-help'].run();
  assert.ok(help.includes('/sync-setup') && help.includes('/sync-restore'));
});
