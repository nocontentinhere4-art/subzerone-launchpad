// MOCK launch provider: a stand-in for a blockchain, for tests and local demos. Nothing here touches any network.
// Everything it produces is labelled "mock"; mock launches never appear as on-chain anywhere, and the provider is
// refused in production (config.js). The "transaction" is a JSON document the wallet signs as a plain message.
// Failure injection (settings key 'mock.behaviour'): ok | reject_on_chain | never_lands | late | slow_index |
// preflight_reject | timeout_but_lands. It applies to the dev buy's own transaction (tx2) as well.
// The dev buy is a second transaction like on pump.fun (setting 'mock.devbuy_one_tx' = true keeps it inside the
// creation, the single-transaction path). The two-step launch (prepare with splitTx, prepareSplit …) is mirrored:
// tx1 records no split, tx2 is a labelled 'split' document; setting 'mock.split_buy_separate' = true makes the dev buy
// not fit tx2 (it then becomes its own transaction, as on pump.fun with a large family split).
import { createHash, randomBytes } from 'node:crypto';
import { b58encode, b58decode, verifyWalletSignature, now } from '../util.js';
import { getSetting } from '../db.js';

const SLOT_MS = 400;
const height = (t = now()) => Math.floor(t / SLOT_MS);
const VALID_BLOCKS = 150;                 // like a Solana blockhash: ~60 s

export function mockSigningText(messageHash) {
  return `MOCK LAUNCH: not a blockchain transaction, nothing is created or paid.\nSigning approves the reviewed mock launch ${messageHash}`;
}

export function makeMockProvider(db) {
  const behaviour = () => getSetting(db, 'mock.behaviour', 'ok');
  return {
    name: 'mock',
    network: 'mock',
    label: 'MOCK provider (no blockchain)',
    isMock: true,

    async describe() { return { feeSharing: true, feeSharingLocked: true, maxShareholders: 8 }; },

    async chainParams() {
      return { totalSupplyBase: '1000000000000000', decimals: 6, tokenProgram: 'mock',
        fees: { protocolFeeBps: null, creatorFeeBps: null, source: 'mock provider: no fee schedule (not a real chain)' } };
    },

    async prepare(config, { devBuyMode = 'same_tx', splitTx = false } = {}) {
      const mint = `MOCK${b58encode(randomBytes(28))}`.slice(0, 44);
      const wanted = Number(config.initialBuyLamports) || 0, second = wanted > 0 && (devBuyMode === 'second_tx' || splitTx);
      const initialBuyLamports = second ? 0 : wanted;
      // the dev buy is recorded in the mock document (nothing is bought: no chain); the estimate reports it like pump.fun's.
      // A two-step tx1 carries no split at all (feeSharing null): the split is the 'split' document of tx2.
      const doc = { mock: true, provider: 'mock', mint, config: { ...config, initialBuyLamports, ...(splitTx ? { feeSharing: null } : {}) }, ...(splitTx ? { splitTx: true } : {}), nonce: randomBytes(8).toString('hex') };
      const json = JSON.stringify(doc);
      return { txBase64: Buffer.from(json).toString('base64'), messageHash: createHash('sha256').update(json).digest('hex'),
        lastValidBlockHeight: height() + VALID_BLOCKS, mint, txBytes: json.length,
        estimate: { networkFeeLamports: 0, accountsLamports: 0, initialBuyLamports, initialBuyMaxLamports: initialBuyLamports, devBuyMode: wanted > 0 ? (splitTx ? 'second_tx' : devBuyMode) : null, splitTx: Boolean(splitTx),
          ...(second ? { devBuy: { mode: 'second_tx', requestedLamports: wanted, lamports: wanted, maxLamports: Math.floor(wanted * 1.05), tokensBase: null, quotedAt: 'mock' } } : {}),
          simulation: { ok: true, mock: true } } };
    },

    async devBuyFitsOneTx() { return getSetting(db, 'mock.devbuy_one_tx', false) === true; },

    /** The mock tx2: a labelled document, signed as a text message like the mock launch. Nothing is bought. */
    async prepareDevBuy({ mint, signer, lamports }, { reuse = null } = {}) {
      const tokensBase = reuse?.tokensBase ?? String(lamports * 1000), max = reuse?.maxLamports ?? Math.floor(lamports * 1.05);
      const json = JSON.stringify({ mock: true, provider: 'mock', kind: 'dev_buy', mint, signer, lamports, tokensBase, nonce: randomBytes(8).toString('hex') });
      return { txBase64: Buffer.from(json).toString('base64'), messageHash: createHash('sha256').update(json).digest('hex'),
        lastValidBlockHeight: height() + VALID_BLOCKS, mint, txBytes: json.length,
        buy: { lamports, requestedLamports: lamports, maxLamports: max, tokensBase },
        estimate: { networkFeeLamports: 0, accountsLamports: 0, initialBuyLamports: lamports, initialBuyRequestedLamports: lamports, initialBuyMaxLamports: max,
          initialBuyTokensBase: tokensBase, devBuyMode: 'second_tx', simulation: { ok: true, mock: true } } };
    },

    /** The mock tx2 of a two-step launch: the exact shares (+ the buy unless 'mock.split_buy_separate'). */
    async prepareSplit({ config, mint, signer, lamports = 0, withBuy = true }, { reuse = null } = {}) {
      if (config?.feeSharing?.mode !== 'sharing_config') throw new Error('step 2 locks a fee split; this launch has none');
      const wantBuy = Boolean(withBuy) && Number(lamports) > 0, deferred = wantBuy && getSetting(db, 'mock.split_buy_separate', false) === true;
      const buy = wantBuy && !deferred ? { lamports, requestedLamports: lamports, maxLamports: reuse?.maxLamports ?? Math.floor(lamports * 1.05), tokensBase: reuse?.tokensBase ?? String(lamports * 1000) } : null;
      const shareholders = config.feeSharing.shareholders.map(({ wallet, bps }) => ({ wallet, bps }));
      const json = JSON.stringify({ mock: true, provider: 'mock', kind: 'split', mint, signer, shareholders, withBuy: Boolean(buy), ...(buy ? { lamports, tokensBase: buy.tokensBase } : {}), nonce: randomBytes(8).toString('hex') });
      return { txBase64: Buffer.from(json).toString('base64'), messageHash: createHash('sha256').update(json).digest('hex'),
        lastValidBlockHeight: height() + VALID_BLOCKS, mint, txBytes: json.length, buy, withBuy: Boolean(buy), buyDeferred: deferred ? { bytes: null } : null,
        estimate: { kind: 'split', networkFeeLamports: 0, accountsLamports: 0, withBuy: Boolean(buy), buyDeferred: deferred ? { bytes: null } : null, shareholders,
          initialBuyLamports: buy ? lamports : 0, initialBuyRequestedLamports: buy ? lamports : 0, initialBuyMaxLamports: buy ? buy.maxLamports : 0,
          initialBuyTokensBase: buy ? buy.tokensBase : null, simulation: { ok: true, mock: true } } };
    },
    /** tx2 signed (a labelled text message, as the mock launch): the document must write exactly the approved shares. */
    verifySplitSigned(attempt, signedBase58, config) {
      const out = this.verifySigned({ ...attempt, config_json: null }, signedBase58);
      let doc = null; try { doc = JSON.parse(Buffer.from(attempt.tx_base64, 'base64').toString('utf8')); } catch { /* checked below */ }
      const ks = (rows) => (rows || []).map((x) => `${x.wallet}:${x.bps}`).sort().join(',');
      if (doc?.kind !== 'split' || doc.mint !== attempt.mint) throw new Error('the signed transaction is not the fee split that was reviewed');
      if (ks(doc.shareholders) !== ks(config?.feeSharing?.shareholders)) throw new Error('the fee shareholders in the signed transaction differ from the approved split');
      return out;
    },
    splitStatus(attempt) { return this.status(attempt); },
    async splitLandCheck(attempt) {
      const row = attempt.tx_signature ? db.get(`SELECT * FROM mock_chain WHERE signature = ? AND status = 'ok'`, attempt.tx_signature) : null;
      return row ? { state: 'landed', signature: row.signature } : { state: 'dead' };
    },
    /** The mock chain's sharing config for a mint: the first successful, visible 'split' document. */
    async splitOnChain(mint, config) {
      const want = (config?.feeSharing?.shareholders || []).map((x) => `${x.wallet}:${x.bps}`).sort().join(',');
      const rows = db.all(`SELECT * FROM mock_chain WHERE mint = ? AND status = 'ok' AND visible_at <= ? AND payload LIKE '%"kind":"split"%' ORDER BY visible_at`, mint, now());
      if (!rows.length) return { state: 'absent', want, got: null, adminRevoked: null, pda: `MOCKSHARE-${mint}`.slice(0, 44), curveCreator: null };
      const doc = JSON.parse(rows[0].payload);
      const got = (doc.shareholders || []).map((x) => `${x.wallet}:${x.bps}`).sort().join(',');
      const base = { want, got, adminRevoked: doc.adminRevoked !== false, pda: `MOCKSHARE-${mint}`.slice(0, 44), signature: rows[0].signature };
      if (got !== want) return { ...base, state: 'wrong', reason: 'the shareholders on chain differ from the approved split' };
      if (doc.adminRevoked === false) return { ...base, state: 'unlocked', reason: 'the shares match but the sharing admin is not revoked: the split could still be changed' };
      return { ...base, state: 'locked' };
    },
    async verifySplit(attempt, config) {
      const row = db.get('SELECT * FROM mock_chain WHERE signature = ?', attempt.tx_signature);
      const payload = row ? JSON.parse(row.payload) : null;
      const ks = (rows) => (rows || []).map((x) => `${x.wallet}:${x.bps}`).sort().join(',');
      const checks = [{ name: 'mock ledger has the fee-split transaction', ok: Boolean(row && row.status === 'ok'), detail: 'mock' },
        { name: 'shareholders match the approved allocation', ok: payload?.kind === 'split' && ks(payload.shareholders) === ks(config.feeSharing.shareholders), detail: ks(payload?.shareholders) },
        { name: 'MOCK: no blockchain was used', ok: true, detail: 'mock provider' }];
      const splitOk = checks.every((c) => c.ok);
      let buyOk = true;
      if (attempt.with_buy) { buyOk = payload?.withBuy === true && payload.tokensBase === attempt.tokens_base; checks.push({ name: 'MOCK: dev buy recorded as reviewed (nothing was bought)', ok: buyOk, detail: `${attempt.requested_lamports} lamports` }); }
      return { ok: splitOk && buyOk, splitOk, buyOk, retry: false, checks, slot: row ? height(row.visible_at) : null, blockTime: row ? Math.floor(row.visible_at / 1000) : null };
    },

    /** No chain: no balance to check (null = unknown, the checks are skipped) and no size limit. */
    async balance() { return null; },

    /** What the wallet will see (review-before-sign): the mock touches no program and no account. */
    reviewOf() { return { programs: [{ id: 'MockLaunch', name: 'MockLaunch', direct: true }], accountsWritable: 0, signers: 1, launchProgramsOnly: true }; },

    /** The wallet signs mockSigningText(hash) with signMessage. */
    verifySigned(intent, signedBase58) {
      let sig;
      try { sig = b58decode(String(signedBase58)); } catch { throw new Error('bad signature encoding'); }
      if (!verifyWalletSignature(intent.signer_wallet, mockSigningText(intent.tx_message_hash), sig)) {
        throw new Error('wallet signature does not verify');
      }
      // the exact shares, as on pump.fun (pumpfun.js checkSignedShares): the reviewed document carries the approved split
      if (intent.config_json) {
        let doc = null; try { doc = JSON.parse(Buffer.from(intent.tx_base64, 'base64').toString('utf8')); } catch { /* checked below */ }
        const ks = (rows) => (rows || []).map((x) => `${x.wallet}:${x.bps}`).sort().join(',');
        if (doc?.splitTx) {
          // tx1 of a two-step launch writes no split (it is tx2's 'split' document)
          if (doc.config?.feeSharing) throw new Error('the creation transaction of a two-step launch must not write a fee split');
        } else if (doc?.kind !== 'dev_buy' && ks(doc?.config?.feeSharing?.shareholders) !== ks(JSON.parse(intent.config_json)?.feeSharing?.shareholders)) {
          throw new Error('the fee shareholders in the signed launch differ from the approved split');
        }
      }
      return { signature: `MOCK${b58encode(sig)}`.slice(0, 88), raw: Buffer.from(intent.tx_base64, 'base64') };
    },

    async submit(intent, _raw) {
      const b = behaviour();
      if (b === 'never_lands') return intent.tx_signature;
      if (b === 'preflight_reject') { const e = new Error('mock: simulation failed (insufficient funds)'); e.rejected = true; throw e; }
      const t = now();
      const visibleAt = b === 'late' ? t + (VALID_BLOCKS + 30) * SLOT_MS : b === 'slow_index' ? t + 20_000 : t + 1500;
      db.run(`INSERT INTO mock_chain (signature, mint, payload, status, visible_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(signature) DO NOTHING`, intent.tx_signature, intent.mint, (intent.split_tx ? null : intent.config_json) ?? Buffer.from(intent.tx_base64, 'base64').toString('utf8'),
      b === 'reject_on_chain' ? 'failed' : 'ok', visibleAt);
      if (b === 'timeout_but_lands') throw new Error('mock: RPC timeout (the transaction was forwarded anyway)');
      return intent.tx_signature;
    },

    async status(intent) {
      const row = db.get('SELECT * FROM mock_chain WHERE signature = ?', intent.tx_signature);
      if (row && row.visible_at <= now()) {
        return row.status === 'failed' ? { state: 'failed', err: 'mock: rejected on-chain' } : { state: 'finalized', slot: height(row.visible_at) };
      }
      if (height() > intent.last_valid_block_height && !row) return { state: 'expired', height: height() };
      return { state: 'pending', height: height(), lastValid: intent.last_valid_block_height };
    },

    /** Only our own submit() can put a mock transaction on the mock ledger, so nothing is ever "open". */
    async landCheck(intent) {
      const row = db.get(`SELECT * FROM mock_chain WHERE mint = ? AND status = 'ok' AND payload NOT LIKE '%"kind":"dev_buy"%' AND payload NOT LIKE '%"kind":"split"%'`, intent.mint);
      return row ? { state: 'landed', signature: row.signature } : { state: 'dead' };
    },

    verifyDevBuySigned(attempt, signed) { return this.verifySigned(attempt, signed); },
    devBuyStatus(attempt) { return this.status(attempt); },
    async devBuyLandCheck(attempt) {
      const row = attempt.tx_signature ? db.get(`SELECT * FROM mock_chain WHERE signature = ? AND status = 'ok'`, attempt.tx_signature) : null;
      return row ? { state: 'landed', signature: row.signature } : { state: 'dead' };
    },
    async verifyDevBuy(attempt) {
      const row = db.get('SELECT * FROM mock_chain WHERE signature = ?', attempt.tx_signature);
      const payload = row ? JSON.parse(row.payload) : null;
      const checks = [{ name: 'mock ledger has the dev buy transaction', ok: Boolean(row && row.status === 'ok'), detail: 'mock' },
        { name: 'MOCK: dev buy recorded as reviewed (nothing was bought)', ok: payload?.kind === 'dev_buy' && payload.mint === attempt.mint && payload.tokensBase === attempt.tokens_base, detail: `${attempt.requested_lamports} lamports` },
        { name: 'MOCK: no blockchain was used', ok: true, detail: 'mock provider' }];
      return { ok: checks.every((c) => c.ok), retry: false, checks, slot: row ? height(row.visible_at) : null, blockTime: row ? Math.floor(row.visible_at / 1000) : null, tokensBase: payload?.tokensBase ?? null };
    },

    async verifyLaunch(intent, config) {
      const row = db.get('SELECT * FROM mock_chain WHERE signature = ?', intent.tx_signature);
      const checks = [{ name: 'mock ledger has the transaction', ok: Boolean(row && row.status === 'ok'), detail: 'mock' }];
      const payload = row ? JSON.parse(row.payload) : null;
      if (intent.split_tx) {
        checks.push({ name: 'no fee split in the creation transaction (two-step launch: locked in step 2)', ok: payload?.splitTx === true && !payload?.config?.feeSharing, detail: 'mock' });
      } else {
        const got = payload?.feeSharing?.shareholders?.map((s) => `${s.wallet}:${s.bps}`).sort().join(',');
        const want = config.feeSharing.shareholders.map((s) => `${s.wallet}:${s.bps}`).sort().join(',');
        checks.push({ name: 'recipients match the approved allocation', ok: got === want, detail: got });
      }
      const buy = Number(config.initialBuyLamports) || 0;
      if (buy > 0 && intent.dev_buy_mode !== 'second_tx') checks.push({ name: 'MOCK: dev buy recorded as approved (nothing was bought)', ok: Number(payload?.initialBuyLamports) === buy, detail: `${buy} lamports` });
      checks.push({ name: 'MOCK: no blockchain was used', ok: true, detail: 'mock provider' });
      return { ok: checks.every((c) => c.ok), checks, slot: row ? height(row.visible_at) : null, blockTime: row ? Math.floor(row.visible_at / 1000) : null };
    },

    async readFees(_launch, _config) {
      return [];                                          // a mock never earns anything; nothing is invented
    },

    explorerTx: () => null,
    explorerToken: () => null,
  };
}
