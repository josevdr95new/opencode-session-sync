// opencode-sync · cifrado AES-256-GCM (zero-dep, node:crypto)
// Formato binario propio: MAGIC 'OCES1' (5B) + salt(16B) + iv(12B) + ciphertext + tag(16B)
import crypto from 'node:crypto';
import { DEFAULT_LANG, t } from './i18n.mjs';

const MAGIC = Buffer.from('OCES1', 'ascii');
export const SALT_LEN = 16;
export const IV_LEN = 12;
export const TAG_LEN = 16;
const KEY_LEN = 32;
// scrypt N=2^15 necesita ~32 MiB; subimos maxmem para no chocar con el límite por defecto
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** Deriva clave AES-256 de la passphrase con scrypt (salt explícito o aleatorio). */
export function deriveKey(passphrase, salt = crypto.randomBytes(SALT_LEN)) {
  const key = crypto.scryptSync(String(passphrase), salt, KEY_LEN, SCRYPT);
  return { key, salt };
}

/** Passphrase aleatoria (base64url) para setup cero-config. */
export function randomPassphrase() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Cifra un Buffer. Devuelve Buffer con header MAGIC+salt+iv+ciphertext+tag. */
export function encryptBuffer(buf, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const { key } = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, ciphertext, tag]);
}

/** Descifra. Passphrase incorrecta o datos dañados -> Error localizable. */
export function decryptBuffer(buf, passphrase, lang = DEFAULT_LANG) {
  const need = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (!Buffer.isBuffer(buf) || buf.length < need || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(t(lang, 'err.corrupt'));
  }
  const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = buf.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const tagStart = buf.length - TAG_LEN;
  const ciphertext = buf.subarray(MAGIC.length + SALT_LEN + IV_LEN, tagStart);
  const tag = buf.subarray(tagStart);
  const { key } = deriveKey(passphrase, salt);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM falla el tag si la passphrase es incorrecta o el blob está alterado
    throw new Error(t(lang, 'err.passphrase'));
  }
  return plain;
}
