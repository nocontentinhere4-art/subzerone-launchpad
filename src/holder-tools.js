// The holder tools on the coin sites (docs/SITE-KIT.md "Holder tools"): /_api/trades, /_api/holders, /_api/devwatch,
// /_api/fees on <slug>.<PROJECTS_HOST>, answered from real chain data only (onchain.js). Nothing is polled in the
// background: a page's request brings the coin's copy up to date, at most every 15 s for trades (30 s dev, 60 s fees,
// 5 min holders) and only while some page keeps asking; the first request of a quiet coin waits a moment for the read.
// A number that was not read is null (the page shows "—" with the reason). The fifth tool, alerts, runs in the
// visitor's browser on /_api/token and /_api/devwatch and keeps nothing on the server.
import { audit, setSetting } from './db.js';
import { heliusBudget, HOLDERS } from './coin-stats.js';
import { feeLedger } from './launch.js';
import { HttpError, now, parseJson } from './util.js';
import { toolOf, TRUST, defaultConfig, validateTools } from './tools.js';
import * as oc from './onchain.js';

export const POLL = Object.freeze({ tradesMs: 15_000, devMs: 30_000, feesMs: 60_000, holdersMs: 5 * 60_000, curveMs: 60_000, balanceMs: 30_000, sharingMs: 10 * 60_000, firstWaitMs: 3_500 });
export const LIST = Object.freeze({ trades: 50, moves: 50, dasPages: 5 });
export const HOLDER_PATHS = Object.freeze({ '/_api/trades': 'trades', '/_api/holders': 'holders', '/_api/devwatch': 'devwatch', '/_api/fees': 'fees' });
const SOL = 1e9;

const NOTES = {
  'pre-launch': 'Goes live at launch: this reads the coin from the chain once it exists.',
  mock: 'MOCK launch: there is no blockchain behind this coin, so there is nothing to read.',
};
const errText = (e) => (e instanceof oc.ChainError ? e.message : `could not read the chain just now (${String(e?.message || e).slice(0, 80)})`);

export function createHolderTools({ db, cfg, fetchImpl = fetch, sleep, poll = POLL }) {
  const rpcs = new Map();
  const rpcFor = (network) => {
    const { url, label } = oc.chainRpcUrl(cfg, network);
    if (!rpcs.has(url)) rpcs.set(url, { call: oc.createRpc({ db, cfg, url, fetchImpl, sleep, minGapMs: cfg.onchain.minGapMs ?? undefined }), label });
    return rpcs.get(url);
  };

  // a sync step: at most every `gapMs` per key, one at a time; the request waits up to `waitMs` for it
  const steps = new Map();
  async function step(key, gapMs, fn, waitMs = poll.firstWaitMs) {
    let s = steps.get(key);
    if (!s) steps.set(key, (s = { at: 0, p: null, error: null }));
    if (!s.p && Date.now() - s.at >= gapMs) {
      s.at = Date.now();
      s.p = Promise.resolve().then(fn).then(() => { s.error = null; }, (e) => { s.error = errText(e); }).finally(() => { s.p = null; });
    }
    if (s.p && waitMs > 0) await Promise.race([s.p, new Promise((r) => { setTimeout(r, waitMs).unref?.(); })]);
    return { busy: !!s.p, error: s.error };
  }
  // a cached read: at most every `ttl` per key, deduplicated; a failed read keeps the last good value and says so
  const memo = new Map();
  async function cached(key, ttl, fn) {
    let m = memo.get(key);
    if (!m) memo.set(key, (m = { at: 0, value: undefined, p: null, error: null }));
    if (!m.p && Date.now() - m.at >= ttl) {
      m.p = (async () => { try { m.value = await fn(); m.at = Date.now(); m.error = null; } catch (e) { m.error = errText(e); m.at = Date.now() - ttl + 15_000; } finally { m.p = null; } })();
    }
    if (m.p) await m.p;
    if (m.value === undefined && m.error) throw new oc.ChainError(m.error);
    return { value: m.value, at: m.at, error: m.error };
  }
  const peek = (key) => memo.get(key)?.value;

  /** The coin behind a project: state, mint, author, dev buy, the reviewed launch config. */
  function coinOf(project) {
    const launch = db.get('SELECT * FROM launches WHERE project_id = ?', project.id);
    if (!launch) return { state: 'pre-launch' };
    if (launch.provider === 'mock' || launch.network === 'mock') return { state: 'mock', mint: launch.mint, network: launch.network };
    const intent = db.get('SELECT signer_wallet, buy_tokens_base, config_json FROM launch_intents WHERE id = ?', launch.intent_id) || {};
    const config = parseJson(intent.config_json, {}) || {};
    const labels = new Map();
    for (const r of config.feeSharing?.recipients || []) if (r?.wallet) labels.set(r.wallet, r.role === 'sub01' ? 'SUB-01' : r.role === 'submitter' ? 'author' : String(r.label || '').slice(0, 30) || null);
    if (cfg.sub01FeeWallet) labels.set(cfg.sub01FeeWallet, 'SUB-01');
    if (intent.signer_wallet) labels.set(intent.signer_wallet, 'author (dev)');
    return { state: 'live', project, launch, mint: launch.mint, network: launch.network, author: intent.signer_wallet || null, launchSig: launch.tx_signature,
      devBuyReviewed: intent.buy_tokens_base ? Number(intent.buy_tokens_base) : null, devBuyLamports: Number(config.initialBuyLamports) || 0,
      sharingMode: config.feeSharing?.mode || null, labels };
  }
  const solscan = (c, kind, x) => `https://solscan.io/${kind}/${x}${c.network === 'devnet' ? '?cluster=devnet' : ''}`;
  const base = (c) => ({ state: c.state, mint: c.mint ?? null, network: c.network ?? null, note: NOTES[c.state] ?? null });

  // --- trades --------------------------------------------------------------------------------------------------------
  async function curveState(c) {
    try { return (await cached(`curve:${c.mint}`, poll.curveMs, () => oc.readCurve(rpcFor(c.network).call, oc.pdas(c.mint).curve))).value; } catch { return undefined; }
  }
  async function trades(c) {
    const p = oc.pdas(c.mint), rpc = rpcFor(c.network);
    const s = await step(`trades:${c.mint}`, poll.tradesMs, () => oc.syncAddress(db, rpc.call, { address: p.curve, mint: c.mint, kind: 'curve', maxTx: cfg.onchain.txPerPoll,
      onTx: (tx, row) => { oc.storeTrades(db, tx, row.signature, c.mint); return null; } }));
    const curve = await curveState(c);
    const hist = oc.historyOf(db, p.curve);
    const rows = db.all('SELECT * FROM chain_trades WHERE mint = ? ORDER BY slot DESC, block_time DESC, signature, idx DESC LIMIT ?', c.mint, LIST.trades);
    const top10 = new Set(peek(`holders:${c.mint}`)?.top10Owners || []);
    const firsts = new Map();
    if (hist.complete) {
      for (const u of new Set(rows.filter((r) => r.is_buy).map((r) => r.user))) {
        const f = db.get('SELECT signature, idx FROM chain_trades WHERE mint = ? AND user = ? AND is_buy = 1 ORDER BY slot, idx LIMIT 1', c.mint, u);
        if (f) firsts.set(u, `${f.signature}:${f.idx}`);
      }
    }
    const t = now(), day = Math.floor((t - 86_400_000) / 1000);
    const covers24h = hist.complete || (hist.oldestAt != null && hist.oldestAt <= t - 86_400_000);
    const agg = covers24h ? db.get(`SELECT SUM(is_buy) buys, SUM(1 - is_buy) sells, SUM(CASE WHEN is_buy = 1 THEN quote_amount ELSE 0 END) inq, SUM(CASE WHEN is_buy = 0 THEN quote_amount ELSE 0 END) outq,
      COUNT(DISTINCT user) wallets FROM chain_trades WHERE mint = ? AND block_time >= ? AND quote_mint = ?`, c.mint, day, oc.WSOL) : null;
    const migrated = curve ? curve.complete : null;
    return { ...base(c), source: rpc.label, syncing: s.busy, error: s.error, at: db.get('SELECT polled_at FROM chain_cursors WHERE address = ?', p.curve)?.polled_at ?? null,
      migrated, note: migrated ? 'This coin completed its bonding curve and moved to PumpSwap: trades after the migration happen on the AMM and are not listed here. See them on DexScreener.' : null,
      links: { dexscreener: c.network === 'mainnet-beta' ? `https://dexscreener.com/solana/${c.mint}` : null, curve: solscan(c, 'account', p.curve) },
      history: hist,
      last24h: agg ? { buys: agg.buys || 0, sells: agg.sells || 0, solIn: (agg.inq || 0) / SOL, solOut: (agg.outq || 0) / SOL, wallets: agg.wallets || 0 } : null,
      trades: rows.map((r) => {
        const flags = [];
        if (c.author && r.user === c.author) flags.push('dev');
        if (top10.has(r.user)) flags.push('top10');
        if (r.is_buy && firsts.get(r.user) === `${r.signature}:${r.idx}`) flags.push('first');
        return { sig: r.signature, at: r.block_time == null ? null : r.block_time * 1000, side: r.is_buy ? 'buy' : 'sell', sol: r.quote_mint === oc.WSOL ? r.quote_amount / SOL : null,
          quote: r.quote_mint === oc.WSOL ? 'SOL' : r.quote_mint, quoteAmount: r.quote_amount, tokens: r.token_amount / 10 ** oc.TOKEN_DECIMALS, wallet: r.user, short: oc.shortKey(r.user),
          walletUrl: solscan(c, 'account', r.user), txUrl: solscan(c, 'tx', r.signature), flags };
      }) };
  }

  // --- holders -------------------------------------------------------------------------------------------------------
  /** Helius DAS: every token account of the mint, page by page, within the shared Helius page budget; partial: complete false. */
  async function dasAccounts(mint) {
    const budget = heliusBudget(db, cfg);
    const maxPages = Math.min(LIST.dasPages, budget.left);
    if (maxPages <= 0) return null;
    const accounts = [];
    let cursor = null, pages = 0, complete = false;
    try {
      while (pages < maxPages) {
        const r = await fetchImpl(cfg.coinStats.heliusUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 'holders', method: 'getTokenAccounts', params: { mint, limit: HOLDERS.pageSize, options: { showZeroBalance: false }, ...(cursor ? { cursor } : {}) } }) });
        pages++;
        if (!r.ok) throw new Error(`helius HTTP ${r.status}`);
        const j = await r.json();
        if (j.error) throw new Error(`helius: ${String(j.error.message || 'error').slice(0, 80)}`);
        const list = Array.isArray(j.result?.token_accounts) ? j.result.token_accounts : [];
        for (const a of list) accounts.push({ address: a.address, owner: a.owner, amount: Number(a.amount) || 0 });
        cursor = typeof j.result?.cursor === 'string' && j.result.cursor ? j.result.cursor : null;
        if (!cursor || list.length < HOLDERS.pageSize) { complete = true; break; }
      }
    } finally {
      if (pages) setSetting(db, 'coin_stats.helius', { day: budget.day, pages: budget.used + pages }, 'coin_stats');
    }
    return { accounts, complete };
  }
  async function readHolders(c) {
    const rpc = rpcFor(c.network), p = oc.pdas(c.mint);
    const supply = Number((await rpc.call('getTokenSupply', [c.mint, { commitment: 'confirmed' }]))?.value?.amount) || 0;
    let accounts = null, count = null, countExact = false, countSource = null, source;
    if (c.network === 'mainnet-beta' && cfg.coinStats.heliusUrl) {
      const das = await dasAccounts(c.mint).catch(() => null);
      if (das?.complete) {
        accounts = das.accounts;
        count = new Set(accounts.filter((a) => a.amount > 0).map((a) => a.owner)).size; countExact = true; countSource = 'Helius DAS getTokenAccounts (every account counted)';
        source = 'Helius DAS getTokenAccounts: every token account of the coin';
      } else if (das) {
        count = new Set(das.accounts.filter((a) => a.amount > 0).map((a) => a.owner)).size; countSource = `Helius DAS (first ${das.accounts.length} accounts read: a floor)`;
      }
    }
    if (!accounts) {
      const largest = (await rpc.call('getTokenLargestAccounts', [c.mint, { commitment: 'confirmed' }]))?.value || [];
      const infos = largest.length ? (await rpc.call('getMultipleAccounts', [largest.map((a) => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value || [] : [];
      accounts = largest.map((a, i) => ({ address: a.address, owner: infos[i]?.data?.parsed?.info?.owner ?? null, amount: Number(a.amount) || 0 }));
      source = 'Solana RPC getTokenLargestAccounts: the 20 largest token accounts';
    }
    if (!countExact) {
      const st = parseJson(db.get('SELECT json FROM coin_stats WHERE mint = ?', c.mint)?.json);
      const stored = Number(st?.holders?.count);
      if (Number.isFinite(stored) && stored > (count ?? -1)) { count = stored; countExact = !!st.holders.exact; countSource = `coin stats (${st.holders.source || 'stored'}, ${new Date(st.holders.at).toISOString().slice(0, 16)} UTC)`; }
    }
    const exclude = new Map([[p.curve, 'bonding curve (unsold supply)'], [p.pool, 'PumpSwap pool (liquidity)']]);
    const v = oc.holdersView({ accounts, supply, exclude, labels: c.labels, count, countExact, programOwned: oc.isOffCurve });
    return { ...v, supply: supply / 10 ** oc.TOKEN_DECIMALS, source, countSource, countNote: count == null ? 'Holder count needs the Helius reader (HELIUS_API_KEY), which this server does not have; the top 20 come from the plain RPC.' : null,
      top10Owners: v.holders.filter((h) => !h.excluded).slice(0, 10).map((h) => h.owner) };
  }
  async function holders(c) {
    let r;
    try { r = await cached(`holders:${c.mint}`, poll.holdersMs, () => readHolders(c)); } catch (e) { return { ...base(c), error: errText(e), holders: [], top10Pct: null, top1Pct: null, count: null, risk: { level: null, line: 'No holder data: the chain could not be read just now.' } }; }
    const { top10Owners, ...v } = r.value;
    return { ...base(c), ...v, at: r.at, error: r.error, holders: v.holders.map((h) => ({ ...h, url: solscan(c, 'account', h.owner) })) };
  }

  // --- dev watch -----------------------------------------------------------------------------------------------------
  async function devwatch(c) {
    if (!c.author) return { ...base(c), error: 'the author wallet of this launch is not recorded', status: null, moves: [] };
    const rpc = rpcFor(c.network), ata = oc.ataOf(c.mint, c.author, true);
    const s = await step(`dev:${c.mint}`, poll.devMs, () => oc.syncAddress(db, rpc.call, { address: ata, mint: c.mint, kind: 'dev', maxTx: 25, onTx: (tx, row) => {
      const tr = oc.storeTrades(db, tx, row.signature, c.mint).filter((x) => x.user === c.author);
      const delta = oc.ownerDelta(tx, c.mint, c.author);
      const kind = row.signature === c.launchSig && delta > 0 ? 'dev buy' : delta < 0 && tr.some((x) => !x.isBuy) ? 'sell' : delta > 0 && tr.some((x) => x.isBuy) ? 'buy'
        : delta < 0 && oc.touches(tx, oc.PUMP_AMM) ? 'sell (PumpSwap)' : delta < 0 ? 'out' : delta > 0 ? 'in' : 'other';
      return { delta, kind, quote: tr.reduce((sum, x) => sum + x.quoteAmount, 0) };
    } }));
    let balance = null, balErr = null;
    try {
      balance = (await cached(`devbal:${c.mint}`, poll.balanceMs, async () => {
        const r = await rpc.call('getTokenAccountsByOwner', [c.author, { mint: c.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        return (r?.value || []).reduce((sum, a) => sum + (Number(a?.account?.data?.parsed?.info?.tokenAmount?.amount) || 0), 0);
      })).value;
    } catch (e) { balErr = errText(e); }
    const hist = oc.historyOf(db, ata);
    const moves = db.all('SELECT signature, block_time, data_json FROM chain_sigs WHERE address = ? AND done_at IS NOT NULL AND data_json IS NOT NULL', ata)
      .map((r) => ({ signature: r.signature, at: r.block_time == null ? null : r.block_time * 1000, ...parseJson(r.data_json, {}) })).filter((m) => m.delta);
    const launchMove = moves.find((m) => m.kind === 'dev buy');
    const devBuy = c.devBuyReviewed ?? launchMove?.delta ?? (c.devBuyLamports === 0 ? 0 : null);
    const v = oc.devView({ devBuy, balance, moves, complete: hist.complete });
    const tok = (x) => (x == null ? null : x / 10 ** oc.TOKEN_DECIMALS);
    return { ...base(c), author: c.author, authorShort: oc.shortKey(c.author), authorUrl: solscan(c, 'account', c.author), account: ata, syncing: s.busy, error: s.error || balErr,
      devBuy: tok(devBuy), devBuySource: c.devBuyReviewed != null ? 'dev buy from the reviewed launch transaction (exact-out, verified at launch)' : launchMove ? 'dev buy read from the launch transaction' : devBuy === 0 ? 'no dev buy in the launch' : null,
      balance: tok(balance), heldPct: v.heldPct, sold: tok(v.sold), left: tok(v.left), status: v.status, level: v.level, history: hist,
      moves: v.moves.slice(0, LIST.moves).map((m) => ({ sig: m.signature, at: m.at, kind: m.kind, tokens: tok(m.delta), sol: m.quote ? m.quote / SOL : null, txUrl: solscan(c, 'tx', m.signature) })) };
  }

  // --- fees ----------------------------------------------------------------------------------------------------------
  async function fees(c) {
    const rpc = rpcFor(c.network), p = oc.pdas(c.mint);
    const curve = await curveState(c);
    let sharing = null, err = null;
    try { sharing = (await cached(`sharing:${c.mint}`, poll.sharingMs, () => oc.readSharing(rpc.call, p.sharing))).value; } catch (e) { err = errText(e); }
    const links = { sharingConfig: solscan(c, 'account', p.sharing), vault: solscan(c, 'account', p.vaultOf(p.sharing)) };
    if (!sharing) {
      return { ...base(c), error: err, sharingConfig: null, links, accrued: null, distributed: null, waiting: null, shareholders: [], distributions: [],
        note: err ? null : curve?.creator ? `This coin has no fee sharing config: its creator fees go to the creator wallet ${oc.shortKey(curve.creator)}, whose vault also holds the fees of every other coin it created, so this coin's part cannot be separated.` : 'No fee sharing config found for this coin.' };
    }
    const s = await step(`fees:${c.mint}`, poll.feesMs, () => oc.syncAddress(db, rpc.call, { address: p.sharing, mint: c.mint, kind: 'fees', maxTx: 25,
      onTx: (tx) => { const d = oc.decodeDistributions(tx, c.mint); return d.length ? { distributions: d } : null; } }));
    let waiting = null;
    try {
      waiting = (await cached(`waiting:${c.mint}`, poll.feesMs, async () => {
        const bal = Number((await rpc.call('getBalance', [p.vaultOf(p.sharing), { commitment: 'confirmed' }]))?.value) || 0;
        // the vault keeps its rent-exempt minimum; read it (it changed on mainnet: 650,240 lamports on 2026-10-12, not 890,880)
        const rent = (await cached(`rent0:${c.network}`, 3_600_000, async () => Number(await rpc.call('getMinimumBalanceForRentExemption', [0])))).value;
        let amm = null;
        if (curve?.complete) {
          try { amm = Number((await rpc.call('getTokenAccountBalance', [p.ammVaultAtaOf(p.sharing), { commitment: 'confirmed' }]))?.value?.amount) || 0; } catch { amm = 0; }   // no account yet: nothing waiting
        }
        return { vault: Math.max(0, bal - (bal > 0 ? rent : 0)), curve: curve ? curve.creatorFee : null, amm };
      })).value;
    } catch (e) { err = errText(e); }
    const distributions = db.all('SELECT signature, block_time, data_json FROM chain_sigs WHERE address = ? AND data_json IS NOT NULL', p.sharing)
      .flatMap((r) => (parseJson(r.data_json, {}).distributions || []).map((d) => ({ signature: r.signature, at: (r.block_time ?? d.timestamp) * 1000, lamports: d.distributed, shareholders: d.shareholders })))
      .filter((d) => d.lamports > 0);                         // the config's creation distributes 0 lamports
    const ft = db.get('SELECT SUM(creator_fee) fee, COUNT(*) n FROM chain_trades WHERE mint = ? AND quote_mint = ?', c.mint, oc.WSOL);
    const curveHist = oc.historyOf(db, p.curve);
    const v = oc.feesView({ sharing, waiting: waiting ? { vault: waiting.vault, curve: waiting.curve, ...(waiting.amm != null ? { amm: waiting.amm } : {}) } : null,
      distributions, fromTrades: { lamports: ft.fee || 0, trades: ft.n || 0, complete: curveHist.complete }, labels: c.labels });
    const ledger = c.project ? feeLedger(db, c.project.id) : null;
    const sol = (x) => (x == null ? null : x / SOL);
    const feeHist = oc.historyOf(db, p.sharing);
    return { ...base(c), error: s.error || err, syncing: s.busy, history: feeHist, partial: !feeHist.complete, sharingConfig: p.sharing, adminRevoked: v.adminRevoked, links,
      accrued: sol(v.accrued), distributed: sol(v.distributed), waiting: sol(v.waiting),
      waitingParts: { vault: sol(v.waitingParts.vault), curve: sol(v.waitingParts.curve), amm: sol(v.waitingParts.amm) },
      shareholders: v.shareholders.map((x) => ({ ...x, accrued: sol(x.accrued), received: sol(x.received), waiting: sol(x.waiting), url: solscan(c, 'account', x.address) })),
      distributions: v.distributions.slice(0, 20).map((d) => ({ sig: d.signature, at: d.at, sol: sol(d.lamports), txUrl: solscan(c, 'tx', d.signature) })),
      fromTrades: { sol: sol(v.fromTrades.lamports), trades: v.fromTrades.trades, complete: v.fromTrades.complete },
      ledger: ledger ? { accrued: sol(ledger.verifiedAccruedLamports), paid: sol(ledger.confirmedPayoutsLamports), observedAt: ledger.vaultObservedAt } : null,
      migrated: curve ? curve.complete : null };
  }

  const run = { trades, holders, devwatch, fees };
  return {
    /** GET /_api/<tool>: the tool's answer for this project (the caller checked the tool is on). */
    async handle(path, project) {
      const tool = HOLDER_PATHS[path];
      const c = coinOf(project);
      if (c.state !== 'live') return { body: { ...base(c), tool }, cache: 'public, max-age=60' };
      try {
        return { body: { tool, ...(await run[tool](c)) }, cache: tool === 'holders' ? 'public, max-age=60' : 'public, max-age=10' };
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return { body: { tool, ...base(c), error: errText(e) }, cache: 'no-store' };
      }
    },
    coinOf,
    /** One tool's answer for a coin described directly (scripts/check-holder-tools.js reads coins that are not in this database). */
    read: (tool, c) => run[tool]({ state: 'live', labels: new Map(), ...c }),
  };
}

// --- boot backfill (scripts/backfill-site-tools.js) --------------------------------------------------------------------
/** Launched coins get the holder tools (the trust layer: trades, holders, dev watch, fees, alerts) as a NEW site version,
 * set live, audited publicly "SUB-01 added holder tools". Once per coin: a coin that has the audit line, already shows
 * all of them, or whose author switched every tool off (tools: []) is left alone. */
export async function backfillHolderTools(db, cfg) {
  const { buildSiteVersion, setLiveVersion } = await import('./site.js');
  const { liveSpec } = await import('./tool-api.js');
  const out = { added: [], skipped: 0, failed: [] };
  const rows = db.all(`SELECT p.* FROM projects p JOIN ideas i ON i.id = p.idea_id JOIN launches l ON l.project_id = p.id
    WHERE i.status = 'launched' AND p.live_site_version IS NOT NULL ORDER BY p.created_at`);
  for (const p of rows) {
    const spec = liveSpec(db, p);
    const done = db.get(`SELECT 1 FROM events WHERE project_id = ? AND kind = 'tools' AND message LIKE 'SUB-01 added holder tools%'`, p.id);
    const missing = TRUST.filter((id) => !toolOf(spec, id));
    if (!spec || done || !Array.isArray(spec.tools) || !spec.tools.length || !missing.length) { out.skipped++; continue; }
    try {
      const tools = validateTools([...spec.tools, ...missing.map((id) => ({ id, config: defaultConfig(id, { name: spec.name }) }))]);
      const site = await buildSiteVersion(db, cfg, p, { ...spec, tools }, 'system:sub01-holder-tools');
      setLiveVersion(db, p, site.version, 'system');
      audit(db, { actor: 'system', kind: 'tools', projectId: p.id, ideaId: p.idea_id, isPublic: true,
        message: `SUB-01 added holder tools to the site: ${missing.join(', ')} (site v${site.version})` });
      out.added.push({ slug: p.slug, version: site.version, tools: missing });
    } catch (e) {
      out.failed.push({ slug: p.slug, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}
