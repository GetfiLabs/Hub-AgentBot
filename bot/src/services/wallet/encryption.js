// Phase 3.0 envelope encryption for the bot's per-user agent secret keys.
//
// Format:  v1:env::<base64 iv>::<base64 ciphertext>::<base64 auth_tag>
//
// v1 = AES-256-GCM with a 32-byte key sourced from BOT_AGENT_MASTER_KEY
//      (hex or base64). Acceptable for devnet bring-up only.
// v2 = (planned) Google Cloud KMS envelope encryption — same on-disk
//      shape but `env` → `kms:<keyName>` so we can rotate without a
//      data migration.
//
// Always ship rotation-ready code: the prefix lets `decrypt` dispatch
// to whichever scheme produced the blob.

const crypto = require('crypto');

const VERSION_ENV = 'v1:env';
const SEPARATOR = '::';

function loadEnvKey() {
  const raw = process.env.BOT_AGENT_MASTER_KEY;
  if (!raw) {
    throw new Error(
      'BOT_AGENT_MASTER_KEY is not set. Generate one with `openssl rand -hex 32`.',
    );
  }
  let bytes;
  if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    bytes = Buffer.from(raw.trim(), 'hex');
  } else {
    bytes = Buffer.from(raw.trim(), 'base64');
  }
  if (bytes.length !== 32) {
    throw new Error(
      `BOT_AGENT_MASTER_KEY must decode to 32 bytes (got ${bytes.length}).`,
    );
  }
  return bytes;
}

function encrypt(plaintext) {
  if (!Buffer.isBuffer(plaintext)) plaintext = Buffer.from(plaintext);
  const key = loadEnvKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION_ENV,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    authTag.toString('base64'),
  ].join(SEPARATOR);
}

function decrypt(blob) {
  if (typeof blob !== 'string' || !blob) {
    throw new Error('decrypt: expected non-empty string blob');
  }
  const parts = blob.split(SEPARATOR);
  if (parts.length !== 4) {
    throw new Error('decrypt: malformed blob (want 4 parts)');
  }
  const [version, ivB64, ctB64, tagB64] = parts;
  if (version !== VERSION_ENV) {
    throw new Error(`decrypt: unsupported version '${version}'`);
  }
  const key = loadEnvKey();
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {encrypt, decrypt, VERSION_ENV};
