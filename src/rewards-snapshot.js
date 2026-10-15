// Read-only normalization of a complete finalized getProgramAccounts export.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { unpackAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { REWARDS } from './rewards-protocol.js';

export function normalizeRewardSnapshot(evidence, exclusions = []) {
  const { mint, tokenProgram, commitment, response, snapshotAt } = evidence;
  if (mint !== REWARDS.mint || commitment !== 'finalized') throw Error('Wrong mint or nonfinalized snapshot');
  if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(tokenProgram)) throw Error('Unsupported token program');
  const slot = response?.result?.context?.slot, values = response?.result?.value;
  if (response?.error || !Number.isSafeInteger(slot) || slot <= 0 || !Array.isArray(values) || !values.length) throw Error('Missing complete account response');
  if (!Number.isSafeInteger(snapshotAt) || snapshotAt < Date.parse(REWARDS.startsAt) || snapshotAt > Date.now()) throw Error('Missing verified snapshot block time');
  const program = new PublicKey(tokenProgram), balances = new Map(), seen = new Set();
  for (const row of values) {
    if (seen.has(row.pubkey)) throw Error('Duplicate token account');
    seen.add(row.pubkey);
    if (row.account?.executable || row.account?.data?.[1] !== 'base64') throw Error('Invalid token account');
    const account = unpackAccount(new PublicKey(row.pubkey), {
      ...row.account, owner: new PublicKey(row.account.owner), data: Buffer.from(row.account.data[0], 'base64'),
    }, program);
    if (account.mint.toBase58() !== mint || !account.isInitialized) throw Error('Unexpected mint or uninitialized account');
    if (account.amount > 0n) {
      const wallet = account.owner.toBase58();
      balances.set(wallet, (balances.get(wallet) || 0n) + account.amount);
    }
  }
  const excluded = new Map([[REWARDS.fundingWallet, 'project funding wallet']]);
  for (const row of exclusions) {
    new PublicKey(row.wallet);
    if (typeof row.reason !== 'string' || !row.reason.trim()) throw Error('Exclusion needs a public reason');
    excluded.set(row.wallet, row.reason.trim());
  }
  // Finalized parent-account evidence resolves signer-capable PDA custody.
  // The claim program permits system-owned signer accounts, including PDAs
  // signed by their controller through CPI; it does not require an on-curve key.
  const custodyAccounts = new Map(), custody = evidence.custody;
  if (custody) {
    const lookup = custody.response?.result;
    if (custody.commitment !== 'finalized' || custody.response?.error || !Number.isSafeInteger(lookup?.context?.slot) || lookup.context.slot < slot
      || !Array.isArray(custody.addresses) || !Array.isArray(lookup.value) || custody.addresses.length !== lookup.value.length) throw Error('Invalid custody evidence');
    custody.addresses.forEach((wallet, i) => {
      new PublicKey(wallet);
      if (custodyAccounts.has(wallet)) throw Error('Duplicate custody address');
      custodyAccounts.set(wallet, lookup.value[i]);
    });
  }
  const entries = [], excludedBalances = [], unresolved = [], eligibleCustody = [];
  for (const [wallet, balance] of [...balances].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const row = { wallet, weight: balance.toString() };
    if (excluded.has(wallet)) excludedBalances.push({ ...row, reason: excluded.get(wallet) });
    else if (!PublicKey.isOnCurve(new PublicKey(wallet))) {
      const parent = custodyAccounts.get(wallet);
      if (parent?.owner === '11111111111111111111111111111111' && !parent.executable && parent.data?.[1] === 'base64' && Buffer.from(parent.data[0], 'base64').length === 0) {
        entries.push(row); eligibleCustody.push({ ...row, reason: 'Finalized system-owned PDA; claim requires its controller to sign via CPI' });
      } else unresolved.push({ ...row, reason: 'Program-derived owner: classify custody/eligibility before funding' });
    }
    else entries.push(row);
  }
  return {
    mint, tokenProgram, snapshotSlot: slot, snapshotAt,
    sourceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    accountCount: values.length, positiveBalanceOwners: balances.size,
    totalRawBalance: [...balances.values()].reduce((a, b) => a + b, 0n).toString(),
    eligibleRawBalance: entries.reduce((a, b) => a + BigInt(b.weight), 0n).toString(),
    excludedWallets: [...excluded.keys()].sort(), exclusions: [...excluded].map(([wallet, reason]) => ({ wallet, reason })),
    excludedBalances, eligibleCustody, unresolved, readyForAllocation: unresolved.length === 0, entries,
    trust: 'RPC export must be complete. Account validation and aggregation do not independently prove provider completeness or project-wallet ownership.',
  };
}
