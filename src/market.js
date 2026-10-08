// SUB-01 token market data: only fetched from fixed public sources, cached, always returned with source and time.
// Sources: DexScreener's public API (price, liquidity, volume) and Solana RPC (supply, authorities).
import { SUB01 } from './config.js';
import { now } from './util.js';

const TTL = 60_000;

async function cached(db, key, source, fn) {
  const row = db.get('SELECT * FROM market_cache WHERE key = ?', key);
  if (row && now() - row.fetched_at < TTL) return { ...JSON.parse(row.json), source: row.source, fetchedAt: row.fetched_at, cached: true };
  try {
    const data = await fn();
    db.run(`INSERT INTO market_cache (key, json, source, fetched_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET json = excluded.json, source = excluded.source, fetched_at = excluded.fetched_at`,
    key, JSON.stringify(data), source, now());
    return { ...data, source, fetchedAt: now(), cached: false };
  } catch (e) {
    if (row) return { ...JSON.parse(row.json), source: row.source, fetchedAt: row.fetched_at, cached: true, stale: true, error: e.message };
    return { unavailable: true, source, error: e.message, fetchedAt: null };
  }
}

export async function sub01Market(db, cfg, fetchImpl = fetch) {
  const dex = await cached(db, 'sub01:dexscreener', 'DexScreener public API (api.dexscreener.com)', async () => {
    const r = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${SUB01.mint}`, { signal: AbortSignal.timeout(6000), redirect: 'error' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === SUB01.mint);
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    if (!p) return { pairs: 0 };
    return { pairs: pairs.length, dex: p.dexId, pair: p.pairAddress, priceUsd: p.priceUsd, priceNative: p.priceNative,
      liquidityUsd: p.liquidity?.usd ?? null, volume24hUsd: p.volume?.h24 ?? null, fdvUsd: p.fdv ?? null,
      marketCapUsd: p.marketCap ?? null, change24hPct: p.priceChange?.h24 ?? null, url: p.url };
  });
  const chain = await cached(db, 'sub01:rpc', `Solana RPC (${new URL(cfg.market.sub01RpcUrl).host})`, async () => {
    const call = async (method, params) => {
      const r = await fetchImpl(cfg.market.sub01RpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000), redirect: 'error' });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    };
    const acc = await call('getAccountInfo', [SUB01.mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const info = acc?.value?.data?.parsed?.info;
    if (!info) throw new Error('mint not found');
    return { supply: info.supply, decimals: info.decimals, mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null, tokenProgram: acc.value.owner, slot: acc.context?.slot ?? null };
  });
  return { mint: SUB01.mint, dex, chain };
}
