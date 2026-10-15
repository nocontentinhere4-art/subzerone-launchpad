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

test('pump.fun dev buy (measurement): in the COMPACT layout create + split + buy fits 1232 bytes; never handed to a wallet any more (event authorities looked up)', async () => {
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

test('pump.fun dev buy: offline size probe: create + split + buy never fits ONE Phantom-safe transaction at real lengths (-> two); without the buy 3 and 8 recipients fit', async () => {
  const { compiledTxBytes, WALLET_HEADROOM_BYTES } = await import('../src/launch/pumpfun.js');
  const w = () => web3.Keypair.generate().publicKey.toBase58();
  const worst = (n, buy, name = 'N'.repeat(32), symbol = 'T'.repeat(10)) => ({ name, symbol, uri: `https://city.subzerone.live/m/${'0'.repeat(16)}.json`, initialBuyLamports: buy,
    feeSharing: { mode: 'sharing_config', shareholders: [{ wallet: w(), bps: 10000 - 1000 * (n - 1) }, ...Array.from({ length: n - 1 }, () => ({ wallet: w(), bps: 1000 }))] } });
  const two = await compiledTxBytes(worst(2, 10_000_000));
  assert.deepEqual([two.fits, two.phantomSafe], [false, false], 'no compact fallback with a buy: the buy becomes tx2');
  assert.ok(two.bytes > 1232 && two.bytes < 1300, `${two.bytes} bytes Phantom-safe (measured 1242-1259 on devnet)`);
  // a short name can squeeze under 1232 bytes, but leaves Phantom no room for the guards it appends: still two
  const typical = await compiledTxBytes(worst(2, 10_000_000, 'Ramen Radar', 'RAMEN'));
  assert.ok(typical.bytes > 1232 - WALLET_HEADROOM_BYTES, `${typical.bytes} bytes`);
  assert.equal(typical.fits, false);
  const plain = await compiledTxBytes(worst(2, 0));
  assert.deepEqual([plain.fits, plain.phantomSafe], [true, true], `${plain.bytes} bytes: a launch without a buy is Phantom-safe`);
  assert.equal((await compiledTxBytes(worst(3, 0))).fits, true, 'without the buy 3 recipients fit');
  assert.equal((await compiledTxBytes(worst(8, 0))).fits, true, 'large splits keep the compact fallback (no buy)');
});

// A bonding curve account as the program stores it (the IDL's snake_case fields), for the offline step-2 tests.
const { BorshAccountsCoder } = require('@coral-xyz/anchor');
async function curveAccount(curve) {
  const snake = Object.fromEntries(Object.entries(curve).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v]));
  return { owner: new web3.PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), lamports: 1_500_000, executable: false, rentEpoch: 0,
    data: await new BorshAccountsCoder(pumpSdk.pumpIdl).encode('BondingCurve', snake) };
}
/** The curve tx1 leaves behind (fresh, creator = the sharing config); `bought` lamports of someone else's buy first. */
function liveCurve(mint, bought = 0) {
  const c = { ...pumpSdk.newBondingCurve(GLOBAL, spl.NATIVE_MINT), creator: pumpSdk.feeSharingConfigPda(mint), isMayhemMode: false };
  if (!bought) return c;
  const Big = require('bn.js');
  const tokens = pumpSdk.getBuyTokenAmountFromSolAmount({ global: GLOBAL, feeConfig: FEE_CONFIG, mintSupply: null, bondingCurve: null, amount: new Big(bought), quoteMint: spl.NATIVE_MINT });
  const sol = new Big(bought).muln(98).divn(100);      // roughly what reaches the curve after fees
  return { ...c, virtualTokenReserves: c.virtualTokenReserves.sub(tokens), realTokenReserves: c.realTokenReserves.sub(tokens),
    virtualQuoteReserves: c.virtualQuoteReserves.add(sol), realQuoteReserves: c.realQuoteReserves.add(sol) };
}

/** A connection that answers from the fixture: Global, FeeConfig, a lookup table with every static account, a simulation. */
function fixtureConn({ balance = 1_000_000_000, simErr = null, logs = [], fee = 10_000, rentAndFee = 15_143_320, curves = new Map() } = {}) {
  let table = null;
  return {
    async getAccountInfo(key) { const k = key.toBase58(); return k === FIX.global.address ? account(FIX.global) : k === FIX.feeConfig.address ? account(FIX.feeConfig) : curves.get(k) ?? null; },
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
      const n = tx.message.compiledInstructions.length, buy = n === 5 || n === 2 ? 10_000_000 : 0;   // tx1 with the buy inside, or tx2
      return { value: simErr ? { err: simErr, logs } : { err: null, logs, unitsConsumed: 385_860, accounts: [{ lamports: balance - (n === 2 ? 2_074_080 + fee : rentAndFee) - buy }] } };
    },
  };
}
const CFG_TABLE = { launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet', lookupTable: web3.Keypair.generate().publicKey.toBase58() } };

test('pump.fun prepare (offline, fixture chain): with a dev buy, tx1 is the Phantom-safe launch WITHOUT the buy; the buy\'s fresh-curve quote rides along; the buy inside is refused, never compacted', async () => {
  const { eventAuthorities } = await import('../src/launch/pumpfun.js');
  const p = makePumpfunProvider(CFG_TABLE, { connection: fixtureConn() });
  const signer = web3.Keypair.generate().publicKey, sub01 = web3.Keypair.generate().publicKey;
  const built = await p.prepare({ ...launchConfig(10_000_000, signer, sub01), signer: signer.toBase58() }, { devBuyMode: 'second_tx' });
  const e = built.estimate;
  assert.equal(e.simulation.ok, true);
  assert.deepEqual([e.phantomSafe, e.devBuyMode, e.initialBuyLamports, e.initialBuyTokensBase], [false, 'second_tx', 0, null], 'nothing bought in tx1; the compact layout by default (Phantom support, 2026-10-15)');
  assert.deepEqual([e.networkFeeLamports, e.accountsLamports, e.signerBalanceLamports], [10_000, 15_133_320, 1_000_000_000], 'fee + rent = the simulated balance change');
  assert.deepEqual(e.devBuy, { mode: 'second_tx', requestedLamports: 10_000_000, lamports: 10_000_000, maxLamports: 10_500_000, tokensBase: '10493886257633', quotedAt: 'fresh curve' });
  const tx = web3.VersionedTransaction.deserialize(Buffer.from(built.txBase64, 'base64'));
  assert.equal(tx.message.compiledInstructions.length, 3, 'create_v2 + sharing config + update shares');
  const statics = tx.message.staticAccountKeys.map(String);
  // compact by default (Phantom support, 2026-10-15: around 900 bytes): the event authorities come from the table
  for (const ea of eventAuthorities()) assert.ok(!statics.includes(ea.toBase58()), 'event authorities read from the lookup table');
  assert.ok(built.txBytes <= 960 && built.txBytes > 800, `${built.txBytes} bytes`);
  assert.deepEqual(p.reviewOf(built.txBase64).programs.filter((x) => x.direct).map((x) => x.name), ['pump.fun (bonding curve)', 'pump.fun fee sharing']);
  assert.equal(await p.balance(signer.toBase58()), 1_000_000_000);
  // the buy inside tx1 does not fit Phantom-safe: a coded error, never the compact layout
  await assert.rejects(p.prepare({ ...launchConfig(10_000_000, signer, sub01), signer: signer.toBase58() }, { devBuyMode: 'same_tx' }), (x) => x.code === 'tx_too_large' && /1232-byte/.test(x.message));
  // a failed simulation is reported, not hidden
  const poor = makePumpfunProvider(CFG_TABLE, { connection: fixtureConn({ balance: 5_000, simErr: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: Error: insufficient lamports 5000, need 15000000'] }) });
  const failed = await poor.prepare({ ...launchConfig(10_000_000, signer, sub01), signer: signer.toBase58() }, { devBuyMode: 'second_tx' });
  assert.equal(failed.estimate.simulation.ok, false);
  assert.match(failed.estimate.simulation.logs.join(' '), /insufficient lamports/);
  const noTable = makePumpfunProvider(CFG_TABLE, { connection: { ...fixtureConn(), getAddressLookupTable: async () => ({ value: new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [] } }) }) } });
  await assert.rejects(noTable.prepare({ ...launchConfig(0, signer, sub01), signer: signer.toBase58() }), (x) => x.code === 'tx_too_large' && /lookup table may be missing accounts/.test(x.message));
  assert.equal(await p.devBuyFitsOneTx({ ...launchConfig(10_000_000, signer, sub01) }), false, 'launch.js picks second_tx');
});

// --- step 2: the dev buy as its own transaction (tx2) ---------------------------------------------------------------
import { devBuyInstructions } from '../src/launch/pumpfun.js';
test('pump.fun tx2 (offline): quoted on the live curve; a sniper first means fewer tokens for the same SOL; cap = cost + 5%; the curve\'s creator is named', async () => {
  const signer = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
  const fresh = await devBuyInstructions({ mint, signer, lamports: 10_000_000, global: GLOBAL, feeConfig: FEE_CONFIG, curve: liveCurve(mint) });
  assert.deepEqual([fresh.buy.lamports, fresh.buy.maxLamports, fresh.buy.tokensBase], [10_000_000, 10_500_000, '10493886257633'], 'nobody bought first: the fresh-curve quote');
  assert.deepEqual(fresh.ixs.map((ix) => ix.programId.toBase58()), [spl.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']);
  const names = pumpSdk.pumpIdl.instructions.find((i) => i.name === 'buy_v2').accounts.map((a) => a.name);
  const keyOf = (name) => fresh.ixs[1].keys[names.indexOf(name)].pubkey.toBase58();
  assert.equal(keyOf('user'), signer.toBase58());
  assert.equal(keyOf('associated_base_user'), spl.getAssociatedTokenAddressSync(mint, signer, true, spl.TOKEN_2022_PROGRAM_ID).toBase58());
  assert.equal(keyOf('creator_vault'), pumpSdk.creatorVaultPda(pumpSdk.feeSharingConfigPda(mint)).toBase58(), 'the buy\'s creator fee goes to the project\'s shared vault');
  // buy_v2 data: amount (exact tokens out) and max_sol_cost, partial fill off
  const data = Buffer.from(fresh.ixs[1].data);
  assert.equal(data.readBigUInt64LE(8).toString(), fresh.buy.tokensBase);
  assert.equal(data.readBigUInt64LE(16).toString(), String(fresh.buy.maxLamports));
  const sniped = await devBuyInstructions({ mint, signer, lamports: 10_000_000, global: GLOBAL, feeConfig: FEE_CONFIG, curve: liveCurve(mint, 500_000_000) });
  assert.ok(BigInt(sniped.buy.tokensBase) < BigInt(fresh.buy.tokensBase), 'a sniper moved the price: fewer tokens for the same SOL');
  assert.ok(sniped.buy.lamports <= 10_000_000 && sniped.buy.maxLamports === Math.floor(sniped.buy.lamports * 1.05), JSON.stringify(sniped.buy));
  // reuse (blockhash refresh): exactly the reviewed amounts, whatever the curve says now
  const again = await devBuyInstructions({ mint, signer, lamports: 10_000_000, global: GLOBAL, feeConfig: FEE_CONFIG, curve: liveCurve(mint, 900_000_000),
    reuse: { tokensBase: fresh.buy.tokensBase, costLamports: fresh.buy.lamports, maxLamports: fresh.buy.maxLamports } });
  assert.deepEqual([again.buy.tokensBase, again.buy.maxLamports], [fresh.buy.tokensBase, fresh.buy.maxLamports]);
  // refused with a code
  await assert.rejects(devBuyInstructions({ mint, signer, lamports: 10_000_000, global: GLOBAL, feeConfig: FEE_CONFIG, curve: null }), (e) => e.code === 'no_curve');
  await assert.rejects(devBuyInstructions({ mint, signer, lamports: 10_000_000, global: GLOBAL, feeConfig: FEE_CONFIG, curve: { ...liveCurve(mint), complete: true } }), (e) => e.code === 'curve_complete');
  await assert.rejects(devBuyInstructions({ mint, signer, lamports: 5_000_000_000, global: GLOBAL, feeConfig: FEE_CONFIG, curve: liveCurve(mint) }), (e) => e.code === 'buy_completes_curve');
});

test('pump.fun prepareDevBuy (fixture chain): no lookup table, one signer (the author), the event authority static, under 1232 bytes, the estimate rows', async () => {
  const { eventAuthorities } = await import('../src/launch/pumpfun.js');
  const signer = web3.Keypair.generate(), mint = web3.Keypair.generate().publicKey;
  const curves = new Map([[pumpSdk.bondingCurvePda(mint).toBase58(), await curveAccount(liveCurve(mint))]]);
  const p = makePumpfunProvider(CFG_TABLE, { connection: fixtureConn({ curves }) });
  const built = await p.prepareDevBuy({ mint: mint.toBase58(), signer: signer.publicKey.toBase58(), lamports: 10_000_000 });
  const tx = web3.VersionedTransaction.deserialize(Buffer.from(built.txBase64, 'base64'));
  assert.equal(tx.message.addressTableLookups.length, 0, 'every account is a static key');
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), signer.publicKey.toBase58());
  assert.ok(tx.message.staticAccountKeys.map(String).includes(eventAuthorities()[0].toBase58()), 'pump\'s event authority is static');
  assert.ok(built.txBytes <= 1232 && built.txBytes > 900, `${built.txBytes} bytes (measured 1033)`);
  const e = built.estimate;
  assert.deepEqual([e.phantomSafe, e.devBuyMode, e.initialBuyLamports, e.initialBuyMaxLamports, e.initialBuyTokensBase, e.networkFeeLamports, e.accountsLamports, e.simulation.ok],
    [true, 'second_tx', 10_000_000, 10_500_000, '10493886257633', 10_000, 2_074_080, true], 'rent = the author\'s new token account');
  const r = p.reviewOf(built.txBase64);
  assert.deepEqual(r.programs.filter((x) => x.direct).map((x) => x.name), ['Associated Token Account', 'pump.fun (bonding curve)']);
  assert.deepEqual([r.signers, r.launchProgramsOnly], [1, true]);
  // the wallet signs it alone; Phantom's guards are tolerated; another signer or another transaction is refused
  const attempt = { signer_wallet: signer.publicKey.toBase58(), mint: mint.toBase58(), tx_base64: built.txBase64, tx_message_hash: built.messageHash };
  const plain = web3.VersionedTransaction.deserialize(Buffer.from(built.txBase64, 'base64')); plain.sign([signer]);
  const ok = await p.verifyDevBuySigned(attempt, Buffer.from(plain.serialize()).toString('base64'));
  assert.ok(ok.signature.length > 80);
  const ixs = web3.TransactionMessage.decompile(tx.message).instructions;
  const guard = new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: signer.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([9]) });
  const guarded = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: tx.message.recentBlockhash,
    instructions: [web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }), ...ixs, guard] }).compileToV0Message());
  guarded.sign([signer]);
  assert.ok((await p.verifyDevBuySigned(attempt, Buffer.from(guarded.serialize()).toString('base64'))).signature);
  const other = web3.Keypair.generate();
  const cosigned = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: tx.message.recentBlockhash,
    instructions: [...ixs, new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([1]) })] }).compileToV0Message());
  cosigned.sign([signer, other]);
  await assert.rejects(p.verifyDevBuySigned(attempt, Buffer.from(cosigned.serialize()).toString('base64')), /another signer/);
  const swapped = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: tx.message.recentBlockhash,
    instructions: [ixs[0], web3.SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: other.publicKey, lamports: 10_000_000 })] }).compileToV0Message());
  swapped.sign([signer]);
  await assert.rejects(p.verifyDevBuySigned(attempt, Buffer.from(swapped.serialize()).toString('base64')), /differs from the reviewed/);
  // reuse: the same amounts, a new blockhash
  const refreshed = await p.prepareDevBuy({ mint: mint.toBase58(), signer: signer.publicKey.toBase58(), lamports: 10_000_000 },
    { reuse: { tokensBase: e.initialBuyTokensBase, costLamports: e.initialBuyLamports, maxLamports: e.initialBuyMaxLamports } });
  assert.deepEqual([refreshed.estimate.initialBuyTokensBase, refreshed.estimate.initialBuyMaxLamports], [e.initialBuyTokensBase, e.initialBuyMaxLamports]);
  assert.notEqual(refreshed.messageHash, built.messageHash);
  // no curve yet (an RPC node behind): a coded error
  await assert.rejects(makePumpfunProvider(CFG_TABLE, { connection: fixtureConn() }).prepareDevBuy({ mint: mint.toBase58(), signer: signer.publicKey.toBase58(), lamports: 10_000_000 }), (x) => x.code === 'no_curve');
});

test('pump.fun tx2 status, land check and on-chain verification: exact tokens, the cap, the payer', async () => {
  const author = web3.Keypair.generate().publicKey.toBase58(), mint = web3.Keypair.generate().publicKey.toBase58();
  const attempt = { tx_signature: 'buySig', last_valid_block_height: 1000, mint, signer_wallet: author, tokens_base: '10493886257633', max_lamports: 10_500_000 };
  const conn = (extra = {}) => ({ getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1200, getSignaturesForAddress: async () => [], ...extra });
  assert.equal((await makePumpfunProvider(cfgDev, { connection: conn({ getBlockHeight: async () => 999 }) }).devBuyStatus(attempt)).state, 'pending');
  assert.equal((await makePumpfunProvider(cfgDev, { connection: conn() }).devBuyStatus(attempt)).state, 'expired', 'no mint to wait for: past the window it is dead');
  assert.equal((await makePumpfunProvider(cfgDev, { connection: conn({ getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [1, { Custom: 6002 }] }, slot: 3 }] }) }) }).devBuyStatus(attempt)).state, 'failed');
  assert.equal((await makePumpfunProvider(cfgDev, { connection: conn({ getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'finalized', slot: 3 }] }) }) }).devBuyStatus(attempt)).state, 'finalized');
  // a finalized tx2 as getTransaction returns it: payer = author, the ATA at index 1 gets the tokens
  const keys = [author, web3.Keypair.generate().publicKey.toBase58(), mint, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'];
  const fetched = ({ tokens = attempt.tokens_base, spent = 10_000_000 + 5_000 + 2_074_080, err = null, payer = author } = {}) => ({ slot: 9, blockTime: 1, transaction: { message: {
    staticAccountKeys: [payer, ...keys.slice(1)].map((k) => new web3.PublicKey(k)),
    getAccountKeys: () => ({ keySegments: () => [[payer, ...keys.slice(1)].map((k) => new web3.PublicKey(k))] }) } },
    meta: { err, fee: 5_000, preBalances: [1_000_000_000, 0, 1, 1], postBalances: [1_000_000_000 - spent, 2_074_080, 1, 1], loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint, owner: author, uiTokenAmount: { amount: tokens } }] } });
  const verify = (t) => makePumpfunProvider(cfgDev, { connection: { getTransaction: async () => t } }).verifyDevBuy(attempt);
  const good = await verify(fetched());
  assert.equal(good.ok, true, JSON.stringify(good.checks));
  assert.match(good.checks.find((c) => /exactly the reviewed/.test(c.name)).detail, /10493886257633 base units/);
  assert.match(good.checks.find((c) => /within the signed cap/.test(c.name)).detail, /^10000000 lamports \(cap 10500000; network fee 5000; new accounts funded 2074080: /);
  assert.equal((await verify(fetched({ tokens: '1' }))).ok, false, 'not exactly the reviewed tokens');
  assert.equal((await verify(fetched({ spent: 11_000_000 + 5_000 + 2_074_080 }))).ok, false, 'took more than the cap');
  assert.equal((await verify(fetched({ payer: web3.Keypair.generate().publicKey.toBase58() }))).ok, false);
  assert.deepEqual([(await verify(null)).ok, (await verify(null)).retry], [false, true], 'not visible yet: look again later');
  // land check: open window, a landed copy found by its exact token amount, or dead
  assert.equal((await makePumpfunProvider(cfgDev, { connection: conn({ getBlockHeight: async () => 990 }) }).devBuyLandCheck(attempt)).state, 'open');
  const landed = makePumpfunProvider(cfgDev, { connection: conn({ getSignaturesForAddress: async () => [{ signature: 'other', err: null }, { signature: 'copy', err: null }],
    getTransaction: async (sig) => (sig === 'copy' ? fetched() : fetched({ tokens: '5' })) }) });
  assert.deepEqual(await landed.devBuyLandCheck(attempt), { state: 'landed', signature: 'copy' });
  assert.equal((await makePumpfunProvider(cfgDev, { connection: conn() }).devBuyLandCheck(attempt)).state, 'dead');
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
