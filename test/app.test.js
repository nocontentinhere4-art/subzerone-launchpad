// The idea app composer (docs/APP-COMPOSER.md): the DSL's strict validation, SUB-01's composer (rules, the optional
// model and its fallback), Konbini Confession end to end (form -> candidates -> signed votes -> the 23:00 reveal with its
// proof -> the archive), the owner's side, the post-quantum registry (signed on the server, verified the way the
// browser does it), the beacon's search for the reveal block, the boot backfill and the built app module's rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { harness, user, drain, IDEA, wallet } from './helpers.js';
import { validateApp, describeApp, exposure, lastSlot, nextSlot, blockOf } from '../src/app-blocks.js';
import { composeRules, composeApp, readIdea, toolsBeside } from '../src/composer.js';
import { runReveals, drawOrder, createBeacon, backfillApps, metrics } from '../src/app-api.js';
import { syncRegistry, verifyRegistry, registryView } from '../src/pq.js';
import { verifyEntries } from '../kit/app/pq.js';
import { templateGenerate, validateSpec } from '../src/generator.js';
import { validateHtml, sandboxBuild } from '../src/site.js';
import { ROOT } from '../src/config.js';

// the live coins' ideas (city.subzerone.live /api/ideas/:id, 2026-10-12)
const KONBINI = 'Concept: A 24-hour konbini in Shibuya where the receipt is the product. Every night at 23:00 the shop prints one anonymous confession from the city on the back of a receipt, and the character who buys an onigiri gets it. Holders can drop their own confession in the box by the ice cream freezer; SUB-01 reads the best one aloud at the counter at 23:05. A place you go to when you can’t sleep, and a receipt you keep in your room. No rewards, no promises: a shop, a ritual, a piece of paper.';
const LIVE = [
  ['Konbini Confession', KONBINI, 'RECEIPT', 'ritual'],
  ['Tokyo Bar for Cats', 'It\'s a Tokyo Cat token representing bar in this city for people with cats and firs cat deployed on this launchpad.', 'TOKYOCAT', 'places'],
  ['Tokyo’s last train carries every idea SUB-01 rejected.', 'At midnight, it stops at a station that doesn’t exist on the map. One rejected idea gets off. SUB-01 reads it again—and decides whether to give it an address in the city.\n\nMissed the launch? Catch the last train.\n\nA station, a nightly ritual, and a second chance for the city’s weirdest ideas.', 'MISSED', 'ritual'],
  ['Bored Ape Yacht Club', 'Bored Ape Yacht Club in Tokyo', 'BAYC', 'board'],
  ['BTC Tower', 'Bitcoin Tower HQ of Satoshi Nakamoto', 'TOWER', 'guestbook'],
  ['Meet SUB-01 and have a diddy party', 'Meet SUB-01 and have a diddy party', 'PARTY', 'party'],
  ['The antithesis SUB-01 character', 'Does everything that SUB-01 does, but the opposite. The shadow version of SUB-01.', 'SCRP01', 'board'],
  ['Sub-01 becomes gozilla', 'Sub-01 becomes gozilla', 'SUBGOZILLA', 'targets'],
  ['A t-rex in the city', 'A t-rex in the city that destroys blocks', 'TREX', 'targets'],
  ["Claudia's House", 'House of Claudia the AI artist', 'CLAUDHOUSE', 'commissions'],
  ['Quantum launchpad', 'a launchpad where everything is managed quantum-proof', 'QSAFE', 'launchpad'],   // 2026-10-12 the owner: a launchpad must launch coins
];
const ENC = { TRUST_PROXY: '1', APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

function hostCall(base, host, method, path, body, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ host: u.hostname, port: u.port, path, method, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let text = ''; res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function project(h, { title = 'Konbini Confession', concept = KONBINI, ticker = 'RECEIPT' } = {}) {
  const owner = h.client(user(h.db));
  await owner.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title, nameSuggestion: title.slice(0, 32), tickerSuggestion: ticker, concept }));
  assert.equal(sub.status, 200, sub.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true })).status, 200);
  const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
  const host = `${slug}.${h.cfg.projectsHost}`, origin = `http://${host}`;
  const k = { ip: '10.0.0.1' };
  const site = (method, path, body, headers = {}) => hostCall(h.base, host, method, path, body, { 'x-forwarded-for': k.ip, ...(method === 'POST' ? { origin } : {}), ...headers });
  const p = () => h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
  const spec = () => JSON.parse(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p().id, p().live_site_version).spec_json);
  return Object.assign(k, { owner, slug, host, origin, site, ideaId: sub.json.id, project: p, spec });
}
function fakeLaunch(h, slug, { network = 'mock', provider = 'mock' } = {}) {
  const p = h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
  let alloc = h.db.get('SELECT id FROM fee_allocations WHERE project_id = ? ORDER BY version DESC LIMIT 1', p.id);
  h.db.run(`UPDATE fee_allocations SET status = 'approved', approved_by = 'w', approved_at = ? WHERE id = ?`, Date.now(), alloc.id);
  const mint = wallet().address, t = Date.now();
  h.db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, tx_signature, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{}', 'cfghash', ?, ?, 'w', 'confirmed', ?, ?, ?)`, `int_${slug}`, p.id, provider, network, alloc.id, mint, `sig_${slug}`, t, t);
  h.db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
    p.id, `int_${slug}`, provider, network, mint, `sig_${slug}`, t);
  h.db.run(`UPDATE ideas SET status = 'launched' WHERE id = ?`, p.idea_id);
  return mint;
}
/** A visitor's wallet signs the server's message and sends the write. */
async function signedVote(k, w, itemId) {
  const s = await k.site('POST', '/_api/sign', { action: 'app.vote', wallet: w.address, itemId });
  assert.equal(s.status, 200, s.text);
  assert.match(s.json.message, /This is a message, not a transaction/);
  return k.site('POST', '/_api/app/vote', { itemId, wallet: w.address, nonce: s.json.nonce, signature: w.signText(s.json.message) });
}

// --- the DSL and the composer -------------------------------------------------------------------------------------------
test('the app DSL is strict: unknown blocks, fields, markup, links, sizes and broken cross-block rules are refused', () => {
  const ok = composeRules({ title: 'Konbini Confession', concept: KONBINI }, { name: 'Konbini Confession', ticker: 'RECEIPT' }).app;
  assert.deepEqual(validateApp(ok), ok, 'normalised specs are fixed points');
  const mut = (f) => { const a = structuredClone(ok); f(a); return a; };
  const bad = [
    mut((a) => { a.v = 2; }), mut((a) => { a.extra = 1; }), mut((a) => { a.screens[0].blocks[0].type = 'script'; }),
    mut((a) => { a.title = '<b>hi</b>'; }), mut((a) => { a.lede = 'see https://evil.example'; }), mut((a) => { a.screens[0].blocks[2].onclick = 'x'; }),
    mut((a) => { a.screens[0].blocks[2].fields = []; }), mut((a) => { a.screens[0].blocks[2].fields[0].kind = 'html'; }),
    mut((a) => { a.screens[0].blocks[2].fields[1].choices = ['A', 'a']; }), mut((a) => { a.screens[0].blocks[4].at = '25:00'; }),
    mut((a) => { a.screens[0].blocks.splice(4, 1); }),                       // a reveal without a schedule
    mut((a) => { a.screens[0].blocks.splice(1, 1); }),                       // candidates without a reveal
    mut((a) => { a.screens[1].blocks[0].template = 'nft'; }), mut((a) => { a.screens[1].blocks[0].lines = Array(7).fill('X'); }),
    mut((a) => { a.screens[1].blocks[1].show = 'all'; }),                    // an inbox app keeps submissions private
    mut((a) => { a.screens.push(...Array(4).fill(a.screens[1])); }), mut((a) => { a.screens[1].id = 'tonight'; }),
    mut((a) => { a.screens[0].blocks.push({ type: 'leaderboard', of: 'wallets', by: 'submissions' }); }),
  ];
  for (const b of bad) assert.throws(() => validateApp(b), /^AppError|app /, JSON.stringify(b).slice(0, 80));
  const spec = templateGenerate({ idea: { title: 'Konbini Confession', concept: KONBINI }, brain: { networks: { language: 1 } } }).spec;
  assert.throws(() => validateSpec({ ...spec, app: mut((a) => { a.lede = 'guaranteed 10x gains'; }) }), /financial promises/);
  assert.equal(exposure(ok), 'candidates');
});

test('SUB-01 composes an app for every live coin, honestly; the quantum launchpad launches coins and gets the post-quantum registry', () => {
  for (const [title, concept, ticker, kind] of LIVE) {
    const r = composeRules({ title, concept }, { name: title.slice(0, 32), ticker });
    assert.equal(r.app.kind, kind, title);
    assert.ok(r.honest && r.summary, title);
    assert.deepEqual(composeRules({ title, concept }, { name: title.slice(0, 32), ticker }).app, r.app, 'deterministic');
  }
  const k = composeRules({ title: 'Konbini Confession', concept: KONBINI }, { name: 'Konbini Confession', ticker: 'RECEIPT' }).app;
  assert.equal(blockOf(k, 'schedule').at, '23:00');
  assert.deepEqual(blockOf(k, 'reveal').pick, ['owner', 'votes', 'random']);
  assert.equal(blockOf(k, 'card').template, 'receipt');
  assert.deepEqual(blockOf(k, 'card').lines, ['ONIGIRI ×1', 'ICE CREAM ×1']);
  assert.equal(blockOf(k, 'vote').holdersOnly, true);
  assert.equal(k.noun.one, 'confession');
  const train = composeRules({ title: LIVE[2][0], concept: LIVE[2][1] }, { name: 'LAST TRAIN', ticker: 'MISSED' }).app;
  assert.equal(blockOf(train, 'schedule').at, '00:00');
  assert.equal(blockOf(train, 'card').template, 'ticket');
  const q = composeRules({ title: 'Quantum launchpad', concept: 'a launchpad where everything is managed quantum-proof' }, { name: 'QSafe', ticker: 'QSAFE' }).app;
  assert.deepEqual(blockOf(q, 'pq'), { type: 'pq', title: 'Signed registry of every launch', registry: true, verify: true, honesty: true });
  assert.deepEqual(blockOf(q, 'launch').split, { creator: 7000, parent: 1000, sub01: 2000 });
  assert.equal(composeRules({ title: 'Quantum launchpad', concept: 'post-quantum lattice signatures for everything' }).app.kind, 'pq', 'quantum without a launchpad: the registry alone');
  for (const w of ['post-quantum', 'PQC', 'lattice crypto', 'dilithium', 'kyber', 'quantum resistant']) assert.equal(readIdea(w).quantum, true, w);
  assert.match(describeApp(k), /confessions form · signed votes · reveal every day at 23:00 JST · receipt card · archive · counter/);
  assert.deepEqual(toolsBeside([{ id: 'token' }, { id: 'drop' }, { id: 'event', config: { daily: '23:00' } }, { id: 'wall' }, { id: 'memes' }], k).map((t) => t.id), ['token', 'wall', 'memes']);
});

test('with a model key the composer asks Claude for the spec, validates it, and falls back to the rules on anything wrong', async () => {
  const cfg = { generator: { anthropicKey: 'test-key' } };
  const idea = { title: 'Konbini Confession', concept: KONBINI };
  const good = { ...composeRules(idea, { name: 'Konbini', ticker: 'RECEIPT' }).app, title: 'The 23:00 receipt, by the model' };
  let seen = null;
  const reply = (text, extra = {}) => async (url, init) => { seen = { url, body: JSON.parse(init.body), headers: init.headers }; return new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra }), { status: 200 }); };
  const r = await composeApp(idea, {}, { name: 'Konbini', ticker: 'RECEIPT', cfg, fetchImpl: reply(JSON.stringify(good)) });
  assert.equal(r.source, 'anthropic:claude-sonnet-5-5');
  assert.equal(r.app.title, 'The 23:00 receipt, by the model');
  assert.equal(seen.body.model, 'claude-sonnet-5-5');
  assert.ok(seen.body.max_tokens <= 2000);
  assert.match(seen.body.system, /untrusted user data/);
  for (const [why, f] of [['script block', reply(JSON.stringify({ ...good, screens: [{ id: 'x', title: 'X', blocks: [{ type: 'script', src: 'https://evil.example' }] }] }))],
    ['markup', reply(JSON.stringify({ ...good, title: '<img onerror=x>' }))], ['not json', reply('Sure! Here is your app.')], ['refusal', reply('{}', { stop_reason: 'refusal' })],
    ['http 500', async () => new Response('{}', { status: 500 })], ['network', async () => { throw new TypeError('fetch failed'); }]]) {
    const out = await composeApp(idea, {}, { name: 'Konbini', ticker: 'RECEIPT', cfg, fetchImpl: f });
    assert.equal(out.source, 'rules', why);
    assert.ok(out.fallback, why);
  }
  assert.equal((await composeApp(idea, {}, { name: 'Konbini', ticker: 'RECEIPT', cfg: { generator: {} } })).source, 'rules', 'no key, no call');
});

test('the built page carries the app as data, passes the validator, and the reveal draw is a pure function of the seed', async () => {
  const spec = templateGenerate({ idea: { title: 'Konbini Confession', concept: KONBINI }, brain: { networks: { language: 1 } } }).spec;
  const context = { preview: false, launched: false, submitter: 'So1', generatorLabel: 'a fixed template', links: [{ href: 'https://subzerone.live', label: 'room' }], token: { state: 'pre-launch', links: [] } };
  const html = await sandboxBuild({ spec, context });
  assert.deepEqual(validateHtml(html, ['https://subzerone.live']), { ok: true, problems: [] });
  assert.equal(html.match(/<script/g).length, 1);
  assert.match(html, /<section class="app card reveal" id="app" data-app data-config="\{&quot;v&quot;:1/);
  assert.ok(!/<(button|input|form|textarea|select)\b/.test(html), 'controls are built by the kit, never by the page');
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(drawOrder('hash1', ids), drawOrder('hash1', [...ids].reverse()), 'order-independent');
  assert.notDeepEqual(drawOrder('hash1', ids), drawOrder('hash2', ids));
});

// --- Konbini Confession end to end ---------------------------------------------------------------------------------------
test('Konbini: anonymous confessions, tonight\'s candidates, signed votes, the 23:00 reveal with its proof, the archive', async () => {
  const h = await harness(ENC);
  try {
    const k = await project(h);
    const app = k.spec().app;
    assert.equal(app.kind, 'ritual');
    for (const t of ['drop', 'poll', 'event']) assert.ok(!k.spec().tools.some((x) => x.id === t), `the ${t} tool gave way to the app`);
    const page = await k.site('GET', '/');
    assert.match(page.headers['content-security-policy'], /script-src 'self'; connect-src 'self'/);
    // three confessions from two connections
    const sent = [];
    for (const [ip, text, item] of [['10.0.0.1', 'I said I was at the gym. I was at the konbini.', 'Onigiri'], ['10.0.0.1', 'I pretend to like natto.', undefined], ['10.0.0.2', 'I still have the receipt from our first date.', 'Ice Cream']]) {
      k.ip = ip;
      const r = await k.site('POST', '/_api/app/submit', { fields: { text, ...(item ? { item } : {}) } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.exposure, 'candidates');
      sent.push(r.json.item);
    }
    assert.deepEqual(sent.map((s) => s.number), [1, 2, 3]);
    assert.equal(sent[0].by, null, 'anonymous');
    // the form is strict and moderated, and the write must come from the site itself
    for (const [body, code] of [[{ fields: {} }, 'bad_fields'], [{ fields: { text: 'x', item: 'Caviar' } }, 'bad_fields'], [{ fields: { text: 'go to https://evil.example' } }, 'no_links'], [{ fields: { text: 'x', hack: 1 } }, 'bad_fields']]) {
      const r = await k.site('POST', '/_api/app/submit', body);
      assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.json.error, code);
    }
    assert.equal((await k.site('POST', '/_api/app/submit', { fields: { text: 'hi' } }, { origin: 'https://evil.example' })).status, 403);
    // the state: counts, tonight's candidates (public, anonymous), the schedule
    let s = (await k.site('GET', '/_api/app')).json;
    assert.equal(s.counts.submitted_today, 3);
    assert.equal(s.candidates.length, 3);
    assert.equal(s.schedule.at, '23:00');
    assert.equal(s.round.slot, nextSlot(blockOf(app, 'schedule'), Date.now()));
    assert.match(s.vote.note, /MOCK launch|launched/);
    assert.equal(s.latest, null);
    // two wallets vote; one vote per wallet per round; a replay or an altered payload is refused
    k.ip = '10.0.0.4';                                          // writes are also limited per minute per connection
    const [w1, w2] = [wallet(), wallet()];
    const v1 = await signedVote(k, w1, sent[2].id); assert.equal(v1.status, 200, v1.text); assert.equal(v1.json.votes, 1);
    const v2 = await signedVote(k, w2, sent[2].id); assert.equal(v2.status, 200); assert.equal(v2.json.votes, 2);
    const again = await signedVote(k, w1, sent[0].id); assert.equal(again.status, 409); assert.equal(again.json.itemId, sent[2].id);
    const sig = await k.site('POST', '/_api/sign', { action: 'app.vote', wallet: w1.address, itemId: sent[1].id });
    assert.equal((await k.site('POST', '/_api/app/vote', { itemId: sent[0].id, wallet: w1.address, nonce: sig.json.nonce, signature: w1.signText(sig.json.message) })).json.error, 'payload_changed');
    // the reveal at 23:00: the holders' votes decide; the proof lists the window's candidates and the votes
    const p = k.project(), slot = s.round.slot;
    const done = await runReveals(h.db, p, app, async () => { throw new Error('no seed needed'); }, slot + 60_000);
    assert.deepEqual(done.map((d) => d.method), ['votes']);
    assert.equal(done[0].item, sent[2].id);
    assert.deepEqual(await runReveals(h.db, p, app, null, slot + 120_000), [], 'once per slot');
    const one = (await k.site('GET', `/_api/app/items/${sent[2].id}`)).json;
    assert.equal(one.how, 'votes');
    assert.equal(one.reveal.method, 'votes');
    assert.deepEqual(one.reveal.proof.candidates.sort(), sent.map((x) => x.id).sort());
    assert.deepEqual(one.reveal.proof.votes, { [sent[2].id]: 2 });
    const arch = (await k.site('GET', '/_api/app/items?show=published')).json;
    assert.deepEqual(arch.items.map((i) => i.number), [3]);
    assert.equal((await k.site('GET', `/_api/app/items?show=published&q=${encodeURIComponent('first date')}`)).json.items.length, 1);
    assert.equal((await k.site('GET', '/_api/app/items?show=published&q=natto')).json.items.length, 0, 'unpublished stays out of the archive');
    assert.equal((await k.site('GET', `/_api/app/items/${sent[1].id}`)).status, 200, 'still a candidate in the open round (the test clock did not move)');
    assert.equal((await k.site('GET', '/_api/app/items?show=all')).json.items.length, 1, 'an inbox app never lists everything');
    // the next round with nobody voting: a random draw seeded by the beacon, recomputable
    k.ip = '10.0.0.3';
    const late = (await k.site('POST', '/_api/app/submit', { fields: { text: 'I read other people\'s receipts.' } })).json.item;
    h.db.run('UPDATE app_items SET created_at = ? WHERE id IN (?, ?, ?)', slot + 3_600_000, late.id, sent[0].id, sent[1].id);
    const slot2 = slot + 86_400_000, seed = { source: 'solana', slot: 123456, blockhash: 'FakeBlockhash1111111111111111111111111111111', blockTime: Math.ceil(slot2 / 1000) };
    const d2 = await runReveals(h.db, p, app, async () => seed, slot2 + 1000);
    assert.equal(d2[0].method, 'random');
    assert.equal(d2[0].item, drawOrder(seed.blockhash, [late.id, sent[0].id, sent[1].id].sort())[0]);
    // an empty round is recorded as empty; the owner's pick wins over votes and the draw
    assert.deepEqual((await runReveals(h.db, p, app, async () => seed, slot2 + 86_400_000 + 1000)).map((d) => d.method), ['empty']);
    const view = (await k.owner.call('GET', `/api/projects/${k.slug}/app`)).json;
    assert.equal(view.editable, true);
    assert.equal(view.inbox.length, 4);
    assert.equal(view.reveals.length, 3);
    assert.equal(view.devTrigger, false);
    const left = view.inbox.find((i) => !i.published);
    const pick = await k.owner.call('POST', `/api/projects/${k.slug}/app/pick`, { itemId: left.id });
    assert.equal(pick.status, 200, pick.text);
    assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/app/reveal-now`, {})).status, 404, 'the dev trigger is off');
    // moderation: hide removes it from everything public; the stranger cannot touch the inbox
    const stranger = h.client(user(h.db)); await stranger.signIn();
    assert.equal((await stranger.call('GET', `/api/projects/${k.slug}/app`)).status, 404);
    assert.equal((await stranger.call('POST', `/api/projects/${k.slug}/app/items/${sent[2].id}`, { hidden: true })).status, 404);
    assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/app/items/${sent[2].id}`, { hidden: true })).status, 200);
    assert.equal((await k.site('GET', `/_api/app/items/${sent[2].id}`)).status, 404);
    assert.equal((await k.site('GET', '/_api/app/items?show=published')).json.items.some((i) => i.id === sent[2].id), false);
    // per-connection daily cap
    k.ip = '10.0.0.9';
    for (let i = 0; i < 6; i++) assert.equal((await k.site('POST', '/_api/app/submit', { fields: { text: `cap ${i}` } })).status, 200);
    assert.equal((await k.site('POST', '/_api/app/submit', { fields: { text: 'one too many' } })).status, 429);
    assert.ok(metrics(h.db, p, app).days_running >= 1);
  } finally { h.close(); }
});

test('owner: edit the app (validated, a new site version), get SUB-01\'s composition again, the dev trigger only when switched on', async () => {
  const h = await harness({ ...ENC, APP_DEV_TRIGGER: '1' });
  try {
    const k = await project(h);
    const app = k.spec().app, before = k.project().live_site_version;
    const edit = structuredClone(app);
    blockOf(edit, 'schedule').at = '22:30';
    blockOf(edit, 'card').heading = 'FAMILY MART-ISH';
    const put = await k.owner.call('PUT', `/api/projects/${k.slug}/app`, { app: edit });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.version, before + 1);
    assert.equal(blockOf(k.spec().app, 'schedule').at, '22:30');
    assert.match((await k.site('GET', '/')).text, /FAMILY MART-ISH/);
    assert.equal((await k.owner.call('PUT', `/api/projects/${k.slug}/app`, { app: { ...edit, screens: [{ id: 'x', title: 'X', blocks: [{ type: 'iframe' }] }] } })).status, 400);
    const again = await k.owner.call('POST', `/api/projects/${k.slug}/app/compose`, {});
    assert.equal(again.status, 200); assert.equal(again.json.app.kind, 'ritual'); assert.equal(again.json.source, 'rules');
    k.ip = '10.0.0.5';
    await k.site('POST', '/_api/app/submit', { fields: { text: 'not this one' } });
    const it = (await k.site('POST', '/_api/app/submit', { fields: { text: 'dev reveal me' } })).json.item;
    assert.equal((await signedVote(k, wallet(), it.id)).status, 200);
    const now = await k.owner.call('POST', `/api/projects/${k.slug}/app/reveal-now`, {});
    assert.equal(now.status, 200, now.text);
    assert.deepEqual(now.json, { item: it.id, method: 'votes' }, 'the open round\'s votes decide a dev reveal too');
    const s = (await k.site('GET', '/_api/app')).json;
    assert.equal(s.latest.id, it.id);
    assert.equal(s.latest.reveal.dev, true, 'a dev reveal is marked as such on the page');
    assert.deepEqual(s.latest.reveal.proof.votes, { [it.id]: 1 });
    assert.equal(s.candidates.length, 0, 'a new round starts after the reveal');
    const off = await k.owner.call('PUT', `/api/projects/${k.slug}/app`, { app: null });
    assert.equal(off.status, 200);
    assert.equal(k.spec().app, null);
    assert.equal((await k.site('GET', '/_api/app')).status, 404);
  } finally { h.close(); }
});

// --- the post-quantum registry -------------------------------------------------------------------------------------------
test('pq: the launchpad\'s record of a coin, ML-DSA-65 signed and chained; verified the way the browser does; tampering shows', async () => {
  const h = await harness(ENC);
  try {
    const k = await project(h, { title: 'Quantum launchpad', concept: 'a launchpad where everything is managed quantum-proof', ticker: 'QSAFE' });
    assert.equal(k.spec().app.kind, 'launchpad');
    assert.ok(blockOf(k.spec().app, 'pq'));
    fakeLaunch(h, k.slug);
    const r = await k.site('GET', '/_api/app/pq');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.alg, 'ML-DSA-65');
    assert.equal(Buffer.from(r.json.publicKey, 'base64').length, 1952);
    const kinds = r.json.entries.map((e) => e.kind).reverse();
    assert.deepEqual(kinds.slice(0, 2), ['registry.key', 'site.version']);
    for (const kind of ['fees.split', 'launch.config', 'launch.mint']) assert.ok(kinds.includes(kind), kind);
    assert.equal(Buffer.from(r.json.entries[0].signature, 'base64').length, 3309);
    assert.deepEqual(verifyRegistry(h.db, k.project()), { ok: true, problems: [] });
    // the browser's check (kit/app/pq.js) with the same library: every entry verified, every link checked
    const res = await verifyEntries(ml_dsa65, r.json, r.json.entries);
    assert.ok(res.every((x) => x.sig && x.payload && x.link !== false), JSON.stringify(res));
    assert.equal(res.filter((x) => x.link === true).length, res.length, 'one page holds the whole chain');
    // an owner note is signed in; idempotent sync adds nothing twice
    assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/app/announce`, { text: 'Fees go to the community wallet, as configured.' })).status, 200);
    assert.equal(syncRegistry(h.db, h.cfg, k.project()), 0);
    // tampering: change a stored payload and the browser's check fails for that entry
    const v = registryView(h.db, h.cfg, k.project());
    const forged = v.entries.map((e) => (e.kind === 'launch.mint' ? { ...e, payload: e.payload.replace(/"network":"mock"/, '"network":"mainnet-beta"') } : e));
    const bad = await verifyEntries(ml_dsa65, v, forged);
    assert.equal(bad.find((x, i) => forged[i].kind === 'launch.mint').payload, false);
    h.db.run(`UPDATE pq_entries SET payload_json = replace(payload_json, 'mock', 'mainnet-beta') WHERE kind = 'launch.mint'`);
    assert.equal(verifyRegistry(h.db, k.project()).ok, false);
    // the page: the registry block, the honesty box and the Winternitz link come from the kit, read-only
    const page = (await k.site('GET', '/')).text;
    assert.match(page, /data-type="pq"/);
    const owner = (await k.owner.call('GET', `/api/projects/${k.slug}/app`)).json;
    assert.equal(owner.pq.ok, false, 'the room PC shows the tampering too');
  } finally { h.close(); }
});

test('pq: without APP_ENCRYPTION_KEY the registry says it is off instead of signing with nothing', async () => {
  const h = await harness({ TRUST_PROXY: '1' });
  try {
    const k = await project(h, { title: 'Quantum launchpad', concept: 'post-quantum lattice signatures for everything', ticker: 'QSAFE' });
    const r = await k.site('GET', '/_api/app/pq');
    assert.equal(r.status, 503); assert.equal(r.json.error, 'pq_off');
  } finally { h.close(); }
});

// --- the beacon ---------------------------------------------------------------------------------------------------------
test('beacon: finds the first finalized block at or after the reveal instant (skipped slots included), or says it has no reader', async () => {
  const T0 = 1_791_000_000;                                 // seconds
  const blocks = []; for (let s = 1000; s < 30_000; s++) if (s % 7 !== 3) blocks.push(s);   // some slots skipped
  const timeOf = (s) => T0 + Math.floor((s - 1000) * 0.4);
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    const { method, params, id } = JSON.parse(init.body);
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    if (method === 'getSlot') return ok(29_990);
    if (method === 'getBlockTime') return blocks.includes(params[0]) ? ok(timeOf(params[0])) : new Response(JSON.stringify({ id, error: { code: -32009, message: 'skipped' } }));
    if (method === 'getBlocksWithLimit') return ok(blocks.filter((b) => b >= params[0]).slice(0, params[1]));
    if (method === 'getBlock') return ok({ blockhash: `hash${params[0]}`, blockTime: timeOf(params[0]) });
    throw new Error(method);
  };
  const beacon = createBeacon({ cfg: { coinStats: { heliusUrl: 'https://mainnet.helius-rpc.com/?api-key=x' } }, fetchImpl });
  const at = (T0 + 4000) * 1000 + 300;                      // between two block times
  const b = await beacon(at);
  const want = blocks.find((s) => timeOf(s) >= Math.ceil(at / 1000));
  assert.deepEqual(b, { source: 'solana', slot: want, blockhash: `hash${want}`, blockTime: timeOf(want) });
  assert.ok(calls < 60, `bounded RPC use (${calls})`);
  await assert.rejects(beacon((T0 + 999_999) * 1000), /not final/);
  assert.equal((await createBeacon({ cfg: { coinStats: {} } })(at)).source, 'time');
});

// --- the backfill and the built module ----------------------------------------------------------------------------------
test('backfill: launched coins without an app get SUB-01\'s app as a public new version (superseded tools off), once', async () => {
  const h = await harness(ENC);
  try {
    const k = await project(h);
    const p = k.project();
    const row = h.db.get('SELECT * FROM site_versions WHERE project_id = ? AND version = ?', p.id, p.live_site_version);
    const old = JSON.parse(row.spec_json); delete old.app;
    old.tools = [{ id: 'token', config: {} }, { id: 'drop', config: { title: 'Drop box', prompt: 'Drop your confession.', revealJst: '23:00', maxLength: 280, autoPick: true } }, { id: 'wall', config: { title: 'Wall', holdersOnly: false } }];
    h.db.run('UPDATE site_versions SET spec_json = ? WHERE id = ?', JSON.stringify(old), row.id);   // the live v1 kit
    fakeLaunch(h, k.slug);
    const out = await backfillApps(h.db, h.cfg);
    assert.deepEqual(out.built.map((b) => [b.slug, b.kind, b.replaced]), [[k.slug, 'ritual', ['drop']]]);
    assert.equal(k.project().live_site_version, p.live_site_version + 1);
    assert.deepEqual(k.spec().tools.map((t) => t.id), ['token', 'wall']);
    assert.match(h.db.get(`SELECT message FROM events WHERE kind = 'app' ORDER BY id DESC LIMIT 1`).message, /^SUB-01 built the app: confessions form · signed votes · reveal every day at 23:00 JST · receipt card/);
    assert.deepEqual((await backfillApps(h.db, h.cfg)).built, [], 'idempotent');
  } finally { h.close(); }
});

test('the built app module: no eval or HTML sinks, no transactions; loaded by the core only for sites with an app', () => {
  const dir = join(ROOT, 'public', '_kit');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const code = readFileSync(join(dir, 'site-app.v1.js'), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'new Function', 'eval(', 'signTransaction', 'sendTransaction', 'signAndSendTransaction']) assert.ok(!code.includes(bad), bad);
  assert.ok(manifest.files['site-app.v1.js'].gzip < 16_000, 'the app module stays small');
  assert.ok(manifest.files['vendor/noble-post-quantum-0.7.1.js']);
  assert.match(readFileSync(join(dir, 'LICENSES.txt'), 'utf8'), /@noble\/post-quantum 0\.7\.1 \(MIT\)/);
  assert.ok(readFileSync(join(dir, 'site-kit.v1.js'), 'utf8').includes('/_kit/site-app.v1.js'), 'the core loads the app module');
});

test('the schedule: daily and weekly JST slots', () => {
  const t = Date.parse('2026-10-12T13:59:00Z');            // Monday 22:59 JST
  assert.equal(new Date(lastSlot({ every: 'day', at: '23:00' }, t)).toISOString(), '2026-10-11T14:00:00.000Z');
  assert.equal(new Date(nextSlot({ every: 'day', at: '23:00' }, t)).toISOString(), '2026-10-12T14:00:00.000Z');
  const fri = { every: 'week', at: '20:00', weekday: 5 };
  assert.equal(new Date(lastSlot(fri, t)).toISOString(), '2026-10-09T11:00:00.000Z');
  assert.equal(new Date(nextSlot(fri, t)).toISOString(), '2026-10-16T11:00:00.000Z');
});
