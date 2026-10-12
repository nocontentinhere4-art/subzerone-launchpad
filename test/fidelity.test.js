// Does it match the idea? (src/fidelity.js): the idea's core features against the composed app, the tools that serve it,
// the honest words that follow, the build timeline step, the API fields and the admin list. The PadPad case (2026-10-12):
// "a launchpad for launchpads; fees up the family tree; the live family tree; a neighbourhood in the city" was shipped as
// a plain launchpad with a meme maker and a map, and nobody was told. Never again silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, makeEnv, user, drain, fakeBrain, IDEA } from './helpers.js';
import { fitIdea, rulesFit, rulesCore, validateFidelity, finish, honestyProblem, honestApp, kit, optionalTools, presentParts, FIT_SYSTEM, FIT_SCHEMA,
  fitBrief, CAPABILITIES, fidelityView, topMissing, recordFidelity, aboutPlaces } from '../src/fidelity.js';
import { templateGenerate, anthropicGenerate, checkCopy, builtText, COPY_SYSTEM } from '../src/generator.js';
import { composeRules } from '../src/composer.js';
import { BLOCK_TYPES, BLOCKS } from '../src/app-blocks.js';
import { CATALOG, TRUST } from '../src/tools.js';
import { buildView, fitNote, PIPELINE } from '../src/build-steps.js';
import { submitIdea } from '../src/ideas.js';
import { loadConfig } from '../src/config.js';

const PADPAD = { title: 'PadPad', name_suggestion: 'PadPad', ticker_suggestion: 'PADPAD',
  concept: 'PadPad: a launchpad for launchpads. Every launchpad born here can launch coins that can be launchpads too. Creator fees flow up the family tree (creator, parent, grandparent, SUB-01). The site shows the live family tree. In the city every launchpad becomes a building with its children as a neighbourhood.' };
const KONBINI = { title: 'Konbini Confession', name_suggestion: 'Konbini Confession', ticker_suggestion: 'KONBINI',
  concept: 'Konbini Confession: every night people drop an anonymous confession at the konbini; at 23:00 JST one gets printed on the receipt.' };
// an idea the kit cannot fully build (since PadPad itself now can: family.js)
const CATRACE = { title: 'Cat Racer', concept: 'Cat Racer: a multiplayer racing game in the browser where an AI generates your cat.' };
const RAMEN = { title: 'Ramen Radar', name_suggestion: 'Ramen Radar', ticker_suggestion: 'RAMEN', concept: 'A hand-drawn map of the best late-night ramen counters in Tokyo, kept by the people who eat there.' };
const BRAIN = { networks: { reward: 1, language: 0.8 }, vote: { options: [{ label: 'build: x', p: 0.7 }, { label: 'pass', p: 0.3 }], spiking: { used: false } } };
const cfgOf = (env = {}) => loadConfig({ LAUNCHPAD_NO_DOTENV: '1', GENERATOR: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', ...env });
const fitFor = (idea, built = null) => { const name = idea.name_suggestion; const app = built || composeRules(idea, { name, ticker: idea.ticker_suggestion }).app; return { app, ...rulesFit({ idea, app, name, ticker: idea.ticker_suggestion }) }; };
// what PadPad was built as before the launchpad families existed (2026-10-12): a plain launchpad. The gap checks below
// keep reading it against the PadPad idea; the composer now builds the real thing (test 'PadPad now', family.test.js).
const SHIPPED = composeRules({ title: 'PadPad', concept: 'A launchpad where anyone can launch a coin.' }, { name: 'PadPad', ticker: 'PADPAD' }).app;
const by = (f, cap) => f.core.find((x) => x.capability === cap);
const ok = (j) => new Response(JSON.stringify({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(j) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 300 } }), { status: 200 });

// what a language model answers for PadPad, overclaiming twice (the rules must correct it) and adding a map
const PADPAD_FIT = {
  core: [
    { feature: 'A launchpad anyone can launch coins from', capability: 'launchpad', status: 'built', builtBy: ['launch'], reason: 'The launch block launches real coins.', terms: ['launch a coin'] },
    { feature: 'Launchpads that launch launchpads', capability: 'recursive-launchpads', status: 'missing', builtBy: [], reason: 'Coins launched here cannot host launches.', terms: ['launchpad for launchpads', 'recursive'] },
    { feature: 'Creator fees flow up the family tree', capability: 'fee-tree', status: 'built', builtBy: ['launch'], reason: 'The launch block splits fees.', terms: ['grandparent', 'fee tree'] },
    { feature: 'The live family tree on the site', capability: 'family-tree-view', status: 'built', builtBy: ['launch'], reason: 'The launch list shows the coins.', terms: ['family tree'] },
  ],
  tools: [{ id: 'map', reason: 'the city neighbourhoods' }, { id: 'memes', reason: 'fun' }],
};

// --- the schema ------------------------------------------------------------------------------------------------------
test('schema: validateFidelity normalises a good result and refuses every malformed one', () => {
  const good = { v: 1, source: 'rules', core: [{ feature: 'A thing', capability: 'A Thing!', status: 'built', builtBy: ['launch'], reason: 'It is there.', terms: ['thing'] }],
    tools: [{ id: 'poll', why: 'the idea asks people to choose' }], built: 'a site', message: 'I built it.' };
  const f = validateFidelity(good);
  assert.equal(f.verdict, 'match');
  assert.equal(f.core[0].capability, 'a-thing');
  assert.equal(f.model, null);
  assert.equal(f.fallback, null);
  const bad = [
    null, { ...good, v: 2 }, { ...good, source: 'gpt' }, { ...good, core: [] }, { ...good, core: Array(6).fill(good.core[0]) },
    { ...good, core: [{ ...good.core[0], status: 'done' }] },
    { ...good, core: [{ ...good.core[0], builtBy: [] }] },                                // built with nothing behind it
    { ...good, core: [{ ...good.core[0], status: 'partial', builtBy: [] }] },
    { ...good, core: [{ ...good.core[0], builtBy: ['<script>'] }] },
    { ...good, core: [good.core[0], good.core[0]] },                                       // the same capability twice
    { ...good, core: [{ ...good.core[0], terms: ['a', 'b', 'c', 'd', 'e'] }] },
    { ...good, tools: [{ id: 'wall', why: 'always' }] },                                   // the fixed tools are not picks
    { ...good, tools: [{ id: 'trades', why: 'always' }] },
    { ...good, tools: [{ id: 'poll', why: '' }] },
    { ...good, tools: [{ id: 'poll', why: 'a' }, { id: 'drop', why: 'b c' }, { id: 'event', why: 'd e' }, { id: 'memes', why: 'f g' }] },
    { ...good, verdict: 'missing' },                                                       // the verdict follows the features
    { ...good, built: '' },
  ];
  for (const b of bad) assert.throws(() => validateFidelity(b), /fidelity:/, JSON.stringify(b)?.slice(0, 80));
  // markup never survives
  assert.doesNotMatch(JSON.stringify(validateFidelity({ ...good, message: 'I <b>built</b> `it`' })), /[<>`]/);
});

test('the kit is read at call time: every block type and tool, with its own line; new blocks count by themselves', () => {
  const k = kit();
  assert.deepEqual(k.blocks.map((b) => b.id), BLOCK_TYPES);
  for (const b of k.blocks) assert.equal(b.line, BLOCKS[b.id].line);
  assert.deepEqual(k.tools.map((t) => t.id), Object.keys(CATALOG));
  BLOCK_TYPES.push('zzblock');
  try { assert.ok(kit().blocks.some((b) => b.id === 'zzblock'), 'a block added to app-blocks.js is in the kit'); } finally { BLOCK_TYPES.pop(); }
  assert.deepEqual(optionalTools(), Object.keys(CATALOG).filter((id) => !['token', 'wall'].includes(id) && !TRUST.includes(id)));
  assert.deepEqual(FIT_SCHEMA().properties.tools.items.properties.id.enum, optionalTools());
  // the evidence is the vetted catalog lines of the parts present, never a title
  const { app } = fitFor(PADPAD, SHIPPED);
  const parts = presentParts({ ...app, title: 'PadPad: the live family tree of launchpads that launch launchpads' }, []);
  assert.ok(parts.ids.has('launch'));
  assert.ok(!/family tree/.test(parts.evidence), 'a title is a label, not evidence');
  const brief = fitBrief({ idea: PADPAD, app, tools: [], name: 'PadPad' });
  for (const want of [/<idea>[\s\S]*launchpad for launchpads[\s\S]*<\/idea>/, /<kit>[\s\S]*- launch \(Launch a coin\):/, /<built>[\s\S]*- launch:/, /<optional>[\s\S]*- map/]) assert.match(brief, want);
});

// --- the PadPad case -------------------------------------------------------------------------------------------------
test('PadPad as it shipped (rules): the recursion, the fee tree, the family tree and the neighbourhood are flagged; no map, no meme maker', () => {
  const r = fitFor(PADPAD, SHIPPED), f = r.fidelity;
  assert.equal(f.source, 'rules');
  assert.equal(f.verdict, 'missing');
  assert.equal(by(f, 'launchpad-app').status, 'built', 'the plain launchpad is really there');
  assert.equal(by(f, 'recursive-launchpads').status, 'missing');
  assert.equal(by(f, 'fee-tree').status, 'partial');
  assert.match(by(f, 'fee-tree').reason, /one level: 70% creator, 10% this coin's author, 20% SUB-01\. Nothing flows further up/);
  assert.equal(by(f, 'family-tree-view').status, 'missing');
  assert.equal(by(f, 'city-neighbourhood').status, 'built', 'the city neighbourhood is the platform\'s (fidelity.js PLATFORM, family-neighbourhood)');
  const ids = r.tools.map((t) => t.id);
  assert.ok(!ids.includes('map') && !ids.includes('memes'), ids.join());
  assert.deepEqual(ids.filter((id) => !TRUST.includes(id)), ['token', 'wall'], 'the wall is the one default community tool');
  assert.ok(TRUST.every((id) => ids.includes(id)), 'the chain panels stay for every coin');
  assert.deepEqual(f.tools, [], 'nothing beyond the app serves this idea');
  // SUB-01 says it, in his voice
  assert.match(f.message, /^I can't build launchpads that launch launchpads .*yet\. The launch block launches plain coins/);
  assert.match(f.message, /I can't build a live family tree/);
  assert.match(f.message, /What I built instead: PadPad: launch a coin here/);
  assert.match(f.message, /You can still publish it as it is\./);
  assert.match(fitNote(f), /^Not all of it\. Missing: Launchpads that launch launchpads; A live family tree/);
  assert.ok(fitNote(f).length <= 200);
});

test('PadPad (model): the model\'s overclaims are corrected by the rules, its map dropped (no places), one call with a JSON schema', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); calls.push(body); return ok(PADPAD_FIT); };
  const app = SHIPPED;
  const r = await fitIdea({ idea: PADPAD, app, name: 'PadPad', ticker: 'PADPAD', cfg: cfgOf(), fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, FIT_SYSTEM);
  assert.equal(calls[0].output_config.format.type, 'json_schema');
  const f = r.fidelity;
  assert.equal(f.source, 'model'); assert.equal(f.model, 'claude-sonnet-5-5');
  assert.equal(r.fallback, undefined);
  assert.equal(by(f, 'launchpad').status, 'built');
  assert.equal(by(f, 'recursive-launchpads').status, 'missing');
  assert.equal(by(f, 'fee-tree').status, 'partial', '"built by launch" is not true: one level only');
  assert.equal(by(f, 'family-tree-view').status, 'missing', 'the launch list is not a family tree');
  assert.deepEqual(by(f, 'family-tree-view').builtBy, []);
  assert.equal(f.verdict, 'missing');
  assert.deepEqual(f.tools.map((t) => t.id), ['memes'], 'the map needs real places; the meme maker came with a reason');
  assert.ok(!r.tools.some((t) => t.id === 'map'));
  assert.equal(typeof r.costUsd, 'number');
});

test('fallback: no key, an HTTP error, a broken answer, a thrown fetch: the rules answer, said why; never throws', async () => {
  const app = SHIPPED;
  let n = 0;
  const none = await fitIdea({ idea: PADPAD, app, name: 'PadPad', ticker: 'PADPAD', cfg: cfgOf({ ANTHROPIC_API_KEY: '' }), fetchImpl: async () => { n++; return ok({}); } });
  assert.equal(n, 0); assert.equal(none.fidelity.source, 'rules'); assert.equal(none.fidelity.verdict, 'missing');
  for (const [fetchImpl, why] of [
    [async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 }), /fidelity HTTP 529: overloaded/],
    [async () => ok({ core: [], tools: [] }), /no core features/],
    [async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'no json here' }], stop_reason: 'end_turn' }), { status: 200 }), /no JSON/],
    [async () => { throw new TypeError('fetch failed'); }, /fetch failed/],
  ]) {
    const r = await fitIdea({ idea: PADPAD, app, name: 'PadPad', ticker: 'PADPAD', cfg: cfgOf(), fetchImpl });
    assert.equal(r.fidelity.source, 'rules');
    assert.match(r.fallback, why);
    assert.match(r.fidelity.fallback, why);
    assert.equal(r.fidelity.verdict, 'missing', 'the rules still flag PadPad');
  }
  // no app at all: still a result
  const bare = rulesFit({ idea: { title: 'x', concept: 'y' }, app: null, name: 'X', ticker: 'X' });
  assert.equal(bare.fidelity.core[0].capability, 'site');
});

// --- simple ideas, fully built -----------------------------------------------------------------------------------------
test('a simple idea fully built: no flags, the tools it needs (a map for the ramen guide, none for PadPad)', () => {
  for (const idea of [KONBINI, RAMEN]) {
    const r = fitFor(idea);
    assert.equal(r.fidelity.verdict, 'match', idea.title);
    assert.ok(r.fidelity.core.every((x) => x.status === 'built'));
    assert.match(r.fidelity.message, /^I built your idea as you described it/);
    assert.match(fitNote(r.fidelity), /^Yes: \d of \d core features built$/);
  }
  const ramen = fitFor(RAMEN), padpad = fitFor(PADPAD);
  const hasMap = (x) => x.tools.some((t) => t.id === 'map') || x.app.screens.some((s) => s.blocks.some((b) => b.type === 'map'));
  assert.ok(hasMap(ramen), 'the ramen guide keeps its map');
  assert.ok(!hasMap(padpad), 'PadPad gets no map');
  assert.ok(aboutPlaces(RAMEN.concept)); assert.ok(!aboutPlaces(PADPAD.concept));
  // the map tool itself (no app map): the rules pick it for places, with its reason
  const r = rulesFit({ idea: RAMEN, app: null, name: 'Ramen Radar', ticker: 'RAMEN' });
  assert.deepEqual(r.fidelity.tools, [{ id: 'map', why: 'the idea is about real places people go' }]);
});

test('the capabilities the rules know: each one detected from its words and missing without its part', () => {
  const samples = { 'ai-generation': 'an AI that generates images of your cat', 'live-chat': 'a live chat for holders', multiplayer: 'a multiplayer battle arena',
    marketplace: 'a marketplace to buy and sell items', nft: 'mint your own NFT badge', 'holder-rewards': 'staking rewards for holders', 'mobile-app': 'a mobile app for the coin',
    bots: 'a telegram bot that posts updates', betting: 'a lottery every friday', 'onchain-governance': 'a DAO with a treasury', 'live-stream': 'a live stream every night',
    'physical-goods': 'merch shipped to your door', 'custom-game': 'a racing game in the browser' };
  for (const cap of CAPABILITIES) if (!samples[cap.id] && !['recursive-launchpads', 'fee-tree', 'family-tree-view', 'city-neighbourhood'].includes(cap.id)) assert.fail(`no sample for ${cap.id}`);
  for (const [id, words] of Object.entries(samples)) {
    const core = rulesCore(words, null, []);
    const f = core.find((x) => x.capability === id);
    assert.ok(f, `${id} detected in "${words}"`);
    assert.equal(f.status, 'missing', id);
  }
  // a part that does some of it: partial, with the part named
  const chat = rulesCore('a live chat for holders', null, [{ id: 'wall' }]).find((x) => x.capability === 'live-chat');
  assert.deepEqual([chat.status, chat.builtBy], ['partial', ['wall']]);
});

// --- honest words ----------------------------------------------------------------------------------------------------
test('copy honesty: a sentence may name a missing feature only to say it is not built; the model copy is refused and retried', async () => {
  const { app, fidelity, tools } = fitFor(PADPAD, SHIPPED);
  const built = builtText(app, tools, 'PadPad');
  assert.match(honestyProblem(['PadPad shows the live family tree of every launchpad.'], fidelity, built), /presents a live family tree/);
  assert.match(honestyProblem(['A launchpad for launchpads: every coin is recursive.'], fidelity, built), /launchpads that launch launchpads/);
  assert.equal(honestyProblem(['The family tree is not built yet.', 'Launch a real coin from this page.'], fidelity, built), null);
  assert.equal(honestyProblem(['Not built yet: a live family tree; a neighbourhood in the city.'], fidelity, built), null, 'one sentence, the marker first');
  assert.equal(honestyProblem(['PadPad shows the live family tree.'], fitFor(KONBINI).fidelity, ''), null, 'nothing missing, nothing refused');
  // the template never presents them, and never quotes the author's words that describe them
  const t = templateGenerate({ idea: PADPAD, brain: BRAIN, submitter: 'nocontent', app: SHIPPED });
  const s = t.spec, prose = [s.tagline, s.description, ...s.sections.flatMap((x) => [x.heading, x.body]), s.x.bio, ...s.x.posts];
  assert.equal(honestyProblem(prose, t.fidelity, builtText(s.app, s.tools, s.name)), null);
  assert.doesNotMatch(prose.join(' '), /launchpad for launchpads|grandparent/);
  const origin = s.sections.find((x) => x.heading === 'Where it comes from').body;
  assert.match(origin, /The idea asks for more than this first version does\. Not built yet: launchpads that launch launchpads/);
  assert.match(origin, /a live family tree/);
  // each idea tool says why it is there
  assert.match(s.sections.find((x) => x.heading === 'Also on the site').body, /Community wall: .* It is here because every site keeps one place for visitors' short notes\./);
  // the model: a lying draft is refused with the reason, the second (honest) one is kept
  const LIE = { name: 'PadPad', ticker: 'PADPAD', tagline: 'The launchpad for launchpads, with a live family tree.', description: 'PadPad is a launchpad for launchpads: every coin can launch coins, and fees flow to every grandparent.',
    sections: [{ heading: 'How it works', body: 'Launch a coin from the page with your wallet. SUB-01 reads it first.' }], x: { handles: ['padpad'], bio: 'PadPad: launch real coins from one page.', posts: ['Launch a coin from the PadPad page.', 'Every launch is read by SUB-01 first.'] } };
  const TRUE = { ...LIE, tagline: 'Launch a real coin from this page, with the fees split on-chain.', description: 'PadPad launches real pump.fun coins from one page. Each launch is read by SUB-01 first; the creator fees are split on-chain.',
    sections: [...LIE.sections, { heading: 'Where it comes from', body: 'An idea by nocontent. The idea asks for more: launchpads that launch launchpads and a live family tree are not built yet. SUB-01\'s brain simulation voted to build it.' }] };
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.system.includes('fixed DSL')) return new Response('{}', { status: 500 });
    if (body.system === FIT_SYSTEM) return ok(PADPAD_FIT);
    seen.push(body.messages[0].content);
    return ok(seen.length === 1 ? LIE : TRUE);
  };
  const out = await anthropicGenerate({ idea: PADPAD, brain: BRAIN, cfg: cfgOf(), fetchImpl, submitter: 'nocontent' });
  assert.equal(out.generator, 'anthropic:claude-sonnet-5-5');
  assert.equal(out.spec.tagline, TRUE.tagline);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /What the idea asks for that SUB-01 could NOT build[\s\S]*- Launchpads that launch launchpads: /);
  // the composer now builds PadPad as a launchpad for launchpads (family.js): the fee tree is built; this canned model
  // answer still calls the recursion missing, and the rules only ever make the model stricter, so that stays
  assert.doesNotMatch(seen[0], /Built only in part[\s\S]*Creator fees flow up the family tree/);
  assert.match(seen[0], /App kind: launchpad-family/);
  assert.match(seen[1], /A previous draft was refused: ".*" presents (launchpads that launch launchpads|a live family tree|the live family tree on the site) as real/i);
  assert.equal(out.fidelity.verdict, 'missing');
  assert.deepEqual(out.spec.tools.filter((t) => !TRUST.includes(t.id)).map((t) => t.id), ['token', 'wall'], 'a launchpad for launchpads drops the meme maker (composer.js toolsBeside)');
  assert.match(COPY_SYSTEM, /could NOT build: never describe those parts as features/);
  // checkCopy directly
  assert.throws(() => checkCopy(LIE, { fidelity: out.fidelity, built: builtText(out.spec.app, out.spec.tools, 'PadPad') }), /presents/);
});

test('the app\'s own words: a title or lede that presents a missing feature is replaced by the rules\' words', () => {
  const { app, fidelity } = fitFor(PADPAD, SHIPPED);
  const lying = { ...app, title: 'PadPad: the live family tree', lede: 'A launchpad for launchpads, recursive all the way down.' };
  // the rules' words of the same kind of app (the plain launchpad PadPad shipped as)
  const fixed = honestApp(lying, fidelity, { idea: { title: 'PadPad', concept: 'A launchpad where anyone can launch a coin.' }, name: 'PadPad', ticker: 'PADPAD' });
  assert.equal(fixed.title, app.title);
  assert.equal(fixed.lede, app.lede);
  assert.equal(honestApp(app, fidelity, { idea: PADPAD, name: 'PadPad', ticker: 'PADPAD' }), app, 'an honest app is left alone');
  const k = fitFor(KONBINI);
  assert.equal(honestApp({ ...k.app, title: 'Konbini: family tree' }, k.fidelity, {}).title, 'Konbini: family tree', 'nothing missing, nothing to fix');
});

// --- the build: timeline, records, API, admin --------------------------------------------------------------------------
test('the build timeline: "Does it match the idea?" between the app and the words, flagged when a core feature is missing', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db), w2 = user(db), w3 = user(db);
  const gap = submitIdea(db, cfg, w.address, IDEA(w, { title: CATRACE.title, concept: CATRACE.concept, nameSuggestion: 'Cat Racer', tickerSuggestion: 'CATRACE' }));
  const ramen = submitIdea(db, cfg, w2.address, IDEA(w2));
  const pad = submitIdea(db, cfg, w3.address, IDEA(w3, { title: PADPAD.title, concept: PADPAD.concept, nameSuggestion: 'PadPad', tickerSuggestion: 'PADPAD' }));
  await drain(db, cfg, fakeBrain('build').fetchImpl);
  assert.ok(PIPELINE.indexOf('app') < PIPELINE.indexOf('fit') && PIPELINE.indexOf('fit') < PIPELINE.indexOf('brief'));
  const v = buildView(db, cfg, gap, { owner: true });
  assert.equal(v.state, 'ready');
  const fit = v.steps.find((s) => s.id === 'fit');
  assert.equal(fit.label, 'Does it match the idea?');
  assert.equal(fit.state, 'done');
  assert.equal(fit.provider, 'rules (no AI)');
  assert.equal(fit.flag, 'missing');
  assert.match(fit.note, /^Not all of it\. Missing: AI that makes things for visitors; Real-time multiplayer/);
  const vr = buildView(db, cfg, ramen, { owner: true }).steps.find((s) => s.id === 'fit');
  assert.equal(vr.flag, null); assert.match(vr.note, /^Yes: /);
  // PadPad, built as a launchpad for launchpads (family.js): every core feature built, nothing flagged
  const vp = buildView(db, cfg, pad, { owner: true }).steps.find((s) => s.id === 'fit');
  assert.equal(vp.flag, null); assert.equal(vp.note, 'Yes: 5 of 5 core features built');
  assert.equal(db.get('SELECT verdict FROM idea_fidelity WHERE idea_id = ?', pad).verdict, 'match');
  assert.equal(db.get('SELECT COUNT(*) n FROM fidelity_gaps WHERE idea_id = ?', pad).n, 0);
  assert.equal(db.get(`SELECT COUNT(*) n FROM events WHERE idea_id = ? AND kind = 'fidelity'`, pad).n, 0);
  const padSpec = JSON.parse(db.get('SELECT s.spec_json FROM site_versions s JOIN projects p ON p.id = s.project_id WHERE p.idea_id = ? ORDER BY s.version DESC LIMIT 1', pad).spec_json);
  assert.deepEqual(padSpec.app.screens.flatMap((x) => x.blocks).map((b) => b.type), ['launch', 'tree']);
  assert.ok(!padSpec.tools.some((t) => ['map', 'memes'].includes(t.id)));
  // recorded, with its project and its gaps; the author is told in SUB-01's words; the preview is not presented as all of it
  const row = db.get('SELECT * FROM idea_fidelity WHERE idea_id = ?', gap);
  assert.equal(row.verdict, 'missing'); assert.ok(row.project_id); assert.ok(row.job_id);
  assert.deepEqual(db.all('SELECT capability, status FROM fidelity_gaps WHERE idea_id = ? ORDER BY capability', gap).map((g) => `${g.capability}:${g.status}`),
    ['ai-generation:missing', 'board-app:partial', 'custom-game:partial', 'multiplayer:missing']);
  assert.match(db.get(`SELECT message FROM events WHERE idea_id = ? AND kind = 'fidelity'`, gap).message, /^I can't build AI that makes things for visitors/);
  assert.equal(db.get(`SELECT COUNT(*) n FROM events WHERE idea_id = ? AND kind = 'fidelity'`, ramen).n, 0, 'nothing to say when it is all built');
  const st = db.get('SELECT status, status_note FROM ideas WHERE id = ?', gap);
  assert.equal(st.status, 'preview_ready', 'the author can still choose to publish');
  assert.match(st.status_note, /^preview ready, but it is not all of your idea: 2 core features are not built yet/);
  assert.doesNotMatch(db.get('SELECT status_note FROM ideas WHERE id = ?', pad).status_note || '', /not all of your idea/);
  // the site's words: no claim of the missing parts
  const spec = JSON.parse(db.get('SELECT spec_json FROM site_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1', row.project_id).spec_json);
  assert.doesNotMatch(JSON.stringify(spec), /AI generates your cat|multiplayer racing/i);
  assert.match(spec.sections.find((x) => x.heading === 'Where it comes from').body, /Not built yet: AI that makes things for visitors; real-time multiplayer\./);
  // the admin list: what ideas keep asking for
  const top = topMissing(db);
  assert.deepEqual(top.map((t) => t.capability).sort(), ['ai-generation', 'board-app', 'custom-game', 'multiplayer']);
  assert.equal(top.find((t) => t.capability === 'multiplayer').ideas, 1);
  // a newer check replaces the older one in the counts (an idea counts once, from its newest check)
  recordFidelity(db, { ideaId: gap, fidelity: fitFor(KONBINI).fidelity, id: 'fit_newer', t: Date.now() + 1000 });
  assert.deepEqual(topMissing(db), []);
  assert.equal(fidelityView(db, gap).verdict, 'match');
});

test('API: GET /api/ideas/:id and the project view carry the check for the author and the staff; the admin page the most requested gaps', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db)); await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: CATRACE.title, concept: CATRACE.concept, nameSuggestion: 'Cat Racer', tickerSuggestion: 'CATRACE' }));
    assert.equal(sub.status, 200, sub.text);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const v = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json;
    assert.equal(v.fidelity.verdict, 'missing');
    assert.equal(v.fidelity.source, 'rules');
    assert.deepEqual(v.fidelity.missing.map((x) => x.capability), ['ai-generation', 'multiplayer']);
    assert.deepEqual(v.fidelity.partial.map((x) => x.capability), ['board-app', 'custom-game']);
    assert.match(v.fidelity.message, /I can't build/);
    assert.ok(v.fidelity.checkedAt > 0);
    assert.equal(v.build.steps.find((s) => s.id === 'fit').flag, 'missing');
    const p = (await owner.call('GET', `/api/projects/${v.project.slug}`)).json;
    assert.equal(p.fidelity.verdict, 'missing');
    assert.match(p.fidelity.built, /^Cat Racer: what next/);
    // a visitor of the public idea sees no check (the author's feedback)
    assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true })).status, 200);
    const visitor = h.client(user(h.db)); await visitor.signIn();
    assert.equal((await visitor.call('GET', `/api/ideas/${sub.json.id}`)).json.fidelity, null);
    assert.equal((await visitor.call('GET', `/api/projects/${v.project.slug}`)).json.fidelity, undefined);
    // the admin overview
    const admin = h.client(user(h.db, 'admin')); await admin.signIn();
    const o = (await admin.call('GET', '/api/admin/overview')).json;
    assert.ok(o.missingCapabilities.some((c) => c.capability === 'multiplayer' && c.ideas === 1 && c.missing === 1));
    // PadPad through the same routes: everything built (family.js)
    const pad = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: PADPAD.title, concept: PADPAD.concept, nameSuggestion: 'PadPad', tickerSuggestion: 'PADPAD' }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const pv = (await owner.call('GET', `/api/ideas/${pad.json.id}`)).json;
    assert.equal(pv.fidelity.verdict, 'match');
    assert.deepEqual([pv.fidelity.missing, pv.fidelity.partial], [[], []]);
    assert.match(pv.fidelity.message, /^I built your idea as you described it/);
    // the room PC: a tool switched on again keeps SUB-01's reason for it
    const put = await owner.call('PUT', `/api/projects/${pv.project.slug}/tools`, { tools: [{ id: 'token' }, { id: 'wall' }, { id: 'poll' }] });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.tools.find((t) => t.id === 'wall').why, "every site keeps one place for visitors' short notes");
    assert.equal(put.json.tools.find((t) => t.id === 'poll').why, undefined, 'a tool the author adds has no reason of SUB-01\'s');
  } finally { h.close(); }
});

test('finish: the message and the verdict follow the features; a partial-only build is "Mostly"', () => {
  const app = composeRules(KONBINI, { name: 'K', ticker: 'K' }).app;
  const f = finish({ source: 'rules', core: [{ feature: 'Live chat', capability: 'live-chat', status: 'partial', builtBy: ['wall'], reason: 'The wall takes short notes.', terms: [] }], picks: [], app, tools: [] });
  assert.equal(f.verdict, 'partial');
  assert.match(f.message, /^Live chat: only partly\. The wall takes short notes\. What I built: /);
  assert.match(fitNote(f), /^Mostly\. Only in part: Live chat$/);
});

test('a launch block set to launch launchpads (the PadPad feature work) counts as the recursion and the fee tree, by its settings', () => {
  const app = SHIPPED;
  const family = JSON.parse(JSON.stringify(app));
  family.screens[0].blocks[0].children = 'launchpads';           // the launch block's setting (app-blocks.js LAUNCH_CHILDREN)
  const core = rulesCore(PADPAD.concept, family, []);
  assert.equal(core.find((x) => x.capability === 'recursive-launchpads').status, 'built');
  assert.deepEqual(core.find((x) => x.capability === 'fee-tree').builtBy, ['launch']);
  assert.equal(core.find((x) => x.capability === 'family-tree-view').status, 'missing', 'the tree needs its own block');
  assert.equal(rulesCore(PADPAD.concept, app, []).find((x) => x.capability === 'recursive-launchpads').status, 'missing', 'a plain launch block does not');
});
