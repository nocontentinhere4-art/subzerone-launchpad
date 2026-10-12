// Read-only integration check of the holder tools against a real chain (default: mainnet, the public RPC, paced).
// For each mint it reads the whole bonding-curve history through the same code the coin sites use (holder-tools.js,
// onchain.js), finds the launch transaction and its author from the CreateEvent, then prints what the four tools show:
// decoded trades, top holders and concentration, the dev status and the fee ledger, for a person to compare with
// pump.fun and Solscan. Nothing is signed or sent. The chain copy lands in DATA_DIR/launchpad.db (chain_* tables).
//   ONCHAIN_RPC_URL=https://api.mainnet-beta.solana.com node scripts/check-holder-tools.js <mint> [<mint>…]
// Holder counts use Helius DAS when HELIUS_API_KEY / HELIUS_URL is set (never printed), else the plain RPC's top 20.
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { createHolderTools, POLL } from '../src/holder-tools.js';
import * as oc from '../src/onchain.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'launchpad.db'));
migrate(db);
const mints = process.argv.slice(2);
if (!mints.length) { console.error('usage: node scripts/check-holder-tools.js <mint> [<mint>…]'); process.exit(2); }
const network = process.env.CHECK_NETWORK || 'mainnet-beta';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tools = createHolderTools({ db, cfg, poll: { ...POLL, tradesMs: 0, devMs: 0, feesMs: 0, firstWaitMs: 600_000 } });
const rpc = oc.createRpc({ db, cfg, url: oc.chainRpcUrl(cfg, network).url, minGapMs: cfg.onchain.minGapMs ?? undefined });
const sol = (x) => (x == null ? '—' : `${x.toFixed(6)} SOL`);
const tok = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-US'));
const at = (ms) => (ms == null ? '—' : new Date(ms).toISOString().replace('.000Z', 'Z'));
console.log(`chain reader: ${oc.chainRpcUrl(cfg, network).label}; holders: ${cfg.coinStats.heliusUrl ? 'Helius DAS (key from the environment, not printed)' : 'plain RPC (no Helius key)'}`);

for (const mint of mints) {
  console.log(`\n=== ${mint} (${network}) ===`);
  const base = { mint, network };
  // 1. the whole curve history (each read() runs one bounded step; repeat until complete)
  let tr;
  for (let i = 0; ; i++) {
    tr = await tools.read('trades', base);
    const hi = tr.history;
    if (i % 5 === 0 || hi.complete) console.log(`  curve history: ${hi.done}/${hi.listed} transactions read${hi.listedAll ? '' : ' (still listing)'}${tr.error ? ` · error: ${tr.error}` : ''}`);
    if (hi.complete) break;
    if (tr.error) await sleep(5000);
  }
  // 2. the launch: among the earliest successful transactions of the curve, the one with the CreateEvent (author = its user)
  let first = null, ctx = null, created = null;
  for (const row of db.all('SELECT signature FROM chain_sigs WHERE address = ? AND failed = 0 ORDER BY slot LIMIT 60', oc.pdas(mint).curve)) {   // snipers share the launch slot
    ctx = await rpc('getTransaction', [row.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    created = oc.decodeCreate(ctx, mint);
    if (created) { first = row; break; }
  }
  if (!created) { console.log('  no CreateEvent found among the earliest transactions'); continue; }
  const devBuy = oc.decodeTrades(ctx, mint).filter((x) => x.user === created?.user && x.isBuy).reduce((s, x) => s + x.tokenAmount, 0);
  console.log(`  launch tx ${first.signature} at ${at((ctx.blockTime || 0) * 1000)}; author ${created?.user}; dev buy in the launch tx: ${tok(devBuy / 1e6)} tokens`);
  const coin = { ...base, author: created?.user || null, launchSig: first.signature, devBuyReviewed: null, devBuyLamports: devBuy ? 1 : 0,   // the dev buy is read from the launch tx
    labels: new Map(created?.user ? [[created.user, 'author (dev)']] : []) };
  // 3. trades
  const all = db.get('SELECT COUNT(*) n, SUM(is_buy) buys, SUM(CASE WHEN is_buy = 1 THEN quote_amount ELSE 0 END) inq, SUM(CASE WHEN is_buy = 0 THEN quote_amount ELSE 0 END) outq, MIN(block_time) a, MAX(block_time) b, COUNT(DISTINCT user) w FROM chain_trades WHERE mint = ?', mint);
  console.log(`  TRADES decoded: ${all.n} (${all.buys} buys, ${all.n - all.buys} sells) by ${all.w} wallets, ${at(all.a * 1000)} → ${at(all.b * 1000)}; SOL in ${sol(all.inq / 1e9)}, out ${sol(all.outq / 1e9)}; migrated: ${tr.migrated}`);
  if (tr.last24h) console.log(`  last 24 h: ${tr.last24h.buys} buys, ${tr.last24h.sells} sells, ${sol(tr.last24h.solIn)} in, ${sol(tr.last24h.solOut)} out, ${tr.last24h.wallets} wallets`);
  for (const x of tr.trades.slice(0, 5)) console.log(`    ${at(x.at)} ${x.side.padEnd(4)} ${sol(x.sol)} ${tok(x.tokens)} tokens ${x.wallet} ${x.flags.join(',')} ${x.sig}`);
  // 4. holders
  const ho = await tools.read('holders', coin);
  console.log(`  HOLDERS: ${ho.count == null ? '—' : `${ho.countExact ? '' : '≥ '}${ho.count}`} (${ho.countSource || ho.countNote || 'no count'}); source: ${ho.source}${ho.error ? ` · error: ${ho.error}` : ''}`);
  console.log(`  ${ho.risk?.line}`);
  for (const x of (ho.holders || []).slice(0, 12)) console.log(`    #${String(x.rank).padStart(2)} ${x.owner} ${String(x.pct).padStart(6)}% ${tok(x.amount / 1e6)}${x.label ? ` [${x.label}]` : ''}`);
  // 5. dev watch (whole history of the author's token account)
  let dv;
  for (;;) { dv = await tools.read('devwatch', coin); if (dv.history?.complete || dv.error) break; }
  console.log(`  DEV ${dv.author}: dev buy ${tok(dv.devBuy)} (${dv.devBuySource || 'unknown'}), holds ${tok(dv.balance)} now, sold ${tok(dv.sold)}${dv.error ? ` · error: ${dv.error}` : ''}`);
  console.log(`  status: ${dv.status}`);
  for (const m of (dv.moves || []).slice(0, 8)) console.log(`    ${at(m.at)} ${m.kind.padEnd(16)} ${tok(m.tokens)} tokens ${m.sol ? sol(m.sol) : ''} ${m.sig}`);
  // 6. fees (whole history of the sharing config)
  let fe;
  for (;;) { fe = await tools.read('fees', coin); if (!fe.sharingConfig || fe.history?.complete || fe.error) break; }
  console.log(`  FEES sharing config ${fe.sharingConfig} (admin revoked: ${fe.adminRevoked})${fe.note ? ` · ${fe.note}` : ''}${fe.error ? ` · error: ${fe.error}` : ''}`);
  console.log(`  accrued ${sol(fe.accrued)} = paid out ${sol(fe.distributed)} (${fe.distributions?.length ?? 0} payouts listed) + waiting ${sol(fe.waiting)} [vault ${sol(fe.waitingParts?.vault)}, curve ${sol(fe.waitingParts?.curve)}${fe.waitingParts?.amm != null ? `, PumpSwap ${sol(fe.waitingParts.amm)}` : ''}]`);
  for (const s of fe.shareholders || []) console.log(`    ${s.address} ${s.pct}%${s.label ? ` [${s.label}]` : ''}: accrued ${sol(s.accrued)}, received ${sol(s.received)}, waiting ${sol(s.waiting)}`);
  console.log(`  cross-check: creator fees in the ${fe.fromTrades?.trades} curve trades read = ${sol(fe.fromTrades?.sol)} (history ${fe.fromTrades?.complete ? 'complete' : 'partial'})`);
}
console.log(`\nRPC calls today (this database): ${oc.chainBudget(db, cfg).used}`);
process.exit(0);
