// The city calendar: deterministic week themes on Tokyo time, rituals, and events derived from public data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { user, harness, SUB01_WALLET } from './helpers.js';
import { calendarView, isoWeek, THEMES, PARTY_MS, OPEN_SOON_MS } from '../src/calendar.js';

const T = (iso) => Date.parse(iso);
const WEEK = 7 * 86_400_000;

function project(db, owner, slug, { status, visibility = 'public', launchedAt = null, plotId = null }) {
  const t = Date.now();
  db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, `idea_${slug}`, owner, status, visibility, t, t);
  db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'd', ?, ?)`,
    `prj_${slug}`, `idea_${slug}`, slug, slug.toUpperCase(), slug.toUpperCase(), t, t);
  if (plotId) db.run(`INSERT INTO plots (plot_id, kind, wallet, idea_id, claimed_at) VALUES (?, 'project', ?, ?, ?)`, plotId, owner, `idea_${slug}`, t);
  if (launchedAt) {
    db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at) VALUES (?, ?, 1, '[]', 10000, 'locked', ?)`, `al_${slug}`, `prj_${slug}`, t);
    db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, created_at, updated_at)
            VALUES (?, ?, 'mock', 'mock', '{}', 'h', ?, ?, ?, 'confirmed', ?, ?)`, `in_${slug}`, `prj_${slug}`, `al_${slug}`, `Mint${slug}`, owner, t, t);
    db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, ?, 'mock', 'mock', ?, ?, '[]', ?)`,
      `prj_${slug}`, `in_${slug}`, `Mint${slug}`, `sig${slug}`, launchedAt);
  }
}

test('calendar: ISO week on Tokyo time, 8 themes rotating, deterministic', () => {
  const sat = T('2026-10-10T03:00:00Z');                      // Saturday 12:00 JST
  const w = isoWeek(sat);
  assert.equal(w.label, '2026-W41');
  assert.equal(w.starts, T('2026-10-04T15:00:00Z'));           // Monday 5 October, 00:00 JST
  assert.equal(w.ends, w.starts + WEEK);
  assert.equal(isoWeek(T('2026-10-11T14:59:59Z')).label, '2026-W41');   // Sunday 23:59:59 JST
  assert.equal(isoWeek(T('2026-10-11T15:00:00Z')).label, '2026-W42');   // Monday 00:00 JST
  assert.equal(isoWeek(T('2027-01-01T03:00:00Z')).label, '2026-W53');   // ISO years: 2026 has 53 weeks
  assert.equal(isoWeek(T('2027-01-04T03:00:00Z')).label, '2027-W01');
  assert.equal(isoWeek(T('2024-12-30T03:00:00Z')).label, '2025-W01');

  const db = { all: () => [] }, cfg = { production: false };
  const a = calendarView(db, cfg, sat);
  assert.deepEqual(calendarView(db, cfg, sat), a);
  assert.equal(a.tokyoDate, '2026-10-10');
  assert.equal(calendarView(db, cfg, T('2026-10-10T15:00:00Z')).tokyoDate, '2026-10-11');
  assert.deepEqual(Object.keys(a.weekTheme), ['id', 'title', 'kanji', 'text', 'isoWeek', 'starts', 'ends']);
  // the whole week shares one theme; the next 8 weeks show every theme once, in order, then repeat
  assert.equal(calendarView(db, cfg, w.starts).weekTheme.id, a.weekTheme.id);
  assert.equal(calendarView(db, cfg, w.ends - 1).weekTheme.id, a.weekTheme.id);
  const ids = Array.from({ length: 9 }, (_, i) => calendarView(db, cfg, sat + i * WEEK).weekTheme.id);
  assert.deepEqual(new Set(ids.slice(0, 8)), new Set(THEMES.map((x) => x.id)));
  assert.equal(ids[8], ids[0]);
  const i0 = THEMES.findIndex((x) => x.id === ids[0]);
  assert.deepEqual(ids.slice(0, 8), [...THEMES, ...THEMES].slice(i0, i0 + 8).map((x) => x.id));
  assert.deepEqual(THEMES.map((x) => x.id), ['hanami', 'matsuri', 'neon', 'rain', 'obon', 'moon', 'snow', 'newyear']);

  // rituals: omikuji at 00:00 JST today and tomorrow; the monthly ranking closes on the month's last day (23:59 JST)
  assert.deepEqual(a.today.events.map((e) => [e.kind, e.at]), [['omikuji', T('2026-10-09T15:00:00Z')]]);
  assert.equal(a.today.events[0].time, '00:00 JST');
  assert.deepEqual(a.upcoming.map((e) => [e.kind, e.at]), [['omikuji', T('2026-10-10T15:00:00Z')], ['ranking', T('2026-10-31T14:59:00Z')]]);
  assert.equal(a.upcoming[1].placeholder, true);
  const leap = calendarView(db, cfg, T('2028-02-29T01:00:00Z'));          // the last day of February 2028, 10:00 JST
  assert.deepEqual(leap.today.events.map((e) => e.kind), ['omikuji', 'ranking']);
  assert.equal(leap.today.events[1].at, T('2028-02-29T14:59:00Z'));
  assert.ok(!leap.upcoming.some((e) => e.kind === 'ranking'));
});

test('calendar: launch parties and open-soon windows from public projects only, no wallets', async () => {
  const h = await harness();
  try {
    const owner = user(h.db).address;
    const JST = 9 * 3_600_000, DAY = 86_400_000;
    const t = Math.floor((Date.now() + JST) / DAY) * DAY - JST + 12 * 3_600_000;   // noon JST today: never near midnight
    project(h.db, owner, 'ramen', { status: 'launched', launchedAt: t - 60_000, plotId: 'shibuya-2' });
    project(h.db, owner, 'hidden', { status: 'launched', visibility: 'private', launchedAt: t - 60_000 });
    project(h.db, owner, 'oldie', { status: 'launched', launchedAt: t - 3 * 86_400_000 });
    project(h.db, owner, 'soon', { status: 'awaiting_signature' });
    project(h.db, owner, 'soonpriv', { status: 'launch_prepared', visibility: 'private' });
    project(h.db, owner, 'early', { status: 'preview_ready' });
    const c = calendarView(h.db, h.cfg, t);
    const party = c.today.events.find((e) => e.kind === 'launch_party');
    assert.deepEqual(party, { kind: 'launch_party', at: t - 60_000, ends: t - 60_000 + PARTY_MS, title: 'Street party: $RAMEN launched',
      slug: 'ramen', name: 'RAMEN', ticker: 'RAMEN', plotId: 'shibuya-2' });
    assert.equal(c.today.events.filter((e) => e.kind === 'launch_party').length, 1, 'no private or older launches');
    const soon = c.upcoming.filter((e) => e.kind === 'open_soon');
    assert.deepEqual(soon.map((e) => [e.slug, e.at, e.ends]), [['soon', t, t + OPEN_SOON_MS]]);

    const r = await h.client(user(h.db)).call('GET', '/api/calendar');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /public, max-age=60/);
    assert.deepEqual(Object.keys(r.json), ['now', 'tokyoDate', 'weekTheme', 'today', 'upcoming']);
    for (const leak of [owner, SUB01_WALLET, 'hidden', 'soonpriv', 'Minthidden']) assert.ok(!r.text.includes(leak), `leaked ${leak}`);
    assert.ok(r.json.today.events.some((e) => e.slug === 'ramen'));
  } finally { h.close(); }
});
