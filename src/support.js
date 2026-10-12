// Help / support (2026-10-12). Anyone with a problem writes a report from the city (the Help button, the launch
// stepper, a launch or dev-buy error); the owner reads and answers it on /admin#support, the AI operator through a
// bearer-token inbox. Reports work signed in or anonymous: every report returns a random read token (only its sha256
// is stored) that the city keeps to show "My reports" and the replies.
//
// What a report carries, besides the author's words:
//   - the client's context, only when the author left "include" ticked: a strict allow-list of short fields (wallet,
//     project, the launch flow's last error, the city's last ~10 failed calls, bundle, browser, viewport, wallets
//     detected, page). Unknown fields are dropped; every string is capped and scrubbed of anything that looks like a
//     secret (private keys, keypair byte arrays, signed transactions, API keys, seed phrases);
//   - the server's own context, from the database only: the author's ideas, the projects' latest launch intents and
//     dev-buy attempts with their errors, and the jobs that died or keep failing. No logs, no secrets.
// The author never gets either context back: /mine returns their words, the status and the replies.
// Limits: 5 reports an hour per IP and per wallet (counted in the database, so a restart does not reset them), 100 an
// hour in all; 10–2000 characters; a 16 KB body.
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { HttpError, id, token, sha256, now, parseJson, isSolanaAddress } from './util.js';
import { getSetting, setSetting } from './db.js';
import { log } from './log.js';

export const SUPPORT = Object.freeze({
  categories: ['launch', 'wallet', 'devbuy', 'site', 'x', 'other'],
  sources: ['help', 'stepper', 'launch_error', 'devbuy_error'],
  statuses: ['open', 'in_progress', 'answered', 'closed'],
  messageMin: 10, messageMax: 2000, contactMax: 64, replyMax: 4000,
  perHourIp: 5, perHourWallet: 5, perHourAll: 100,
  bodyBytes: 16_000, tokensMax: 20, errorsMax: 10,
});
export const SUPPORT_LABEL = 'SUBZERONE support';            // how every staff reply is signed to the author
const HOUR = 3_600_000;

// --- secrets out ---------------------------------------------------------------------------------------------------
// Each pattern is something nobody should ever paste into a support form. Wallet addresses (32–44 base58) and mints
// stay; 64-byte things in base58 (a secret key, but also a transaction signature: the server attaches those itself from
// the database) and long base64 (a signed transaction) go.
const SECRET_PATTERNS = [
  /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){31,}\s*\]/g,                           // a keypair as a JSON byte array
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,}(?![1-9A-HJ-NP-Za-km-z])/g, // a base58 secret key (or a signature)
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{120,}={0,2}/g,                           // a base64 transaction or key file
  /(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g,                      // a hex private key
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,  // API keys
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,                                       // a Telegram bot token
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|private[_-]?key)\s*[:=]\s*\S{6,}/gi,
  /\b(?:[a-z]{3,8}[ \t]+){11,23}[a-z]{3,8}\b/g,                              // 12–24 short lowercase words: a seed phrase
];
const REMOVED = '[removed: looked like a secret]';
/** -> {text, redacted}. Control characters (but newlines and tabs in the message) go too. */
export function scrubSecrets(s, { multiline = false } = {}) {
  let text = String(s ?? '').replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, multiline ? '' : ' ');
  let redacted = false;
  for (const re of SECRET_PATTERNS) text = text.replace(re, () => { redacted = true; return REMOVED; });
  return { text, redacted };
}

// --- validation ------------------------------------------------------------------------------------------------------
const bad = (what) => { throw new HttpError(400, 'bad_support', what); };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const SLUG = /^[a-z0-9-]{1,40}$/;
const WORD = /^[a-z0-9_:. -]{1,40}$/i;

/** A short string from the client's context: capped, scrubbed; anything else is dropped (null). */
function ctxStr(v, max, flags) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const { text, redacted } = scrubSecrets(String(v).slice(0, max * 2));
  if (redacted) flags.redacted = true;
  const t = text.trim().slice(0, max);
  return t || null;
}
const ctxNum = (v, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== '' && Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v)) : null);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)
  && !(isObj(v) && !Object.keys(v).length)));

/** The client's context, allow-listed -> {context, redacted}. Unknown fields are dropped, never stored. */
export function cleanClientContext(raw) {
  if (raw == null) return { context: null, redacted: false };
  if (!isObj(raw)) bad('context must be an object');
  const f = { redacted: false };
  const s = (v, n) => ctxStr(v, n, f);
  const project = isObj(raw.project) ? compact({ slug: SLUG.test(String(raw.project.slug || '')) ? raw.project.slug : null, status: s(raw.project.status, 40), name: s(raw.project.name, 60) }) : null;
  const l = isObj(raw.launch) ? raw.launch : null;
  const launch = l ? compact({ intentId: s(l.intentId, 64), step: s(l.step, 24), status: s(l.status, 40), code: s(l.code, 60), message: s(l.message, 300),
    httpStatus: ctxNum(l.httpStatus, 0, 599), at: ctxNum(l.at, 0, 8.64e15) }) : null;
  const errors = Array.isArray(raw.errors) ? raw.errors.slice(-SUPPORT.errorsMax).filter(isObj).map((e) => compact({
    at: ctxNum(e.at, 0, 8.64e15), method: /^(GET|POST|PUT|PATCH|DELETE)$/.test(String(e.method)) ? e.method : null,
    // the path without its query (tokens never ride in a query here, but a pasted one would)
    path: typeof e.path === 'string' ? s(e.path.split(/[?#]/)[0], 120) : null, status: ctxNum(e.status, 0, 599), code: s(e.code, 60), message: s(e.message, 200),
  })) : [];
  const wallets = Array.isArray(raw.wallets) ? raw.wallets.slice(0, 10).map((w) => s(w, 32)).filter(Boolean) : [];
  const context = compact({
    wallet: typeof raw.wallet === 'string' && isSolanaAddress(raw.wallet) ? raw.wallet : null,
    project, launch, errors, wallets,
    bundle: s(raw.bundle, 64), userAgent: s(raw.userAgent, 300), viewport: s(raw.viewport, 40), page: s(raw.page, 200),
    language: s(raw.language, 20), signedIn: typeof raw.signedIn === 'boolean' ? raw.signedIn : null,
  });
  return { context: Object.keys(context).length ? context : null, redacted: f.redacted };
}

const BODY_KEYS = new Set(['category', 'message', 'contact', 'context', 'source']);
/** The POST body -> {category, source, message, contact, context, projectSlug, redacted}. Throws 400 bad_support. */
export function validateReport(b) {
  if (!isObj(b)) bad('expected a JSON object');
  const extra = Object.keys(b).find((k) => !BODY_KEYS.has(k));
  if (extra) bad(`unknown field ${extra.slice(0, 24)}`);
  if (!SUPPORT.categories.includes(b.category)) bad(`category: one of ${SUPPORT.categories.join(', ')}`);
  const source = b.source == null ? 'help' : b.source;
  if (!SUPPORT.sources.includes(source)) bad(`source: one of ${SUPPORT.sources.join(', ')}`);
  if (typeof b.message !== 'string') bad('message: text');
  const len = b.message.trim().length;
  if (len < SUPPORT.messageMin || len > SUPPORT.messageMax) bad(`message: ${SUPPORT.messageMin}–${SUPPORT.messageMax} characters`);
  const msg = scrubSecrets(b.message.trim(), { multiline: true });
  let contact = null;
  if (b.contact != null && b.contact !== '') {
    if (typeof b.contact !== 'string') bad('contact: text');
    const c = b.contact.trim();
    // an X handle (@name), a Telegram handle or t.me link; nothing that could carry markup or a script
    if (c.length > SUPPORT.contactMax || !/^[A-Za-z0-9@_.:/+ -]{2,}$/.test(c)) bad('contact: an X or Telegram handle, at most 64 characters');
    contact = c;
  }
  const { context, redacted } = cleanClientContext(b.context);
  return { category: b.category, source, message: msg.text, contact, context, projectSlug: context?.project?.slug || null, redacted: msg.redacted || redacted };
}

// --- the server's own context ----------------------------------------------------------------------------------------
const cut = (s, n = 300) => (s == null ? null : scrubSecrets(String(s)).text.slice(0, n));
/** What the database knows about this author / project, for the staff. Bounded: 5 projects, 3 intents, 8 jobs. */
export function serverContext(db, { wallet = null, slug = null } = {}) {
  const out = { at: now(), signedIn: Boolean(wallet) };
  const ideaIds = [];
  const projects = [];
  if (wallet) {
    const u = db.get('SELECT role, created_at, banned_at FROM users WHERE wallet = ?', wallet);
    out.user = u ? { role: u.role, since: u.created_at, banned: Boolean(u.banned_at) } : null;
    const ideas = db.all(`SELECT i.id, i.status, i.status_note, i.updated_at, p.id project_id, p.slug FROM ideas i LEFT JOIN projects p ON p.idea_id = i.id
      WHERE i.owner_wallet = ? ORDER BY i.updated_at DESC LIMIT 5`, wallet);
    out.ideas = ideas.map((i) => ({ id: i.id, status: i.status, note: cut(i.status_note, 200), slug: i.slug || null, updatedAt: i.updated_at }));
    for (const i of ideas) { ideaIds.push(i.id); if (i.project_id) projects.push({ id: i.project_id, slug: i.slug, owned: true }); }
  }
  if (slug && SLUG.test(slug) && !projects.some((p) => p.slug === slug)) {
    const p = db.get('SELECT p.id, p.slug, i.id idea_id, i.owner_wallet FROM projects p JOIN ideas i ON i.id = p.idea_id WHERE p.slug = ?', slug);
    if (p) { projects.push({ id: p.id, slug: p.slug, owned: Boolean(wallet) && p.owner_wallet === wallet, named: true }); ideaIds.push(p.idea_id); }
    else out.unknownSlug = slug;
  }
  out.projects = projects.slice(0, 5).map((p) => {
    const idea = db.get('SELECT i.status, i.status_note FROM ideas i JOIN projects pr ON pr.idea_id = i.id WHERE pr.id = ?', p.id);
    const intents = db.all(`SELECT id, status, error, provider, network, dev_buy_mode, tx_signature, signer_wallet, created_at, updated_at FROM launch_intents
      WHERE project_id = ? ORDER BY updated_at DESC LIMIT 3`, p.id);
    const launch = db.get('SELECT mint, tx_signature, dev_buy_status, dev_buy_lamports, verified_at FROM launches WHERE project_id = ?', p.id);
    const buys = db.all('SELECT id, status, error, requested_lamports, tx_signature, updated_at FROM dev_buy_attempts WHERE project_id = ? ORDER BY updated_at DESC LIMIT 3', p.id);
    return {
      slug: p.slug, owned: p.owned, ...(p.named ? { namedByClient: true } : {}), status: idea?.status || null, note: cut(idea?.status_note, 200),
      intents: intents.map((x) => ({ id: x.id, status: x.status, error: cut(x.error), provider: x.provider, network: x.network, devBuyMode: x.dev_buy_mode,
        txSignature: x.tx_signature, signerIsAuthor: wallet ? x.signer_wallet === wallet : null, createdAt: x.created_at, updatedAt: x.updated_at })),
      launch: launch ? { mint: launch.mint, txSignature: launch.tx_signature, devBuyStatus: launch.dev_buy_status, devBuyLamports: launch.dev_buy_lamports, verifiedAt: launch.verified_at } : null,
      devBuyAttempts: buys.map((x) => ({ id: x.id, status: x.status, error: cut(x.error), lamports: x.requested_lamports, txSignature: x.tx_signature, updatedAt: x.updated_at })),
    };
  });
  const pids = projects.map((p) => p.id);
  if (pids.length || ideaIds.length) {
    const ph = (xs) => xs.map(() => '?').join(',') || 'NULL';
    out.jobs = db.all(`SELECT id, type, status, attempts, max_attempts, last_error, project_id, idea_id, updated_at FROM jobs
      WHERE (project_id IN (${ph(pids)}) OR idea_id IN (${ph(ideaIds)})) AND (status = 'dead' OR last_error IS NOT NULL)
      ORDER BY updated_at DESC LIMIT 8`, ...pids, ...ideaIds)
      .map((j) => ({ id: j.id, type: j.type, status: j.status, attempts: `${j.attempts}/${j.max_attempts}`, lastError: cut(j.last_error), updatedAt: j.updated_at }));
  }
  return out;
}

// --- storage -----------------------------------------------------------------------------------------------------------
function ipHash(db, ip) {
  let s = getSetting(db, 'support.salt', null);
  if (!s) { s = randomBytes(32).toString('hex'); setSetting(db, 'support.salt', s, 'system'); }
  return createHmac('sha256', s).update(String(ip)).digest('hex').slice(0, 32);
}

/** -> {ticket (the author's view), token}. Throws 400 bad_support, 429 rate_limited. */
export function createTicket(db, { body, wallet = null, ip }, t = now()) {
  const r = validateReport(body);
  const ih = ipHash(db, ip);
  const since = t - HOUR;
  const retry = (first) => ({ retryAfterS: Math.max(1, Math.ceil((first + HOUR - t) / 1000)) });
  const byIp = db.get('SELECT COUNT(*) n, MIN(created_at) first FROM support_tickets WHERE ip_hash = ? AND created_at > ?', ih, since);
  if (byIp.n >= SUPPORT.perHourIp) throw new HttpError(429, 'rate_limited', `at most ${SUPPORT.perHourIp} reports an hour; we read every one`, retry(byIp.first));
  if (wallet) {
    const byW = db.get('SELECT COUNT(*) n, MIN(created_at) first FROM support_tickets WHERE wallet = ? AND created_at > ?', wallet, since);
    if (byW.n >= SUPPORT.perHourWallet) throw new HttpError(429, 'rate_limited', `at most ${SUPPORT.perHourWallet} reports an hour; we read every one`, retry(byW.first));
  }
  const all = db.get('SELECT COUNT(*) n FROM support_tickets WHERE created_at > ?', since).n;
  if (all >= SUPPORT.perHourAll) throw new HttpError(429, 'rate_limited', 'too many reports right now; try again in a few minutes', { retryAfterS: 300 });
  const tok = token(24);
  const ticketId = id('sup');
  const server = serverContext(db, { wallet, slug: r.projectSlug });
  db.run(`INSERT INTO support_tickets (id, wallet, token_hash, ip_hash, category, source, message, contact, project_slug, client_context_json,
      server_context_json, redacted, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ticketId, wallet, sha256(tok), ih, r.category, r.source, r.message, r.contact, r.projectSlug, r.context ? JSON.stringify(r.context) : null,
  JSON.stringify(server), r.redacted ? 1 : 0, t, t);
  return { ticket: authorView(db, db.get('SELECT * FROM support_tickets WHERE id = ?', ticketId)), token: tok, redacted: r.redacted };
}

const repliesOf = (db, ticketId) => db.all('SELECT author, text, created_at FROM support_replies WHERE ticket_id = ? ORDER BY id', ticketId);
/** What the author sees: their words, the status, the replies signed "SUBZERONE support". No context, no wallet. */
export function authorView(db, row) {
  return { id: row.id, category: row.category, message: row.message, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    replies: repliesOf(db, row.id).map((x) => ({ from: SUPPORT_LABEL, text: x.text, at: x.created_at })) };
}
/** What the staff (admin page, operator) sees: everything stored except the hashes. */
export function staffView(db, row) {
  return { id: row.id, status: row.status, category: row.category, source: row.source, message: row.message, contact: row.contact, wallet: row.wallet,
    signedIn: Boolean(row.wallet), projectSlug: row.project_slug, redacted: Boolean(row.redacted), createdAt: row.created_at, updatedAt: row.updated_at,
    clientContext: parseJson(row.client_context_json, null), serverContext: parseJson(row.server_context_json, null),
    replies: repliesOf(db, row.id).map((x) => ({ author: x.author, from: SUPPORT_LABEL, text: x.text, at: x.created_at })) };
}

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
/** The author's reports: by the signed-in wallet and/or by read tokens (header x-support-token, comma-separated). */
export function myTickets(db, { wallet = null, tokens = [] }) {
  const toks = [...new Set(tokens.map((x) => String(x).trim()).filter((x) => TOKEN.test(x)))].slice(0, SUPPORT.tokensMax);
  if (!wallet && !toks.length) throw new HttpError(401, 'sign_in', 'sign in, or send the report token this browser kept');
  const rows = new Map();
  if (wallet) for (const r of db.all('SELECT * FROM support_tickets WHERE wallet = ? ORDER BY created_at DESC LIMIT 50', wallet)) rows.set(r.id, r);
  for (const tk of toks) { const r = db.get('SELECT * FROM support_tickets WHERE token_hash = ?', sha256(tk)); if (r) rows.set(r.id, r); }
  return { tickets: [...rows.values()].sort((a, b) => b.created_at - a.created_at).map((r) => authorView(db, r)) };
}

/** Staff list, newest first. filter: {status, category, q, since, limit}. */
export function listTickets(db, { status = null, category = null, q = null, since = null, limit = 100 } = {}) {
  const where = [], args = [];
  if (status) { const ss = String(status).split(',').filter((s) => SUPPORT.statuses.includes(s)); if (!ss.length) bad('status'); where.push(`status IN (${ss.map(() => '?').join(',')})`); args.push(...ss); }
  if (category) { if (!SUPPORT.categories.includes(category)) bad('category'); where.push('category = ?'); args.push(category); }
  if (q) { const s = String(q).slice(0, 80).replace(/[%_\\]/g, (c) => `\\${c}`); where.push("(message LIKE ? ESCAPE '\\' OR wallet LIKE ? ESCAPE '\\' OR project_slug LIKE ? ESCAPE '\\' OR id = ?)"); args.push(`%${s}%`, `%${s}%`, `%${s}%`, String(q)); }
  if (since != null) { where.push('updated_at > ?'); args.push(since); }
  const n = Math.min(200, Math.max(1, Number(limit) || 100));
  const rows = db.all(`SELECT * FROM support_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${n}`, ...args);
  const counts = Object.fromEntries(SUPPORT.statuses.map((s) => [s, 0]));
  for (const c of db.all('SELECT status, COUNT(*) n FROM support_tickets GROUP BY status')) counts[c.status] = c.n;
  return { tickets: rows.map((r) => staffView(db, r)), counts, open: counts.open + counts.in_progress, now: now() };
}

const ticketOr404 = (db, ticketId) => {
  const row = typeof ticketId === 'string' && /^sup_[A-Za-z0-9_-]{6,20}$/.test(ticketId) ? db.get('SELECT * FROM support_tickets WHERE id = ?', ticketId) : null;
  if (!row) throw new HttpError(404, 'not_found');
  return row;
};
export const getTicket = (db, ticketId) => staffView(db, ticketOr404(db, ticketId));

/** A staff reply. Sets the status ('answered' unless one is given). author: 'operator' | 'admin:<wallet>'. */
export function replyTicket(db, ticketId, { text, status } = {}, author, t = now()) {
  const row = ticketOr404(db, ticketId);
  if (typeof text !== 'string' || !text.trim() || text.length > SUPPORT.replyMax) bad(`text: 1–${SUPPORT.replyMax} characters`);
  const to = status == null ? 'answered' : status;
  if (!SUPPORT.statuses.includes(to)) bad(`status: one of ${SUPPORT.statuses.join(', ')}`);
  db.tx(() => {
    db.run('INSERT INTO support_replies (ticket_id, author, text, created_at) VALUES (?, ?, ?, ?)', row.id, author, text.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''), t);
    db.run('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?', to, t, row.id);
  });
  return staffView(db, db.get('SELECT * FROM support_tickets WHERE id = ?', row.id));
}
export function setTicketStatus(db, ticketId, status, t = now()) {
  const row = ticketOr404(db, ticketId);
  if (!SUPPORT.statuses.includes(status)) bad(`status: one of ${SUPPORT.statuses.join(', ')}`);
  db.run('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?', status, t, row.id);
  return staffView(db, db.get('SELECT * FROM support_tickets WHERE id = ?', row.id));
}

// --- operator auth -------------------------------------------------------------------------------------------------------
const digest = (s) => createHash('sha256').update(String(s)).digest();
/** Authorization: Bearer <SUPPORT_OPERATOR_TOKEN>, compared in constant time (on digests, so the length leaks nothing). */
export function operatorAllowed(cfg, authorization) {
  const want = cfg.support?.operatorToken;
  if (!want) return false;
  const m = /^Bearer ([^\s]+)$/.exec(String(authorization || ''));
  return timingSafeEqual(digest(m ? m[1] : ''), digest(want)) && Boolean(m);
}

/** since: unix ms, or an ISO date; null when absent. */
export function parseSince(v) {
  if (v == null || v === '') return null;
  if (/^\d{1,16}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (!Number.isFinite(t) || !/^\d{4}-\d{2}-\d{2}/.test(v)) bad('since: unix milliseconds or an ISO date');
  return t;
}

// --- the owner's Telegram ping -------------------------------------------------------------------------------------------
const CATEGORY_WORDS = { launch: 'Launch', wallet: 'Wallet/Phantom', devbuy: 'Dev buy', site: 'My site', x: 'X', other: 'Other' };
export const categoryLabel = (c) => CATEGORY_WORDS[c] || c;
/** Fire and forget: never awaited by the request, never throws, never logs the token or the URL. Skipped when unset. */
export function notifyTelegram(cfg, fetchImpl, ticket) {
  const { telegramBotToken: bot, telegramChatId: chat } = cfg.support || {};
  if (!bot || !chat) return null;
  const text = [`SUBZERONE support · ${categoryLabel(ticket.category)} · ${ticket.signedIn ? 'signed in' : 'anonymous'}`,
    ticket.message.replace(/\s+/g, ' ').slice(0, 200) + (ticket.message.length > 200 ? '…' : ''),
    `${cfg.publicOrigin}/admin#support`].join('\n');
  let p;
  try {
    p = Promise.resolve(fetchImpl(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    }));
  } catch { p = Promise.reject(new Error('fetch threw')); }
  return p.then((res) => { if (!res?.ok) log.warn('support telegram not sent', { status: res?.status ?? null, ticket: ticket.id }); return Boolean(res?.ok); },
    (err) => { log.warn('support telegram not sent', { error: err?.name || 'error', ticket: ticket.id }); return false; });
}
