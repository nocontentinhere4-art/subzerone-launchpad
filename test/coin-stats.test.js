// Coin stats (coin-stats.js): the honest data feed behind the city's building lights. Real numbers or nothing: every
// value carries source and time, holders are counted (never estimated), a failed fetch keeps the last good value as
// fresh: false, mock numbers exist only with the mock provider and are marked, private projects get nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, makeEnv, user, drain, SUB01_WALLET, logs } from './helpers.js';
import { coinTier, publicStats, parseDexScreener, fetchDexScreener, fetchHolders, refreshCoinStats, scheduleCoinStats, coinStatsView,
  mockStats, heliusBudget, THRESHOLDS, TIER_NAMES, CADENCE, HOLDERS, DEX } from '../src/coin-stats.js';
import { worldView } from '../src/world.js';
import { claim, Defer } from '../src/jobs.js';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-token.json', import.meta.url), 'utf8'));
const MINT = 'FixtureMint1111111111111111111111111111111';
const HELIUS_URL = 'https://mainnet.helius-rpc.com/?api-key=test-key';

/** A verified launch inserted directly (the launch flow is covered in flow.test.js). */
function launched(db, wallet, { slug = 'ramen', mint = 'MintRamen', provider = 'mock', verifiedAt = Date.now(), visibility = 'public', plotId = null } = {}) {
  const t = verifiedAt;
  db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES (?, ?, 'launched', ?, ?, ?)`, `idea_${slug}`, wallet, visibility, t, t);
  db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES (?, ?, ?, 'Ramen', 'RAMEN', 'd', ?, ?)`, `prj_${slug}`, `idea_${slug}`, slug, t, t);
  const recipients = [{ label: 'Idea submitter', wallet, bps: 8000, role: 'submitter' }, { label: 'SUB-01', wallet: SUB01_WALLET, bps: 2000, role: 'sub01' }];
  db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at) VALUES (?, ?, 1, ?, 10000, 'locked', ?)`, `al_${slug}`, `prj_${slug}`, JSON.stringify(recipients), t);
  db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, created_at, updated_at)
          VALUES (?, ?, ?, 'n', '{}', 'h', ?, ?, ?, 'confirmed', ?, ?)`, `in_${slug}`, `prj_${slug}`, provider, `al_${slug}`, mint, wallet, t, t);
  db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, ?, ?, 'n', ?, ?, '[]', ?)`,
    `prj_${slug}`, `in_${slug}`, provider, mint, `sig_${slug}`, t);
  if (plotId) db.run(`INSERT INTO plots (plot_id, kind, wallet, idea_id, claimed_at) VALUES (?, 'project', ?, ?, ?)`, plotId, wallet, `idea_${slug}`, t);
  return { id: `prj_${slug}`, slug, mint };
}

/** A fake fetch: DexScreener answers from the fixture (or `dex`), Helius pages `holders` owners 1000 at a time. */
function fakeFetch({ dex = FIXTURE, dexStatus = 200, holders = 0, heliusStatus = 200 } = {}) {
  const state = { dexCalls: 0, heliusCalls: 0, cursors: [], bodies: [] };
  const owners = Array.from({ length: holders }, (_, i) => `Owner${i}`);
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('https://api.dexscreener.com/latest/dex/tokens/')) {
      state.dexCalls++;
      return new Response(JSON.stringify(typeof dex === 'function' ? dex() : dex), { status: dexStatus });
    }
    if (String(url) === HELIUS_URL) {
      state.heliusCalls++;
      const body = JSON.parse(init.body);
      state.bodies.push(body);
      state.cursors.push(body.params.cursor ?? null);
      if (heliusStatus !== 200) return new Response('{}', { status: heliusStatus });
      const from = Number(body.params.cursor || 0);
      const page = owners.slice(from, from + body.params.limit);
      // real accounts: an owner can have several accounts and some are empty; neither inflates the count
      const token_accounts = page.flatMap((owner, i) => [{ address: `acc${from + i}`, mint: MINT, owner, amount: 1 + i },
        ...(i === 0 ? [{ address: `dup${from}`, mint: MINT, owner, amount: 5 }, { address: `zero${from}`, mint: MINT, owner: `Empty${from}`, amount: 0 }] : [])]);
      const next = from + body.params.limit;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { total: token_accounts.length, limit: body.params.limit,
        cursor: next < owners.length ? String(next) : undefined, token_accounts } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, state };
}

test('coinTier: thresholds by holders or dollars, trend from the 24 h change, fresh within twice the cadence', () => {
  const t = 1_800_000_000_000;
  const S = (o) => ({ at: t, cadenceMs: CADENCE.settledMs, ...o });
  assert.deepEqual(coinTier(null, t), { tier: 0, name: 'none', by: null, trend: null, fresh: false });
  assert.deepEqual(coinTier(S({}), t), { tier: 0, name: 'none', by: null, trend: null, fresh: false }, 'a row without any number is no data');
  assert.deepEqual(coinTier(S({ holders: { count: null }, marketCapUsd: null, volume24hUsd: null }), t).tier, 0);
  assert.deepEqual(coinTier(S({ priceUsd: 0.001 }), t), { tier: 1, name: 'open', by: null, trend: null, fresh: true }, 'launched with data = open');
  assert.equal(coinTier(S({ marketCapUsd: 0 }), t).tier, 1, 'zero is data');
  // lit: holders ≥ 1,000 or 24 h volume ≥ $25k
  assert.equal(coinTier(S({ holders: { count: 999 } }), t).tier, 1);
  assert.deepEqual([coinTier(S({ holders: { count: 1000 } }), t).tier, coinTier(S({ holders: { count: 1000 } }), t).by], [2, 'holders']);
  assert.equal(coinTier(S({ volume24hUsd: 24_999.99 }), t).tier, 1);
  assert.deepEqual([coinTier(S({ volume24hUsd: 25_000 }), t).tier, coinTier(S({ volume24hUsd: 25_000 }), t).by], [2, 'volume']);
  // roof: holders ≥ 10,000 or market cap ≥ $1M (volume never lifts above lit)
  assert.equal(coinTier(S({ holders: { count: 9_999 }, volume24hUsd: 1e9 }), t).tier, 2);
  assert.equal(coinTier(S({ holders: { count: 10_000 } }), t).tier, 3);
  assert.equal(coinTier(S({ marketCapUsd: 999_999 }), t).tier, 1);
  assert.deepEqual([coinTier(S({ marketCapUsd: 1_000_000 }), t).tier, coinTier(S({ marketCapUsd: 1_000_000 }), t).by], [3, 'marketCap']);
  // sign: holders ≥ 100,000 or market cap ≥ $10M
  assert.equal(coinTier(S({ holders: { count: 99_999 }, marketCapUsd: 9_999_999 }), t).tier, 3);
  assert.equal(coinTier(S({ holders: { count: 100_000 } }), t).tier, 4);
  assert.equal(coinTier(S({ marketCapUsd: 10_000_000 }), t).tier, 4);
  assert.equal(coinTier(S({ holders: { count: 20_000, exact: false, atLeast: true }, marketCapUsd: 10_000_000 }), t).by, 'marketCap', 'a capped count cannot reach sign; the dollar line can');
  assert.equal(coinTier(S({ holders: { count: 50_000 }, marketCapUsd: 2_000_000 }), t).by, 'holders', 'holders is the preferred signal at the same tier');
  assert.equal(coinTier(S({ holders: { count: 500 }, marketCapUsd: 2_000_000 }), t).by, 'marketCap', 'the dollar line lifts a coin with few holders');
  // trend: ±5 %
  assert.equal(coinTier(S({ priceUsd: 1, priceChange24hPct: 5 }), t).trend, 'up');
  assert.equal(coinTier(S({ priceUsd: 1, priceChange24hPct: 4.99 }), t).trend, 'flat');
  assert.equal(coinTier(S({ priceUsd: 1, priceChange24hPct: -4.99 }), t).trend, 'flat');
  assert.equal(coinTier(S({ priceUsd: 1, priceChange24hPct: -5 }), t).trend, 'down');
  assert.equal(coinTier(S({ priceUsd: 1, priceChange24hPct: null }), t).trend, null, 'no change figure: no trend, not flat');
  // fresh: fetched within 2× its cadence (young coins 5 min, settled 30 min)
  assert.equal(coinTier(S({ priceUsd: 1 }), t + 2 * CADENCE.settledMs).fresh, true);
  assert.equal(coinTier(S({ priceUsd: 1 }), t + 2 * CADENCE.settledMs + 1).fresh, false);
  assert.equal(coinTier(S({ priceUsd: 1, cadenceMs: CADENCE.youngMs }), t + 2 * CADENCE.youngMs + 1).fresh, false);
  assert.equal(coinTier({ priceUsd: 1 }, t).fresh, false, 'no fetch time: never fresh');
  // bad input never throws or invents
  assert.equal(coinTier({ holders: { count: 'many' }, marketCapUsd: 'lots', volume24hUsd: NaN, at: t }, t).tier, 0);
  assert.equal(coinTier(S({ holders: { count: '1500' } }), t).tier, 2, 'numeric strings are read');
  assert.deepEqual(TIER_NAMES, ['none', 'open', 'lit', 'roof', 'sign']);
  assert.deepEqual(Object.keys(THRESHOLDS), ['lit', 'roof', 'sign']);
  assert.throws(() => { THRESHOLDS.lit.holders = 1; }, TypeError, 'frozen');
});

test('parseDexScreener: the Solana pair of the mint with the most liquidity; strings become numbers; nothing invented', async () => {
  const p = parseDexScreener(FIXTURE, MINT);
  assert.deepEqual(p, { pairs: 2, dex: 'pumpswap', pairAddress: '7pairaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', priceUsd: 0.002345, marketCapUsd: 2345000, fdvUsd: 2345000,
    liquidityUsd: 45678.9, volume24hUsd: 123456.78, txns24h: { buys: 1234, sells: 987 }, priceChange24hPct: 12.5, pairCreatedAt: 1760000000000,
    url: 'https://dexscreener.com/solana/7pairaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  // the pair where the mint is the QUOTE token and the ethereum pair (biggest liquidity of all) are not this coin
  assert.equal(parseDexScreener(FIXTURE, 'So11111111111111111111111111111111111111112').pairs, 1);
  assert.equal(parseDexScreener(FIXTURE, 'Nope'), null);
  assert.equal(parseDexScreener({ schemaVersion: '1.0.0', pairs: null }, MINT), null, 'a new token has `pairs: null`');
  assert.equal(parseDexScreener({}, MINT), null);
  assert.equal(parseDexScreener(null, MINT), null);
  // missing fields are null (never 0), marketCap falls back to fdv, a url off dexscreener.com is dropped
  const thin = parseDexScreener({ pairs: [{ chainId: 'solana', baseToken: { address: MINT }, fdv: 777, url: 'https://evil.example/x' }] }, MINT);
  assert.deepEqual(thin, { pairs: 1, dex: null, pairAddress: null, priceUsd: null, marketCapUsd: 777, fdvUsd: 777, liquidityUsd: null, volume24hUsd: null,
    txns24h: { buys: null, sells: null }, priceChange24hPct: null, pairCreatedAt: null, url: null });
  // the fetch: the documented endpoint, an HTTP error throws (so the last good value is kept)
  const f = fakeFetch();
  assert.equal((await fetchDexScreener(MINT, f.fetchImpl)).marketCapUsd, 2345000);
  await assert.rejects(fetchDexScreener(MINT, fakeFetch({ dexStatus: 429 }).fetchImpl), /dexscreener HTTP 429/);
  assert.equal(DEX.minGapMs >= 1000, true, 'at most 60 calls a minute, documented limit');
});

test('fetchHolders: distinct owners with a balance, cursor pagination, capped at maxPages as "at least"', async () => {
  const exact = fakeFetch({ holders: 2_500 });
  let h = await fetchHolders(MINT, { url: HELIUS_URL, fetchImpl: exact.fetchImpl });
  assert.deepEqual(h, { count: 2_500, exact: true, atLeast: false, pages: 3 });
  assert.deepEqual(exact.state.cursors, [null, '1000', '2000'], 'cursor passed back');
  assert.deepEqual(exact.state.bodies[0], { jsonrpc: '2.0', id: 'coin-stats', method: 'getTokenAccounts', params: { mint: MINT, limit: 1000, options: { showZeroBalance: false } } });
  // 25 pages of owners, cap 20: 20 requests, 20,000 counted, flagged as a floor
  const big = fakeFetch({ holders: 25_000 });
  const pages = [];
  h = await fetchHolders(MINT, { url: HELIUS_URL, fetchImpl: big.fetchImpl, onPage: (n) => pages.push(n) });
  assert.deepEqual(h, { count: 20_000, exact: false, atLeast: true, pages: 20 });
  assert.equal(big.state.heliusCalls, 20);
  assert.equal(pages.at(-1), 20);
  assert.equal(HOLDERS.maxPages * HOLDERS.pageSize, 20_000);
  h = await fetchHolders(MINT, { url: HELIUS_URL, fetchImpl: fakeFetch({ holders: 5_000 }).fetchImpl, maxPages: 2 });
  assert.deepEqual(h, { count: 2_000, exact: false, atLeast: true, pages: 2 });
  assert.deepEqual(await fetchHolders(MINT, { url: HELIUS_URL, fetchImpl: fakeFetch({ holders: 0 }).fetchImpl }), { count: 0, exact: true, atLeast: false, pages: 1 });
  await assert.rejects(fetchHolders(MINT, { url: HELIUS_URL, fetchImpl: fakeFetch({ heliusStatus: 401 }).fetchImpl }), /helius HTTP 401/);
  const rpcError = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }), { status: 200 });
  await assert.rejects(fetchHolders(MINT, { url: HELIUS_URL, fetchImpl: rpcError }), /helius: Invalid params/);
});

test('refreshCoinStats: stores DexScreener + Helius numbers with source and time; a failed fetch keeps the last good value (fresh: false, error only per coin); Helius has a daily page budget', async () => {
  const { cfg, db } = makeEnv({ HELIUS_API_KEY: 'test-key', HELIUS_DAILY_PAGES: '25' });
  assert.equal(cfg.coinStats.heliusUrl, HELIUS_URL);
  const w = user(db).address;
  const t0 = Date.now() - 2 * 3_600_000;                     // launched 2 h ago: young (5 min cadence)
  launched(db, w, { slug: 'fx', mint: MINT, provider: 'pumpfun', verifiedAt: t0, plotId: 'ginza-1' });
  const f = fakeFetch({ holders: 1_500 });
  const t1 = Date.now();
  const r1 = await refreshCoinStats(db, cfg, MINT, { fetchImpl: f.fetchImpl, t: t1 });
  assert.deepEqual(r1, { ok: true, source: 'dexscreener', tier: 3 }, 'mcap $2.3M → roof');
  assert.deepEqual([f.state.dexCalls, f.state.heliusCalls], [1, 2]);
  const row = db.get('SELECT * FROM coin_stats WHERE mint = ?', MINT);
  assert.equal(row.ok, 1);
  assert.equal(row.error, null);
  assert.equal(row.fetched_at, t1);
  const s = JSON.parse(row.json);
  assert.equal(s.source, 'dexscreener');
  assert.equal(s.cadenceMs, CADENCE.youngMs);
  assert.equal(s.launchedAt, t0);
  assert.equal(s.at, t1);
  assert.deepEqual({ ...s.holders, at: 0 }, { count: 1_500, exact: true, atLeast: false, at: 0, source: 'helius' });
  assert.equal(s.holders.at, t1);
  assert.deepEqual(heliusBudget(db, cfg, t1), { day: new Date(t1).toISOString().slice(0, 10), used: 2, left: 23 }, 'pages counted');
  // the world view: launched public → stats; the per-coin view: the full object, ok and no error
  const pub = publicStats(s, t1 + 1000);
  assert.deepEqual(pub, { tier: 3, tierName: 'roof', by: 'marketCap', trend: 'up', fresh: true, holders: s.holders, marketCapUsd: 2345000, volume24hUsd: 123456.78,
    liquidityUsd: 45678.9, priceChange24hPct: 12.5, at: s.at, source: 'dexscreener', url: 'https://dexscreener.com/solana/7pairaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.deepEqual(worldView(db, cfg, t1 + 1000).plots[0].project.stats, pub);
  const v = coinStatsView(db, MINT, t1 + 1000);
  assert.equal(v.ok, true);
  assert.equal(v.error, null);
  assert.equal(v.priceUsd, 0.002345);
  assert.deepEqual(v.txns24h, { buys: 1234, sells: 987 });
  assert.equal(v.checkedAt, t1);
  assert.deepEqual(v.thresholds, THRESHOLDS);
  // a second refresh inside the holders window re-reads prices but not holders (credits), DexScreener pacing is a Defer
  const t2 = t1 + 1000;
  await assert.rejects(refreshCoinStats(db, cfg, MINT, { fetchImpl: f.fetchImpl, t: t2 }), (e) => e instanceof Defer && e.delayMs > 0 && e.delayMs <= DEX.minGapMs);
  const t3 = t1 + DEX.minGapMs;
  assert.equal((await refreshCoinStats(db, cfg, MINT, { fetchImpl: f.fetchImpl, t: t3 })).ok, true);
  assert.deepEqual([f.state.dexCalls, f.state.heliusCalls], [2, 2], 'holders kept from the last fetch');
  assert.equal(JSON.parse(db.get('SELECT json FROM coin_stats WHERE mint = ?', MINT).json).holders.count, 1_500);
  // DexScreener down: the last good value stays, ok = 0 with the error; the world shows it stale, never the error
  const down = fakeFetch({ dexStatus: 503 });
  const t4 = t3 + 10 * 60_000;
  assert.deepEqual(await refreshCoinStats(db, cfg, MINT, { fetchImpl: down.fetchImpl, t: t4 }), { ok: false, error: 'dexscreener HTTP 503' });
  const stale = db.get('SELECT * FROM coin_stats WHERE mint = ?', MINT);
  assert.equal(stale.ok, 0);
  assert.equal(stale.error, 'dexscreener HTTP 503');
  assert.equal(stale.fetched_at, t3, 'the last GOOD time');
  assert.equal(stale.checked_at, t4);
  assert.equal(JSON.parse(stale.json).marketCapUsd, 2345000, 'last good json kept');
  const tLater = t4 + 2 * CADENCE.youngMs;
  const ws = worldView(db, cfg, tLater).plots[0].project.stats;
  assert.equal(ws.fresh, false);
  assert.equal(ws.marketCapUsd, 2345000);
  assert.equal('error' in ws, false, 'the world never carries an error');
  const vs = coinStatsView(db, MINT, tLater);
  assert.deepEqual([vs.ok, vs.error, vs.fresh, vs.checkedAt, vs.marketCapUsd], [false, 'dexscreener HTTP 503', false, t4, 2345000]);
  assert.ok(logs.some((l) => l.includes('coin stats: refresh failed') && l.includes('dexscreener HTTP 503')));
  // holders window passed and the daily page budget: 23 pages left, so a 25-page coin is capped at 23 and flagged; then 0 left → no Helius call, holders kept
  const huge = fakeFetch({ holders: 30_000 });
  const t5 = t4 + HOLDERS.youngEveryMs + DEX.minGapMs;
  assert.equal((await refreshCoinStats(db, cfg, MINT, { fetchImpl: huge.fetchImpl, t: t5 })).ok, true);
  assert.equal(huge.state.heliusCalls, 20, 'the per-fetch cap (20) comes first');
  assert.deepEqual({ ...JSON.parse(db.get('SELECT json FROM coin_stats WHERE mint = ?', MINT).json).holders, at: 0 }, { count: 20_000, exact: false, atLeast: true, at: 0, source: 'helius' });
  assert.equal(heliusBudget(db, cfg, t5).left, 3);
  const t6 = t5 + HOLDERS.youngEveryMs + DEX.minGapMs;
  const more = fakeFetch({ holders: 30_000 });
  assert.equal((await refreshCoinStats(db, cfg, MINT, { fetchImpl: more.fetchImpl, t: t6 })).ok, true);
  assert.equal(more.state.heliusCalls, 3, 'only what the day has left');
  assert.equal(heliusBudget(db, cfg, t6).left, 0);
  const t7 = t6 + HOLDERS.youngEveryMs + DEX.minGapMs;
  const none = fakeFetch({ holders: 30_000 });
  assert.equal((await refreshCoinStats(db, cfg, MINT, { fetchImpl: none.fetchImpl, t: t7 })).ok, true);
  assert.equal(none.state.heliusCalls, 0, 'budget used up: no call');
  assert.equal(JSON.parse(db.get('SELECT json FROM coin_stats WHERE mint = ?', MINT).json).holders.count, 3_000, 'the last counted value stays, with its own time');
  assert.ok(logs.some((l) => l.includes('helius daily page budget used up')));
  assert.equal(heliusBudget(db, cfg, t7 + 86_400_000).left, 25, 'a new UTC day resets the budget');
  assert.ok(!logs.some((l) => l.includes('test-key')), 'the Helius key is never logged');
  // a Helius failure keeps the previous holders and still stores the prices
  const t8 = t7 + 86_400_000;
  const hdown = fakeFetch({ heliusStatus: 500 });
  assert.equal((await refreshCoinStats(db, cfg, MINT, { fetchImpl: hdown.fetchImpl, t: t8 })).ok, true);
  const after = JSON.parse(db.get('SELECT json FROM coin_stats WHERE mint = ?', MINT).json);
  assert.equal(after.holders.count, 3_000);
  assert.equal(after.at, t8);
  assert.equal(db.get('SELECT ok FROM coin_stats WHERE mint = ?', MINT).ok, 1);
  assert.ok(logs.some((l) => l.includes('coin stats: holders not fetched')));
});

test('refreshCoinStats without Helius: holders is null, never estimated; no pair on DexScreener: no numbers, tier 0; the first failed fetch leaves a row without a value', async () => {
  const { cfg, db } = makeEnv();
  assert.equal(cfg.coinStats.heliusUrl, '');
  const w = user(db).address;
  launched(db, w, { slug: 'a', mint: MINT, provider: 'pumpfun', verifiedAt: Date.now() - 3 * 86_400_000, plotId: 'ueno-1' });
  const f = fakeFetch({ holders: 5000 });
  const t = Date.now();
  assert.deepEqual(await refreshCoinStats(db, cfg, MINT, { fetchImpl: f.fetchImpl, t }), { ok: true, source: 'dexscreener', tier: 3 });
  assert.equal(f.state.heliusCalls, 0);
  const s = JSON.parse(db.get('SELECT json FROM coin_stats WHERE mint = ?', MINT).json);
  assert.equal(s.holders, null);
  assert.equal(s.cadenceMs, CADENCE.settledMs, 'three days old: settled cadence');
  assert.equal(worldView(db, cfg, t).plots[0].project.stats.holders, null);
  // no pair yet (a brand-new token): the numbers are null and the building stays dark, but the look is on record
  launched(db, w, { slug: 'b', mint: 'NewMint22222222222222222222222222222222222', provider: 'pumpfun', verifiedAt: t - 2000, plotId: 'ueno-2' });
  const empty = fakeFetch({ dex: { schemaVersion: '1.0.0', pairs: null } });
  const t2 = t + DEX.minGapMs;
  assert.deepEqual(await refreshCoinStats(db, cfg, 'NewMint22222222222222222222222222222222222', { fetchImpl: empty.fetchImpl, t: t2 }), { ok: true, source: 'dexscreener', tier: 0 });
  const st = worldView(db, cfg, t2).plots[1].project.stats;
  assert.deepEqual(st, { tier: 0, tierName: 'none', by: null, trend: null, fresh: false, holders: null, marketCapUsd: null, volume24hUsd: null, liquidityUsd: null,
    priceChange24hPct: null, at: st.at, source: 'dexscreener', url: null });
  assert.equal(st.at, t2);
  // a coin whose very first fetch fails: a row with the error and no value; the view says so
  launched(db, w, { slug: 'c', mint: 'FailMint3333333333333333333333333333333333', provider: 'pumpfun', verifiedAt: t - 1000, plotId: 'ueno-3' });
  const t3 = t2 + DEX.minGapMs;
  assert.equal((await refreshCoinStats(db, cfg, 'FailMint3333333333333333333333333333333333', { fetchImpl: fakeFetch({ dexStatus: 500 }).fetchImpl, t: t3 })).ok, false);
  const v = coinStatsView(db, 'FailMint3333333333333333333333333333333333', t3);
  assert.deepEqual([v.tier, v.ok, v.error, v.at, v.checkedAt], [0, false, 'dexscreener HTTP 500', null, t3]);
  assert.equal(worldView(db, cfg, t3).plots[2].project.stats.tier, 0);
  assert.deepEqual(await refreshCoinStats(db, cfg, 'NotLaunched', { fetchImpl: f.fetchImpl }), { skipped: 'not a launched mint' });
});

test('mock source: only with LAUNCH_PROVIDER=mock, deterministic, unmistakably marked source "mock"; a mock launch under a real provider gets nothing', async () => {
  const t = Date.now();
  const a = mockStats('MOCKabc', t - 3_600_000, t);
  assert.deepEqual(mockStats('MOCKabc', t - 3_600_000, t), a, 'deterministic in (mint, time)');
  assert.notDeepEqual(mockStats('MOCKxyz', t - 3_600_000, t).holders, a.holders, 'differs by mint');
  assert.ok(mockStats('MOCKabc', t - 48 * 3_600_000, t).holders.count > a.holders.count, 'grows with age so a dev sees a building light up');
  assert.equal(a.source, 'mock');
  assert.equal(a.mock, true);
  assert.equal(a.url, null);
  assert.equal(a.holders.source, 'mock');
  for (const k of ['priceUsd', 'marketCapUsd', 'volume24hUsd', 'liquidityUsd', 'priceChange24hPct']) assert.equal(typeof a[k], 'number', k);
  const { cfg, db } = makeEnv();                              // LAUNCH_PROVIDER=mock
  const w = user(db).address;
  launched(db, w, { slug: 'm', mint: 'MOCKabc', provider: 'mock', verifiedAt: t - 3_600_000, plotId: 'kanda-1' });
  const f = fakeFetch();
  assert.deepEqual(await refreshCoinStats(db, cfg, 'MOCKabc', { fetchImpl: f.fetchImpl, t }), { ok: true, source: 'mock', tier: coinTier({ ...a, cadenceMs: CADENCE.youngMs }, t).tier });
  assert.deepEqual([f.state.dexCalls, f.state.heliusCalls], [0, 0], 'no network for mock numbers');
  const st = worldView(db, cfg, t).plots[0].project.stats;
  assert.equal(st.source, 'mock');
  assert.equal(st.mock, true, 'the city can label it');
  assert.equal(st.url, null);
  assert.equal(coinStatsView(db, 'MOCKabc', t).sourceLabel, 'mock numbers: local development only, not from any chain');
  // the same row under a real provider: refused (no data), and never scheduled
  const real = { ...cfg, launch: { ...cfg.launch, provider: 'pumpfun' } };
  assert.deepEqual(await refreshCoinStats(db, real, 'MOCKabc', { fetchImpl: f.fetchImpl, t: t + 1 }), { skipped: 'mock launch under a real provider: no data' });
  assert.equal(scheduleCoinStats(db, real, t), 0);
  assert.throws(() => loadConfig({ LAUNCHPAD_NO_DOTENV: '1', DEPLOY_ENV: 'production', LAUNCH_PROVIDER: 'mock', APP_ENCRYPTION_KEY: 'x', PUBLIC_ORIGIN: 'https://x' }), /mock is not allowed in production/);
});

test('scheduling: one coin_stats job per launched mint per cadence slot (5 min young, 30 min settled), spread in the slot, idempotent, pruned; the worker job stores the stats', async () => {
  const { cfg, db } = makeEnv({ HELIUS_API_KEY: 'test-key', DEXSCREENER_MIN_GAP_MS: '0' });   // pacing is covered above with a simulated clock
  assert.equal(cfg.coinStats.dexGapMs, 0);
  const w = user(db).address;
  const t = 1_800_000_000_000 + 7 * 60_000;
  launched(db, w, { slug: 'young', mint: 'YoungMint111111111111111111111111111111111', provider: 'pumpfun', verifiedAt: t - 3_600_000 });
  launched(db, w, { slug: 'old', mint: 'OldMint22222222222222222222222222222222222', provider: 'pumpfun', verifiedAt: t - 3 * 86_400_000 });
  launched(db, w, { slug: 'mock', mint: 'MOCKmint', provider: 'mock', verifiedAt: t - 60_000 });
  assert.equal(scheduleCoinStats(db, cfg, t), 3);
  assert.equal(scheduleCoinStats(db, cfg, t + 30_000), 3, 'the same slot again');
  const jobs = db.all(`SELECT idempotency_key k, run_after, status, payload_json FROM jobs WHERE type = 'coin_stats' ORDER BY idempotency_key`);
  assert.equal(jobs.length, 3, 'idempotent inside a slot');
  const young = jobs.find((j) => j.k.startsWith('coin_stats:YoungMint'));
  const old = jobs.find((j) => j.k.startsWith('coin_stats:OldMint'));
  const youngSlot = Math.floor(t / CADENCE.youngMs) * CADENCE.youngMs, oldSlot = Math.floor(t / CADENCE.settledMs) * CADENCE.settledMs;
  assert.equal(young.k, `coin_stats:YoungMint111111111111111111111111111111111:${youngSlot}`);
  assert.equal(old.k, `coin_stats:OldMint22222222222222222222222222222222222:${oldSlot}`);
  assert.ok(young.run_after >= youngSlot && young.run_after < youngSlot + CADENCE.youngMs / 2, 'jitter inside the first half of the slot');
  assert.ok(old.run_after >= oldSlot && old.run_after < oldSlot + CADENCE.settledMs / 2);
  assert.deepEqual(JSON.parse(young.payload_json), { mint: 'YoungMint111111111111111111111111111111111' });
  assert.equal(scheduleCoinStats(db, cfg, t + CADENCE.youngMs), 3);
  assert.equal(db.get(`SELECT COUNT(*) n FROM jobs WHERE type = 'coin_stats'`).n, 5, 'the two young coins get a new slot, the old one not yet');
  assert.equal(scheduleCoinStats(db, { ...cfg, coinStats: { ...cfg.coinStats, enabled: false } }, t + 2 * CADENCE.youngMs), 0, 'COIN_STATS=0');
  // run them: the worker's handler fetches and stores (fake network), the mock one needs none
  const f = fakeFetch({ holders: 10 });
  const ran = await drain(db, cfg, f.fetchImpl, { t: t + 2 * CADENCE.youngMs });
  assert.deepEqual(ran.map((r) => [r.type, r.status]), Array(5).fill(['coin_stats', 'succeeded']), JSON.stringify(ran));
  assert.equal(db.get(`SELECT COUNT(*) n FROM coin_stats WHERE ok = 1`).n, 3);
  assert.equal(JSON.parse(db.get(`SELECT json FROM coin_stats WHERE mint = 'MOCKmint'`).json).source, 'mock');
  assert.equal(f.state.dexCalls, 3, 'two slots of the young coin, one of the old; the mock one makes no call');
  assert.equal(f.state.heliusCalls, 2, 'holders once per coin inside the holders window');
  // finished rows older than a day are pruned by the next sweep
  db.run(`UPDATE jobs SET updated_at = ? WHERE type = 'coin_stats' AND status = 'succeeded'`, t - 2 * 86_400_000);
  scheduleCoinStats(db, cfg, t + 3 * CADENCE.youngMs);
  assert.equal(db.get(`SELECT COUNT(*) n FROM jobs WHERE type = 'coin_stats' AND status = 'succeeded'`).n, 0);
  assert.equal(claim(db, 'x', t + 3 * CADENCE.youngMs + CADENCE.youngMs)?.type, 'coin_stats', 'new slot jobs are there');
});

test('/api/world and GET /api/coins/:mint/stats: launched public projects carry stats, private and unlaunched carry nothing; cache header; 404 for private, 400 for a bad mint', async () => {
  const h = await harness();
  try {
    const w = user(h.db).address;
    launched(h.db, w, { slug: 'pub', mint: 'MOCKpub', provider: 'mock', plotId: 'ginza-1' });
    launched(h.db, w, { slug: 'priv', mint: 'MOCKpriv', provider: 'mock', visibility: 'private', plotId: 'ginza-2' });
    const t = Date.now();
    await refreshCoinStats(h.db, h.cfg, 'MOCKpub', { t });
    await refreshCoinStats(h.db, h.cfg, 'MOCKpriv', { t });
    const anon = h.client(user(h.db));
    const wv = await anon.call('GET', '/api/world');
    const pub = wv.json.plots.find((p) => p.plotId === 'ginza-1').project;
    assert.equal(pub.launched, true);
    assert.deepEqual(Object.keys(pub.stats), ['tier', 'tierName', 'by', 'trend', 'fresh', 'holders', 'marketCapUsd', 'volume24hUsd', 'liquidityUsd', 'priceChange24hPct', 'at', 'source', 'url', 'mock']);
    assert.equal(pub.stats.source, 'mock');
    assert.ok(pub.stats.tier >= 1);
    const priv = wv.json.plots.find((p) => p.plotId === 'ginza-2').project;
    assert.equal('stats' in priv, false, 'a private project gets nothing');
    assert.equal(priv.name, 'Private project');
    assert.ok(!wv.text.includes('MOCKpriv'));
    // an idea that is public but not launched has no stats key either
    h.db.run(`UPDATE ideas SET status = 'preview_ready' WHERE id = 'idea_pub'`);
    assert.equal('stats' in worldView(h.db, h.cfg).plots.find((p) => p.plotId === 'ginza-1').project, false);
    h.db.run(`UPDATE ideas SET status = 'launched' WHERE id = 'idea_pub'`);
    // the per-coin endpoint
    const r = await anon.call('GET', '/api/coins/MOCKpub/stats');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.json.mint, 'MOCKpub');
    assert.equal(r.json.slug, 'pub');
    assert.equal(r.json.source, 'mock');
    assert.equal(r.json.mock, true);
    assert.deepEqual([r.json.ok, r.json.error], [true, null]);
    assert.deepEqual(r.json.thresholds, THRESHOLDS);
    assert.deepEqual(r.json.tiers, TIER_NAMES);
    assert.equal(r.json.holdersCap, 20_000);
    assert.equal(typeof r.json.priceUsd, 'number');
    assert.ok(!r.text.includes(w), 'no wallet');
    assert.equal((await anon.call('GET', '/api/coins/MOCKpriv/stats')).status, 404, 'private: not even its existence');
    assert.equal((await anon.call('GET', '/api/coins/Unknown111/stats')).status, 404);
    assert.equal((await anon.call('GET', '/api/coins/bad-mint!/stats')).json.error, 'bad_mint');
    // a launched coin the worker has not looked at yet: tier 0, ok null (no attempt yet)
    launched(h.db, w, { slug: 'fresh', mint: 'MOCKfresh', provider: 'mock' });
    const f = await anon.call('GET', '/api/coins/MOCKfresh/stats');
    assert.deepEqual([f.json.tier, f.json.ok, f.json.error, f.json.checkedAt, f.json.at, f.json.source], [0, null, null, null, null, null]);
  } finally { h.close(); }
});

test('migration 007 applies on a fresh database: coin_stats table with its columns', () => {
  const db = openDb(':memory:');
  const applied = migrate(db);
  assert.ok(applied.includes('007_coin_stats.sql'), applied.join(','));
  assert.deepEqual(db.all('PRAGMA table_info(coin_stats)').map((c) => c.name), ['mint', 'json', 'fetched_at', 'checked_at', 'ok', 'error']);
  assert.equal(db.get(`SELECT 1 x FROM schema_migrations WHERE name = '007_coin_stats.sql'`).x, 1);
  db.run(`INSERT INTO coin_stats (mint, json, fetched_at, checked_at, ok, error) VALUES ('m', '{}', 1, 1, 1, NULL)`);
  assert.throws(() => db.run(`INSERT INTO coin_stats (mint, json, fetched_at, checked_at, ok, error) VALUES ('m', '{}', 1, 1, 1, NULL)`), /UNIQUE|PRIMARY/);
  assert.throws(() => db.run(`INSERT INTO coin_stats (mint, json, fetched_at, checked_at, ok, error) VALUES ('n', '{}', 1, 1, 2, NULL)`), /CHECK/);
  assert.deepEqual(migrate(db), [], 'nothing twice');
  // HELIUS_URL validation: only Helius over https
  assert.throws(() => loadConfig({ LAUNCHPAD_NO_DOTENV: '1', HELIUS_URL: 'http://evil.example/?api-key=x' }), /HELIUS_URL/);
  assert.equal(loadConfig({ LAUNCHPAD_NO_DOTENV: '1', HELIUS_URL: 'https://mainnet.helius-rpc.com/?api-key=k', HELIUS_API_KEY: 'ignored' }).coinStats.heliusUrl, 'https://mainnet.helius-rpc.com/?api-key=k');
  assert.equal(loadConfig({ LAUNCHPAD_NO_DOTENV: '1' }).coinStats.heliusDailyPages, 1000);
  db.close();
});
