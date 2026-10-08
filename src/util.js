import { createHash, randomBytes, createCipheriv, createDecipheriv, createPublicKey, verify } from 'node:crypto';

export const now = () => Date.now();
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const id = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const utcDay = (t = now()) => new Date(t).toISOString().slice(0, 10);
export const parseJson = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };

// --- base58 (Bitcoin alphabet, as Solana uses) ---------------------------------------------------------------------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function b58decode(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 100) throw new Error('bad base58');
  let n = 0n;
  for (const c of s) {
    if (!(c in MAP)) throw new Error('bad base58');
    n = n * 58n + BigInt(MAP[c]);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function b58encode(buf) {
  const b = Uint8Array.from(buf);
  let n = 0n;
  for (const x of b) n = (n << 8n) + BigInt(x);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b) { if (x === 0) out = '1' + out; else break; }
  return out;
}

/** A Solana public key: base58 that decodes to exactly 32 bytes. Does not check that it is on the curve. */
export function isSolanaAddress(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}

/** Ed25519 signature check: a wallet's signMessage output (string message) or a transaction message (bytes). */
export function verifyWalletSignature(wallet, message, signature) {
  try {
    const pub = b58decode(wallet);
    if (pub.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub).toString('base64url') }, format: 'jwk' });
    const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
    return verify(null, bytes, key, Buffer.from(signature));
  } catch {
    return false;
  }
}

// --- symmetric encryption for stored secrets (AES-256-GCM) ---------------------------------------------------------
function keyBytes(b64) {
  const k = Buffer.from(b64 || '', 'base64');
  if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64');
  return k;
}
export function encrypt(keyB64, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBytes(keyB64), iv);
  const body = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function decrypt(keyB64, blob) {
  const [v, iv, tag, body] = String(blob).split('.');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const d = createDecipheriv('aes-256-gcm', keyBytes(keyB64), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]);
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra;
  }
}
