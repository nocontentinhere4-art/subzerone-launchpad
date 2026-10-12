// The holder tools' chain layer (docs/SITE-KIT.md "Holder tools"): a paced, budgeted JSON-RPC client, the pump.fun
// event decoders (the official @pump-fun/pump-sdk coder, as launch/pumpfun.js uses it for DistributeCreatorFeesEvent),
// the incremental signature walker behind the trades / dev / fee feeds, and the pure math of each view. Read-only:
// nothing here builds, signs or sends a transaction. Honest data: a number that was not read is null (the page shows
// "—" and says why); nothing is estimated from volume or extrapolated.
import { createRequire } from 'node:module';
import { getSetting, setSetting } from './db.js';
import { now, utcDay } from './util.js';

const require = createRequire(import.meta.url);
let _sdk = null;
function sdk() {
  if (!_sdk) _sdk = { web3: require('@solana/web3.js'), spl: require('@solana/spl-token'), pump: require('@pump-fun/pump-sdk') };
  return _sdk;
}

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN_DECIMALS = 6;                                  // pump.fun coins
const EVENT_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');        // Anchor's self-CPI event instruction (sha256("anchor:event")[0..8])
const PAGE = 1000;                                                // getSignaturesForAddress maximum

export class ChainError extends Error {
  constructor(message, code = 'chain_error') { super(message); this.code = code; }
}

// --- RPC -------------------------------------------------------------------------------------------------------------
/** Which endpoint reads a coin on `network`: ONCHAIN_RPC_URL, else Helius (mainnet), else SOLANA_RPC_URL when it is that
 * network's, else the network's public endpoint (rate limited; the client paces itself). -> {url, label} */
export function chainRpcUrl(cfg, network) {
  if (cfg.onchain?.rpcUrl) return { url: cfg.onchain.rpcUrl, label: 'configured RPC (ONCHAIN_RPC_URL)' };
  if (network === 'mainnet-beta' && cfg.coinStats?.heliusUrl) return { url: cfg.coinStats.heliusUrl, label: 'Helius RPC (mainnet)' };
  if (network === cfg.launch?.network && cfg.launch?.rpcUrl) return { url: cfg.launch.rpcUrl, label: `Solana RPC (${network})` };
  if (network === 'devnet') return { url: 'https://api.devnet.solana.com', label: 'public Solana RPC (devnet)' };
  return { url: 'https://api.mainnet-beta.solana.com', label: 'public Solana RPC (mainnet)' };
}

/** Calls used today by the holder tools (settings `onchain.calls`, UTC day) and what is left of ONCHAIN_DAILY_CALLS. */
export function chainBudget(db, cfg, t = now()) {
  const day = utcDay(t), s = getSetting(db, 'onchain.calls', null);
  const used = s?.day === day ? Number(s.calls) || 0 : 0;
  return { day, used, left: Math.max(0, (cfg.onchain?.dailyCalls ?? 15000) - used) };
}

/** A JSON-RPC client: paced (public endpoints slower), retried on 429 / 5xx with backoff, counted against the daily budget.
 * -> call(method, params) resolving to `result`, or a ChainError. */
export function createRpc({ db, cfg, url, fetchImpl = fetch, minGapMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const gap = minGapMs ?? (/api\.(mainnet-beta|devnet)\.solana\.com/.test(url) ? 450 : 110);
  let next = 0;
  return async function call(method, params) {
    for (let attempt = 0; ; attempt++) {
      if (db && chainBudget(db, cfg).left <= 0) throw new ChainError('the chain reader used its daily call budget; it resumes tomorrow (UTC)', 'budget');
      const wait = next - Date.now();
      next = Math.max(Date.now(), next) + gap;
      if (wait > 0) await sleep(wait);
      if (db) { const b = chainBudget(db, cfg); setSetting(db, 'onchain.calls', { day: b.day, calls: b.used + 1 }, 'onchain'); }
      let r;
      try {
        r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      } catch (e) {
        if (attempt < 2) { await sleep(800 * 2 ** attempt); continue; }
        throw new ChainError(`RPC unreachable (${String(e?.message || e).slice(0, 80)})`);
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
        throw new ChainError(`RPC answered ${r.status}`, r.status === 429 ? 'rate_limited' : 'chain_error');
      }
      let j;
      try { j = await r.json(); } catch { throw new ChainError(`RPC answered ${r.status} without JSON`); }
      if (j.error) {
        if (/rate|too many/i.test(String(j.error.message)) && attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
        throw new ChainError(`RPC ${method}: ${String(j.error.message || 'error').slice(0, 120)}`);
      }
      return j.result;
    }
  };
}

// --- decoding (pure) -------------------------------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', B58MAP = Object.fromEntries([...B58].map((c, i) => [c, BigInt(i)]));
/** base58 of any length (instruction data; util.js b58decode is for keys and signatures and caps the length). */
export function b58bytes(str) {
  let v = 0n;
  for (const ch of str) { const d = B58MAP[ch]; if (d === undefined) throw new Error('bad base58'); v = v * 58n + d; }
  const hex = v === 0n ? '' : v.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  let zeros = 0;
  while (str[zeros] === '1') zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}
let _names = null;
const eventNames = () => (_names ??= new Map(sdk().pump.pumpIdl.events.map((e) => [Buffer.from(e.discriminator).toString('hex'), e.name])));

/** All account keys of a getTransaction (encoding json) answer, in index order (static, then loaded writable, readonly). */
export function txKeys(tx) {
  const m = tx?.transaction?.message || {};
  const keys = (m.accountKeys || []).map((k) => (typeof k === 'string' ? k : k?.pubkey));
  return [...keys, ...(tx?.meta?.loadedAddresses?.writable || []), ...(tx?.meta?.loadedAddresses?.readonly || [])];
}

/** Pure. The pump program's events in a transaction: [{name, data}] (data = the body after the 8-byte discriminator).
 * Read from the self-CPI event instructions (never truncated); from the program's own "Program data:" log lines when
 * those hold more (older layouts, or no inner instructions in the answer). Never both: no event is counted twice. */
export function pumpEvents(tx) {
  const names = eventNames(), keys = txKeys(tx);
  const cpi = [];
  for (const g of tx?.meta?.innerInstructions || []) {
    for (const ix of g.instructions || []) {
      if (keys[ix.programIdIndex] !== PUMP) continue;
      let b;
      try { b = b58bytes(String(ix.data)); } catch { continue; }
      if (b.length < 16 || !b.subarray(0, 8).equals(EVENT_TAG)) continue;
      const name = names.get(b.subarray(8, 16).toString('hex'));
      if (name) cpi.push({ name, data: b.subarray(16) });
    }
  }
  const logs = [], stack = [];
  for (const line of tx?.meta?.logMessages || []) {
    let m;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if (line.startsWith('Program data: ') && stack[stack.length - 1] === PUMP) {
      const b = Buffer.from(line.slice(14), 'base64');
      const name = b.length >= 8 && names.get(b.subarray(0, 8).toString('hex'));
      if (name) logs.push({ name, data: b.subarray(8) });
    }
  }
  return cpi.length >= logs.length ? cpi : logs;
}

const n = (bn) => (bn == null ? 0 : Number(bn.toString()));
const key = (pk) => (pk?.toBase58 ? pk.toBase58() : pk == null ? null : String(pk));
const solLike = (q) => !q || q === WSOL || q === SYSTEM;

/** Pure. The bonding-curve trades of `mint` in a transaction, in event order:
 * [{idx, isBuy, quoteAmount, tokenAmount, user, fee, creatorFee, quoteMint, ixName, timestamp}] (base units). */
export function decodeTrades(tx, mint) {
  const { pump } = sdk();
  const out = [];
  let idx = 0;
  for (const e of pumpEvents(tx)) {
    if (e.name !== 'TradeEvent') continue;
    let ev;
    try { ev = pump.PUMP_SDK.decodeTradeEventBc(e.data); } catch { continue; }
    const at = idx++;
    if (key(ev.mint) !== mint) continue;
    const quoteMint = key(ev.quoteMint);
    out.push({ idx: at, isBuy: !!ev.isBuy, quoteAmount: solLike(quoteMint) ? n(ev.solAmount) : n(ev.quoteAmount) || n(ev.solAmount), tokenAmount: n(ev.tokenAmount),
      user: key(ev.user), fee: n(ev.fee), creatorFee: n(ev.creatorFee), quoteMint: solLike(quoteMint) ? WSOL : quoteMint, ixName: ev.ixName ? String(ev.ixName).slice(0, 32) : null,
      timestamp: n(ev.timestamp) });
  }
  return out;
}

/** Pure. DistributeCreatorFeesEvents of `mint`: [{distributed (lamports), shareholders: [{address, bps}], sharingConfig, timestamp}]. */
export function decodeDistributions(tx, mint) {
  const { pump } = sdk();
  const out = [];
  for (const e of pumpEvents(tx)) {
    if (e.name !== 'DistributeCreatorFeesEvent') continue;
    let ev;
    try { ev = pump.PUMP_SDK.decodeDistributeCreatorFeesEvent(e.data); } catch { continue; }
    if (key(ev.mint) !== mint) continue;
    out.push({ distributed: n(ev.distributed), shareholders: (ev.shareholders || []).map((s) => ({ address: key(s.address), bps: Number(s.shareBps) })),
      sharingConfig: key(ev.sharingConfig), timestamp: n(ev.timestamp) });
  }
  return out;
}

/** Pure. The CreateEvent of `mint` in a transaction (the launch), or null: {user, creator, timestamp}. */
export function decodeCreate(tx, mint) {
  const { pump } = sdk();
  for (const e of pumpEvents(tx)) {
    if (e.name !== 'CreateEvent') continue;
    try { const ev = pump.PUMP_SDK.decodeCreateEventBc(e.data); if (key(ev.mint) === mint) return { user: key(ev.user), creator: key(ev.creator), timestamp: n(ev.timestamp) }; } catch { /* other layout */ }
  }
  return null;
}

/** Pure. How much of `mint` the wallet `owner` gained (+) or lost (−) in a transaction, from its token balances (base units). */
export function ownerDelta(tx, mint, owner) {
  const sum = (list) => (list || []).filter((b) => b.mint === mint && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount || '0'), 0n);
  return Number(sum(tx?.meta?.postTokenBalances) - sum(tx?.meta?.preTokenBalances));
}
export const touches = (tx, program) => txKeys(tx).includes(program);

// --- the signature walker -------------------------------------------------------------------------------------------
/**
 * Brings one watched address's history up to date, a bounded step at a time:
 *   1. every signature newer than the cursor (paginated; the first walk takes the newest page);
 *   2. one page of older history, until the listing reaches the address's first transaction;
 *   3. at most `maxTx` not yet decoded transactions, newest first: `onTx(tx, row)` stores what it finds and may return
 *      per-transaction facts (kept in data_json). Failed transactions are never fetched.
 * -> {newSigs, fetched, ...historyOf}
 */
export async function syncAddress(db, rpc, { address, mint, kind, maxTx = 30, onTx, t = now() }) {
  let cur = db.get('SELECT * FROM chain_cursors WHERE address = ?', address);
  if (!cur) {
    db.run('INSERT INTO chain_cursors (address, mint, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', address, mint, kind);
    cur = db.get('SELECT * FROM chain_cursors WHERE address = ?', address);
  }
  const add = (list) => db.tx(() => {
    for (const s of list) {
      db.run(`INSERT INTO chain_sigs (address, signature, mint, slot, block_time, failed, done_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        address, s.signature, mint, s.slot, s.blockTime ?? null, s.err ? 1 : 0, s.err ? t : null);
    }
  });
  let listed = 0;
  // 1. newer than the cursor
  const fresh = [];
  let before = null;
  for (let page = 0; page < 10; page++) {
    const opts = { limit: PAGE, commitment: 'confirmed', ...(cur.newest_sig ? { until: cur.newest_sig } : {}), ...(before ? { before } : {}) };
    const got = (await rpc('getSignaturesForAddress', [address, opts])) || [];
    fresh.push(...got);
    if (got.length < PAGE || !cur.newest_sig) {                 // the first walk takes one page; older pages come in step 2
      if (!cur.newest_sig) db.run('UPDATE chain_cursors SET oldest_sig = ?, listed_all = ? WHERE address = ?', got[got.length - 1]?.signature ?? null, got.length < PAGE ? 1 : 0, address);
      break;
    }
    before = got[got.length - 1].signature;
  }
  if (fresh.length) {
    add(fresh);
    listed += fresh.length;
    db.run('UPDATE chain_cursors SET newest_sig = ? WHERE address = ?', fresh[0].signature, address);
  }
  cur = db.get('SELECT * FROM chain_cursors WHERE address = ?', address);
  // 2. one page of older history
  if (!cur.listed_all && cur.oldest_sig) {
    const got = (await rpc('getSignaturesForAddress', [address, { limit: PAGE, before: cur.oldest_sig, commitment: 'confirmed' }])) || [];
    add(got);
    listed += got.length;
    db.run('UPDATE chain_cursors SET oldest_sig = ?, listed_all = ? WHERE address = ?', got.length ? got[got.length - 1].signature : cur.oldest_sig, got.length < PAGE ? 1 : 0, address);
  }
  // 3. decode, newest first
  let fetched = 0;
  const todo = db.all('SELECT * FROM chain_sigs WHERE address = ? AND done_at IS NULL ORDER BY slot DESC LIMIT ?', address, maxTx);
  for (const row of todo) {
    const tx = await rpc('getTransaction', [row.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    fetched++;
    if (!tx) {                                                 // not served (yet) by this node: retried on the next polls, then set aside
      const tries = (JSON.parse(row.data_json || '{}').tries || 0) + 1;
      db.run('UPDATE chain_sigs SET data_json = ?, done_at = ? WHERE address = ? AND signature = ?', JSON.stringify(tries >= 3 ? { unreadable: true } : { tries }),
        tries >= 3 ? t : null, address, row.signature);
      continue;
    }
    const facts = db.tx(() => onTx(tx, row) ?? null);
    db.run('UPDATE chain_sigs SET done_at = ?, data_json = ?, block_time = COALESCE(block_time, ?) WHERE address = ? AND signature = ?',
      t, facts == null ? null : JSON.stringify(facts), tx.blockTime ?? null, address, row.signature);
  }
  db.run('UPDATE chain_cursors SET polled_at = ?, error = NULL WHERE address = ?', t, address);
  return { newSigs: listed, fetched, ...historyOf(db, address) };
}

/** Where a watched address's history stands: {complete, listed, done, pending, unreadable, oldestAt, listedAll}. unreadable:
 * transactions the RPC answered null three times (set aside so the rest moves on; the page says how many). */
export function historyOf(db, address) {
  const c = db.get('SELECT listed_all FROM chain_cursors WHERE address = ?', address);
  const s = db.get(`SELECT COUNT(*) listed, SUM(done_at IS NOT NULL) done, MIN(block_time) oldest, SUM(data_json = '{"unreadable":true}') unreadable FROM chain_sigs WHERE address = ?`, address);
  const listedAll = !!c?.listed_all, done = s.done || 0;
  return { complete: listedAll && done === s.listed, listedAll, listed: s.listed, done, pending: s.listed - done, unreadable: s.unreadable || 0, oldestAt: s.oldest == null ? null : s.oldest * 1000 };
}

/** Stores a transaction's trades of `mint` (idempotent). -> the trades. */
export function storeTrades(db, tx, signature, mint) {
  const trades = decodeTrades(tx, mint);
  for (const x of trades) {
    db.run(`INSERT INTO chain_trades (signature, idx, mint, slot, block_time, is_buy, quote_amount, token_amount, user, fee, creator_fee, quote_mint, ix_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, signature, x.idx, mint, tx.slot, tx.blockTime ?? (x.timestamp || null), x.isBuy ? 1 : 0,
    x.quoteAmount, x.tokenAmount, x.user, x.fee, x.creatorFee, x.quoteMint, x.ixName);
  }
  return trades;
}

// --- the views (pure) ------------------------------------------------------------------------------------------------
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10_000) / 100 : null);
export const shortKey = (w) => (w && w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w || '');

/** Concentration words for the risk line (top-10 share of the supply, liquidity accounts excluded). */
export const CONCENTRATION = Object.freeze({ high: 50, moderate: 25, whale: 10, circHigh: 80, circModerate: 50 });

/**
 * Pure. The holders view from token accounts [{address, owner, amount}] (base units): grouped by owner, sorted, the top
 * 20 with their share of the supply; `exclude` (owner -> label: the bonding curve, the PumpSwap pool) is listed but left
 * out of the concentration; `labels` (owner -> label) names known wallets. count: holders with a balance, when known.
 */
export function holdersView({ accounts, supply, exclude = new Map(), labels = new Map(), count = null, countExact = false, programOwned = () => false }) {
  const by = new Map();
  for (const a of accounts) {
    const amt = Number(a.amount) || 0;
    if (!a.owner || amt <= 0) continue;
    by.set(a.owner, (by.get(a.owner) || 0) + amt);
  }
  const rows = [...by.entries()].map(([owner, amount]) => ({ owner, amount })).sort((a, b) => b.amount - a.amount || (a.owner < b.owner ? -1 : 1));
  const top = rows.slice(0, 20).map((r, i) => ({ rank: i + 1, owner: r.owner, short: shortKey(r.owner), amount: r.amount, pct: pct(r.amount, supply),
    label: exclude.get(r.owner) || labels.get(r.owner) || (programOwned(r.owner) ? 'program account' : null), excluded: exclude.has(r.owner) }));
  const people = rows.filter((r) => !exclude.has(r.owner));
  const top10 = people.slice(0, 10).reduce((s, r) => s + r.amount, 0), top1 = people[0]?.amount || 0;
  const top10Pct = supply > 0 && people.length ? pct(top10, supply) : null, top1Pct = supply > 0 && people.length ? pct(top1, supply) : null;
  const excludedRows = rows.filter((r) => exclude.has(r.owner)).map((r) => ({ label: exclude.get(r.owner), pct: pct(r.amount, supply) }));
  // the tokens in circulation: the supply less what the excluded accounts hold (they are among the largest, so in the list)
  const circulating = supply - rows.filter((r) => exclude.has(r.owner)).reduce((s, r) => s + r.amount, 0);
  const top10CircPct = circulating > 0 && people.length ? pct(Math.min(top10, circulating), circulating) : null;
  return { holders: top, top10Pct, top1Pct, top10CircPct, excluded: excludedRows, count, countExact,
    risk: riskLine({ top10Pct, top1Pct, top10CircPct, excluded: excludedRows, wallets: Math.min(10, people.length) }) };
}

/** Pure. The plain-words risk line: "Top 10 wallets hold 62% of the supply: high concentration." The level is the worse of
 * the share of the whole supply (≥ 50% high, ≥ 25% moderate) and the share of the tokens in circulation, outside the
 * bonding curve and the pool (≥ 80% high, ≥ 50% moderate): early on the curve holds most of the supply, and a handful of
 * wallets can hold nearly everything that trades. */
export function riskLine({ top10Pct, top1Pct, top10CircPct = null, excluded = [], wallets = 10 }) {
  if (top10Pct == null) return { level: null, line: 'No holder data yet.' };
  const rank = (l) => ['low', 'moderate', 'high'].indexOf(l);
  const bySupply = top10Pct >= CONCENTRATION.high ? 'high' : top10Pct >= CONCENTRATION.moderate ? 'moderate' : 'low';
  const byCirc = top10CircPct == null ? 'low' : top10CircPct >= CONCENTRATION.circHigh ? 'high' : top10CircPct >= CONCENTRATION.circModerate ? 'moderate' : 'low';
  const level = rank(byCirc) > rank(bySupply) ? byCirc : bySupply;
  const words = { high: 'high concentration: a few wallets can move the price a lot', moderate: 'moderate concentration', low: 'spread out' }[level];
  const who = wallets === 10 ? 'Top 10 wallets' : `The ${wallets} wallet${wallets === 1 ? '' : 's'} holding it`;
  const circ = excluded.length && top10CircPct != null ? ` and ${fmtPct(top10CircPct)} of the tokens in circulation` : '';
  const parts = [`${who} hold ${fmtPct(top10Pct)} of the supply${circ}: ${words}.`];
  if (top1Pct != null && top1Pct >= CONCENTRATION.whale) parts.push(`The largest wallet alone holds ${fmtPct(top1Pct)}.`);
  const ex = excluded.filter((e) => e.pct != null);
  if (ex.length) parts.push(`Not counted: ${ex.map((e) => `${e.label} (${fmtPct(e.pct)})`).join(', ')}.`);
  return { level, line: parts.join(' ') };
}
const fmtPct = (p) => `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
const fmtTokens = (base) => {
  const v = base / 10 ** TOKEN_DECIMALS;
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${Math.round(v)}`;
};
const utc = (ms) => (ms == null ? 'an unknown time' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

/**
 * Pure. The dev watch: the author's balance against their dev buy, and every move of the coin in and out of the author's
 * token account. moves: [{signature, at, delta (base units), kind: 'dev buy'|'buy'|'sell'|'sell (PumpSwap)'|'out'|'in', quoteAmount}].
 * devBuy: base units bought in the launch transaction (null when unknown, 0 when none). complete: the account's whole
 * history was read.
 */
export function devView({ devBuy, balance, moves, complete }) {
  const outs = moves.filter((m) => m.delta < 0), sells = outs.filter((m) => m.kind.startsWith('sell'));
  const left = outs.reduce((s, m) => s - m.delta, 0), sold = sells.reduce((s, m) => s - m.delta, 0);
  const last = outs.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  const heldPct = devBuy > 0 && balance != null ? pct(Math.min(balance, devBuy), devBuy) : null;
  let line, level;
  if (balance == null) { line = 'The author wallet\'s balance could not be read just now.'; level = null; }
  else if (devBuy == null) { line = `The dev buy is not known for this coin; the author wallet holds ${fmtTokens(balance)} tokens now.`; level = null; }
  else if (devBuy === 0) {
    line = balance > 0 ? `The author made no dev buy at launch; the author wallet holds ${fmtTokens(balance)} tokens now.` : 'The author made no dev buy at launch and holds none of the coin.';
    level = balance > 0 ? 'info' : 'ok';
  } else if (!outs.length && balance >= devBuy) {
    line = balance > devBuy ? `Dev holds 100% of their dev buy (and ${fmtTokens(balance - devBuy)} more bought later).` : 'Dev holds 100% of their dev buy.';
    level = 'ok';
  } else {
    const soldPct = pct(Math.min(sold, devBuy), devBuy), leftPct = pct(Math.min(left, devBuy), devBuy);
    const what = sells.length && sold >= left ? `Dev sold ${fmtPct(soldPct)} of their dev buy` : sells.length ? `Dev sold ${fmtPct(soldPct)} and moved out ${fmtPct(pct(Math.min(left - sold, devBuy), devBuy))} more of their dev buy`
      : `${fmtPct(leftPct)} of the dev buy left the author wallet (a transfer, or a sale through another program)`;
    line = `${what}${last ? `, last at ${utc(last.at)}` : ''}. Holds ${fmtPct(heldPct ?? 0)} of it now.`;
    level = heldPct != null && heldPct < 50 ? 'warn' : 'info';
  }
  if (!complete) line += ' (History still loading: older transactions of the author account are not read yet.)';
  return { status: line, level, heldPct, sold, left, balance, devBuy, moves: moves.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) };
}

/**
 * Pure. The creator-fee ledger of one coin. sharing: the on-chain sharing config {address, adminRevoked, shareholders:
 * [{address, bps}]} or null; waiting: lamports read now {vault, curve, amm}; distributions: [{signature, at, lamports,
 * shareholders}]; fromTrades: {lamports, trades, complete} (the sum of the curve trades' creator fees, a cross-check).
 * accrued = distributed + waiting: both read on chain, so it holds whether or not the trade history is complete.
 */
export function feesView({ sharing, waiting, distributions, fromTrades = null, labels = new Map() }) {
  const w = waiting || {};
  const known = ['vault', 'curve', 'amm'].filter((k) => w[k] != null);
  const waitingTotal = known.length ? known.reduce((s, k) => s + w[k], 0) : null;
  const distributed = distributions.reduce((s, d) => s + d.lamports, 0);
  const accrued = waitingTotal == null ? null : distributed + waitingTotal;
  const shareholders = (sharing?.shareholders || []).map((s) => ({ address: s.address, short: shortKey(s.address), bps: s.bps, pct: s.bps / 100, label: labels.get(s.address) || null,
    accrued: accrued == null ? null : Math.floor((accrued * s.bps) / 10_000),
    received: distributions.reduce((sum, d) => sum + Math.floor((d.lamports * ((d.shareholders || []).find((x) => x.address === s.address)?.bps ?? 0)) / 10_000), 0),
    waiting: waitingTotal == null ? null : Math.floor((waitingTotal * s.bps) / 10_000) }));
  return { accrued, distributed, waiting: waitingTotal, waitingParts: w, distributions: distributions.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0)), shareholders,
    fromTrades, adminRevoked: sharing?.adminRevoked ?? null, sharingConfig: sharing?.address ?? null };
}

// --- account reads ---------------------------------------------------------------------------------------------------
export const pdas = (mint) => {
  const { web3, pump, spl } = sdk();
  const m = new web3.PublicKey(mint);
  const sharing = pump.feeSharingConfigPda(m);
  return { curve: pump.bondingCurvePda(m).toBase58(), sharing: sharing.toBase58(), pool: pump.canonicalPumpPoolPda(m).toBase58(),
    vaultOf: (creator) => pump.creatorVaultPda(new web3.PublicKey(creator)).toBase58(),
    ammVaultAtaOf: (creator) => spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, pump.ammCreatorVaultPda(new web3.PublicKey(creator)), true, spl.TOKEN_PROGRAM_ID).toBase58() };
};
export const ataOf = (mint, owner, token2022 = true) => {
  const { web3, spl } = sdk();
  return spl.getAssociatedTokenAddressSync(new web3.PublicKey(mint), new web3.PublicKey(owner), true, token2022 ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID).toBase58();
};
export const isOffCurve = (addr) => { try { const { web3 } = sdk(); return !web3.PublicKey.isOnCurve(new web3.PublicKey(addr).toBytes()); } catch { return false; } };

const accountData = (v) => (v?.data && Array.isArray(v.data) ? Buffer.from(v.data[0], 'base64') : null);
/** The bonding curve (decoded) or null when the account does not exist. */
export async function readCurve(rpc, curve) {
  const r = await rpc('getAccountInfo', [curve, { encoding: 'base64', commitment: 'confirmed' }]);
  const data = accountData(r?.value);
  if (!data) return null;
  const c = sdk().pump.PUMP_SDK.decodeBondingCurve({ data });
  return { complete: !!c.complete, creator: key(c.creator), creatorFee: n(c.creatorFee), virtualTokenReserves: n(c.virtualTokenReserves),
    virtualQuoteReserves: n(c.virtualQuoteReserves ?? c.virtualSolReserves), realTokenReserves: n(c.realTokenReserves), tokenTotalSupply: n(c.tokenTotalSupply), slot: r.context?.slot ?? null };
}
/** The fee sharing config (decoded) or null. */
export async function readSharing(rpc, address) {
  const r = await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  const data = accountData(r?.value);
  if (!data) return null;
  const sc = sdk().pump.PUMP_SDK.decodeSharingConfig({ data });
  return { address, adminRevoked: !!sc.adminRevoked, shareholders: (sc.shareholders || []).map((s) => ({ address: key(s.address), bps: Number(s.shareBps) })) };
}
