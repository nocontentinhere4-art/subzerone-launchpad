// The copy SUB-01 writes for a coin (generator.js): the app first, then the words for that app; the template when no
// model is set or the model fails; the rules every copy keeps; "Ask SUB-01 to rewrite" (rewrite.js) through the room PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, user, drain, IDEA, logs } from './helpers.js';
import { templateGenerate, anthropicGenerate, checkCopy, copyBrief, appFeatures, COPY_SYSTEM, DISCLAIMER } from '../src/generator.js';
import { composeRules } from '../src/composer.js';
import { loadConfig } from '../src/config.js';

const QWAVE = { title: 'Q-wave', name_suggestion: 'Q-wave', ticker_suggestion: 'QWAVE',
  concept: 'Q-wave is a permissionless launchpad where visitors launch real pump.fun coins from the site, with an ML-DSA-65 post-quantum registry of every launch. Honest note: Solana keys are Ed25519.' };
const RAMEN = { title: 'Ramen Radar', name_suggestion: 'Ramen Radar', ticker_suggestion: 'RAMEN', concept: 'A hand-drawn map of the best late-night ramen counters in Tokyo, kept by the people who eat there.' };
const BRAIN = { networks: { reward: 1, language: 0.8, attention: 0.5 }, vote: { options: [{ label: 'build: x', p: 0.62 }, { label: 'pass', p: 0.38 }], spiking: { used: true, n_neurons: 500000, net: 'cpu' } } };
const MEME = /just a meme|no promises|not financial advice/i;
const cfgOf = (env = {}) => loadConfig({ LAUNCHPAD_NO_DOTENV: '1', GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', ...env });

const GOOD = {
  name: 'Q-wave', ticker: 'QWAVE', tagline: 'The launchpad with a post-quantum registry of every launch.',
  description: 'Q-wave is a permissionless launchpad: anyone launches a real pump.fun coin from the page. Every launch is signed with ML-DSA-65 and verified in your browser.',
  sections: [{ heading: 'Launch from the page', body: 'Connect a wallet, name the coin, sign. SUB-01 reads each launch first; the creator fees are split on-chain and locked.' },
    { heading: 'A registry that outlasts Ed25519', body: 'Each launch is signed with ML-DSA-65. The coins use Solana keys (Ed25519) and are not quantum-proof; the registry is the post-quantum part.' },
    { heading: 'Where it comes from', body: 'An idea by nocontent. SUB-01\'s brain simulation voted to build it.' }],
  x: { handles: ['qwavepad', 'qwave_sol', 'QWAVE_sub01'], bio: 'Q-wave: launch real coins from one page, each signed into a post-quantum registry.',
    posts: ['Launch a pump.fun coin from the Q-wave page in three steps.', 'Every Q-wave launch is signed with ML-DSA-65; your browser checks the signature.'] },
};
/** A fake Anthropic API: the composer's call fails (rules), the copy call answers `copy` (or what `reply` returns). */
function fakeModel({ copy = GOOD, reply = null, composer = 'fail' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    if (body.system.includes('fixed DSL')) return composer === 'fail' ? new Response('{}', { status: 500 }) : composer(body);
    if (reply) return reply(body, calls.filter((c) => c.body.system === COPY_SYSTEM).length);
    return new Response(JSON.stringify({ model: body.model, content: [{ type: 'text', text: JSON.stringify(copy) }], stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 700 } }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('template: the copy presents the app SUB-01 composed; no meme filler; the legal note only in its own section', () => {
  const q = templateGenerate({ idea: QWAVE, brain: BRAIN, submitter: 'nocontent' }).spec;
  assert.equal(q.app.kind, 'launchpad');
  assert.equal(q.tagline, 'The launchpad with a post-quantum registry of every launch.');
  assert.match(q.description, /post-quantum registry of every launch/);
  assert.match(q.description, /Ed25519/);
  assert.equal(q.sections[0].heading, 'How it works');
  assert.match(q.sections[0].body, /launch a real pump\.fun coin/i);
  assert.match(q.sections.map((s) => s.body).join(' '), /ML-DSA-65/);
  assert.deepEqual(q.sections.at(-1), { heading: 'What this is', body: DISCLAIMER });
  for (const t of [q.tagline, q.description, q.x.bio, ...q.x.posts, ...q.sections.slice(0, -1).map((s) => s.body)]) assert.doesNotMatch(t, MEME, t);
  assert.doesNotMatch(DISCLAIMER, /meme/i);
  const credit = q.sections.map((s) => s.body).join(' ');
  assert.equal((credit.match(/nocontent/g) || []).length, 1, 'the submitter is credited once');
  assert.equal((credit.match(/brain simulation voted/g) || []).length, 1, 'the vote is mentioned once');
  assert.match(credit, /build 62% vs pass, 500k-neuron network on CPU/);
  const r = templateGenerate({ idea: RAMEN, brain: BRAIN }).spec;
  assert.equal(r.app.kind, 'places');
  assert.match(r.tagline, /guide to .*spots/);
  assert.ok(r.x.posts.length >= 2 && r.x.posts.every((p) => p.length <= 280));
  assert.ok(r.x.bio.length <= 160 && !/https?:/.test(r.x.bio));
});

test('model: the app is composed first and passed into the brief; JSON schema output; the configured model; the copy is the model\'s', async () => {
  const m = fakeModel();
  const out = await anthropicGenerate({ idea: QWAVE, brain: BRAIN, cfg: cfgOf(), fetchImpl: m.fetchImpl, submitter: 'nocontent' });
  assert.equal(out.generator, 'anthropic:claude-sonnet-5-5');
  assert.equal(out.fallback, undefined);
  assert.equal(out.spec.tagline, GOOD.tagline);
  assert.equal(out.spec.app.kind, 'launchpad', 'the composed app (the rules, since the composer call failed)');
  assert.deepEqual(out.spec.sections.at(-1), { heading: 'What this is', body: DISCLAIMER });
  const [composer, copy] = m.calls;
  assert.match(composer.body.system, /fixed DSL/, 'the composer runs first');
  assert.equal(copy.body.system, COPY_SYSTEM);
  assert.equal(copy.body.model, 'claude-sonnet-5-5');
  assert.equal(copy.body.output_config.format.type, 'json_schema');
  assert.equal(copy.body.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(copy.body.thinking, { type: 'between_tools' });
  assert.equal(copy.headers['x-api-key'], 'sk-test');
  const brief = copy.body.messages[0].content;
  for (const want of [/<idea>[\s\S]*Author: nocontent[\s\S]*<\/idea>/, /<app>[\s\S]*App kind: launchpad/, /ML-DSA-65/, /launch a real pump\.fun coin/i, /Fixed name: "Q-wave"\. Fixed ticker: "QWAVE"/,
    /build 62% vs pass, 500k-neuron network on CPU/, /Ed25519/]) assert.match(brief, want);
  assert.match(COPY_SYSTEM, /top product studio/);
  assert.doesNotMatch(COPY_SYSTEM, /playful/i);
  // the model is configurable
  const m2 = fakeModel();
  await anthropicGenerate({ idea: QWAVE, brain: BRAIN, cfg: cfgOf({ ANTHROPIC_MODEL: 'claude-opus-5-5' }), fetchImpl: m2.fetchImpl });
  assert.ok(m2.calls.every((c) => c.body.model === 'claude-opus-5-5'));
  assert.equal(m2.calls[1].body.thinking, undefined, 'Opus 5.5 runs its default thinking');
});

test('model: a rule broken once gets one retry with the reason; twice, or any HTTP error, and the template writes with a warning', async () => {
  // 1st answer says "Just a meme", the 2nd is clean
  const flaky = fakeModel({ reply: (body, n) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(n === 1 ? { ...GOOD, x: { ...GOOD.x, bio: 'Q-wave: a meme coin for the launchpad idea. Just a meme, no promises.' } } : GOOD) }], stop_reason: 'end_turn' }), { status: 200 }) });
  const ok = await anthropicGenerate({ idea: QWAVE, brain: BRAIN, cfg: cfgOf(), fetchImpl: flaky.fetchImpl });
  assert.equal(ok.generator, 'anthropic:claude-sonnet-5-5');
  assert.equal(ok.spec.x.bio, GOOD.x.bio);
  assert.match(flaky.calls.at(-1).body.messages[0].content, /A previous draft was refused: no "just a meme"/);
  // HTTP 400 with the API's message: the template, and a warning with the status and the message
  logs.length = 0;
  const bad = fakeModel({ reply: () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'workspace_id required' } }), { status: 400 }) });
  const fb = await anthropicGenerate({ idea: QWAVE, brain: BRAIN, cfg: cfgOf(), fetchImpl: bad.fetchImpl, submitter: 'nocontent' });
  assert.equal(fb.generator, 'template/1');
  assert.match(fb.fallback, /generator HTTP 400: workspace_id required/);
  assert.equal(fb.spec.tagline, 'The launchpad with a post-quantum registry of every launch.');
  const warn = logs.map((l) => JSON.parse(l)).find((l) => l.level === 'warn' && l.msg.startsWith('generator: the language model failed'));
  assert.equal(warn.status, 400);
  assert.ok(!logs.some((l) => l.includes('sk-test')), 'never the key');
  // refusal and network failure: the template too
  for (const reply of [() => new Response(JSON.stringify({ content: [], stop_reason: 'refusal' }), { status: 200 }), () => { throw new TypeError('fetch failed'); }]) {
    assert.equal((await anthropicGenerate({ idea: RAMEN, brain: BRAIN, cfg: cfgOf(), fetchImpl: fakeModel({ reply }).fetchImpl })).generator, 'template/1');
  }
  // no key: the template, no call
  const none = fakeModel();
  assert.equal((await anthropicGenerate({ idea: RAMEN, brain: BRAIN, cfg: cfgOf({ ANTHROPIC_API_KEY: '' }), fetchImpl: none.fetchImpl })).generator, 'template/1');
  assert.equal(none.calls.length, 0);
});

test('checkCopy: the hard rules (returns, holders, endorsements, consciousness, quantum claims, links, filler); credits added when missing', () => {
  const fixed = { name: 'Q-wave', ticker: 'QWAVE' };
  const bad = (patch, re) => assert.throws(() => checkCopy({ ...GOOD, ...patch }, { fixed }), re);
  bad({ tagline: 'Just a meme, no promises.' }, /just a meme/);
  bad({ description: 'Holders earn a share of every launch fee on Q-wave, forever and ever.' }, /holders|returns/);
  bad({ description: 'The official launchpad of Solana, for every coin and every builder out there.' }, /endorsements/);
  bad({ description: 'SUB-01 is a conscious machine that picks the coins he likes the most.' }, /conscious/);
  bad({ description: 'Q-wave coins are quantum-proof: launch once, stay safe from every quantum computer.' }, /quantum-proof/);
  bad({ description: 'Post-quantum fees for every coin launched from this page, signed and sealed.' }, /quantum/);
  bad({ x: { ...GOOD.x, bio: 'Launch coins at qwave.live with a post-quantum registry of every launch.' } }, /links/);
  bad({ tagline: 'A revolutionary launchpad with a registry of every launch.' }, /hype/);
  bad({ tagline: 'A <b>bold</b> launchpad with a registry for every launch.' }, /< >/);
  // honest negations and the registry are fine
  assert.ok(checkCopy({ ...GOOD, description: 'The coins are not quantum-proof: Solana keys are Ed25519. The quantum-safe registry signs every launch with ML-DSA-65.' }, { fixed }));
  // the fixed name and ticker win; the credit and the vote are added when the model forgot them
  const c = checkCopy({ ...GOOD, name: 'Other', ticker: 'OTH', sections: [{ heading: 'Launch', body: 'Launch from the page.' }], x: { ...GOOD.x, posts: ['One concrete thing.', 'Another concrete thing.'] } }, { fixed, submitter: 'nocontent' });
  assert.deepEqual([c.name, c.ticker], ['Q-wave', 'QWAVE']);
  assert.match(c.sections[0].body, /brain simulation voted to build it\. Idea by nocontent\.$/);
});

test('appFeatures: one plain sentence per block, from the app the site really has', () => {
  const app = composeRules(QWAVE, { name: 'Q-wave', ticker: 'QWAVE' }).app;
  const f = appFeatures(app, { name: 'Q-wave' });
  assert.deepEqual(f.map((x) => x.type), ['launch', 'pq']);
  assert.match(f[0].text, /70% to the coin's creator, 10% to Q-wave's author, 20% to SUB-01/);
  assert.match(f[1].text, /not quantum-proof/);
  const brief = copyBrief({ idea: RAMEN, brain: BRAIN, app: composeRules(RAMEN, { name: 'Ramen Radar', ticker: 'RAMEN' }).app, tools: [{ id: 'poll', config: {} }, { id: 'trades', config: {} }] });
  assert.match(brief, /Standard tools on this coin's own site \(the same kit on every SUBZERONE site, not customised to the idea; they do exactly what each line says\):\n- Poll: /);
  assert.match(brief, /Chain panels on this coin's own site that go live at launch: Live trades\./);
  assert.match(brief, /Name: use "Ramen Radar"/);
});

test('rewrite: owner only, a job writes the copy again (model), a new site version through the QA, the X drafts follow; 3 a day', async () => {
  const h = await harness({ GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' });
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const other = h.client(user(h.db));
    await other.signIn();
    // the first build: the model is down, the template writes
    const down = (url, init) => (String(url).includes('anthropic') ? Promise.resolve(new Response('{}', { status: 503 })) : h.brain.fetchImpl(url, init));
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, down);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const p = h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
    const v0 = p.live_site_version;
    assert.equal(h.db.get('SELECT generator FROM generations WHERE project_id = ?', p.id).generator, 'template/1');
    const ramen = { ...GOOD, name: 'Ramen Radar', ticker: 'RAMEN', tagline: 'Late-night ramen in Tokyo, mapped and voted by the people who eat there.',
      description: 'Ramen Radar is a community guide to the ramen counters that stay open late in Tokyo. Add a spot, vote the good ones up, find them on the map.',
      sections: [{ heading: 'Add a spot', body: 'Name the counter, the area and why it is worth the walk.' }, { heading: 'Where it comes from', body: 'SUB-01\'s brain simulation voted to build it.' }],
      x: { handles: ['ramenradar', 'ramen_sol', 'RAMEN_sub01'], bio: 'Ramen Radar: the late-night ramen map of Tokyo, written by the people who eat there.', posts: ['Add your late-night ramen counter to the Ramen Radar map.', 'Vote the best bowl in Shinjuku up.', 'The top ten counters, ranked by votes.'] } };
    const model = fakeModel({ copy: ramen });
    const live = (url, init) => (String(url).includes('anthropic') ? model.fetchImpl(url, init) : h.brain.fetchImpl(url, init));

    assert.equal((await other.call('POST', `/api/projects/${slug}/rewrite`, {})).status, 404, 'owner only');
    const r1 = await owner.call('POST', `/api/projects/${slug}/rewrite`, {});
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.json.queued, true);
    assert.equal(r1.json.left, 2);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/rewrite`, {})).json.already, true, 'one at a time');
    assert.equal((await owner.call('GET', `/api/projects/${slug}/rewrite`)).json.last.state, 'queued');
    await drain(h.db, h.cfg, live);
    const st = (await owner.call('GET', `/api/projects/${slug}/rewrite`)).json;
    assert.equal(st.last.state, 'done', JSON.stringify(st));
    assert.equal(st.last.generator, 'anthropic:claude-sonnet-5-5');
    assert.equal(st.last.version, v0 + 1);
    assert.equal(st.last.live, true);
    const fresh = h.db.get('SELECT * FROM projects WHERE id = ?', p.id);
    assert.equal(fresh.live_site_version, v0 + 1);
    assert.equal(fresh.name, 'Ramen Radar');
    assert.equal(fresh.description, ramen.description);
    const spec = JSON.parse(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p.id, v0 + 1).spec_json);
    assert.equal(spec.tagline, ramen.tagline);
    assert.equal(spec.app.kind, 'places', 'the app stays');
    assert.match(h.db.get('SELECT html FROM site_versions WHERE project_id = ? AND version = ?', p.id, v0 + 1).html, /Late-night ramen in Tokyo, mapped/);
    const brief = model.calls.find((c) => c.body.system === COPY_SYSTEM).body.messages[0].content;
    assert.match(brief, /Fixed name: "Ramen Radar"/);
    assert.match(brief, /App kind: places/);
    const drafts = h.db.all(`SELECT text FROM x_posts WHERE project_id = ? AND status = 'draft' ORDER BY created_at`, p.id).map((x) => x.text);
    assert.deepEqual(drafts, ramen.x.posts);
    assert.equal(h.db.get('SELECT planned_bio FROM x_accounts WHERE project_id = ?', p.id).planned_bio, ramen.x.bio);
    assert.match(h.db.get(`SELECT message FROM events WHERE project_id = ? AND kind = 'rewrite'`, p.id).message, /Copy rewritten by SUB-01 at the author's request/);
    // 3 a day
    await owner.call('POST', `/api/projects/${slug}/rewrite`, {}); await drain(h.db, h.cfg, live);
    await owner.call('POST', `/api/projects/${slug}/rewrite`, {}); await drain(h.db, h.cfg, live);
    const r4 = await owner.call('POST', `/api/projects/${slug}/rewrite`, {});
    assert.equal(r4.status, 429);
    assert.equal(r4.json.error, 'rewrite_limit');
    assert.equal((await owner.call('GET', `/api/projects/${slug}/rewrite`)).json.left, 0);
  } finally { h.close(); }
});

test('rewrite: launch_prepared -> the configuration is prepared again with the new description; refused once a transaction exists', async () => {
  const h = await harness({ REQUIRE_ADMIN_CLEARANCE: '0' });
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const proj = await owner.call('GET', `/api/projects/${slug}`);
    await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.json.allocation.id, statement: proj.json.allocation.statement, siteVersion: proj.json.liveSiteVersion });
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const status = () => h.db.get('SELECT status FROM ideas WHERE id = ?', sub.json.id).status;
    assert.equal(status(), 'launch_prepared');
    // an old description, as copy written before the new brief
    const p = h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
    h.db.run('UPDATE projects SET launch_config_json = json_set(launch_config_json, \'$.token.metadata.description\', \'Ramen Radar: a meme coin. Just a meme, no promises.\') WHERE id = ?', p.id);
    const r = await owner.call('POST', `/api/projects/${slug}/rewrite`, {});
    assert.equal(r.status, 200, r.text);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(status(), 'launch_prepared', 'approved, then prepared again by the job');
    const meta = JSON.parse(h.db.get('SELECT launch_config_json c FROM projects WHERE id = ?', p.id).c).token.metadata;
    assert.doesNotMatch(meta.description, MEME);
    assert.equal(meta.description, h.db.get('SELECT description FROM projects WHERE id = ?', p.id).description);
    // the live logo for the X kit: always the newest version, never cached
    const logo = await owner.call('GET', `/api/projects/${slug}/art/logo-live.png`);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal(logo.headers.get('cache-control'), 'no-store');
    assert.match((await owner.call('GET', `/api/projects/${slug}/art`)).json.live.bannerUrl, /\/art\/banner-live\.png$/);
    const tx = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(tx.status, 200, tx.text);
    const locked = await owner.call('POST', `/api/projects/${slug}/rewrite`, {});
    assert.equal(locked.status, 409);
    assert.equal((await owner.call('GET', `/api/projects/${slug}/rewrite`)).json.allowed, false);
  } finally { h.close(); }
});
