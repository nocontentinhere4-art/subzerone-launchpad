// The two-step launch (LAUNCH_SPLIT_TX=1, the default since 2026-10-15): tx1 = create_v2 ONLY (the wallet signs first,
// the mint key second, server-side), tx2 = sweep_creator_fee + create_fee_sharing_config + update_fee_shares_v2 with
// the exact approved shares (+ the dev buy when it fits), the author's wallet the only signer. The coin is never shown
// as having a locked split before tx2 is verified on chain. Offline (fixture chain) for pump.fun, end to end over HTTP
// with the MOCK provider for the city coin and for family coins launched from a coin site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { harness, user, drain, IDEA, ideaStatus, SUB01_WALLET } from './helpers.js';
import { mockSigningText } from '../src/launch/mock.js';
import { makePumpfunProvider, launchInstructions, splitInstructions, splitTxBytes, compiledTxBytes, decodeFeeShares, checkSignedShares, splitShape, PROGRAMS,
  WALLET_HEADROOM_BYTES } from '../src/launch/pumpfun.js';
import { recheckSplit, sweepSplits, splitText, getProvider } from '../src/launch.js';
import { worldView, deskView } from '../src/world.js';
import { setSetting } from '../src/db.js';
import { sha256 } from '../src/util.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const pumpSdk = require('@pump-fun/pump-sdk');
const Big = require('bn.js');

// --- pump.fun, offline: the devnet Global / FeeConfig fixture (as test/pumpfun.test.js) --------------------------------
const FIX = JSON.parse(readFileSync(new URL('./fixtures/pump-devnet-accounts.json', import.meta.url), 'utf8'));
const account = (f) => ({ owner: new web3.PublicKey(f.owner), lamports: f.lamports, executable: f.executable, rentEpoch: 0, data: Buffer.from(f.data, 'base64') });
const GLOBAL = pumpSdk.PUMP_SDK.decodeGlobal(account(FIX.global));
const FEE_CONFIG = pumpSdk.PUMP_SDK.decodeFeeConfig(account(FIX.feeConfig));
const LIGHTHOUSE = new web3.PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const pk = () => web3.Keypair.generate().publicKey;
const shapeOf = (signer, rows, initialBuyLamports = 0, extra = {}) => ({ name: 'Ramen Radar', symbol: 'RAMEN', uri: 'https://city.subzerone.live/m/0123456789abcdef.json', initialBuyLamports,
  feeSharing: { mode: 'sharing_config', shareholders: rows.map(([w, bps]) => ({ wallet: String(w), bps })) }, ...extra });
// the splits the launchpad writes: a city coin, a launchpad's child (gen 1), a family coin at depth 2 (gen 2)
const CITY = (a, s) => [[a, 8000], [s, 2000]];
const GEN1 = (a, p, s) => [[a, 7000], [p, 1000], [s, 2000]];
const GEN2 = (a, p, g, s) => [[a, 6000], [p, 1000], [g, 1000], [s, 2000]];

const { BorshAccountsCoder } = require('@coral-xyz/anchor');
async function curveAccount(curve) {
  const snake = Object.fromEntries(Object.entries(curve).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v]));
  return { owner: new web3.PublicKey(PROGRAMS.pump), lamports: 1_500_000, executable: false, rentEpoch: 0, data: await new BorshAccountsCoder(pumpSdk.pumpIdl).encode('BondingCurve', snake) };
}
/** The curve tx1 leaves behind: fresh, its creator the author (the split is tx2). */
const freshCurve = (creator, extra = {}) => ({ ...pumpSdk.newBondingCurve(GLOBAL, spl.NATIVE_MINT), creator, isMayhemMode: false, ...extra });
async function sharingAccount(mint, rows, { adminRevoked = true, admin = pk() } = {}) {
  const data = await pumpSdk.PUMP_SDK.offlinePumpFeeProgram.coder.accounts.encode('sharingConfig', { bump: 255, version: 2, status: { active: {} }, mint, admin, adminRevoked,
    shareholders: rows.map(([w, bps]) => ({ address: new web3.PublicKey(String(w)), shareBps: bps })) });
  return { owner: new web3.PublicKey(PROGRAMS.pumpFees), lamports: 2_000_000, executable: false, rentEpoch: 0, data };
}

/** A lookup table with every account common to two launches (create + split + sweep + buy): what npm run lookup-table
 *  writes from provider.staticAccounts(). */
let TABLE = null;
async function table() {
  if (TABLE) return TABLE;
  const p = makePumpfunProvider({ launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet' } }, { connection: { getAccountInfo: async (k) => (k.toBase58() === FIX.global.address ? account(FIX.global) : k.toBase58() === FIX.feeConfig.address ? account(FIX.feeConfig) : null) } });
  const keys = await p.staticAccounts();
  TABLE = new web3.AddressLookupTableAccount({ key: pk(), state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: keys.map((k) => new web3.PublicKey(k)) } });
  return TABLE;
}
function chainConn({ accounts = new Map(), balance = 1_000_000_000, simErr = null, logs = [], fee = 5_000, txs = new Map() } = {}) {
  return {
    async getAccountInfo(key) { const k = key.toBase58(); return k === FIX.global.address ? account(FIX.global) : k === FIX.feeConfig.address ? account(FIX.feeConfig) : accounts.get(k) ?? null; },
    async getAddressLookupTable() { return { value: await table() }; },
    async getLatestBlockhash() { return { blockhash: pk().toBase58(), lastValidBlockHeight: 1000 }; },
    async getFeeForMessage() { return { value: fee }; },
    async getBalance() { return balance; },
    async getBlockHeight() { return 1200; },
    async getTransaction(sig) { return txs.get(sig) ?? null; },
    async simulateTransaction() { return { value: simErr ? { err: simErr, logs } : { err: null, logs, unitsConsumed: 120_000, accounts: [{ lamports: balance - fee - 2_500_000 }] } }; },
  };
}
const CFG = (extra = {}) => ({ launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet', lookupTable: pk().toBase58(), ...extra } });
const tx = (b64) => web3.VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
const programsOf = (m) => { const k = m.staticAccountKeys.map(String); return m.compiledInstructions.map((ix) => k[ix.programIdIndex]); };
const sharesOf = (m) => { const k = m.staticAccountKeys.map(String); return m.compiledInstructions.filter((ix) => k[ix.programIdIndex] === PROGRAMS.pumpFees).map((ix) => decodeFeeShares(ix.data)).filter(Boolean); };

test('two-step tx1 (pump.fun, offline): exactly create_v2, the wallet first + one extra signer slot for the mint, <= 650 bytes, no fee-sharing program; the buy never rides in it', async () => {
  const author = web3.Keypair.generate(), sub01 = pk();
  const p = makePumpfunProvider(CFG(), { connection: chainConn() });
  for (const [rows, buy] of [[CITY(author.publicKey, sub01), 0], [GEN2(author.publicKey, pk(), pk(), sub01), 10_000_000]]) {
    const built = await p.prepare({ ...shapeOf(author.publicKey, rows, buy), signer: author.publicKey.toBase58() }, { devBuyMode: 'second_tx', splitTx: true });
    const t = tx(built.txBase64);
    assert.deepEqual(programsOf(t.message), [PROGRAMS.pump], 'create_v2 only');
    assert.deepEqual(Buffer.from(t.message.compiledInstructions[0].data).subarray(0, 8), Buffer.from(pumpSdk.pumpIdl.instructions.find((i) => i.name === 'create_v2').discriminator), 'it is create_v2');
    assert.equal(t.message.header.numRequiredSignatures, 2, 'the author + ONE extra signer: the mint');
    assert.equal(t.message.staticAccountKeys[0].toBase58(), author.publicKey.toBase58(), 'the wallet signs first');
    assert.equal(t.message.staticAccountKeys[1].toBase58(), built.mint, 'the mint is the second signer slot');
    assert.ok(t.signatures[1].every((b) => b === 0), 'the mint slot is empty in the bytes handed to the wallet');
    assert.ok(!t.message.staticAccountKeys.map(String).includes(PROGRAMS.pumpFees), 'no fee-sharing program');
    assert.ok(built.txBytes <= 650, `${built.txBytes} bytes`);
    assert.deepEqual([built.estimate.splitTx, built.estimate.initialBuyLamports], [true, 0]);
    if (buy) assert.equal(built.estimate.devBuy.requestedLamports, buy, 'the buy that follows is quoted for the review');
    // the server's verification: the shares check expects NO split in tx1; the wallet's guards are tolerated
    const intent = { signer_wallet: author.publicKey.toBase58(), mint: built.mint, tx_base64: built.txBase64, tx_message_hash: built.messageHash, split_tx: 1,
      config_json: JSON.stringify({ feeSharing: shapeOf(author.publicKey, rows).feeSharing }) };
    const ixs = web3.TransactionMessage.decompile(t.message, { addressLookupTableAccounts: [await table()] }).instructions;
    const guarded = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: author.publicKey, recentBlockhash: t.message.recentBlockhash,
      instructions: [web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7 }), ...ixs, new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [], data: Buffer.from([1]) })] }).compileToV0Message([await table()]));
    guarded.sign([author]);
    const out = await p.verifySigned(intent, Buffer.from(guarded.serialize()).toString('base64'), { mintSecret: built.mintSecret });
    assert.equal(web3.VersionedTransaction.deserialize(out.raw).signatures.length, 2);
  }
  // a tx1 that calls the fee-sharing program is refused by the shares check of a two-step intent
  const signer = pk(), mint = pk();
  const both = await launchInstructions({ config: shapeOf(signer, CITY(signer, sub01)), mint, signer });
  const m = new web3.TransactionMessage({ payerKey: signer, recentBlockhash: pk().toBase58(), instructions: both.ixs }).compileToV0Message([await table()]);
  assert.throws(() => checkSignedShares(m, shapeOf(signer, CITY(signer, sub01)), { expectNone: true }), /must not call the fee-sharing program/);
  assert.equal(checkSignedShares(m, shapeOf(signer, CITY(signer, sub01))).length, 2, 'the single-transaction check is unchanged');
  // the offline size probe agrees
  assert.ok((await compiledTxBytes({ ...shapeOf(signer, CITY(signer, sub01)), splitTx: true })).bytes <= 650);
});

test('two-step tx2 (pump.fun, offline): exactly sweep + sharing config + the exact shares (+ ATA + buy_v2), one signer, <= 1082 bytes; city 80/20, family gen1 70/10/20 and gen2 60/10/10/20', async () => {
  const sub01 = pk();
  for (const [label, mk] of [['city', (a) => CITY(a, sub01)], ['gen1', (a) => GEN1(a, pk(), sub01)], ['gen2', (a) => GEN2(a, pk(), pk(), sub01)]]) {
    for (const buy of [0, 10_000_000]) {
      const author = web3.Keypair.generate(), mint = pk(), rows = mk(author.publicKey);
      const accounts = new Map([[pumpSdk.bondingCurvePda(mint).toBase58(), await curveAccount(freshCurve(author.publicKey))]]);
      const p = makePumpfunProvider(CFG(), { connection: chainConn({ accounts }) });
      const config = shapeOf(author.publicKey, rows, buy);
      const built = await p.prepareSplit({ config, mint: mint.toBase58(), signer: author.publicKey.toBase58(), lamports: buy, withBuy: true });
      const t = tx(built.txBase64);
      const want = [PROGRAMS.pump, PROGRAMS.pumpFees, PROGRAMS.pumpFees, ...(built.withBuy ? [spl.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), PROGRAMS.pump] : [])];
      assert.deepEqual(programsOf(t.message), want, `${label} buy=${buy}`);
      const k = t.message.staticAccountKeys.map(String), names = (n) => Buffer.from(pumpSdk.pumpIdl.instructions.find((i) => i.name === n).discriminator);
      assert.deepEqual(Buffer.from(t.message.compiledInstructions[0].data).subarray(0, 8), names('sweep_creator_fee'), 'the sweep first: trades since tx1 left creator fees on the curve');
      assert.equal(t.message.header.numRequiredSignatures, 1, 'the author alone signs tx2');
      assert.equal(k[0], author.publicKey.toBase58());
      const shares = sharesOf(t.message);
      assert.equal(shares.length, 1);
      assert.deepEqual(shares[0].map((x) => [x.wallet, x.bps]), rows.map(([w, b]) => [String(w), b]), `${label}: exactly the approved shares, in order`);
      assert.ok(built.txBytes <= 1232 - WALLET_HEADROOM_BYTES, `${label} buy=${buy}: ${built.txBytes} bytes`);
      if (buy) {
        // the buy fits for the 2- and 3-row splits; a 4-row family split may push it to its own transaction (tx3)
        if (label !== 'gen2') assert.equal(built.withBuy, true, `${label}: the buy rides in tx2 (${built.txBytes} bytes)`);
        if (built.withBuy) {
          const bnames = pumpSdk.pumpIdl.instructions.find((i) => i.name === 'buy_v2').accounts.map((a) => a.name);
          const T = [await table()], ix = t.message.compiledInstructions[4], keyOf = (n) => web3.TransactionMessage.decompile(t.message, { addressLookupTableAccounts: T }).instructions[4].keys[bnames.indexOf(n)].pubkey.toBase58();
          assert.ok(ix);
          assert.equal(keyOf('creator_vault'), pumpSdk.creatorVaultPda(pumpSdk.feeSharingConfigPda(mint)).toBase58(), 'the buy\'s creator fee goes to the project\'s shared vault');
          assert.deepEqual([built.estimate.initialBuyLamports, built.estimate.initialBuyMaxLamports, built.estimate.initialBuyTokensBase], [10_000_000, 10_500_000, '10493886257633']);
        } else assert.deepEqual(built.buyDeferred && typeof built.buyDeferred.bytes, 'number');
      }
      const r = p.reviewOf(built.txBase64);
      assert.deepEqual([r.signers, r.launchProgramsOnly], [1, true]);
      console.log(`tx2 ${label} buy=${buy}: ${built.txBytes} bytes, withBuy=${built.withBuy}`);
    }
  }
  // the offline probe (what lookup-table and the docs quote): the 80/20 split with the buy stays under the wallet headroom
  const a = pk();
  const probe = await splitTxBytes(shapeOf(a, CITY(a, sub01), 10_000_000));
  assert.equal(probe.fitsWithBuy, true, `${probe.bytes} bytes`);
});

test('two-step tx2 (pump.fun): the signed copy must be the reviewed split; tampered shares, another signer, a missing split or a dropped buy are refused; Phantom\'s guards pass', async () => {
  const author = web3.Keypair.generate(), mint = pk(), sub01 = pk(), parent = pk();
  const rows = GEN1(author.publicKey, parent, sub01), config = shapeOf(author.publicKey, rows, 10_000_000);
  const accounts = new Map([[pumpSdk.bondingCurvePda(mint).toBase58(), await curveAccount(freshCurve(author.publicKey))]]);
  const p = makePumpfunProvider(CFG(), { connection: chainConn({ accounts }) });
  const built = await p.prepareSplit({ config, mint: mint.toBase58(), signer: author.publicKey.toBase58(), lamports: 10_000_000 });
  assert.equal(built.withBuy, true);
  const attempt = { signer_wallet: author.publicKey.toBase58(), mint: mint.toBase58(), tx_base64: built.txBase64, tx_message_hash: built.messageHash, with_buy: 1 };
  const t = tx(built.txBase64), T = [await table()];
  const ixs = web3.TransactionMessage.decompile(t.message, { addressLookupTableAccounts: T }).instructions;
  const signedWith = (list, signers = [author]) => { const v = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: author.publicKey, recentBlockhash: t.message.recentBlockhash, instructions: list }).compileToV0Message(T)); v.sign(signers); return Buffer.from(v.serialize()).toString('base64'); };
  const plain = tx(built.txBase64); plain.sign([author]);
  assert.ok((await p.verifySplitSigned(attempt, Buffer.from(plain.serialize()).toString('base64'), config)).signature.length > 80);
  const guard = new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: author.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([9]) });
  assert.ok((await p.verifySplitSigned(attempt, signedWith([web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs, guard]), config)).signature);
  // tampered shares: the same instructions with SUB-01's 20% moved to the author
  const [tampered] = await splitInstructions({ config: shapeOf(author.publicKey, [[author.publicKey, 9000], [parent, 1000]]), mint, signer: author.publicKey }).then((x) => [x.ixs]);
  await assert.rejects(p.verifySplitSigned(attempt, signedWith([...tampered, ixs[3], ixs[4]]), config), /differs from the reviewed|differ from the approved/);
  // even if the reviewed bytes themselves carried other shares, the server's approved split decides
  const evilAttempt = { ...attempt, tx_base64: Buffer.from(new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: author.publicKey, recentBlockhash: t.message.recentBlockhash, instructions: [...tampered, ixs[3], ixs[4]] }).compileToV0Message(T)).serialize()).toString('base64') };
  evilAttempt.tx_message_hash = createHash('sha256').update(tx(evilAttempt.tx_base64).message.serialize()).digest('hex');
  const evilSigned = tx(evilAttempt.tx_base64); evilSigned.sign([author]);
  await assert.rejects(p.verifySplitSigned(evilAttempt, Buffer.from(evilSigned.serialize()).toString('base64'), config), /differ from the approved split/);
  // another signer
  const other = web3.Keypair.generate();
  await assert.rejects(p.verifySplitSigned(attempt, signedWith([...ixs, new web3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([1]) })], [author, other]), config), /another signer/);
  // the split taken out (only the buy left), or the buy taken out of an attempt that carries it
  await assert.rejects(p.verifySplitSigned(attempt, signedWith(ixs.slice(3)), config), /differs from the reviewed/);
  const noBuy = await p.prepareSplit({ config, mint: mint.toBase58(), signer: author.publicKey.toBase58(), lamports: 10_000_000, withBuy: false });
  const nb = tx(noBuy.txBase64); nb.sign([author]);
  await assert.rejects(p.verifySplitSigned({ ...attempt, tx_base64: noBuy.txBase64, tx_message_hash: noBuy.messageHash }, Buffer.from(nb.serialize()).toString('base64'), config), /not the fee split that was reviewed/);
  assert.ok((await p.verifySplitSigned({ ...attempt, with_buy: 0, tx_base64: noBuy.txBase64, tx_message_hash: noBuy.messageHash }, Buffer.from(nb.serialize()).toString('base64'), config)).signature);
  assert.deepEqual(splitShape(nb.message), [PROGRAMS.pump, PROGRAMS.pumpFees, PROGRAMS.pumpFees]);
  // tx2 cannot be built before tx1 is on chain, nor once the curve's creator is no longer the author
  const none = makePumpfunProvider(CFG(), { connection: chainConn() });
  await assert.rejects(none.prepareSplit({ config, mint: mint.toBase58(), signer: author.publicKey.toBase58() }), (e) => e.code === 'no_curve');
  const pda = pumpSdk.feeSharingConfigPda(mint);
  const done = makePumpfunProvider(CFG(), { connection: chainConn({ accounts: new Map([[pumpSdk.bondingCurvePda(mint).toBase58(), await curveAccount(freshCurve(pda))]]) }) });
  await assert.rejects(done.prepareSplit({ config, mint: mint.toBase58(), signer: author.publicKey.toBase58() }), (e) => e.code === 'split_exists');
  const gone = makePumpfunProvider(CFG(), { connection: chainConn({ accounts: new Map([[pumpSdk.bondingCurvePda(mint).toBase58(), await curveAccount(freshCurve(author.publicKey, { complete: true }))]]) }) });
  await assert.rejects(gone.prepareSplit({ config, mint: mint.toBase58(), signer: author.publicKey.toBase58() }), (e) => e.code === 'curve_complete');
});

test('two-step (pump.fun): the chain read of a split (locked / other shares / not revoked / absent) and the verification of a landed tx2', async () => {
  const author = pk(), mint = pk(), sub01 = pk(), rows = CITY(author, sub01), config = shapeOf(author, rows);
  const pda = pumpSdk.feeSharingConfigPda(mint), curveKey = pumpSdk.bondingCurvePda(mint).toBase58();
  const conn = async (share, creator = pda) => chainConn({ accounts: new Map([[curveKey, await curveAccount(freshCurve(creator))], ...(share ? [[pda.toBase58(), share]] : [])]) });
  const read = async (c) => makePumpfunProvider(CFG(), { connection: c }).splitOnChain(mint.toBase58(), config);
  assert.equal((await read(await conn(null, author))).state, 'absent');
  assert.equal((await read(await conn(await sharingAccount(mint, rows)))).state, 'locked');
  const wrong = await read(await conn(await sharingAccount(mint, [[author, 10000]])));
  assert.deepEqual([wrong.state, wrong.reason], ['wrong', 'the shareholders on chain differ from the approved split']);
  assert.equal((await read(await conn(await sharingAccount(mint, rows, { adminRevoked: false })))).state, 'unlocked');
  assert.equal((await read(await conn(await sharingAccount(mint, rows), author))).state, 'wrong', 'the curve must name the config as its creator');
  // a finalized tx2
  const attempt = { tx_signature: 'splitSig', mint: mint.toBase58(), signer_wallet: author.toBase58(), with_buy: 0 };
  const landed = { slot: 9, blockTime: 1, transaction: { message: { getAccountKeys: () => ({ keySegments: () => [[author, pda, new web3.PublicKey(PROGRAMS.pumpFees)]] }) } }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] } } };
  const c = await conn(await sharingAccount(mint, rows)); c.getTransaction = async () => landed;
  const v = await makePumpfunProvider(CFG(), { connection: c }).verifySplit(attempt, config);
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  const cw = await conn(await sharingAccount(mint, [[author, 9000], [sub01, 1000]])); cw.getTransaction = async () => landed;
  const bad = await makePumpfunProvider(CFG(), { connection: cw }).verifySplit(attempt, config);
  assert.deepEqual([bad.ok, bad.splitOk, bad.retry], [false, false, false]);
  const lag = await conn(null, author); lag.getTransaction = async () => landed;
  assert.equal((await makePumpfunProvider(CFG(), { connection: lag }).verifySplit(attempt, config)).retry, true, 'a lagging node: look again');
  // the fee reader: before the lock the creator fees go to the author's own vault
  const reads = [];
  const fc = { getSlot: async () => 1, getBalance: async (k) => { reads.push(k.toBase58()); return 0; }, getMinimumBalanceForRentExemption: async () => 890_880, getAccountInfo: async () => null, getSignaturesForAddress: async () => [] };
  const fp = makePumpfunProvider(CFG(), { connection: fc });
  const pending = await fp.readFees({ mint: mint.toBase58(), split_state: 'pending' }, { ...config, signer: author.toBase58() });
  assert.equal(reads[0], pumpSdk.creatorVaultPda(author).toBase58());
  assert.match(pending[0].scope, /not locked yet/);
  await fp.readFees({ mint: mint.toBase58(), split_state: 'locked' }, { ...config, signer: author.toBase58() });
  assert.equal(reads[1], pumpSdk.creatorVaultPda(pda).toBase58(), 'locked: the project vault');
});

// --- end to end, MOCK provider --------------------------------------------------------------------------------------
function getWithHost(base, host, path) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => { let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', reject); req.end();
  });
}
async function later(ms, fn) { const real = Date.now; Date.now = () => real() + ms; try { return await fn(); } finally { Date.now = real; } }
async function toLaunchPrepared(h, { buySol = 0 } = {}) {
  const owner = h.client(user(h.db)); await owner.signIn();
  const admin = h.client(user(h.db, 'admin')); await admin.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { plotId: 'ginza-1' }));
  assert.equal(sub.status, 200, sub.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  const ideaId = sub.json.id, slug = (await owner.call('GET', `/api/ideas/${ideaId}`)).json.project.slug;
  assert.equal((await owner.call('POST', `/api/ideas/${ideaId}/publish`, { public: true })).status, 200);
  if (buySol) assert.equal((await owner.call('PUT', `/api/projects/${slug}/launch/options`, { initialBuySol: buySol })).status, 200);
  const proj = await owner.call('GET', `/api/projects/${slug}`);
  assert.equal((await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.json.allocation.id, statement: proj.json.allocation.statement, siteVersion: proj.json.liveSiteVersion })).status, 200);
  assert.equal((await admin.call('POST', `/api/admin/projects/${slug}/clear`, {})).status, 200);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
  return { owner, admin, ideaId, slug };
}
async function step1(h, owner, slug) {
  const t1 = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
  assert.equal(t1.status, 200, t1.text);
  assert.deepEqual([t1.json.step, t1.json.kind, t1.json.splitTx, t1.json.estimate.splitTx], [1, 'launch', true, true]);
  const s = await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: owner.w.signText(mockSigningText(t1.json.messageHash)) });
  assert.equal(s.status, 200, s.text);
  return t1;
}
const PENDING_LINE = 'Coin created. Step 2: lock the fee split (80% you / 20% SUB-01)';

test('two-step launch (MOCK, city coin): the coin first, NOT shown as split-locked; step 2 built only after tx1 confirms, resumed, abandoned, resumed, signed -> locked', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    const cfg = (await owner.call('GET', `/api/projects/${slug}`)).json.launchConfig;
    assert.equal(cfg.splitTx, true);
    assert.match(cfg.irreversible.join(' '), /locked in step 2, a second signature right after the coin is created/);
    await step1(h, owner, slug);
    assert.equal(h.db.get('SELECT split_tx FROM launch_intents').split_tx, 1);
    // tx2 cannot be built before tx1 is confirmed and verified
    const early = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.deepEqual([early.status, early.json.error], [409, 'not_launched']);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    // the coin exists; the split is NOT locked and nothing says it is
    const st = ideaStatus(h.db, ideaId);
    assert.equal(st.status, 'launched');
    assert.match(st.status_note, /Step 2: lock the fee split \(80% you \/ 20% SUB-01\)/);
    let v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([v.split.state, v.split.locked, v.allocation.status, v.ledger.locked, v.ledger.splitState], ['pending', false, 'approved', false, 'pending']);
    assert.ok(v.split.line.startsWith(PENDING_LINE), v.split.line);
    assert.equal(h.db.get('SELECT status FROM fee_allocations WHERE project_id = ?', v.id).status, 'approved', 'the allocation is not locked by tx1');
    const anon = h.client(user(h.db));
    const pub = (await anon.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([pub.split.state, pub.split.attempt, pub.ledger.locked], ['pending', null, false], 'public: the state, no attempt');
    assert.ok(JSON.stringify(worldView(h.db, h.cfg)).includes('"stageLabel":"Coin created · fee split not locked yet"'), 'the city says so');
    const desk = deskView(h.db, h.cfg, { wallet: owner.w.address, owner: true, previewLink: () => null, explorerTx: () => null });
    assert.deepEqual([desk.projects[0].stageLabel, desk.projects[0].split], ['Coin created · fee split not locked yet', { state: 'pending', locked: false }]);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    let site = await getWithHost(h.base, `${slug}.${h.cfg.projectsHost}`, '/');
    assert.match(site.body, /Coin created · fee split not locked yet/);
    assert.match(site.body, /Until then the fee split is NOT locked\./);
    assert.match(site.body, /Author: lock the fee split/);
    // step 2: exactly the approved shares, the author alone; a second request resumes it
    const t2 = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.equal(t2.status, 200, t2.text);
    assert.deepEqual([t2.json.step, t2.json.kind, t2.json.withBuy, t2.json.signers], [2, 'split', false, 1]);
    assert.deepEqual(t2.json.shareholders, [{ wallet: owner.w.address, bps: 8000 }, { wallet: SUB01_WALLET, bps: 2000 }]);
    assert.equal(t2.json.splitText, '80% you / 20% SUB-01');
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {})).json.attemptId, t2.json.attemptId, 'resumed, not a second one');
    // abandoned (the wallet closed): back to pending; the author resumes any time with a fresh transaction
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/abandon`, { reason: 'rejected' })).status, 200);
    assert.equal((await owner.call('GET', `/api/projects/${slug}`)).json.split.state, 'pending');
    const again = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.equal(again.status, 200, again.text);
    assert.notEqual(again.json.attemptId, t2.json.attemptId);
    assert.notEqual(again.json.messageHash, t2.json.messageHash);
    // someone else cannot sign it
    const stranger = h.client(user(h.db)); await stranger.signIn();
    assert.notEqual((await stranger.call('POST', `/api/projects/${slug}/launch/split/signed`, { signed: stranger.w.signText(again.json.mockSigningText) })).status, 200);
    const sg = await owner.call('POST', `/api/projects/${slug}/launch/split/signed`, { signed: owner.w.signText(again.json.mockSigningText) });
    assert.equal(sg.status, 200, sg.text);
    assert.equal((await owner.call('GET', `/api/projects/${slug}`)).json.split.state, 'submitted');
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([v.split.state, v.split.locked, v.allocation.status, v.ledger.locked], ['locked', true, 'locked', true]);
    assert.match(ideaStatus(h.db, ideaId).status_note, /Fee split locked on chain: 80% you \/ 20% SUB-01\. Launched\./);
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM events WHERE kind = 'split_locked'`).n, 1);
    // locked: no second tx2, the recheck is idempotent
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {})).json.error, 'already_locked');
    assert.equal((await recheckSplit(h.db, h.cfg, v.id)).skipped, true);
    // the site, rebuilt: no "not locked" line any more
    site = await getWithHost(h.base, `${slug}.${h.cfg.projectsHost}`, '/');
    assert.doesNotMatch(site.body, /fee split not locked yet|NOT locked/);
    assert.ok(!JSON.stringify(worldView(h.db, h.cfg)).includes('fee split not locked yet'));
  } finally { h.close(); }
});

test('two-step launch (MOCK): the dev buy rides in tx2 when it fits (one signature for split + buy), else it waits for the lock and is a third signature', async () => {
  const h = await harness();
  try {
    const { owner, slug } = await toLaunchPrepared(h, { buySol: 0.01 });
    assert.equal((await owner.call('GET', `/api/projects/${slug}`)).json.launchConfig.devBuyMode, 'second_tx', 'never inside tx1');
    const t1 = await step1(h, owner, slug);
    assert.equal(t1.json.estimate.initialBuyLamports, 0);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    let v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([v.split.state, v.devBuy.status], ['pending', 'pending']);
    // the buy alone is refused until the split is locked (its creator fee must go to the split)
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/devbuy/transaction`, {})).json.error, 'split_pending');
    const t2 = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.deepEqual([t2.json.withBuy, t2.json.requestedLamports], [true, 10_000_000]);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/signed`, { signed: owner.w.signText(t2.json.mockSigningText) })).status, 200);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([v.split.state, v.devBuy.status, v.devBuy.attempt.status], ['locked', 'done', 'done']);
    assert.equal(v.devBuy.attempt.signature, v.split.attempt.signature, 'one signature: the split and the buy together');
  } finally { h.close(); }
  // the buy does not fit tx2 (mock.split_buy_separate): the split alone, then the dev buy as before
  const h2 = await harness();
  try {
    setSetting(h2.db, 'mock.split_buy_separate', true, 'test');
    const { owner, slug } = await toLaunchPrepared(h2, { buySol: 0.01 });
    await step1(h2, owner, slug);
    await later(5000, () => drain(h2.db, h2.cfg, h2.brain.fetchImpl));
    const t2 = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.deepEqual([t2.json.withBuy, t2.json.buyDeferred], [false, true]);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/signed`, { signed: owner.w.signText(t2.json.mockSigningText) })).status, 200);
    await later(5000, () => drain(h2.db, h2.cfg, h2.brain.fetchImpl));
    let v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([v.split.state, v.devBuy.status], ['locked', 'pending']);
    assert.match(v.statusNote, /Next: your dev buy of 0\.01 SOL/);
    const t3 = await owner.call('POST', `/api/projects/${slug}/launch/devbuy/transaction`, {});
    assert.equal(t3.status, 200, t3.text);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/devbuy/signed`, { signed: owner.w.signText(t3.json.mockSigningText) })).status, 200);
    await later(5000, () => drain(h2.db, h2.cfg, h2.brain.fetchImpl));
    v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.equal(v.devBuy.status, 'done');
    // and separateBuy (the author's choice, e.g. after the price moved) works without the setting too
  } finally { h2.close(); }
  const h3 = await harness();
  try {
    const { owner, slug } = await toLaunchPrepared(h3, { buySol: 0.01 });
    await step1(h3, owner, slug);
    await later(5000, () => drain(h3.db, h3.cfg, h3.brain.fetchImpl));
    const withBuy = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.equal(withBuy.json.withBuy, true);
    // skipping the buy cancels the waiting tx2 that carried it; step 2 is built again without it
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/devbuy/skip`, {})).status, 200);
    const plain = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.equal(plain.status, 200, plain.text);
    assert.equal(plain.json.withBuy, false);
  } finally { h3.close(); }
});

test('two-step launch (MOCK): tampered shares are refused at signing; the server re-derives them from the approved allocation', async () => {
  const h = await harness();
  try {
    const { owner, slug } = await toLaunchPrepared(h);
    await step1(h, owner, slug);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    const t2 = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    // the reviewed document altered (SUB-01's row moved to the author): the signature verifies, the shares do not
    const doc = JSON.parse(Buffer.from(t2.json.txBase64, 'base64').toString('utf8'));
    doc.shareholders = [{ wallet: owner.w.address, bps: 10000 }];
    h.db.run('UPDATE split_attempts SET tx_base64 = ? WHERE id = ?', Buffer.from(JSON.stringify(doc)).toString('base64'), t2.json.attemptId);
    const bad = await owner.call('POST', `/api/projects/${slug}/launch/split/signed`, { signed: owner.w.signText(t2.json.mockSigningText) });
    assert.deepEqual([bad.status, bad.json.error], [400, 'bad_signed_tx']);
    assert.match(bad.json.message, /differ from the approved split/);
    // the approved allocation row no longer matching the launch configuration: nothing is built or sent
    h.db.run(`UPDATE split_attempts SET status = 'cancelled' WHERE id = ?`, t2.json.attemptId);
    h.db.run(`UPDATE launches SET split_state = 'pending'`);
    const alloc = h.db.get(`SELECT * FROM fee_allocations WHERE status = 'approved'`);
    h.db.run('UPDATE fee_allocations SET recipients_json = ? WHERE id = ?', JSON.stringify([{ label: 'x', wallet: owner.w.address, bps: 10000, role: 'submitter' }]), alloc.id);
    const refused = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
    assert.deepEqual([refused.status, refused.json.error], [409, 'split_mismatch']);
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM split_attempts WHERE status = 'awaiting_signature'`).n, 0);
  } finally { h.close(); }
});

test('two-step launch (MOCK): the on-chain recheck marks a split found with the right shares locked (idempotent), flags other shares loudly, reminds the author while nothing is signed', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    await step1(h, owner, slug);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    const pid = h.db.get('SELECT id FROM projects WHERE slug = ?', slug).id, mint = h.db.get('SELECT mint FROM launches').mint;
    // nothing on chain yet: a reminder (at most every 6 hours), the state stays pending
    const r1 = await recheckSplit(h.db, h.cfg, pid);
    assert.deepEqual([r1.state, r1.reminded], ['pending', true]);
    assert.match(ideaStatus(h.db, ideaId).status_note, /fee split NOT locked yet/);
    assert.equal((await recheckSplit(h.db, h.cfg, pid)).reminded, undefined);
    assert.equal(sweepSplits(h.db), 1, 'the worker queues an hourly recheck');
    // the split landed (e.g. a tx2 whose answer was lost): the recheck marks it locked, once
    const shares = [{ wallet: owner.w.address, bps: 8000 }, { wallet: SUB01_WALLET, bps: 2000 }];
    h.db.run(`INSERT INTO mock_chain (signature, mint, payload, status, visible_at) VALUES (?, ?, ?, 'ok', ?)`, 'MOCKsplitSig', mint, JSON.stringify({ mock: true, kind: 'split', mint, shareholders: shares }), Date.now() - 1);
    assert.equal((await recheckSplit(h.db, h.cfg, pid)).state, 'locked');
    assert.equal((await recheckSplit(h.db, h.cfg, pid)).skipped, true);
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM events WHERE kind = 'split_locked'`).n, 1);
    assert.equal(h.db.get('SELECT split_state FROM launches').split_state, 'locked');
    assert.equal(h.db.get(`SELECT status FROM fee_allocations WHERE project_id = ? ORDER BY version DESC`, pid).status, 'locked');
  } finally { h.close(); }
  const h2 = await harness();
  try {
    const { owner, slug } = await toLaunchPrepared(h2);
    await step1(h2, owner, slug);
    await later(5000, () => drain(h2.db, h2.cfg, h2.brain.fetchImpl));
    const pid = h2.db.get('SELECT id FROM projects WHERE slug = ?', slug).id, mint = h2.db.get('SELECT mint FROM launches').mint;
    // the author set their own split elsewhere (100% to themselves): flagged for an admin, never retried, never "locked"
    h2.db.run(`INSERT INTO mock_chain (signature, mint, payload, status, visible_at) VALUES (?, ?, ?, 'ok', ?)`, 'MOCKwrong', mint, JSON.stringify({ mock: true, kind: 'split', mint, shareholders: [{ wallet: owner.w.address, bps: 10000 }] }), Date.now() - 1);
    const r = await recheckSplit(h2.db, h2.cfg, pid);
    assert.equal(r.state, 'mismatch');
    const v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([v.split.state, v.split.locked, v.ledger.locked], ['mismatch', false, false]);
    assert.match(v.split.line, /not the approved one/);
    assert.equal(h2.db.get(`SELECT COUNT(*) n FROM events WHERE kind = 'split_mismatch'`).n, 1, 'an admin alert');
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {})).json.error, 'split_mismatch');
    assert.equal((await recheckSplit(h2.db, h2.cfg, pid)).skipped, true, 'never retried by itself');
    await drain(h2.db, h2.cfg, h2.brain.fetchImpl);
    const site = await getWithHost(h2.base, `${slug}.${h2.cfg.projectsHost}`, '/');
    assert.match(site.body, /NOT the approved one/);
  } finally { h2.close(); }
});

test('LAUNCH_SPLIT_TX=0 rolls back to the single creation transaction without a code change', async () => {
  const h = await harness({ LAUNCH_SPLIT_TX: '0' });
  try {
    const { owner, slug } = await toLaunchPrepared(h);
    const t1 = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(t1.json.splitTx, false);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: owner.w.signText(mockSigningText(t1.json.messageHash)) })).status, 200);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    const v = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([v.split, v.allocation.status, v.ledger.locked, h.db.get('SELECT split_tx FROM launch_intents').split_tx], [null, 'locked', true, 0]);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {})).json.error, 'no_split_step');
  } finally { h.close(); }
  assert.equal(splitText([{ role: 'submitter', bps: 6000 }, { role: 'parent', bps: 1000 }, { role: 'grandparent', bps: 1000 }, { role: 'sub01', bps: 2000 }]),
    '60% you / 10% the parent launchpad\'s author / 10% the grandparent launchpad\'s author / 20% SUB-01');
  assert.ok(getProvider);
});

// --- child launches from a coin site: the family split in tx2 -------------------------------------------------------------
const ENV = { TRUST_PROXY: '1', APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), REQUIRE_ADMIN_CLEARANCE: '0' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PADPAD = { title: 'PadPad', ticker: 'PADPAD', concept: 'PadPad ($PADPAD). A launchpad for launchpads. You don\'t launch a coin here, you launch a launchpad, and every launchpad born here can launch coins that can be launchpads too. Creator fees flow up the family tree, split and locked on-chain at launch: the creator, the parent launchpad, the grandparent, and SUB-01. The site shows the live family tree.' };
function hostCall(base, host, method, path, body, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ host: u.hostname, port: u.port, path, method, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* raw */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const siteOf = (h, slug, ip = '10.0.0.1') => { const host = `${slug}.${h.cfg.projectsHost}`, origin = `http://${host}`;
  return { slug, site: (method, path, body) => hostCall(h.base, host, method, path, body, { 'x-forwarded-for': ip, ...(method === 'POST' ? { origin } : {}) }) }; };
async function lockSplitCity(h, owner, slug) {
  const t2 = await owner.call('POST', `/api/projects/${slug}/launch/split/transaction`, {});
  assert.equal(t2.status, 200, t2.text);
  assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/split/signed`, { signed: owner.w.signText(t2.json.mockSigningText) })).status, 200);
  await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
}
async function root(h) {
  const owner = h.client(user(h.db)); await owner.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: PADPAD.title, nameSuggestion: PADPAD.title, tickerSuggestion: PADPAD.ticker, concept: PADPAD.concept, plotId: 'ginza-2' }));
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true })).status, 200);
  const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug, p = (await owner.call('GET', `/api/projects/${slug}`)).json;
  assert.equal((await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: p.allocation.id, statement: p.allocation.statement, siteVersion: p.liveSiteVersion })).status, 200);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  await step1(h, owner, slug);
  await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
  await lockSplitCity(h, owner, slug);
  return { owner, ...siteOf(h, slug) };
}
let N = 0;
async function childTwoStep(h, k, w) {
  const i = ++N, fields = { name: `Split Gen ${i}`, ticker: `SPLG${i}`, description: `Generation ${i} of the family, launched in two signatures and then a split lock.`, devBuySol: 0 };
  const q = await k.site('POST', '/_api/launch/quote', { wallet: w.address, ...fields, imageSha256: sha256(Buffer.from(PNG, 'base64')) });
  assert.equal(q.status, 200, q.text);
  const s = await k.site('POST', '/_api/launch/start', { wallet: w.address, nonce: q.json.nonce, signature: w.signText(q.json.message), ...fields, image: PNG });
  assert.equal(s.status, 200, s.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  const tx1 = await k.site('POST', `/_api/launch/${s.json.id}/tx`, { key: s.json.key });
  assert.equal(tx1.status, 200, tx1.text);
  assert.equal(tx1.json.splitTx, true);
  // the split is not reachable before tx1 lands
  assert.equal((await k.site('POST', `/_api/launch/${s.json.id}/split/tx`, { key: s.json.key })).json.error, 'not_launched');
  assert.equal((await k.site('POST', `/_api/launch/${s.json.id}/signed`, { key: s.json.key, signed: w.signText(tx1.json.mockSigningText) })).status, 200);
  await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
  const view = (await k.site('GET', `/_api/launch/${s.json.id}`)).json;
  assert.deepEqual([view.status, view.split.state], ['launched', 'pending']);
  const child = h.db.get('SELECT * FROM projects WHERE idea_id = ?', s.json.ideaId);
  assert.equal(h.db.get(`SELECT COUNT(*) n FROM events WHERE kind = 'child_launch' AND project_id = ? AND message LIKE '%was launched from this site%'`, child.parent_project_id).n, 0, 'not signed into the parent\'s registry before the lock');
  return { id: s.json.id, key: s.json.key, child, view, ...siteOf(h, child.slug) };
}

test('two-step child launches (MOCK): gen 1 and gen 2 family splits go into tx2 exactly, re-derived by the family rule; tampering refused; the parent hears it after the lock', async () => {
  const h = await harness(ENV);
  try {
    const r = await root(h);
    const a1 = h.client(user(h.db)).w, a2 = h.client(user(h.db)).w;
    const g1 = await childTwoStep(h, r, a1);
    const t2 = await r.site('POST', `/_api/launch/${g1.id}/split/tx`, { key: g1.key });
    assert.equal(t2.status, 200, t2.text);
    const rootAuthor = h.db.get(`SELECT owner_wallet FROM ideas WHERE id = (SELECT idea_id FROM projects WHERE slug = ?)`, r.slug).owner_wallet;
    const want1 = new Map([[a1.address, 7000], [rootAuthor, 1000], [SUB01_WALLET, 2000]]);
    assert.equal(t2.json.shareholders.length, 3);
    for (const x of t2.json.shareholders) assert.equal(want1.get(x.wallet), x.bps, x.wallet);
    assert.equal((await r.site('POST', `/_api/launch/${g1.id}/split/signed`, { key: g1.key, signed: a1.signText(t2.json.mockSigningText) })).status, 200);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal((await r.site('GET', `/_api/launch/${g1.id}`)).json.split.state, 'locked');
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM events WHERE kind = 'child_launch' AND project_id = ? AND message LIKE '%was launched from this site%'`, g1.child.parent_project_id).n, 1, 'the parent hears it once the split is locked');
    // gen 2, launched from gen 1's site: creator 60 / parent 10 / grandparent 10 / SUB-01 20
    const g2 = await childTwoStep(h, g1, a2);
    const s2 = await g1.site('POST', `/_api/launch/${g2.id}/split/tx`, { key: g2.key });
    assert.equal(s2.status, 200, s2.text);
    const want2 = new Map([[a2.address, 6000], [a1.address, 1000], [rootAuthor, 1000], [SUB01_WALLET, 2000]]);
    assert.equal(s2.json.shareholders.length, 4);
    for (const x of s2.json.shareholders) assert.equal(want2.get(x.wallet), x.bps, x.wallet);
    // the family rule is recomputed server side at signing: a signed launch record that no longer matches is refused
    const cl = h.db.get('SELECT * FROM child_launches WHERE idea_id = ?', g2.child.idea_id);
    const forged = JSON.parse(cl.recipients_json).map((x) => (x.role === 'submitter' ? { ...x, bps: x.bps + 1000 } : x.role === 'grandparent' ? { ...x, bps: x.bps - 1000 } : x));
    h.db.run('UPDATE child_launches SET recipients_json = ? WHERE id = ?', JSON.stringify(forged), cl.id);
    const refused = await g1.site('POST', `/_api/launch/${g2.id}/split/signed`, { key: g2.key, signed: a2.signText(s2.json.mockSigningText) });
    assert.deepEqual([refused.status, refused.json.error], [409, 'split_mismatch']);
    h.db.run('UPDATE child_launches SET recipients_json = ? WHERE id = ?', cl.recipients_json, cl.id);
    const ok = await g1.site('POST', `/_api/launch/${g2.id}/split/signed`, { key: g2.key, signed: a2.signText(s2.json.mockSigningText) });
    assert.equal(ok.status, 200, ok.text);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal((await g1.site('GET', `/_api/launch/${g2.id}`)).json.split.state, 'locked');
    // the wrong key cannot drive someone else's step 2
    assert.equal((await r.site('POST', `/_api/launch/${g1.id}/split/tx`, { key: 'nope' })).status, 403);
  } finally { h.close(); }
});
