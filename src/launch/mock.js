// MOCK launch provider: a stand-in for a blockchain, for tests and local demos. Nothing here touches any network.
// Everything it produces is labelled "mock"; mock launches never appear as on-chain anywhere, and the provider is
// refused in production (config.js). The "transaction" is a JSON document the wallet signs as a plain message.
// Failure injection (settings key 'mock.behaviour'): ok | reject_on_chain | never_lands | late | slow_index |
// preflight_reject | timeout_but_lands.
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

    async prepare(config) {
      const mint = `MOCK${b58encode(randomBytes(28))}`.slice(0, 44);
      const initialBuyLamports = Number(config.initialBuyLamports) || 0;
      // the dev buy is recorded in the mock document (nothing is bought: no chain); the estimate reports it like pump.fun's
      const doc = { mock: true, provider: 'mock', mint, config: { ...config, initialBuyLamports }, nonce: randomBytes(8).toString('hex') };
      const json = JSON.stringify(doc);
      return { txBase64: Buffer.from(json).toString('base64'), messageHash: createHash('sha256').update(json).digest('hex'),
        lastValidBlockHeight: height() + VALID_BLOCKS, mint, txBytes: json.length,
        estimate: { networkFeeLamports: 0, accountsLamports: 0, initialBuyLamports, initialBuyMaxLamports: initialBuyLamports, simulation: { ok: true, mock: true } } };
    },

    /** What the wallet will see (review-before-sign): the mock touches no program and no account. */
    reviewOf() { return { programs: [{ id: 'MockLaunch', name: 'MockLaunch', direct: true }], accountsWritable: 0, signers: 1, launchProgramsOnly: true }; },

    /** The wallet signs mockSigningText(hash) with signMessage. */
    verifySigned(intent, signedBase58) {
      let sig;
      try { sig = b58decode(String(signedBase58)); } catch { throw new Error('bad signature encoding'); }
      if (!verifyWalletSignature(intent.signer_wallet, mockSigningText(intent.tx_message_hash), sig)) {
        throw new Error('wallet signature does not verify');
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
              ON CONFLICT(signature) DO NOTHING`, intent.tx_signature, intent.mint, intent.config_json,
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
      const row = db.get(`SELECT * FROM mock_chain WHERE mint = ? AND status = 'ok'`, intent.mint);
      return row ? { state: 'landed', signature: row.signature } : { state: 'dead' };
    },

    async verifyLaunch(intent, config) {
      const row = db.get('SELECT * FROM mock_chain WHERE signature = ?', intent.tx_signature);
      const checks = [{ name: 'mock ledger has the transaction', ok: Boolean(row && row.status === 'ok'), detail: 'mock' }];
      const payload = row ? JSON.parse(row.payload) : null;
      const got = payload?.feeSharing?.shareholders?.map((s) => `${s.wallet}:${s.bps}`).sort().join(',');
      const want = config.feeSharing.shareholders.map((s) => `${s.wallet}:${s.bps}`).sort().join(',');
      checks.push({ name: 'recipients match the approved allocation', ok: got === want, detail: got });
      const buy = Number(config.initialBuyLamports) || 0;
      if (buy > 0) checks.push({ name: 'MOCK: dev buy recorded as approved (nothing was bought)', ok: Number(payload?.initialBuyLamports) === buy, detail: `${buy} lamports` });
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
