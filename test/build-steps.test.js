// SUB-01's build, step by step (build-steps.js, migration 018): the recorded steps and providers, the data-driven ETA
// (medians, p90 overrun, never negative), the queue position, failures, GET /api/ideas/:id `build`, /api/world and the
// live SSE `build` frame. Observation only: the same spec is built with or without the observer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, makeEnv, user, fakeBrain, drain, IDEA, ideaStatus } from './helpers.js';
import { submitIdea, publishIdea } from '../src/ideas.js';
import { enqueue, claim, runJob } from '../src/jobs.js';
import { handlers, onDead } from '../src/pipeline.js';
import { templateGenerate } from '../src/generator.js';
import { setSetting } from '../src/db.js';
import { worldView, PLOT_IDS } from '../src/world.js';
import { median, quantile, expectFor, remainingFor, estimate, queueStart, buildView, buildSummary, buildRecorder, artOutcome, qaOutcome, clearStatsCache,
  DEFAULT_SECONDS, PIPELINE } from '../src/build-steps.js';

const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

// --- pure ---------------------------------------------------------------------------------------------------------------
test('median / p90 of durations', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.equal(median([]), null);
});

test('expected seconds: the defaults until there is data, then the median (per provider with 3+ runs)', () => {
  assert.deepEqual(DEFAULT_SECONDS, { brief: 25, app: 20, art: 40, site: 5, qa: 30 });
  assert.equal(expectFor({}, 'brief', 'language model').expected, 25);
  assert.equal(expectFor({}, 'art', 'Higgsfield').expected, 40);
  assert.equal(expectFor({}, 'brief', 'template (no AI)').expected, 1, 'no network: about a second');
  assert.equal(expectFor({}, 'brief', 'language model').source, 'default');
  const stats = { art: { all: [10, 12, 50, 11, 13], by: { Higgsfield: [40, 44, 42], 'local drawing': [2, 2, 3] } } };
  const h = expectFor(stats, 'art', 'Higgsfield');
  assert.equal(h.expected, 42); assert.equal(h.source, 'provider'); assert.ok(h.p90 >= h.expected);
  assert.equal(expectFor(stats, 'art', 'Recraft').expected, 12, 'too few runs of its own: the step median');
  assert.equal(expectFor({ art: { all: [10, 11], by: {} } }, 'art', 'Recraft').expected, 40, 'fewer than 3 runs: the default');
});

test('remaining time of a running step: to its median, then its p90, then by p90 again; never negative', () => {
  const e = { expected: 20, p90: 30 };
  assert.equal(remainingFor(e, 0), 20);
  assert.equal(remainingFor(e, 15), 5);
  assert.equal(remainingFor(e, 25), 5, 'past the median: to the p90');
  assert.equal(remainingFor(e, 31), 29, 'past the p90: extended by another p90');
  for (let s = 0; s < 200; s += 0.7) assert.ok(remainingFor(e, s) > 0);
  assert.equal(remainingFor(e, -5), 20);
});

test('estimate: remaining = medians of steps not started + what is left of the running one; percent of the work', () => {
  const t = 1_000_000;
  const steps = [
    { id: 'queued', state: 'done', startedAt: t - 90_000, endedAt: t - 60_000 },
    { id: 'brief', state: 'done', startedAt: t - 60_000, endedAt: t - 35_000, expectedSeconds: 25, p90Seconds: 40 },
    { id: 'app', state: 'running', startedAt: t - 10_000, expectedSeconds: 20, p90Seconds: 32 },
    { id: 'art', state: 'todo', expectedSeconds: 40, p90Seconds: 64 },
    { id: 'site', state: 'todo', expectedSeconds: 5, p90Seconds: 8 },
    { id: 'ready', state: 'todo' }];
  const e = estimate(steps, t);
  assert.equal(e.remaining, 10 + 40 + 5);
  assert.equal(e.done, 25 + 10);
  assert.equal(e.percent, Math.floor((100 * 35) / 90));
  // converges: the same steps later in the running step leave less
  assert.ok(estimate(steps, t + 5_000).remaining < e.remaining);
  assert.equal(queueStart({ ahead: [30, 60], dueInSeconds: 5 }), 90);
  assert.equal(queueStart({ ahead: [], dueInSeconds: 120 }), 120, 'a deferred job waits for its time');
  assert.equal(queueStart({ ahead: [], dueInSeconds: -3 }), 0);
});

test('QA outcome in words: Chromium or static checks, and what it found', () => {
  assert.deepEqual(qaOutcome({ browser: 'ran', line: 'passed', held: false }), { provider: 'Chromium', note: 'passed' });
  assert.deepEqual(qaOutcome({ browser: 'skipped', line: '2 issues (static checks only: no browser)', held: true }), { provider: 'static checks', note: '2 issues (static checks only: no browser); this version was held back' });
  assert.equal(qaOutcome(null).note, 'not checked');
});

test('art outcome in words: Higgsfield, Higgsfield + local fallback, local fallback, local drawing', () => {
  const cfgHf = { art: { hfKeyId: 'a', hfKeySecret: 'b' } }, cfgNone = { art: {} };
  assert.equal(artOutcome({ provider: ['higgsfield', 'higgsfield'] }, cfgHf).provider, 'Higgsfield');
  assert.equal(artOutcome({ provider: ['higgsfield', 'local'] }, cfgHf).provider, 'Higgsfield + local fallback');
  assert.equal(artOutcome({ provider: ['local', 'local'] }, cfgHf).provider, 'local fallback');
  assert.match(artOutcome({ provider: ['local', 'local'] }, cfgHf).note, /Higgsfield did not deliver/);
  assert.equal(artOutcome({ provider: ['local', 'local'] }, cfgNone).provider, 'local drawing');
  assert.equal(artOutcome(null, cfgNone).provider, 'procedural fallback');
});

test('migration 018: build_steps on a fresh database', () => {
  const { db } = makeEnv();
  const cols = db.all('PRAGMA table_info(build_steps)').map((c) => c.name);
  for (const c of ['idea_id', 'job_id', 'attempt', 'step', 'state', 'provider', 'planned', 'note', 'started_at', 'ended_at', 'updated_at']) assert.ok(cols.includes(c), c);
  assert.ok(db.get(`SELECT 1 FROM schema_migrations WHERE name = '018_build_steps.sql'`));
});

// --- recording -----------------------------------------------------------------------------------------------------------
test('a build records queued → app → brief (the words) → art → site → qa → ready with providers; the view ends ready at 100%', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fakeBrain('build').fetchImpl);
  assert.equal(ideaStatus(db, id).status, 'preview_ready');
  const rows = db.all('SELECT step, state, provider, started_at, ended_at FROM build_steps WHERE idea_id = ? ORDER BY started_at, rowid', id);
  assert.deepEqual(rows.map((r) => r.step), PIPELINE);
  assert.ok(rows.every((r) => r.state === 'done' && r.ended_at >= r.started_at));
  const by = Object.fromEntries(rows.map((r) => [r.step, r.provider]));
  assert.equal(by.brief, 'template (no AI)');
  assert.equal(by.app, 'rules (no AI)');
  assert.equal(by.art, 'local drawing');
  assert.equal(by.site, 'sandbox');
  assert.equal(by.qa, 'static checks', 'SUB-01\'s QA gate (no browser in tests)');
  assert.match(db.get(`SELECT note FROM build_steps WHERE idea_id = ? AND step = 'qa'`, id).note, /passed|issue/);
  const v = buildView(db, cfg, id, { owner: true });
  assert.equal(v.state, 'ready'); assert.equal(v.percent, 100); assert.equal(v.etaSeconds, 0); assert.equal(v.queue, null);
  assert.deepEqual(v.steps.map((s) => [s.id, s.state]), PIPELINE.map((s) => [s, 'done']));
  for (const s of v.steps) for (const k of ['label', 'startedAt', 'endedAt', 'provider', 'note', 'elapsedSeconds']) assert.ok(k in s, k);
  assert.ok(v.elapsedSeconds >= 0 && v.startedAt <= v.steps.at(-1).endedAt);
});

test('observing changes nothing: the same spec with or without the observer', () => {
  const idea = { title: 'Ramen Radar', concept: 'A map of late-night ramen in Tokyo, updated by the community.', name_suggestion: 'Ramen Radar', ticker_suggestion: 'RAMEN' };
  const brain = { networks: { reward: 1, attention: 0.5 }, vote: { options: [{ label: 'build: x', p: 0.8 }], spiking: { used: false } } };
  const heard = [];
  const a = templateGenerate({ idea, brain }), b = templateGenerate({ idea, brain, observe: (e) => heard.push(e) });
  assert.deepEqual(a, b);
  assert.deepEqual(heard, ['app:done', 'brief:start', 'brief:done'], 'the app first, then the words for it (2026-10-12)');
});

test('language model build: brief and app by the language model; a composer fallback says rules (no AI) and why', async () => {
  const { cfg, db } = makeEnv({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'test-key' });
  const w = user(db);
  const brain = fakeBrain('build');
  const spec = { name: 'Ramen Radar', ticker: 'RAMEN', tagline: 'Late-night ramen, mapped.', description: 'A community map of late-night ramen in Tokyo.',
    sections: [{ heading: 'The idea', body: 'A map.' }], x: { handles: ['ramenradar', 'ramen_sol', 'ramen_sub01'], bio: 'Late-night ramen in Tokyo, mapped.', posts: ['Add a ramen counter.', 'Vote the good bowls up.'] } };
  const fetchImpl = async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) return brain.fetchImpl(url, init);
    if (/You design a small working web app/.test(JSON.parse(init.body).system)) return new Response('{}', { status: 529 });   // the composer: falls back
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(spec) }], usage: { input_tokens: 10, output_tokens: 10 } }));
  };
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fetchImpl);
  assert.equal(ideaStatus(db, id).status, 'preview_ready');
  const v = buildView(db, cfg, id);
  const s = Object.fromEntries(v.steps.map((x) => [x.id, x]));
  assert.equal(s.brief.provider, 'language model');
  assert.equal(s.app.provider, 'rules (no AI)');
  assert.match(s.app.note, /did not pass the checks; built from the rules/);
  assert.equal(db.get(`SELECT planned FROM build_steps WHERE idea_id = ? AND step = 'app'`, id).planned, 'language model', 'the ETA keeps it as a language-model run');
});

test('a language model failure: the words step says the template wrote them, and the build goes on', async () => {
  const { cfg, db } = makeEnv({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'test' });
  const w = user(db);
  const brain = fakeBrain('build');
  const failing = async (url, init) => (String(url).includes('anthropic') ? new Response('{}', { status: 529 }) : brain.fetchImpl(url, init));
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, failing);
  assert.equal(ideaStatus(db, id).status, 'preview_ready');
  const s = Object.fromEntries(buildView(db, cfg, id, { owner: true }).steps.map((x) => [x.id, x]));
  assert.equal(s.app.provider, 'rules (no AI)');
  assert.equal(s.brief.state, 'done');
  assert.equal(s.brief.provider, 'template (no AI)');
  assert.match(s.brief.note, /the language model failed \(generator HTTP 529\); the template wrote the words/);
});

test('a failed run: the step it stopped on is failed, the build retries; the reason only for the author', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const failing = fakeBrain('build').fetchImpl;
  setSetting(db, 'pause.deployment', true, 'test');          // the site build refuses: the run stops on the site step
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, failing);
  const mine = buildView(db, cfg, id, { owner: true }), pub = buildView(db, cfg, id);
  assert.equal(mine.state, 'retrying');
  assert.equal(mine.steps.find((s) => s.id === 'site').state, 'failed');
  assert.match(mine.steps.find((s) => s.id === 'site').note, /paused/);
  assert.equal(pub.steps.find((s) => s.id === 'site').note, 'stopped here');
  assert.ok(mine.queue && mine.queue.startsInSeconds > 0, 'waits for the retry');
  assert.ok(mine.etaSeconds >= mine.queue.startsInSeconds);
  // out of attempts: failed, no ETA
  let t = Date.now();
  for (let i = 0; i < 6; i++) { t += 30 * 60_000; await drain(db, cfg, failing, { t }); }
  assert.equal(ideaStatus(db, id).status, 'failed');
  const end = buildView(db, cfg, id, { owner: true });
  assert.equal(end.state, 'failed'); assert.equal(end.etaAt, null); assert.equal(end.attempt, 3);
});

test('copy the content check refuses: the words step says the template wrote them; nothing of it reaches the page', async () => {
  const { cfg, db } = makeEnv({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'test' });
  const w = user(db);
  const brain = fakeBrain('build');
  const evil = { name: 'Evil', ticker: 'EVIL', tagline: 'fine', description: 'guaranteed 100x returns for holders', sections: [{ heading: 'x', body: 'y' }], x: { handles: ['evilcoin'], bio: 'b', posts: ['p'] } };
  const gen = async (url, init) => (String(url).includes('anthropic') ? new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(evil) }], usage: {} })) : brain.fetchImpl(url, init));
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, gen);
  const v = buildView(db, cfg, id, { owner: true });
  assert.equal(v.state, 'ready');
  assert.deepEqual(v.steps.map((s) => s.id), ['queued', 'app', 'brief', 'art', 'site', 'qa', 'ready']);
  assert.equal(v.steps[2].provider, 'template (no AI)');
  assert.match(v.steps[2].note, /generator output refused/);
  assert.doesNotMatch(db.get('SELECT html FROM site_versions').html, /guaranteed 100x/);
});

test('ETA from data: the medians of the last finished builds replace the defaults; the queue says who is first', async () => {
  const { cfg, db } = makeEnv({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'test' });
  const w = user(db), w2 = user(db), old = user(db);
  // five finished builds: brief 10 s, app 4 s, art 30 s, site 2 s
  const t0 = Date.now() - 3_600_000;
  for (let i = 0; i < 5; i++) {
    const job = { id: `job_old${i}`, idea_id: `idea_old${i}`, attempts: 1, created_at: t0 };
    db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, current_version, created_at, updated_at) VALUES (?, ?, 'preview_ready', 'private', 1, ?, ?)`, job.idea_id, old.address, t0, t0);
    const r = buildRecorder(db, job, { cfg });
    let t = t0 + i * 100_000;
    r.begin(t); t += 4_000; r.done('app', {}, t);               // begin(): in line → the app (2026-10-12: the app first)
    r.start('brief', 'language model', null, t); t += 10_000; r.done('brief', {}, t);
    r.start('art', 'local drawing', null, t); t += 30_000; r.done('art', {}, t);
    r.start('site', 'sandbox', null, t); t += 2_000; r.done('site', {}, t);
    r.start('qa', 'static checks', null, t); t += 500; r.done('qa', {}, t);
    r.done('ready', {}, t);
  }
  clearStatsCache(db);
  // two new builds in line, one worker
  const a = submitIdea(db, cfg, w.address, IDEA(w)), b = submitIdea(db, cfg, w2.address, IDEA(w2, { title: 'Onsen Owls', concept: 'A coin about owls that run a tiny onsen in Hakone, with daily bath times.' }));
  for (const id of [a, b]) {
    db.run(`UPDATE ideas SET status = 'selected' WHERE id = ?`, id);
    enqueue(db, { type: 'generate', key: `generate:${id}:1`, ideaId: id });
    await new Promise((r) => setTimeout(r, 5));
  }
  const va = buildView(db, cfg, a), vb = buildView(db, cfg, b);
  assert.equal(va.state, 'queued'); assert.equal(va.percent, 0);
  assert.equal(va.steps[0].state, 'running', 'in line');
  assert.equal(va.queue.position, 1); assert.equal(vb.queue.position, 2);
  const s = Object.fromEntries(va.steps.map((x) => [x.id, x]));
  assert.equal(s.brief.expectedSeconds, 10); assert.equal(s.app.expectedSeconds, 4); assert.equal(s.art.expectedSeconds, 30); assert.equal(s.site.expectedSeconds, 2);
  assert.equal(s.brief.estimateFrom, 'median of 5');
  assert.equal(s.brief.plannedProvider, 'language model');
  assert.equal(s.qa.expectedSeconds, 0.5); assert.equal(s.qa.plannedProvider, 'static checks');
  assert.equal(va.etaSeconds, 46.5);
  assert.equal(vb.queue.startsInSeconds, 46.5, 'starts when the first one is done');
  assert.equal(vb.etaSeconds, 93);
  const sum = buildSummary(vb);
  assert.deepEqual(Object.keys(sum).sort(), ['elapsedSeconds', 'etaAt', 'etaSeconds', 'now', 'percent', 'queuePosition', 'state', 'step']);
  assert.equal(sum.queuePosition, 2);
});

test('while it runs: the running step, the percentage and an ETA that converges', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  db.run(`UPDATE ideas SET status = 'generating' WHERE id = ?`, id);
  const job = enqueue(db, { type: 'generate', key: `generate:${id}:1`, ideaId: id });
  db.run(`UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?`, job.id);
  const j = db.get('SELECT * FROM jobs WHERE id = ?', job.id);
  const r = buildRecorder(db, j, { cfg: { ...cfg, generator: { ...cfg.generator, provider: 'anthropic' } } });
  const t = Date.now();
  r.begin(t - 30_000); r.done('app', {}, t - 10_000); r.start('brief', 'language model', null, t - 10_000);   // the app, then the words
  const v1 = buildView(db, cfg, id, { t });
  assert.equal(v1.state, 'running');
  assert.equal(v1.steps.find((s) => s.id === 'brief').state, 'running');
  assert.equal(v1.steps.find((s) => s.id === 'brief').provider, 'language model');
  assert.ok(v1.percent > 0 && v1.percent < 100);
  const v2 = buildView(db, cfg, id, { t: t + 5_000 });
  assert.ok(v2.etaSeconds < v1.etaSeconds && v2.etaSeconds > 0);
  assert.ok(Math.abs(v2.etaAt - v1.etaAt) < 1000, 'within the medians the finish time holds still');
  assert.equal(buildSummary(v1).step.id, 'brief');
  // the building in /api/world: "Building · 62% · ~1 min left"
  db.run(`INSERT INTO plots (plot_id, kind, wallet, idea_id, claimed_at) VALUES (?, 'project', ?, ?, ?)`, PLOT_IDS[0], w.address, id, t);
  const b = worldView(db, cfg, t).plots.find((p) => p.plotId === PLOT_IDS[0]).project.build;
  assert.equal(b.state, 'running'); assert.equal(b.step.id, 'brief'); assert.ok(b.percent > 0 && b.etaSeconds > 0);
  // a job no longer running leaves the running step failed (a worker that died mid-step)
  db.run(`UPDATE jobs SET status = 'dead', last_error = 'lease expired' WHERE id = ?`, job.id);
  assert.equal(buildView(db, cfg, id, { t }).steps.find((s) => s.id === 'brief').state, 'failed');
});

// --- HTTP + the stream ------------------------------------------------------------------------------------------------
async function sse(h, c) {
  const ac = new AbortController();
  const res = await fetch(`${h.base}/api/chat/stream`, { headers: c?.cookie ? { cookie: c.cookie } : {}, signal: ac.signal });
  const events = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = {};
          for (const line of buf.slice(0, i).split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          buf = buf.slice(i + 2);
          if (ev.event) events.push(ev);
        }
      }
    } catch { /* aborted */ }
  })();
  await until(() => events.some((e) => e.event === 'hello'));
  return { of: (name) => events.filter((e) => e.event === name).map((e) => e.data), close: () => ac.abort() };
}

test('GET /api/ideas/:id carries build; /api/world the building summary; the stream a `build` frame per step change', async () => {
  const h = await harness({}, { buildWatchMs: 0 });
  try {
    const owner = h.client(user(h.db)); await owner.signIn();
    const other = h.client(user(h.db)); await other.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    const id = sub.json.id;
    publishIdea(h.db, id, owner.w.address, true);
    const sOwner = await sse(h, owner), sOther = await sse(h, other);
    // the verdict: build -> a generate job in line
    let job = claim(h.db, 'test');
    await runJob(h.db, job, handlers, { cfg: h.cfg, fetchImpl: h.brain.fetchImpl }, onDead);
    assert.equal(h.app.buildWatch.tick(), 1);
    await until(() => sOther.of('build').length === 1);
    const f1 = sOther.of('build')[0];
    assert.equal(f1.ideaId, id); assert.equal(f1.private, false); assert.equal(f1.build.state, 'queued'); assert.equal(f1.build.queue.position, 1);
    const view = await other.call('GET', `/api/ideas/${id}`);
    assert.equal(view.json.build.state, 'queued');
    const world = await other.call('GET', '/api/world');
    const proj = world.json.plots.find((p) => p.project?.ideaId === id)?.project;
    if (proj) { assert.equal(proj.build.state, 'queued'); assert.equal(proj.build.queuePosition, 1); }
    assert.equal(h.app.buildWatch.tick(), 0, 'nothing changed: no frame');
    // the build runs
    job = claim(h.db, 'test');
    assert.equal(job.type, 'generate');
    await runJob(h.db, job, handlers, { cfg: h.cfg, fetchImpl: h.brain.fetchImpl }, onDead);
    assert.equal(h.app.buildWatch.tick(), 1);
    await until(() => sOwner.of('build').length === 2);
    const f2 = sOwner.of('build')[1];
    assert.equal(f2.status, 'preview_ready'); assert.equal(f2.build.state, 'ready'); assert.equal(f2.build.percent, 100);
    const done = await owner.call('GET', `/api/ideas/${id}`);
    assert.deepEqual(done.json.build.steps.map((s) => s.state), PIPELINE.map(() => 'done'));
    sOwner.close(); sOther.close();
  } finally { h.close(); }
});

test('a private idea\'s build frames reach its author only', async () => {
  const h = await harness({}, { buildWatchMs: 0 });
  try {
    const owner = h.client(user(h.db)); await owner.signIn();
    const other = h.client(user(h.db)); await other.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    const sOwner = await sse(h, owner), sOther = await sse(h, other);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    h.app.buildWatch.tick();
    await until(() => sOwner.of('build').length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sOther.of('build').length, 0);
    assert.equal(sOwner.of('build')[0].private, true);
    assert.equal(sOwner.of('build')[0].ideaId, sub.json.id);
    assert.equal((await other.call('GET', `/api/ideas/${sub.json.id}`)).status, 404);
    sOwner.close(); sOther.close();
  } finally { h.close(); }
});
