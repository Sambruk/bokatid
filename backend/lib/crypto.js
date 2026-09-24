'use strict';
// Kryptering av M365-tokens i vila, lösenordshashning och slumpade länktokens.
const crypto = require('crypto');

const KEY = (() => {
  const hex = process.env.TOKEN_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('TOKEN_KEY måste vara 32 byte i hex (64 tecken). Kör: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
})();

/** AES-256-GCM. Format: v1.<iv>.<tagg>.<krypterat>, allt base64url. */
function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', b64(iv), b64(c.getAuthTag()), b64(enc)].join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Ogiltigt krypterat värde');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, unb64(iv));
  d.setAuthTag(unb64(tag));
  return Buffer.concat([d.update(unb64(data)), d.final()]).toString('utf8');
}

/** scrypt med slumpat salt. Format: scrypt$<salt>$<hash>. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${b64(salt)}$${b64(hash)}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = unb64(hash);
  const actual = crypto.scryptSync(String(password), unb64(salt), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** PKCE-par för OAuth-flödet mot Entra. */
function pkce() {
  const verifier = randomToken(32);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const b64 = (buf) => buf.toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

module.exports = { encrypt, decrypt, hashPassword, verifyPassword, randomToken, pkce };
