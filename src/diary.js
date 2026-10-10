// SUB-01's nightly diary (nippō): one page per Tokyo day, written from the vote ledger and the build log with fixed
// templates (no language model). Numbers are copied from the ledger exactly. A private idea, or one SUB-01 passed on,
// is named by the first 8 characters of its ledger ideaHash, never by its title. A finished day is cached in
// diary_days; the cache is re-checked on every read so an idea made private later is not named from the cache.
import { jstDate, dayStart, dateStart, TOKYO_DAY } from './calendar.js';
import { now, parseJson, HttpError } from './util.js';

export const DIARY_NOTE = 'SUB-01 is a model, not a conscious being. This page is generated from the vote ledger and the build log; numbers are copied exactly.';
const KIND_ORDER = ['built', 'passed', 'site_live', 'launched', 'moved_in'];

export const TEMPLATES = Object.freeze({
  built: ({ name, ticker, score }) => `I built ${name}${ticker ? ` ($${ticker})` : ''}.${score != null ? ` The build network lit at ${score}.` : ''}`,
  builtPrivate: ({ hash, score }) => `I said build to a private idea (${hash}).${score != null ? ` The build network lit at ${score}.` : ''}`,
  passed: ({ hash, score, keep }) => `I passed on an idea (${hash})${score != null ? `: build ${score}, keep going ${keep}` : ''}.`,
  site_live: ({ name, ticker }) => `I finished the site of ${name}${ticker ? ` ($${ticker})` : ''}. Its author reviews it before anything goes out.`,
  launched: ({ name, ticker }) => `${name}${ticker ? ` ($${ticker})` : ''} launched. Its author signed the transaction.`,
  moved_in: ({ name, district }) => `${name} moved into ${district}.`,
});

/** The build and pass probabilities of a ledger vote, as stored (null when absent). */
function probabilities(voteJson) {
  const opts = parseJson(voteJson)?.options || [];
  const p = (a) => { const o = opts.find((x) => x.action === a); return typeof o?.p === 'number' ? o.p : null; };
  const build = p('build');
  const pass = p('pass') ?? (build == null ? null : Number((1 - build).toFixed(6)));
  return { build, pass };
}
const districtName = (plotId) => { const d = String(plotId || '').replace(/-\d+$/, ''); return d ? d[0].toUpperCase() + d.slice(1) : 'the city'; };
const shownIdea = (x) => x.visibility === 'public' && x.status !== 'declined';

/** The entries of one Tokyo day [from, to) and the ids of the ideas they name. */
function buildDay(db, cfg, from, to) {
  const entries = [], named = new Set();
  const entry = (kind, at, text, extra = {}) => entries.push({ kind, at, text, slug: extra.slug ?? null, ticker: extra.ticker ?? null,
    ledgerSeq: extra.ledgerSeq ?? null, score: extra.score ?? null });

  // 1. the brain's votes (every ledger row of the day)
  for (const x of db.all(`SELECT l.seq, l.at, l.idea_hash, l.decision, l.vote_json, i.id idea_id, i.visibility, i.status,
        COALESCE(p.name, v.title) name, COALESCE(p.ticker, v.ticker_suggestion) ticker, p.slug
      FROM vote_ledger l LEFT JOIN evaluations e ON e.brain_request_id = l.request_id LEFT JOIN ideas i ON i.id = e.idea_id
      LEFT JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version LEFT JOIN projects p ON p.idea_id = i.id
      WHERE l.at >= ? AND l.at < ? ORDER BY l.seq`, from, to)) {
    const { build, pass } = probabilities(x.vote_json);
    const hash = x.idea_hash.slice(0, 8);
    if (x.decision === 'pass') entry('passed', x.at, TEMPLATES.passed({ hash, score: build, keep: pass }), { ledgerSeq: x.seq, score: build });
    else if (shownIdea(x)) {
      named.add(x.idea_id);
      entry('built', x.at, TEMPLATES.built({ name: x.name, ticker: x.ticker, score: build }), { slug: x.slug, ticker: x.ticker, ledgerSeq: x.seq, score: build });
    } else entry('built', x.at, TEMPLATES.builtPrivate({ hash, score: build }), { ledgerSeq: x.seq, score: build });
  }

  // 2. the build log: the first time a public idea's site was built and the first time it launched
  const hideMock = cfg.production ? `AND NOT (json_extract(e.data_json, '$.to') = 'launched' AND l.provider = 'mock')` : '';
  for (const x of db.all(`SELECT e.at, json_extract(e.data_json, '$.to') st, i.id idea_id, i.visibility, i.status,
        COALESCE(p.name, v.title) name, COALESCE(p.ticker, v.ticker_suggestion) ticker, p.slug
      FROM events e JOIN ideas i ON i.id = e.idea_id JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
      LEFT JOIN projects p ON p.idea_id = i.id LEFT JOIN launches l ON l.project_id = p.id
      WHERE e.kind = 'status' AND e.at >= ? AND e.at < ? AND i.visibility = 'public' AND i.status != 'declined'
        AND json_extract(e.data_json, '$.to') IN ('preview_ready', 'launched') ${hideMock}
        AND NOT EXISTS (SELECT 1 FROM events o WHERE o.idea_id = e.idea_id AND o.kind = 'status' AND o.id < e.id
          AND json_extract(o.data_json, '$.to') = json_extract(e.data_json, '$.to'))
      ORDER BY e.id`, from, to)) {
    const vote = db.get(`SELECT l.seq, l.vote_json FROM evaluations e JOIN vote_ledger l ON l.request_id = e.brain_request_id
      WHERE e.idea_id = ? AND l.decision = 'build' ORDER BY l.seq LIMIT 1`, x.idea_id);
    const kind = x.st === 'launched' ? 'launched' : 'site_live';
    named.add(x.idea_id);
    entry(kind, x.at, TEMPLATES[kind]({ name: x.name, ticker: x.ticker }), { slug: x.slug, ticker: x.ticker, ledgerSeq: vote?.seq ?? null,
      score: vote ? probabilities(vote.vote_json).build : null });
  }

  // 3. new residents (a first move-in, not a move between plots); the name is the resident's name now
  for (const x of db.all(`SELECT e.at, json_extract(e.data_json, '$.to') plot, r.name FROM events e JOIN residents r ON e.actor = 'wallet:' || r.wallet
      WHERE e.kind = 'resident' AND e.at >= ? AND e.at < ? AND json_extract(e.data_json, '$.from') IS NULL ORDER BY e.id`, from, to)) {
    entry('moved_in', x.at, TEMPLATES.moved_in({ name: x.name, district: districtName(x.plot) }));
  }

  entries.sort((a, b) => a.at - b.at || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const n = (k) => entries.filter((e) => e.kind === k).length;
  return { entries, counts: { built: n('built'), passed: n('passed'), launched: n('launched'), residents: n('moved_in') }, named: [...named] };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The last completed Tokyo day before t. */
export const lastCompletedDay = (t = now()) => jstDate(dayStart(t) - 1);

/** GET /api/diary?date=YYYY-MM-DD (Tokyo; default the last completed day). Today is allowed (partial, not cached). */
export function diaryFor(db, cfg, date, t = now()) {
  const d = date ?? lastCompletedDay(t);
  const parsed = typeof d === 'string' && DATE.test(d) ? new Date(`${d}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d || d < '2020-01-01') {
    throw new HttpError(400, 'bad_request', 'date: a Tokyo date YYYY-MM-DD');
  }
  if (d > jstDate(t)) throw new HttpError(400, 'bad_request', 'that Tokyo day has not started yet');
  const from = dateStart(d), to = from + TOKYO_DAY;
  const finished = to <= t;
  if (finished) {
    const c = db.get('SELECT body_json, ideas_json FROM diary_days WHERE date = ?', d);
    const ids = c ? parseJson(c.ideas_json, []) : null;
    const stillShown = ids && (ids.length === 0 || db.get(`SELECT COUNT(*) n FROM ideas WHERE visibility = 'public' AND status != 'declined'
      AND id IN (${ids.map(() => '?').join(',')})`, ...ids).n === ids.length);
    if (stillShown) return parseJson(c.body_json);
  }
  const day = buildDay(db, cfg, from, to);
  const body = { date: d, entries: day.entries, counts: day.counts, note: DIARY_NOTE };
  if (finished) {
    db.run(`INSERT INTO diary_days (date, body_json, ideas_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET body_json = excluded.body_json, ideas_json = excluded.ideas_json, created_at = excluded.created_at`,
    d, JSON.stringify(body), JSON.stringify(day.named), now());
  }
  return body;
}

/** GET /api/diary/latest: the most recent finished Tokyo day that has a page (looks back up to 60 days of activity). */
export function latestDiary(db, cfg, t = now()) {
  let before = dayStart(t);
  for (let i = 0; i < 60; i++) {
    const last = db.get(`SELECT MAX(at) at FROM (SELECT MAX(at) at FROM vote_ledger WHERE at < ?
      UNION ALL SELECT MAX(at) FROM events WHERE at < ? AND (kind = 'resident' OR (kind = 'status' AND json_extract(data_json, '$.to') IN ('preview_ready', 'launched'))))`,
    before, before).at;
    if (last == null) break;
    const page = diaryFor(db, cfg, jstDate(last), t);
    if (page.entries.length) return page;
    before = dateStart(jstDate(last));
  }
  return diaryFor(db, cfg, lastCompletedDay(t), t);
}
