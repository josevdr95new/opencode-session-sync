// entryHref: resolución de la ruta de entrada para detección isEntry
// Caso portable: la ruta del proyecto resuelve (vía realpath) a sí misma en href.
// El caso junction (npm link) depende del sistema: no se fuerza con paths duros.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { entryHref } from '../src/cli.mjs';

test('entryHref: ruta real del proyecto resuelve a su propio href; null/argumento inexistente no lanza', () => {
  const here = fileURLToPath(import.meta.url);
  const hereHref = import.meta.url;
  assert.equal(entryHref(here), hereHref);
  // arg vacío -> null
  assert.equal(entryHref(''), null);
  assert.equal(entryHref(undefined), null);
  // path inexistente: no lanza, compara con lo que hay
  assert.equal(entryHref('C:\\definitivamente\\no\\existe\\x.mjs'), 'file:///C:/definitivamente/no/existe/x.mjs');
});
