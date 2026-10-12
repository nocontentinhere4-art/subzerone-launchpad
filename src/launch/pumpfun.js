// Pump.fun launch provider, built only on the official on-chain SDK (@pump-fun/pump-sdk 4.0.0) and Solana RPC.
// Verified against the official docs on 2026-10-09 (see docs/PUMPFUN.md):
//   - create_v2 makes a Token-2022 mint (6 decimals); signers: the mint keypair and the user (payer).
//   - fee sharing (pump-fees program): create_fee_sharing_config makes a per-mint sharing-config PDA the coin creator;
//     update_fee_shares_v2 sets up to 10 shareholders (total 10,000 bps) ONCE and revokes the admin: irreversible
//     (only pump.fun's own takeover authority can rewrite it).
//   - fee rates are dynamic: read from Global / FeeConfig at preparation time, never hardcoded.
//   - no official REST API for creation; no official metadata upload endpoint (metadata is served by this app).
//   - the dev buy (optional, launch.js initialBuyLamports): ATA + buy_v2 (exact-out: `amount` tokens, `max_sol_cost`
//     cap, partial_fill off), cost capped at quote + 5%; the author's wallet pays and receives the tokens. In the
//     Phantom-safe layout create + split + buy is 1242-1259 bytes, over 1232: the buy is then a SECOND transaction
//     (devBuyInstructions / prepareDevBuy), quoted on the curve tx1 created, signed by the author alone. It stays
//     inside tx1 only when that still fits Phantom-safe (launch.js devBuyMode 'same_tx'); never the compact layout.
// The submitter's own wallet is the payer and creator and signs; this app never holds a key that can move funds.
// The mint keypair is generated per launch intent, signs once during preparation and is then discarded.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { b58encode, verifyWalletSignature } from '../util.js';

const require = createRequire(import.meta.url);
let _sdk = null;
function sdk() {
  if (!_sdk) {
    const web3 = require('@solana/web3.js');
    const spl = require('@solana/spl-token');
    const pump = require('@pump-fun/pump-sdk');
    _sdk = { web3, spl, pump };
  }
  return _sdk;
}

const MAX_TX_BYTES = 1232;
// Phantom appends its own instructions when it signs (Lighthouse balance assertions, a compute-budget priority fee:
// see verifySigned), which needs room in the packet. A dev buy stays inside the creation transaction only if that
// transaction leaves this much; create + split + buy measures 1231-1259 bytes Phantom-safe, so in practice the buy is
// always its own transaction (tx1 975-997 bytes, tx2 about 1033: both leave ~200 bytes).
export const WALLET_HEADROOM_BYTES = 150;
const ONE_TX_BUY_LIMIT = MAX_TX_BYTES - WALLET_HEADROOM_BYTES;
export const PROGRAMS = {
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  pumpSwap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
};

// Programs a reviewer may see in a launch transaction, by id. Anything else is shown as 'unknown program'.
export const KNOWN_PROGRAMS = Object.freeze({
  [PROGRAMS.pump]: 'pump.fun (bonding curve)', [PROGRAMS.pumpFees]: 'pump.fun fee sharing', [PROGRAMS.pumpSwap]: 'PumpSwap (AMM)',
  '11111111111111111111111111111111': 'System Program', ComputeBudget111111111111111111111111111111: 'Compute Budget',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022', TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account', metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex Token Metadata',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
});
// the only programs a launch transaction may call directly for the "what this does NOT do" line to hold: pump, pump-fees,
// compute budget, and the Associated Token Account program (the dev buy creates the author's own token account)
// Programs a wallet may add when it signs (Phantom: Lighthouse balance assertions, compute-budget priority fee).
// pump-fees update_fee_shares_v2 (IDL discriminator): the instruction that writes the locked split. Its data is the
// discriminator then a Borsh vec<Shareholder {address: pubkey, share_bps: u16}>; the program takes at most 10 shareholders
// (SDK MAX_SHAREHOLDERS = 10, pump-fees error 6011 TooManyShareholders), each > 0 bps (6017), 10,000 in total (6014).
const UPDATE_FEE_SHARES_V2 = Buffer.from([111, 251, 49, 6, 78, 78, 106, 18]);
export const MAX_SHAREHOLDERS = 10;
/** The shareholders an update_fee_shares_v2 instruction's data writes, [{wallet, bps}], or null for another instruction. */
export function decodeFeeShares(data) {
  const b = Buffer.from(data);
  if (b.length < 12 || !b.subarray(0, 8).equals(UPDATE_FEE_SHARES_V2)) return null;
  const n = b.readUInt32LE(8);
  if (n < 1 || n > MAX_SHAREHOLDERS || b.length !== 12 + n * 34) throw new Error('malformed fee-shares instruction');
  return Array.from({ length: n }, (_, i) => ({ wallet: b58encode(b.subarray(12 + i * 34, 44 + i * 34)), bps: b.readUInt16LE(44 + i * 34) }));
}
/** Throws unless the signed message writes exactly the configured split (sharing_config) or no split at all (direct). */
export function checkSignedShares(message, config) {
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const found = message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === PROGRAMS.pumpFees).map((ix) => decodeFeeShares(ix.data)).filter(Boolean);
  const sharing = config?.feeSharing?.mode === 'sharing_config';
  if (!sharing) { if (found.length) throw new Error('the signed transaction writes a fee split the approved configuration does not have'); return null; }
  const want = (config.feeSharing.shareholders || []).map((x) => `${x.wallet}:${x.bps}`).sort().join(',');
  if (found.length !== 1) throw new Error(`the signed transaction writes ${found.length} fee splits, not the approved one`);
  const got = found[0].map((x) => `${x.wallet}:${x.bps}`).sort().join(',');
  if (got !== want) throw new Error('the fee shareholders in the signed transaction differ from the approved split');
  return found[0];
}
const WALLET_GUARDS = new Set(['ComputeBudget111111111111111111111111111111', 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']);
const LAUNCH_DIRECT = new Set([PROGRAMS.pump, PROGRAMS.pumpFees, 'ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);
// The dev buy's cost cap: quote + 5% (500 bps). The curve is fresh at creation, so the SDK quote is what the program
// charges; the margin only covers rounding and a fee-schedule change between preparation and landing.
export const BUY_SLIPPAGE_PERCENT = 5;
/** A transaction that cannot be built as asked; `code` is the API error (409) and the message is for the author. */
export class LaunchBuildError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const TOO_LARGE_NOTE = 'the creation transaction with the dev buy inside would not leave the wallet room under the 1232-byte network limit in the layout wallets can simulate; prepare the launch again (the dev buy then becomes a second signature)';

/**
 * The dev buy's fee recipients, pinned so the launch lookup table can hold them: the SDK otherwise picks one of
 * eight at random per build. fee_recipient = the primary one on Global; buyback_fee_recipient = the lowest-sorted of
 * the SDK's candidates (read from built instructions by the IDL account name, never hardcoded here).
 */
let _buyback = null;
/** The log lines of a finalized transaction. Our own launches are v0, but other transactions touching the same fee
 *  account (pump.fun's distributions, 2026-10-10 on mainnet) can use a newer version the web3.js client refuses to
 *  decode; the raw RPC answer still carries the logs, which is all the fee reader needs. */
async function logsOf(conn, signature) {
  try {
    const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
    return tx?.meta?.logMessages || [];
  } catch (e) {
    if (!/maxSupportedTransactionVersion/.test(String(e?.message))) throw e;
    const res = await conn._rpcRequest('getTransaction', [signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
    return res?.result?.meta?.logMessages || [];
  }
}

async function buybackRecipient() {
  if (_buyback) return _buyback;
  const { web3, spl, pump } = sdk();
  const names = pump.pumpIdl.instructions.find((i) => i.name === 'buy_v2').accounts.map((a) => a.name);
  const at = names.indexOf('buyback_fee_recipient');
  if (at < 0) throw new Error('pump IDL: buy_v2 has no buyback_fee_recipient account');
  const user = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
  const Big = require('bn.js');
  const seen = new Set();
  for (let i = 0; i < 128; i++) {
    const ix = await pump.PUMP_SDK.getBuyV2InstructionRaw({ user, mint, creator: user, amount: new Big(1), quoteAmount: new Big(1),
      feeRecipient: user, tokenProgram: spl.TOKEN_2022_PROGRAM_ID, quoteMint: spl.NATIVE_MINT, quoteTokenProgram: spl.TOKEN_PROGRAM_ID });
    seen.add(ix.keys[at].pubkey.toBase58());
  }
  _buyback = new web3.PublicKey([...seen].sort()[0]);
  return _buyback;
}

/**
 * The instructions of one launch, offline: create_v2, the locked fee split (sharing_config mode), and the dev buy
 * (ATA + buy_v2) when initialBuyLamports > 0. The buy comes AFTER the fee split, with the curve creator the split
 * already made (the sharing-config PDA), so the buy's own creator fee goes to the project's shared vault like every
 * other trade's. global/feeConfig: the decoded pump Global and pump-fees FeeConfig (needed for the buy only).
 * probe: a size-only build without the chain (1 token, dummy fee recipient): same bytes, never sent.
 * -> { ixs, buy: null | { lamports (real cost, fees included), requestedLamports, maxLamports, tokensBase, feeRecipient,
 *      buybackFeeRecipient, ata } }
 */
export async function launchInstructions({ config, mint, signer, global = null, feeConfig = null, probe = false }) {
  const { web3, spl, pump } = sdk();
  const Big = require('bn.js');
  const ixs = [];
  ixs.push(await pump.PUMP_SDK.createV2Instruction({ mint, name: config.name, symbol: config.symbol, uri: config.uri,
    creator: signer, user: signer, mayhemMode: false }));
  const sharing = config.feeSharing.mode === 'sharing_config';
  if (sharing) {
    ixs.push(await pump.PUMP_SDK.createFeeSharingConfig({ creator: signer, mint, pool: null }));
    ixs.push(await pump.PUMP_SDK.updateFeeSharesV2({ authority: signer, mint, currentShareholders: [signer],
      newShareholders: config.feeSharing.shareholders.map((s) => ({ address: new web3.PublicKey(s.wallet), shareBps: s.bps })),
      quoteMint: spl.NATIVE_MINT, quoteTokenProgram: spl.TOKEN_PROGRAM_ID, bondingCurveComplete: false }));
  }
  const lamports = Number(config.initialBuyLamports) || 0;
  let buy = null;
  if (lamports > 0) {
    if (!global && !probe) throw new Error('the dev buy needs the pump Global account');
    if (!Number.isInteger(lamports)) throw new Error('dev buy must be whole lamports');
    const requested = new Big(String(lamports));
    let tokens = new Big(1), cost = requested;
    if (!probe) {
      // the SDK clamps the quote to the curve's real reserves: a buy that would take them all completes the curve
      // (pump.fun then migrates it); such a buy is refused instead of silently buying less
      tokens = pump.getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: requested, quoteMint: spl.NATIVE_MINT });
      if (tokens.isZero()) throw new LaunchBuildError('buy_too_small', 'the dev buy is too small to buy any token');
      const fresh = pump.newBondingCurve(global, spl.NATIVE_MINT);
      if (tokens.gte(fresh.realTokenReserves)) throw new LaunchBuildError('buy_completes_curve', 'the dev buy would buy the whole bonding curve and complete it; choose a smaller amount');
      // what those tokens really cost, fees included (the quote rounds): this is the amount shown and reserved
      cost = pump.getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: tokens, quoteMint: spl.NATIVE_MINT });
      if (cost.isZero()) cost = requested;
    }
    const ata = spl.getAssociatedTokenAddressSync(mint, signer, true, spl.TOKEN_2022_PROGRAM_ID);
    const creator = sharing ? pump.feeSharingConfigPda(mint) : signer;
    const feeRecipient = probe ? signer : global.feeRecipient, buybackFeeRecipient = await buybackRecipient();
    // max cost = real cost + slippage, as the SDK's buyV2Instruction computes it (percent, in tenths)
    const maxQuote = cost.add(cost.mul(new Big(Math.floor(BUY_SLIPPAGE_PERCENT * 10))).div(new Big(1000)));
    ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(signer, ata, signer, mint, spl.TOKEN_2022_PROGRAM_ID));
    ixs.push(await pump.PUMP_SDK.getBuyV2InstructionRaw({ user: signer, mint, creator, amount: tokens, quoteAmount: maxQuote, feeRecipient, buybackFeeRecipient,
      tokenProgram: spl.TOKEN_2022_PROGRAM_ID, quoteMint: spl.NATIVE_MINT, quoteTokenProgram: spl.TOKEN_PROGRAM_ID }));
    buy = { lamports: Number(cost.toString()), requestedLamports: lamports, maxLamports: Number(maxQuote.toString()), tokensBase: tokens.toString(),
      feeRecipient: feeRecipient.toBase58(), buybackFeeRecipient: buybackFeeRecipient.toBase58(), ata: ata.toBase58() };
  }
  return { ixs, buy };
}

/**
 * The size of a launch transaction, offline (no RPC, nothing signed): built twice with random keys, the accounts
 * common to both are what the lookup table holds, the rest stay static. Exact for a table that holds every static
 * account (npm run lookup-table). -> { bytes: number|null (null: beyond what a message can hold), fits }
 * config: { name, symbol, uri, feeSharing: {mode, shareholders}, initialBuyLamports }
 */
// Phantom's simulator cannot predict a pump.fun launch whose program event authorities sit in an address lookup table
// and shows "This dApp could be malicious" (koynlabs/labs-mcp#14, 2026-10; our launches were flagged the same way). The
// event authorities of pump and pump fees are therefore always written into the transaction itself (+31 bytes each):
// the table keeps its positions, those entries are just never used.
export function eventAuthorities() {
  const { web3 } = sdk();
  return [PROGRAMS.pump, PROGRAMS.pumpFees].map((p) => web3.PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new web3.PublicKey(p))[0]);
}
export function phantomSafeTables(tables) {
  const { web3 } = sdk();
  const hide = new Set(eventAuthorities().map((k) => k.toBase58()));
  return tables.map((t) => new web3.AddressLookupTableAccount({ key: t.key, state: { ...t.state,
    addresses: t.state.addresses.map((a) => (hide.has(a.toBase58()) ? web3.Keypair.generate().publicKey : a)) } }));
}

/** -> { bytes, fits, phantomSafe }. With a dev buy only the Phantom-safe layout counts (fits: false = the buy must be a
 *  second transaction); without one the compact layout remains the fallback for large splits. */
export async function compiledTxBytes(config) {
  const { web3 } = sdk();
  const build = async () => {
    const signer = web3.Keypair.generate().publicKey, mint = web3.Keypair.generate().publicKey;
    const { ixs } = await launchInstructions({ config, mint, signer, probe: true });
    return { signer, ixs, keys: new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58())) };
  };
  const [a, b] = [await build(), await build()];
  const statics = [...a.keys].filter((k) => b.keys.has(k)).map((k) => new web3.PublicKey(k));
  const table = new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey,
    state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: statics } });
  const message = new web3.TransactionMessage({ payerKey: a.signer, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: a.ixs })
    .compileToV0Message(phantomSafeTables([table]));
  const compact = new web3.TransactionMessage({ payerKey: a.signer, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: a.ixs })
    .compileToV0Message([table]);
  try {
    const safe = (() => { try { return new web3.VersionedTransaction(message).serialize().length; } catch { return null; } })();
    if ((Number(config.initialBuyLamports) || 0) > 0) {
      const ok = safe != null && safe <= ONE_TX_BUY_LIMIT;
      return { bytes: safe, fits: ok, phantomSafe: ok };
    }
    if (safe != null && safe <= MAX_TX_BYTES) return { bytes: safe, fits: true, phantomSafe: true };
    const bytes = new web3.VersionedTransaction(compact).serialize().length;
    return { bytes, fits: bytes <= MAX_TX_BYTES, phantomSafe: false };
  } catch (e) {
    if (/overruns/.test(e.message)) return { bytes: null, fits: false };
    throw e;
  }
}

/**
 * Review-before-sign, from the compiled message itself: the programs it calls (direct), known programs it passes to
 * them as accounts (called inside them, direct: false), how many accounts it can write and how many signers it needs.
 * Program ids are always static keys in a v0 message; lookup-table accounts are counted, not named.
 */
export function reviewOfMessage(message) {
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const direct = [...new Set(message.compiledInstructions.map((ix) => keys[ix.programIdIndex]))];
  const passed = keys.filter((k) => KNOWN_PROGRAMS[k] && !direct.includes(k));
  const h = message.header;
  const writable = (h.numRequiredSignatures - h.numReadonlySignedAccounts) + (keys.length - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts)
    + (message.addressTableLookups || []).reduce((n, l) => n + l.writableIndexes.length, 0);
  return {
    programs: [...direct.map((id) => ({ id, name: KNOWN_PROGRAMS[id] || 'unknown program', direct: true })),
      ...passed.map((id) => ({ id, name: KNOWN_PROGRAMS[id], direct: false }))],
    accountsWritable: writable, signers: h.numRequiredSignatures, launchProgramsOnly: direct.every((id) => LAUNCH_DIRECT.has(id)),
  };
}

/**
 * The dev buy as its own transaction (tx2), offline: the author's Token-2022 ATA (idempotent) and buy_v2 on the curve
 * tx1 created. Quoted on that curve as it is NOW (a sniper may have bought first): `amount` = tokens for the requested
 * SOL, cap = their real cost + 5%. reuse ({tokensBase, costLamports, maxLamports}): the same buy again with a new
 * blockhash (the review stays true; a price past the cap then fails the simulation instead of buying less).
 * curve: the decoded BondingCurve (OnlinePumpSdk.fetchBondingCurve); its creator is what buy_v2 must name (the
 * sharing-config PDA for our launches).
 */
export async function devBuyInstructions({ mint, signer, lamports, global, feeConfig, curve, reuse = null }) {
  const { spl, pump } = sdk();
  const Big = require('bn.js');
  if (!curve) throw new LaunchBuildError('no_curve', 'the coin\'s bonding curve is not visible on the network yet; try again in a few seconds');
  if (curve.complete) throw new LaunchBuildError('curve_complete', 'the bonding curve is already complete (the coin left pump.fun\'s curve); the dev buy cannot run');
  if (curve.isMayhemMode) throw new LaunchBuildError('curve_mayhem', 'this coin\'s curve is in mayhem mode; the dev buy is not supported there');
  if (!Number.isInteger(lamports) || lamports <= 0) throw new Error('dev buy must be whole lamports');
  let tokens, cost, maxQuote;
  if (reuse) {
    tokens = new Big(String(reuse.tokensBase)); cost = new Big(String(reuse.costLamports)); maxQuote = new Big(String(reuse.maxLamports));
  } else {
    const requested = new Big(String(lamports));
    const at = { global, feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, quoteMint: spl.NATIVE_MINT };
    tokens = pump.getBuyTokenAmountFromSolAmount({ ...at, amount: requested });
    if (tokens.isZero()) throw new LaunchBuildError('buy_too_small', 'the dev buy is too small to buy any token');
    if (tokens.gte(curve.realTokenReserves)) throw new LaunchBuildError('buy_completes_curve', 'the dev buy would buy the rest of the bonding curve and complete it; skip it or launch again with a smaller amount');
    cost = pump.getBuySolAmountFromTokenAmount({ ...at, amount: tokens });
    if (cost.isZero()) cost = requested;
    maxQuote = cost.add(cost.mul(new Big(Math.floor(BUY_SLIPPAGE_PERCENT * 10))).div(new Big(1000)));
  }
  const ata = spl.getAssociatedTokenAddressSync(mint, signer, true, spl.TOKEN_2022_PROGRAM_ID);
  const feeRecipient = global.feeRecipient, buybackFeeRecipient = await buybackRecipient();
  const ixs = [spl.createAssociatedTokenAccountIdempotentInstruction(signer, ata, signer, mint, spl.TOKEN_2022_PROGRAM_ID),
    await pump.PUMP_SDK.getBuyV2InstructionRaw({ user: signer, mint, creator: curve.creator, amount: tokens, quoteAmount: maxQuote, feeRecipient, buybackFeeRecipient,
      tokenProgram: spl.TOKEN_2022_PROGRAM_ID, quoteMint: spl.NATIVE_MINT, quoteTokenProgram: spl.TOKEN_PROGRAM_ID })];
  return { ixs, buy: { lamports: Number(cost.toString()), requestedLamports: lamports, maxLamports: Number(maxQuote.toString()), tokensBase: tokens.toString(),
    ata: ata.toBase58(), creator: curve.creator.toBase58(), feeRecipient: feeRecipient.toBase58(), buybackFeeRecipient: buybackFeeRecipient.toBase58() } };
}

/** Token balance change of `owner`'s account for `mint` in a fetched transaction (meta pre/post token balances). */
function tokenDelta(meta, mint, owner) {
  const pick = (list) => (list || []).find((b) => b.mint === mint && b.owner === owner);
  const pre = pick(meta?.preTokenBalances), post = pick(meta?.postTokenBalances);
  if (!post) return null;
  return { accountIndex: post.accountIndex, delta: BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount?.amount ?? '0') };
}

const bnToStr = (x) => (x == null ? null : x.toString());

export function makePumpfunProvider(cfg, { connection } = {}) {
  const { web3 } = sdk();
  const conn = connection || new web3.Connection(cfg.launch.rpcUrl, 'confirmed');
  const network = cfg.launch.network;

  /** Read live parameters: supply, decimals, current fee schedule for a fresh curve. */
  async function chainParams() {
    const { pump } = sdk();
    const online = new pump.OnlinePumpSdk(conn);
    const global = await online.fetchGlobal();
    let fees = null;
    try {
      const feeConfig = await online.fetchFeeConfig();
      const f = pump.computeFeesBps({ global, feeConfig, mintSupply: global.tokenTotalSupply,
        virtualQuoteReserves: global.initialVirtualQuoteReserves ?? global.initialVirtualSolReserves,
        virtualTokenReserves: global.initialVirtualTokenReserves });
      fees = { protocolFeeBps: Number(bnToStr(f.protocolFeeBps)), creatorFeeBps: Number(bnToStr(f.creatorFeeBps)),
        source: 'pump-fees FeeConfig + pump Global (on-chain), at a fresh curve; tiers change with market cap' };
    } catch (e) {
      fees = { error: `fee schedule not readable: ${e.message}` };
    }
    return { totalSupplyBase: bnToStr(global.tokenTotalSupply), decimals: 6, tokenProgram: 'Token-2022', fees };
  }

  /** The signed message differs from the reviewed one: it must be the same launch (or the same dev buy) with wallet
   *  guards added. The reviewed message is decompiled with the tables it names (none for tx2). */
  async function sameLaunch(web3, intent, tx) {
    const reviewed = web3.VersionedTransaction.deserialize(Buffer.from(intent.tx_base64, 'base64')).message;
    const signed = tx.message;
    const tables = reviewed.addressTableLookups?.length ? await lookupTables() : [];
    let a, b;
    try {
      a = web3.TransactionMessage.decompile(reviewed, { addressLookupTableAccounts: tables });
      b = web3.TransactionMessage.decompile(signed, { addressLookupTableAccounts: signed.addressTableLookups?.length ? await tablesFor(signed) : [] });
    } catch { throw new Error('signed transaction differs from the reviewed one'); }
    if (b.payerKey.toBase58() !== a.payerKey.toBase58()) throw new Error('signed transaction differs from the reviewed one (payer)');
    if (b.recentBlockhash !== a.recentBlockhash) throw new Error('signed transaction differs from the reviewed one (blockhash)');
    const key = (ix) => JSON.stringify([ix.programId.toBase58(), Buffer.from(ix.data).toString('base64'), ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])]);
    const ours = a.instructions.map(key);
    let i = 0;
    for (const ix of b.instructions) {
      if (i < ours.length && key(ix) === ours[i]) { i++; continue; }
      if (!WALLET_GUARDS.has(ix.programId.toBase58())) throw new Error(`signed transaction differs from the reviewed one (an instruction for ${ix.programId.toBase58()} was added)`);
      // a guard may read accounts, never sign for anyone but the payer
      if (ix.keys.some((k) => k.isSigner && !k.pubkey.equals(a.payerKey))) throw new Error('signed transaction differs from the reviewed one (an added instruction asks for another signer)');
    }
    if (i !== ours.length) throw new Error('signed transaction differs from the reviewed one (instructions missing or changed)');
  }
  async function tablesFor(message) {
    const out = [];
    for (const l of message.addressTableLookups) {
      const r = await conn.getAddressLookupTable(l.accountKey);
      if (!r.value) throw new Error('lookup table not found');
      out.push(r.value);
    }
    return out;
  }

  async function lookupTables() {
    if (!cfg.launch.lookupTable) return [];
    const r = await conn.getAddressLookupTable(new web3.PublicKey(cfg.launch.lookupTable));
    if (!r.value) throw new Error('LAUNCH_LOOKUP_TABLE not found on this network');
    return [r.value];
  }

  /** Global + FeeConfig as the buy needs them (FeeConfig may be unreadable: the SDK then quotes from Global alone). */
  async function chainAccounts() {
    const { pump } = sdk();
    const online = new pump.OnlinePumpSdk(conn);
    const global = await online.fetchGlobal();
    let feeConfig = null;
    try { feeConfig = await online.fetchFeeConfig(); } catch { /* quoted from Global's flat rate */ }
    return { global, feeConfig };
  }

  async function buildInstructions(config, mint, signer) {
    const chain = (Number(config.initialBuyLamports) || 0) > 0 ? await chainAccounts() : {};
    return launchInstructions({ config, mint, signer, ...chain });
  }

  /** Fee, simulation and balance change of a built transaction for the review. buyLamports: the buy's real cost inside
   *  it (0 for none); accountsLamports is then the rent alone (balance change - buy - fee). */
  async function estimateOf(tx, message, signer, buyLamports) {
    const estimate = { networkFeeLamports: null, accountsLamports: null, simulation: null };
    try { estimate.networkFeeLamports = (await conn.getFeeForMessage(message, 'confirmed')).value; } catch { /* left null */ }
    try {
      const pre = await conn.getBalance(signer, 'confirmed');
      const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true,
        accounts: { addresses: [signer.toBase58()], encoding: 'base64' } });
      if (sim.value.err) estimate.simulation = { ok: false, err: JSON.stringify(sim.value.err), logs: (sim.value.logs || []).slice(-6) };
      else {
        const post = sim.value.accounts?.[0]?.lamports;
        estimate.simulation = { ok: true, unitsConsumed: sim.value.unitsConsumed };
        if (post != null) estimate.accountsLamports = Math.max(0, pre - post - buyLamports - (estimate.networkFeeLamports ?? 0));
      }
      estimate.signerBalanceLamports = pre;
    } catch (e) {
      estimate.simulation = { ok: false, err: e.message };
    }
    return estimate;
  }

  return {
    name: 'pumpfun',
    network,
    label: `pump.fun on Solana ${network}`,
    isMock: false,

    async describe() {
      return { feeSharing: true, feeSharingLocked: true, maxShareholders: 10, programs: PROGRAMS };
    },

    chainParams,

    /**
     * Build the creation transaction for review. -> {txBase64, messageHash, lastValidBlockHeight, mint, estimate}
     * config: {name, symbol, uri, signer, feeSharing: {mode, shareholders:[{wallet,bps}]}, initialBuyLamports}
     * devBuyMode (with a buy): 'same_tx' = the buy inside, Phantom-safe or a coded tx_too_large; 'second_tx' = tx1
     * WITHOUT the buy, and estimate.devBuy carries the fresh-curve quote of the buy that follows (what step 2 costs
     * if nobody buys first). Without a buy the compact layout stays the fallback for large splits.
     */
    async prepare(config, { mintSecret = null, devBuyMode = 'same_tx' } = {}) {
      const signer = new web3.PublicKey(config.signer);
      // refresh (same intent, fresh blockhash right before the wallet opens): the intent's own mint key, not a new one
      const mintKp = mintSecret ? web3.Keypair.fromSecretKey(Buffer.from(mintSecret, 'base64')) : web3.Keypair.generate();
      const mint = mintKp.publicKey;
      const wantsBuy = (Number(config.initialBuyLamports) || 0) > 0;
      // no compute-budget instruction: the default (200k CU per instruction) covers create_v2 + fee sharing (+ buy_v2)
      let { ixs, buy } = await buildInstructions(config, mint, signer);
      let devBuy = null;
      if (wantsBuy && devBuyMode === 'second_tx') {
        devBuy = { mode: 'second_tx', requestedLamports: buy.requestedLamports, lamports: buy.lamports, maxLamports: buy.maxLamports, tokensBase: buy.tokensBase, quotedAt: 'fresh curve' };
        ({ ixs } = await launchInstructions({ config: { ...config, initialBuyLamports: 0 }, mint, signer }));
        buy = null;
      }
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const tables = await lookupTables();
      const compile = (t) => new web3.TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(t);
      const fitsBytes = (m, limit = MAX_TX_BYTES) => { try { return new web3.VersionedTransaction(m).serialize().length <= limit; } catch { return false; } };
      // the Phantom-safe layout (event authorities written in) always with a buy; without one it is the default and the
      // compact layout only the fallback for a split too large for it
      let message = compile(phantomSafeTables(tables)), phantomSafe = true;
      if (buy && !fitsBytes(message, ONE_TX_BUY_LIMIT)) {
        if (!cfg.launch.lookupTable) throw new Error('transaction too large: fee sharing needs LAUNCH_LOOKUP_TABLE (npm run lookup-table)');
        throw new LaunchBuildError('tx_too_large', TOO_LARGE_NOTE);
      }
      if (!fitsBytes(message)) { message = compile(tables); phantomSafe = false; }
      const tx = new web3.VersionedTransaction(message);
      // Signing order (Phantom support, 2026-10-11): the wallet signs the untouched transaction FIRST; the mint key signs
      // afterwards, server-side, in verifySigned. Phantom's Lighthouse flags transactions that arrive with another
      // signer already on them. So the bytes shown for review carry an empty mint slot; the secret travels back to the
      // caller once, is stored encrypted on the intent, and is wiped after the broadcast.
      let bytes = null;                                   // web3 refuses to encode far beyond the packet size
      try { bytes = tx.serialize(); } catch (e) { if (!/overruns/.test(e.message)) throw e; }
      if (!bytes || bytes.length > MAX_TX_BYTES) {
        const size = bytes ? `${bytes.length} bytes` : 'over 1232 bytes';
        // an operator problem (no table, or a table missing accounts) is a plain error
        if (!cfg.launch.lookupTable) throw new Error(`transaction too large (${size}): fee sharing needs LAUNCH_LOOKUP_TABLE (npm run lookup-table)`);
        throw new LaunchBuildError('tx_too_large', `transaction too large (${size}): the lookup table may be missing accounts (npm run lookup-table -- --extend <table>)`);
      }
      const msgBytes = message.serialize();
      // initialBuyLamports: the buy's real cost, fees included (what the simulation's balance change contains);
      // initialBuyMaxLamports: the cap signed in the transaction (cost + slippage); accountsLamports is the rent alone:
      // the simulation's balance change minus the buy and minus the network fee it charged
      const estimate = { phantomSafe, devBuyMode: wantsBuy ? devBuyMode : null,
        initialBuyLamports: buy ? buy.lamports : 0, initialBuyRequestedLamports: buy ? buy.requestedLamports : 0,
        initialBuyMaxLamports: buy ? buy.maxLamports : 0, initialBuyTokensBase: buy ? buy.tokensBase : null,
        ...(devBuy ? { devBuy } : {}), ...(await estimateOf(tx, message, signer, buy ? buy.lamports : 0)) };
      return { txBase64: Buffer.from(bytes).toString('base64'), messageHash: createHash('sha256').update(msgBytes).digest('hex'),
        lastValidBlockHeight, mint: mint.toBase58(), estimate, txBytes: bytes.length,
        mintSecret: Buffer.from(mintKp.secretKey).toString('base64') };
    },

    /** Would create + split + buy fit ONE Phantom-safe transaction? (offline; compiledTxBytes) */
    async devBuyFitsOneTx(config) { const s = await compiledTxBytes(config); return s.fits === true && s.phantomSafe === true; },

    /**
     * Step 2 of a launch with a dev buy: tx2 = the author's ATA + buy_v2, quoted on the live curve, the author the only
     * signer. No lookup table at all: every account (the pump event authority among them) is a static key, so a
     * wallet's simulator has nothing to resolve (1033 bytes measured). -> the shape of prepare() without a mint key.
     * {mint, signer, lamports}; reuse: see devBuyInstructions.
     */
    async prepareDevBuy({ mint, signer, lamports }, { reuse = null } = {}) {
      const { pump } = sdk();
      const signerKey = new web3.PublicKey(signer), mintKey = new web3.PublicKey(mint);
      const { global, feeConfig } = await chainAccounts();
      let curve = null;
      try { curve = await new pump.OnlinePumpSdk(conn).fetchBondingCurve(mintKey); } catch { /* refused below */ }
      const { ixs, buy } = await devBuyInstructions({ mint: mintKey, signer: signerKey, lamports, global, feeConfig, curve, reuse });
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const message = new web3.TransactionMessage({ payerKey: signerKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
      const tx = new web3.VersionedTransaction(message);
      const bytes = tx.serialize();
      if (bytes.length > MAX_TX_BYTES) throw new LaunchBuildError('tx_too_large', `the dev buy transaction is ${bytes.length} bytes, over the 1232-byte limit`);
      const estimate = { phantomSafe: true, devBuyMode: 'second_tx', initialBuyLamports: buy.lamports, initialBuyRequestedLamports: buy.requestedLamports,
        initialBuyMaxLamports: buy.maxLamports, initialBuyTokensBase: buy.tokensBase, quotedAt: reuse ? 'the reviewed quote, fresh blockhash' : 'the live curve',
        ...(await estimateOf(tx, message, signerKey, buy.lamports)) };
      return { txBase64: Buffer.from(bytes).toString('base64'), messageHash: createHash('sha256').update(message.serialize()).digest('hex'),
        lastValidBlockHeight, mint, estimate, txBytes: bytes.length, buy };
    },

    /** tx2 signed by the wallet: the reviewed dev buy (Phantom's guards tolerated as in verifySigned), one signer. */
    async verifyDevBuySigned(attempt, signedBase64) {
      const tx = web3.VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64'));
      const msgBytes = tx.message.serialize();
      if (createHash('sha256').update(msgBytes).digest('hex') !== attempt.tx_message_hash) await sameLaunch(web3, attempt, tx);
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      if (keys[0] !== attempt.signer_wallet) throw new Error('payer is not the expected wallet');
      if (tx.message.header.numRequiredSignatures !== 1) throw new Error('the dev buy is signed by your wallet alone; this transaction asks for another signer');
      const sig = tx.signatures[0];
      if (!sig || sig.every((b) => b === 0)) throw new Error('missing wallet signature');
      if (!verifyWalletSignature(attempt.signer_wallet, msgBytes, sig)) throw new Error('wallet signature does not verify');
      return { signature: b58encode(sig), raw: Buffer.from(tx.serialize()) };
    },

    /** tx2's fate by its signature: no mint to look for, so "expired" = the finalized height is past its window. */
    async devBuyStatus(attempt) {
      const st = (await conn.getSignatureStatuses([attempt.tx_signature], { searchTransactionHistory: true })).value[0];
      if (st) {
        if (st.err) return { state: 'failed', err: JSON.stringify(st.err), slot: st.slot };
        return { state: st.confirmationStatus === 'finalized' ? 'finalized' : 'confirmed', slot: st.slot };
      }
      const height = await conn.getBlockHeight('finalized');
      if (height <= attempt.last_valid_block_height) return { state: 'pending', height, lastValid: attempt.last_valid_block_height };
      return { state: 'expired', height };
    },

    /** An abandoned tx2 attempt (cancelled, expired): could a signed copy still land, or did one? A landed one is a
     *  finalized, successful transaction paid by the author that put exactly the attempt's tokens in the author's
     *  account (buy_v2 is exact-out; every blockhash refresh of an attempt keeps the same amount). */
    async devBuyLandCheck(attempt) {
      const height = await conn.getBlockHeight('finalized');
      if (height <= attempt.last_valid_block_height) return { state: 'open', blocksLeft: attempt.last_valid_block_height - height };
      const { spl } = sdk();
      const ata = spl.getAssociatedTokenAddressSync(new web3.PublicKey(attempt.mint), new web3.PublicKey(attempt.signer_wallet), true, spl.TOKEN_2022_PROGRAM_ID);
      const sigs = await conn.getSignaturesForAddress(ata, { limit: 25 }, 'finalized');
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
        if (!tx || tx.meta?.err !== null) continue;
        const payer = tx.transaction.message.staticAccountKeys[0].toBase58();
        const d = tokenDelta(tx.meta, attempt.mint, attempt.signer_wallet);
        if (payer === attempt.signer_wallet && d && attempt.tokens_base && d.delta === BigInt(attempt.tokens_base)) return { state: 'landed', signature: s.signature };
      }
      return { state: 'dead' };
    },

    /** On-chain checks of a finalized tx2. The author's account must gain EXACTLY the reviewed tokens (exact-out), and
     *  the SOL the buy took must be within the signed cap: the author's balance change minus the network fee and minus
     *  what funded accounts this transaction created (the author's token account; on devnet 2026-10-12 also the
     *  project's creator vault, 679,870 lamports on its first trade). A lower bound when the vault is new (its share of
     *  the creator fee is counted as funding); the program itself enforces max_sol_cost exactly. */
    async verifyDevBuy(attempt) {
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
      const tx = await conn.getTransaction(attempt.tx_signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
      add('transaction found at finalized commitment', tx, attempt.tx_signature);
      if (!tx) return { ok: false, retry: true, checks };
      add('transaction succeeded', tx.meta && tx.meta.err === null, JSON.stringify(tx.meta?.err ?? null));
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat().map((k) => k.toBase58());
      add('payer is the author', keys[0] === attempt.signer_wallet, keys[0]);
      add('pump program invoked', keys.includes(PROGRAMS.pump), PROGRAMS.pump);
      add('mint account in transaction', keys.includes(attempt.mint), attempt.mint);
      const d = tokenDelta(tx.meta, attempt.mint, attempt.signer_wallet);
      add('dev buy landed: exactly the reviewed amount of tokens in the author wallet', d && attempt.tokens_base && d.delta === BigInt(attempt.tokens_base),
        d ? `${d.delta} base units (reviewed ${attempt.tokens_base})` : 'no token balance of the author for this mint');
      if (d && tx.meta) {
        const spent = tx.meta.preBalances[0] - tx.meta.postBalances[0];
        const created = keys.map((k, i) => ({ k, i })).filter(({ i }) => i > 0 && tx.meta.preBalances[i] === 0 && tx.meta.postBalances[i] > 0);
        const funded = created.reduce((s, { i }) => s + tx.meta.postBalances[i], 0);
        const buyCost = spent - tx.meta.fee - funded;
        add('SOL the buy took is within the signed cap', attempt.max_lamports != null && buyCost <= attempt.max_lamports,
          `${buyCost} lamports (cap ${attempt.max_lamports}; network fee ${tx.meta.fee}; new accounts funded ${funded}: ${created.map(({ k, i }) => `${k.slice(0, 6)}… ${tx.meta.postBalances[i]}`).join(', ') || 'none'})`);
      }
      return { ok: checks.every((c) => c.ok), retry: false, checks, slot: tx.slot, blockTime: tx.blockTime, tokensBase: d ? String(d.delta) : null };
    },

    reviewOf(txBase64) { return reviewOfMessage(web3.VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64')).message); },

    /** The size a launch would have, offline (see compiledTxBytes): the dev buy is refused before it is stored. */
    txBytes: compiledTxBytes,

    /** The wallet's SOL balance in lamports (confirmed). */
    async balance(wallet) { return conn.getBalance(new web3.PublicKey(wallet), 'confirmed'); },

    /** Accounts every launch uses (same for any mint and signer), the dev buy's included: the lookup table's contents. */
    async staticAccounts() {
      const chain = await chainAccounts();
      const keysOf = async () => {
        const a = web3.Keypair.generate().publicKey, b = web3.Keypair.generate().publicKey, m = web3.Keypair.generate().publicKey;
        const { ixs } = await launchInstructions({ config: { name: 'x', symbol: 'X', uri: 'https://x', initialBuyLamports: 10_000_000,
          feeSharing: { mode: 'sharing_config', shareholders: [{ wallet: a.toBase58(), bps: 5000 }, { wallet: b.toBase58(), bps: 5000 }] } }, mint: m, signer: a, ...chain });
        return new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()));
      };
      const [x, y] = [await keysOf(), await keysOf()];
      return [...x].filter((k) => y.has(k)).sort();
    },

    /** The wallet's signed bytes must be exactly the reviewed message, signed by the expected signer. */
    /** The wallet signed: check it is the reviewed transaction, then add the mint key's signature (second, as Phantom
     *  asks) from the secret the intent kept (mintSecret, base64). -> {signature, raw} ready to broadcast.
     *  Phantom may ADD its own instructions when it signs (Lighthouse balance guards, a compute-budget priority fee):
     *  then the bytes differ from the review. Accepted only when the payer, the blockhash and every one of our
     *  instructions are unchanged and in order, and each extra instruction belongs to those two programs. */
    async verifySigned(intent, signedBase64, { mintSecret = null } = {}) {
      const { web3 } = sdk();
      const tx = web3.VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64'));
      const msgBytes = tx.message.serialize();
      const hash = createHash('sha256').update(msgBytes).digest('hex');
      if (hash !== intent.tx_message_hash) await sameLaunch(web3, intent, tx);
      // the exact shares: the split instruction in the bytes the wallet signed is the approved one (a family coin's
      // creator / parent / grandparent / SUB-01 rows, recomputed server-side in launch.js submitSigned before this)
      if (intent.config_json) checkSignedShares(tx.message, JSON.parse(intent.config_json));
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      if (keys[0] !== intent.signer_wallet) throw new Error('payer is not the expected wallet');
      const sig = tx.signatures[0];
      if (!sig || sig.every((b) => b === 0)) throw new Error('missing wallet signature');
      if (!verifyWalletSignature(intent.signer_wallet, msgBytes, sig)) throw new Error('wallet signature does not verify');
      const mintIndex = keys.indexOf(intent.mint);
      if (mintIndex < 0 || mintIndex >= tx.message.header.numRequiredSignatures) throw new Error('the mint is not a signer of this transaction');
      const mintSig = tx.signatures[mintIndex];
      if (!mintSig || mintSig.every((b) => b === 0)) {
        if (!mintSecret) throw new Error('the mint key is gone; prepare the transaction again');
        const mintKp = web3.Keypair.fromSecretKey(Buffer.from(mintSecret, 'base64'));
        if (mintKp.publicKey.toBase58() !== intent.mint) throw new Error('the stored mint key does not match the transaction');
        tx.sign([mintKp]);                                 // sets only the mint's slot; the wallet's signature stays as it came
      }
      if (!verifyWalletSignature(intent.mint, msgBytes, tx.signatures[mintIndex])) throw new Error('mint signature does not verify');
      return { signature: b58encode(sig), raw: Buffer.from(tx.serialize()) };
    },

    /**
     * Broadcast. Only a failed preflight simulation is a definite rejection (the RPC does not forward the transaction
     * then): that error gets `rejected = true`. Anything else (timeout, 429, 5xx) may have reached the network, so the
     * caller must keep the intent and let the confirmation job decide.
     */
    async submit(_intent, raw) {
      try {
        return await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 });
      } catch (e) {
        const logs = e?.logs || e?.transactionLogs;
        if (e?.name === 'SendTransactionError' && (logs || /simulation failed/i.test(e.message))) {
          const err = new Error(String(e.message).split('\n')[0].slice(0, 200));
          err.rejected = true;
          throw err;
        }
        throw e;
      }
    },

    /** -> {state: 'pending'|'confirmed'|'finalized'|'failed'|'expired', ...} */
    async status(intent) {
      const st = (await conn.getSignatureStatuses([intent.tx_signature], { searchTransactionHistory: true })).value[0];
      if (st) {
        if (st.err) return { state: 'failed', err: JSON.stringify(st.err), slot: st.slot };
        return { state: st.confirmationStatus === 'finalized' ? 'finalized' : 'confirmed', slot: st.slot };
      }
      // expired only on strong evidence: the FINALIZED height is past the blockhash window and the mint does not exist
      const height = await conn.getBlockHeight('finalized');
      if (height <= intent.last_valid_block_height) return { state: 'pending', height, lastValid: intent.last_valid_block_height };
      const mint = await conn.getAccountInfo(new web3.PublicKey(intent.mint), 'confirmed');
      if (mint) return { state: 'pending', height, note: 'the mint exists; waiting for the indexer to show the signature' };
      return { state: 'expired', height };
    },

    /**
     * For an intent we stopped tracking (cancelled, expired, failed): could its transaction still land, or did it?
     * -> {state: 'open'} (blockhash still valid) | {state: 'landed', signature} | {state: 'dead'}
     */
    async landCheck(intent) {
      const height = await conn.getBlockHeight('finalized');
      if (height <= intent.last_valid_block_height) return { state: 'open', blocksLeft: intent.last_valid_block_height - height };
      const mintKey = new web3.PublicKey(intent.mint);
      if (!(await conn.getAccountInfo(mintKey, 'confirmed'))) return { state: 'dead' };
      const sigs = await conn.getSignaturesForAddress(mintKey, { limit: 20 }, 'confirmed');
      const first = sigs.filter((x) => !x.err).sort((a, b) => a.slot - b.slot)[0];
      return { state: 'landed', signature: first?.signature ?? intent.tx_signature };
    },

    /** On-chain checks that make a project "launched". Every check is recorded. */
    async verifyLaunch(intent, config) {
      const { web3, pump } = sdk();
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
      const tx = await conn.getTransaction(intent.tx_signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
      add('transaction found at finalized commitment', tx, intent.tx_signature);
      if (!tx) return { ok: false, retry: true, checks };          // an RPC node behind: look again later
      add('transaction succeeded', tx.meta && tx.meta.err === null, JSON.stringify(tx.meta?.err ?? null));
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
        .keySegments().flat().map((k) => k.toBase58());
      add('payer is the approved signer', keys[0] === intent.signer_wallet, keys[0]);
      add('pump program invoked', keys.includes(PROGRAMS.pump), PROGRAMS.pump);
      add('mint account in transaction', keys.includes(intent.mint), intent.mint);
      const mintInfo = await conn.getParsedAccountInfo(new web3.PublicKey(intent.mint), 'finalized');
      const parsed = mintInfo.value?.data?.parsed?.info;
      add('mint exists (Token-2022)', mintInfo.value && mintInfo.value.owner.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', mintInfo.value?.owner?.toBase58());
      add('mint authority is none', parsed && parsed.mintAuthority == null, parsed?.mintAuthority ?? null);
      add('freeze authority is none', parsed && parsed.freezeAuthority == null, parsed?.freezeAuthority ?? null);
      add('decimals', parsed && parsed.decimals === 6, parsed?.decimals);
      const online = new pump.OnlinePumpSdk(conn);
      let curve = null;
      try { curve = await online.fetchBondingCurve(intent.mint); } catch { /* checked below */ }
      add('bonding curve exists', curve, curve ? 'ok' : 'missing');
      let missing = !mintInfo.value || !curve;
      if (config.feeSharing.mode === 'sharing_config') {
        const pda = pump.feeSharingConfigPda(new web3.PublicKey(intent.mint));
        add('curve creator is the sharing config', curve && curve.creator.toBase58() === pda.toBase58(), curve?.creator?.toBase58());
        const acc = await conn.getAccountInfo(pda, 'finalized');
        let sc = null;
        try { sc = acc && pump.PUMP_SDK.decodeSharingConfig(acc); } catch { /* checked below */ }
        add('sharing config exists', sc, pda.toBase58());
        if (!acc) missing = true;
        if (sc) {
          const got = sc.shareholders.map((s) => `${s.address.toBase58()}:${s.shareBps}`).sort().join(',');
          const want = config.feeSharing.shareholders.map((s) => `${s.wallet}:${s.bps}`).sort().join(',');
          add('shareholders match the approved allocation', got === want, got);
          add('sharing admin revoked (allocation locked)', sc.adminRevoked === true, String(sc.adminRevoked));
        }
      } else {
        add('curve creator is the approved recipient', curve && curve.creator.toBase58() === config.feeSharing.shareholders[0].wallet, curve?.creator?.toBase58());
      }
      // the dev buy inside tx1 (same_tx, or an intent from before the two-step launch); a second_tx buy is verified
      // on its own (verifyDevBuy) and never holds up "launched"
      if ((Number(config.initialBuyLamports) || 0) > 0 && intent.dev_buy_mode !== 'second_tx') {
        // the dev buy landed in the same transaction: the author's Token-2022 account holds tokens
        const { spl } = sdk();
        const ata = spl.getAssociatedTokenAddressSync(new web3.PublicKey(intent.mint), new web3.PublicKey(intent.signer_wallet), true, spl.TOKEN_2022_PROGRAM_ID);
        let amount = null;
        try { amount = (await conn.getTokenAccountBalance(ata, 'finalized')).value.amount; } catch { /* checked below */ }
        // buy_v2 is exact-out: the account holds exactly the tokens the reviewed transaction asked for
        const want = intent.buy_tokens_base ? String(intent.buy_tokens_base) : null;
        add(want ? 'dev buy landed: exactly the reviewed amount of tokens in the author wallet' : 'dev buy landed: tokens in the author wallet',
          amount != null && (want ? amount === want : BigInt(amount) > 0n), amount == null ? `${ata.toBase58()} not visible` : `${amount} base units${want ? ` (reviewed ${want})` : ''}`);
        if (amount == null) missing = true;
      }
      const ok = checks.every((c) => c.ok);
      // a missing account on a successful finalized transaction means a lagging node, not a mismatch: retry
      return { ok, retry: !ok && missing && tx.meta?.err === null, checks, slot: tx.slot, blockTime: tx.blockTime };
    },

    /**
     * Fee observations from the chain. Only facts read now, each with the account or transaction it came from.
     * sharing_config: per-mint vault (this project only). direct: the creator's vault (ALL coins of that wallet).
     */
    async readFees(launch, config) {
      const { web3, pump } = sdk();
      const mint = new web3.PublicKey(launch.mint);
      const sharing = config.feeSharing.mode === 'sharing_config';
      const owner = sharing ? pump.feeSharingConfigPda(mint) : new web3.PublicKey(config.feeSharing.shareholders[0].wallet);
      const vault = pump.creatorVaultPda(owner);
      const slot = await conn.getSlot('confirmed');
      const [bal, rent] = await Promise.all([conn.getBalance(vault, 'confirmed'), conn.getMinimumBalanceForRentExemption(0)]);
      const out = [{ kind: 'vault_balance', account: vault.toBase58(), lamports: Math.max(0, bal - (bal > 0 ? rent : 0)), slot,
        scope: sharing ? 'project' : 'creator wallet (all its coins)' }];
      let curve = null;
      try { curve = await new pump.OnlinePumpSdk(conn).fetchBondingCurve(mint); } catch { /* none */ }
      if (curve?.creatorFee && Number(curve.creatorFee.toString()) > 0) {
        out.push({ kind: 'vault_balance', account: pump.bondingCurvePda(mint).toBase58(), lamports: Number(curve.creatorFee.toString()),
          slot, scope: 'unswept creator fee on the curve' });
      }
      if (sharing) {
        const sigs = await conn.getSignaturesForAddress(owner, { limit: 25 }, 'finalized');
        for (const s of sigs) {
          if (s.err) continue;
          for (const line of await logsOf(conn, s.signature)) {
            if (!line.startsWith('Program data: ')) continue;
            const data = Buffer.from(line.slice(14), 'base64');
            let ev = null;
            for (const d of [data, data.subarray(8)]) {
              try { ev = pump.PUMP_SDK.decodeDistributeCreatorFeesEvent(d); if (ev?.mint?.toBase58() === launch.mint) break; ev = null; } catch { ev = null; }
            }
            if (!ev) continue;
            const total = BigInt(ev.distributed.toString());
            for (const sh of ev.shareholders) {
              out.push({ kind: 'distribution', recipient: sh.address.toBase58(), lamports: Number((total * BigInt(sh.shareBps)) / 10000n),
                txSignature: s.signature, slot: s.slot, blockTime: s.blockTime, note: 'distributed amount × share (bps)' });
            }
          }
        }
      }
      return out;
    },

    explorerTx: (sig) => `https://solscan.io/tx/${sig}${network === 'devnet' ? '?cluster=devnet' : ''}`,
    explorerToken: (mint) => `https://solscan.io/token/${mint}${network === 'devnet' ? '?cluster=devnet' : ''}`,
  };
}

