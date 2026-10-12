// Fee allocation and launch orchestration. A launch goes: approved allocation -> reviewed launch configuration ->
// launch intent (exact transaction, persisted BEFORE the signature is requested) -> wallet signature -> broadcast ->
// on-chain verification -> launched. A provider's answer alone never marks a project launched.
import { createHash } from 'node:crypto';
import { log } from './log.js';
import { audit, isPaused } from './db.js';
import { enqueue, Permanent, Defer } from './jobs.js';
import { transition, note } from './states.js';
import { currentVersion, validateReceivingWallet } from './ideas.js';
import { makeMockProvider } from './launch/mock.js';
import { makePumpfunProvider } from './launch/pumpfun.js';
import { mockSigningText } from './launch/mock.js';
import { id, now, HttpError, parseJson, isSolanaAddress, encrypt, decrypt } from './util.js';

export const MAX_RECIPIENTS = 8;
let cached = null;

// --- the author's dev buy ---------------------------------------------------------------------------------------------
// An optional buy of the author's own coin right at the launch (pump.fun ATA + buy_v2). Paid by the author's wallet,
// tokens land in the author's wallet. Hard cap 5 SOL; MAX_INITIAL_BUY_SOL can only lower it; the transaction caps the
// cost at quote + 5%. Every transaction handed to the wallet is in the Phantom-safe layout, where create + split + buy
// does not fit 1232 bytes: the buy is then a SECOND transaction (devBuyMode 'second_tx', step 2 below: tx1 creates the
// coin, is confirmed and verified -> "launched"; tx2 = ATA + buy_v2, quoted on the live curve, signed by the author
// alone). It stays inside tx1 ('same_tx') only when that fits Phantom-safe.
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const HARD_MAX_INITIAL_BUY_SOL = 5;
export const INITIAL_BUY_SLIPPAGE_BPS = 500;
export const INITIAL_BUY_STATES = ['preview_ready', 'approved', 'launch_prepared'];

export function maxInitialBuyLamports(cfg) {
  const sol = Number(cfg.launch?.maxInitialBuySol);
  const capped = Math.min(HARD_MAX_INITIAL_BUY_SOL, Number.isFinite(sol) && sol >= 0 ? sol : HARD_MAX_INITIAL_BUY_SOL);
  return Math.round(capped * LAMPORTS_PER_SOL);
}

/** Body value (SOL, number or numeric string) -> lamports, or 400 bad_initial_buy. */
export const MIN_INITIAL_BUY_LAMPORTS = 1_000_000;                 // 0.001 SOL: below that the quote rounds to nothing
// Rent + network fee a launch needs on top of the buy (devnet 2026-10-10: 15.1M lamports), with margin, for the checks
// made before the transaction exists; the transaction itself then carries the exact numbers.
export const LAUNCH_COST_RESERVE_LAMPORTS = 20_000_000;

export function parseInitialBuySol(cfg, value) {
  const sol = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(sol) || sol < 0) throw new HttpError(400, 'bad_initial_buy', 'the dev buy is an amount of SOL, 0 or more');
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  const cap = maxInitialBuyLamports(cfg);
  if (lamports > cap) throw new HttpError(400, 'bad_initial_buy', `the dev buy is at most ${cap / LAMPORTS_PER_SOL} SOL`);
  if (lamports > 0 && lamports < MIN_INITIAL_BUY_LAMPORTS) throw new HttpError(400, 'bad_initial_buy', `the dev buy is at least ${solString(MIN_INITIAL_BUY_LAMPORTS)} SOL, or 0 for none`);
  return lamports;
}

export const solString = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(9).replace(/\.?0+$/, '');

/** "your wallet holds X SOL; …" for the two checks below. */
function fundsMessage(balance, buy, extra, exact) {
  const need = buy + extra;
  return `your wallet holds ${solString(balance)} SOL; the dev buy of ${solString(buy)} SOL plus ${exact ? '' : 'about '}${solString(extra)} SOL of rent and fees needs ${solString(need)} SOL`;
}

/** Before a transaction exists: can the wallet cover the buy plus a reserve for rent and fees? (null balance = unknown) */
async function checkFunds(provider, wallet, lamports) {
  if (!(lamports > 0) || typeof provider?.balance !== 'function') return;
  const balance = await provider.balance(wallet);
  if (balance == null) return;
  if (balance < lamports + LAUNCH_COST_RESERVE_LAMPORTS) throw new HttpError(400, 'insufficient_funds', fundsMessage(balance, lamports, LAUNCH_COST_RESERVE_LAMPORTS, false));
}

/**
 * Where the dev buy goes: inside the creation transaction only when create + split + buy fits ONE Phantom-safe
 * transaction (provider.devBuyFitsOneTx, offline), else its own second transaction. null without a buy.
 */
export async function devBuyModeFor(provider, shape) {
  if (!((Number(shape.initialBuyLamports) || 0) > 0)) return null;
  if (typeof provider?.devBuyFitsOneTx !== 'function') return 'second_tx';
  return (await provider.devBuyFitsOneTx(shape)) ? 'same_tx' : 'second_tx';
}
const shapeOf = (config, initialBuyLamports = Number(config.initialBuyLamports) || 0) => ({ name: config.token.name, symbol: config.token.symbol, uri: config.token.uri,
  initialBuyLamports, feeSharing: { mode: config.feeSharing.mode, shareholders: config.feeSharing.shareholders } });
// the plain words before step 1 (configuration, review card): what a second signature means for the author
export const devBuyStepNote = (lamports) => `Your dev buy of ${solString(lamports)} SOL is a second signature right after the launch, at the price then (pump.fun's fees included; the tokens go to your wallet). If the price moves more than ${INITIAL_BUY_SLIPPAGE_BPS / 100}% first, it does not go through and you keep your SOL. You can also skip it.`;

/**
 * Owner sets the dev buy. Allowed while the idea is preview_ready / approved / launch_prepared and no transaction
 * exists (409 intent_exists: cancel it first). Once a reviewed configuration exists it is rebuilt by the same job as
 * the first time (launch_prepared -> approved -> prepare_launch -> launch_prepared), so the hash the author reviews
 * always matches what the transaction will do.
 */
export async function setInitialBuy(db, cfg, project, idea, wallet, lamports) {
  if (idea.owner_wallet !== wallet) throw new HttpError(403, 'not_owner');
  if (db.get('SELECT 1 FROM launches WHERE project_id = ?', project.id)) throw new HttpError(409, 'already_launched');
  if (db.get(`SELECT 1 FROM launch_intents WHERE project_id = ? AND status IN ('prepared','awaiting_signature','submitted','confirmed')`, project.id)) {
    throw new HttpError(409, 'intent_exists', 'a transaction already exists; cancel it first to change the dev buy');
  }
  if (!INITIAL_BUY_STATES.includes(idea.status)) throw new HttpError(409, 'bad_state', `idea is ${idea.status}`);
  const provider = getProvider(cfg, db);
  await checkFunds(provider, wallet, lamports);                          // 400 insufficient_funds (no size limit: a buy that does not fit is step 2)
  const t = now();
  const changed = lamports !== Number(project.initial_buy_lamports ?? 0);
  let status = idea.status;
  db.tx(() => {
    db.run('UPDATE projects SET initial_buy_lamports = ?, updated_at = ? WHERE id = ?', lamports, t, project.id);
    audit(db, { actor: `wallet:${wallet}`, kind: 'launch_options', ideaId: idea.id, projectId: project.id,
      message: `Dev buy set to ${solString(lamports)} SOL`, data: { initialBuyLamports: lamports } });
    if (idea.status === 'launch_prepared' && changed) {
      db.run('UPDATE projects SET launch_config_json = NULL, launch_config_hash = NULL WHERE id = ?', project.id);
      transition(db, idea.id, 'launch_prepared', 'approved', { actor: `wallet:${wallet}`, note: 'dev buy changed; preparing the launch configuration again' });
      status = 'approved';
    }
    // approved: the queued job reads the row (and re-checks it before writing); a fresh key covers a dead one
    if (status === 'approved') enqueue(db, { type: 'prepare_launch', key: `prepare:${project.id}:options:${t}`, ideaId: idea.id, projectId: project.id });
  });
  return { initialBuyLamports: lamports, status, reprepared: status === 'approved' && idea.status === 'launch_prepared' };
}

export function getProvider(cfg, db) {
  if (cfg.launch.provider === 'none') return null;
  if (cached && cached.db === db && cached.key === cfg.launch.provider + cfg.launch.rpcUrl) return cached.p;
  const p = cfg.launch.provider === 'pumpfun' ? makePumpfunProvider(cfg) : makeMockProvider(db);
  cached = { db, key: cfg.launch.provider + cfg.launch.rpcUrl, p };
  return p;
}
export const setProviderForTests = (db, p, cfg) => { cached = { db, key: cfg.launch.provider + cfg.launch.rpcUrl, p }; };

// --- allocation --------------------------------------------------------------------------------------------------
// Owner rule: 80% of every project's creator fees to the idea submitter's side, 20% to SUB-01. The SUB-01 row is
// fixed and mandatory; the submitter may split their 80% with collaborators.
export const SUB01_FEE_BPS = 2000;
export const SUB01_LABEL = 'SUB-01';

export function requireSub01Wallet(cfg) {
  if (!cfg.sub01FeeWallet) throw new HttpError(409, 'sub01_wallet_missing', 'SUB01_FEE_WALLET is not configured: SUB-01\'s 20% creator-fee share has no wallet, so nothing can be approved or launched');
  return cfg.sub01FeeWallet;
}

/** Default: 80% to the submitter's receiving wallet, 20% to SUB-01 (wallet null until SUB01_FEE_WALLET is set). */
export function defaultAllocation(cfg, receivingWallet) {
  return [{ label: 'Idea submitter', wallet: receivingWallet, bps: 10000 - SUB01_FEE_BPS, role: 'submitter' },
    { label: SUB01_LABEL, wallet: cfg.sub01FeeWallet || null, bps: SUB01_FEE_BPS, role: 'sub01' }];
}

// A coin launched from another coin's site (child-launch.js): creator (the visitor) / the parent's author / SUB-01, the
// parent's launch block sets the bps within these limits. SUB-01 at least 20%, the creator at least 50%, no collaborators.
export const CHILD_SPLIT_POLICY = Object.freeze({ child: true, minSub01Bps: SUB01_FEE_BPS, minSubmitterBps: 5000 });

/** policy: null (a city coin: submitter + collaborators + exactly 20% SUB-01) or CHILD_SPLIT_POLICY. */
export function validateRecipients(cfg, recipients, receivingWallet, policy = null) {
  const sub01Wallet = requireSub01Wallet(cfg);
  if (!Array.isArray(recipients) || recipients.length < 2 || recipients.length > MAX_RECIPIENTS) {
    throw new HttpError(400, 'bad_allocation', `2–${MAX_RECIPIENTS} recipients (the submitter and SUB-01 at least)`);
  }
  const seen = new Set();
  let total = 0;
  const roles = policy?.child ? ['submitter', 'sub01', 'parent'] : ['submitter', 'sub01', 'collaborator', undefined, null, ''];
  const out = recipients.map((r) => {
    if (!roles.includes(r.role)) throw new HttpError(400, 'bad_allocation', `unknown role ${String(r.role).slice(0, 20)}`);
    const role = r.role || 'collaborator';
    const wallet = validateReceivingWallet(r.wallet);
    const bps = Number(r.bps);
    if (!Number.isInteger(bps) || bps <= 0 || bps > 10000) throw new HttpError(400, 'bad_allocation', 'each share must be 1–10000 bps');
    if (seen.has(wallet)) throw new HttpError(400, 'bad_allocation', 'duplicate recipient');
    seen.add(wallet);
    total += bps;
    return { label: role === 'sub01' ? SUB01_LABEL : String(r.label || role).slice(0, 40).replace(/[<>`]/g, ''), wallet, bps, role };
  });
  if (total !== 10000) throw new HttpError(400, 'bad_allocation', `shares must total 100% (got ${total / 100}%)`);
  const subs = out.filter((r) => r.role === 'submitter');
  if (subs.length !== 1 || subs[0].wallet !== receivingWallet) throw new HttpError(400, 'bad_allocation', 'exactly one submitter row, and it must be the idea\'s receiving wallet');
  const s1 = out.filter((r) => r.role === 'sub01');
  if (policy?.child) {
    if (s1.length !== 1 || s1[0].wallet !== sub01Wallet || s1[0].bps < policy.minSub01Bps) {
      throw new HttpError(400, 'bad_allocation', `the SUB-01 row is mandatory: at least ${policy.minSub01Bps / 100}% to ${sub01Wallet}`);
    }
    if (subs[0].bps < policy.minSubmitterBps) throw new HttpError(400, 'bad_allocation', `the creator keeps at least ${policy.minSubmitterBps / 100}%`);
    if (out.filter((r) => r.role === 'parent').length > 1) throw new HttpError(400, 'bad_allocation', 'one parent row at most');
    return out;
  }
  if (s1.length !== 1 || s1[0].wallet !== sub01Wallet || s1[0].bps !== SUB01_FEE_BPS) {
    throw new HttpError(400, 'bad_allocation', `the SUB-01 row is mandatory: exactly ${SUB01_FEE_BPS / 100}% to ${sub01Wallet}`);
  }
  return out;
}

export function draftAllocation(db, projectId, recipients, createdBy) {
  const last = db.get('SELECT MAX(version) v FROM fee_allocations WHERE project_id = ?', projectId);
  const version = (last?.v || 0) + 1;
  db.run(`UPDATE fee_allocations SET status = 'superseded' WHERE project_id = ? AND status IN ('draft','approved')`, projectId);
  const aid = id('alloc');
  db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at)
          VALUES (?, ?, ?, ?, 10000, 'draft', ?)`, aid, projectId, version, JSON.stringify(recipients), now());
  audit(db, { actor: createdBy, kind: 'allocation', projectId, message: `Fee allocation draft v${version}`, data: recipients });
  return aid;
}

export function allocationStatement(recipients, mode) {
  const lines = recipients.map((r) => `- ${r.label} (${r.role}): ${(r.bps / 100).toFixed(2)}% → ${r.wallet}`);
  return [
    'I approve this split of the CREATOR FEES of this token (not trading fees, not hosting costs):',
    ...lines,
    mode === 'sharing_config'
      ? 'This split is written on-chain at launch and LOCKED: it cannot be changed afterwards by me or by SUBZERONE.'
      : 'Creator fees go directly to the creator wallet above; no split is configured on-chain.',
    'There is no other, undisclosed recipient. Fees depend on trading; there may be none.',
  ].join('\n');
}

export function feeMode(recipients, signer) {
  return recipients.length === 1 && recipients[0].wallet === signer ? 'direct' : 'sharing_config';
}

// --- launch configuration (prepare_launch job) ---------------------------------------------------------------------
export async function buildLaunchConfig(db, cfg, project) {
  const provider = getProvider(cfg, db);
  if (!provider) throw new Permanent('launching is disabled (LAUNCH_PROVIDER=none)');
  if (!cfg.sub01FeeWallet) throw new Permanent('sub01_wallet_missing: SUB01_FEE_WALLET is not configured');
  const idea = db.get('SELECT * FROM ideas WHERE id = ?', project.idea_id);
  const v = currentVersion(db, idea.id);
  const alloc = db.get(`SELECT * FROM fee_allocations WHERE project_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1`, project.id);
  if (!alloc) throw new Permanent('no approved fee allocation');
  const recipients = parseJson(alloc.recipients_json);
  validateRecipients(cfg, recipients, v.receiving_wallet, project.parent_project_id ? CHILD_SPLIT_POLICY : null);   // re-checked against the current receiving wallet
  const signer = idea.owner_wallet;
  const mode = feeMode(recipients, signer);
  if (alloc.approval_statement !== allocationStatement(recipients, mode)) throw new Permanent('approval statement does not match the allocation');
  const params = await provider.chainParams();
  const site = db.get('SELECT * FROM site_versions WHERE project_id = ? AND version = ?', project.id, project.live_site_version);
  const logo = db.get(`SELECT version, sha256 FROM assets WHERE project_id = ? AND kind = 'logo' ORDER BY version DESC LIMIT 1`, project.id);
  const spec = parseJson(site.spec_json);
  const metadata = {
    name: project.name, symbol: project.ticker, description: spec.description,
    image: `${cfg.publicOrigin}/meta/${project.slug}/logo-v${logo.version}.png`,
    external_url: `${cfg.projectsScheme}://${project.slug}.${cfg.projectsHost}/`,
    attributes: [{ trait_type: 'built_by', value: 'SUB-01 (SUBZERONE launchpad)' }],
  };
  const metaHash = createHash('sha256').update(JSON.stringify(metadata)).digest('hex').slice(0, 16);
  const uri = `${cfg.publicOrigin}/m/${metaHash}.json`;        // short on purpose: every byte counts in a 1232-byte transaction (app.js serves /m/)
  if (uri.length > 200) throw new Permanent('metadata URI longer than 200 characters');
  // the dev buy: read fresh (the author may have changed it since the job picked up the row), checked against the cap
  const initialBuyLamports = Number(db.get('SELECT initial_buy_lamports FROM projects WHERE id = ?', project.id)?.initial_buy_lamports ?? 0);
  if (!Number.isInteger(initialBuyLamports) || initialBuyLamports < 0) throw new Permanent('bad dev buy amount');
  if (initialBuyLamports > maxInitialBuyLamports(cfg)) {
    throw new Permanent(`the dev buy of ${solString(initialBuyLamports)} SOL is above the cap of ${solString(maxInitialBuyLamports(cfg))} SOL; lower it in the Launch tab`);
  }
  const irreversible = [
    'The token name, ticker and metadata link cannot be changed after creation.',
    'The supply is fixed by the launch program; there is no mint or freeze authority you can use afterwards.',
  ];
  if (mode === 'sharing_config') irreversible.push('The creator-fee split is written on-chain and locked: nobody at SUBZERONE, and not you, can change it later. (pump.fun keeps an emergency takeover authority over all coins.)');
  let devBuyMode = null;
  if (initialBuyLamports > 0) {
    if (initialBuyLamports < MIN_INITIAL_BUY_LAMPORTS) throw new Permanent(`the dev buy is at least ${solString(MIN_INITIAL_BUY_LAMPORTS)} SOL, or 0 for none`);
    devBuyMode = await devBuyModeFor(provider, { name: project.name, symbol: project.ticker, uri, initialBuyLamports,
      feeSharing: { mode, shareholders: recipients.map(({ wallet, bps }) => ({ wallet, bps })) } });
    irreversible.push(devBuyMode === 'same_tx'
      ? `You buy ${solString(initialBuyLamports)} SOL of your own coin in the creation transaction, pump.fun's fees included; the tokens go to your wallet. The transaction caps the cost at the quote + ${INITIAL_BUY_SLIPPAGE_BPS / 100}%.`
      : devBuyStepNote(initialBuyLamports));
  }
  const config = {
    version: 'launch-config/1',
    provider: provider.name, providerLabel: provider.label, network: provider.network, mock: provider.isMock,
    token: { name: project.name, symbol: project.ticker, uri, metadata, decimals: params.decimals,
      totalSupplyBase: params.totalSupplyBase, tokenProgram: params.tokenProgram,
      authorities: { mint: 'none after creation', freeze: 'none' } },
    signer, payer: signer, creator: mode === 'sharing_config' ? 'per-mint sharing config (holds the split)' : signer,
    initialBuyLamports, initialBuySlippageBps: initialBuyLamports > 0 ? INITIAL_BUY_SLIPPAGE_BPS : 0, devBuyMode,
    feeSharing: { mode, shareholders: recipients.map(({ wallet, bps }) => ({ wallet, bps })), recipients, locked: mode === 'sharing_config',
      allocationId: alloc.id, allocationVersion: alloc.version },
    tradingFees: params.fees,
    irreversible,
    preparedAt: now(),
  };
  return config;
}

export const configHash = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');

// --- signature request -> broadcast -> confirmation ---------------------------------------------------------------
/** Owner asks for the transaction. Builds a fresh launch intent. Only one live intent per project (DB-enforced). */
export async function createIntent(db, cfg, project, wallet) {
  if (isPaused(db, 'launch')) throw new HttpError(503, 'paused', 'launches are paused');
  requireSub01Wallet(cfg);
  const idea = db.get('SELECT * FROM ideas WHERE id = ?', project.idea_id);
  if (idea.owner_wallet !== wallet) throw new HttpError(403, 'not_owner');
  if (idea.status === 'awaiting_signature') {
    // resume (page reload, double click): the same reviewed transaction, never a second one
    const pending = db.get(`SELECT * FROM launch_intents WHERE project_id = ? AND status = 'awaiting_signature'`, project.id);
    if (pending && pending.signer_wallet === wallet) {
      const provider = getProvider(cfg, db);
      return { intentId: pending.id, mint: pending.mint, txBase64: pending.tx_base64, messageHash: pending.tx_message_hash,
        estimate: pending.estimate_json ? parseJson(pending.estimate_json) : null, lastValidBlockHeight: pending.last_valid_block_height, mock: provider.isMock,
        txBytes: Buffer.from(pending.tx_base64, 'base64').length, resumed: true, ...review(provider, pending.tx_base64, pending.network, pending.signer_wallet) };
    }
  }
  if (idea.status !== 'launch_prepared') throw new HttpError(409, 'bad_state', `idea is ${idea.status}`);
  if (db.get('SELECT 1 FROM launches WHERE project_id = ?', project.id)) throw new HttpError(409, 'already_launched');
  const live = db.get(`SELECT * FROM launch_intents WHERE project_id = ? AND status IN ('prepared','awaiting_signature','submitted','confirmed')`, project.id);
  if (live) throw new HttpError(409, 'intent_exists', 'a launch attempt is already in progress');
  if (db.get(`SELECT 1 FROM launch_intents WHERE project_id = ? AND error LIKE 'landed:%'`, project.id)) {
    throw new HttpError(409, 'landed_unverified', 'an earlier transaction landed but failed verification; an admin must resolve it first');
  }
  if (idea.visibility !== 'public') throw new HttpError(409, 'private', 'a launched token is public: publish the idea first');
  const provider = getProvider(cfg, db);
  await settleEarlierIntents(db, cfg, provider, project);
  const config = parseJson(project.launch_config_json);
  if (!config || configHash(config) !== project.launch_config_hash) throw new HttpError(409, 'config_changed', 'launch configuration changed; prepare it again');
  if (config.provider !== provider.name || config.network !== provider.network) throw new HttpError(409, 'config_changed', 'provider changed; prepare again');
  const buyLamports = Number(config.initialBuyLamports) || 0;
  // a configuration from before the two-step launch has no devBuyMode: decided now, the same way
  const devBuyMode = buyLamports > 0 ? (config.devBuyMode || await devBuyModeFor(provider, shapeOf(config))) : null;
  const built = await buildChecked(provider, config, buyLamports, { devBuyMode });
  const est = built.estimate || {};
  const reviewed = review(provider, built.txBase64, provider.network, config.payer);   // before anything is stored
  const intentId = id('intent');
  const t = now();
  db.tx(() => {
    // the mint key signs after the wallet (verifySigned): kept encrypted until the broadcast, then wiped
    const mintSecretEnc = built.mintSecret ? encrypt(cfg.encryptionKey, built.mintSecret) : null;
    db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, mint_secret_enc,
              signer_wallet, status, tx_base64, tx_message_hash, last_valid_block_height, buy_tokens_base, estimate_json, dev_buy_mode, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_signature', ?, ?, ?, ?, ?, ?, ?, ?)`,
    intentId, project.id, provider.name, provider.network, project.launch_config_json, project.launch_config_hash,
    config.feeSharing.allocationId, built.mint, mintSecretEnc, config.signer, built.txBase64, built.messageHash, built.lastValidBlockHeight,
    devBuyMode === 'same_tx' && est.initialBuyTokensBase != null ? String(est.initialBuyTokensBase) : null, JSON.stringify(built.estimate ?? null), devBuyMode, t, t);
    transition(db, idea.id, 'launch_prepared', 'awaiting_signature', { actor: `wallet:${wallet}`,
      note: provider.isMock ? 'MOCK transaction ready for your wallet' : 'transaction ready for your wallet', data: { intent: intentId, mint: built.mint } });
  });
  return { intentId, mint: built.mint, txBase64: built.txBase64, messageHash: built.messageHash, estimate: built.estimate,
    lastValidBlockHeight: built.lastValidBlockHeight, mock: provider.isMock, txBytes: built.txBytes, ...reviewed };
}

/** provider.prepare with the checks the author must see as a sentence, never as a 500; nothing is stored when it fails. */
async function buildChecked(provider, config, buyLamports, opts = {}) {
  let built;
  try {
    built = await provider.prepare({ name: config.token.name, symbol: config.token.symbol, uri: config.token.uri,
      signer: config.signer, feeSharing: config.feeSharing, initialBuyLamports: buyLamports }, opts);
  } catch (e) {
    if (e?.code) throw new HttpError(409, e.code, e.message);     // tx_too_large, buy_completes_curve, buy_too_small: the author's choice to change
    throw e;
  }
  const est = built.estimate || {};
  // every simulation is logged (Phantom support, 2026-10-12: show that only transactions that simulate cleanly reach the wallet)
  log.info('launch simulation', { mint: built.mint, ok: est.simulation?.ok ?? null, err: est.simulation?.err ?? null,
    units: est.simulation?.unitsConsumed ?? null, bytes: built.txBytes ?? null, refresh: Boolean(opts.mintSecret),
    phantomSafe: est.phantomSafe ?? null, devBuyMode: est.devBuyMode ?? null });
  if (!est.simulation || est.simulation.ok !== true) {
    if (est.simulation?.logs) log.warn('launch simulation logs', { mint: built.mint, logs: est.simulation.logs });
    throw new HttpError(409, 'simulation_failed', simulationMessage(est, buyLamports));   // nothing goes to the wallet
  }
  if (est.signerBalanceLamports != null && est.networkFeeLamports != null && est.accountsLamports != null) {
    // a second-transaction buy is counted too: the author asked for both, and step 2 right after needs that SOL
    const extra = est.networkFeeLamports + est.accountsLamports, buy = (Number(est.initialBuyLamports) || 0) + (Number(est.devBuy?.lamports) || 0);
    if (est.signerBalanceLamports < buy + extra) throw new HttpError(409, 'insufficient_funds', fundsMessage(est.signerBalanceLamports, buy, extra, true));
  }
  return built;
}

/** Right before the wallet opens: the SAME transaction (same mint, same instructions, same review) with a fresh
 *  blockhash, so a minute spent reading the review never hands the wallet an expired transaction (Phantom simulates
 *  before signing and calls an expired one "could be malicious"). -> the same shape as createIntent. */
export async function refreshIntent(db, cfg, project, wallet) {
  const provider = getProvider(cfg, db);
  const intent = db.get(`SELECT * FROM launch_intents WHERE project_id = ? AND status = 'awaiting_signature'`, project.id);
  if (!intent) throw new HttpError(409, 'no_intent', 'no transaction is waiting for a signature');
  if (intent.signer_wallet !== wallet) throw new HttpError(403, 'not_signer');
  const config = parseJson(intent.config_json);
  const current = () => ({ intentId: intent.id, mint: intent.mint, txBase64: intent.tx_base64, messageHash: intent.tx_message_hash,
    estimate: intent.estimate_json ? parseJson(intent.estimate_json) : null, lastValidBlockHeight: intent.last_valid_block_height, mock: provider.isMock,
    txBytes: Buffer.from(intent.tx_base64, 'base64').length, resumed: true, ...review(provider, intent.tx_base64, intent.network, intent.signer_wallet) });
  if (provider.isMock || !intent.mint_secret_enc) return current();          // the mock has no blockhash; no key → sign what was reviewed
  let mintSecret;
  try { mintSecret = decrypt(cfg.encryptionKey, intent.mint_secret_enc).toString('utf8'); } catch { return current(); }
  const buy = Number(config.initialBuyLamports) || 0;
  const built = await buildChecked(provider, config, buy, { mintSecret, devBuyMode: buy > 0 ? (intent.dev_buy_mode || 'same_tx') : null });
  mintSecret = null;
  if (built.mint !== intent.mint) throw new HttpError(500, 'mint_mismatch', 'the refreshed transaction is not for the same mint');
  const before = review(provider, intent.tx_base64, intent.network, intent.signer_wallet), after = review(provider, built.txBase64, built.network ?? intent.network, intent.signer_wallet);
  if (JSON.stringify(before.programs) !== JSON.stringify(after.programs) || before.signers !== after.signers) {
    throw new HttpError(409, 'config_changed', 'the launch program changed since the review; prepare again');
  }
  db.run(`UPDATE launch_intents SET tx_base64 = ?, tx_message_hash = ?, last_valid_block_height = ?, estimate_json = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_signature'`,
    built.txBase64, built.messageHash, built.lastValidBlockHeight, JSON.stringify(built.estimate ?? null), now(), intent.id);
  return { intentId: intent.id, mint: intent.mint, txBase64: built.txBase64, messageHash: built.messageHash, estimate: built.estimate,
    lastValidBlockHeight: built.lastValidBlockHeight, mock: false, txBytes: built.txBytes, resumed: true, refreshed: true, ...after };
}

/** A failed preparation simulation in one plain sentence: funds first, else the last useful program log line. */
export function simulationMessage(est, buyLamports = 0) {
  const { text, line } = simulationText(est);
  if (FUNDS_RE.test(text)) {
    const bal = est.signerBalanceLamports;
    return bal != null ? `the network simulation says your wallet cannot cover it: ${fundsMessage(bal, buyLamports, LAUNCH_COST_RESERVE_LAMPORTS, false)}`
      : `the network simulation says your wallet cannot cover the dev buy of ${solString(buyLamports)} SOL plus rent and fees`;
  }
  return `the network simulation rejected the transaction (${line}); nothing was created. Check the dev buy and your balance, then try again`;
}
const FUNDS_RE = /insufficient (lamports|funds)|InsufficientFunds|Transfer: insufficient/i;
// pump's TooMuchSolRequired (6002 = 0x1772): buy_v2 would cost more than its max_sol_cost
const PRICE_MOVED_RE = /TooMuchSolRequired|custom program error: 0x1772|"Custom":6002/i;
/** The simulation's error and logs as one text, and the most useful line of it. */
function simulationText(est) {
  const logs = Array.isArray(est.simulation?.logs) ? est.simulation.logs.map(String) : [];
  const text = [est.simulation?.err, ...logs].filter(Boolean).join('\n');
  const keyword = /error|failed|custom program|insufficient|exceeded/i, rev = [...logs].reverse();
  // the program's own words first ("Program log: …"), the runtime's "Program X failed: …" line otherwise
  const useful = rev.find((l) => /^Program log: /.test(l) && keyword.test(l)) || rev.find((l) => keyword.test(l) && !/^Program .* (consumed|success)/.test(l));
  return { text, line: String(useful || logs.at(-1) || est.simulation?.err || 'unknown reason').replace(/^Program log: /, '').slice(0, 200) };
}
// what step 2 needs on top of the buy: the network fee and the author's new Token-2022 account (~0.0021 SOL), with margin
export const DEV_BUY_RESERVE_LAMPORTS = 3_000_000;
export const PRICE_MOVED_NOTE = `the price moved more than ${INITIAL_BUY_SLIPPAGE_BPS / 100}% since the quote, so the dev buy would cost more than its cap: it did not go through and you keep your SOL. Try again at the new price, or skip it`;
/** A failed dev-buy (tx2) simulation in one plain sentence. */
export function devBuySimulationMessage(est, buyLamports) {
  const { text, line } = simulationText(est);
  if (PRICE_MOVED_RE.test(text)) return PRICE_MOVED_NOTE;
  if (FUNDS_RE.test(text)) {
    const bal = est.signerBalanceLamports;
    return bal != null ? `the network simulation says your wallet cannot cover the dev buy: ${fundsMessage(bal, buyLamports, DEV_BUY_RESERVE_LAMPORTS, false)}`
      : `the network simulation says your wallet cannot cover the dev buy of ${solString(buyLamports)} SOL plus the network fee and the token account`;
  }
  return `the network simulation rejected the dev buy (${line}); nothing was bought. Try again, or skip it`;
}

/** Review-before-sign: what the wallet will show, read from the built transaction (provider.reviewOf). */
function review(provider, txBase64, network, payer) {
  const r = provider.reviewOf(txBase64);
  return { network, feePayer: payer, programs: r.programs, accountsWritable: r.accountsWritable, signers: r.signers, launchProgramsOnly: r.launchProgramsOnly };
}

/**
 * Before a new transaction exists, every earlier one for this project must be provably dead: a signed transaction
 * can be broadcast by anyone holding it until its blockhash expires. Open -> wait; landed -> verify it instead.
 */
async function settleEarlierIntents(db, cfg, provider, project) {
  const old = db.all(`SELECT * FROM launch_intents WHERE project_id = ? AND status IN ('cancelled','expired','failed')
                      AND (error IS NULL OR (error NOT LIKE '%[final]%' AND error NOT LIKE 'preflight:%'))`, project.id);
  for (const intent of old) {
    const c = await provider.landCheck(intent);
    if (c.state === 'open') {
      throw new HttpError(409, 'previous_open', `the previous transaction could still land for about ${Math.ceil((c.blocksLeft ?? 150) * 0.4)} more seconds; try again after that`);
    }
    if (c.state === 'landed') {
      db.tx(() => {
        db.run(`UPDATE launch_intents SET status = 'submitted', tx_signature = ?, error = NULL, updated_at = ? WHERE id = ?`, c.signature, now(), intent.id);
        transition(db, project.idea_id, 'launch_prepared', 'confirming', { note: 'an earlier transaction landed after all; verifying it on-chain' });
        enqueue(db, { type: 'confirm_launch', key: `confirm:${intent.id}:landed`, ideaId: project.idea_id, projectId: project.id, payload: { intentId: intent.id } });
      });
      throw new HttpError(409, 'previous_landed', 'an earlier transaction landed after all; it is being verified instead of creating a new one');
    }
    db.run(`UPDATE launch_intents SET error = COALESCE(error, '') || ' [final]' WHERE id = ?`, intent.id);
  }
}

/** The wallet declined, or the user walked away. A signed copy could still be broadcast until it expires: the next
 * transaction waits for that (settleEarlierIntents). */
export function abandonIntent(db, project, wallet, reason = 'signature request cancelled') {
  const intent = db.get(`SELECT * FROM launch_intents WHERE project_id = ? AND status IN ('prepared','awaiting_signature')`, project.id);
  if (!intent) throw new HttpError(409, 'no_intent');
  db.tx(() => {
    db.run(`UPDATE launch_intents SET status = 'cancelled', error = ?, mint_secret_enc = NULL, updated_at = ? WHERE id = ?`, reason, now(), intent.id);
    transition(db, project.idea_id, 'awaiting_signature', 'launch_prepared', { actor: `wallet:${wallet}`, note: `${reason}; nothing was created` });
  });
}

/** Signed transaction comes back: verify it is exactly the reviewed one, persist the signature, then broadcast. */
export async function submitSigned(db, cfg, project, wallet, signed) {
  const provider = getProvider(cfg, db);
  const intent = db.get(`SELECT * FROM launch_intents WHERE project_id = ? AND status = 'awaiting_signature'`, project.id);
  if (!intent) throw new HttpError(409, 'no_intent', 'no transaction is waiting for a signature');
  if (intent.signer_wallet !== wallet) throw new HttpError(403, 'not_signer');
  let checked;
  let mintSecret = null;
  if (intent.mint_secret_enc) { try { mintSecret = decrypt(cfg.encryptionKey, intent.mint_secret_enc).toString('utf8'); } catch { mintSecret = null; } }
  try { checked = await provider.verifySigned(intent, signed, { mintSecret }); } catch (e) { throw new HttpError(400, 'bad_signed_tx', e.message); }
  mintSecret = null;
  // persist first: if we crash after broadcasting, reconciliation finds the signature; the mint key is wiped here
  db.tx(() => {
    db.run(`UPDATE launch_intents SET status = 'submitted', tx_signature = ?, mint_secret_enc = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_signature'`,
      checked.signature, now(), intent.id);
    transition(db, project.idea_id, 'awaiting_signature', 'confirming', { actor: `wallet:${wallet}`,
      note: 'signed; broadcast and waiting for the network', data: { signature: checked.signature } });
  });
  const fresh = db.get('SELECT * FROM launch_intents WHERE id = ?', intent.id);
  let uncertain = false;
  try {
    await provider.submit(fresh, checked.raw);
  } catch (e) {
    if (e.rejected) {
      // a failed preflight simulation: the RPC did not forward it, it cannot land
      db.tx(() => {
        db.run(`UPDATE launch_intents SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, `preflight: ${String(e.message).slice(0, 280)}`, now(), intent.id);
        transition(db, project.idea_id, 'confirming', 'launch_prepared', { note: `the network rejected the transaction before it ran (${String(e.message).slice(0, 120)}); nothing was created` });
      });
      throw new HttpError(400, 'rejected', `the network rejected the transaction: ${String(e.message).slice(0, 160)}`);
    }
    // timeout / RPC error: it may have reached the network. Keep tracking it; the confirmation job decides.
    uncertain = true;
    note(db, project.idea_id, 'broadcast answer unclear; checking the network for the transaction', { actor: 'system' });
  }
  enqueue(db, { type: 'confirm_launch', key: `confirm:${intent.id}:0`, ideaId: project.idea_id, projectId: project.id,
    payload: { intentId: intent.id } });
  return { signature: checked.signature, uncertain };
}

/** confirm_launch job: resolve one submitted intent. */
export async function confirmIntent(db, cfg, intentId, progress = () => {}) {
  const provider = getProvider(cfg, db);
  const intent = db.get('SELECT * FROM launch_intents WHERE id = ?', intentId);
  if (!intent) throw new Permanent('intent not found');
  if (intent.status === 'confirmed') return { state: 'already confirmed' };
  if (intent.status !== 'submitted') return { state: `intent is ${intent.status}` };
  const project = db.get('SELECT * FROM projects WHERE id = ?', intent.project_id);
  const st = await provider.status(intent);
  progress(`network status: ${st.state}`);
  if (st.state === 'pending' || st.state === 'confirmed') throw new Defer(`waiting for finalization (${st.state})`, 4000);
  if (st.state === 'expired') {
    db.tx(() => {
      db.run(`UPDATE launch_intents SET status = 'expired', error = 'blockhash expired before the transaction landed', mint_secret_enc = NULL, updated_at = ? WHERE id = ?`, now(), intent.id);
      transition(db, project.idea_id, 'confirming', 'launch_prepared', { note: 'the transaction expired before it landed; nothing was created. You can sign a new one.' });
    });
    return { state: 'expired' };
  }
  if (st.state === 'failed') {
    db.tx(() => {
      db.run(`UPDATE launch_intents SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, st.err, now(), intent.id);
      transition(db, project.idea_id, 'confirming', 'launch_prepared', { note: `the transaction failed on-chain (${st.err}); nothing was created` });
    });
    return { state: 'failed' };
  }
  // finalized: verify on-chain before calling it launched
  const config = parseJson(intent.config_json);
  const v = await provider.verifyLaunch(intent, config);
  if (!v.ok && v.retry) throw new Defer('finalized, but an account is not visible yet on this RPC node; checking again', 15_000);
  if (!v.ok) {
    db.tx(() => {
      db.run(`UPDATE launch_intents SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, 'landed: on-chain verification failed', now(), intent.id);
      transition(db, project.idea_id, 'confirming', 'failed', { note: 'landed on-chain but did not match the approved configuration; an admin has been alerted', data: { checks: v.checks } });
    });
    return { state: 'verification_failed', checks: v.checks };
  }
  const buy = Number(config.initialBuyLamports) || 0;
  const step2 = buy > 0 && intent.dev_buy_mode === 'second_tx';           // the dev buy waits for its own signature
  db.tx(() => {
    db.run(`UPDATE launch_intents SET status = 'confirmed', updated_at = ? WHERE id = ?`, now(), intent.id);
    db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, slot, block_time, verification, verified_at, dev_buy_status, dev_buy_lamports)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, project.id, intent.id, intent.provider, intent.network, intent.mint,
    intent.tx_signature, v.slot, v.blockTime, JSON.stringify(v.checks), now(), step2 ? 'pending' : null, step2 ? buy : 0);
    db.run(`UPDATE fee_allocations SET status = 'locked' WHERE id = ?`, intent.allocation_id);
    // the launched note records what the author bought, in whole tokens (the config's decimals) and SOL
    const tokens = intent.buy_tokens_base ? tokensText(intent.buy_tokens_base, config) : null;
    const bought = step2 ? ` · next: your dev buy of ${solString(buy)} SOL, a second signature (step 2)`
      : buy > 0 ? ` · dev buy: ${solString(buy)} SOL${tokens ? ` for ${tokens} tokens` : ''}, in your wallet` : '';
    transition(db, project.idea_id, 'confirming', 'launched', { note: (provider.isMock ? 'MOCK launch recorded (no blockchain)' : `verified on ${intent.network}`) + bought,
      data: { mint: intent.mint, signature: intent.tx_signature, checks: v.checks.length, ...(buy > 0 ? { devBuyLamports: buy, devBuyTokensBase: intent.buy_tokens_base ?? null } : {}) } });
  });
  enqueue(db, { type: 'build_site', key: `site:launched:${project.id}`, ideaId: project.idea_id, projectId: project.id, payload: { reason: 'launched' } });
  enqueue(db, { type: 'reconcile_fees', key: `fees:${project.id}:first`, projectId: project.id, payload: {} });
  return { state: 'launched' };
}

const tokensText = (base, config) => (Number(BigInt(base) / 10n ** BigInt(config?.token?.decimals ?? 6))).toLocaleString('en-US');

/** Worker sweep: submitted intents (and dev-buy attempts) whose confirm job gave up get a new one (indexing delay,
 *  late confirmation). */
export function sweepSubmitted(db, t = now()) {
  const rows = db.all(`SELECT i.* FROM launch_intents i WHERE i.status = 'submitted' AND NOT EXISTS
    (SELECT 1 FROM jobs j WHERE j.type = 'confirm_launch' AND j.status IN ('queued','running') AND j.payload_json LIKE '%' || i.id || '%')`);
  for (const i of rows) {
    const p = db.get('SELECT idea_id FROM projects WHERE id = ?', i.project_id);
    enqueue(db, { type: 'confirm_launch', key: `confirm:${i.id}:${Math.floor(t / 300_000)}`, ideaId: p.idea_id, projectId: i.project_id, payload: { intentId: i.id } });
  }
  const buys = db.all(`SELECT a.* FROM dev_buy_attempts a WHERE a.status = 'submitted' AND NOT EXISTS
    (SELECT 1 FROM jobs j WHERE j.type = 'confirm_dev_buy' AND j.status IN ('queued','running') AND j.payload_json LIKE '%' || a.id || '%')`);
  for (const a of buys) {
    const p = db.get('SELECT idea_id FROM projects WHERE id = ?', a.project_id);
    enqueue(db, { type: 'confirm_dev_buy', key: `confirm-buy:${a.id}:${Math.floor(t / 300_000)}`, ideaId: p.idea_id, projectId: a.project_id, payload: { attemptId: a.id } });
  }
  return rows.length + buys.length;
}

// --- step 2: the dev buy as its own transaction (devBuyMode 'second_tx') ------------------------------------------------
// After tx1 is confirmed and verified the project is "launched" with launches.dev_buy_status = 'pending'. The author
// then asks for tx2 (built fresh: a new quote on the live curve, cap = cost + 5%, simulated, balance checked), signs it
// alone, the server verifies it is the reviewed one (wallet guards tolerated), broadcasts, confirms and checks the
// author's account gained exactly the reviewed tokens (buy_v2 is exact-out). A sniper between tx1 and tx2 only makes
// tx2 fail on its cap (nothing lost but the fee); the author may try again at the new price, or skip the buy.
const DEV_BUY_BUILDABLE = ['pending', 'failed'];

function launchWithBuy(db, project, wallet) {
  const launch = db.get('SELECT * FROM launches WHERE project_id = ?', project.id);
  if (!launch) throw new HttpError(409, 'not_launched', 'the coin is not launched yet: the dev buy comes right after the launch');
  if (!launch.dev_buy_status) throw new HttpError(409, 'no_dev_buy', 'this launch has no separate dev buy');
  const intent = db.get('SELECT signer_wallet, config_json FROM launch_intents WHERE id = ?', launch.intent_id);
  if (intent.signer_wallet !== wallet) throw new HttpError(403, 'not_signer');
  return { launch, config: parseJson(intent.config_json) };
}

/** What the author sees of an attempt (the same shape as createIntent's answer, plus the attempt). */
function attemptAnswer(provider, a, extra = {}) {
  return { attemptId: a.id, step: 2, mint: a.mint, txBase64: a.tx_base64, messageHash: a.tx_message_hash, estimate: a.estimate_json ? parseJson(a.estimate_json) : null,
    lastValidBlockHeight: a.last_valid_block_height, mock: provider.isMock, txBytes: a.tx_base64 ? Buffer.from(a.tx_base64, 'base64').length : null,
    requestedLamports: a.requested_lamports, costLamports: a.cost_lamports, maxLamports: a.max_lamports, tokensBase: a.tokens_base,
    ...(provider.isMock ? { mockSigningText: mockSigningText(a.tx_message_hash) } : {}),
    ...review(provider, a.tx_base64, a.network, a.signer_wallet), ...extra };
}

/** provider.prepareDevBuy with the checks the author must see as a sentence; every simulation is logged. */
async function buildDevBuyChecked(provider, args, opts = {}) {
  let built;
  try { built = await provider.prepareDevBuy(args, opts); } catch (e) {
    if (e?.code) throw new HttpError(409, e.code, e.message);    // no_curve, curve_complete, buy_completes_curve, buy_too_small
    throw e;
  }
  const est = built.estimate || {};
  log.info('dev buy simulation', { mint: args.mint, ok: est.simulation?.ok ?? null, err: est.simulation?.err ?? null, units: est.simulation?.unitsConsumed ?? null,
    bytes: built.txBytes ?? null, refresh: Boolean(opts.reuse), tokens: est.initialBuyTokensBase ?? null, maxLamports: est.initialBuyMaxLamports ?? null, phantomSafe: est.phantomSafe ?? null });
  if (!est.simulation || est.simulation.ok !== true) {
    if (est.simulation?.logs) log.warn('dev buy simulation logs', { mint: args.mint, logs: est.simulation.logs });
    const err = new HttpError(409, 'simulation_failed', devBuySimulationMessage(est, args.lamports));
    err.priceMoved = PRICE_MOVED_RE.test(simulationText(est).text);
    throw err;
  }
  if (est.signerBalanceLamports != null && est.networkFeeLamports != null && est.accountsLamports != null) {
    const extra = est.networkFeeLamports + est.accountsLamports, buy = Number(est.initialBuyLamports) || 0;
    if (est.signerBalanceLamports < buy + extra) throw new HttpError(409, 'insufficient_funds', fundsMessage(est.signerBalanceLamports, buy, extra, true));
  }
  return built;
}

/** Before a new tx2 exists, every earlier one must be provably dead (a signed copy can land until its blockhash
 *  expires; two landing would buy twice). Open -> wait; landed -> verify it instead of buying again. */
async function settleEarlierDevBuys(db, provider, project) {
  const old = db.all(`SELECT * FROM dev_buy_attempts WHERE project_id = ? AND status IN ('cancelled','expired') AND (error IS NULL OR error NOT LIKE '%[final]%')`, project.id);
  for (const a of old) {
    const c = await provider.devBuyLandCheck(a);
    if (c.state === 'open') throw new HttpError(409, 'previous_open', `the previous dev buy transaction could still land for about ${Math.ceil((c.blocksLeft ?? 150) * 0.4)} more seconds; try again after that`);
    if (c.state === 'landed') {
      db.tx(() => {
        db.run(`UPDATE dev_buy_attempts SET status = 'submitted', tx_signature = ?, error = NULL, updated_at = ? WHERE id = ?`, c.signature, now(), a.id);
        db.run(`UPDATE launches SET dev_buy_status = 'submitted' WHERE project_id = ?`, project.id);
        enqueue(db, { type: 'confirm_dev_buy', key: `confirm-buy:${a.id}:landed`, ideaId: project.idea_id, projectId: project.id, payload: { attemptId: a.id } });
      });
      throw new HttpError(409, 'previous_landed', 'an earlier dev buy transaction landed after all; it is being verified instead of buying again');
    }
    db.run(`UPDATE dev_buy_attempts SET error = COALESCE(error, '') || ' [final]' WHERE id = ?`, a.id);
  }
}

/** Owner asks for tx2. Resumes the waiting one (reload, double click), else builds a fresh one. */
export async function createDevBuy(db, cfg, project, wallet) {
  if (isPaused(db, 'launch')) throw new HttpError(503, 'paused', 'launches are paused');
  const { launch } = launchWithBuy(db, project, wallet);
  const provider = getProvider(cfg, db);
  if (launch.dev_buy_status === 'awaiting_signature') {
    const pending = db.get(`SELECT * FROM dev_buy_attempts WHERE project_id = ? AND status = 'awaiting_signature'`, project.id);
    if (pending) return attemptAnswer(provider, pending, { resumed: true });
  }
  if (!DEV_BUY_BUILDABLE.includes(launch.dev_buy_status)) throw new HttpError(409, 'bad_state', `the dev buy is ${launch.dev_buy_status.replace(/_/g, ' ')}`);
  if (db.get(`SELECT 1 FROM dev_buy_attempts WHERE project_id = ? AND error LIKE 'landed:%'`, project.id)) {
    throw new HttpError(409, 'landed_unverified', 'an earlier dev buy landed but failed verification; an admin must look at it first');
  }
  await settleEarlierDevBuys(db, provider, project);
  const lamports = Number(launch.dev_buy_lamports);
  const built = await buildDevBuyChecked(provider, { mint: launch.mint, signer: wallet, lamports });
  const est = built.estimate || {};
  const attemptId = id('devbuy'), t = now();
  db.tx(() => {
    db.run(`INSERT INTO dev_buy_attempts (id, project_id, intent_id, mint, signer_wallet, network, status, requested_lamports, cost_lamports, max_lamports, tokens_base,
              tx_base64, tx_message_hash, last_valid_block_height, estimate_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'awaiting_signature', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, attemptId, project.id, launch.intent_id, launch.mint, wallet, launch.network,
    lamports, est.initialBuyLamports ?? null, est.initialBuyMaxLamports ?? null, est.initialBuyTokensBase != null ? String(est.initialBuyTokensBase) : null,
    built.txBase64, built.messageHash, built.lastValidBlockHeight, JSON.stringify(est), t, t);
    db.run(`UPDATE launches SET dev_buy_status = 'awaiting_signature' WHERE project_id = ?`, project.id);
    note(db, project.idea_id, provider.isMock ? 'MOCK dev buy ready for your wallet (step 2)' : 'dev buy transaction ready for your wallet (step 2)', { actor: `wallet:${wallet}` });
  });
  return attemptAnswer(provider, db.get('SELECT * FROM dev_buy_attempts WHERE id = ?', attemptId));
}

/** Right before the wallet opens: the SAME buy (same tokens, same cap: the review stays true) with a fresh blockhash.
 *  If the price moved past the cap meanwhile the attempt is cancelled and the author reads why. */
export async function refreshDevBuy(db, cfg, project, wallet) {
  const provider = getProvider(cfg, db);
  const a = db.get(`SELECT * FROM dev_buy_attempts WHERE project_id = ? AND status = 'awaiting_signature'`, project.id);
  if (!a) throw new HttpError(409, 'no_intent', 'no dev buy transaction is waiting for a signature');
  if (a.signer_wallet !== wallet) throw new HttpError(403, 'not_signer');
  if (provider.isMock) return attemptAnswer(provider, a, { resumed: true });
  let built;
  try {
    built = await buildDevBuyChecked(provider, { mint: a.mint, signer: wallet, lamports: a.requested_lamports },
      { reuse: { tokensBase: a.tokens_base, costLamports: a.cost_lamports, maxLamports: a.max_lamports } });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) {
      db.tx(() => {
        db.run(`UPDATE dev_buy_attempts SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_signature'`, `before signing: ${e.message.slice(0, 200)}`, now(), a.id);
        db.run(`UPDATE launches SET dev_buy_status = 'pending' WHERE project_id = ? AND dev_buy_status = 'awaiting_signature'`, project.id);
      });
    }
    throw e;
  }
  db.run(`UPDATE dev_buy_attempts SET tx_base64 = ?, tx_message_hash = ?, last_valid_block_height = ?, estimate_json = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_signature'`,
    built.txBase64, built.messageHash, built.lastValidBlockHeight, JSON.stringify(built.estimate ?? null), now(), a.id);
  return attemptAnswer(provider, db.get('SELECT * FROM dev_buy_attempts WHERE id = ?', a.id), { resumed: true, refreshed: true });
}

/** tx2 signed: verify it is the reviewed one, persist the signature, then broadcast. */
export async function submitDevBuy(db, cfg, project, wallet, signed) {
  const provider = getProvider(cfg, db);
  const a = db.get(`SELECT * FROM dev_buy_attempts WHERE project_id = ? AND status = 'awaiting_signature'`, project.id);
  if (!a) throw new HttpError(409, 'no_intent', 'no dev buy transaction is waiting for a signature');
  if (a.signer_wallet !== wallet) throw new HttpError(403, 'not_signer');
  let checked;
  try { checked = await provider.verifyDevBuySigned(a, signed); } catch (e) { throw new HttpError(400, 'bad_signed_tx', e.message); }
  db.tx(() => {
    db.run(`UPDATE dev_buy_attempts SET status = 'submitted', tx_signature = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_signature'`, checked.signature, now(), a.id);
    db.run(`UPDATE launches SET dev_buy_status = 'submitted' WHERE project_id = ?`, project.id);
    note(db, project.idea_id, 'dev buy signed; broadcast and waiting for the network', { actor: `wallet:${wallet}`, data: { signature: checked.signature } });
  });
  let uncertain = false;
  try {
    await provider.submit(db.get('SELECT * FROM dev_buy_attempts WHERE id = ?', a.id), checked.raw);
  } catch (e) {
    if (e.rejected) {
      const why = PRICE_MOVED_RE.test(String(e.message)) ? PRICE_MOVED_NOTE : `the network rejected the dev buy before it ran (${String(e.message).slice(0, 120)}); nothing was bought`;
      db.tx(() => {
        db.run(`UPDATE dev_buy_attempts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, `preflight: ${String(e.message).slice(0, 280)}`, now(), a.id);
        db.run(`UPDATE launches SET dev_buy_status = 'failed' WHERE project_id = ?`, project.id);
        note(db, project.idea_id, why);
      });
      throw new HttpError(400, 'rejected', why);
    }
    uncertain = true;
    note(db, project.idea_id, 'dev buy broadcast answer unclear; checking the network for the transaction', { actor: 'system' });
  }
  enqueue(db, { type: 'confirm_dev_buy', key: `confirm-buy:${a.id}:0`, ideaId: project.idea_id, projectId: project.id, payload: { attemptId: a.id } });
  return { signature: checked.signature, uncertain };
}

/** The wallet declined, or the author walked away from tx2: back to 'pending' (a new one waits for this one's window). */
export function abandonDevBuy(db, project, wallet, reason = 'signature request cancelled') {
  const a = db.get(`SELECT * FROM dev_buy_attempts WHERE project_id = ? AND status = 'awaiting_signature'`, project.id);
  if (!a) throw new HttpError(409, 'no_intent', 'no dev buy transaction is waiting for a signature');
  if (a.signer_wallet !== wallet) throw new HttpError(403, 'not_signer');
  db.tx(() => {
    db.run(`UPDATE dev_buy_attempts SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ?`, reason, now(), a.id);
    db.run(`UPDATE launches SET dev_buy_status = 'pending' WHERE project_id = ?`, project.id);
    note(db, project.idea_id, `dev buy: ${reason}; nothing was bought`, { actor: `wallet:${wallet}` });
  });
}

/** The author skips the dev buy (final). A waiting, unsigned tx2 is cancelled with it. */
export function skipDevBuy(db, project, wallet) {
  const { launch } = launchWithBuy(db, project, wallet);
  if (!['pending', 'failed', 'awaiting_signature'].includes(launch.dev_buy_status)) {
    throw new HttpError(409, 'bad_state', launch.dev_buy_status === 'submitted' ? 'the dev buy is already on its way to the network' : `the dev buy is ${launch.dev_buy_status}`);
  }
  db.tx(() => {
    db.run(`UPDATE dev_buy_attempts SET status = 'cancelled', error = 'skipped by the author', updated_at = ? WHERE project_id = ? AND status = 'awaiting_signature'`, now(), project.id);
    db.run(`UPDATE launches SET dev_buy_status = 'skipped' WHERE project_id = ?`, project.id);
    note(db, project.idea_id, 'dev buy skipped by the author; nothing was bought', { actor: `wallet:${wallet}` });
  });
  return { status: 'skipped' };
}

/** confirm_dev_buy job: resolve one submitted tx2. "launched" never depends on it. */
export async function confirmDevBuy(db, cfg, attemptId, progress = () => {}) {
  const provider = getProvider(cfg, db);
  const a = db.get('SELECT * FROM dev_buy_attempts WHERE id = ?', attemptId);
  if (!a) throw new Permanent('dev buy attempt not found');
  if (a.status !== 'submitted') return { state: `attempt is ${a.status}` };
  const project = db.get('SELECT * FROM projects WHERE id = ?', a.project_id);
  const setLaunch = (s) => db.run('UPDATE launches SET dev_buy_status = ? WHERE project_id = ?', s, a.project_id);
  const st = await provider.devBuyStatus(a);
  progress(`network status: ${st.state}`);
  if (st.state === 'pending' || st.state === 'confirmed') throw new Defer(`waiting for finalization (${st.state})`, 4000);
  if (st.state === 'expired') {
    db.tx(() => {
      db.run(`UPDATE dev_buy_attempts SET status = 'expired', error = 'blockhash expired before the transaction landed', updated_at = ? WHERE id = ?`, now(), a.id);
      setLaunch('pending');
      note(db, project.idea_id, 'the dev buy expired before it landed; nothing was bought. Try again, or skip it.');
    });
    return { state: 'expired' };
  }
  if (st.state === 'failed') {
    const why = PRICE_MOVED_RE.test(st.err) ? PRICE_MOVED_NOTE : `the dev buy failed on-chain (${String(st.err).slice(0, 120)}); nothing was bought but the network fee. Try again, or skip it`;
    db.tx(() => {
      db.run(`UPDATE dev_buy_attempts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, st.err, now(), a.id);
      setLaunch('failed');
      note(db, project.idea_id, why);
    });
    return { state: 'failed' };
  }
  const v = await provider.verifyDevBuy(a);
  if (!v.ok && v.retry) throw new Defer('finalized, but not visible yet on this RPC node; checking again', 15_000);
  if (!v.ok) {
    db.tx(() => {
      db.run(`UPDATE dev_buy_attempts SET status = 'failed', error = 'landed: on-chain verification failed', verification = ?, updated_at = ? WHERE id = ?`, JSON.stringify(v.checks), now(), a.id);
      setLaunch('failed');
      audit(db, { actor: 'system', kind: 'dev_buy_mismatch', ideaId: project.idea_id, projectId: project.id, message: 'a dev buy landed but did not match its review', data: { checks: v.checks } });
      note(db, project.idea_id, 'the dev buy landed but did not match what you reviewed; an admin has been alerted', { data: { checks: v.checks } });
    });
    return { state: 'verification_failed', checks: v.checks };
  }
  const intent = db.get('SELECT config_json FROM launch_intents WHERE id = ?', a.intent_id);
  const tokens = a.tokens_base && !provider.isMock ? tokensText(a.tokens_base, parseJson(intent?.config_json)) : null;
  db.tx(() => {
    db.run(`UPDATE dev_buy_attempts SET status = 'done', verification = ?, updated_at = ? WHERE id = ?`, JSON.stringify(v.checks), now(), a.id);
    setLaunch('done');
    note(db, project.idea_id, `${provider.isMock ? 'MOCK ' : ''}dev buy: ${solString(a.cost_lamports ?? a.requested_lamports)} SOL${tokens ? ` for ${tokens} tokens` : ''}, in your wallet`,
      { data: { signature: a.tx_signature, tokensBase: a.tokens_base, checks: v.checks.length } });
  });
  return { state: 'done' };
}

/** The owner's view of step 2 (GET /api/projects/:slug): null when the launch has no separate dev buy. */
export function devBuyView(db, provider, project) {
  const launch = db.get('SELECT dev_buy_status, dev_buy_lamports FROM launches WHERE project_id = ?', project.id);
  if (!launch?.dev_buy_status) return null;
  const a = db.get('SELECT * FROM dev_buy_attempts WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', project.id);
  return { status: launch.dev_buy_status, lamports: launch.dev_buy_lamports, slippageBps: INITIAL_BUY_SLIPPAGE_BPS,
    attempt: a ? { id: a.id, status: a.status, signature: a.tx_signature, error: a.error ? a.error.replace(/ \[final\]$/, '') : null, costLamports: a.cost_lamports,
      maxLamports: a.max_lamports, tokensBase: a.tokens_base, verification: a.verification ? parseJson(a.verification) : null,
      explorerTx: a.tx_signature ? provider?.explorerTx?.(a.tx_signature) ?? null : null, updatedAt: a.updated_at } : null };
}

// --- fee ledger ---------------------------------------------------------------------------------------------------
export async function reconcileFees(db, cfg, projectId) {
  const provider = getProvider(cfg, db);
  const launch = db.get('SELECT * FROM launches WHERE project_id = ?', projectId);
  if (!launch) throw new Permanent('not launched');
  if (launch.provider !== provider.name) throw new Permanent('launched with another provider');
  const intent = db.get('SELECT * FROM launch_intents WHERE id = ?', launch.intent_id);
  const config = parseJson(intent.config_json);
  const obs = await provider.readFees(launch, config);
  const t = now();
  db.tx(() => {
    for (const o of obs) {
      db.run(`INSERT INTO fee_observations (id, project_id, kind, account, recipient, lamports, tx_signature, slot, block_time, source, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, id('fee'), projectId, o.kind, o.account ?? null,
      o.recipient ?? null, o.lamports, o.txSignature ?? null, o.slot ?? null, o.blockTime ?? null,
      provider.isMock ? 'mock' : `rpc:${cfg.launch.network}`, t);
    }
  });
  return { observations: obs.length };
}

/** Public ledger view for one project. Every number cites its observation; nothing is estimated from volume. */
export function feeLedger(db, projectId) {
  const launch = db.get('SELECT * FROM launches WHERE project_id = ?', projectId);
  if (!launch) return null;
  const intent = db.get('SELECT config_json FROM launch_intents WHERE id = ?', launch.intent_id);
  const config = parseJson(intent.config_json);
  const latestVault = db.all(`SELECT * FROM fee_observations WHERE project_id = ? AND kind = 'vault_balance'
    AND observed_at = (SELECT MAX(observed_at) FROM fee_observations WHERE project_id = ? AND kind = 'vault_balance')`, projectId, projectId);
  const payouts = db.all(`SELECT * FROM fee_observations WHERE project_id = ? AND kind IN ('distribution','payout','claim') ORDER BY block_time DESC`, projectId);
  const undistributed = latestVault.reduce((s, o) => s + o.lamports, 0);
  const paidTotal = payouts.reduce((s, o) => s + o.lamports, 0);
  const recipients = config.feeSharing.recipients.map((r) => ({
    ...r,
    // only meaningful when the vault belongs to this project alone
    estimatedShareOfUndistributed: config.feeSharing.mode === 'sharing_config' ? Math.floor((undistributed * r.bps) / 10000) : null,
    confirmedPayouts: payouts.filter((p) => p.recipient === r.wallet).reduce((s, o) => s + o.lamports, 0),
  }));
  return {
    mode: config.feeSharing.mode, locked: config.feeSharing.locked, network: launch.network, provider: launch.provider,
    mock: launch.provider === 'mock',
    tradingFees: config.tradingFees,
    verifiedUndistributedLamports: latestVault.length ? undistributed : null,
    vaultScope: config.feeSharing.mode === 'sharing_config' ? 'this project only' : 'the creator wallet\'s vault (all coins it created)',
    vaultObservedAt: latestVault[0]?.observed_at ?? null, vaultSlot: latestVault[0]?.slot ?? null,
    vaultAccounts: latestVault.map((o) => o.account),
    verifiedAccruedLamports: latestVault.length ? undistributed + paidTotal : null,
    confirmedPayoutsLamports: paidTotal,
    payouts: payouts.map((p) => ({ recipient: p.recipient, lamports: p.lamports, tx: p.tx_signature, blockTime: p.block_time, kind: p.kind })),
    recipients,
  };
}

export { isSolanaAddress };
