import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, wallet, user, fakeBrain, drain, IDEA, ideaStatus, SUB01_WALLET } from './helpers.js';
import { submitIdea, editIdea, viewIdea } from '../src/ideas.js';
import { enqueue, claim, runJob } from '../src/jobs.js';
import { handlers, onDead } from '../src/pipeline.js';
import { setSetting } from '../src/db.js';

test('brain says build: idea goes submitted -> evaluating -> selected -> generating -> preview_ready', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('build');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, brain.fetchImpl);
  assert.equal(ideaStatus(db, id).status, 'preview_ready');
  const ev = db.get('SELECT * FROM evaluations WHERE idea_id = ?', id);
  assert.equal(ev.decided_by, 'brain_vote');
  const scores = JSON.parse(ev.scores_json);
  assert.equal(scores.suitability.source.startsWith('simulation'), true);
  assert.equal(scores.originality.source.startsWith('rule'), true);
  const p = db.get('SELECT * FROM projects WHERE idea_id = ?', id);
  assert.equal(p.ticker, 'RAMEN');
  assert.ok(db.get(`SELECT 1 FROM site_versions WHERE project_id = ? AND build_status = 'ok'`, p.id));
  assert.equal(db.get(`SELECT COUNT(*) n FROM assets WHERE project_id = ?`, p.id).n, 2);
  assert.equal(db.get(`SELECT COUNT(*) n FROM x_posts WHERE project_id = ? AND status = 'draft'`, p.id).n, 2);
  const alloc = db.get(`SELECT * FROM fee_allocations WHERE project_id = ?`, p.id);
  assert.deepEqual(JSON.parse(alloc.recipients_json).map((r) => [r.wallet, r.bps]), [[w.address, 8000], [SUB01_WALLET, 2000]]);
  assert.equal(db.get(`SELECT wallet FROM project_roles WHERE project_id = ? AND role = 'founder'`, p.id).wallet, w.address, 'founder role granted');
  const timeline = db.all(`SELECT message FROM events WHERE idea_id = ? AND public = 1`, id).map((e) => e.message);
  assert.ok(timeline.some((m) => m.includes('brain vote: build')));
});

test('brain says pass: declined, and no generation job', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fakeBrain('pass').fetchImpl);
  assert.equal(ideaStatus(db, id).status, 'declined');
  assert.equal(db.get(`SELECT COUNT(*) n FROM jobs WHERE type = 'generate'`).n, 0);
});

test('brain offline: stays evaluating, says so, no other system decides; dead after the bounded retries', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('offline');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, brain.fetchImpl, { max: 1 });
  const s = ideaStatus(db, id);
  assert.equal(s.status, 'evaluating');
  assert.match(s.status_note, /Nothing has been decided/);
  assert.equal(db.get('SELECT COUNT(*) n FROM evaluations').n, 0);
  // exhaust the attempts by jumping the clock forward
  let t = Date.now();
  for (let i = 0; i < 80; i++) { t += 3_600_000; await drain(db, cfg, brain.fetchImpl, { max: 1, t }); }
  assert.equal(ideaStatus(db, id).status, 'failed');
  assert.match(ideaStatus(db, id).status_note, /evaluation unavailable/);
  assert.equal(db.get(`SELECT status FROM jobs WHERE type = 'evaluate'`).status, 'dead');
  assert.equal(db.get('SELECT COUNT(*) n FROM evaluations').n, 0);
});

test('brain asleep: queued until he wakes, then decided', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('asleep');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, brain.fetchImpl, { max: 1 });
  assert.match(ideaStatus(db, id).status_note, /asleep/);
  const job = db.get(`SELECT * FROM jobs WHERE type = 'evaluate'`);
  assert.ok(job.run_after - Date.now() > 15 * 60_000, 'retries after ~20 minutes');
  brain.state.mode = 'build';
  await drain(db, cfg, brain.fetchImpl, { t: Date.now() + 21 * 60_000 });
  assert.equal(ideaStatus(db, id).status, 'preview_ready');
});

test('brain not configured: unavailable, never a substitute decision', async () => {
  const { cfg, db } = makeEnv({ BRAIN_URL: '' });
  const w = user(db);
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fakeBrain('build').fetchImpl, { max: 1 });
  assert.equal(ideaStatus(db, id).status, 'evaluating');
  assert.match(ideaStatus(db, id).status_note, /not configured/);
});

test('duplicate job delivery: same key enqueued twice is one job; a re-run handler changes nothing', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('build');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  const again = enqueue(db, { type: 'evaluate', key: `evaluate:${id}:v1`, ideaId: id });
  assert.equal(db.get(`SELECT COUNT(*) n FROM jobs WHERE type = 'evaluate'`).n, 1);
  await drain(db, cfg, brain.fetchImpl);
  // deliver the evaluate job again under a new key (a duplicate from outside)
  enqueue(db, { type: 'evaluate', key: `evaluate:${id}:dup`, ideaId: id });
  enqueue(db, { type: 'generate', key: `generate:${id}:dup`, ideaId: id });
  const ran = await drain(db, cfg, brain.fetchImpl);
  assert.ok(ran.every((r) => r.status === 'succeeded'));
  assert.equal(db.get('SELECT COUNT(*) n FROM evaluations').n, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM projects').n, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM site_versions').n, 1);
  assert.equal(ideaStatus(db, id).status, 'preview_ready');
  assert.ok(again.id);
});

test('crashed worker: an expired lease is requeued and finishes once', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('build');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  const job = claim(db, 'worker-a');                      // worker A takes it and "dies"
  assert.equal(job.status, 'running');
  const later = Date.now() + job.timeout_ms + 10_000;
  const again = claim(db, 'worker-b', later);             // reaped and claimed by B
  assert.equal(again.id, job.id);
  await runJob(db, again, handlers, { cfg, fetchImpl: brain.fetchImpl }, onDead);
  assert.equal(ideaStatus(db, id).status, 'selected');
});

test('generation failure: bounded retries, then failed with a reason', async () => {
  const { cfg, db } = makeEnv({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'test' });
  const w = user(db);
  const brain = fakeBrain('build');
  const failing = async (url, init) => (String(url).includes('anthropic') ? new Response('{}', { status: 529 }) : brain.fetchImpl(url, init));
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  let t = Date.now();
  for (let i = 0; i < 6; i++) { await drain(db, cfg, failing, { t }); t += 30 * 60_000; }
  assert.equal(ideaStatus(db, id).status, 'failed');
  assert.match(ideaStatus(db, id).status_note, /building failed: generator HTTP 529/);
  assert.equal(db.get(`SELECT attempts FROM jobs WHERE type = 'generate'`).attempts, 3);
});

test('generator output with markup or financial promises is rejected (unsafe generated content)', async () => {
  const { cfg, db } = makeEnv({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'test' });
  const w = user(db);
  const brain = fakeBrain('build');
  const evil = { name: 'Evil', ticker: 'EVIL', tagline: '<script>alert(1)</script>', description: 'guaranteed 100x returns for holders',
    sections: [{ heading: 'x', body: 'y' }], x: { handles: ['evilcoin'], bio: 'b', posts: ['p'] } };
  const gen = async (url, init) => (String(url).includes('anthropic')
    ? new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(evil) }], usage: { input_tokens: 10, output_tokens: 10 } }))
    : brain.fetchImpl(url, init));
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, gen);
  assert.equal(ideaStatus(db, id).status, 'failed');
  assert.equal(db.get('SELECT COUNT(*) n FROM site_versions').n, 0);
});

test('policy gate: promised returns are declined before the brain is asked', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('build');
  const id = submitIdea(db, cfg, w.address, IDEA(w, { concept: 'Holders get passive income and guaranteed returns every week from fees.' }));
  await drain(db, cfg, brain.fetchImpl);
  assert.equal(ideaStatus(db, id).status, 'declined');
  assert.equal(brain.state.calls, 0);
  assert.equal(db.get('SELECT decided_by FROM evaluations').decided_by, 'policy:promised_returns');
});

test('pauses: generation paused keeps the idea selected and queued', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  setSetting(db, 'pause.generation', true, 'test');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fakeBrain('build').fetchImpl);
  assert.equal(ideaStatus(db, id).status, 'selected');
});

test('global budget cap blocks paid generation', async () => {
  const { cfg, db } = makeEnv({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'k', GENERATOR_PRICE_IN_PER_MTOK: '1000', GENERATOR_PRICE_OUT_PER_MTOK: '1000', BUDGET_GLOBAL_DAILY_USD: '1' });
  const w = user(db);
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fakeBrain('build').fetchImpl);
  assert.equal(ideaStatus(db, id).status, 'selected');
  assert.match(ideaStatus(db, id).status_note, /budget/);
});

test('submissions: original kept; edits are versions; receiving wallet change is audited; privacy enforced', () => {
  const { cfg, db } = makeEnv();
  const w = user(db), w2 = wallet(), stranger = user(db);
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  editIdea(db, id, w.address, IDEA(w, { receivingWallet: w2.address, title: 'Ramen Radar 2' }));
  const vs = db.all('SELECT version, title, receiving_wallet FROM idea_versions WHERE idea_id = ? ORDER BY version', id);
  assert.deepEqual(vs.map((v) => v.title), ['Ramen Radar', 'Ramen Radar 2']);
  assert.equal(vs[0].receiving_wallet, w.address);
  assert.ok(db.get(`SELECT 1 FROM events WHERE idea_id = ? AND message LIKE '%receiving wallet changed%'`, id));
  assert.equal(viewIdea(db, id, { wallet: stranger.address, role: 'user' }), null);
  assert.equal(viewIdea(db, id, null), null);
  assert.equal(viewIdea(db, id, { wallet: w.address, role: 'user' }).title, 'Ramen Radar 2');
  assert.throws(() => editIdea(db, id, stranger.address, IDEA(stranger)), { code: 'not_found' });
});

test('submission validation: bad wallet, SUB-01 mint as wallet, SVG upload, missing rights confirmation', () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  assert.throws(() => submitIdea(db, cfg, w.address, IDEA(w, { receivingWallet: 'nope' })), { code: 'invalid' });
  assert.throws(() => submitIdea(db, cfg, w.address, IDEA(w, { receivingWallet: '6WCtKQfkWurd77tCCAYWuL5TwyAvuovTzworfnfupump' })), { code: 'invalid' });
  assert.throws(() => submitIdea(db, cfg, w.address, IDEA(w, { rightsConfirmed: false })), { code: 'invalid' });
  assert.throws(() => submitIdea(db, cfg, w.address, IDEA(w, { links: ['javascript:alert(1)'] })), { code: 'invalid' });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.throws(() => submitIdea(db, cfg, w.address, IDEA(w, { images: [svg] })), { code: 'bad_type' });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
  assert.ok(submitIdea(db, cfg, w.address, IDEA(w, { images: [png] })));
});

test('per-wallet daily submission cap', () => {
  const { cfg, db } = makeEnv({ MAX_IDEAS_PER_WALLET_PER_DAY: '2' });
  const w = user(db);
  submitIdea(db, cfg, w.address, IDEA(w, { title: 'One idea here' }));
  submitIdea(db, cfg, w.address, IDEA(w, { title: 'Two idea here' }));
  assert.throws(() => submitIdea(db, cfg, w.address, IDEA(w, { title: 'Three idea' })), { code: 'daily_limit' });
});

test('receiving wallet changed after the build: the split is redrafted with the new wallet and needs approval again', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db), w2 = wallet();
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fakeBrain('build').fetchImpl);
  editIdea(db, id, w.address, IDEA(w, { receivingWallet: w2.address }));
  const rows = db.all(`SELECT status, recipients_json FROM fee_allocations ORDER BY version`);
  assert.deepEqual(rows.map((r) => r.status), ['superseded', 'draft']);
  assert.equal(JSON.parse(rows[1].recipients_json)[0].wallet, w2.address);
  assert.equal(db.get('SELECT submitter_approved_at a FROM projects').a, null);
});
