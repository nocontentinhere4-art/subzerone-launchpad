// Wallet sign-in (Sign-In-With-Solana style): the server issues a single-use, expiring nonce inside a plain-text
// message; the wallet signs the message (signMessage: no transaction, no funds); the server checks the ed25519
// signature, that the nonce is unused and unexpired, and that the message is exactly the one it issued.
import { now, token, sha256, isSolanaAddress, verifyWalletSignature, b58decode, HttpError } from './util.js';
import { audit } from './db.js';
import { randomBytes } from 'node:crypto';

export function signInMessage({ domain, origin, wallet, nonce, issuedAt, expiresAt }) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    '',
    'Sign in to the SUBZERONE launchpad. This is a message, not a transaction: it moves no funds and costs nothing.',
    '',
    `URI: ${origin}`,
    'Version: 1',
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(expiresAt).toISOString()}`,
  ].join('\n');
}

export function issueNonce(db, cfg, wallet, t = now()) {
  if (!isSolanaAddress(wallet)) throw new HttpError(400, 'bad_wallet', 'not a Solana address');
  db.run('DELETE FROM auth_nonces WHERE expires_at < ?', t - 86_400_000);
  // SIWS requires an alphanumeric nonce; base64url can contain '-' and '_'.
  const nonce = randomBytes(16).toString('hex');
  const origin = cfg.publicOrigin;
  const domain = new URL(origin).host;
  const expiresAt = t + cfg.nonceTtlS * 1000;
  const message = signInMessage({ domain, origin, wallet, nonce, issuedAt: t, expiresAt });
  db.run('INSERT INTO auth_nonces (nonce, wallet, message, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    nonce, wallet, message, t, expiresAt);
  return { nonce, message, expiresAt };
}

/** -> session cookie value. Throws 401 on any mismatch; the nonce is burned on the first attempt either way. */
export function verifySignIn(db, cfg, { wallet, nonce, signature }, t = now()) {
  let sig;
  try { sig = b58decode(String(signature)); } catch { throw new HttpError(401, 'bad_signature'); }
  const row = db.get('SELECT * FROM auth_nonces WHERE nonce = ?', String(nonce));
  if (!row) throw new HttpError(401, 'unknown_nonce', 'sign-in request not found; start again');
  // burned in its own committed statement: a replay of the same nonce fails even if this attempt fails below
  const burned = db.run('UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL', t, row.nonce);
  if (burned.changes !== 1) throw new HttpError(401, 'nonce_used', 'this sign-in request was already used');
  if (row.expires_at < t) throw new HttpError(401, 'nonce_expired', 'sign-in request expired; start again');
  if (row.wallet !== wallet) throw new HttpError(401, 'wallet_mismatch');
  if (!verifyWalletSignature(wallet, row.message, sig)) throw new HttpError(401, 'bad_signature');
  return db.tx(() => {
    db.run(`INSERT INTO users (wallet, role, created_at) VALUES (?, ?, ?) ON CONFLICT(wallet) DO NOTHING`,
      wallet, cfg.adminWallets.includes(wallet) ? 'admin' : 'user', t);
    if (cfg.adminWallets.includes(wallet)) db.run("UPDATE users SET role = 'admin' WHERE wallet = ?", wallet);
    const user = db.get('SELECT * FROM users WHERE wallet = ?', wallet);
    if (user.banned_at) throw new HttpError(403, 'banned');
    const value = token(32);
    db.run('INSERT INTO sessions (token_hash, wallet, created_at, expires_at) VALUES (?, ?, ?, ?)',
      sha256(value), wallet, t, t + cfg.sessionDays * 86_400_000);
    audit(db, { actor: `wallet:${wallet}`, kind: 'auth', message: 'signed in' });
    return value;
  });
}

export function sessionUser(db, cookieValue, t = now()) {
  if (!cookieValue) return null;
  const s = db.get(`SELECT s.wallet, u.role, u.banned_at FROM sessions s JOIN users u ON u.wallet = s.wallet
                    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`, sha256(cookieValue), t);
  if (!s || s.banned_at) return null;
  return { wallet: s.wallet, role: s.role };
}

export function signOut(db, cookieValue) {
  if (cookieValue) db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', now(), sha256(cookieValue));
}
