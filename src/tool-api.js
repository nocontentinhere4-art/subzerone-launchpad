// The coin sites' tool endpoints (docs/SITE-KIT.md): /_api/* on <slug>.<PROJECTS_HOST>, the same origin as the page,
// answered from the launchpad database. No sessions and no cookies on project hosts: a write is either anonymous
// (rate limited per IP, capped per day per salted IP hash) or carries a wallet signature over a single-use message the
// server issued (POST /_api/sign), verified with verifyWalletSignature. Holder checks read the chain (Helius RPC
// getTokenAccountsByOwner, cached); without a reader they degrade to "any wallet" and the page says so. Nothing here
// builds, asks for or moves a transaction. The author's side (switches, moderation) is on the launchpad API (app.js).
import { createHmac } from 'node:crypto';
import { audit, getSetting, setSetting } from './db.js';
import { moderateText } from './chat.js';
import { shortWallet } from './world.js';
import { publicStats } from './coin-stats.js';
import { toolOf, lastJst, nextJst, parseJstLocal, jstDay } from './tools.js';
import { createAppApi } from './app-api.js';
import { createHolderTools, HOLDER_PATHS } from './holder-tools.js';
import { HttpError, id, now, parseJson, sha256, token, isSolanaAddress, verifyWalletSignature, b58decode, b58encode } from './util.js';

export const LIMITS = Object.freeze({
  wallMax: 280, mapNameMax: 40, nonceTtlMs: 5 * 60_000, list: 50,
  perIpDay: { wall: 20, drop: 5, map: 10 },                 // per project, per JST day, per salted IP hash
  perProjectDay: { wall: 2000, drop: 1000, map: 300 },      // bounds what one site can add to the database in a day
  holderCacheMs: 10 * 60_000, holderMissCacheMs: 2 * 60_000, holderCacheMax: 5000,
});
const WHERE = 'on this site';

/** The live spec of a project (the tool configs are the server's truth, never the page's copy). */
export const liveSpec = (db, project) => parseJson(db.get(`SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ? AND build_status = 'ok'`,
  project.id, project.live_site_version)?.spec_json, null);

export function ipHash(db, ip) {
  let salt = getSetting(db, 'tools.ip_salt', null);
  if (!salt) { salt = token(24); setSetting(db, 'tools.ip_salt', salt, 'system'); }
  return createHmac('sha256', salt).update(String(ip)).digest('base64url').slice(0, 22);
}
const dayStart = (t) => lastJst(t, '00:00');

function capDay(db, project, tool, hash, t) {
  const since = dayStart(t);
  const mine = db.get('SELECT COUNT(*) n FROM tool_entries WHERE project_id = ? AND tool = ? AND ip_hash = ? AND created_at >= ?', project.id, tool, hash, since).n;
  if (mine >= LIMITS.perIpDay[tool]) throw new HttpError(429, 'rate_limited', `at most ${LIMITS.perIpDay[tool]} a day from one connection; come back tomorrow (JST)`, { retryAfterS: Math.ceil((since + 86_400_000 - t) / 1000) });
  const all = db.get('SELECT COUNT(*) n FROM tool_entries WHERE project_id = ? AND tool = ? AND created_at >= ?', project.id, tool, since).n;
  if (all >= LIMITS.perProjectDay[tool]) throw new HttpError(429, 'rate_limited', 'this site took all it can for today; come back tomorrow (JST)');
}

// --- holders -------------------------------------------------------------------------------------------------------
/** How a holders-only tool behaves on this server for this project: {mode: 'holders'|'any', note}. */
export function holderMode(cfg, launch, wanted) {
  if (!wanted) return { mode: 'any', note: null };
  if (!launch) return { mode: 'any', note: 'Holders only starts when the coin is launched; until then any wallet can take part.' };
  if (launch.provider === 'mock' || launch.network === 'mock') return { mode: 'any', note: 'MOCK launch: there is no chain to check, so any wallet can take part.' };
  if (launch.network !== 'mainnet-beta') return { mode: 'any', note: `Holder checks run on mainnet; this coin is on ${launch.network}, so any wallet can take part.` };
  if (!cfg.coinStats.heliusUrl) return { mode: 'any', note: 'Holder checks are off on this server (no chain reader configured), so any wallet can take part.' };
  return { mode: 'holders', note: 'Holders only: your wallet must hold this coin. The check reads the chain; nothing is sent or spent.' };
}

export function createHolderCheck({ cfg, fetchImpl = fetch }) {
  const cache = new Map();                                 // `${mint}:${wallet}` -> {ok, at}
  return async function isHolder(mint, wallet, t = now()) {
    const key = `${mint}:${wallet}`, hit = cache.get(key);
    if (hit && t - hit.at < (hit.ok ? LIMITS.holderCacheMs : LIMITS.holderMissCacheMs)) return hit.ok;
    let ok;
    try {
      const r = await fetchImpl(cfg.coinStats.heliusUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id: 'holder', method: 'getTokenAccountsByOwner', params: [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }] }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(String(j.error.message || 'rpc error').slice(0, 80));
      ok = (j.result?.value || []).some((a) => BigInt(String(a?.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0').replace(/\D/g, '') || '0') > 0n);
    } catch {
      throw new HttpError(503, 'holder_check_failed', 'the holder check could not read the chain just now; try again in a minute');
    }
    cache.delete(key); cache.set(key, { ok, at: t });
    if (cache.size > LIMITS.holderCacheMax) cache.delete(cache.keys().next().value);
    return ok;
  };
}

// --- signed messages -----------------------------------------------------------------------------------------------
const payloadHash = (action, payload) => sha256(JSON.stringify([action, payload]));
export function signText({ host, origin, wallet, summary, action, nonce, issuedAt, expiresAt }) {
  return [`${host} asks you to sign a message with your Solana account:`, wallet, '', summary,
    'This is a message, not a transaction: it moves no funds, costs nothing and gives no one access to your wallet.', '',
    `URI: ${origin}/`, `Action: ${action}`, `Nonce: ${nonce}`, `Issued At: ${new Date(issuedAt).toISOString()}`, `Expiration Time: ${new Date(expiresAt).toISOString()}`].join('\n');
}
export function issue(db, project, site, { wallet, action, payload, summary }, t) {
  if (!isSolanaAddress(wallet)) throw new HttpError(400, 'bad_wallet', 'not a Solana address');
  db.run('DELETE FROM tool_nonces WHERE expires_at < ?', t - 3_600_000);
  const nonce = token(16), expiresAt = t + LIMITS.nonceTtlMs;
  const message = signText({ host: site.host, origin: site.origin, wallet, summary, action, nonce, issuedAt: t, expiresAt });
  db.run('INSERT INTO tool_nonces (nonce, project_id, wallet, action, payload_hash, message, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    nonce, project.id, wallet, action, payloadHash(action, payload), message, t, expiresAt);
  return { nonce, message, expiresAt };
}
/** Burns the nonce on the first attempt (a replay fails even if this one fails below), then checks everything. */
export function consume(db, project, { wallet, nonce, signature, action, payload }, t) {
  let sig;
  try { sig = b58decode(String(signature)); } catch { throw new HttpError(401, 'bad_signature'); }
  const row = db.get('SELECT * FROM tool_nonces WHERE nonce = ? AND project_id = ?', String(nonce ?? ''), project.id);
  if (!row) throw new HttpError(401, 'unknown_nonce', 'signature request not found; start again');
  if (db.run('UPDATE tool_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL', t, row.nonce).changes !== 1) throw new HttpError(401, 'nonce_used', 'this signature was already used');
  if (row.expires_at < t) throw new HttpError(401, 'nonce_expired', 'the signature request expired; start again');
  if (row.wallet !== wallet || row.action !== action) throw new HttpError(401, 'wallet_mismatch');
  if (row.payload_hash !== payloadHash(action, payload)) throw new HttpError(401, 'payload_changed', 'what you signed is not what was sent');
  if (!verifyWalletSignature(wallet, row.message, sig)) throw new HttpError(401, 'bad_signature');
  return b58encode(sig);
}

// --- reading -------------------------------------------------------------------------------------------------------
export const launchOf = (db, project) => db.get('SELECT mint, network, provider, verified_at FROM launches WHERE project_id = ?', project.id);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The token panel: stored numbers only (coin-stats.js fills them; this never calls out). No number -> null -> "—". */
export function tokenState(db, project, t = now(), range = '24h') {
  const launch = launchOf(db, project);
  const base = { name: project.name, ticker: project.ticker };
  if (!launch) return { ...base, state: 'pre-launch', mint: null, network: null, priceUsd: null, marketCapUsd: null, volume24hUsd: null, priceChange24hPct: null,
    liquidityUsd: null, holders: null, at: null, fresh: false, source: null, samples: [] };
  const row = db.get('SELECT json FROM coin_stats WHERE mint = ?', launch.mint);
  const s = parseJson(row?.json), pub = publicStats(s, t);
  const since = t - (range === '7d' ? 7 * 86_400_000 : 86_400_000);
  const samples = db.all('SELECT at, price_usd p, market_cap_usd m FROM coin_samples WHERE mint = ? AND at >= ? ORDER BY at', launch.mint, since);
  const step = Math.max(1, Math.ceil(samples.length / 400));
  return { ...base, state: launch.provider === 'mock' ? 'mock' : 'live', mint: launch.mint, network: launch.network, launchedAt: launch.verified_at,
    priceUsd: num(s?.priceUsd), marketCapUsd: pub.marketCapUsd, volume24hUsd: pub.volume24hUsd, priceChange24hPct: pub.priceChange24hPct, liquidityUsd: pub.liquidityUsd,
    holders: pub.holders ? { count: num(pub.holders.count), atLeast: !!pub.holders.atLeast } : null, at: pub.at, fresh: pub.fresh, source: pub.source,
    sourceLabel: s?.sourceLabel ?? null, samples: samples.filter((_, i) => i % step === 0 || i === samples.length - 1).map((x) => [x.at, x.p, x.m]) };
}

const entryView = (e) => ({ id: e.id, text: e.text, at: e.created_at, by: e.wallet ? shortWallet(e.wallet) : null });
export function wallState(db, cfg, project, conf) {
  const rows = db.all(`SELECT * FROM tool_entries WHERE project_id = ? AND tool = 'wall' AND hidden_at IS NULL ORDER BY created_at DESC LIMIT ?`, project.id, LIMITS.list);
  return { title: conf.title, holdersOnly: conf.holdersOnly, ...holderMode(cfg, launchOf(db, project), conf.holdersOnly), max: LIMITS.wallMax, entries: rows.map(entryView) };
}
export const pollKey = (conf) => sha256(JSON.stringify([conf.question, conf.options])).slice(0, 16);
export function pollState(db, cfg, project, conf) {
  const key = pollKey(conf);
  const counts = conf.options.map(() => 0);
  for (const r of db.all('SELECT choice, COUNT(*) n FROM poll_votes WHERE project_id = ? AND poll_key = ? GROUP BY choice', project.id, key)) if (r.choice < counts.length) counts[r.choice] = r.n;
  return { question: conf.question, options: conf.options, counts, total: counts.reduce((a, b) => a + b, 0), pollKey: key, holdersOnly: conf.holdersOnly,
    ...holderMode(cfg, launchOf(db, project), conf.holdersOnly) };
}
/** The daily rule: at each reveal time, when nothing was featured in the 24 h before it, one of that window's
 * submissions is featured (picked by a hash of its id and the reveal instant: fair, repeatable, not guessable early). */
export function runDropRule(db, project, conf, t = now()) {
  if (!conf.autoPick) return null;
  const reveal = lastJst(t, conf.revealJst), from = reveal - 86_400_000;
  if (db.get(`SELECT 1 FROM tool_entries WHERE project_id = ? AND tool = 'drop' AND featured_at >= ?`, project.id, from)) return null;
  const pool = db.all(`SELECT id FROM tool_entries WHERE project_id = ? AND tool = 'drop' AND hidden_at IS NULL AND featured_at IS NULL AND created_at >= ? AND created_at < ?`,
    project.id, from, reveal);
  if (!pool.length) return null;
  const pick = pool.map((r) => [sha256(`${r.id}:${reveal}`), r.id]).sort()[0][1];
  db.run(`UPDATE tool_entries SET featured_at = ?, featured_by = 'rule:daily' WHERE id = ? AND featured_at IS NULL`, reveal, pick);
  return pick;
}
export function dropState(db, project, conf, t = now()) {
  runDropRule(db, project, conf, t);
  const f = db.get(`SELECT * FROM tool_entries WHERE project_id = ? AND tool = 'drop' AND featured_at IS NOT NULL AND hidden_at IS NULL ORDER BY featured_at DESC LIMIT 1`, project.id);
  return { title: conf.title, prompt: conf.prompt, revealJst: conf.revealJst, maxLength: conf.maxLength, autoPick: conf.autoPick,
    featured: f ? { text: f.text, at: f.featured_at, day: jstDay(f.featured_at), by: f.featured_by === 'rule:daily' ? 'the daily rule' : 'the author' } : null,
    nextRevealAt: nextJst(t, conf.revealJst), lastRevealAt: lastJst(t, conf.revealJst) };
}
export function mapState(db, project, conf) {
  const pins = db.all(`SELECT * FROM tool_entries WHERE project_id = ? AND tool = 'map' AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 200`, project.id)
    .map((e) => ({ ...entryView(e), ...parseJson(e.data_json, {}) }));
  return { title: conf.title, center: conf.center, zoom: conf.zoom, places: conf.places, community: conf.community, pins };
}
/** The next occurrence of an event config (daily or once), or null when a one-off date is past. */
export function eventNext(conf, t = now()) {
  if (conf.daily) return nextJst(t, conf.daily);
  const at = parseJstLocal(conf.at);
  return at != null && at > t ? at : null;
}

// --- the project host: /_api/* ---------------------------------------------------------------------------------------
/** `limit(rule, key)` is app.js's rate limiter. Returns handle(ctx) -> {status, body, headers?}. */
export function createSiteApi({ db, cfg, fetchImpl = fetch, limit }) {
  const isHolder = createHolderCheck({ cfg, fetchImpl });
  const holderTools = createHolderTools({ db, cfg, fetchImpl });
  // the idea app's endpoints (/_api/app*, app-api.js) share the signing, the caps and the holder checks
  const appApi = createAppApi({ db, cfg, fetchImpl, limit, h: { issue, consume, ipHash, launchOf, holderMode, isHolder } });
  // a tool's config: the site's tool, or the app's block of the same kind (the app's map is the map tool)
  const conf = (spec, tool) => {
    const t = toolOf(spec, tool) || (tool === 'map' ? { config: (spec.app?.screens || []).flatMap((x) => x.blocks).find((b) => b.type === 'map') } : null);
    if (!t?.config) throw new HttpError(404, 'tool_off', `this site has no ${tool} tool`);
    return t.config;
  };
  // a holders-only write: the signature is required and checked first; then the chain (when the server can read it)
  async function gate(project, c, b, action, payload, t) {
    const signature = consume(db, project, { wallet: String(b.wallet || ''), nonce: b.nonce, signature: b.signature, action, payload }, t);
    const launch = launchOf(db, project), hm = holderMode(cfg, launch, c.holdersOnly);
    if (hm.mode === 'holders' && !(await isHolder(launch.mint, b.wallet, t))) throw new HttpError(403, 'not_holder', `this wallet holds no $${project.ticker}; holders only`);
    return signature;
  }
  // the exact write a signature request is for: same normalisation as the write itself, so the hashes match
  const intents = {
    'wall.post': (spec, b) => { const c = conf(spec, 'wall'); const text = moderateText(b.text, { max: LIMITS.wallMax, where: WHERE });
      return { c, payload: { text }, summary: `Post on the wall of ${spec.name} ($${spec.ticker}): "${text}"` }; },
    'poll.vote': (spec, b) => { const c = conf(spec, 'poll'); const choice = Number(b.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= c.options.length) throw new HttpError(400, 'bad_choice', `choice: 0–${c.options.length - 1}`);
      return { c, payload: { choice, pollKey: pollKey(c) }, summary: `Vote "${c.options[choice]}" in the poll "${c.question}" of ${spec.name} ($${spec.ticker}).` }; },
  };

  return async function handle({ project, site, method, path, ip, query, body }) {
    const t = now();
    const spec = liveSpec(db, project);
    if (!spec) throw new HttpError(404, 'not_found');
    const route = `${method} ${path}`;
    if (path === '/_api/app' || path.startsWith('/_api/app/')) {
      limit(method === 'GET' ? 'siteRead' : 'siteWrite', ip);
      if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      return appApi.handle({ project, spec, method, path, ip, query, body, t });
    }
    if (method === 'GET') {
      limit('siteRead', ip);
      switch (path) {
        case '/_api/token': {
          const range = query.get('range') === '7d' ? '7d' : '24h';
          if (!toolOf(spec, 'token') && !toolOf(spec, 'chart')) throw new HttpError(404, 'tool_off', 'this site has no token panel');
          return { body: tokenState(db, project, t, range), cache: 'public, max-age=30' };
        }
        case '/_api/wall': return { body: wallState(db, cfg, project, conf(spec, 'wall')) };
        case '/_api/poll': return { body: pollState(db, cfg, project, conf(spec, 'poll')) };
        case '/_api/drop': return { body: dropState(db, project, conf(spec, 'drop'), t) };
        case '/_api/map': return { body: mapState(db, project, conf(spec, 'map')) };
        default:
          if (HOLDER_PATHS[path]) { conf(spec, HOLDER_PATHS[path]); return holderTools.handle(path, project); }   // holder-tools.js
          throw new HttpError(404, 'not_found');
      }
    }
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    limit('siteWrite', ip);
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    switch (route) {
      case 'POST /_api/sign': {
        limit('siteSign', ip);
        const make = intents[b.action] || appApi.intents[b.action];
        if (!make) throw new HttpError(400, 'bad_action', `action: ${[...Object.keys(intents), ...Object.keys(appApi.intents)].join(' | ')}`);
        const { payload, summary } = make(spec, b, project, t);
        return { body: issue(db, project, site, { wallet: String(b.wallet || ''), action: b.action, payload, summary }, t) };
      }
      case 'POST /_api/wall': {
        const { c, payload } = intents['wall.post'](spec, b);
        const hash = ipHash(db, ip);
        let wallet = null;
        if (c.holdersOnly) { await gate(project, c, b, 'wall.post', payload, t); wallet = b.wallet; limit('siteWallet', wallet); }
        capDay(db, project, 'wall', hash, t);
        const eid = id('wal');
        db.run(`INSERT INTO tool_entries (id, project_id, tool, text, wallet, ip_hash, created_at) VALUES (?, ?, 'wall', ?, ?, ?, ?)`, eid, project.id, payload.text, wallet, hash, t);
        return { body: { entry: entryView(db.get('SELECT * FROM tool_entries WHERE id = ?', eid)) } };
      }
      case 'POST /_api/poll': {
        const { c, payload } = intents['poll.vote'](spec, b);
        const signature = await gate(project, c, b, 'poll.vote', payload, t);
        limit('siteWallet', b.wallet);
        const had = db.get('SELECT choice FROM poll_votes WHERE project_id = ? AND poll_key = ? AND wallet = ?', project.id, payload.pollKey, b.wallet);
        if (had) throw new HttpError(409, 'already_voted', `this wallet already voted "${c.options[had.choice]}"`, { choice: had.choice });
        db.run('INSERT INTO poll_votes (project_id, poll_key, wallet, choice, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)', project.id, payload.pollKey, b.wallet, payload.choice, signature, t);
        return { body: { ...pollState(db, cfg, project, c), mine: payload.choice } };
      }
      case 'POST /_api/drop': {
        const c = conf(spec, 'drop');
        const text = moderateText(b.text, { max: c.maxLength, where: WHERE });
        const hash = ipHash(db, ip);
        capDay(db, project, 'drop', hash, t);
        db.run(`INSERT INTO tool_entries (id, project_id, tool, text, ip_hash, created_at) VALUES (?, ?, 'drop', ?, ?, ?)`, id('drp'), project.id, text, hash, t);
        return { body: { ok: true, private: true, nextRevealAt: nextJst(t, c.revealJst) } };
      }
      case 'POST /_api/map': {
        const c = conf(spec, 'map');
        if (!c.community) throw new HttpError(403, 'closed', 'the author keeps this map to their own places');
        const name = moderateText(b.name, { max: LIMITS.mapNameMax, where: WHERE });
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) throw new HttpError(400, 'bad_place', 'lat -85…85, lng -180…180');
        const hash = ipHash(db, ip);
        capDay(db, project, 'map', hash, t);
        const eid = id('pin');
        db.run(`INSERT INTO tool_entries (id, project_id, tool, text, data_json, ip_hash, created_at) VALUES (?, ?, 'map', ?, ?, ?, ?)`, eid, project.id, name,
          JSON.stringify({ lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 }), hash, t);
        return { body: { pin: mapState(db, project, c).pins.find((p) => p.id === eid) } };
      }
      default: throw new HttpError(404, 'not_found');
    }
  };
}

// --- the author's side (launchpad API, session auth) -------------------------------------------------------------------
/** The room PC's inbox: drop submissions (private), wall notes and map pins, hidden ones included and marked. */
export function ownerInbox(db, cfg, project, t = now()) {
  const spec = liveSpec(db, project);
  const drop = toolOf(spec, 'drop');
  if (drop) runDropRule(db, project, drop.config, t);
  const rows = (tool) => db.all('SELECT * FROM tool_entries WHERE project_id = ? AND tool = ? ORDER BY created_at DESC LIMIT ?', project.id, tool, LIMITS.list)
    .map((e) => ({ ...entryView(e), hidden: e.hidden_at != null, featured: e.featured_at != null, featuredBy: e.featured_by, ...(e.data_json ? parseJson(e.data_json, {}) : {}) }));
  const poll = toolOf(spec, 'poll');
  return { drop: rows('drop'), wall: rows('wall'), map: rows('map'), poll: poll ? pollState(db, cfg, project, poll.config) : null };
}

/** Hide / unhide any entry; feature a drop submission (it becomes public). actor: 'wallet:…' or 'admin:…'. */
export function moderateEntry(db, project, entryId, b, actor, t = now()) {
  const e = db.get('SELECT * FROM tool_entries WHERE id = ? AND project_id = ?', String(entryId), project.id);
  if (!e) throw new HttpError(404, 'not_found');
  if (typeof b.hidden === 'boolean') {
    db.run('UPDATE tool_entries SET hidden_at = ?, hidden_by = ? WHERE id = ?', b.hidden ? t : null, b.hidden ? actor : null, e.id);
    audit(db, { actor, kind: 'tools', projectId: project.id, ideaId: project.idea_id, message: `${b.hidden ? 'hid' : 'unhid'} a ${e.tool} entry`, data: { id: e.id } });
  }
  if (b.featured === true) {
    if (e.tool !== 'drop') throw new HttpError(400, 'bad_request', 'only drop submissions are featured');
    if (e.hidden_at && b.hidden !== false) throw new HttpError(409, 'hidden', 'unhide it first');
    db.run('UPDATE tool_entries SET featured_at = ?, featured_by = ? WHERE id = ?', t, actor, e.id);
    audit(db, { actor, kind: 'tools', projectId: project.id, ideaId: project.idea_id, isPublic: true, message: 'featured a drop-box submission on the site', data: { id: e.id } });
  }
  return { ok: true };
}

// --- boot backfill (scripts/backfill-site-tools.js; tools/start.sh runs it at container start) ------------------------
/** Launched coins built before the kit get SUB-01's tool pick as a NEW site version (same text, tools added; sites are
 * mutable after launch by design), set live and recorded publicly as "SUB-01 added tools". Idempotent: a live spec that
 * has a `tools` key at all (even [] after the author switched everything off) is left alone. */
export async function backfillTools(db, cfg) {
  const { buildSiteVersion, setLiveVersion } = await import('./site.js');
  const { chooseTools } = await import('./generator.js');
  const out = { added: [], skipped: 0, failed: [] };
  const rows = db.all(`SELECT p.* FROM projects p JOIN ideas i ON i.id = p.idea_id JOIN launches l ON l.project_id = p.id
    WHERE i.status = 'launched' AND p.live_site_version IS NOT NULL ORDER BY p.created_at`);
  for (const p of rows) {
    const spec = liveSpec(db, p);
    if (!spec || spec.tools !== undefined) { out.skipped++; continue; }
    try {
      const idea = db.get('SELECT v.title, v.concept, v.name_suggestion FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version WHERE i.id = ?', p.idea_id);
      const brain = parseJson(db.get(`SELECT brain_json FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, p.idea_id)?.brain_json, {});
      const tools = chooseTools(idea, brain, { name: spec.name });
      const site = await buildSiteVersion(db, cfg, p, { ...spec, tools }, 'system:sub01-tools');
      setLiveVersion(db, p, site.version, 'system');
      audit(db, { actor: 'system', kind: 'tools', projectId: p.id, ideaId: p.idea_id, isPublic: true,
        message: `SUB-01 added tools to the site: ${tools.map((x) => x.id).join(', ')} (site v${site.version})` });
      out.added.push({ slug: p.slug, version: site.version, tools: tools.map((x) => x.id) });
    } catch (e) {
      out.failed.push({ slug: p.slug, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}
