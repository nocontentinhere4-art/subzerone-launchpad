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
  // the mint is the second required signer, as in a real create_v2 launch
  const ix = web3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: 1, space: 0, programId: web3.SystemProgram.programId });
  const blockhash = web3.Keypair.generate().publicKey.toBase58();
  const msg = new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new web3.VersionedTransaction(msg);
  const intent = { signer_wallet: payer.publicKey.toBase58(), mint: mint.publicKey.toBase58(), tx_base64: Buffer.from(tx.serialize()).toString('base64'),
    tx_message_hash: createHash('sha256').update(msg.serialize()).digest('hex') };
  const mintSecret = Buffer.from(mint.secretKey).toString('base64');
  // what a wallet returns when it adds its own instructions before ours / after ours
  const withExtra = (before, after = []) => new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [...before, ix, ...after] }).compileToV0Message());
  return { payer, mint, mintSecret, tx, msg, intent, withExtra };
}
const LIGHTHOUSE = new web3.PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

const provider = makePumpfunProvider({ launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet' } }, { connection: {} });

test('pump.fun: the wallet signs first, the server adds the mint signature second (Phantom order), both verify', async () => {
  const { payer, mint, mintSecret, tx, intent } = prepared();
  assert.ok(tx.signatures[1].every((b) => b === 0), 'the reviewed bytes carry an empty mint slot');
  tx.sign([payer]);
  const out = await provider.verifySigned(intent, Buffer.from(tx.serialize()).toString('base64'), { mintSecret });
  assert.equal(out.signature.length > 80, true);
  const sent = web3.VersionedTransaction.deserialize(out.raw);
  assert.equal(sent.signatures.length, 2);
  assert.ok(!sent.signatures[1].every((b) => b === 0), 'the mint slot is filled before the broadcast');
  const { verifyWalletSignature } = require('../src/util.js');
  assert.ok(verifyWalletSignature(payer.publicKey.toBase58(), sent.message.serialize(), sent.signatures[0]));
  assert.ok(verifyWalletSignature(mint.publicKey.toBase58(), sent.message.serialize(), sent.signatures[1]));
  // no secret (wiped or lost) → the author must prepare again; a foreign secret is refused
  const { payer: p2, tx: t2, intent: i2 } = prepared(); t2.sign([p2]);
  await assert.rejects(() => provider.verifySigned(i2, Buffer.from(t2.serialize()).toString('base64')), /mint key is gone/);
  const { payer: p3, tx: t3, intent: i3 } = prepared(); t3.sign([p3]);
  await assert.rejects(() => provider.verifySigned(i3, Buffer.from(t3.serialize()).toString('base64'), { mintSecret }), /does not match/);
});

test('pump.fun: Phantom adding Lighthouse / compute-budget instructions is accepted; anything else added is refused', async () => {
  const { payer, mintSecret, intent, withExtra } = prepared();
  const cu = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
  const guard = new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: payer.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) });
  const ok = withExtra([cu], [guard]); ok.sign([payer]);
  const out = await provider.verifySigned(intent, Buffer.from(ok.serialize()).toString('base64'), { mintSecret });
  assert.equal(web3.VersionedTransaction.deserialize(out.raw).message.compiledInstructions.length, 3, 'broadcast as the wallet returned it');
  const steal = web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: web3.Keypair.generate().publicKey, lamports: 5 });
  const bad = withExtra([], [steal]); bad.sign([payer]);
  await assert.rejects(() => provider.verifySigned(intent, Buffer.from(bad.serialize()).toString('base64'), { mintSecret }), /was added/);
  const empty = withExtra([cu]).message; const noOurs = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: empty.recentBlockhash, instructions: [cu] }).compileToV0Message());
  noOurs.sign([payer]);
  await assert.rejects(() => provider.verifySigned(intent, Buffer.from(noOurs.serialize()).toString('base64'), { mintSecret }), /differs from the reviewed/);
});

test('pump.fun: a transaction that differs from the reviewed one is refused', async () => {
  const { payer, intent } = prepared();
  const other = prepared();
  other.tx.sign([other.payer]);
  await assert.rejects(() => provider.verifySigned(intent, Buffer.from(other.tx.serialize()).toString('base64')), /differs from the reviewed/);
  assert.ok(payer);
});

test('pump.fun: unsigned or wrongly signed transactions are refused', async () => {
  const { tx, intent } = prepared();
  await assert.rejects(() => provider.verifySigned(intent, Buffer.from(tx.serialize()).toString('base64')), /missing wallet signature/);
  const { tx: tx2, intent: intent2 } = prepared();
  tx2.signatures[0] = new Uint8Array(64).fill(7);
  await assert.rejects(() => provider.verifySigned(intent2, Buffer.from(tx2.serialize()).toString('base64')), /does not verify/);
});

function fakeConn({ status = null, height = 0, mintExists = false, sigs = [] } = {}) {
  return {
    getSignatureStatuses: async () => ({ value: [status] }),
    getBlockHeight: async () => height,
    getAccountInfo: async () => (mintExists ? { lamports: 1 } : null),
    getSignaturesForAddress: async () => sigs,
  };
}
const intentAt = { tx_signature: 'sig1', last_valid_block_height: 1000, mint: web3.Keypair.generate().publicKey.toBase58() };
const cfgDev = { launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet' } };

test('pump.fun status: never "expired" while the window is open or the mint exists (review #6)', async () => {
  const open = makePumpfunProvider(cfgDev, { connection: fakeConn({ height: 999 }) });
  assert.equal((await open.status(intentAt)).state, 'pending');
  const lagging = makePumpfunProvider(cfgDev, { connection: fakeConn({ height: 1200, mintExists: true }) });
  assert.equal((await lagging.status(intentAt)).state, 'pending');
  const dead = makePumpfunProvider(cfgDev, { connection: fakeConn({ height: 1200 }) });
  assert.equal((await dead.status(intentAt)).state, 'expired');
  const failed = makePumpfunProvider(cfgDev, { connection: fakeConn({ status: { err: { InstructionError: [0, 'x'] }, slot: 5 } }) });
  assert.equal((await failed.status(intentAt)).state, 'failed');
});

test('pump.fun landCheck: open window, landed later (found by mint), or dead', async () => {
  assert.equal((await makePumpfunProvider(cfgDev, { connection: fakeConn({ height: 990 }) }).landCheck(intentAt)).state, 'open');
  const landed = await makePumpfunProvider(cfgDev, { connection: fakeConn({ height: 1200, mintExists: true, sigs: [{ signature: 'later', slot: 9, err: null }, { signature: 'first', slot: 3, err: null }] }) }).landCheck(intentAt);
  assert.deepEqual(landed, { state: 'landed', signature: 'first' });
  assert.equal((await makePumpfunProvider(cfgDev, { connection: fakeConn({ height: 1200 }) }).landCheck(intentAt)).state, 'dead');
});

test('pump.fun submit: only a failed preflight counts as rejected; a timeout does not', async () => {
  const pre = Object.assign(new Error('Transaction simulation failed: insufficient lamports'), { name: 'SendTransactionError', logs: ['x'] });
  const p1 = makePumpfunProvider(cfgDev, { connection: { sendRawTransaction: async () => { throw pre; } } });
  await assert.rejects(p1.submit({}, Buffer.alloc(1)), (e) => e.rejected === true);
  const p2 = makePumpfunProvider(cfgDev, { connection: { sendRawTransaction: async () => { throw new TypeError('fetch failed'); } } });
  await assert.rejects(p2.submit({}, Buffer.alloc(1)), (e) => !e.rejected);
});

test('pump.fun review-before-sign: programs and writable accounts read from the built message', async () => {
  const { reviewOfMessage, PROGRAMS } = await import('../src/launch/pumpfun.js');
  const payer = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey, curve = web3.Keypair.generate().publicKey;
  const token2022 = new web3.PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const ix = (programId, keys) => new web3.TransactionInstruction({ programId: new web3.PublicKey(programId), keys, data: Buffer.alloc(0) });
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: [
    ix(PROGRAMS.pump, [{ pubkey: mint, isSigner: true, isWritable: true }, { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: token2022, isSigner: false, isWritable: false }]),
    ix(PROGRAMS.pumpFees, [{ pubkey: mint, isSigner: false, isWritable: false }]),
  ] }).compileToV0Message();
  const r = reviewOfMessage(msg);
  assert.deepEqual(r.programs, [{ id: PROGRAMS.pump, name: 'pump.fun (bonding curve)', direct: true },
    { id: PROGRAMS.pumpFees, name: 'pump.fun fee sharing', direct: true }, { id: token2022.toBase58(), name: 'Token-2022', direct: false }]);
  assert.deepEqual([r.accountsWritable, r.signers, r.launchProgramsOnly], [3, 2, true]);       // payer, mint, curve; payer + mint sign
  const b64 = Buffer.from(new web3.VersionedTransaction(msg).serialize()).toString('base64');
  assert.deepEqual(provider.reviewOf(b64), r);
  // anything else called directly (here a plain SOL transfer) is named and breaks the "launch programs only" promise
  const odd = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(),
    instructions: [web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: curve, lamports: 1 })] }).compileToV0Message();
  assert.deepEqual(reviewOfMessage(odd).programs, [{ id: '11111111111111111111111111111111', name: 'System Program', direct: true }]);
  assert.equal(reviewOfMessage(odd).launchProgramsOnly, false);
});

// --- the dev buy, composed offline from the devnet Global / FeeConfig fixture (read on 2026-10-10) ------------------
import { readFileSync } from 'node:fs';
import { launchInstructions, BUY_SLIPPAGE_PERCENT } from '../src/launch/pumpfun.js';
const pumpSdk = require('@pump-fun/pump-sdk');
const spl = require('@solana/spl-token');
const FIX = JSON.parse(readFileSync(new URL('./fixtures/pump-devnet-accounts.json', import.meta.url), 'utf8'));
const account = (f) => ({ owner: new web3.PublicKey(f.owner), lamports: f.lamports, executable: f.executable, rentEpoch: 0, data: Buffer.from(f.data, 'base64') });
const GLOBAL = pumpSdk.PUMP_SDK.decodeGlobal(account(FIX.global));
const FEE_CONFIG = pumpSdk.PUMP_SDK.decodeFeeConfig(account(FIX.feeConfig));
const launchConfig = (initialBuyLamports, signer, sub01) => ({ name: 'Ramen Radar', symbol: 'RAMEN', uri: 'https://city.subzerone.live/meta/ramen-radar/0123456789abcdef.json', initialBuyLamports,
  feeSharing: { mode: 'sharing_config', shareholders: [{ wallet: signer.toBase58(), bps: 8000 }, { wallet: sub01.toBase58(), bps: 2000 }] } });
const compile = (ixs, payer, tables = []) => new web3.TransactionMessage({ payerKey: payer, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message(tables);

test('pump.fun dev buy: create + locked split + ATA + buy_v2 in one message, buy after the split with the sharing config as creator', async () => {
  const { reviewOfMessage, PROGRAMS } = await import('../src/launch/pumpfun.js');
  const signer = web3.Keypair.generate().publicKey, sub01 = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
  const plain = await launchInstructions({ config: launchConfig(0, signer, sub01), mint, signer });
  assert.equal(plain.ixs.length, 3);
  assert.equal(plain.buy, null);
  const { ixs, buy } = await launchInstructions({ config: launchConfig(10_000_000, signer, sub01), mint, signer, global: GLOBAL, feeConfig: FEE_CONFIG });
  assert.equal(ixs.length, 5);
  assert.deepEqual(ixs.map((ix) => ix.programId.toBase58()), [PROGRAMS.pump, PROGRAMS.pumpFees, PROGRAMS.pumpFees, spl.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), PROGRAMS.pump]);
  // the quote: tokens for 0.01 SOL at a fresh curve, cost capped at quote + 5%
  assert.equal(buy.lamports, 10_000_000);
  assert.equal(buy.maxLamports, 10_500_000);
  assert.equal(BUY_SLIPPAGE_PERCENT, 5);
  assert.ok(BigInt(buy.tokensBase) > 0n);
  const expectTokens = pumpSdk.getBuyTokenAmountFromSolAmount({ global: GLOBAL, feeConfig: FEE_CONFIG, mintSupply: null, bondingCurve: null, amount: new (require('bn.js'))(10_000_000), quoteMint: spl.NATIVE_MINT });
  assert.equal(buy.tokensBase, expectTokens.toString());
  // the buy's accounts: the author's Token-2022 ATA, the sharing-config PDA's creator vault, the pinned fee recipients
  const names = pumpSdk.pumpIdl.instructions.find((i) => i.name === 'buy_v2').accounts.map((a) => a.name);
  const keyOf = (name) => ixs[4].keys[names.indexOf(name)].pubkey.toBase58();
  assert.equal(keyOf('user'), signer.toBase58());
  assert.equal(keyOf('associated_base_user'), buy.ata);
  assert.equal(buy.ata, spl.getAssociatedTokenAddressSync(mint, signer, true, spl.TOKEN_2022_PROGRAM_ID).toBase58());
  assert.equal(keyOf('creator_vault'), pumpSdk.creatorVaultPda(pumpSdk.feeSharingConfigPda(mint)).toBase58(), 'the buy\'s creator fee goes to the project\'s shared vault');
  assert.equal(keyOf('fee_recipient'), GLOBAL.feeRecipient.toBase58());
  assert.equal(keyOf('buyback_fee_recipient'), buy.buybackFeeRecipient);
  const again = await launchInstructions({ config: launchConfig(10_000_000, web3.Keypair.generate().publicKey, sub01), mint: web3.Keypair.generate().publicKey, signer: web3.Keypair.generate().publicKey, global: GLOBAL, feeConfig: FEE_CONFIG });
  assert.equal(again.buy.buybackFeeRecipient, buy.buybackFeeRecipient, 'pinned, not random: the lookup table can hold it');
  // review-before-sign: still "launch programs only" (the ATA program is green-listed), the token programs passed inside
  const r = reviewOfMessage(compile(ixs, signer));
  assert.equal(r.launchProgramsOnly, true);
  assert.deepEqual(r.programs.filter((p) => p.direct).map((p) => p.name), ['pump.fun (bonding curve)', 'pump.fun fee sharing', 'Associated Token Account']);
  assert.ok(r.programs.some((p) => p.name === 'Token-2022' && !p.direct));
  assert.ok(r.programs.every((p) => p.name !== 'unknown program'));
  assert.equal(r.signers, 2);
  // rejects what cannot be built
  await assert.rejects(launchInstructions({ config: launchConfig(10_000_000, signer, sub01), mint, signer }), /needs the pump Global/);
  await assert.rejects(launchInstructions({ config: launchConfig(1.5, signer, sub01), mint, signer, global: GLOBAL, feeConfig: FEE_CONFIG }), /whole lamports/);
});

test('pump.fun dev buy: with the static accounts in a lookup table the transaction stays under 1232 bytes', async () => {
  const sub01 = web3.Keypair.generate().publicKey;
  const build = async () => { const signer = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
    return { signer, ...(await launchInstructions({ config: launchConfig(2_000_000_000, signer, sub01), mint, signer, global: GLOBAL, feeConfig: FEE_CONFIG })) }; };   // 5 SOL would complete devnet's 1-SOL curve
  const keys = (b) => new Set(b.ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()));
  const [x, y] = [await build(), await build()];
  const statics = [...keys(x)].filter((k) => keys(y).has(k)).sort();         // what staticAccounts() puts in the table
  assert.ok(statics.length >= 22 && statics.length <= 26, `static accounts: ${statics.length}`);
  const table = new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: statics.map((k) => new web3.PublicKey(k)) } });
  const tx = new web3.VersionedTransaction(compile(x.ixs, x.signer, [table]));
  const bytes = tx.serialize().length;
  assert.ok(bytes <= 1232, `${bytes} bytes`);
  assert.ok(bytes > 1100, `${bytes} bytes: expected about 1186`);
  // without the table it does not fit at all
  assert.throws(() => new web3.VersionedTransaction(compile(x.ixs, x.signer)).serialize(), /overruns/);
});

test('pump.fun dev buy: the real cost is reported, a buy that would complete the curve is refused with a code', async () => {
  const signer = web3.Keypair.generate().publicKey, sub01 = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
  const two = await launchInstructions({ config: launchConfig(2_000_000_000, signer, sub01), mint, signer, global: GLOBAL, feeConfig: FEE_CONFIG });
  assert.deepEqual([two.buy.requestedLamports, two.buy.lamports, two.buy.maxLamports], [2_000_000_000, 1_999_999_999, 2_099_999_998], 'the quote rounds: the cost of the tokens, not the request');
  // devnet\'s Global seeds the curve with 1 SOL: 5 SOL takes every real token (mainnet seeds 30 SOL, where 5 SOL cannot)
  await assert.rejects(launchInstructions({ config: launchConfig(5_000_000_000, signer, sub01), mint, signer, global: GLOBAL, feeConfig: FEE_CONFIG }), (e) => e.code === 'buy_completes_curve' && /complete/.test(e.message));
  await assert.rejects(launchInstructions({ config: launchConfig(1, signer, sub01), mint, signer, global: GLOBAL, feeConfig: FEE_CONFIG }), (e) => e.code === 'buy_too_small');
});

test('pump.fun dev buy: offline size probe with the longest name, ticker and URI: 2 recipients fit, 3 do not', async () => {
  const { compiledTxBytes } = await import('../src/launch/pumpfun.js');
  const w = () => web3.Keypair.generate().publicKey.toBase58();
  const worst = (n, buy) => ({ name: 'N'.repeat(32), symbol: 'T'.repeat(10), uri: `https://city.subzerone.live/meta/${'s'.repeat(30)}/${'0'.repeat(16)}.json`, initialBuyLamports: buy,
    feeSharing: { mode: 'sharing_config', shareholders: [{ wallet: w(), bps: 10000 - 1000 * (n - 1) }, ...Array.from({ length: n - 1 }, () => ({ wallet: w(), bps: 1000 }))] } });
  const two = await compiledTxBytes(worst(2, 10_000_000));
  assert.equal(two.fits, true);
  assert.ok(two.bytes >= 1220 && two.bytes <= 1232, `${two.bytes} bytes (expected 1231)`);
  const three = await compiledTxBytes(worst(3, 10_000_000));
  assert.equal(three.fits, false);
  assert.ok(three.bytes > 1232 && three.bytes < 1300, `${three.bytes} bytes (expected 1263)`);
  assert.equal((await compiledTxBytes(worst(3, 0))).fits, true, 'without the buy 3 recipients fit');
  assert.equal((await compiledTxBytes(worst(8, 0))).fits, true);
});

/** A connection that answers from the fixture: Global, FeeConfig, a lookup table with every static account, a simulation. */
function fixtureConn({ balance = 1_000_000_000, simErr = null, logs = [], fee = 10_000, rentAndFee = 15_143_320 } = {}) {
  let table = null;
  return {
    async getAccountInfo(key) { const k = key.toBase58(); return k === FIX.global.address ? account(FIX.global) : k === FIX.feeConfig.address ? account(FIX.feeConfig) : null; },
    async getAddressLookupTable() {
      if (!table) {
        const sub01 = web3.Keypair.generate().publicKey, b = async () => { const s = web3.Keypair.generate().publicKey; return (await launchInstructions({ config: launchConfig(10_000_000, s, sub01), mint: web3.Keypair.generate().publicKey, signer: s, global: GLOBAL, feeConfig: FEE_CONFIG })).ixs; };
        const k = (ixs) => new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((x) => x.pubkey)]).map((x) => x.toBase58()));
        const [x, y] = [k(await b()), k(await b())];
        table = new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [...x].filter((a) => y.has(a)).map((a) => new web3.PublicKey(a)) } });
      }
      return { value: table };
    },
    async getLatestBlockhash() { return { blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }; },
    async getFeeForMessage() { return { value: fee }; },
    async getBalance() { return balance; },
    async simulateTransaction(tx) {
      const buy = tx.message.compiledInstructions.length === 5 ? 10_000_000 : 0;
      return { value: simErr ? { err: simErr, logs } : { err: null, logs, unitsConsumed: 385_860, accounts: [{ lamports: balance - rentAndFee - buy }] } };
    },
  };
}
const CFG_TABLE = { launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet', lookupTable: web3.Keypair.generate().publicKey.toBase58() } };

test('pump.fun prepare (offline, fixture chain): the estimate rows sum (rent excludes the fee and the buy), the buy fields, the size', async () => {
  const p = makePumpfunProvider(CFG_TABLE, { connection: fixtureConn() });
  const signer = web3.Keypair.generate().publicKey, sub01 = web3.Keypair.generate().publicKey;
  const built = await p.prepare({ ...launchConfig(10_000_000, signer, sub01), signer: signer.toBase58() });
  const e = built.estimate;
  assert.equal(e.simulation.ok, true);
  assert.deepEqual([e.networkFeeLamports, e.accountsLamports, e.initialBuyLamports, e.initialBuyRequestedLamports, e.initialBuyMaxLamports, e.signerBalanceLamports],
    [10_000, 15_133_320, 10_000_000, 10_000_000, 10_500_000, 1_000_000_000], 'fee + rent + buy = the simulated balance change (25,143,320)');
  assert.equal(e.initialBuyTokensBase, '10493886257633');
  assert.ok(built.txBytes <= 1232 && built.txBytes > 1100, `${built.txBytes} bytes`);
  assert.equal(p.reviewOf(built.txBase64).launchProgramsOnly, true);
  assert.equal(await p.balance(signer.toBase58()), 1_000_000_000);
  // a failed simulation is reported, not hidden; a transaction that does not fit is a coded error
  const poor = makePumpfunProvider(CFG_TABLE, { connection: fixtureConn({ balance: 5_000, simErr: { InstructionError: [4, { Custom: 1 }] }, logs: ['Program log: Error: insufficient lamports 5000, need 10500000'] }) });
  const failed = await poor.prepare({ ...launchConfig(10_000_000, signer, sub01), signer: signer.toBase58() });
  assert.equal(failed.estimate.simulation.ok, false);
  assert.match(failed.estimate.simulation.logs.join(' '), /insufficient lamports/);
  const noTable = makePumpfunProvider(CFG_TABLE, { connection: { ...fixtureConn(), getAddressLookupTable: async () => ({ value: new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [] } }) }) } });
  await assert.rejects(noTable.prepare({ ...launchConfig(10_000_000, signer, sub01), signer: signer.toBase58() }), (x) => x.code === 'tx_too_large' && /1232 bytes/.test(x.message));
});

test('pump.fun: Phantom-safe layout keeps both event authorities out of the lookup table (static keys), positions intact', async () => {
  const { eventAuthorities, phantomSafeTables } = await import('../src/launch/pumpfun.js');
  const signer = web3.Keypair.generate().publicKey, sub01 = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
  const built = await launchInstructions({ config: launchConfig(0, signer, sub01), mint, signer, global: GLOBAL, feeConfig: FEE_CONFIG });
  const all = [...new Set(built.ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()))].map((k) => new web3.PublicKey(k));
  const table = new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: all } });
  const safe = phantomSafeTables([table])[0];
  assert.equal(safe.state.addresses.length, table.state.addresses.length, 'same positions');
  const msg = compile(built.ixs, signer, [safe]);
  const statics = msg.staticAccountKeys.map((k) => k.toBase58());
  for (const ea of eventAuthorities()) assert.ok(statics.includes(ea.toBase58()), `${ea.toBase58()} is a static key`);
  assert.ok(new web3.VersionedTransaction(msg).serialize().length <= 1232, 'a launch without a dev buy still fits');
});
