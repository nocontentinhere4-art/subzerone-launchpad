// Anonymous telemetry: strict reports, per-session and per-IP limits, opt-out, no IP or session id stored, daily
// salt rotation, admin-only daily aggregates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { user, harness, makeEnv } from './helpers.js';
import { recordTelemetry, telemetryDaily, TELEMETRY } from '../src/telemetry.js';
import { getSetting } from '../src/db.js';

const REPORT = (extra = {}) => ({ session: 'sess_abcdefghijklmnop', device: 'phone', gpu_class: 'weak', quality_level: 1, fps_bucket: '20-30',
  crash: false, context_lost: false, memory_mb: 512, seconds: 90, ...extra });
const NOON = Date.parse('2026-10-10T12:00:00Z');
const code = (fn) => { try { fn(); return null; } catch (e) { return [e.status, e.code]; } };

test('telemetry: strict validation', () => {
  const { db } = makeEnv();
  const bad = [{ extra: 1 }, { session: 'short' }, { session: 'x'.repeat(33) }, { session: 'has space in it ok?' }, { device: 'tablet' },
    { gpu_class: 'great' }, { quality_level: 4 }, { quality_level: 1.5 }, { fps_bucket: '60' }, { crash: 'yes' }, { context_lost: 0 },
    { memory_mb: -1 }, { memory_mb: 'lots' }, { seconds: 86401 }, { seconds: null }];
  for (const b of bad) assert.deepEqual(code(() => recordTelemetry(db, REPORT(b), '1.2.3.4', NOON)), [400, 'bad_telemetry'], JSON.stringify(b));
  assert.deepEqual(code(() => recordTelemetry(db, [], '1.2.3.4', NOON)), [400, 'bad_telemetry']);
  assert.deepEqual(recordTelemetry(db, REPORT({ gpu_class: null, memory_mb: null }), '1.2.3.4', NOON), { stored: true });
  assert.equal(db.get('SELECT COUNT(*) n FROM telemetry').n, 1);
});

test('telemetry: one report per 30 s per session, 500 per IP per day, no IP or session id stored', () => {
  const { db } = makeEnv();
  recordTelemetry(db, REPORT(), '203.0.113.7', NOON);
  const e = (() => { try { recordTelemetry(db, REPORT(), '203.0.113.7', NOON + 29_000); } catch (x) { return x; } })();
  assert.deepEqual([e.status, e.code, e.extra.retryAfterS], [429, 'rate_limited', 1]);
  assert.deepEqual(recordTelemetry(db, REPORT(), '203.0.113.7', NOON + 30_000), { stored: true });
  for (let i = 2; i < TELEMETRY.perIpPerDay; i++) recordTelemetry(db, REPORT({ session: `session_${String(i).padStart(10, '0')}` }), '203.0.113.7', NOON + 31_000);
  assert.equal(db.get('SELECT COUNT(*) n FROM telemetry').n, 500);
  assert.deepEqual(code(() => recordTelemetry(db, REPORT({ session: 'another_session_xyz' }), '203.0.113.7', NOON + 32_000)), [429, 'rate_limited']);
  assert.deepEqual(recordTelemetry(db, REPORT({ session: 'another_session_xyz' }), '198.51.100.2', NOON + 32_000), { stored: true });
  const dump = JSON.stringify(db.all('SELECT * FROM telemetry'));
  for (const leak of ['203.0.113.7', '198.51.100.2', 'sess_abcdefghijklmnop', 'another_session_xyz']) assert.ok(!dump.includes(leak), `stored ${leak}`);

  // the next UTC day: a new salt (yesterday's is gone), yesterday's IP hashes cleared, the same session unlinkable
  const salt1 = getSetting(db, 'telemetry.salt').salt;
  const day1Hash = db.get('SELECT session_hash h FROM telemetry ORDER BY id LIMIT 1').h;
  recordTelemetry(db, REPORT(), '203.0.113.7', NOON + 86_400_000);
  assert.notEqual(getSetting(db, 'telemetry.salt').salt, salt1);
  assert.equal(getSetting(db, 'telemetry.salt').day, '2026-10-11');
  assert.equal(db.get(`SELECT COUNT(*) n FROM telemetry WHERE day = '2026-10-10' AND ip_hash IS NOT NULL`).n, 0);
  assert.notEqual(db.get('SELECT session_hash h FROM telemetry ORDER BY id DESC LIMIT 1').h, day1Hash);
  // after 90 days the rows are deleted
  recordTelemetry(db, REPORT(), '203.0.113.7', NOON + 92 * 86_400_000);
  assert.equal(db.get(`SELECT COUNT(*) n FROM telemetry WHERE day < '2026-10-12'`).n, 0);
});

test('telemetry: daily aggregate (per-session rates, report distributions)', () => {
  const { db } = makeEnv();
  const t = NOON;
  recordTelemetry(db, REPORT({ session: 'aaaaaaaaaaaaaaaa', fps_bucket: '<20', quality_level: 0 }), 'ip1', t);
  recordTelemetry(db, REPORT({ session: 'aaaaaaaaaaaaaaaa', fps_bucket: '20-30', quality_level: 0, crash: true }), 'ip1', t + 40_000);
  recordTelemetry(db, REPORT({ session: 'bbbbbbbbbbbbbbbb', device: 'desktop', fps_bucket: '45+', quality_level: 3, context_lost: true }), 'ip2', t);
  recordTelemetry(db, REPORT({ session: 'cccccccccccccccc', device: 'desktop', fps_bucket: '45+', quality_level: 2 }), 'ip3', t);
  recordTelemetry(db, REPORT({ session: 'dddddddddddddddd', device: 'desktop', fps_bucket: '30-45', quality_level: 2 }), 'ip3', t - 86_400_000);
  const out = telemetryDaily(db, 14, t);
  assert.deepEqual(out.days[0], { day: '2026-10-10', sessions: 3, reports: 4, phoneShare: 0.333, crashRate: 0.333, contextLossRate: 0.333,
    fps: { '<20': 1, '20-30': 1, '30-45': 0, '45+': 2 }, quality: { 0: 2, 1: 0, 2: 1, 3: 1 } });
  assert.deepEqual(out.days.map((d) => d.day), ['2026-10-10', '2026-10-09']);
  assert.deepEqual(telemetryDaily(db, 1, t).days.map((d) => d.day), ['2026-10-10']);
});

test('POST /api/telemetry + GET /api/admin/telemetry over HTTP: opt-out headers, admin only, no hashes shown', async () => {
  const h = await harness();
  try {
    const anon = h.client(user(h.db));
    const r = await anon.call('POST', '/api/telemetry', REPORT());
    assert.deepEqual([r.status, r.json], [200, { stored: true }]);
    assert.equal((await anon.call('POST', '/api/telemetry', REPORT())).status, 429);
    for (const hd of [{ dnt: '1' }, { 'sec-gpc': '1' }, { 'x-telemetry': 'off' }]) {
      const o = await anon.call('POST', '/api/telemetry', REPORT({ session: 'opted_out_session_1' }), hd);
      assert.deepEqual(o.json, { stored: false, reason: 'opted_out' });
    }
    assert.equal((await anon.call('POST', '/api/telemetry', REPORT({ session: 'tiny' }))).status, 400);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM telemetry').n, 1);
    assert.equal((await anon.call('GET', '/api/admin/telemetry')).status, 401);
    await anon.signIn();
    assert.equal((await anon.call('GET', '/api/admin/telemetry')).status, 403);
    const admin = h.client(user(h.db, 'admin'));
    await admin.signIn();
    const a = await admin.call('GET', '/api/admin/telemetry?days=7');
    assert.equal(a.status, 200);
    assert.equal(a.json.days[0].sessions, 1);
    assert.equal(a.json.days[0].phoneShare, 1);
    const hashes = h.db.all('SELECT session_hash, ip_hash FROM telemetry').flatMap((x) => [x.session_hash, x.ip_hash]);
    for (const x of hashes) assert.ok(!a.text.includes(x));
    for (const q of ['days=0', 'days=91', 'days=x']) assert.equal((await admin.call('GET', `/api/admin/telemetry?${q}`)).status, 400, q);
  } finally { h.close(); }
});
