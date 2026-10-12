// The idea app's server side (docs/APP-COMPOSER.md): /_api/app* on the project host (same origin as the page, no
// cookies; writes anonymous + capped per salted IP hash, or signed by a wallet over a single-use message), the reveal
// engine (owner pick -> holders' votes -> a draw seeded by a Solana blockhash, recorded with its proof), the owner's
// side for the room PC, and the boot backfill. Nothing here builds, asks for or moves a transaction.
import { audit } from './db.js';
import { moderateText } from './chat.js';
import { shortWallet } from './world.js';
import { lastJst, jstDay } from './tools.js';
import { validateApp, isAppError, blockOf, blocksOf, exposure, lastSlot, nextSlot, prevSlot, describeApp, BLOCKS, CARD_TEMPLATES, METRICS, METRIC_LABELS } from './app-blocks.js';
import { HttpError, id, now, parseJson, sha256 } from './util.js';

export const LIMITS = Object.freeze({ perIpDay: 6, perProjectDay: 1000, list: 24, inbox: 100, catchUp: 7, beaconGraceMs: 2 * 3_600_000, maxBody: 4096 });
const WHERE = 'in this app';
const appOf = (spec) => (spec && spec.app && typeof spec.app === 'object' ? spec.app : null);

// --- views -----------------------------------------------------------------------------------------------------------
function itemView(row, app, { votes, reveal } = {}) {
  const fields = parseJson(row.fields_json, {});
  const submit = blockOf(app, 'submit');
  return { id: row.id, number: row.seq, text: row.text, fields, at: row.created_at, by: row.wallet && submit && !submit.anonymous ? shortWallet(row.wallet) : null,
    publishedAt: row.published_at ?? null, how: row.published_by ? (row.published_by.startsWith('rule:') ? row.published_by.slice(5) : 'owner') : null,
    ...(votes != null ? { votes } : {}), ...(reveal ? { reveal } : {}) };
}
const revealView = (r) => (r ? { slotAt: r.slot_at, method: r.method, dev: !!r.dev, proof: parseJson(r.proof_json, {}) } : null);
const voteCount = (db, project, itemId) => db.get('SELECT COUNT(*) n FROM app_votes WHERE project_id = ? AND item_id = ?', project.id, itemId).n;

/** The reveal round open now: [start, slot) where slot is the next scheduled instant and start the later of the last
 * scheduled instant and the last reveal (a dev reveal moves it). */
function round(db, project, app, t) {
  const sched = blockOf(app, 'schedule');
  if (!sched) return null;
  const slot = nextSlot(sched, t), last = lastSlot(sched, t);
  const rev = db.get('SELECT MAX(slot_at) s FROM app_reveals WHERE project_id = ? AND slot_at <= ?', project.id, t)?.s ?? 0;
  return { slot, start: Math.max(last, rev), key: `slot:${slot}` };
}
function publicFilter(app, t, rnd) {
  const ex = exposure(app);
  if (ex === 'board') return { sql: 'hidden_at IS NULL', args: [] };
  if (ex === 'candidates' && rnd) return { sql: 'hidden_at IS NULL AND (published_at IS NOT NULL OR (created_at >= ? AND created_at < ?))', args: [rnd.start, rnd.slot] };
  return { sql: 'hidden_at IS NULL AND published_at IS NOT NULL', args: [] };
}

export function metrics(db, project, app, t = now()) {
  const day = lastJst(t, '00:00'), P = project.id, n = (sql, ...a) => db.get(sql, P, ...a).n;
  const first = db.get('SELECT MIN(created_at) m FROM app_items WHERE project_id = ?', P).m;
  const all = {
    submitted_today: n('SELECT COUNT(*) n FROM app_items WHERE project_id = ? AND created_at >= ? AND hidden_at IS NULL', day),
    submitted_total: n('SELECT COUNT(*) n FROM app_items WHERE project_id = ? AND hidden_at IS NULL'),
    published_total: n('SELECT COUNT(*) n FROM app_items WHERE project_id = ? AND published_at IS NOT NULL AND hidden_at IS NULL'),
    votes_today: n('SELECT COUNT(*) n FROM app_votes WHERE project_id = ? AND created_at >= ?', day),
    voters_today: n('SELECT COUNT(DISTINCT wallet) n FROM app_votes WHERE project_id = ? AND created_at >= ?', day),
    days_running: first ? Math.floor((day - lastJst(first, '00:00')) / 86_400_000) + 1 : 0,
  };
  return Object.fromEntries(METRICS.map((k) => [k, all[k]]));
}

// --- the draw: a Solana blockhash after the reveal instant ------------------------------------------------------------
/** -> beacon(slotAt) -> {source: 'solana', slot, blockhash, blockTime} for the first block whose time is >= the reveal
 * instant (anyone can look the slot up and redo the draw), or {source: 'time'} when the server has no chain reader. */
export function createBeacon({ cfg, fetchImpl = fetch }) {
  const url = cfg.coinStats?.heliusUrl;
  let n = 0;
  const rpc = async (method, params) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
    if (!r.ok) throw new Error(`rpc HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(String(j.error.message || 'rpc error').slice(0, 80));
    return j.result;
  };
  const firstBlockAtOrAfter = async (s) => { const r = await rpc('getBlocksWithLimit', [s, 1, { commitment: 'finalized' }]); if (!r?.length) throw new Error('no block'); return r[0]; };
  return async function beacon(slotAt) {
    if (!url) return { source: 'time', value: slotAt, note: 'This server has no chain reader, so the draw is seeded by the reveal instant itself.' };
    const target = Math.ceil(slotAt / 1000);
    const hi0 = await rpc('getSlot', [{ commitment: 'finalized' }]);
    const hiTime = await rpc('getBlockTime', [hi0]);
    if (hiTime < target) throw new Error('the reveal instant is not final on chain yet');
    // P(x) = the first block at or after slot x has a time >= the reveal instant: monotone in x, so binary search
    const times = new Map(), timeOf = async (s) => { if (!times.has(s)) times.set(s, await rpc('getBlockTime', [s])); return times.get(s); };
    const P = async (x) => timeOf(await firstBlockAtOrAfter(x));
    let lo = Math.max(0, hi0 - Math.ceil((hiTime - target) / 0.4) - 3000), hi = hi0;
    for (let k = 0; (await P(lo)) >= target; k++) { if (k > 5 || lo === 0) throw new Error('could not find the reveal instant on chain'); hi = lo; lo = Math.max(0, lo - 50_000 * (k + 1)); }
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if ((await P(mid)) >= target) hi = mid; else lo = mid; }
    const pickSlot = await firstBlockAtOrAfter(hi);
    const block = await rpc('getBlock', [pickSlot, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
    return { source: 'solana', slot: pickSlot, blockhash: block.blockhash, blockTime: block.blockTime };
  };
}
/** The draw's order: ids sorted by sha256(`${seed}:${id}`), lowest first. The page recomputes it in the browser. */
export const drawOrder = (seed, ids) => ids.map((i) => [sha256(`${seed}:${i}`), i]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
const seedOf = (b) => (b.source === 'solana' ? b.blockhash : `time:${b.value}`);

/** Decide one scheduled reveal (slotAt) and record it. Idempotent per (project, slot). */
async function revealSlot(db, project, app, slotAt, start, beacon, t, { dev = false, roundSlot = slotAt } = {}) {
  if (db.get('SELECT 1 FROM app_reveals WHERE project_id = ? AND slot_at = ?', project.id, slotAt)) return null;
  const rv = blockOf(app, 'reveal');
  const cands = db.all('SELECT id FROM app_items WHERE project_id = ? AND hidden_at IS NULL AND published_at IS NULL AND created_at >= ? AND created_at < ? ORDER BY created_at', project.id, start, slotAt).map((r) => r.id);
  let item = null, method = 'empty';
  const proof = { rule: rv.pick, window: [start, slotAt], candidates: cands };
  let seed = null;
  const needSeed = async () => {
    if (seed) return seed;
    try { seed = await beacon(slotAt); } catch (e) {
      if (t - slotAt < LIMITS.beaconGraceMs && !dev) throw e;     // try again on a later request: never fall back by choice
      seed = { source: 'time', value: slotAt, note: `The chain could not be read (${String(e.message).slice(0, 60)}), so the draw is seeded by the reveal instant.` };
    }
    return seed;
  };
  for (const how of rv.pick) {
    if (how === 'owner') {
      const p = db.get('SELECT p.item_id FROM app_picks p JOIN app_items i ON i.id = p.item_id WHERE p.project_id = ? AND p.slot_at = ? AND i.hidden_at IS NULL AND i.published_at IS NULL', project.id, roundSlot);
      if (p) { item = p.item_id; method = 'owner'; break; }
    } else if (how === 'votes' && cands.length) {
      const rows = db.all(`SELECT item_id, COUNT(*) n FROM app_votes WHERE project_id = ? AND round = ? GROUP BY item_id`, project.id, `slot:${roundSlot}`).filter((r) => cands.includes(r.item_id));
      const top = Math.max(0, ...rows.map((r) => r.n));
      if (top > 0) {
        const tied = rows.filter((r) => r.n === top).map((r) => r.item_id).sort();
        proof.votes = Object.fromEntries(rows.map((r) => [r.item_id, r.n]));
        if (tied.length > 1) { const s = await needSeed(); proof.seed = s; proof.tie = tied; item = drawOrder(seedOf(s), tied)[0]; } else item = tied[0];
        method = 'votes'; break;
      }
    } else if (how === 'random' && cands.length) {
      const s = await needSeed(); proof.seed = s; item = drawOrder(seedOf(s), [...cands].sort())[0]; method = 'random'; break;
    }
  }
  return db.tx(() => {
    if (db.get('SELECT 1 FROM app_reveals WHERE project_id = ? AND slot_at = ?', project.id, slotAt)) return null;
    db.run('INSERT INTO app_reveals (project_id, slot_at, item_id, method, proof_json, created_at, dev) VALUES (?, ?, ?, ?, ?, ?, ?)', project.id, slotAt, item, method, JSON.stringify(proof), t, dev ? 1 : 0);
    if (item) db.run('UPDATE app_items SET published_at = ?, published_by = ? WHERE id = ? AND published_at IS NULL', slotAt, method === 'owner' ? 'owner-pick' : `rule:${method}`, item);
    if (item) audit(db, { actor: 'system', kind: 'app', projectId: project.id, ideaId: project.idea_id, isPublic: true, message: `The app revealed #${db.get('SELECT seq FROM app_items WHERE id = ?', item).seq} (${method}${dev ? ', dev trigger' : ''})` });
    return { item, method };
  });
}

const inflight = new Map();
/** Run every reveal that is due (the last LIMITS.catchUp scheduled instants without a record), oldest first. */
export function runReveals(db, project, app, beacon, t = now()) {
  const sched = blockOf(app, 'schedule');
  if (!sched || !blockOf(app, 'reveal')) return Promise.resolve([]);
  const first = db.get('SELECT MIN(created_at) m FROM app_items WHERE project_id = ?', project.id).m;
  if (first == null) return Promise.resolve([]);
  const key = project.id;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const due = [];
    for (let s = lastSlot(sched, t), k = 0; k < LIMITS.catchUp && s > first; s = prevSlot(sched, s), k++) {
      if (db.get('SELECT 1 FROM app_reveals WHERE project_id = ? AND slot_at = ?', project.id, s)) break;
      due.unshift(s);
    }
    const done = [];
    for (const s of due) {
      const before = db.get('SELECT MAX(slot_at) m FROM app_reveals WHERE project_id = ? AND slot_at < ?', project.id, s)?.m ?? 0;
      done.push(await revealSlot(db, project, app, s, Math.max(prevSlot(sched, s), before), beacon, t));
    }
    return done;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** The dev-only trigger (APP_DEV_TRIGGER=1): reveal the open round right now, marked as a dev reveal on the page. */
export async function devReveal(db, cfg, project, app, beacon, t = now()) {
  if (!cfg.appDevTrigger) throw new HttpError(404, 'not_found');
  const rnd = round(db, project, app, t);
  if (!rnd) throw new HttpError(400, 'no_schedule', 'this app has no scheduled reveal');
  return revealSlot(db, project, app, t, rnd.start, beacon, t, { dev: true, roundSlot: rnd.slot });   // the open round's votes and pick count
}

// --- reading -------------------------------------------------------------------------------------------------------------
export async function appState(db, cfg, project, app, beacon, holder, t = now()) {
  try { await runReveals(db, project, app, beacon, t); } catch { /* the chain is slow: the reveal runs on a later request */ }
  const sched = blockOf(app, 'schedule'), rnd = round(db, project, app, t), ex = exposure(app);
  const lastPub = db.get('SELECT * FROM app_items WHERE project_id = ? AND published_at IS NOT NULL AND hidden_at IS NULL ORDER BY published_at DESC LIMIT 1', project.id);
  const lastRev = lastPub ? db.get('SELECT * FROM app_reveals WHERE project_id = ? AND item_id = ?', project.id, lastPub.id) : null;
  const lastEmpty = db.get(`SELECT * FROM app_reveals WHERE project_id = ? ORDER BY slot_at DESC LIMIT 1`, project.id);
  const candidates = ex === 'candidates' && rnd ? db.all('SELECT * FROM app_items WHERE project_id = ? AND hidden_at IS NULL AND published_at IS NULL AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 50',
    project.id, rnd.start, rnd.slot).map((r) => itemView(r, app, { votes: db.get('SELECT COUNT(*) n FROM app_votes WHERE project_id = ? AND round = ? AND item_id = ?', project.id, rnd.key, r.id).n })) : null;
  const submit = blockOf(app, 'submit'), vote = blockOf(app, 'vote');
  return {
    title: app.title, flow: app.flow, exposure: ex, now: t, noun: app.noun,
    schedule: sched ? { ...sched, nextAt: nextSlot(sched, t), lastAt: lastSlot(sched, t) } : null,
    round: rnd ? { key: rnd.key, start: rnd.start, slot: rnd.slot } : null,
    latest: lastPub ? itemView(lastPub, app, { votes: voteCount(db, project, lastPub.id), reveal: revealView(lastRev) }) : null,
    lastReveal: lastEmpty ? { slotAt: lastEmpty.slot_at, method: lastEmpty.method, dev: !!lastEmpty.dev } : null,
    candidates, counts: metrics(db, project, app, t),
    submit: submit ? holder(submit.holdersOnly) : null, vote: vote ? holder(vote.holdersOnly) : null,
  };
}

export function listItems(db, project, app, { show, month, q, before, limit } = {}, t = now()) {
  const rnd = round(db, project, app, t);
  const f = show === 'all' && exposure(app) === 'board' ? publicFilter(app, t, rnd) : { sql: 'hidden_at IS NULL AND published_at IS NOT NULL', args: [] };
  const order = f.sql.includes('published_at IS NOT NULL AND') || show !== 'all' ? 'COALESCE(published_at, created_at)' : 'created_at';
  const where = [`project_id = ?`, f.sql], args = [project.id, ...f.args];
  if (/^\d{4}-\d{2}$/.test(month || '')) { const a = Date.parse(`${month}-01T00:00:00+09:00`); const d = new Date(a + 9 * 3_600_000); const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 9 * 3_600_000; where.push(`${order} >= ? AND ${order} < ?`); args.push(a, b); }
  if (typeof q === 'string' && q.trim()) { where.push(`(text LIKE ? ESCAPE '\\' OR fields_json LIKE ? ESCAPE '\\')`); const like = `%${q.trim().slice(0, 40).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; args.push(like, like); }
  if (Number.isFinite(before)) { where.push(`${order} < ?`); args.push(before); }
  const n = Math.min(Math.max(Number(limit) || LIMITS.list, 1), 48);
  const rows = db.all(`SELECT *, ${order} AS k FROM app_items WHERE ${where.join(' AND ')} ORDER BY k DESC LIMIT ?`, ...args, n);
  const months = db.all(`SELECT DISTINCT strftime('%Y-%m', (${order} + 32400000) / 1000, 'unixepoch') m FROM app_items WHERE project_id = ? AND ${f.sql} ORDER BY m DESC LIMIT 36`, project.id, ...f.args).map((r) => r.m);
  return { items: rows.map((r) => itemView(r, app, { votes: voteCount(db, project, r.id), reveal: r.published_at ? revealView(db.get('SELECT * FROM app_reveals WHERE project_id = ? AND item_id = ?', project.id, r.id)) : null })),
    next: rows.length === n ? rows[rows.length - 1].k : null, months };
}

export function oneItem(db, project, app, itemId, t = now()) {
  const r = db.get('SELECT * FROM app_items WHERE id = ? AND project_id = ?', String(itemId), project.id);
  const f = publicFilter(app, t, round(db, project, app, t));
  if (!r || !db.get(`SELECT 1 FROM app_items WHERE id = ? AND ${f.sql}`, r.id, ...f.args)) throw new HttpError(404, 'not_found', 'not here (or not public yet)');
  return itemView(r, app, { votes: voteCount(db, project, r.id), reveal: revealView(db.get('SELECT * FROM app_reveals WHERE project_id = ? AND item_id = ?', project.id, r.id)) });
}

export function leaderboard(db, project, app, block, t = now()) {
  const f = publicFilter(app, t, round(db, project, app, t));
  if (block.of === 'items') {
    const by = block.by === 'votes' ? '(SELECT COUNT(*) FROM app_votes v WHERE v.project_id = i.project_id AND v.item_id = i.id)' : '0';
    const rows = db.all(`SELECT i.*, ${by} AS score FROM app_items i WHERE i.project_id = ? AND ${f.sql.replace(/\b(hidden_at|published_at|created_at)\b/g, 'i.$1')} ORDER BY score DESC, i.created_at ASC LIMIT ?`, project.id, ...f.args, block.limit);
    return { of: 'items', by: block.by, rows: rows.filter((r) => block.by !== 'votes' || r.score > 0).map((r) => ({ ...itemView(r, app), score: r.score })) };
  }
  const rows = block.by === 'votes'
    ? db.all('SELECT wallet, COUNT(*) score FROM app_votes WHERE project_id = ? GROUP BY wallet ORDER BY score DESC LIMIT ?', project.id, block.limit)
    : db.all('SELECT wallet, COUNT(*) score FROM app_items WHERE project_id = ? AND wallet IS NOT NULL AND hidden_at IS NULL GROUP BY wallet ORDER BY score DESC LIMIT ?', project.id, block.limit);
  return { of: 'wallets', by: block.by, rows: rows.map((r) => ({ wallet: shortWallet(r.wallet), score: r.score })) };
}

// --- writing -------------------------------------------------------------------------------------------------------------
/** The form, normalised exactly as stored (moderated text, known choices, whole numbers), or a 400. */
export function normaliseFields(submit, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'bad_fields', 'fields: an object');
  const extra = Object.keys(raw).filter((k) => !submit.fields.some((f) => f.key === k));
  if (extra.length) throw new HttpError(400, 'bad_fields', `unknown field ${String(extra[0]).slice(0, 20)}`);
  const out = {};
  for (const f of submit.fields) {
    const v = raw[f.key];
    if (v == null || v === '') { if (f.required) throw new HttpError(400, 'bad_fields', `${f.label} is required`); continue; }
    if (f.kind === 'text' || f.kind === 'longtext') out[f.key] = moderateText(v, { max: f.max, where: WHERE });
    else if (f.kind === 'choice') { if (!f.choices.includes(v)) throw new HttpError(400, 'bad_fields', `${f.label}: one of ${f.choices.join(', ')}`); out[f.key] = v; }
    else { const n = typeof v === 'number' ? v : Number(v); if (!Number.isInteger(n) || n < f.min || n > f.max) throw new HttpError(400, 'bad_fields', `${f.label}: a whole number ${f.min}–${f.max}`); out[f.key] = n; }
  }
  return { fields: out, text: out[submit.fields[0].key] };
}

/** The project host's handler for /_api/app*. `h` are tool-api.js helpers: {issue, consume, ipHash, launchOf, holderMode, isHolder}. */
export function createAppApi({ db, cfg, fetchImpl = fetch, limit, h }) {
  const beacon = createBeacon({ cfg, fetchImpl });
  const need = (spec) => { const a = appOf(spec); if (!a) throw new HttpError(404, 'app_off', 'this site has no app'); return a; };
  const holderFor = (project) => (wanted) => h.holderMode(cfg, h.launchOf(db, project), wanted);
  // the vote a signature is for: which round, which block (candidates tonight, or a published / board item)
  function voteTarget(project, app, itemId, t) {
    const it = db.get('SELECT * FROM app_items WHERE id = ? AND project_id = ? AND hidden_at IS NULL', String(itemId ?? ''), project.id);
    if (!it) throw new HttpError(404, 'not_found', 'no such item');
    const rnd = round(db, project, app, t);
    const cand = blocksOf(app, 'vote').find((b) => b.of === 'candidates');
    if (cand && rnd && !it.published_at && it.created_at >= rnd.start && it.created_at < rnd.slot) return { it, block: cand, round: rnd.key };
    const pub = blocksOf(app, 'vote').find((b) => b.of === 'published');
    if (pub && (it.published_at || exposure(app) === 'board')) return { it, block: pub, round: `item:${it.id}` };
    throw new HttpError(409, 'not_votable', cand ? 'voting on this one is closed' : 'this app takes no votes on that');
  }
  const intents = {
    'app.submit': (spec, b, project) => { const app = need(spec), s = blockOf(app, 'submit'); if (!s) throw new HttpError(404, 'app_off', 'this app has no form');
      const { fields, text } = normaliseFields(s, b.fields); return { c: s, payload: { fields }, summary: `Send to "${app.title}" of ${spec.name} ($${spec.ticker}): "${text}"` }; },
    'app.vote': (spec, b, project, t) => { const app = need(spec), { it, block, round: r } = voteTarget(project, app, b.itemId, t);
      return { c: block, payload: { itemId: it.id, round: r }, summary: `Vote for #${it.seq} "${[...it.text].slice(0, 80).join('')}" in "${app.title}" of ${spec.name} ($${spec.ticker}).` }; },
  };
  async function gate(project, c, b, action, payload, t) {
    const signature = h.consume(db, project, { wallet: String(b.wallet || ''), nonce: b.nonce, signature: b.signature, action, payload }, t);
    const launch = h.launchOf(db, project), hm = h.holderMode(cfg, launch, c.holdersOnly);
    if (hm.mode === 'holders' && !(await h.isHolder(launch.mint, b.wallet, t))) throw new HttpError(403, 'not_holder', `this wallet holds no $${project.ticker}; holders only`);
    return signature;
  }
  async function handle({ project, spec, method, path, ip, query, body, t }) {
    const app = need(spec);
    if (method === 'GET') {
      if (path === '/_api/app') return { body: await appState(db, cfg, project, app, beacon, holderFor(project), t) };
      if (path === '/_api/app/items') {
        try { await runReveals(db, project, app, beacon, t); } catch { /* later */ }
        return { body: listItems(db, project, app, { show: query.get('show'), month: query.get('month'), q: query.get('q'), before: query.get('before') ? Number(query.get('before')) : undefined, limit: query.get('limit') }, t) };
      }
      const m = /^\/_api\/app\/items\/([A-Za-z0-9_-]{1,40})$/.exec(path);
      if (m) return { body: oneItem(db, project, app, m[1], t) };
      if (path === '/_api/app/leaderboard') {
        const list = blocksOf(app, 'leaderboard'), i = Number(query.get('i') || 0);
        if (!list[i]) throw new HttpError(404, 'not_found');
        return { body: leaderboard(db, project, app, list[i], t) };
      }
      if (path === '/_api/app/pq') {
        if (!blockOf(app, 'pq')) throw new HttpError(404, 'app_off', 'this app has no registry');
        const { registryView } = await import('./pq.js');
        return { body: registryView(db, cfg, project, { before: Number(query.get('before')) || undefined }), cache: 'no-store' };
      }
      throw new HttpError(404, 'not_found');
    }
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (path === '/_api/app/submit') {
      const { c, payload } = intents['app.submit'](spec, b, project, t);
      let wallet = null;
      if (c.holdersOnly) { await gate(project, c, b, 'app.submit', payload, t); wallet = b.wallet; limit('siteWallet', wallet); }
      const hash = h.ipHash(db, ip), since = lastJst(t, '00:00');
      if (db.get('SELECT COUNT(*) n FROM app_items WHERE project_id = ? AND ip_hash = ? AND created_at >= ?', project.id, hash, since).n >= LIMITS.perIpDay) throw new HttpError(429, 'rate_limited', `at most ${LIMITS.perIpDay} a day from one connection; come back tomorrow (JST)`);
      if (db.get('SELECT COUNT(*) n FROM app_items WHERE project_id = ? AND created_at >= ?', project.id, since).n >= LIMITS.perProjectDay) throw new HttpError(429, 'rate_limited', 'this app took all it can for today; come back tomorrow (JST)');
      const iid = id('itm');
      db.tx(() => {
        const seq = (db.get('SELECT MAX(seq) s FROM app_items WHERE project_id = ?', project.id).s || 0) + 1;
        db.run('INSERT INTO app_items (id, project_id, seq, text, fields_json, wallet, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', iid, project.id, seq, payload.fields[c.fields[0].key], JSON.stringify(payload.fields), wallet, hash, t);
      });
      const row = db.get('SELECT * FROM app_items WHERE id = ?', iid), ex = exposure(app), sched = blockOf(app, 'schedule');
      return { body: { ok: true, item: ex === 'private' ? null : itemView(row, app, { votes: 0 }), private: ex === 'private', exposure: ex, number: row.seq, nextAt: sched ? nextSlot(sched, t) : null } };
    }
    if (path === '/_api/app/vote') {
      const { c, payload } = intents['app.vote'](spec, b, project, t);
      const signature = await gate(project, c, b, 'app.vote', payload, t);
      limit('siteWallet', b.wallet);
      const had = db.get('SELECT item_id FROM app_votes WHERE project_id = ? AND round = ? AND wallet = ?', project.id, payload.round, b.wallet);
      if (had) throw new HttpError(409, 'already_voted', payload.round.startsWith('slot:') ? 'this wallet already voted in this round' : 'this wallet already voted for this one', { itemId: had.item_id });
      db.run('INSERT INTO app_votes (project_id, round, item_id, wallet, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)', project.id, payload.round, payload.itemId, b.wallet, signature, t);
      return { body: { ok: true, itemId: payload.itemId, round: payload.round, votes: db.get('SELECT COUNT(*) n FROM app_votes WHERE project_id = ? AND round = ? AND item_id = ?', project.id, payload.round, payload.itemId).n } };
    }
    throw new HttpError(404, 'not_found');
  }
  return { intents, handle, beacon };
}

// --- the owner's side (room PC) ------------------------------------------------------------------------------------------
export function ownerApp(db, cfg, project, app, t = now()) {
  const rnd = app ? round(db, project, app, t) : null;
  const rows = db.all('SELECT * FROM app_items WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', project.id, LIMITS.inbox);
  const pick = rnd ? db.get('SELECT item_id FROM app_picks WHERE project_id = ? AND slot_at = ?', project.id, rnd.slot)?.item_id ?? null : null;
  return {
    inbox: rows.map((r) => ({ ...itemView(r, app || { screens: [] }), wallet: r.wallet ? shortWallet(r.wallet) : null, hidden: r.hidden_at != null, published: r.published_at != null,
      candidate: !!rnd && !r.published_at && !r.hidden_at && r.created_at >= rnd.start && r.created_at < rnd.slot, votes: voteCount(db, project, r.id), picked: r.id === pick })),
    round: rnd, pick, counts: app ? metrics(db, project, app, t) : null,
    reveals: db.all('SELECT r.*, i.seq, i.text FROM app_reveals r LEFT JOIN app_items i ON i.id = r.item_id WHERE r.project_id = ? ORDER BY r.slot_at DESC LIMIT 14', project.id)
      .map((r) => ({ slotAt: r.slot_at, method: r.method, dev: !!r.dev, number: r.seq ?? null, text: r.text ?? null })),
    devTrigger: Boolean(cfg.appDevTrigger),
  };
}

export function moderateItem(db, project, itemId, b, actor, t = now()) {
  const e = db.get('SELECT * FROM app_items WHERE id = ? AND project_id = ?', String(itemId), project.id);
  if (!e) throw new HttpError(404, 'not_found');
  if (typeof b.hidden === 'boolean') {
    db.run('UPDATE app_items SET hidden_at = ?, hidden_by = ? WHERE id = ?', b.hidden ? t : null, b.hidden ? actor : null, e.id);
    audit(db, { actor, kind: 'app', projectId: project.id, ideaId: project.idea_id, message: `${b.hidden ? 'hid' : 'unhid'} app item #${e.seq}`, data: { id: e.id } });
  }
  if (b.publish === true) {
    if (e.hidden_at && b.hidden !== false) throw new HttpError(409, 'hidden', 'unhide it first');
    if (e.published_at) throw new HttpError(409, 'published', 'already published');
    db.run('UPDATE app_items SET published_at = ?, published_by = ? WHERE id = ?', t, actor.replace(/^wallet:/, 'owner:'), e.id);
    audit(db, { actor, kind: 'app', projectId: project.id, ideaId: project.idea_id, isPublic: true, message: `published app item #${e.seq} on the site` });
  }
  return { ok: true };
}

export function pickNext(db, project, app, itemId, actor, t = now()) {
  const rnd = round(db, project, app, t);
  if (!rnd || !blockOf(app, 'reveal')?.pick.includes('owner')) throw new HttpError(400, 'no_reveal', 'this app has no reveal you can pick for');
  if (itemId == null) { db.run('DELETE FROM app_picks WHERE project_id = ? AND slot_at = ?', project.id, rnd.slot); return { ok: true, pick: null, slotAt: rnd.slot }; }
  const e = db.get('SELECT * FROM app_items WHERE id = ? AND project_id = ? AND hidden_at IS NULL AND published_at IS NULL', String(itemId), project.id);
  if (!e) throw new HttpError(404, 'not_found', 'no such unpublished, visible item');
  db.run('INSERT INTO app_picks (project_id, slot_at, item_id, picked_by, picked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, slot_at) DO UPDATE SET item_id = excluded.item_id, picked_by = excluded.picked_by, picked_at = excluded.picked_at',
    project.id, rnd.slot, e.id, actor, t);
  audit(db, { actor, kind: 'app', projectId: project.id, ideaId: project.idea_id, message: `picked #${e.seq} for the ${new Date(rnd.slot).toISOString()} reveal` });
  return { ok: true, pick: e.id, slotAt: rnd.slot };
}

/** The launchpad routes for the room PC. deps: {db, cfg, fetchImpl, limit, toolsProject, ownedProject, TOOL_STATES, liveSpec, currentVersion}. */
export function registerAppRoutes(r, deps) {
  const { db, cfg, fetchImpl, limit, toolsProject, ownedProject, TOOL_STATES, liveSpec, currentVersion } = deps;
  const beacon = createBeacon({ cfg, fetchImpl });
  const brainOf = (ideaId) => parseJson(db.get(`SELECT brain_json FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, ideaId)?.brain_json, {});
  r.get('/api/projects/:slug/app', async (ctx) => {
    const { p, idea, owner } = toolsProject(ctx, ctx.params.slug, { staffToo: true });
    const spec = liveSpec(db, p), app = appOf(spec);
    if (app) { try { await runReveals(db, p, app, beacon); } catch { /* later */ } }
    let pq = null;
    if (app && blockOf(app, 'pq')) { try { const m = await import('./pq.js'); m.syncRegistry(db, cfg, p); const k = m.projectKey(db, cfg, p); pq = { publicKey: k.public_key, ...m.verifyRegistry(db, p), total: db.get('SELECT COUNT(*) n FROM pq_entries WHERE project_id = ?', p.id).n }; } catch (e) { pq = { error: e.message }; } }
    return { editable: owner && TOOL_STATES.includes(idea.status), status: idea.status, app, summary: app ? describeApp(app) : null,
      blocks: BLOCKS, templates: CARD_TEMPLATES, metrics: METRIC_LABELS, liveSiteVersion: p.live_site_version, pq, ...ownerApp(db, cfg, p, app) };
  });
  r.post('/api/projects/:slug/app/compose', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    const spec = liveSpec(db, p), v = currentVersion(db, idea.id);
    const { composeApp } = await import('./composer.js');
    return composeApp({ title: v.title, concept: v.concept, name_suggestion: v.name_suggestion }, brainOf(idea.id), { name: spec.name, ticker: spec.ticker, cfg, fetchImpl });
  });
  r.put('/api/projects/:slug/app', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    if (!TOOL_STATES.includes(idea.status)) throw new HttpError(409, 'locked', 'the app can change while the preview is open, or after the launch');
    const b = await ctx.body(24_000);
    let app = null;
    if (b.app !== null) { try { app = validateApp(b.app); } catch (e) { if (isAppError(e)) throw new HttpError(400, 'invalid', e.message); throw e; } }
    const { buildSiteVersion, setLiveVersion } = await import('./site.js');
    const { validateSpec } = await import('./generator.js');
    const cur = liveSpec(db, p), spec = { ...cur };
    spec.app = app;                                      // null = switched off by the author (the backfill leaves it alone)
    try { validateSpec(spec); } catch (e) { throw new HttpError(400, 'invalid', e.message.replace('generated spec invalid: ', '')); }
    const site = await buildSiteVersion(db, cfg, p, spec, `wallet:${u.wallet}`);
    setLiveVersion(db, p, site.version, `wallet:${u.wallet}`);
    if (idea.status === 'preview_ready') db.run('UPDATE projects SET submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL, updated_at = ? WHERE id = ?', now(), p.id);
    audit(db, { actor: `wallet:${u.wallet}`, kind: 'app', projectId: p.id, ideaId: idea.id, isPublic: true, message: app ? `App edited by the author: ${describeApp(app)} (site v${site.version})` : `App switched off by the author (site v${site.version})` });
    return { version: site.version, app };
  });
  r.post('/api/projects/:slug/app/items/:id', async (ctx) => {
    const { p, u, owner } = toolsProject(ctx, ctx.params.slug, { staffToo: true });
    limit('write', u.wallet);
    return moderateItem(db, p, ctx.params.id, await ctx.body(1_000), `${owner ? 'wallet' : 'admin'}:${u.wallet}`);
  });
  r.post('/api/projects/:slug/app/pick', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    const app = appOf(liveSpec(db, p));
    if (!app) throw new HttpError(404, 'app_off', 'this site has no app');
    const b = await ctx.body(1_000);
    return pickNext(db, p, app, b.itemId ?? null, `wallet:${u.wallet}`);
  });
  r.post('/api/projects/:slug/app/announce', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    const app = appOf(liveSpec(db, p));
    if (!app || !blockOf(app, 'pq')) throw new HttpError(404, 'app_off', 'this site has no post-quantum registry');
    const text = moderateText((await ctx.body(2_000)).text, { max: 500, where: 'in the registry' });
    const { announce } = await import('./pq.js');
    return announce(db, cfg, p, text, `wallet:${u.wallet}`);
  });
  r.post('/api/projects/:slug/app/reveal-now', async (ctx) => {
    if (!cfg.appDevTrigger) throw new HttpError(404, 'not_found');
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    const app = appOf(liveSpec(db, p));
    if (!app) throw new HttpError(404, 'app_off', 'this site has no app');
    return (await devReveal(db, cfg, p, app, beacon)) || { item: null, method: 'already' };
  });
}

// --- boot backfill (scripts/backfill-app.js; tools/start.sh runs it) ------------------------------------------------------
/** Launched coins whose live spec has no `app` key get SUB-01's composed app as a NEW site version, set live, with the
 * tools the app supersedes switched off, recorded publicly as "SUB-01 built the app". Idempotent: a spec with an `app`
 * key at all (even null, the author's "off") is left alone. */
export async function backfillApps(db, cfg, { fetchImpl = fetch } = {}) {
  const { buildSiteVersion, setLiveVersion } = await import('./site.js');
  const { composeApp, toolsBeside } = await import('./composer.js');
  const { liveSpec } = await import('./tool-api.js');
  const out = { built: [], skipped: 0, failed: [] };
  const rows = db.all(`SELECT p.* FROM projects p JOIN ideas i ON i.id = p.idea_id JOIN launches l ON l.project_id = p.id
    WHERE i.status = 'launched' AND p.live_site_version IS NOT NULL ORDER BY p.created_at`);
  for (const p of rows) {
    const spec = liveSpec(db, p);
    if (!spec || spec.app !== undefined) { out.skipped++; continue; }
    try {
      const idea = db.get('SELECT v.title, v.concept, v.name_suggestion, v.ticker_suggestion FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version WHERE i.id = ?', p.idea_id);
      const brain = parseJson(db.get(`SELECT brain_json FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, p.idea_id)?.brain_json, {});
      const c = await composeApp(idea, brain, { name: spec.name, ticker: spec.ticker, cfg, fetchImpl });
      const next = { ...spec, app: c.app, ...(Array.isArray(spec.tools) ? { tools: toolsBeside(spec.tools, c.app) } : {}) };
      const site = await buildSiteVersion(db, cfg, p, next, 'system:sub01-app');
      setLiveVersion(db, p, site.version, 'system');
      const off = (spec.tools || []).map((x) => x.id).filter((x) => !(next.tools || []).some((y) => y.id === x));
      audit(db, { actor: 'system', kind: 'app', projectId: p.id, ideaId: p.idea_id, isPublic: true,
        message: `SUB-01 built the app: ${c.summary} (site v${site.version}${off.length ? `; replaces ${off.join(', ')}` : ''})`, data: { kind: c.app.kind, source: c.source, honest: c.honest } });
      out.built.push({ slug: p.slug, version: site.version, kind: c.app.kind, summary: c.summary, source: c.source, honest: c.honest, replaced: off });
    } catch (e) {
      out.failed.push({ slug: p.slug, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}

export { jstDay };
