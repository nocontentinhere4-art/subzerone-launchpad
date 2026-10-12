// Per-mint stats of launched coins: the honest data feed behind the city's building lights ("at 10k holders the roof
// lights up, at 100k the giant sign appears"). Real numbers or nothing: every value carries its source and time, a
// holder count is counted (never estimated), a failed refresh keeps the last good value flagged fresh: false, and the
// mock source exists only with the mock launch provider (refused in production by config.js) and is marked source: 'mock'.
// Sources: DexScreener's public API (price, market cap, liquidity, 24 h volume and trades) and, only when HELIUS_URL or
// HELIUS_API_KEY is set, Helius DAS getTokenAccounts (holders = distinct owners with a balance, paginated and capped).
import { getSetting, setSetting } from './db.js';
import { Defer, enqueue } from './jobs.js';
import { log } from './log.js';
import { now, parseJson, sha256, utcDay } from './util.js';

// Tier thresholds (shown in GET /api/disclosure so the city can print them). A tier is reached by holders OR by the
// dollar line; holders is the preferred signal (`by` says which one lit the tier).
export const THRESHOLDS = Object.freeze({
  lit: Object.freeze({ holders: 1_000, volume24hUsd: 25_000 }),
  roof: Object.freeze({ holders: 10_000, marketCapUsd: 1_000_000 }),
  sign: Object.freeze({ holders: 100_000, marketCapUsd: 10_000_000 }),
});
export const TIER_NAMES = Object.freeze(['none', 'open', 'lit', 'roof', 'sign']);
export const TREND_PCT = 5;                                  // |priceChange.h24| under this = flat
// refresh cadence: every 5 min in the first 24 h after the verified launch, every 30 min after; fresh = within 2× cadence
export const CADENCE = Object.freeze({ youngMs: 5 * 60_000, settledMs: 30 * 60_000, youngUntilMs: 24 * 3_600_000 });
// holders cost Helius credits (one DAS call per page of 1,000 accounts): fetched less often than prices, at most
// maxPages pages per fetch (a bigger coin is reported as "at least" that many), and at most HELIUS_DAILY_PAGES a day.
export const HOLDERS = Object.freeze({ pageSize: 1000, maxPages: 20, youngEveryMs: 30 * 60_000, settledEveryMs: 2 * 3_600_000 });
export const DEX = Object.freeze({ source: 'dexscreener', label: 'DexScreener public API (api.dexscreener.com)', minGapMs: 2_000 });   // ≤ 30 req/min
export const HELIUS = Object.freeze({ source: 'helius', label: 'Helius DAS getTokenAccounts (mainnet.helius-rpc.com)' });
export const MOCK = Object.freeze({ source: 'mock', label: 'mock numbers: local development only, not from any chain' });

const num = (x) => {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (x, max = 64) => (typeof x === 'string' ? x.slice(0, max) : null);
const hasData = (s) => [s.holders?.count, s.priceUsd, s.marketCapUsd, s.volume24hUsd, s.liquidityUsd].some((v) => num(v) != null);

/** Pure. The tier of a stored stats object (or null): { tier: 0..4, name, by: 'holders'|'marketCap'|'volume'|null,
 * trend: 'up'|'down'|'flat'|null, fresh }. 0 none = no data at all; 1 open = launched with data; then THRESHOLDS. */
export function coinTier(stats, t = now()) {
  if (!stats || typeof stats !== 'object' || !hasData(stats)) return { tier: 0, name: 'none', by: null, trend: null, fresh: false };
  let tier = 1, by = null;
  const up = (n, k) => { if (n > tier) { tier = n; by = k; } };
  const holders = num(stats.holders?.count);
  if (holders != null) {
    if (holders >= THRESHOLDS.sign.holders) up(4, 'holders');
    else if (holders >= THRESHOLDS.roof.holders) up(3, 'holders');
    else if (holders >= THRESHOLDS.lit.holders) up(2, 'holders');
  }
  const mcap = num(stats.marketCapUsd);
  if (mcap != null) {
    if (mcap >= THRESHOLDS.sign.marketCapUsd) up(4, 'marketCap');
    else if (mcap >= THRESHOLDS.roof.marketCapUsd) up(3, 'marketCap');
  }
  const vol = num(stats.volume24hUsd);
  if (vol != null && vol >= THRESHOLDS.lit.volume24hUsd) up(2, 'volume');
  const pc = num(stats.priceChange24hPct);
  const trend = pc == null ? null : pc >= TREND_PCT ? 'up' : pc <= -TREND_PCT ? 'down' : 'flat';
  const at = num(stats.at);
  const fresh = at != null && t - at <= 2 * (num(stats.cadenceMs) || CADENCE.settledMs);
  return { tier, name: TIER_NAMES[tier], by, trend, fresh };
}

/** What /api/world carries for a launched public project. Never an error (that is the per-coin endpoint's). */
export function publicStats(stats, t = now()) {
  const s = stats && typeof stats === 'object' ? stats : null;
  const { tier, name, by, trend, fresh } = coinTier(s, t);
  return { tier, tierName: name, by, trend, fresh, holders: s?.holders ?? null, marketCapUsd: num(s?.marketCapUsd),
    volume24hUsd: num(s?.volume24hUsd), liquidityUsd: num(s?.liquidityUsd), priceChange24hPct: num(s?.priceChange24hPct),
    at: num(s?.at), source: s?.source ?? null, url: s?.url ?? null, ...(s?.source === MOCK.source ? { mock: true } : {}) };
}

// --- DexScreener ---------------------------------------------------------------------------------------------------
/** Pure. /latest/dex/tokens/{mint}: the Solana pair of this mint with the most liquidity; null when there is none. */
export function parseDexScreener(json, mint) {
  const pairs = (Array.isArray(json?.pairs) ? json.pairs : []).filter((p) => p && p.chainId === 'solana' && p.baseToken?.address === mint);
  pairs.sort((a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0));
  const p = pairs[0];
  if (!p) return null;
  const url = typeof p.url === 'string' && p.url.startsWith('https://dexscreener.com/') ? p.url.slice(0, 200) : null;
  return { pairs: pairs.length, dex: str(p.dexId, 32), pairAddress: str(p.pairAddress), priceUsd: num(p.priceUsd),
    marketCapUsd: num(p.marketCap) ?? num(p.fdv), fdvUsd: num(p.fdv), liquidityUsd: num(p.liquidity?.usd), volume24hUsd: num(p.volume?.h24),
    txns24h: { buys: num(p.txns?.h24?.buys), sells: num(p.txns?.h24?.sells) }, priceChange24hPct: num(p.priceChange?.h24),
    pairCreatedAt: num(p.pairCreatedAt), url };
}
const NO_PAIR = Object.freeze({ pairs: 0, dex: null, pairAddress: null, priceUsd: null, marketCapUsd: null, fdvUsd: null, liquidityUsd: null,
  volume24hUsd: null, txns24h: { buys: null, sells: null }, priceChange24hPct: null, pairCreatedAt: null, url: null });

export async function fetchDexScreener(mint, fetchImpl = fetch, signal) {
  const r = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
    { headers: { accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(10_000), redirect: 'error' });
  if (!r.ok) throw new Error(`dexscreener HTTP ${r.status}`);
  return parseDexScreener(await r.json(), mint);
}

// --- Helius DAS: holders -------------------------------------------------------------------------------------------
/** Distinct owners with a balance, page by page (cursor). Stops after `maxPages`: then exact: false, atLeast: true
 * (the count is a floor, never an estimate). `onPage` is called once per request made, for the daily budget. */
export async function fetchHolders(mint, { url, fetchImpl = fetch, signal, maxPages = HOLDERS.maxPages, onPage }) {
  const owners = new Set();
  let cursor = null, pages = 0;
  for (;;) {
    const params = { mint, limit: HOLDERS.pageSize, options: { showZeroBalance: false }, ...(cursor ? { cursor } : {}) };
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'coin-stats', method: 'getTokenAccounts', params }), signal: signal ?? AbortSignal.timeout(10_000), redirect: 'error' });
    pages++;
    onPage?.(pages);
    if (!r.ok) throw new Error(`helius HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`helius: ${str(j.error.message, 120) || 'error'}`);
    const accounts = Array.isArray(j.result?.token_accounts) ? j.result.token_accounts : [];
    for (const a of accounts) if (typeof a?.owner === 'string' && Number(a.amount) > 0) owners.add(a.owner);
    cursor = typeof j.result?.cursor === 'string' && j.result.cursor ? j.result.cursor : null;
    if (!cursor || accounts.length < HOLDERS.pageSize) return { count: owners.size, exact: true, atLeast: false, pages };
    if (pages >= maxPages) return { count: owners.size, exact: false, atLeast: true, pages };
  }
}

/** Pages spent today on Helius (settings `coin_stats.helius`, UTC day). */
export function heliusBudget(db, cfg, t = now()) {
  const day = utcDay(t);
  const s = getSetting(db, 'coin_stats.helius', null);
  const used = s?.day === day ? Number(s.pages) || 0 : 0;
  return { day, used, left: Math.max(0, cfg.coinStats.heliusDailyPages - used) };
}
const spendPages = (db, { day, used }, n) => setSetting(db, 'coin_stats.helius', { day, pages: used + n }, 'coin_stats');

// --- mock source (LAUNCH_PROVIDER=mock only) -----------------------------------------------------------------------
/** Deterministic fake numbers for a mock launch: a function of the mint and the coin's age (they grow for three days
 * so a dev can watch a building light up). Unmistakably marked: source 'mock', mock: true, no url. */
export function mockStats(mint, launchedAt, t = now()) {
  const h = sha256(`coin-stats:${mint}`);
  const seed = (i) => parseInt(h.slice(i * 8, i * 8 + 8), 16) / 0xffffffff;
  const ageH = Math.max(0, (t - launchedAt) / 3_600_000);
  const growth = 1 + Math.min(ageH, 72) * (0.5 + seed(1));
  const holders = Math.round((20 + seed(0) * 1200) * growth);
  const mcap = Math.round((2_000 + seed(2) * 50_000) * growth);
  const priceChange24hPct = Math.round((seed(4) - 0.4) * 600) / 10;
  return { mint, source: MOCK.source, sourceLabel: MOCK.label, mock: true, at: t, launchedAt, pairs: 0, dex: 'mock', pairAddress: null,
    priceUsd: mcap / 1e9, marketCapUsd: mcap, fdvUsd: mcap, liquidityUsd: Math.round(mcap * 0.12),
    volume24hUsd: Math.round(mcap * (0.2 + seed(3))), txns24h: { buys: Math.round(holders * 0.3), sells: Math.round(holders * 0.2) },
    priceChange24hPct, pairCreatedAt: launchedAt, url: null,
    holders: { count: holders, exact: true, atLeast: false, at: t, source: MOCK.source } };
}

// --- refresh (the coin_stats job) ----------------------------------------------------------------------------------
const cadenceFor = (launchedAt, t) => (t - launchedAt < CADENCE.youngUntilMs ? CADENCE.youngMs : CADENCE.settledMs);

/** Cross-process pacing of DexScreener calls: one every cfg.coinStats.dexGapMs (DEX.minGapMs by default), or Defer until the next free moment. */
function paceDex(db, cfg, t) {
  db.tx(() => {
    const next = Number(getSetting(db, 'coin_stats.dex_next_at', 0)) || 0;
    if (t < next) throw new Defer('dexscreener pacing', next - t);
    setSetting(db, 'coin_stats.dex_next_at', t + cfg.coinStats.dexGapMs, 'coin_stats');
  });
}

export const SAMPLES_KEEP_MS = 8 * 86_400_000;
/** One price / market-cap sample per good refresh (the token panel's sparkline, the chart tool); older than 8 days pruned. */
function sample(db, mint, stats, t) {
  const price = num(stats?.priceUsd), mcap = num(stats?.marketCapUsd);
  if (price == null && mcap == null) return;
  db.run('INSERT OR REPLACE INTO coin_samples (mint, at, price_usd, market_cap_usd) VALUES (?, ?, ?, ?)', mint, t, price, mcap);
  db.run('DELETE FROM coin_samples WHERE mint = ? AND at < ?', mint, t - SAMPLES_KEEP_MS);
}

function save(db, mint, stats, prevRow, t, error = null) {
  const ok = error == null ? 1 : 0;
  if (ok) sample(db, mint, stats, t);
  const json = ok ? JSON.stringify(stats) : prevRow?.json;
  if (!json) {                                              // first fetch failed: a row with no good value yet
    db.run(`INSERT INTO coin_stats (mint, json, fetched_at, checked_at, ok, error) VALUES (?, 'null', 0, ?, 0, ?)
            ON CONFLICT(mint) DO UPDATE SET checked_at = excluded.checked_at, ok = 0, error = excluded.error`, mint, t, error);
    return;
  }
  db.run(`INSERT INTO coin_stats (mint, json, fetched_at, checked_at, ok, error) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(mint) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at,
          ok = excluded.ok, error = excluded.error`, mint, json, ok ? t : prevRow.fetched_at, t, ok, error);
}

/** Fetch and store one mint's stats. A failed fetch keeps the last good json (ok = 0, error). -> { ok, tier, … } */
export async function refreshCoinStats(db, cfg, mint, { fetchImpl = fetch, signal, t = now() } = {}) {
  const launch = db.get('SELECT verified_at, provider FROM launches WHERE mint = ?', mint);
  if (!launch) return { skipped: 'not a launched mint' };
  const prevRow = db.get('SELECT json, fetched_at FROM coin_stats WHERE mint = ?', mint);
  const prev = parseJson(prevRow?.json);
  const cadenceMs = cadenceFor(launch.verified_at, t);
  if (launch.provider === 'mock') {
    if (cfg.launch.provider !== 'mock') return { skipped: 'mock launch under a real provider: no data' };
    const stats = { ...mockStats(mint, launch.verified_at, t), cadenceMs };
    save(db, mint, stats, prevRow, t);
    return { ok: true, source: MOCK.source, tier: coinTier(stats, t).tier };
  }
  paceDex(db, cfg, t);
  let stats;
  try {
    const dex = await fetchDexScreener(mint, fetchImpl, signal);
    stats = { mint, source: DEX.source, sourceLabel: DEX.label, at: t, cadenceMs, launchedAt: launch.verified_at, ...(dex || NO_PAIR),
      holders: cfg.coinStats.heliusUrl && prev?.holders?.source === HELIUS.source ? prev.holders : null };
  } catch (e) {
    const error = String(e?.message || e).slice(0, 300);
    save(db, mint, null, prevRow, t, error);
    log.warn('coin stats: refresh failed', { mint, error, kept: Boolean(prevRow?.json && prevRow.json !== 'null') });
    return { ok: false, error };
  }
  const holdersEvery = t - launch.verified_at < CADENCE.youngUntilMs ? HOLDERS.youngEveryMs : HOLDERS.settledEveryMs;
  if (cfg.coinStats.heliusUrl && (!stats.holders || t - (num(stats.holders.at) || 0) >= holdersEvery)) {
    const budget = heliusBudget(db, cfg, t);
    if (budget.left > 0) {
      let pages = 0;
      try {
        const h = await fetchHolders(mint, { url: cfg.coinStats.heliusUrl, fetchImpl, signal, maxPages: Math.min(HOLDERS.maxPages, budget.left), onPage: (n) => { pages = n; } });
        stats.holders = { count: h.count, exact: h.exact, atLeast: h.atLeast, at: t, source: HELIUS.source };
      } catch (e) {
        log.warn('coin stats: holders not fetched', { mint, error: String(e?.message || e).slice(0, 200), kept: Boolean(stats.holders) });
      } finally {
        if (pages) spendPages(db, budget, pages);
      }
    } else {
      log.info('coin stats: helius daily page budget used up', { mint, day: budget.day, pages: budget.used });
    }
  }
  save(db, mint, stats, prevRow, t);
  const tier = coinTier(stats, t);
  log.info('coin stats refreshed', { mint, tier: tier.name, holders: stats.holders?.count ?? null, pairs: stats.pairs });
  return { ok: true, source: stats.source, tier: tier.tier };
}

/** Worker sweep (every minute): one coin_stats job per launched mint per cadence slot, spread inside the first half of
 * the slot by a per-mint offset so the coins do not all hit DexScreener at once; the idempotency key makes a repeated
 * sweep a no-op. Finished rows older than a day are pruned (this is the only job type that runs forever). */
export function scheduleCoinStats(db, cfg, t = now()) {
  if (!cfg.coinStats.enabled) return 0;
  let n = 0;
  for (const l of db.all('SELECT project_id, mint, verified_at, provider FROM launches')) {
    if (l.provider === 'mock' && cfg.launch.provider !== 'mock') continue;
    const cadence = cadenceFor(l.verified_at, t);
    const slot = Math.floor(t / cadence) * cadence;
    const offset = parseInt(sha256(l.mint).slice(0, 8), 16) % Math.floor(cadence / 2);
    enqueue(db, { type: 'coin_stats', key: `coin_stats:${l.mint}:${slot}`, projectId: l.project_id, payload: { mint: l.mint }, runAfter: slot + offset });
    n++;
  }
  db.run(`DELETE FROM jobs WHERE type = 'coin_stats' AND status IN ('succeeded', 'cancelled', 'dead') AND updated_at < ?`, t - 86_400_000);
  return n;
}

/** GET /api/coins/:mint/stats: the full stored object for a launched PUBLIC project (else null), with ok/error. */
export function coinStatsView(db, mint, t = now()) {
  const row = db.get(`SELECT cs.json, cs.fetched_at, cs.checked_at, cs.ok, cs.error, l.verified_at, l.provider, p.slug, p.name, p.ticker, i.visibility
    FROM launches l JOIN projects p ON p.id = l.project_id JOIN ideas i ON i.id = p.idea_id LEFT JOIN coin_stats cs ON cs.mint = l.mint WHERE l.mint = ?`, mint);
  if (!row || row.visibility !== 'public') return null;
  const stats = parseJson(row.json);
  const pub = publicStats(stats, t);
  return { mint, slug: row.slug, name: row.name, ticker: row.ticker, launchedAt: row.verified_at, ...pub,
    priceUsd: num(stats?.priceUsd), txns24h: stats?.txns24h ?? { buys: null, sells: null }, pairCreatedAt: num(stats?.pairCreatedAt), dex: stats?.dex ?? null,
    sourceLabel: stats?.sourceLabel ?? null, cadenceMs: num(stats?.cadenceMs) ?? cadenceFor(row.verified_at, t),
    ok: row.ok == null ? null : row.ok === 1, error: row.ok === 0 ? row.error : null, checkedAt: row.checked_at ?? null,
    thresholds: THRESHOLDS, tiers: TIER_NAMES, trendPct: TREND_PCT, holdersCap: HOLDERS.pageSize * HOLDERS.maxPages };
}
