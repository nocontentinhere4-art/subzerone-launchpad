// Daily rituals in the city: omikuji (one fortune per Tokyo day), build-or-pass predictions, ema (ideas pinned before
// the vote, with cheers) and "while you were away". Legal line: nothing here is a prize, a stake or a tradeable thing.
// Fortunes and buffs are cosmetic and expire at midnight JST; prediction points only order a leaderboard; cheers are
// never read by the pipeline or the brain. No wallet ever appears in a public output (names only).
import { createHash, randomBytes } from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { jstDate, dayStart, TOKYO_DAY } from './calendar.js';
import { LABELS } from './states.js';
import { now, sha256, HttpError } from './util.js';

export const NO_VALUE_NOTE = 'Cosmetic only: no value, nothing to trade, transfer or redeem.';

function requireResident(db, wallet) {
  const r = db.get('SELECT * FROM residents WHERE wallet = ?', wallet);
  if (!r) throw new HttpError(409, 'no_resident', 'create your resident first (POST /api/residents)');
  return r;
}
const strictBody = (b, keys) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_request', `a JSON object with ${keys.join(', ')}`);
  const extra = Object.keys(b).filter((k) => !keys.includes(k));
  if (extra.length) throw new HttpError(400, 'bad_request', `unknown field ${extra[0].slice(0, 20)}`);
};
const intParam = (q, k, d, min, max) => {
  const s = q.get(k);
  if (s == null || s === '') return d;
  if (!/^\d{1,4}$/.test(s) || Number(s) < min || Number(s) > max) throw new HttpError(400, 'bad_request', `${k}: an integer ${min}–${max}`);
  return Number(s);
};
const IDEA_ID = /^idea_[A-Za-z0-9_-]{1,40}$/;
const validIdeaId = (x) => {
  if (typeof x !== 'string' || !IDEA_ID.test(x)) throw new HttpError(400, 'bad_request', 'ideaId: an idea id');
  return x;
};

// --- omikuji ----------------------------------------------------------------------------------------------------------
// The usual shrine ranks (orders vary between shrines). weight = slips in the box out of 12.
export const FORTUNES = Object.freeze([
  { id: 'daikichi', kanji: '大吉', rank: 1, weight: 1, buff: 'glow', texts: [
    'Great blessing. Your balcony lantern stays lit until midnight.',
    'Great blessing. Even the crows are polite to you today.',
    'Great blessing. The street hums your song as you walk by.'] },
  { id: 'kichi', kanji: '吉', rank: 2, weight: 3, buff: 'petals', texts: [
    'Blessing. A good day to finish something small.',
    'Blessing. The vending machine gives you the warm can.',
    'Blessing. Someone in your district is glad you live here.'] },
  { id: 'chukichi', kanji: '中吉', rank: 3, weight: 2, buff: 'confetti', texts: [
    'Middle blessing. A neighbour may wave first.',
    'Middle blessing. Your plants look happier than yesterday.',
    'Middle blessing. The last train waits a few seconds for you.'] },
  { id: 'shokichi', kanji: '小吉', rank: 4, weight: 2, buff: 'petals', texts: [
    'Small blessing. Tea tastes better than usual.',
    'Small blessing. The cat on the wall blinks at you.',
    'Small blessing. A quiet table at your favourite ramen bar.'] },
  { id: 'hankichi', kanji: '半吉', rank: 5, weight: 1, buff: 'none', texts: [
    'Half blessing. Take the long way round; the view is better.',
    'Half blessing. Half the umbrella, all of the rain. Laugh about it.'] },
  { id: 'suekichi', kanji: '末吉', rank: 6, weight: 2, buff: 'none', texts: [
    'Future blessing. What you plant today flowers later.',
    'Future blessing. Patience; the lantern is still being painted.'] },
  { id: 'kyo', kanji: '凶', rank: 7, weight: 1, buff: 'none', texts: [
    'Curse. Tie this slip to the shrine tree and leave it behind.',
    'Curse. Not today. The tree will hold it for you.'] },
]);
export const BUFFS = ['glow', 'confetti', 'petals', 'none'];
const TOTAL_WEIGHT = FORTUNES.reduce((s, f) => s + f.weight, 0);

/** Pure: the fortune of `wallet` on Tokyo `date` for a given secret salt. -> {fortune, text} */
export function drawFortune(wallet, date, salt) {
  const h = createHash('sha256').update(`${wallet}|${date}|${salt}`).digest();
  let n = h.readUInt32BE(0) % TOTAL_WEIGHT;
  const fortune = FORTUNES.find((f) => (n -= f.weight) < 0);
  return { fortune, text: fortune.texts[h[4] % fortune.texts.length] };
}

/** The secret salt (settings 'omikuji.salt'), created on first use. Never returned by any route. */
function omikujiSalt(db) {
  let salt = getSetting(db, 'omikuji.salt', null);
  if (typeof salt !== 'string' || salt.length < 32) {
    salt = randomBytes(32).toString('hex');
    setSetting(db, 'omikuji.salt', salt, 'system');
  }
  return salt;
}

const fortuneView = (row, fresh) => {
  const f = FORTUNES.find((x) => x.id === row.fortune);
  return { drawn: true, fresh, date: row.date, fortune: { id: f.id, kanji: f.kanji, rank: f.rank }, text: row.text,
    buff: { kind: row.buff, until: row.until }, drawnAt: row.drawn_at, note: NO_VALUE_NOTE };
};

/** POST /api/omikuji: the day's slip (resident required). A second draw the same Tokyo day returns the same slip. */
export function drawOmikuji(db, wallet, t = now()) {
  requireResident(db, wallet);
  const date = jstDate(t);
  return db.tx(() => {
    const had = db.get('SELECT * FROM fortunes WHERE wallet = ? AND date = ?', wallet, date);
    if (had) return fortuneView(had, false);
    const { fortune, text } = drawFortune(wallet, date, omikujiSalt(db));
    db.run('INSERT INTO fortunes (wallet, date, fortune, text, buff, until, drawn_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      wallet, date, fortune.id, text, fortune.buff, dayStart(t) + TOKYO_DAY, t);
    return fortuneView(db.get('SELECT * FROM fortunes WHERE wallet = ? AND date = ?', wallet, date), true);
  });
}

export function todayOmikuji(db, wallet, t = now()) {
  const date = jstDate(t);
  const row = db.get('SELECT * FROM fortunes WHERE wallet = ? AND date = ?', wallet, date);
  return row ? fortuneView(row, false) : { drawn: false, date, note: NO_VALUE_NOTE };
}

// --- predictions: guess SUB-01's vote on a public idea before the brain answers ------------------------------------------
export const PREDICTION_POINTS = 10;
const OPEN_STAGES = ['submitted', 'evaluating'];

/** The brain's first vote on the idea (the one predictions are about), or undefined. */
const firstVote = (db, ideaId) => db.get(`SELECT l.seq, l.decision, l.at FROM evaluations e JOIN vote_ledger l ON l.request_id = e.brain_request_id
  WHERE e.idea_id = ? ORDER BY l.seq LIMIT 1`, ideaId);

export function predict(db, wallet, body) {
  strictBody(body, ['ideaId', 'guess']);
  const ideaId = validIdeaId(body.ideaId);
  if (!['build', 'pass'].includes(body.guess)) throw new HttpError(400, 'bad_request', "guess: 'build' or 'pass'");
  requireResident(db, wallet);
  return db.tx(() => {
    const idea = db.get('SELECT id, owner_wallet, status, visibility FROM ideas WHERE id = ?', ideaId);
    if (!idea || idea.visibility !== 'public') throw new HttpError(404, 'not_found', 'not found, or private');
    if (idea.owner_wallet === wallet) throw new HttpError(403, 'own_idea', 'you cannot predict the vote on your own idea');
    if (!OPEN_STAGES.includes(idea.status) || firstVote(db, ideaId)) throw new HttpError(409, 'closed', 'SUB-01 has already answered (or the idea left the queue)');
    if (db.get('SELECT 1 FROM predictions WHERE idea_id = ? AND wallet = ?', ideaId, wallet)) throw new HttpError(409, 'already_predicted', 'one guess per idea');
    db.run('INSERT INTO predictions (idea_id, wallet, guess, created_at) VALUES (?, ?, ?, ?)', ideaId, wallet, body.guess, now());
    return predictionView(db, ideaId, wallet);
  });
}

/** Inside the evaluation's transaction, right after the vote is appended to the ledger: score the guesses. */
export function settlePredictions(db, ideaId, decision, t = now()) {
  for (const p of db.all('SELECT wallet, guess FROM predictions WHERE idea_id = ? AND settled_at IS NULL AND created_at <= ?', ideaId, t)) {
    const correct = p.guess === decision;
    db.run('UPDATE predictions SET correct = ?, settled_at = ? WHERE idea_id = ? AND wallet = ?', correct ? 1 : 0, t, ideaId, p.wallet);
    if (correct) db.run('UPDATE residents SET points = points + ? WHERE wallet = ?', PREDICTION_POINTS, p.wallet);
  }
}

/** GET /api/predictions/:ideaId (public ideas only; `mine`/`correct` need a session). */
export function predictionView(db, ideaId, viewerWallet = null) {
  validIdeaId(ideaId);
  const idea = db.get('SELECT status, visibility FROM ideas WHERE id = ?', ideaId);
  if (!idea || idea.visibility !== 'public') throw new HttpError(404, 'not_found', 'not found, or private');
  const vote = firstVote(db, ideaId);
  const c = db.get(`SELECT COUNT(*) total, COALESCE(SUM(guess = 'build'), 0) build, COALESCE(SUM(guess = 'pass'), 0) pass FROM predictions WHERE idea_id = ?`, ideaId);
  const mine = viewerWallet ? db.get('SELECT guess, correct FROM predictions WHERE idea_id = ? AND wallet = ?', ideaId, viewerWallet) : null;
  return { ideaId, closed: Boolean(vote) || !OPEN_STAGES.includes(idea.status), decision: vote ? vote.decision : null,
    total: c.total, build: c.build, pass: c.pass, mine: mine?.guess ?? null, correct: mine && mine.correct != null ? mine.correct === 1 : null };
}

/** GET /api/leaderboard?kind=predictions: top 20 resident names by points (ties: the older resident first). */
export function leaderboard(db, query) {
  const kind = query.get('kind') ?? 'predictions';
  if (kind !== 'predictions') throw new HttpError(400, 'bad_request', "kind: 'predictions'");
  return { kind, top: db.all('SELECT name, points FROM residents WHERE points > 0 ORDER BY points DESC, created_at, name LIMIT 20'),
    note: 'Points only order this list. They have no value and cannot be traded, transferred or redeemed.' };
}

// --- ema: the idea pinned before the vote ------------------------------------------------------------------------------
/** sha256 of JSON [title, concept, version, wallet]: proof that this wallet had this text at pinnedAt. */
export const pinHash = (title, concept, version, wallet) => sha256(JSON.stringify([String(title), String(concept), Number(version), String(wallet)]));
const SHRINE_HIDDEN = ['declined', 'cancelled'];

export function emaList(db, query) {
  const limit = intParam(query, 'limit', 30, 1, 50);
  const rows = db.all(`SELECT i.id, i.pinned_hash, i.pinned_at, i.status, v.title, p.slug, (SELECT COUNT(*) FROM ema_cheers c WHERE c.idea_id = i.id) cheers
    FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version LEFT JOIN projects p ON p.idea_id = i.id
    WHERE i.visibility = 'public' AND i.pinned_hash IS NOT NULL AND i.status NOT IN ('declined', 'cancelled')
    ORDER BY i.pinned_at DESC, i.id LIMIT ?`, limit);
  return { ema: rows.map((x) => ({ ideaId: x.id, pinnedHash: x.pinned_hash, pinnedAt: x.pinned_at, title: x.title, slug: x.slug || null,
    stage: x.status, stageLabel: LABELS[x.status] || x.status, cheers: x.cheers })),
  note: 'Cheers are cosmetic. They do not reach SUB-01\'s brain and do not change the order or the outcome of any vote.' };
}

export function cheerEma(db, wallet, ideaId) {
  validIdeaId(ideaId);
  requireResident(db, wallet);
  return db.tx(() => {
    const idea = db.get('SELECT owner_wallet, status, visibility, pinned_hash FROM ideas WHERE id = ?', ideaId);
    if (!idea || idea.visibility !== 'public' || !idea.pinned_hash || SHRINE_HIDDEN.includes(idea.status)) throw new HttpError(404, 'not_found', 'not on the shrine');
    if (idea.owner_wallet === wallet) throw new HttpError(403, 'own_idea', 'you cannot cheer your own ema');
    if (db.get('SELECT 1 FROM ema_cheers WHERE idea_id = ? AND wallet = ?', ideaId, wallet)) throw new HttpError(409, 'already_cheered', 'one cheer per ema');
    db.run('INSERT INTO ema_cheers (idea_id, wallet, created_at) VALUES (?, ?, ?)', ideaId, wallet, now());
    return { cheers: db.get('SELECT COUNT(*) n FROM ema_cheers WHERE idea_id = ?', ideaId).n };
  });
}

// --- "while you were away" -------------------------------------------------------------------------------------------
export const VISIT_GAP_MS = 30 * 60_000;              // a visit ends after 30 minutes without GET /api/me
export const AWAY_CAP = 20;
export const AWAY_NOTE = 'What happened in your rooms and to your ideas since your last visit. Nothing here needs an action.';

/** GET /api/me: a new visit (first one, or after a 30-minute gap) moves `away_since` to the end of the last visit. */
export function touchSeen(db, wallet, t = now()) {
  const r = db.get('SELECT created_at, last_seen_at FROM residents WHERE wallet = ?', wallet);
  if (!r) return;
  if (r.last_seen_at == null) db.run('UPDATE residents SET away_since = ?, last_seen_at = ? WHERE wallet = ?', r.created_at, t, wallet);
  else if (t - r.last_seen_at > VISIT_GAP_MS) db.run('UPDATE residents SET away_since = last_seen_at, last_seen_at = ? WHERE wallet = ?', t, wallet);
  else db.run('UPDATE residents SET last_seen_at = ? WHERE wallet = ?', t, wallet);
}

/** GET /api/rooms/:plotId by a signed-in visitor (not the owner): one row per visitor, plot and Tokyo day. */
export function recordVisit(db, wallet, plotId, ownerWallet, t = now()) {
  if (!wallet || wallet === ownerWallet) return;
  db.run('INSERT INTO room_visits (plot_id, wallet, day, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', plotId, wallet, jstDate(t), t);
}

export function awayView(db, wallet) {
  const r = requireResident(db, wallet);
  const since = r.away_since ?? r.created_at;
  // the wallet's plots as they are claimed now; anything from before a claim belongs to the previous tenant
  const visits = db.all(`SELECT COALESCE(rs.name, 'Visitor') name, MAX(x.at) at FROM (
        SELECT rv.wallet, rv.at FROM room_visits rv JOIN plots pl ON pl.plot_id = rv.plot_id WHERE pl.wallet = ? AND rv.at >= pl.claimed_at AND rv.at > ?
        UNION ALL
        SELECT g.wallet, g.created_at at FROM guestbook g JOIN plots pl ON pl.plot_id = g.plot_id WHERE pl.wallet = ? AND g.created_at >= pl.claimed_at AND g.created_at > ?
      ) x LEFT JOIN residents rs ON rs.wallet = x.wallet WHERE x.wallet != ? GROUP BY x.wallet ORDER BY at DESC LIMIT ?`,
  wallet, since, wallet, since, wallet, AWAY_CAP);
  const guestbook = db.all(`SELECT COALESCE(rs.name, 'Visitor') name, g.text, g.created_at at FROM guestbook g JOIN plots pl ON pl.plot_id = g.plot_id
      LEFT JOIN residents rs ON rs.wallet = g.wallet WHERE pl.wallet = ? AND g.created_at >= pl.claimed_at AND g.created_at > ? AND g.wallet != ?
      ORDER BY g.id DESC LIMIT ?`, wallet, since, wallet, AWAY_CAP);
  const project = db.all(`SELECT i.id ideaId, p.slug, json_extract(e.data_json, '$.from') "from", json_extract(e.data_json, '$.to') "to", e.at
      FROM events e JOIN ideas i ON i.id = e.idea_id LEFT JOIN projects p ON p.idea_id = i.id
      WHERE i.owner_wallet = ? AND e.kind = 'status' AND e.at > ? AND json_extract(e.data_json, '$.to') IS NOT NULL
      ORDER BY e.id DESC LIMIT ?`, wallet, since, AWAY_CAP).map((x) => ({ ideaId: x.ideaId, slug: x.slug || null, from: x.from, to: x.to, at: x.at }));
  return { since, visits, guestbook, project, note: AWAY_NOTE };
}
