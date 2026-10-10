// Daily rituals: omikuji, build-or-pass predictions, "while you were away", ema, SUB-01's diary and share postcards.
// Legal line under test: nothing awarded has value (cosmetic buffs, leaderboard points), no wallet in public output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, user, drain, IDEA, ideaStatus } from './helpers.js';
import { drawFortune, FORTUNES, pinHash, drawOmikuji, touchSeen, VISIT_GAP_MS, PREDICTION_POINTS } from '../src/rituals.js';
import { diaryFor, latestDiary, DIARY_NOTE, lastCompletedDay } from '../src/diary.js';
import { jstDate } from '../src/calendar.js';
import { postcardPng, postcardSvg } from '../src/postcard.js';

const DAY = 86_400_000;
const LOOK = { skin: '#c98e66', hair: '#1b1b1b', hairStyle: 'bun', top: '#ff6600', bottom: '#222222', outfit: 'hoodie' };
const PASS_IDEA = (w, extra = {}) => IDEA(w, { title: 'Sock Exchange', concept: 'A coin for swapping lost single socks between neighbours in Osaka, with a weekly sock swap meet.',
  nameSuggestion: 'Sock Exchange', tickerSuggestion: 'SOCK', ...extra });

async function resident(h, name, plotId) {
  const c = h.client(user(h.db));
  await c.signIn();
  const r = await c.call('POST', '/api/residents', { name, look: LOOK, plotId });
  assert.equal(r.status, 200, r.text);
  return c;
}
const noWallets = (text, ...clients) => { for (const c of clients) assert.ok(!text.includes(c.w.address), 'a wallet leaked'); };
/** No price or market number: the strings a price would need. Data URIs (base64) are dropped first. */
const PRICE = /price|market ?cap|mcap|\bsol\b|\busd\b|\$\s?\d|volume|liquidity/i;
const noPrice = (s) => assert.ok(!PRICE.test(String(s).replace(/data:[^"]+/g, '')), `price-like text: ${String(s).replace(/data:[^"]+/g, '').match(PRICE)?.[0]}`);

test('omikuji: deterministic per wallet, date and salt; all 7 fortunes reachable; buffs cosmetic', () => {
  const a = drawFortune('walletA', '2026-10-10', 'salt');
  assert.deepEqual(drawFortune('walletA', '2026-10-10', 'salt'), a);
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(drawFortune(`w${i}`, '2026-10-10', 'salt').fortune.id);
  assert.deepEqual([...seen].sort(), FORTUNES.map((f) => f.id).sort());
  assert.notDeepEqual([0, 1, 2, 3, 4, 5].map((d) => drawFortune('walletA', `2026-10-1${d}`, 'salt').text),
    [0, 1, 2, 3, 4, 5].map(() => a.text), 'another day, another slip');
  assert.notDeepEqual(Array.from({ length: 20 }, (_, i) => drawFortune(`w${i}`, '2026-10-10', 'other salt').fortune.id),
    Array.from({ length: 20 }, (_, i) => drawFortune(`w${i}`, '2026-10-10', 'salt').fortune.id), 'the salt matters');
  assert.deepEqual(FORTUNES.map((f) => f.kanji), ['大吉', '吉', '中吉', '小吉', '半吉', '末吉', '凶']);
  for (const f of FORTUNES) {
    assert.ok(['glow', 'confetti', 'petals', 'none'].includes(f.buff));
    for (const t of f.texts) noPrice(t);
  }
});

test('POST /api/omikuji: resident only, one draw per Tokyo day, same slip again, buff kind on /api/world, nothing of value', async () => {
  const h = await harness();
  try {
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('POST', '/api/omikuji')).status, 401);
    const a = await resident(h, 'Kenji', 'ebisu-1');
    const bare = h.client(user(h.db));
    await bare.signIn();
    assert.equal((await bare.call('POST', '/api/omikuji')).json.error, 'no_resident');
    assert.deepEqual(Object.keys((await a.call('GET', '/api/omikuji/today')).json), ['drawn', 'date', 'note']);

    const first = await a.call('POST', '/api/omikuji');
    assert.equal(first.status, 200);
    const j = first.json;
    assert.deepEqual(Object.keys(j), ['drawn', 'fresh', 'date', 'fortune', 'text', 'buff', 'drawnAt', 'note']);
    assert.equal(j.fresh, true);
    assert.equal(j.date, jstDate(Date.now()));
    const salt = JSON.parse(h.db.get(`SELECT value_json FROM settings WHERE key = 'omikuji.salt'`).value_json);
    const expect = drawFortune(a.w.address, j.date, salt);
    assert.deepEqual([j.fortune.id, j.text], [expect.fortune.id, expect.text], 'sha256(wallet, Tokyo date, secret salt)');
    assert.equal(j.buff.kind, expect.fortune.buff);
    assert.equal(j.buff.until, Date.parse(`${j.date}T00:00:00Z`) - 9 * 3_600_000 + DAY, 'until midnight JST');
    assert.match(j.note, /no value/);
    noPrice(first.text);

    const again = await a.call('POST', '/api/omikuji');
    assert.deepEqual({ ...again.json, fresh: true }, j, 'the same slip');
    assert.equal(again.json.fresh, false);
    assert.deepEqual((await a.call('GET', '/api/omikuji/today')).json, { ...j, fresh: false });
    assert.equal(h.db.get('SELECT COUNT(*) n FROM fortunes').n, 1);
    // tomorrow (Tokyo) is a new draw; points never move
    const next = drawOmikuji(h.db, a.w.address, Date.now() + DAY);
    assert.equal(next.fresh, true);
    assert.equal(next.date, jstDate(Date.now() + DAY));
    assert.equal(h.db.get('SELECT points FROM residents WHERE wallet = ?', a.w.address).points, 0);

    // /api/world shows the buff kind only (never the fortune, text or wallet); 'none' and expired show null
    h.db.run(`UPDATE fortunes SET buff = 'glow' WHERE wallet = ? AND date = ?`, a.w.address, j.date);
    let w = await anon.call('GET', '/api/world');
    assert.equal(w.json.plots.find((p) => p.plotId === 'ebisu-1').resident.buff, 'glow');
    assert.ok(!w.text.includes(j.text) && !w.text.includes(salt));
    noWallets(w.text, a);
    h.db.run(`UPDATE fortunes SET buff = 'none' WHERE wallet = ? AND date = ?`, a.w.address, j.date);
    await a.call('POST', '/api/omikuji');                              // a write busts the 3 s world cache
    w = await anon.call('GET', '/api/world');
    assert.equal(w.json.plots.find((p) => p.plotId === 'ebisu-1').resident.buff, null);
    for (const r of [first, again]) assert.ok(!r.text.includes(salt), 'the salt is never returned');
  } finally { h.close(); }
});

test('predictions: public ideas in the queue only, one guess each, closed by the ledger row, +10 per correct guess, names only', async () => {
  const h = await harness();
  try {
    const author = await resident(h, 'Author', 'shiba-1');
    const yui = await resident(h, 'Yui', 'shiba-2');
    const ken = await resident(h, 'Ken', 'shiba-3');
    const id = (await author.call('POST', '/api/ideas', IDEA(author.w))).json.id;
    // private: not predictable, not visible
    assert.equal((await yui.call('POST', '/api/predictions', { ideaId: id, guess: 'build' })).status, 404);
    assert.equal((await yui.call('GET', `/api/predictions/${id}`)).status, 404);
    await author.call('POST', `/api/ideas/${id}/publish`, { public: true });   // the author publishes before the vote
    const bad = [{ ideaId: id }, { ideaId: id, guess: 'maybe' }, { ideaId: id, guess: 'build', extra: 1 }, { ideaId: 'nope', guess: 'build' }, []];
    for (const b of bad) assert.equal((await yui.call('POST', '/api/predictions', b)).status, 400, JSON.stringify(b));
    assert.equal((await author.call('POST', '/api/predictions', { ideaId: id, guess: 'build' })).json.error, 'own_idea');
    const bare = h.client(user(h.db));
    await bare.signIn();
    assert.equal((await bare.call('POST', '/api/predictions', { ideaId: id, guess: 'build' })).json.error, 'no_resident');

    const y = await yui.call('POST', '/api/predictions', { ideaId: id, guess: 'build' });
    assert.deepEqual(y.json, { ideaId: id, closed: false, decision: null, total: 1, build: 1, pass: 0, mine: 'build', correct: null });
    assert.equal((await yui.call('POST', '/api/predictions', { ideaId: id, guess: 'pass' })).json.error, 'already_predicted');
    await ken.call('POST', '/api/predictions', { ideaId: id, guess: 'pass' });
    const anon = h.client(user(h.db));
    assert.deepEqual((await anon.call('GET', `/api/predictions/${id}`)).json, { ideaId: id, closed: false, decision: null, total: 2, build: 1, pass: 1, mine: null, correct: null });

    await drain(h.db, h.cfg, h.brain.fetchImpl);                       // the brain answers: build
    assert.equal(ideaStatus(h.db, id).status, 'preview_ready');
    assert.deepEqual((await yui.call('GET', `/api/predictions/${id}`)).json, { ideaId: id, closed: true, decision: 'build', total: 2, build: 1, pass: 1, mine: 'build', correct: true });
    assert.equal((await ken.call('GET', `/api/predictions/${id}`)).json.correct, false);
    assert.equal((await ken.call('POST', '/api/predictions', { ideaId: id, guess: 'build' })).json.error, 'closed');
    assert.equal((await yui.call('GET', '/api/me')).json.resident.points, PREDICTION_POINTS);
    assert.equal((await ken.call('GET', '/api/me')).json.resident.points, 0);
    // settled once: another drain or a replay adds nothing
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const lb = await anon.call('GET', '/api/leaderboard?kind=predictions');
    assert.deepEqual(lb.json.top, [{ name: 'Yui', points: 10 }], 'names and points only; zero points are not listed');
    assert.match(lb.json.note, /no value/);
    assert.equal((await anon.call('GET', '/api/leaderboard?kind=money')).status, 400);
    noWallets(lb.text, yui, ken, author);

    // a pass: the pass-guesser scores
    const p = (await author.call('POST', '/api/ideas', PASS_IDEA(author.w))).json.id;
    await author.call('POST', `/api/ideas/${p}/publish`, { public: true });
    await ken.call('POST', '/api/predictions', { ideaId: p, guess: 'pass' });
    h.brain.state.mode = 'pass';
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, p).status, 'declined');
    assert.equal((await ken.call('GET', `/api/predictions/${p}`)).json.decision, 'pass');
    assert.deepEqual((await anon.call('GET', '/api/leaderboard')).json.top.map((x) => x.name).sort(), ['Ken', 'Yui']);
    // made private later: gone
    const q = (await author.call('POST', '/api/ideas', IDEA(author.w, { title: 'Quiet one', concept: 'A coin about the quietest train carriage on the Yamanote line, mapped by riders.' }))).json.id;
    assert.equal((await anon.call('GET', `/api/predictions/${q}`)).status, 404);
  } finally { h.close(); }
});

test('while you were away: since the last visit, room visitors (one per day), guestbook, project transitions; names only', async () => {
  const h = await harness();
  try {
    const kenji = await resident(h, 'Kenji', 'ebisu-1');
    const yui = await resident(h, 'Yui', 'ebisu-2');
    assert.equal((await h.client(user(h.db)).call('GET', '/api/away')).status, 401);
    await kenji.call('GET', '/api/me');                                // first visit: since = when the resident was created
    const created = h.db.get('SELECT created_at, away_since FROM residents WHERE wallet = ?', kenji.w.address);
    assert.equal(created.away_since, created.created_at);
    await kenji.call('GET', '/api/rooms/ebisu-1');                     // the owner's own visit is not a visit
    await yui.call('GET', '/api/rooms/ebisu-1');
    await yui.call('GET', '/api/rooms/ebisu-1');                       // same Tokyo day: one row
    assert.equal(h.db.get('SELECT COUNT(*) n FROM room_visits').n, 1);
    await yui.call('POST', '/api/rooms/ebisu-1/guestbook', { text: 'nice room 🍜' });
    const id = (await kenji.call('POST', '/api/ideas', IDEA(kenji.w))).json.id;
    await drain(h.db, h.cfg, h.brain.fetchImpl);

    const r = await kenji.call('GET', '/api/away');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['since', 'visits', 'guestbook', 'project', 'note']);
    assert.equal(r.json.since, created.created_at);
    assert.deepEqual(r.json.visits.map((v) => [v.name, Object.keys(v).join()]), [['Yui', 'name,at']]);
    assert.deepEqual(r.json.guestbook.map((g) => [g.name, g.text]), [['Yui', 'nice room 🍜']]);
    assert.deepEqual(r.json.project.map((p) => [p.from, p.to]).reverse(),
      [['submitted', 'evaluating'], ['evaluating', 'selected'], ['selected', 'generating'], ['generating', 'preview_ready']]);
    assert.equal(r.json.project[0].ideaId, id);
    assert.ok(r.json.project[0].slug);
    assert.doesNotMatch(r.json.note, /miss|come back|don't|hurry|!/i, 'neutral, no nagging');
    noWallets(r.text, kenji, yui);

    // a new visit after a 30-minute gap: since = the end of the last visit; what came before drops out
    await kenji.call('GET', '/api/me');
    const last = h.db.get('SELECT last_seen_at t FROM residents WHERE wallet = ?', kenji.w.address).t;
    touchSeen(h.db, kenji.w.address, last + VISIT_GAP_MS + 1000);
    const a2 = (await kenji.call('GET', '/api/away')).json;
    assert.equal(a2.since, last);
    assert.deepEqual([a2.visits, a2.guestbook, a2.project], [[], [], []]);
    // within the same visit, since does not move
    touchSeen(h.db, kenji.w.address, last + VISIT_GAP_MS + 60_000);
    assert.equal((await kenji.call('GET', '/api/away')).json.since, last);
    const bare = h.client(user(h.db));
    await bare.signIn();
    assert.equal((await bare.call('GET', '/api/away')).json.error, 'no_resident');
  } finally { h.close(); }
});

test('ema: pinned hash at submission, on the idea and project JSON, public shrine, one cheer each, cheers never reach the brain', async () => {
  const h = await harness();
  try {
    const author = await resident(h, 'Author', 'shiba-1');
    const yui = await resident(h, 'Yui', 'shiba-2');
    const before = Date.now();
    const sub = await author.call('POST', '/api/ideas', IDEA(author.w, { plotId: 'shiba-3' }));
    assert.deepEqual(Object.keys(sub.json), ['id', 'pinnedHash', 'pinnedAt']);
    const { id, pinnedHash, pinnedAt } = sub.json;
    assert.equal(pinnedHash, pinHash(IDEA(author.w).title, IDEA(author.w).concept, 1, author.w.address));
    assert.ok(pinnedAt >= before && pinnedAt <= Date.now());
    const anon = h.client(user(h.db));
    assert.deepEqual((await anon.call('GET', '/api/ema')).json.ema, [], 'private ideas are not on the shrine');
    assert.equal((await yui.call('POST', `/api/ema/${id}/cheer`)).status, 404);
    await author.call('POST', `/api/ideas/${id}/publish`, { public: true });

    const e = await anon.call('GET', '/api/ema?limit=30');
    assert.deepEqual(e.json.ema, [{ ideaId: id, pinnedHash, pinnedAt, title: 'Ramen Radar', slug: null, stage: 'submitted', stageLabel: 'Dropped in his room', cheers: 0 }]);
    assert.match(e.json.note, /do not reach SUB-01's brain/);
    for (const q of ['limit=0', 'limit=51', 'limit=x']) assert.equal((await anon.call('GET', `/api/ema?${q}`)).status, 400, q);
    noWallets(e.text, author, yui);

    assert.equal((await author.call('POST', `/api/ema/${id}/cheer`)).json.error, 'own_idea');
    assert.deepEqual((await yui.call('POST', `/api/ema/${id}/cheer`)).json, { cheers: 1 });
    assert.equal((await yui.call('POST', `/api/ema/${id}/cheer`)).json.error, 'already_cheered');
    assert.equal((await anon.call('GET', '/api/ema')).json.ema[0].cheers, 1);

    // the brain is asked about the idea only: no cheers, no predictions in the request
    const asked = [];
    const spy = async (url, init) => { asked.push(JSON.parse(init.body)); return h.brain.fetchImpl(url, init); };
    await drain(h.db, h.cfg, spy);
    assert.equal(asked.length, 1);
    assert.deepEqual(Object.keys(asked[0]).sort(), ['concept', 'request_id', 'title']);
    assert.ok(!JSON.stringify(asked[0]).match(/cheer|ema|predict/i));
    for (const f of ['src/pipeline.js', 'src/brain.js', 'src/scorecard.js']) assert.ok(!readFileSync(f, 'utf8').includes('ema_cheers'), f);

    const idea = (await anon.call('GET', `/api/ideas/${id}`)).json;
    const seq = h.db.get('SELECT seq FROM vote_ledger').seq;
    assert.deepEqual([idea.pinnedHash, idea.pinnedAt, idea.ledgerSeq], [pinnedHash, pinnedAt, seq]);
    const slug = h.db.get('SELECT slug FROM projects WHERE idea_id = ?', id).slug;
    const p = (await anon.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([p.pinnedHash, p.pinnedAt, p.ledgerSeq], [pinnedHash, pinnedAt, seq]);
    assert.equal((await anon.call('GET', '/api/ema')).json.ema[0].slug, slug);

    // a passed idea leaves the shrine; its ledger seq stays off its public page
    const passed = (await author.call('POST', '/api/ideas', PASS_IDEA(author.w))).json.id;
    await author.call('POST', `/api/ideas/${passed}/publish`, { public: true });
    h.brain.state.mode = 'pass';
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.deepEqual((await anon.call('GET', '/api/ema')).json.ema.map((x) => x.ideaId), [id]);
    assert.equal((await anon.call('GET', `/api/ideas/${passed}`)).json.ledgerSeq, null);
    assert.equal(typeof (await author.call('GET', `/api/ideas/${passed}`)).json.ledgerSeq, 'number', 'the author sees it');
  } finally { h.close(); }
});

test('diary: template text from the ledger and build log, exact numbers, private and passed ideas by hash only, cached per finished day', async () => {
  const h = await harness();
  try {
    const author = await resident(h, 'Author', 'shiba-1');
    const build = (await author.call('POST', '/api/ideas', IDEA(author.w))).json.id;
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    h.brain.state.mode = 'pass';
    const pass = (await author.call('POST', '/api/ideas', PASS_IDEA(author.w))).json.id;
    await author.call('POST', `/api/ideas/${pass}/publish`, { public: true });      // public, but passed: still hash only
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const [l1, l2] = h.db.all('SELECT seq, idea_hash FROM vote_ledger ORDER BY seq');
    const today = jstDate(Date.now());
    const anon = h.client(user(h.db));

    let d = await anon.call('GET', `/api/diary?date=${today}`);
    assert.equal(d.status, 200);
    assert.deepEqual(Object.keys(d.json), ['date', 'entries', 'counts', 'note']);
    assert.equal(d.json.note, DIARY_NOTE);
    assert.equal(d.json.note, 'SUB-01 is a model, not a conscious being. This page is generated from the vote ledger and the build log; numbers are copied exactly.');
    assert.deepEqual(d.json.entries.map((e) => e.kind), ['moved_in', 'built', 'passed']);
    const [moved, built, passed] = d.json.entries;
    assert.deepEqual(moved, { kind: 'moved_in', at: moved.at, text: 'Author moved into Shiba.', slug: null, ticker: null, ledgerSeq: null, score: null });
    assert.deepEqual(built, { kind: 'built', at: built.at, text: `I said build to a private idea (${l1.idea_hash.slice(0, 8)}). The build network lit at 0.8.`,
      slug: null, ticker: null, ledgerSeq: l1.seq, score: 0.8 });
    assert.deepEqual(passed, { kind: 'passed', at: passed.at, text: `I passed on an idea (${l2.idea_hash.slice(0, 8)}): build 0.2, keep going 0.8.`,
      slug: null, ticker: null, ledgerSeq: l2.seq, score: 0.2 });
    assert.deepEqual(d.json.counts, { built: 1, passed: 1, launched: 0, residents: 1 });
    for (const leak of ['Ramen Radar', 'RAMEN', 'Sock Exchange', 'SOCK', build, pass, author.w.address]) assert.ok(!d.text.includes(leak), `leaked ${leak}`);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM diary_days').n, 0, 'today is not finished: not cached');

    // published: the built idea is named, with its ticker, and its site going live is in the log
    await author.call('POST', `/api/ideas/${build}/publish`, { public: true });
    const slug = h.db.get('SELECT slug, name, ticker FROM projects WHERE idea_id = ?', build);
    d = await anon.call('GET', `/api/diary?date=${today}`);
    const named = d.json.entries.find((e) => e.kind === 'built');
    assert.equal(named.text, `I built ${slug.name} ($${slug.ticker}). The build network lit at 0.8.`);
    assert.deepEqual([named.slug, named.ticker, named.ledgerSeq], [slug.slug, slug.ticker, l1.seq]);
    const live = d.json.entries.find((e) => e.kind === 'site_live');
    assert.deepEqual([live.slug, live.ledgerSeq, live.score], [slug.slug, l1.seq, 0.8]);
    assert.ok(!d.text.includes('Sock Exchange') && !d.text.includes('SOCK'), 'a passed idea is never named');

    // a finished day is cached; making the idea private again regenerates the page without its name
    const later = Date.now() + 2 * DAY;
    const cached = diaryFor(h.db, h.cfg, today, later);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM diary_days WHERE date = ?', today).n, 1);
    assert.deepEqual(diaryFor(h.db, h.cfg, today, later), cached);
    assert.deepEqual(latestDiary(h.db, h.cfg, later), cached, 'latest: the most recent finished day with a page');
    await author.call('POST', `/api/ideas/${build}/publish`, { public: false });
    const again = diaryFor(h.db, h.cfg, today, later);
    assert.ok(!JSON.stringify(again).includes(slug.name) && !again.entries.some((e) => e.kind === 'site_live'));
    assert.equal(again.entries.find((e) => e.kind === 'built').text, `I said build to a private idea (${l1.idea_hash.slice(0, 8)}). The build network lit at 0.8.`);

    // default and latest; strict dates
    assert.equal((await anon.call('GET', '/api/diary')).json.date, lastCompletedDay());
    assert.equal((await anon.call('GET', '/api/diary/latest')).status, 200);
    for (const q of ['date=2026-13-01', 'date=2026-02-30', 'date=x', `date=${jstDate(Date.now() + 2 * DAY)}`, 'date=1999-01-01', 'day=2026-10-10']) {
      assert.equal((await anon.call('GET', `/api/diary?${q}`)).status, 400, q);
    }
  } finally { h.close(); }
});

/** Tag balance of our own SVG (no CDATA; comments dropped): every element closed, one root. */
function wellFormed(svg) {
  const s = svg.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let roots = 0;
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else if (!m[4]) { if (!stack.length) roots++; stack.push(m[2]); } else if (!stack.length) roots++;
  }
  const stray = s.replace(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g, '').match(/[<>]/);
  return stack.length === 0 && roots === 1 && !stray;
}

test('postcards: SVG and PNG 1200×630 for public projects and lived-in apartments, never a price, 5-minute cache; share pages', async () => {
  const h = await harness();
  try {
    const author = await resident(h, 'Kenji', 'ebisu-1');
    const id = (await author.call('POST', '/api/ideas', IDEA(author.w, { plotId: 'ebisu-2' }))).json.id;
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const p = h.db.get('SELECT slug, name, ticker FROM projects WHERE idea_id = ?', id);
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('GET', `/api/postcard/${p.slug}.svg`)).status, 404, 'private');
    assert.equal((await anon.call('GET', `/p/${p.slug}`)).status, 404);
    await author.call('POST', `/api/ideas/${id}/publish`, { public: true });

    const svg = await anon.call('GET', `/api/postcard/${p.slug}.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(svg.headers.get('cache-control'), 'public, max-age=300');
    assert.match(svg.headers.get('content-security-policy'), /sandbox/);
    assert.ok(svg.text.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">'));
    assert.ok(wellFormed(svg.text), 'well-formed SVG');
    for (const s of [p.name, `$${p.ticker}`, 'Preview ready for your review', '建', 'data:image/png;base64,', 'TOKYO', jstDate(Date.now()).replaceAll('-', '.')]) assert.ok(svg.text.includes(s), s);
    assert.ok(svg.text.includes('<svg x="72" y="462" width="340" height="88" viewBox="0 0 861 224">'), 'the brand lockup, inline');
    noPrice(svg.text);
    noWallets(svg.text, author);

    const png = await anon.call('GET', `/api/postcard/${p.slug}.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await (await fetch(`${h.base}/api/postcard/${p.slug}.png`)).arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [1200, 630]);

    const room = await anon.call('GET', '/api/postcard/room/ebisu-1.svg');
    assert.equal(room.status, 200);
    assert.ok(wellFormed(room.text) && room.text.includes('Kenji') && room.text.includes('Lives in Ebisu') && room.text.includes('住'));
    noPrice(room.text);
    noWallets(room.text, author);
    assert.equal((await anon.call('GET', '/api/postcard/room/ebisu-1.png')).headers.get('content-type'), 'image/png');
    for (const path of ['/api/postcard/room/ebisu-2.svg', '/api/postcard/room/ebisu-3.svg', '/api/postcard/room/nowhere-1.svg', '/api/postcard/nope.svg',
      `/api/postcard/${p.slug}.gif`, `/api/postcard/${p.slug}`]) assert.equal((await anon.call('GET', path)).status, 404, path);

    // a launched card says so, and still carries no market number (the card has no field for one)
    const card = { kind: 'project', slug: 's', name: 'Moon <b>&', ticker: 'MOON', stage: 'launched', stageLabel: 'Launched', networks: {}, logo: null, date: '2026-10-10',
      price: 123.45, marketCap: 99999 };
    const s2 = postcardSvg(card);
    assert.ok(wellFormed(s2) && s2.includes('Moon &lt;b&gt;&amp;') && s2.includes('発'));
    assert.ok(!s2.includes('123.45') && !s2.includes('99999'));
    noPrice(s2);
    assert.ok(postcardPng(card).length > 1000);

    // share pages: Open Graph tags with the PNG, a redirect into the city
    const share = await anon.call('GET', `/p/${p.slug}`);
    assert.equal(share.status, 200);
    assert.match(share.headers.get('content-type'), /^text\/html/);
    assert.ok(share.text.includes(`<meta property="og:image" content="${h.cfg.publicOrigin}/api/postcard/${p.slug}.png">`));
    assert.ok(share.text.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(share.text.includes('<meta http-equiv="refresh" content="0; url=/?focus=ebisu-2">'));
    noPrice(share.text);
    const r = await anon.call('GET', '/r/ebisu-1');
    assert.ok(r.text.includes(`content="${h.cfg.publicOrigin}/api/postcard/room/ebisu-1.png"`) && r.text.includes('url=/?focus=ebisu-1'));
    assert.equal((await anon.call('GET', '/r/ebisu-3')).status, 404);
    assert.equal((await anon.call('GET', '/r/bad')).status, 404);
    noWallets(share.text + r.text, author);
  } finally { h.close(); }
});
