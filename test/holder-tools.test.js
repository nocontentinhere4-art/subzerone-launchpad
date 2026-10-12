// The holder tools (docs/SITE-KIT.md "Holder tools"): pump.fun event decoding on real mainnet transactions (fixtures:
// Konbini Confession, 8NmKmy…a8w7, fetched read-only 2026-10-12), the holder / dev / fee math, the incremental signature
// walker, the /_api endpoints on a project host against a fake chain, the static "goes live at launch" state, the
// built chunk's rules and the launched-coin backfill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { harness, makeEnv, user, drain, IDEA, wallet } from './helpers.js';
import * as oc from '../src/onchain.js';
import { backfillHolderTools } from '../src/holder-tools.js';
import { TRUST, validateTools } from '../src/tools.js';
import { liveSpec, backfillTools } from '../src/tool-api.js';
import { backfillApps } from '../src/app-api.js';
import { ROOT } from '../src/config.js';

const MINT = '8NmKmyZSq7TV7XWt9612SKL3ezD7soTCquXdLxoUa8w7';
const AUTHOR = 'HMPUiULXumamWDhuoKap6ty2hQ7V7GQwi8PZ7pGx6STQ', SUB01 = '4o16Xj4EvVSLctQxNNXymEMPnYDXAcyXjzdGKL5VjVAg';
const fx = (name) => JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'onchain', `${name}.json`), 'utf8'));

// --- decoding (real transactions) -------------------------------------------------------------------------------------
test('trade events decode from real mainnet transactions (legacy and v1), and match the token balance changes', () => {
  for (const [name, side, sol, tokens, user] of [['konbini-trade-legacy', false, 211_718_025, 4_761_603_244_368, 'A2RB47FBfwDyev6JtQAmYJ8gzvDbQ6Z4kZb7w25Smo7J'],
    ['konbini-trade-v1', false, 114_205_529, 2_307_010_393_066, 'Ad7mC79aR5MvoBL8JTMBrmDn33fXPahmDmWZncyrgMZo']]) {
    const { tx } = fx(name);
    const [t, ...rest] = oc.decodeTrades(tx, MINT);
    assert.equal(rest.length, 0, name);
    assert.deepEqual([t.isBuy, t.quoteAmount, t.tokenAmount, t.user, t.quoteMint], [side, sol, tokens, user, oc.WSOL], name);
    assert.equal(oc.ownerDelta(tx, MINT, t.user), side ? tokens : -tokens, `${name}: the seller's token account lost exactly the traded amount`);
    assert.ok(t.creatorFee > 0 && t.fee > t.creatorFee, name);
    assert.deepEqual(oc.decodeTrades(tx, 'So11111111111111111111111111111111111111112'), [], 'another mint: nothing');
  }
});

test('events come from the self-CPI instructions or the program\'s own log lines, never both', () => {
  const { tx } = fx('konbini-trade-v1');
  const both = oc.decodeTrades(tx, MINT);
  const logsOnly = oc.decodeTrades({ ...tx, meta: { ...tx.meta, innerInstructions: [] } }, MINT);
  const cpiOnly = oc.decodeTrades({ ...tx, meta: { ...tx.meta, logMessages: [] } }, MINT);
  assert.equal(both.length, 1);
  assert.deepEqual(logsOnly, both, 'truncated or missing inner instructions: the logs carry the same event');
  assert.deepEqual(cpiOnly, both, 'truncated logs: the CPI event is enough');
  // a "Program data:" line printed by ANOTHER program is not read as a pump event
  const foreign = { ...tx, meta: { ...tx.meta, innerInstructions: [], logMessages: tx.meta.logMessages.map((l) => l.replace(/^Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke/, 'Program 11111111111111111111111111111111 invoke')) } };
  assert.equal(oc.decodeTrades(foreign, MINT).length, 0);
});

test('the launch transaction: CreateEvent author, no dev buy; the fee config starts at 100% to the creator (0 distributed)', () => {
  const { tx } = fx('konbini-create');
  assert.deepEqual(oc.decodeCreate(tx, MINT), { user: AUTHOR, creator: AUTHOR, timestamp: 1791662979 });
  assert.deepEqual(oc.decodeTrades(tx, MINT), [], 'Konbini launched without a dev buy');
  assert.deepEqual(oc.decodeDistributions(tx, MINT).map((d) => [d.distributed, d.shareholders]), [[0, [{ address: AUTHOR, bps: 10000 }]]]);
});

test('a creator-fee distribution: the amount and the locked 80/20 shareholders; sweeps carry no trade', () => {
  const [d] = oc.decodeDistributions(fx('konbini-distribute').tx, MINT);
  assert.equal(d.distributed, 76_532_580);
  assert.deepEqual(d.shareholders, [{ address: AUTHOR, bps: 8000 }, { address: SUB01, bps: 2000 }]);
  assert.equal(d.sharingConfig, 'BHWQP16QccbfMDHXCMTfTjRJaBgci9BB8fS2hgh7NZRr');
  const sweep = fx('konbini-sweep').tx;
  assert.deepEqual(oc.decodeTrades(sweep, MINT), []);
  assert.ok(oc.pumpEvents(sweep).every((e) => e.name === 'SweepBondingCurveFeeEvent'));
});

test('account decoders: the bonding curve and the locked sharing config', async () => {
  const acc = fx('konbini-accounts');
  const rpc = async (method, [addr]) => { assert.equal(method, 'getAccountInfo'); return { context: { slot: 1 }, value: Object.values(acc).find((a) => a.address === addr)?.value ?? null }; };
  const p = oc.pdas(MINT);
  assert.equal(p.curve, acc.curve.address); assert.equal(p.sharing, acc.sharing.address);
  const curve = await oc.readCurve(rpc, p.curve);
  assert.equal(curve.complete, false); assert.equal(curve.creator, p.sharing, 'the curve pays its creator fees to the sharing config');
  assert.deepEqual(await oc.readSharing(rpc, p.sharing), { address: p.sharing, adminRevoked: true, shareholders: [{ address: AUTHOR, bps: 8000 }, { address: SUB01, bps: 2000 }] });
  assert.equal(await oc.readCurve(rpc, 'missing'), null);
});

// --- the math -------------------------------------------------------------------------------------------------------
test('holders: grouped by owner, the curve labelled and left out, concentration in plain words', () => {
  const supply = 1_000_000_000e6, M = 1e6 * 1e6;           // 1 M tokens in base units
  const accounts = [{ owner: 'CURVE', amount: 400 * M }, { owner: 'W1', amount: 150 * M }, { owner: 'W1', amount: 10 * M }, { owner: 'W2', amount: 90 * M },
    ...Array.from({ length: 12 }, (_, i) => ({ owner: `X${String(i).padStart(2, '0')}`, amount: (30 - i) * M })), { owner: 'ZERO', amount: 0 }];
  const v = oc.holdersView({ accounts, supply, exclude: new Map([['CURVE', 'bonding curve (unsold supply)']]), labels: new Map([['W2', 'author (dev)']]), count: 15, countExact: true });
  assert.deepEqual(v.holders.slice(0, 3).map((x) => [x.owner, x.pct, x.label, x.excluded]), [['CURVE', 40, 'bonding curve (unsold supply)', true], ['W1', 16, null, false], ['W2', 9, 'author (dev)', false]]);
  assert.equal(v.holders.length, 15, 'zero balances never count');
  assert.equal(v.top1Pct, 16);
  assert.equal(v.top10Pct, 46.2, '160 + 90 + (30 + 29 + … + 23) M of 1,000 M');
  assert.equal(v.risk.level, 'moderate');
  assert.equal(v.top10CircPct, 77, '462 M of the 600 M outside the curve');
  // early on: the curve holds most of the supply and ten wallets hold nearly everything that trades -> high, said plainly
  const early = oc.holdersView({ accounts: [{ owner: 'CURVE', amount: 810 * M }, { owner: 'A', amount: 52 * M }, { owner: 'B', amount: 35 * M }, { owner: 'C', amount: 100 * M }, { owner: 'D', amount: 3 * M }],
    supply, exclude: new Map([['CURVE', 'bonding curve (unsold supply)']]) });
  assert.equal(early.risk.level, 'high');
  assert.equal(early.risk.line, 'The 4 wallets holding it hold 19% of the supply and 100% of the tokens in circulation: high concentration: a few wallets can move the price a lot. The largest wallet alone holds 10%. Not counted: bonding curve (unsold supply) (81%).');
  assert.equal(v.risk.line, 'Top 10 wallets hold 46% of the supply and 77% of the tokens in circulation: moderate concentration. The largest wallet alone holds 16%. Not counted: bonding curve (unsold supply) (40%).');
  const high = oc.riskLine({ top10Pct: 62.4, top1Pct: 3 });
  assert.equal(high.line, 'Top 10 wallets hold 62% of the supply: high concentration: a few wallets can move the price a lot.');
  assert.equal(oc.riskLine({ top10Pct: 8.25, top1Pct: 2, wallets: 3 }).line, 'The 3 wallets holding it hold 8.3% of the supply: spread out.');
  assert.equal(oc.riskLine({ top10Pct: null }).line, 'No holder data yet.');
});

test('dev watch: the status line in every case, honest about missing data and partial history', () => {
  const B = 50_000_000e6, t = Date.parse('2026-10-11T14:02:00Z');
  assert.equal(oc.devView({ devBuy: B, balance: B, moves: [{ at: 1, delta: B, kind: 'dev buy' }], complete: true }).status, 'Dev holds 100% of their dev buy.');
  const sold = oc.devView({ devBuy: B, balance: 0.6 * B, moves: [{ at: 1, delta: B, kind: 'dev buy' }, { at: t, delta: -0.4 * B, kind: 'sell' }], complete: true });
  assert.equal(sold.status, 'Dev sold 40% of their dev buy, last at 2026-10-11 14:02 UTC. Holds 60% of it now.');
  assert.equal(sold.level, 'info');
  const moved = oc.devView({ devBuy: B, balance: 0.2 * B, moves: [{ at: t, delta: -0.8 * B, kind: 'out' }], complete: false });
  assert.match(moved.status, /^80% of the dev buy left the author wallet \(a transfer, or a sale through another program\), last at 2026-10-11 14:02 UTC\. Holds 20% of it now\. \(History still loading/);
  assert.equal(moved.level, 'warn');
  assert.equal(oc.devView({ devBuy: 0, balance: 0, moves: [], complete: true }).status, 'The author made no dev buy at launch and holds none of the coin.');
  assert.equal(oc.devView({ devBuy: null, balance: 5e6, moves: [], complete: true }).status, 'The dev buy is not known for this coin; the author wallet holds 5 tokens now.');
  assert.equal(oc.devView({ devBuy: B, balance: null, moves: [], complete: true }).status, 'The author wallet\'s balance could not be read just now.');
  assert.equal(oc.devView({ devBuy: B, balance: B + 1e12, moves: [], complete: true }).status, 'Dev holds 100% of their dev buy (and 1.00M more bought later).');
});

test('fees: accrued = paid out + waiting (both on chain); each shareholder\'s part by the locked bps', () => {
  const sh = [{ address: AUTHOR, bps: 8000 }, { address: SUB01, bps: 2000 }];
  const v = oc.feesView({ sharing: { address: 'S', adminRevoked: true, shareholders: sh }, waiting: { vault: 10_000_000, curve: 2_000_000 },
    distributions: [{ signature: 'a', at: 2, lamports: 76_532_580, shareholders: sh }, { signature: 'b', at: 1, lamports: 1_000_000, shareholders: sh }],
    fromTrades: { lamports: 89_000_000, trades: 10, complete: true }, labels: new Map([[AUTHOR, 'author'], [SUB01, 'SUB-01']]) });
  assert.equal(v.distributed, 77_532_580); assert.equal(v.waiting, 12_000_000); assert.equal(v.accrued, 89_532_580);
  assert.deepEqual(v.shareholders.map((s) => [s.label, s.pct, s.accrued, s.received, s.waiting]),
    [['author', 80, 71_626_064, 62_026_064, 9_600_000], ['SUB-01', 20, 17_906_516, 15_506_516, 2_400_000]]);
  assert.equal(v.distributions[0].signature, 'a', 'newest first');
  assert.equal(oc.feesView({ sharing: null, waiting: null, distributions: [] }).accrued, null, 'nothing read: null, never 0');
});

// --- the signature walker ---------------------------------------------------------------------------------------------
/** A fake chain: `sigs[address]` newest first; getTransaction answers from `txs`. Counts calls by method. */
function fakeChain({ sigs = {}, txs = {}, extra = {} } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getSignaturesForAddress') {
      const [addr, o] = params;
      let list = sigs[addr] || [];
      if (o.until) { const i = list.findIndex((s) => s.signature === o.until); if (i >= 0) list = list.slice(0, i); }
      if (o.before) { const i = list.findIndex((s) => s.signature === o.before); list = i >= 0 ? list.slice(i + 1) : []; }
      return list.slice(0, o.limit);
    }
    if (method === 'getTransaction') return txs[params[0]] ?? null;
    if (extra[method]) return extra[method](params);
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls, count: (m) => calls.filter((c) => c === m).length };
}
const sig = (s, slot, err = null) => ({ signature: s, slot, blockTime: 1791700000 + slot, err });

test('signature walker: newest first, older history page by page, failed transactions never fetched, bounded per step, incremental', async () => {
  const { db } = makeEnv();
  const legacy = fx('konbini-trade-legacy'), v1 = fx('konbini-trade-v1');
  const list = [sig('n3', 30), sig(legacy.signature, 20), sig('bad', 15, { InstructionError: [0, 'x'] }), sig(v1.signature, 10)];
  const chain = fakeChain({ sigs: { CURVE: list }, txs: { [legacy.signature]: legacy.tx, [v1.signature]: v1.tx, n3: { ...legacy.tx, meta: { ...legacy.tx.meta, innerInstructions: [], logMessages: [] } } } });
  const onTx = (tx, row) => { oc.storeTrades(db, tx, row.signature, MINT); return null; };
  let r = await oc.syncAddress(db, chain.rpc, { address: 'CURVE', mint: MINT, kind: 'curve', maxTx: 2, onTx });
  assert.deepEqual([r.newSigs, r.fetched, r.complete, r.pending], [4, 2, false, 1], 'two decoded, the failed one never fetched');
  r = await oc.syncAddress(db, chain.rpc, { address: 'CURVE', mint: MINT, kind: 'curve', maxTx: 2, onTx });
  assert.deepEqual([r.fetched, r.complete, r.done, r.newSigs], [1, true, 4, 0]);
  assert.equal(chain.count('getTransaction'), 3);
  assert.equal(db.get('SELECT COUNT(*) n FROM chain_trades WHERE mint = ?', MINT).n, 2, 'a transaction without pump events stores nothing');
  // a new trade: only it is listed and fetched; re-storing a transaction never duplicates a trade
  chain.calls.length = 0;
  list.unshift(sig('n4', 40));
  r = await oc.syncAddress(db, chain.rpc, { address: 'CURVE', mint: MINT, kind: 'curve', maxTx: 5, onTx });
  assert.deepEqual([r.newSigs, r.fetched], [1, 1]);
  oc.storeTrades(db, legacy.tx, legacy.signature, MINT);
  assert.equal(db.get('SELECT COUNT(*) n FROM chain_trades').n, 2);
  // more than a page of history: the first walk takes the newest page, the rest comes one page per step
  const many = Array.from({ length: 2500 }, (_, i) => sig(`s${i}`, 5000 - i, { e: 1 }));
  const big = fakeChain({ sigs: { BIG: many } });
  const steps = [];
  for (let i = 0; i < 3; i++) steps.push(await oc.syncAddress(db, big.rpc, { address: 'BIG', mint: MINT, kind: 'curve', onTx }));
  assert.deepEqual(steps.map((s) => [s.newSigs, s.listedAll]), [[2000, false], [500, true], [0, true]]);
  assert.equal(steps[2].complete, true);
  assert.equal(big.count('getTransaction'), 0);
  // a transaction the RPC never serves is retried twice more, then set aside and counted, so the rest moves on
  const ghost = fakeChain({ sigs: { G: [sig('ghost', 9)] } });
  for (let i = 0; i < 3; i++) r = await oc.syncAddress(db, ghost.rpc, { address: 'G', mint: MINT, kind: 'curve', onTx });
  assert.deepEqual([r.complete, r.unreadable, ghost.count('getTransaction')], [true, 1, 3]);
});

test('the RPC client: paced, retried on 429, counted against the daily budget, stops at it', async () => {
  const { db, cfg } = makeEnv({ ONCHAIN_DAILY_CALLS: '3' });
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? new Response('slow down', { status: 429 }) : Response.json({ jsonrpc: '2.0', id: 1, result: n }));
  const rpc = oc.createRpc({ db, cfg, url: 'https://rpc.test', fetchImpl, minGapMs: 0, sleep: async () => {} });
  assert.equal(await rpc('getSlot', []), 2, 'the 429 was retried');
  assert.equal(oc.chainBudget(db, cfg).used, 2);
  await rpc('getSlot', []);
  await assert.rejects(rpc('getSlot', []), (e) => e.code === 'budget');
  assert.equal(oc.chainRpcUrl({ onchain: {}, coinStats: { heliusUrl: 'https://mainnet.helius-rpc.com/?api-key=k' }, launch: {} }, 'mainnet-beta').label, 'Helius RPC (mainnet)');
  assert.equal(oc.chainRpcUrl({ onchain: {}, coinStats: {}, launch: { network: 'devnet', rpcUrl: 'https://d.test' } }, 'mainnet-beta').url, 'https://api.mainnet-beta.solana.com');
});

// --- the endpoints ------------------------------------------------------------------------------------------------------
function hostCall(base, host, method, path) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers: { host, 'x-forwarded-for': '10.0.0.9' } }, (res) => {
      let text = ''; res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end();
  });
}
const KONBINI = 'Konbini Confession: every night people drop an anonymous confession at the konbini; at 23:00 JST one gets printed on the receipt.';

/** A JSON-RPC endpoint over fakeChain plus the token reads the holder tools make. */
function chainServer(chain) {
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    try { return Response.json({ jsonrpc: '2.0', id: 1, result: await chain.rpc(method, params) }); } catch (e) { return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: e.message } }); }
  };
}

test('project host: trades, holders, dev watch and fees from the chain; pre-launch and mock say so; polled at most every 15 s', async () => {
  const p = oc.pdas(MINT), ata = oc.ataOf(MINT, AUTHOR), acc = fx('konbini-accounts');
  const create = fx('konbini-create'), legacy = fx('konbini-trade-legacy'), v1 = fx('konbini-trade-v1'), dist = fx('konbini-distribute');
  const M = 1e12;
  const accountInfo = ([addr]) => ({ context: { slot: 9 }, value: Object.values(acc).find((a) => a.address === addr)?.value ?? null });
  const chain = fakeChain({
    sigs: { [p.curve]: [sig(legacy.signature, 30), sig(v1.signature, 20), sig(create.signature, 1)], [ata]: [sig(create.signature, 1)], [p.sharing]: [sig(dist.signature, 25), sig(create.signature, 1)] },
    txs: { [create.signature]: create.tx, [legacy.signature]: legacy.tx, [v1.signature]: v1.tx, [dist.signature]: dist.tx },
    extra: {
      getAccountInfo: accountInfo,
      getTokenSupply: () => ({ value: { amount: String(1_000_000_000e6), decimals: 6 } }),
      getTokenLargestAccounts: () => ({ value: [{ address: 'TA1', amount: String(500 * M) }, { address: 'TA2', amount: String(300 * M) }, { address: 'TA3', amount: String(30 * M) }] }),
      getMultipleAccounts: () => ({ value: [p.curve, 'A2RB47FBfwDyev6JtQAmYJ8gzvDbQ6Z4kZb7w25Smo7J', AUTHOR].map((owner) => ({ data: { parsed: { info: { owner } } } })) }),
      getTokenAccountsByOwner: () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(30 * M) } } } } } }] }),
      getBalance: () => ({ value: 650_240 + 5_000_000 }),
      getMinimumBalanceForRentExemption: () => 650_240,
    } });
  let brainFetch = null;
  const h = await harness({ TRUST_PROXY: '1', ONCHAIN_RPC_URL: 'https://chain.test/rpc', ONCHAIN_MIN_GAP_MS: '0' },
    { fetchImpl: (url, init) => (String(url).startsWith('https://chain.test') ? chainServer(chain)(url, init) : brainFetch(url, init)) });
  brainFetch = h.brain.fetchImpl;
  try {
    const owner = h.client(user(h.db)); await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: 'Konbini Confession', nameSuggestion: 'Konbini Confession', tickerSuggestion: 'KONBINI', concept: KONBINI }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug, host = `${slug}.${h.cfg.projectsHost}`;
    const site = (path) => hostCall(h.base, host, 'GET', path);
    // pre-launch: the tools are on the page, in their own section, saying when they go live
    const page = await site('/');
    assert.match(page.text, /<h2 class="sec">Check the chain<\/h2>/);
    for (const id of TRUST) assert.match(page.text, new RegExp(`data-tool="${id}"`));
    assert.match(page.text, /Goes live at launch: there is no coin on chain yet\./);
    const pre = (await site('/_api/trades')).json;
    assert.deepEqual([pre.state, pre.note], ['pre-launch', 'Goes live at launch: this reads the coin from the chain once it exists.']);
    assert.equal(chain.calls.length, 0, 'no chain read before a launch');
    // launched on mainnet with pump.fun: the real Konbini mint, author, locked 80/20 split
    const proj = h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
    const alloc = h.db.get('SELECT id FROM fee_allocations WHERE project_id = ? ORDER BY version DESC LIMIT 1', proj.id);
    const config = { feeSharing: { mode: 'sharing_config', recipients: [{ label: 'Idea submitter', wallet: AUTHOR, bps: 8000, role: 'submitter' }, { label: 'SUB-01', wallet: SUB01, bps: 2000, role: 'sub01' }] }, initialBuyLamports: 0 };
    h.db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, tx_signature, created_at, updated_at)
      VALUES ('int_k', ?, 'pumpfun', 'mainnet-beta', ?, 'h', ?, ?, ?, 'confirmed', ?, 1, 1)`, proj.id, JSON.stringify(config), alloc.id, MINT, AUTHOR, create.signature);
    h.db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, 'int_k', 'pumpfun', 'mainnet-beta', ?, ?, '[]', 1)`,
      proj.id, MINT, create.signature);
    const tr = (await site('/_api/trades')).json;
    assert.equal(tr.state, 'live');
    assert.equal(tr.migrated, false);
    assert.deepEqual(tr.trades.map((x) => [x.side, x.sol, x.tokens, x.short]), [['sell', 0.211718025, 4_761_603.244368, 'A2RB…mo7J'], ['sell', 0.114205529, 2_307_010.393066, 'Ad7m…gMZo']]);
    assert.equal(tr.trades[0].txUrl, `https://solscan.io/tx/${legacy.signature}`);
    assert.equal(tr.history.complete, true);
    assert.ok(tr.last24h == null || typeof tr.last24h.buys === 'number');
    const calls = chain.calls.length;
    await site('/_api/trades');
    assert.equal(chain.calls.length, calls, 'a second visitor within 15 s reads the stored copy');
    // holders: the plain-RPC top 20 (no Helius here), the curve left out, the author labelled
    const ho = (await site('/_api/holders')).json;
    assert.deepEqual(ho.holders.map((x) => [x.pct, x.label, x.excluded]), [[50, 'bonding curve (unsold supply)', true], [30, null, false], [3, 'author (dev)', false]]);
    assert.equal(ho.risk.line, 'The 2 wallets holding it hold 33% of the supply and 66% of the tokens in circulation: moderate concentration. The largest wallet alone holds 30%. Not counted: bonding curve (unsold supply) (50%).');
    assert.equal(ho.count, null); assert.match(ho.countNote, /Helius/);
    // the top-10 flag reaches the trades feed once the holders were read
    assert.ok((await site('/_api/trades')).json.trades[0].flags.includes('top10'));
    // dev watch: no dev buy in Konbini's launch; 30 M tokens in the author wallet now
    const dv = (await site('/_api/devwatch')).json;
    assert.deepEqual([dv.devBuy, dv.balance, dv.devBuySource], [0, 30_000_000, 'no dev buy in the launch']);
    assert.equal(dv.status, 'The author made no dev buy at launch; the author wallet holds 30.00M tokens now.');
    // fees: the locked split read on chain, the payout decoded, the vault less its rent
    const fe = (await site('/_api/fees')).json;
    assert.equal(fe.adminRevoked, true);
    assert.equal(fe.partial, false, 'the payout history was read to its start');
    assert.deepEqual(fe.shareholders.map((s) => [s.label, s.pct, s.received]), [['author (dev)', 80, 0.061226064], ['SUB-01', 20, 0.015306516]]);
    assert.equal(fe.distributed, 0.07653258); assert.equal(fe.waiting, 0.005); assert.equal(fe.accrued, 0.08153258);
    assert.deepEqual(fe.distributions.map((d) => d.sol), [0.07653258], 'the 0-lamport distribution at creation is not listed');
    assert.equal(fe.fromTrades.trades, 2);
    // a tool the author switched off answers 404
    await owner.call('PUT', `/api/projects/${slug}/tools`, { tools: [{ id: 'token' }, { id: 'trades' }] });
    assert.equal((await site('/_api/holders')).status, 404);
    assert.equal((await site('/_api/trades')).status, 200);
  } finally { h.close(); }
});

// --- the kit and the backfill -------------------------------------------------------------------------------------------
test('the built holder chunk: no HTML sinks, no eval, no transactions; loaded lazily, the core stays small', () => {
  const dir = join(ROOT, 'public', '_kit');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const file = manifest.vendor.holderTools;
  assert.match(file, /^holder-tools\.[0-9a-f]{10}\.js$/);
  assert.ok(readdirSync(join(dir, 'vendor')).includes(file));
  const code = readFileSync(join(dir, 'vendor', file), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'new Function', 'eval(', 'signTransaction', 'sendTransaction', 'signMessage']) assert.ok(!code.includes(bad), bad);
  const core = readFileSync(join(dir, 'site-kit.v1.js'), 'utf8');
  assert.ok(core.includes(file), 'the core knows the chunk by its hashed name');
  assert.ok(manifest.files['site-kit.v1.js'].gzip < 20_000);
});

test('backfill: launched coins get the holder tools once, as a new public version; an all-off site is left alone', async () => {
  const h = await harness({ TRUST_PROXY: '1' });
  try {
    const owner = h.client(user(h.db)); await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: 'Konbini Confession', nameSuggestion: 'Konbini Confession', tickerSuggestion: 'KONBINI', concept: KONBINI }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const p = () => h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
    // a v1 site: tools without the holder tools (as built before this pack)
    const row = h.db.get('SELECT * FROM site_versions WHERE project_id = ? AND version = ?', p().id, p().live_site_version);
    const old = JSON.parse(row.spec_json); old.tools = validateTools(old.tools.filter((t) => !TRUST.includes(t.id)));
    h.db.run('UPDATE site_versions SET spec_json = ? WHERE id = ?', JSON.stringify(old), row.id);
    assert.deepEqual((await backfillHolderTools(h.db, h.cfg)).added, [], 'not launched: left alone');
    const alloc = h.db.get('SELECT id FROM fee_allocations WHERE project_id = ? ORDER BY version DESC LIMIT 1', p().id);
    const mint = wallet().address;
    h.db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, tx_signature, created_at, updated_at)
      VALUES ('int_b', ?, 'mock', 'mock', '{}', 'h', ?, ?, 'w', 'confirmed', 'sig_b', 1, 1)`, p().id, alloc.id, mint);
    h.db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, 'int_b', 'mock', 'mock', ?, 'sig_b', '[]', 1)`, p().id, mint);
    h.db.run(`UPDATE ideas SET status = 'launched' WHERE id = ?`, p().idea_id);
    const before = p().live_site_version;
    const out = await backfillHolderTools(h.db, h.cfg);
    assert.deepEqual(out.added.map((a) => [a.slug, a.tools]), [[slug, TRUST]]);
    assert.equal(p().live_site_version, before + 1);
    assert.deepEqual(liveSpec(h.db, p()).tools.map((t) => t.id).slice(-5), TRUST);
    assert.match(h.db.get(`SELECT message FROM events WHERE kind = 'tools' ORDER BY id DESC LIMIT 1`).message, /^SUB-01 added holder tools to the site: trades, holders, devwatch, fees, alerts \(site v\d+\)$/);
    assert.deepEqual((await backfillHolderTools(h.db, h.cfg)).added, [], 'idempotent');
    // a MOCK launch has no chain: the tools say so and read nothing
    const mock = (await hostCall(h.base, `${slug}.${h.cfg.projectsHost}`, 'GET', '/_api/devwatch')).json;
    assert.deepEqual([mock.state, mock.note], ['mock', 'MOCK launch: there is no blockchain behind this coin, so there is nothing to read.']);
    // the author removes them afterwards: the audit line keeps the backfill from adding them back
    await owner.call('PUT', `/api/projects/${slug}/tools`, { tools: [{ id: 'token' }] });
    assert.deepEqual((await backfillHolderTools(h.db, h.cfg)).added, []);
    await owner.call('PUT', `/api/projects/${slug}/tools`, { tools: [] });
    assert.deepEqual((await backfillHolderTools(h.db, h.cfg)).added, []);
  } finally { h.close(); }
});

test('boot order site-tools -> app -> holder tools: both sections render, and a second boot rebuilds nothing', async () => {
  const h = await harness({ TRUST_PROXY: '1' });
  try {
    const owner = h.client(user(h.db)); await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: 'Konbini Confession', nameSuggestion: 'Konbini Confession', tickerSuggestion: 'KONBINI', concept: KONBINI }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const p = () => h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
    // a coin launched before both packs: v1 tools, no app key
    const row = h.db.get('SELECT * FROM site_versions WHERE project_id = ? AND version = ?', p().id, p().live_site_version);
    const old = JSON.parse(row.spec_json); delete old.app;
    old.tools = validateTools([{ id: 'token' }, { id: 'drop', config: { prompt: 'Drop your confession.', revealJst: '23:00' } }, { id: 'wall' }]);
    h.db.run('UPDATE site_versions SET spec_json = ? WHERE id = ?', JSON.stringify(old), row.id);
    const alloc = h.db.get('SELECT id FROM fee_allocations WHERE project_id = ? ORDER BY version DESC LIMIT 1', p().id);
    const mint = wallet().address;
    h.db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, tx_signature, created_at, updated_at)
      VALUES ('int_o', ?, 'mock', 'mock', '{}', 'h', ?, ?, 'w', 'confirmed', 'sig_o', 1, 1)`, p().id, alloc.id, mint);
    h.db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, 'int_o', 'mock', 'mock', ?, 'sig_o', '[]', 1)`, p().id, mint);
    h.db.run(`UPDATE ideas SET status = 'launched' WHERE id = ?`, p().idea_id);
    const boot = async () => [(await backfillTools(h.db, h.cfg)).added.length, (await backfillApps(h.db, h.cfg)).built.length, (await backfillHolderTools(h.db, h.cfg)).added.length];
    assert.deepEqual(await boot(), [0, 1, 1], 'the app first, then the holder tools appended to what the app left');
    const spec = liveSpec(h.db, p());
    assert.ok(spec.app, 'the app is on');
    assert.deepEqual(spec.tools.map((t) => t.id).slice(-5), TRUST);
    const page = (await hostCall(h.base, `${slug}.${h.cfg.projectsHost}`, 'GET', '/')).text;
    assert.match(page, /<section class="app card reveal" id="app" data-app/);
    assert.match(page, /<h2 class="sec">Check the chain<\/h2>/);
    const v = p().live_site_version;
    assert.deepEqual(await boot(), [0, 0, 0], 'idempotent together');
    assert.equal(p().live_site_version, v);
  } finally { h.close(); }
});
