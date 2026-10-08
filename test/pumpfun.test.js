// Offline checks of the pump.fun provider's signed-transaction verification (no RPC needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { makePumpfunProvider } from '../src/launch/pumpfun.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

function prepared() {
  const payer = web3.Keypair.generate(), mint = web3.Keypair.generate();
  const ix = web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mint.publicKey, lamports: 1 });
  const msg = new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: [ix] }).compileToV0Message();
  const tx = new web3.VersionedTransaction(msg);
  const intent = { signer_wallet: payer.publicKey.toBase58(), tx_message_hash: createHash('sha256').update(msg.serialize()).digest('hex') };
  return { payer, tx, msg, intent };
}

const provider = makePumpfunProvider({ launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet' } }, { connection: {} });

test('pump.fun: a correctly signed reviewed transaction verifies', () => {
  const { payer, tx, intent } = prepared();
  tx.sign([payer]);
  const out = provider.verifySigned(intent, Buffer.from(tx.serialize()).toString('base64'));
  assert.equal(out.signature.length > 80, true);
});

test('pump.fun: a transaction that differs from the reviewed one is refused', () => {
  const { payer, intent } = prepared();
  const other = prepared();
  other.tx.sign([other.payer]);
  assert.throws(() => provider.verifySigned(intent, Buffer.from(other.tx.serialize()).toString('base64')), /differs from the reviewed/);
  assert.ok(payer);
});

test('pump.fun: unsigned or wrongly signed transactions are refused', () => {
  const { tx, intent } = prepared();
  assert.throws(() => provider.verifySigned(intent, Buffer.from(tx.serialize()).toString('base64')), /missing wallet signature/);
  const { tx: tx2, intent: intent2 } = prepared();
  tx2.signatures[0] = new Uint8Array(64).fill(7);
  assert.throws(() => provider.verifySigned(intent2, Buffer.from(tx2.serialize()).toString('base64')), /does not verify/);
});
