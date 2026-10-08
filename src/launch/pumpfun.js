// Pump.fun launch provider, built only on the official on-chain SDK (@pump-fun/pump-sdk 4.0.0) and Solana RPC.
// Verified against the official docs on 2026-10-09 (see docs/PUMPFUN.md):
//   - create_v2 makes a Token-2022 mint (6 decimals); signers: the mint keypair and the user (payer).
//   - fee sharing (pump-fees program): create_fee_sharing_config makes a per-mint sharing-config PDA the coin creator;
//     update_fee_shares_v2 sets up to 10 shareholders (total 10,000 bps) ONCE and revokes the admin: irreversible
//     (only pump.fun's own takeover authority can rewrite it).
//   - fee rates are dynamic: read from Global / FeeConfig at preparation time, never hardcoded.
//   - no official REST API for creation; no official metadata upload endpoint (metadata is served by this app).
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

  async function buildInstructions(config, mint, signer) {
    const { spl, pump } = sdk();
    const ixs = [];
    ixs.push(await pump.PUMP_SDK.createV2Instruction({ mint, name: config.name, symbol: config.symbol, uri: config.uri,
      creator: signer, user: signer, mayhemMode: false }));
    if (config.feeSharing.mode === 'sharing_config') {
      ixs.push(await pump.PUMP_SDK.createFeeSharingConfig({ creator: signer, mint, pool: null }));
      ixs.push(await pump.PUMP_SDK.updateFeeSharesV2({ authority: signer, mint, currentShareholders: [signer],
        newShareholders: config.feeSharing.shareholders.map((s) => ({ address: new web3.PublicKey(s.wallet), shareBps: s.bps })),
        quoteMint: spl.NATIVE_MINT, quoteTokenProgram: spl.TOKEN_PROGRAM_ID, bondingCurveComplete: false }));
    }
    return ixs;
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
      // no compute-budget instruction: the default (200k CU per instruction) covers create_v2 + fee sharing
      const ixs = await buildInstructions(config, mint, signer);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const message = new web3.TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: ixs })
        .compileToV0Message(await lookupTables());
      const tx = new web3.VersionedTransaction(message);
      tx.sign([mintKp]);                                    // the mint key signs now and is never stored
      const bytes = tx.serialize();
      if (bytes.length > MAX_TX_BYTES) {
        throw new Error(`transaction too large (${bytes.length} bytes)${cfg.launch.lookupTable ? '' : ': fee sharing needs LAUNCH_LOOKUP_TABLE (npm run lookup-table)'}`);
      }
      const msgBytes = message.serialize();
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
          if (post != null) estimate.accountsLamports = pre - post;
        }
        estimate.signerBalanceLamports = pre;
      } catch (e) {
        estimate.simulation = { ok: false, err: e.message };
      }
      return { txBase64: Buffer.from(bytes).toString('base64'), messageHash: createHash('sha256').update(msgBytes).digest('hex'),
        lastValidBlockHeight, mint: mint.toBase58(), estimate, txBytes: bytes.length };
    },

    /** The wallet's signed bytes must be exactly the reviewed message, signed by the expected signer. */
    /** Accounts every launch uses (same for any mint and signer): the lookup table's contents. */
    async staticAccounts() {
      const keysOf = async () => {
        const a = web3.Keypair.generate().publicKey, b = web3.Keypair.generate().publicKey, m = web3.Keypair.generate().publicKey;
        const ixs = await buildInstructions({ name: 'x', symbol: 'X', uri: 'https://x', feeSharing: { mode: 'sharing_config',
          shareholders: [{ wallet: a.toBase58(), bps: 5000 }, { wallet: b.toBase58(), bps: 5000 }] } }, m, a);
        return new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()));
      };
      const [x, y] = [await keysOf(), await keysOf()];
      return [...x].filter((k) => y.has(k)).sort();
    },

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

    async submit(_intent, raw) {
      return conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 });
    },

    /** -> {state: 'pending'|'confirmed'|'finalized'|'failed'|'expired', ...} */
    async status(intent) {
      const st = (await conn.getSignatureStatuses([intent.tx_signature], { searchTransactionHistory: true })).value[0];
      if (st) {
        if (st.err) return { state: 'failed', err: JSON.stringify(st.err), slot: st.slot };
        return { state: st.confirmationStatus === 'finalized' ? 'finalized' : 'confirmed', slot: st.slot };
      }
      const height = await conn.getBlockHeight('confirmed');
      if (height > intent.last_valid_block_height) return { state: 'expired', height };
      return { state: 'pending', height, lastValid: intent.last_valid_block_height };
    },

    /** On-chain checks that make a project "launched". Every check is recorded. */
    async verifyLaunch(intent, config) {
      const { web3, pump } = sdk();
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
      const tx = await conn.getTransaction(intent.tx_signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
      add('transaction found at finalized commitment', tx, intent.tx_signature);
      if (!tx) return { ok: false, checks };
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
      if (config.feeSharing.mode === 'sharing_config') {
        const pda = pump.feeSharingConfigPda(new web3.PublicKey(intent.mint));
        add('curve creator is the sharing config', curve && curve.creator.toBase58() === pda.toBase58(), curve?.creator?.toBase58());
        const acc = await conn.getAccountInfo(pda, 'finalized');
        let sc = null;
        try { sc = acc && pump.PUMP_SDK.decodeSharingConfig(acc); } catch { /* checked below */ }
        add('sharing config exists', sc, pda.toBase58());
        if (sc) {
          const got = sc.shareholders.map((s) => `${s.address.toBase58()}:${s.shareBps}`).sort().join(',');
          const want = config.feeSharing.shareholders.map((s) => `${s.wallet}:${s.bps}`).sort().join(',');
          add('shareholders match the approved allocation', got === want, got);
          add('sharing admin revoked (allocation locked)', sc.adminRevoked === true, String(sc.adminRevoked));
        }
      } else {
        add('curve creator is the approved recipient', curve && curve.creator.toBase58() === config.feeSharing.shareholders[0].wallet, curve?.creator?.toBase58());
      }
      return { ok: checks.every((c) => c.ok), checks, slot: tx.slot, blockTime: tx.blockTime };
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
          const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
          for (const line of tx?.meta?.logMessages || []) {
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

