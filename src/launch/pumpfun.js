// Pump.fun launch provider, built only on the official on-chain SDK (@pump-fun/pump-sdk 4.0.0) and Solana RPC.
// Verified against the official docs on 2026-10-09 (see docs/PUMPFUN.md):
//   - create_v2 makes a Token-2022 mint (6 decimals); signers: the mint keypair and the user (payer).
//   - fee sharing (pump-fees program): create_fee_sharing_config makes a per-mint sharing-config PDA the coin creator;
//     update_fee_shares_v2 sets up to 10 shareholders (total 10,000 bps) ONCE and revokes the admin: irreversible
//     (only pump.fun's own takeover authority can rewrite it).
//   - fee rates are dynamic: read from Global / FeeConfig at preparation time, never hardcoded.
//   - no official REST API for creation; no official metadata upload endpoint (metadata is served by this app).
//   - the dev buy (optional, launch.js initialBuyLamports): buy_v2 in the SAME transaction, after the fee split, quoted
//     by the SDK at a fresh curve (getBuyTokenAmountFromSolAmount), cost capped at quote + 5%; the author's wallet pays
//     and receives the tokens. It needs the buy's static accounts in the lookup table (scripts/lookup-table.js --extend).
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
const LAUNCH_DIRECT = new Set([PROGRAMS.pump, PROGRAMS.pumpFees, 'ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);
// The dev buy's cost cap: quote + 5% (500 bps). The curve is fresh at creation, so the SDK quote is what the program
// charges; the margin only covers rounding and a fee-schedule change between preparation and landing.
export const BUY_SLIPPAGE_PERCENT = 5;

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
 * -> { ixs, buy: null | { lamports, maxLamports, tokensBase, feeRecipient, buybackFeeRecipient, ata } }
 */
export async function launchInstructions({ config, mint, signer, global = null, feeConfig = null }) {
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
    if (!global) throw new Error('the dev buy needs the pump Global account');
    if (!Number.isInteger(lamports)) throw new Error('dev buy must be whole lamports');
    const quoteAmount = new Big(String(lamports));
    const tokens = pump.getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount, quoteMint: spl.NATIVE_MINT });
    if (tokens.isZero()) throw new Error('the dev buy is too small to buy any token');
    const ata = spl.getAssociatedTokenAddressSync(mint, signer, true, spl.TOKEN_2022_PROGRAM_ID);
    const creator = sharing ? pump.feeSharingConfigPda(mint) : signer;
    const feeRecipient = global.feeRecipient, buybackFeeRecipient = await buybackRecipient();
    // max cost = quote + slippage, as the SDK's buyV2Instruction computes it (percent, in tenths)
    const maxQuote = quoteAmount.add(quoteAmount.mul(new Big(Math.floor(BUY_SLIPPAGE_PERCENT * 10))).div(new Big(1000)));
    ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(signer, ata, signer, mint, spl.TOKEN_2022_PROGRAM_ID));
    ixs.push(await pump.PUMP_SDK.getBuyV2InstructionRaw({ user: signer, mint, creator, amount: tokens, quoteAmount: maxQuote, feeRecipient, buybackFeeRecipient,
      tokenProgram: spl.TOKEN_2022_PROGRAM_ID, quoteMint: spl.NATIVE_MINT, quoteTokenProgram: spl.TOKEN_PROGRAM_ID }));
    buy = { lamports, maxLamports: Number(maxQuote.toString()), tokensBase: tokens.toString(), feeRecipient: feeRecipient.toBase58(),
      buybackFeeRecipient: buybackFeeRecipient.toBase58(), ata: ata.toBase58() };
  }
  return { ixs, buy };
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

  /** The launch lookup table (static program accounts), so create + locked fee split fits in one transaction. */
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
     * config: {name, symbol, uri, signer, feeSharing: {mode, shareholders:[{wallet,bps}]}}
     */
    async prepare(config) {
      const signer = new web3.PublicKey(config.signer);
      const mintKp = web3.Keypair.generate();
      const mint = mintKp.publicKey;
      // no compute-budget instruction: the default (200k CU per instruction) covers create_v2 + fee sharing (+ buy_v2)
      const { ixs, buy } = await buildInstructions(config, mint, signer);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const message = new web3.TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: ixs })
        .compileToV0Message(await lookupTables());
      const tx = new web3.VersionedTransaction(message);
      tx.sign([mintKp]);                                    // the mint key signs now and is never stored
      const bytes = tx.serialize();
      if (bytes.length > MAX_TX_BYTES) {
        const hint = !cfg.launch.lookupTable ? ': fee sharing needs LAUNCH_LOOKUP_TABLE (npm run lookup-table)'
          : buy ? ': the dev buy needs the buy accounts in LAUNCH_LOOKUP_TABLE (npm run lookup-table -- --extend <table>)' : '';
        throw new Error(`transaction too large (${bytes.length} bytes)${hint}`);
      }
      const msgBytes = message.serialize();
      // initialBuyLamports: the buy's quoted cost, fees included (what the simulation's balance change contains);
      // initialBuyMaxLamports: the cap signed in the transaction (quote + slippage); accountsLamports excludes the buy
      const estimate = { networkFeeLamports: null, accountsLamports: null, simulation: null,
        initialBuyLamports: buy ? buy.lamports : 0, initialBuyMaxLamports: buy ? buy.maxLamports : 0, initialBuyTokensBase: buy ? buy.tokensBase : null };
      try { estimate.networkFeeLamports = (await conn.getFeeForMessage(message, 'confirmed')).value; } catch { /* left null */ }
      try {
        const pre = await conn.getBalance(signer, 'confirmed');
        const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true,
          accounts: { addresses: [signer.toBase58()], encoding: 'base64' } });
        if (sim.value.err) estimate.simulation = { ok: false, err: JSON.stringify(sim.value.err), logs: (sim.value.logs || []).slice(-6) };
        else {
          const post = sim.value.accounts?.[0]?.lamports;
          estimate.simulation = { ok: true, unitsConsumed: sim.value.unitsConsumed };
          if (post != null) estimate.accountsLamports = Math.max(0, pre - post - (buy ? buy.lamports : 0));
        }
        estimate.signerBalanceLamports = pre;
      } catch (e) {
        estimate.simulation = { ok: false, err: e.message };
      }
      return { txBase64: Buffer.from(bytes).toString('base64'), messageHash: createHash('sha256').update(msgBytes).digest('hex'),
        lastValidBlockHeight, mint: mint.toBase58(), estimate, txBytes: bytes.length };
    },

    reviewOf(txBase64) { return reviewOfMessage(web3.VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64')).message); },

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
    verifySigned(intent, signedBase64) {
      const { web3 } = sdk();
      const tx = web3.VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64'));
      const msgBytes = tx.message.serialize();
      const hash = createHash('sha256').update(msgBytes).digest('hex');
      if (hash !== intent.tx_message_hash) throw new Error('signed transaction differs from the reviewed one');
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      if (keys[0] !== intent.signer_wallet) throw new Error('payer is not the expected wallet');
      const sig = tx.signatures[0];
      if (!sig || sig.every((b) => b === 0)) throw new Error('missing wallet signature');
      if (!verifyWalletSignature(intent.signer_wallet, msgBytes, sig)) throw new Error('wallet signature does not verify');
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
      if ((Number(config.initialBuyLamports) || 0) > 0) {
        // the dev buy landed in the same transaction: the author's Token-2022 account holds tokens
        const { spl } = sdk();
        const ata = spl.getAssociatedTokenAddressSync(new web3.PublicKey(intent.mint), new web3.PublicKey(intent.signer_wallet), true, spl.TOKEN_2022_PROGRAM_ID);
        let amount = null;
        try { amount = (await conn.getTokenAccountBalance(ata, 'finalized')).value.amount; } catch { /* checked below */ }
        add('dev buy landed: tokens in the author wallet', amount != null && BigInt(amount) > 0n, amount == null ? `${ata.toBase58()} not visible` : `${amount} base units`);
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

