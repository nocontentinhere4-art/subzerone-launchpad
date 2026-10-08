import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, wallet } from './helpers.js';
import { issueNonce, verifySignIn, sessionUser } from '../src/auth.js';

test('sign-in: valid signature creates a session', () => {
  const { cfg, db } = makeEnv();
  const w = wallet();
  const n = issueNonce(db, cfg, w.address);
  assert.match(n.message, /not a transaction/);
  const cookie = verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: w.signText(n.message) });
  assert.equal(sessionUser(db, cookie).wallet, w.address);
});

test('sign-in: a replayed nonce is refused', () => {
  const { cfg, db } = makeEnv();
  const w = wallet();
  const n = issueNonce(db, cfg, w.address);
  const sig = w.signText(n.message);
  verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: sig });
  assert.throws(() => verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: sig }), { code: 'nonce_used' });
});

test('sign-in: an expired nonce is refused', () => {
  const { cfg, db } = makeEnv();
  const w = wallet();
  const t = Date.now();
  const n = issueNonce(db, cfg, w.address, t - 10 * 60_000);
  assert.throws(() => verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: w.signText(n.message) }, t), { code: 'nonce_expired' });
});

test('sign-in: a failed attempt still burns the nonce (no retry with a forged signature)', () => {
  const { cfg, db } = makeEnv();
  const w = wallet(), other = wallet();
  const n = issueNonce(db, cfg, w.address);
  assert.throws(() => verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: other.signText(n.message) }), { code: 'bad_signature' });
  assert.throws(() => verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: w.signText(n.message) }), { code: 'nonce_used' });
});

test('sign-in: signature over a different message is refused', () => {
  const { cfg, db } = makeEnv();
  const w = wallet();
  const n = issueNonce(db, cfg, w.address);
  assert.throws(() => verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: w.signText(n.message.replace('localhost', 'evil.example')) }), { code: 'bad_signature' });
});

test('sign-in: invalid wallet address is refused', () => {
  const { cfg, db } = makeEnv();
  assert.throws(() => issueNonce(db, cfg, '0xabc'), { code: 'bad_wallet' });
  assert.throws(() => issueNonce(db, cfg, 'O0Il'.repeat(10)), { code: 'bad_wallet' });
});

test('admin wallets from ADMIN_WALLETS get the admin role', () => {
  const w = wallet();
  const { cfg, db } = makeEnv({ ADMIN_WALLETS: w.address });
  const n = issueNonce(db, cfg, w.address);
  const cookie = verifySignIn(db, cfg, { wallet: w.address, nonce: n.nonce, signature: w.signText(n.message) });
  assert.equal(sessionUser(db, cookie).role, 'admin');
});
