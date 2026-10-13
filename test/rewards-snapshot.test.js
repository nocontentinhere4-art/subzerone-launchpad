import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { normalizeRewardSnapshot } from '../src/rewards-snapshot.js';
import { REWARDS } from '../src/rewards-protocol.js';
const holder = Keypair.generate().publicKey;
const pda = PublicKey.findProgramAddressSync([Buffer.from('custody')], TOKEN_2022_PROGRAM_ID)[0];
function row(owner, amount) {
  const data = Buffer.alloc(165);
  new PublicKey(REWARDS.mint).toBuffer().copy(data, 0); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1;
  return { pubkey: Keypair.generate().publicKey.toBase58(), account: { owner: TOKEN_2022_PROGRAM_ID.toBase58(), executable: false, data: [data.toString('base64'), 'base64'] } };
}
const evidence = () => ({ mint: REWARDS.mint, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), commitment: 'finalized', snapshotAt: Date.parse(REWARDS.startsAt), response: { result: { context: { slot: 123 }, value: [row(holder, 2n), row(holder, 3n), row(pda, 4n), row(new PublicKey(REWARDS.fundingWallet), 5n)] } } });
test('snapshot aggregates by owner, excludes treasury and blocks unresolved custody', () => {
  const e = evidence(), s = normalizeRewardSnapshot(e);
  assert.equal(s.totalRawBalance, '14'); assert.equal(s.entries[0].weight, '5');
  assert.equal(s.excludedBalances[0].weight, '5'); assert.equal(s.unresolved.length, 1); assert.equal(s.readyForAllocation, false);
  const reviewed = normalizeRewardSnapshot(e, [{ wallet: pda.toBase58(), reason: 'verified liquidity pool' }]);
  assert.equal(reviewed.readyForAllocation, true); assert.equal(reviewed.eligibleRawBalance, '5');
  assert.equal(normalizeRewardSnapshot(e).sourceDigest, s.sourceDigest);
});
test('snapshot rejects partial/error, mixed mint, duplicate accounts and unfinalized evidence', () => {
  assert.throws(() => normalizeRewardSnapshot({ ...evidence(), commitment: 'confirmed' }));
  assert.throws(() => normalizeRewardSnapshot({ ...evidence(), response: { error: { message: 'truncated' } } }));
  const duplicate = evidence(); duplicate.response.result.value.push(duplicate.response.result.value[0]); assert.throws(() => normalizeRewardSnapshot(duplicate));
  const wrong = evidence(), b = Buffer.from(wrong.response.result.value[0].account.data[0], 'base64'); Keypair.generate().publicKey.toBuffer().copy(b); wrong.response.result.value[0].account.data[0] = b.toString('base64'); assert.throws(() => normalizeRewardSnapshot(wrong));
  assert.throws(() => normalizeRewardSnapshot(evidence(), [{ wallet: pda.toBase58(), reason: '' }]));
});
