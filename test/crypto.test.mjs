// crypto: roundtrip, passphrase errónea, datos dañados, scrypt
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptBuffer, decryptBuffer, deriveKey, randomPassphrase, SALT_LEN, IV_LEN, TAG_LEN } from '../src/crypto.mjs';
import { t } from '../src/i18n.mjs';

test('roundtrip encrypt/decrypt preserva contenido binario arbitrario', () => {
  const samples = [
    crypto.randomBytes(1024),
    Buffer.from('incluye ünicode ñ y NUL\x00bytes¡'),
    Buffer.alloc(0),
    Buffer.from([0, 1, 2, 250, 255, 65, 66, 67]),
  ];
  for (const buf of samples) {
    const enc = encryptBuffer(buf, 'mi frase secreta');
    assert.equal(enc.subarray(0, 5).toString('ascii'), 'OCES1');
    assert.ok(enc.length >= 5 + SALT_LEN + IV_LEN + TAG_LEN);
    const dec = decryptBuffer(enc, 'mi frase secreta');
    assert.ok(Buffer.isBuffer(dec));
    assert.equal(dec.equals(buf), true, 'el descifrado devuelve el original');
  }
});

test('passphrase incorrecta -> error localizable claro', () => {
  const enc = encryptBuffer(Buffer.from('secreto'), 'correcta');
  assert.throws(() => decryptBuffer(enc, 'incorrecta'), (e) => e.message === t('es', 'err.passphrase'));
  assert.throws(() => decryptBuffer(enc, ''), /passphrase|secreto|incorrect/i);
});

test('datos dañados (magic) -> err.corrupt; bits alterados -> err.passphrase', () => {
  const ok = encryptBuffer(crypto.randomBytes(500), 'k');
  const noMagic = Buffer.from('XXXXX' + ok.subarray(5).toString('latin1'), 'latin1');
  assert.throws(() => decryptBuffer(noMagic, 'k'), (e) => e.message === t('es', 'err.corrupt'));
  const tampered = Buffer.from(ok);
  tampered[tampered.length - 3] ^= 0xff;
  assert.throws(() => decryptBuffer(tampered, 'k'), (e) => e.message === t('es', 'err.passphrase'));
  const trunc = ok.subarray(0, 10);
  assert.throws(() => decryptBuffer(trunc, 'k'), /corrupt|dañado|unrecognized/i);
});

test('deriveKey: mismo passphrase+salt -> misma clave; sale distinta por salt', () => {
  const salt = Buffer.alloc(SALT_LEN, 7);
  const a = deriveKey('x', salt).key;
  const b = deriveKey('x', Buffer.from(salt)).key;
  const c = deriveKey('x', Buffer.alloc(SALT_LEN, 8)).key;
  assert.ok(a.equals(b), 'determinista con igual salt');
  assert.ok(!a.equals(c), 'sensible al salt');
  assert.equal(a.length, 32);
});

test('randomPassphrase: dos llamadas dan valores distintos en base64url', () => {
  const a = randomPassphrase();
  const b = randomPassphrase();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 24);
});
