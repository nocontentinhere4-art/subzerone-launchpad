// The verdict in seconds: the in-process kick, SUB-01's feedback (rules, brain record, optional polish), the revise
// loop (versions, limits, declined -> evaluating -> selected), the live SSE `verdict` frame and migration 008.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, makeEnv, user, fakeBrain, drain, IDEA, ideaStatus } from './helpers.js';
import { submitIdea, reviseIdea, viewIdea, publishIdea, MAX_VERSIONS } from '../src/ideas.js';
import { buildFeedback, validatePolish, polishFeedback } from '../src/feedback.js';
import { preGate } from '../src/scorecard.js';
import { UNAVAILABLE_BACKOFF } from '../src/pipeline.js';
import { createKicker } from '../src/kick.js';
import { claimKey } from '../src/jobs.js';

const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
async function signedIn(h, role = 'user') { const c = h.client(user(h.db, role)); await c.signIn(); return c; }

/** A small SSE reader (as in chat.test.js): collects frames by event name. */
async function sse(h, c) {
  const ac = new AbortController();
  const res = await fetch(`${h.base}/api/chat/stream`, { headers: c?.cookie ? { cookie: c.cookie } : {}, signal: ac.signal });
  const events = [];
  let raw = '';
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        const s = dec.decode(chunk, { stream: true });
        raw += s; buf += s;
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
  return { events, get raw() { return raw; }, of: (name) => events.filter((e) => e.event === name).map((e) => e.data), close: () => ac.abort() };
}

test('migration 008: feedback_json and latency_ms on evaluations, on a fresh database', () => {
  const { db } = makeEnv();
  const cols = db.all('PRAGMA table_info(evaluations)').map((c) => c.name);
  assert.ok(cols.includes('feedback_json') && cols.includes('latency_ms'));
  assert.ok(db.get(`SELECT 1 FROM schema_migrations WHERE name = '008_feedback.sql'`));
});

test('kick: the verdict lands within the request\'s wake, without a worker sweep; the view carries feedback, latency and versions', async () => {
  const h = await harness({}, { kick: true });
  try {
    const owner = await signedIn(h);
    const t0 = Date.now();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    assert.equal(sub.status, 200, sub.text);
    await until(() => h.db.get('SELECT 1 FROM evaluations WHERE idea_id = ?', sub.json.id));
    const ms = Date.now() - t0;
    const idea = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json;
    assert.equal(idea.status, 'selected', 'decided; the build job is the worker\'s');
    assert.equal(idea.evaluation.verdict, 'build');
    assert.equal(typeof idea.evaluation.latencyMs, 'number');
    assert.ok(idea.evaluation.latencyMs >= 0 && idea.evaluation.latencyMs <= ms + 50, `latency ${idea.evaluation.latencyMs} within ${ms} ms`);
    assert.equal(idea.evaluation.feedback.version, 'feedback/1');
    assert.match(idea.evaluation.feedback.summary, /^Build\./);
    assert.deepEqual(idea.versions.map((v) => [v.version, v.decision]), [[1, 'build']]);
    assert.equal(idea.canRevise, false);
    assert.equal(idea.eta, null);
    assert.equal(h.brain.state.calls, 1);
    assert.equal(h.db.get(`SELECT status, locked_by FROM jobs WHERE type = 'evaluate'`).status, 'succeeded');
    // the worker finds nothing left to claim for that key
    assert.equal(claimKey(h.db, 'worker', `evaluate:${sub.json.id}:v1`), null);
  } finally { h.close(); }
});

test('kick: the same key cannot run twice (lease), and a kick on a missing key is a no-op', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('build');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  const k = createKicker({ db, cfg, fetchImpl: brain.fetchImpl });
  const [a, b, c] = await Promise.all([k.kick(`evaluate:${id}:v1`), k.kick(`evaluate:${id}:v1`), k.kick('evaluate:nope:v1')]);
  assert.equal(a.status, 'succeeded');
  assert.equal(b, a, 'the second kick joined the first');
  assert.equal(c, null);
  assert.equal(brain.state.calls, 1);
  assert.equal(ideaStatus(db, id).status, 'selected');
  k.close();
});

test('feedback from fired rules: promised returns -> pass with the concrete suggestion; no market facts invented', () => {
  const input = { title: 'Yield Cat', concept: 'A cat coin with guaranteed returns and passive income for every holder, 10x gains by Friday.', nameSuggestion: 'Yield Cat', tickerSuggestion: 'YCAT' };
  const pre = preGate(input, []);
  const f = buildFeedback({ input, pre, rec: null, decision: 'declined' });
  assert.equal(f.source, 'rules');
  assert.deepEqual(f.facts.rules, ['policy:promised_returns']);
  assert.match(f.summary, /^Pass, before I even read it properly: promises returns/);
  assert.equal(f.suggestions[0].what, 'Drop every promise of money');
  assert.match(f.suggestions[0].how, /what people do with it/);
  assert.equal(f.confidence, 1);
  assert.match(f.wouldBuildIf, /^drop every promise of money/);
  assert.ok(f.likes.some((l) => l.includes('$YCAT')), 'the name is a like');
  assert.ok(!/guaranteed|10x/i.test(JSON.stringify([f.summary, f.suggestions, f.wouldBuildIf])), 'the promise is not echoed');
});

test('feedback: a duplicate names the earlier idea only when it is public', () => {
  const { cfg, db } = makeEnv();
  const a = user(db), b = user(db);
  const first = submitIdea(db, cfg, a.address, IDEA(a));
  const second = submitIdea(db, cfg, b.address, IDEA(b, { receivingWallet: b.address }));
  const others = db.all(`SELECT i.id, i.visibility, v.title, v.concept FROM ideas i JOIN idea_versions v ON v.idea_id = i.id WHERE i.id = ?`, first);
  const input = { title: 'Ramen Radar', concept: IDEA(b).concept };
  const priv = buildFeedback({ input, pre: preGate(input, others), rec: null, decision: 'declined', others });
  assert.equal(priv.facts.rules[0], 'policy:duplicate');
  assert.ok(!JSON.stringify(priv).includes('"Ramen Radar"'), 'a private idea\'s title never leaks');
  publishIdea(db, first, a.address, true);
  const pubOthers = db.all(`SELECT i.id, i.visibility, v.title, v.concept FROM ideas i JOIN idea_versions v ON v.idea_id = i.id WHERE i.id = ?`, first);
  const pub = buildFeedback({ input, pre: preGate(input, pubOthers), rec: null, decision: 'declined', others: pubOthers });
  assert.match(pub.suggestions[0].why, /It reads like "Ramen Radar", which is already in my room/);
  assert.ok(second);
});

test('feedback from the brain record: networks become likes, a pass gets his reasons and a "would build if"', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('pass');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, brain.fetchImpl);
  const f = viewIdea(db, id, { wallet: w.address }).evaluation.feedback;
  assert.equal(f.source, 'rules+brain');
  assert.match(f.summary, /^Pass\./);
  assert.ok(f.likes.some((l) => /reward 1\.00/.test(l)), `likes: ${f.likes}`);
  assert.equal(f.confidence, 0.8, '1 - p(build)');
  assert.equal(f.facts.buildP, 0.2);
  assert.ok(f.context.some((c) => c.startsWith('Vote note:')));
  assert.ok(f.context.some((c) => /demo brain/.test(c)));
  assert.ok(typeof f.wouldBuildIf === 'string' && f.wouldBuildIf.length > 10);
  assert.ok(f.suggestions.every((s) => s.what && s.why && s.how));
  // a build: no "would build if", confidence = p(build)
  const w2 = user(db);
  const id2 = submitIdea(db, cfg, w2.address, IDEA(w2, { title: 'Soba Signal', concept: 'A coin for a hand-drawn map of the quiet soba counters near Tokyo stations, kept by the people who eat there.', nameSuggestion: 'Soba Signal', tickerSuggestion: 'SOBA' }));
  await drain(db, cfg, fakeBrain('build').fetchImpl, { max: 1 });
  const g = viewIdea(db, id2, { wallet: w2.address }).evaluation.feedback;
  assert.match(g.summary, /^Build\./);
  assert.equal(g.wouldBuildIf, null);
  assert.equal(g.confidence, 0.8);
});

test('polish: a configured language model rewrites the text, the row keeps the rule text and the cost; guardrails refuse promises', async () => {
  const env = { GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'test-key', GENERATOR_PRICE_IN_PER_MTOK: '3', GENERATOR_PRICE_OUT_PER_MTOK: '15' };
  const { cfg, db } = makeEnv(env);
  const w = user(db);
  const brain = fakeBrain('pass');
  let reply = { summary: 'Pass. Reward 1.00 lit up, the rest did not. Give it a twist, then drop it again.', dislikes: ['It is a map; maps are quiet.'],
    suggestions: [{ what: 'Give it a twist', why: 'Nothing new in the text.', how: 'One object nobody else has.' }], wouldBuildIf: 'it had one object nobody else has.' };
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('api.anthropic.com')) {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: `Here you go:\n${JSON.stringify(reply)}` }], usage: { input_tokens: 800, output_tokens: 300 } }), { status: 200 });
    }
    return brain.fetchImpl(url, init);
  };
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  const ran = await drain(db, cfg, fetchImpl, { max: 1 });
  assert.equal(ran[0].status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].system.includes('never the word "guaranteed"'));
  const f = viewIdea(db, id, { wallet: w.address }).evaluation.feedback;
  assert.equal(f.source, 'llm');
  assert.equal(f.summary, reply.summary);
  assert.equal(f.rulesText.summary.startsWith('Pass.'), true, 'the rule text stays beside the polish');
  assert.equal(f.polished.generator, 'anthropic:claude-sonnet-5-5');
  assert.equal(f.polished.costUsd, (800 * 3 + 300 * 15) / 1e6);
  assert.equal(db.get(`SELECT usd FROM spend WHERE kind = 'feedback'`).usd, (800 * 3 + 300 * 15) / 1e6);
  // once per version: a second polish is a no-op
  const ev = db.get('SELECT id FROM evaluations WHERE idea_id = ?', id);
  assert.deepEqual(await polishFeedback(db, cfg, { evaluationId: ev.id, idea: { title: 'x', concept: 'y' }, fetchImpl }), { done: false, why: 'already polished' });
  assert.equal(calls.length, 1);
  // guardrails: markup, financial promises, or the launchpad's returns regex -> refused, rule text kept
  const base = { wouldBuildIf: 'x', suggestions: [{ what: 'a', why: 'b', how: 'c' }] };
  assert.equal(validatePolish({ ...reply, summary: 'Build. Guaranteed returns.' }, base), null);
  assert.equal(validatePolish({ ...reply, summary: 'Build. <b>bold</b>' }, base), null);
  assert.equal(validatePolish({ ...reply, summary: 'Pass. Airdrop to holders next week.' }, base), null);
  assert.equal(validatePolish({ ...reply, suggestions: [] }, base), null, 'no suggestions where the rules had some');
  assert.ok(validatePolish(reply, base));
  // no model configured: nothing is called, the rule text stands
  const plain = makeEnv();
  const w2 = user(plain.db);
  const id2 = submitIdea(plain.db, plain.cfg, w2.address, IDEA(w2));
  await drain(plain.db, plain.cfg, fetchImpl, { max: 1 });
  assert.equal(viewIdea(plain.db, id2, { wallet: w2.address }).evaluation.feedback.source, 'rules+brain');
  assert.equal(calls.length, 1);
  reply = null;
});

test('brain offline: short retries first (5 s, 15 s, 60 s), a visible note and eta, nothing decided', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const brain = fakeBrain('offline');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  let t = Date.now();
  for (const [i, delay] of UNAVAILABLE_BACKOFF.entries()) {
    await drain(db, cfg, brain.fetchImpl, { max: 1, t });
    const job = db.get(`SELECT run_after, attempts FROM jobs WHERE type = 'evaluate'`);
    assert.equal(job.attempts, i + 1);
    assert.ok(Math.abs(job.run_after - (Date.now() + delay)) < 1500, `attempt ${i + 1} retries after ${delay} ms`);
    const view = viewIdea(db, id, { wallet: w.address });
    assert.equal(view.status, 'evaluating');
    assert.equal(view.eta, job.run_after);
    assert.match(view.statusNote, /SUB-01 is offline right now .*Next try in .*Nothing has been decided/);
    assert.equal(view.evaluation, null);
    t = job.run_after + 1;
  }
  // after the short ones the job policy's minutes take over
  await drain(db, cfg, brain.fetchImpl, { max: 1, t });
  assert.ok(db.get(`SELECT run_after FROM jobs WHERE type = 'evaluate'`).run_after - Date.now() > 5 * 60_000);
  assert.ok(cfg.brain.timeoutMs <= 8000, 'a sick brain is given at most 8 s');
});

test('revise loop: pass -> PATCH -> evaluating -> build, every verdict kept, limits (60 s per wallet, 5 versions, 409 when not declined)', async () => {
  const h = await harness({}, { kick: true });
  try {
    const owner = await signedIn(h);
    h.brain.state.mode = 'pass';
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await until(() => ideaStatus(h.db, sub.json.id).status === 'declined');
    let view = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json;
    assert.equal(view.canRevise, true);
    assert.equal(view.nextVersionAt, null);
    assert.equal(view.maxVersions, MAX_VERSIONS);
    const other = await signedIn(h);
    assert.equal((await other.call('PATCH', `/api/ideas/${sub.json.id}`, IDEA(other.w))).status, 404, 'not the author');
    h.brain.state.mode = 'build';
    const rev = await owner.call('PATCH', `/api/ideas/${sub.json.id}`, IDEA(owner.w, { concept: 'A hand-drawn map of the best late-night ramen in Tokyo, redrawn every week by whoever ate the most bowls; the map is the coin.' }));
    assert.equal(rev.status, 200, rev.text);
    assert.deepEqual(rev.json, { id: sub.json.id, version: 2, maxVersions: MAX_VERSIONS });
    await until(() => ideaStatus(h.db, sub.json.id).status === 'selected');
    view = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json;
    assert.equal(view.version, 2);
    assert.deepEqual(view.versions.map((v) => [v.version, v.decision]), [[1, 'pass'], [2, 'build']]);
    assert.equal(view.evaluation.version, 2);
    assert.equal(view.evaluation.verdict, 'build');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM evaluations WHERE idea_id = ?', sub.json.id).n, 2, 'history by version');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM vote_ledger').n, 2, 'one ledger row per brain answer, append-only');
    assert.ok(h.db.get(`SELECT 1 FROM jobs WHERE idempotency_key = ?`, `evaluate:${sub.json.id}:v2`));
    assert.equal((await owner.call('PATCH', `/api/ideas/${sub.json.id}`, IDEA(owner.w))).json.error, 'not_declined');
    // one resubmit a minute per wallet: a second declined idea of the same wallet waits
    h.brain.state.mode = 'pass';
    const second = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: 'Soba Signal', concept: 'A coin for a hand-drawn map of the quiet soba counters near Tokyo stations, kept by the people who eat there.' }));
    await until(() => ideaStatus(h.db, second.json.id).status === 'declined');
    const fast = await owner.call('PATCH', `/api/ideas/${second.json.id}`, IDEA(owner.w, { title: 'Soba Signal', concept: 'A coin for a hand-drawn map of the quiet soba counters near Tokyo stations, kept by the people who eat there, with a weekly bowl count.' }));
    assert.equal(fast.status, 429);
    assert.equal(fast.json.error, 'too_fast');
    assert.ok(fast.json.retryAfterS >= 1 && fast.json.retryAfterS <= 60);
    view = (await owner.call('GET', `/api/ideas/${second.json.id}`)).json;
    assert.equal(typeof view.nextVersionAt, 'number');
    assert.equal(view.canRevise, true, 'allowed, just not yet');
    // the plot: released on the pass, claimable again with the revision (direct calls, no wait); then the version cap
    const { cfg, db } = h;
    const w3 = user(db);
    const passing = createKicker({ db, cfg, fetchImpl: fakeBrain('pass').fetchImpl });
    const third = submitIdea(db, cfg, w3.address, { ...IDEA(w3), plotId: 'ginza-1' });
    assert.equal((await passing.kick(`evaluate:${third}:v1`)).status, 'succeeded');
    assert.equal(db.get(`SELECT COUNT(*) n FROM plots WHERE idea_id = ?`, third).n, 0, 'the pass gave the plot back');
    reviseIdea(db, third, w3.address, { ...IDEA(w3), plotId: 'ginza-1' });
    assert.equal(db.get(`SELECT plot_id FROM plots WHERE idea_id = ?`, third).plot_id, 'ginza-1');
    assert.equal(ideaStatus(db, third).status, 'evaluating');
    for (let v = 2; v < MAX_VERSIONS; v++) {
      assert.equal((await passing.kick(`evaluate:${third}:v${v}`)).status, 'succeeded');
      db.run(`DELETE FROM events WHERE kind = 'revise'`);
      assert.equal(reviseIdea(db, third, w3.address, IDEA(w3)).version, v + 1);
    }
    assert.equal((await passing.kick(`evaluate:${third}:v${MAX_VERSIONS}`)).status, 'succeeded');
    passing.close();
    db.run(`DELETE FROM events WHERE kind = 'revise'`);
    const capView = viewIdea(db, third, { wallet: w3.address });
    assert.equal(capView.version, MAX_VERSIONS);
    assert.equal(capView.status, 'declined');
    assert.equal(capView.canRevise, false);
    assert.deepEqual(capView.versions.map((x) => x.decision), ['pass', 'pass', 'pass', 'pass', 'pass']);
    assert.throws(() => reviseIdea(db, third, w3.address, IDEA(w3)), (e) => e.status === 409 && e.code === 'max_versions');
  } finally { h.close(); }
});

test('SSE verdict: a private idea reaches only its author, without a title on any public stream; a public one reaches everyone with the title', async () => {
  const h = await harness({}, { kick: true });
  try {
    const owner = await signedIn(h);
    const bystander = await signedIn(h);
    const anon = await sse(h), mine = await sse(h, owner), theirs = await sse(h, bystander);
    h.brain.state.mode = 'pass';
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await until(() => mine.of('verdict').length === 1);
    const v = mine.of('verdict')[0];
    assert.equal(v.ideaId, sub.json.id);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.status, 'declined');
    assert.equal(v.private, true);
    assert.equal(v.title, undefined, 'no title even for the author: the view has it');
    assert.equal(typeof v.latencyMs, 'number');
    assert.match(v.summary, /^Pass\./);
    assert.equal(anon.of('verdict').length, 0);
    assert.equal(theirs.of('verdict').length, 0);
    assert.ok(!anon.raw.includes('Ramen Radar') && !theirs.raw.includes('Ramen Radar'), 'a private title reached a public stream');
    // published, then revised: the verdict is public, with the title and the plot
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    h.db.run(`DELETE FROM events WHERE kind = 'revise'`);
    h.brain.state.mode = 'build';
    const rev = await owner.call('PATCH', `/api/ideas/${sub.json.id}`, { ...IDEA(owner.w), plotId: 'shibuya-1' });
    assert.equal(rev.status, 200, rev.text);
    await until(() => anon.of('verdict').length === 1);
    const pub = anon.of('verdict')[0];
    assert.equal(pub.ideaId, sub.json.id);
    assert.deepEqual([pub.version, pub.verdict, pub.status, pub.private, pub.title, pub.plotId], [2, 'build', 'selected', false, 'Ramen Radar', 'shibuya-1']);
    assert.equal(theirs.of('verdict').length, 1);
    assert.equal(mine.of('verdict').length, 2);
    assert.ok(!anon.raw.includes(owner.w.address), 'no wallet on the stream');
    anon.close(); mine.close(); theirs.close();
  } finally { h.close(); }
});
