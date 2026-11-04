// opencode-session-sync · tests del comando/menú interactivo `menu`
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, menuText, main } from '../src/cli.mjs';

test('parseArgs: menu y alias m mapean a cmd menu', () => {
  assert.equal(parseArgs(['menu']).cmd, 'menu');
  assert.equal(parseArgs(['m']).cmd, 'menu');
  assert.equal(parseArgs(['menu', '--lang', 'en']).cmd, 'menu');
  // sin comando se mantiene el default actual (help)
  assert.equal(parseArgs([]).cmd, 'help');
  assert.equal(parseArgs(['status']).cmd, 'status');
});

test('menuText: título localizado, opciones numeradas 1..5 y salida q, sin claves sin resolver', () => {
  for (const lang of ['es', 'en']) {
    const text = menuText(lang);
    // 5 opciones numéricas + línea q en el cuerpo
    assert.equal((text.match(/\n  \d\) /g) || []).length, 5);
    assert.ok(text.includes('  1) ') && text.includes('  2) ') && text.includes('  3) '));
    assert.ok(text.includes('  4) ') && text.includes('  5) '));
    assert.ok(text.includes('  q) '));
    // las claves i18n se resuelven (no quedan paths crudos)
    assert.ok(!text.includes('cli.menu.'));
    // título localizado
    assert.ok(text.startsWith(lang === 'es' ? 'opencode-session-sync · Menú principal' : 'opencode-session-sync · Main menu'));
    // textos de opciones presentes
    assert.ok(text.includes(lang === 'es' ? 'Mostrar estado' : 'Show status'));
    assert.ok(text.includes(lang === 'es' ? 'Respaldar ahora' : 'Back up now'));
  }
});

test('comando menu en non-TTY: imprime menú de solo lectura y termina 0 sin ejecutar acciones', async () => {
  // precondición del entorno de test (stdin con pipe → no TTY)
  assert.ok(!process.stdin.isTTY);
  const code = await main(['menu']);
  assert.equal(code, 0);
  const codeAlias = await main(['m']);
  assert.equal(codeAlias, 0);
});
