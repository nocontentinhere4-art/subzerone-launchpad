// Live city chat: one Server-Sent Events stream (same origin, so the app CSP's connect-src 'self' holds), residents'
// messages with moderation and quotas, presence by district, reports and admin removal, and the relay to SUB-01
// (sub01relay.js). Public output carries resident names only, never wallets. Connections live in memory (one web
// process, as the rate limits; see DEPLOY.md). Contract: docs/CITY-API.md, "Chat".
import { HttpError, now, utcDay, parseJson, token, sha256 } from './util.js';
import { audit } from './db.js';
import { DISTRICTS, cleanText, validatePlotId, scrub, reservedName, readLook } from './world.js';
import { createRelay, textKey, wsUrl } from './sub01relay.js';

export const CHAT = Object.freeze({
  max: 140, keepMs: 7 * 86_400_000, recent: 50,
  gapMs: 3000, windowMs: 600_000, perWindow: 30, perDay: 200, dedupeMs: 60_000,
  presenceEveryMs: 20_000, presenceTtlMs: 90_000, onlineMax: 500,
  maxConnections: 2000, perIp: 20, idleMs: 600_000, heartbeatMs: 15_000, sub01EveryMs: 30_000, slowBytes: 262_144,
  sub01: { gapMs: 20_000, perDay: 20, cityGapMs: 10_000 },
  // live walkers (POST /api/presence): at most 2 posts a second per wallet, a walker that stops posting is gone after
  // the TTL, walker frames are coalesced into one `walkers` frame per 250 ms (≤ 4 broadcasts a second)
  walkPerSec: 2, walkTtlMs: 15_000, walkBatchMs: 250, walkPathMax: 24, walkMaxWalkers: 200,
});
export const SUB01_NAME = 'SUB-01';

// --- live walkers -------------------------------------------------------------------------------------------------
// The city the client draws is about ±101.5 units on x and z, with the canal bridge east to x ≈ 125 and the metro at
// z ≈ 108 (city-state.js, explore.js). A generous box, not the plot geometry: a position just off a kerb is still fine.
export const WALK_BOX = Object.freeze({ minX: -120, maxX: 140, minZ: -120, maxZ: 120 });
export const WALK_STATES = ['walk', 'idle', 'home'];
const EMOTE_RE = /^[a-z][a-z0-9_-]{0,15}$/;

/** POST /api/presence body -> {state, x, z, yaw, path, speed, emote}; a 400 on anything off. */
export function validateWalk(b, { pathMax = CHAT.walkPathMax, box = WALK_BOX } = {}) {
  const bad = (m) => new HttpError(400, 'bad_presence', m);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('a JSON object');
  const extra = Object.keys(b).filter((k) => !['state', 'x', 'z', 'yaw', 'path', 'speed', 'emote'].includes(k));
  if (extra.length) throw bad(`unknown field ${String(extra[0]).slice(0, 20)}`);
  if (!WALK_STATES.includes(b.state)) throw bad(`state: one of ${WALK_STATES.join(', ')}`);
  if (b.state === 'home') return { state: 'home' };
  const num = (v, k, lo, hi) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(`${k}: a number between ${lo} and ${hi}`);
    return Math.round(v * 100) / 100;
  };
  const x = num(b.x, 'x', box.minX, box.maxX), z = num(b.z, 'z', box.minZ, box.maxZ);
  const yaw = b.yaw == null ? 0 : num(b.yaw, 'yaw', -7, 7);
  const speed = b.speed == null ? 0 : num(b.speed, 'speed', 0, 12);
  let path = null;                                         // absent: the server keeps the walker's last path
  if (b.path != null) {
    if (!Array.isArray(b.path)) throw bad('path: an array of {x, z}');
    path = b.path.slice(0, pathMax).map((p, i) => {
      if (!p || typeof p !== 'object') throw bad(`path[${i}]: {x, z}`);
      return { x: num(p.x, `path[${i}].x`, box.minX, box.maxX), z: num(p.z, `path[${i}].z`, box.minZ, box.maxZ) };
    });
  }
  let emote = null;
  if (b.emote != null) { if (typeof b.emote !== 'string' || !EMOTE_RE.test(b.emote)) throw bad('emote: a short name'); emote = b.emote; }
  return { state: b.state, x, z, yaw, speed, path, emote };
}

/** What everyone sees of a walker: an opaque id, the resident's public name, plot and look. Never the wallet. */
export const walkerView = (w) => ({ id: w.id, name: w.name, plotId: w.plotId, look: w.look, state: w.state, x: w.x, z: w.z, yaw: w.yaw,
  path: w.path, speed: w.speed, ...(w.emote ? { emote: w.emote } : {}), at: w.at });

// --- moderation ---------------------------------------------------------------------------------------------------
const URL_RE = /(https?:\/\/|www\.|t\.me\/|discord\.gg)/i;
// a small denylist (hate slurs and self-harm prompts, as in the live server's chat.py), on a folded, de-leeted copy
const SLURS = ['nigger', 'nigga', 'faggot', 'fag', 'kike', 'spic', 'chink', 'gook', 'wetback', 'tranny', 'retard', 'dyke', 'kys', 'kill yourself'];
const SLUR_RE = new RegExp(`\\b(${SLURS.join('|')})(s|es|ed|ing|y|ic)?\\b`);
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[013457@$!]/g, (c) => LEET[c])
  .replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').replace(/(.)\1{2,}/g, '$1$1').trim();
// a fake name tag: "SUB-01: …", "[SUB01] …", "<sub 01> …", "**SUB-01** — …"
const FAKE_TAG = /^[\s\p{P}\p{S}]*sub[\s._-]*0?1(?![\p{L}\p{N}])[\s\p{P}\p{S}]*?[:：>»|\]\)}\-–—=]/iu;

/** -> the cleaned text, or a 400. */
export function moderate(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'bad_text', `text: 1–${CHAT.max} characters`);
  const t = cleanText(raw);
  if (!t || [...t].length > CHAT.max) throw new HttpError(400, 'bad_text', `text: 1–${CHAT.max} characters`);
  if (URL_RE.test(t) || URL_RE.test(t.replace(/\s+/g, ''))) throw new HttpError(400, 'no_links', 'links are not allowed in the city chat');
  if (SLUR_RE.test(fold(t))) throw new HttpError(400, 'blocked', 'that word is not allowed here');
  if (FAKE_TAG.test(raw.normalize('NFKC')) || FAKE_TAG.test(t)) throw new HttpError(400, 'impersonation', 'only SUB-01 speaks as SUB-01');
  return scrub(t);                                          // an address-like string is shortened, as in the news
}

const dayStart = (t) => Date.parse(`${utcDay(t)}T00:00:00Z`);
const untilTomorrow = (t) => Math.ceil((dayStart(t) + 86_400_000 - t) / 1000);
const tooFast = (message, retryAfterS) => new HttpError(429, 'rate_limited', message, { retryAfterS: Math.max(1, retryAfterS) });

export function msgView(r) {
  return { id: r.id, at: r.at, name: r.name, text: r.text, district: r.district ?? null, plotId: r.plot_id ?? null, kind: r.kind,
    ...(r.to_sub01 ? { to: 'sub01' } : {}), ...(r.replying_to_json ? { replyingTo: parseJson(r.replying_to_json) } : {}) };
}

export function createChat({ db, cfg, connect, fetchMind, relayOpts, limits = {} }) {
  const L = { ...CHAT, ...limits, sub01: { ...CHAT.sub01, ...(limits.sub01 || {}) } };
  const conns = new Set();
  const presence = new Map();                               // wallet -> {name, district, at}
  const walkers = new Map();                                // wallet -> {id, name, plotId, look, state, x, z, yaw, path, speed, emote, at}
  const walkPosts = new Map();                              // wallet -> [t, t] (the last two posts, for the 2/s rule)
  const walkSalt = token(16);                               // walker ids are stable for this process only
  const walkerId = (wallet) => sha256(`${walkSalt}:${wallet}`).slice(0, 16);
  let presenceTimer = null, lastForward = 0, sub01At = 0, walkTimer = null;
  const walkQueue = new Map();                              // id -> frame, flushed every walkBatchMs
  const inflight = new Set();
  const hasConn = (wallet) => [...conns].some((x) => x.wallet === wallet);

  // --- fan-out ---
  const frame = (event, data, id) => `${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  function drop(c) {
    if (!conns.delete(c)) return;
    try { c.res.end(); } catch { /* gone */ }
    if (c.wallet && !hasConn(c.wallet)) {
      if (presence.delete(c.wallet)) schedulePresence();
      leaveWalk(c.wallet);
    }
  }
  function write(c, text) {
    if (c.res.writableLength > L.slowBytes) return drop(c);  // a client that does not read is dropped, not buffered
    try { c.res.write(text); } catch { drop(c); }
  }
  const broadcast = (event, data, id) => { const f = frame(event, data, id); for (const c of [...conns]) write(c, f); };

  const online = () => [...presence.values()].sort((a, b) => b.at - a.at).slice(0, L.onlineMax).map(({ name, district }) => ({ name, district }));
  function schedulePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => { presenceTimer = null; broadcast('presence', { online: online() }); }, 1000);
    presenceTimer.unref?.();
  }
  // Walker frames: one `walker` when a single walker changed in the batch window, else one `walkers` [...] frame.
  function queueWalk(view) {
    walkQueue.set(view.id, view);
    if (walkTimer) return;
    walkTimer = setTimeout(() => {
      walkTimer = null;
      const batch = [...walkQueue.values()]; walkQueue.clear();
      if (batch.length === 1) broadcast('walker', batch[0]); else if (batch.length) broadcast('walkers', batch);
    }, L.walkBatchMs);
    walkTimer.unref?.();
  }
  /** The walker goes home: on a 'home' post, the TTL, logout, or the last stream closing. */
  function leaveWalk(wallet) {
    const w = walkers.get(wallet);
    if (!w) return false;
    walkers.delete(wallet);
    queueWalk({ id: w.id, name: w.name, plotId: w.plotId, state: 'home', at: now() });
    return true;
  }
  const walkersNow = () => [...walkers.values()].map(walkerView);

  const relay = createRelay({
    url: cfg.brain.url ? wsUrl(cfg.brain.url) : null,
    connect, fetchMind, opts: relayOpts,
    onState: (s) => { sub01At = now(); broadcast('sub01', s); },
    onReply: ({ text, replyingTo }) => {
      // his words, as the live server sent them (only control/bidi characters cleaned); no tag (product-level disclosure)
      const t = cleanText(text).slice(0, 600);
      if (!t) return;
      const rt = { id: replyingTo.id, name: replyingTo.name, text: replyingTo.text ? scrub(cleanText(replyingTo.text)).slice(0, 280) : null };
      broadcast('msg', ...store({ kind: 'sub01', name: SUB01_NAME, text: t, replyingTo: rt }));
    },
  });
  const ensureRelay = () => { if (relay.configured) relay.start(); };

  function store({ kind, wallet = null, name, text, district = null, plotId = null, toSub01 = false, replyingTo = null, key = null }) {
    const at = now();
    return db.tx(() => {
      db.run('DELETE FROM chat_messages WHERE at < ?', at - L.keepMs);
      const id = Number(db.run(`INSERT INTO chat_messages (at, kind, wallet, name, text, district, plot_id, to_sub01, replying_to_json, dedupe_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, at, kind, wallet, name, text, district, plotId, toSub01 ? 1 : 0,
      replyingTo ? JSON.stringify(replyingTo) : null, key).lastInsertRowid);
      return [msgView(db.get('SELECT * FROM chat_messages WHERE id = ?', id)), id];
    });
  }

  const resident = (user) => {
    const r = db.get('SELECT name, plot_id FROM residents WHERE wallet = ?', user.wallet);
    if (!r) throw new HttpError(409, 'no_resident', 'create your resident first (POST /api/residents)');
    if (reservedName(r.name)) throw new HttpError(403, 'impersonation', 'rename your resident: names like SUB-01 are reserved');
    return r;
  };
  const touch = (wallet) => { const t = now(); for (const c of conns) if (c.wallet === wallet) c.active = t; };
  function place(b) {
    const plotId = b.plotId == null ? null : validatePlotId(b.plotId);
    let district = b.district ?? null;
    if (district !== null && !DISTRICTS.includes(district)) throw new HttpError(400, 'bad_district', 'district: one of the districts in /api/world/options, or null');
    if (plotId) {
      const d = plotId.replace(/-\d+$/, '');
      if (district && district !== d) throw new HttpError(400, 'bad_district', `${plotId} is in ${d}`);
      district = d;
    }
    return { district, plotId };
  }
  const only = (b, keys) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_request', 'a JSON object');
    const extra = Object.keys(b).filter((k) => !keys.includes(k));
    if (extra.length) throw new HttpError(400, 'bad_request', `unknown field ${extra[0].slice(0, 20)}`);
  };
  /** Quotas from the stored rows (a restart does not reset them). */
  function cityQuota(wallet, key, t) {
    const rows = db.all('SELECT at, dedupe_key FROM chat_messages WHERE wallet = ? AND to_sub01 = 0 AND at >= ? ORDER BY at DESC',
      wallet, Math.min(dayStart(t), t - L.windowMs));
    if (rows[0] && t - rows[0].at < L.gapMs) throw tooFast(`one message every ${L.gapMs / 1000} s`, Math.ceil((L.gapMs - (t - rows[0].at)) / 1000));
    const win = rows.filter((r) => t - r.at < L.windowMs);
    if (win.length >= L.perWindow) throw tooFast(`at most ${L.perWindow} messages in ${L.windowMs / 60_000} minutes`, Math.ceil((win.at(-1).at + L.windowMs - t) / 1000));
    if (rows.filter((r) => r.at >= dayStart(t)).length >= L.perDay) throw tooFast(`at most ${L.perDay} messages a day`, untilTomorrow(t));
    if (rows.some((r) => t - r.at < L.dedupeMs && r.dedupe_key === key)) throw new HttpError(409, 'duplicate', 'you just said that');
  }

  // --- heartbeat, idle drop, presence expiry, periodic SUB-01 state ---
  const tick = setInterval(() => {
    const t = now();
    for (const c of [...conns]) { if (t - c.active > L.idleMs) drop(c); else write(c, ':\n\n'); }
    let gone = false;
    // online = residents with a live stream: a stale ping only expires once its streams are gone
    for (const [w, p] of presence) if (t - p.at > L.presenceTtlMs && !hasConn(w)) { presence.delete(w); gone = true; }
    if (gone) schedulePresence();
    if (conns.size && t - sub01At >= L.sub01EveryMs) { sub01At = t; broadcast('sub01', relay.state()); }
  }, L.heartbeatMs);
  tick.unref?.();
  // A walker that stops posting goes home after the TTL (checked a few times per TTL).
  const sweep = setInterval(() => {
    const t = now();
    for (const [w, x] of walkers) if (t - x.at > L.walkTtlMs) leaveWalk(w);
    for (const [w, ts] of walkPosts) if (t - ts[ts.length - 1] > 60_000) walkPosts.delete(w);
  }, Math.max(50, Math.floor(L.walkTtlMs / 3)));
  sweep.unref?.();

  return {
    relay, conns, presence, walkers,
    /** A frame to every stream (public verdicts, app.js). */
    broadcast,
    /** A frame to one wallet's own streams only (a private idea's verdict reaches its author, nobody else). -> streams written */
    sendTo(wallet, event, data) {
      if (!wallet) return 0;
      const f = frame(event, data);
      let n = 0;
      for (const c of [...conns]) if (c.wallet === wallet) { write(c, f); n++; }
      return n;
    },
    /** GET /api/chat/stream */
    stream(req, res, { user, ip }) {
      if (conns.size >= L.maxConnections) throw new HttpError(503, 'full', 'the city chat is full; try again in a minute', { retryAfterS: 60 });
      if ([...conns].filter((c) => c.ip === ip).length >= L.perIp) throw tooFast('too many chat connections from this address', 60);
      const r = user && db.get('SELECT name FROM residents WHERE wallet = ?', user.wallet);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
      if (req.method === 'HEAD') return res.end();
      const c = { res, ip, wallet: user?.wallet ?? null, active: now() };
      conns.add(c);
      req.on('close', () => drop(c));
      res.on('error', () => drop(c));
      ensureRelay();
      // a resident with a live stream is online from the first byte (the ping only adds the district)
      if (r && !presence.has(user.wallet)) { presence.set(user.wallet, { name: r.name, district: null, at: now() }); schedulePresence(); }
      const recent = db.all('SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?', L.recent).reverse().map(msgView);
      write(c, 'retry: 5000\n\n');
      write(c, frame('hello', { you: r ? { name: r.name, walker: walkerId(user.wallet) } : null, online: online(), recent, walkers: walkersNow() }));
      write(c, frame('sub01', relay.state()));
    },
    /** POST /api/presence {state, x, z, yaw, path, speed, emote?}: where the resident's model walks (see validateWalk). */
    walk(user, b) {
      const v = validateWalk(b, { pathMax: L.walkPathMax });
      const r = db.get('SELECT name, plot_id, look_json FROM residents WHERE wallet = ?', user.wallet);
      if (!r) throw new HttpError(409, 'no_resident', 'create your resident first (POST /api/residents)');
      const t = now(), ts = walkPosts.get(user.wallet) || [];
      if (ts.length >= L.walkPerSec && t - ts[ts.length - L.walkPerSec] < 1000) throw tooFast(`presence at most ${L.walkPerSec} times a second`, 1);
      ts.push(t); walkPosts.set(user.wallet, ts.slice(-L.walkPerSec));
      const id = walkerId(user.wallet);
      if (v.state === 'home') { leaveWalk(user.wallet); return { id, state: 'home' }; }
      if (!walkers.has(user.wallet) && walkers.size >= L.walkMaxWalkers) throw new HttpError(503, 'full', 'too many walkers out right now', { retryAfterS: 15 });
      // a fix without a path keeps the last one (the client sends the path only when it changes); idle clears it
      const prev = walkers.get(user.wallet);
      const path = v.path ?? ((v.state === 'walk' && prev?.path) || []);
      const w = { id, name: r.name, plotId: r.plot_id, look: readLook(r.look_json), ...v, path, at: t };
      walkers.set(user.wallet, w);
      queueWalk(walkerView(w));
      touch(user.wallet);
      return { id, state: w.state, at: t };
    },
    /** Logout (app.js): the walker goes home and the wallet leaves the online list. */
    leave(wallet) {
      if (!wallet) return;
      leaveWalk(wallet);
      if (presence.delete(wallet)) schedulePresence();
    },
    /** POST /api/chat/presence {district} */
    ping(user, b) {
      only(b, ['district']);
      const r = resident(user);
      const { district } = place({ district: b.district ?? null });
      const t = now(), cur = presence.get(user.wallet);
      if (cur?.pingAt && t - cur.pingAt < L.presenceEveryMs) throw tooFast(`presence at most every ${L.presenceEveryMs / 1000} s`, Math.ceil((L.presenceEveryMs - (t - cur.pingAt)) / 1000));
      presence.set(user.wallet, { name: r.name, district, at: t, pingAt: t });
      if (!cur || cur.district !== district || cur.name !== r.name) schedulePresence();
      touch(user.wallet);
      return { online: presence.size };
    },
    /** POST /api/chat {text, district?, plotId?} */
    post(user, b) {
      only(b, ['text', 'district', 'plotId']);
      const r = resident(user);
      const text = moderate(b.text);
      const { district, plotId } = place(b);
      const key = textKey(text);
      return db.tx(() => {
        cityQuota(user.wallet, key, now());
        const [m, id] = store({ kind: 'resident', wallet: user.wallet, name: r.name, text, district, plotId, key });
        touch(user.wallet);
        broadcast('msg', m, id);
        return { message: m };
      });
    },
    /** POST /api/chat/sub01 {text}: forwarded over the relay; his answer (if any) arrives later on the stream. */
    async sub01(user, b) {
      only(b, ['text', 'district', 'plotId']);
      const r = resident(user);
      const text = moderate(b.text);
      const { district, plotId } = place(b);
      if (inflight.has(user.wallet)) throw tooFast('your last message to SUB-01 is still on its way', 2);
      const t = now();
      const rows = db.all('SELECT at FROM chat_messages WHERE wallet = ? AND to_sub01 = 1 AND at >= ? ORDER BY at DESC', user.wallet, Math.min(dayStart(t), t - L.sub01.gapMs));
      if (rows[0] && t - rows[0].at < L.sub01.gapMs) throw tooFast(`one message to SUB-01 every ${L.sub01.gapMs / 1000} s`, Math.ceil((L.sub01.gapMs - (t - rows[0].at)) / 1000));
      if (rows.filter((x) => x.at >= dayStart(t)).length >= L.sub01.perDay) throw tooFast(`at most ${L.sub01.perDay} messages to SUB-01 a day`, untilTomorrow(t));
      ensureRelay();
      if (relay.state().state === 'offline') throw new HttpError(503, 'sub01_offline', 'SUB-01 cannot be reached right now', { sub01: relay.state() });
      // the live server takes one message per 10 s from this process (it is one client to him): the city shares it
      if (t - lastForward < L.sub01.cityGapMs) throw new HttpError(429, 'sub01_busy', 'SUB-01 is reading another city message; try again in a few seconds', { retryAfterS: Math.ceil((L.sub01.cityGapMs - (t - lastForward)) / 1000) });
      lastForward = t;
      inflight.add(user.wallet);
      let ack;
      try { ack = await relay.send(text, r.name); } finally { inflight.delete(user.wallet); }
      if (ack.timeout) throw new HttpError(504, 'sub01_no_answer', 'SUB-01\'s server did not confirm the message', { sub01: relay.state() });
      if (ack.lost) throw new HttpError(503, 'sub01_offline', 'SUB-01 cannot be reached right now', { sub01: relay.state() });
      if (!ack.ok) {
        if (/one message every/.test(ack.reason)) throw new HttpError(429, 'sub01_busy', 'SUB-01 is reading another city message; try again in a few seconds', { retryAfterS: 10 });
        throw new HttpError(422, 'sub01_refused', `SUB-01's chat filter refused it: ${ack.reason}`, { reason: ack.reason });
      }
      const [m, id] = store({ kind: 'resident', wallet: user.wallet, name: r.name, text, district, plotId, toSub01: true, key: textKey(text) });
      relay.track({ id, name: r.name, text });
      touch(user.wallet);
      broadcast('msg', m, id);
      return { message: m, sub01: relay.state() };
    },
    /** POST /api/chat/report {id} */
    report(user, b) {
      only(b, ['id']);
      const id = Number(b.id);
      if (!Number.isSafeInteger(id) || !db.get('SELECT 1 FROM chat_messages WHERE id = ?', id)) throw new HttpError(404, 'not_found');
      db.tx(() => {
        if (db.run('INSERT OR IGNORE INTO chat_reports (message_id, wallet, at) VALUES (?, ?, ?)', id, user.wallet, now()).changes) {
          db.run('UPDATE chat_messages SET reports = reports + 1, reported_at = ? WHERE id = ?', now(), id);
        }
      });
      return { ok: true };
    },
    adminList(query) {
      const reported = query.get('reported') === '1';
      const rows = db.all(`SELECT * FROM chat_messages ${reported ? 'WHERE reports > 0 ORDER BY reported_at DESC' : 'ORDER BY id DESC'} LIMIT 200`);
      return { messages: rows.map((x) => ({ ...msgView(x), wallet: x.wallet, reports: x.reports, reportedAt: x.reported_at })) };
    },
    adminDelete(admin, idRaw) {
      const id = Number(idRaw);
      const row = Number.isSafeInteger(id) && db.get('SELECT * FROM chat_messages WHERE id = ?', id);
      if (!row) throw new HttpError(404, 'not_found');
      db.tx(() => {
        db.run('DELETE FROM chat_messages WHERE id = ?', id);
        audit(db, { actor: `admin:${admin.wallet}`, kind: 'admin', message: `removed chat message ${id}`, data: { name: row.name, wallet: row.wallet } });
      });
      broadcast('del', { id });
      return { ok: true };
    },
    close() {
      clearInterval(tick); clearInterval(sweep); clearTimeout(presenceTimer); clearTimeout(walkTimer); relay.stop();
      for (const c of [...conns]) drop(c);
    },
  };
}
