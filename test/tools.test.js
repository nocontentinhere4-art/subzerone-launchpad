// The site kit (docs/SITE-KIT.md): tool schemas and SUB-01's pick, the validator's exact kit allowance, the project
// host's /_kit and /_api, signed votes, holders-only, moderation, the drop box's private inbox and daily rule, the room
// PC's PUT /tools, the launched-coin backfill and the built bundle's rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { harness, user, drain, IDEA, wallet } from './helpers.js';
import { validateTools, pickTools, readConcept, conceptTime, lastJst, nextJst, parseJstLocal, defaultConfig, LIBS, CATALOG, TOOL_IDS } from '../src/tools.js';
import { chooseTools, templateGenerate, validateSpec } from '../src/generator.js';
import { validateHtml, sandboxBuild, siteCsp } from '../src/site.js';
import { holderMode, createHolderCheck, runDropRule, backfillTools, tokenState } from '../src/tool-api.js';
import { refreshCoinStats } from '../src/coin-stats.js';
import { ROOT } from '../src/config.js';

const KONBINI = 'Konbini Confession: every night people drop an anonymous confession at the konbini; at 23:00 JST one gets printed on the receipt.';

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

/** A public preview_ready project from the Konbini idea; `site(method, path, body)` talks to its own host. */
async function konbini(h, extra = {}) {
  const owner = h.client(user(h.db));
  await owner.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: 'Konbini Confession', nameSuggestion: 'Konbini Confession', tickerSuggestion: 'KONBINI', concept: KONBINI, ...extra }));
  assert.equal(sub.status, 200, sub.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true })).status, 200);
  const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
  const host = `${slug}.${h.cfg.projectsHost}`, origin = `http://${host}`;
  // TRUST_PROXY=1 in these harnesses: each test picks the visitor's address (k.ip), so per-IP limits are testable
  const k = { ip: '10.0.0.1' };
  const site = (method, path, body, headers = {}) => hostCall(h.base, host, method, path, body, { 'x-forwarded-for': k.ip, ...(method === 'POST' ? { origin } : {}), ...headers });
  return Object.assign(k, { owner, slug, host, origin, site, ideaId: sub.json.id, project: () => h.db.get('SELECT * FROM projects WHERE slug = ?', slug) });
}
const TP = { TRUST_PROXY: '1' };

/** Pretend the coin launched (mock network), as the confirm job would record it. */
function fakeLaunch(h, slug, { network = 'mock', provider = 'mock' } = {}) {
  const p = h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
  const alloc = h.db.get('SELECT id FROM fee_allocations WHERE project_id = ? ORDER BY version DESC LIMIT 1', p.id);
  const mint = wallet().address, t = Date.now();
  h.db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, tx_signature, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{}', 'h', ?, ?, 'w', 'confirmed', ?, ?, ?)`, `int_${slug}`, p.id, provider, network, alloc.id, mint, `sig_${slug}`, t, t);
  h.db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
    p.id, `int_${slug}`, provider, network, mint, `sig_${slug}`, t);
  h.db.run(`UPDATE ideas SET status = 'launched' WHERE id = ?`, p.idea_id);
  return mint;
}

// --- schemas and SUB-01's pick ---------------------------------------------------------------------------------------
test('SUB-01 picks 3–4 generic tools plus at most one idea-specific one, by keywords (en/it/ja) and the brain', () => {
  const k = pickTools({ name: 'Konbini Confession', concept: KONBINI, networks: { language: 1 } });
  assert.deepEqual(k.map((t) => t.id), ['token', 'drop', 'wall', 'event']);
  assert.equal(k[1].config.revealJst, '23:00');
  assert.match(k[1].config.prompt, /^Drop your confession\. It stays private; one is featured here every day at 23:00 JST\.$/);
  assert.equal(k[3].config.daily, '23:00');
  assert.equal(pickTools({ name: 'X', concept: KONBINI, networks: { reward: 1 } })[2].id, 'poll', 'reward / control -> poll');
  assert.deepEqual(pickTools({ name: 'Ramen Radar', concept: 'A hand-drawn map of the best late-night ramen in Tokyo.', networks: {} }).map((t) => t.id), ['token', 'wall', 'memes', 'map']);
  assert.equal(readConcept('lofi beats per gatti, alle 23').extra, 'synth');
  assert.equal(readConcept('un gioco: fai punteggio ogni sera').extra, 'game');
  assert.equal(readConcept('maiban himitsu wo okuru').drop, true);
  assert.equal(readConcept('watch the price chart candles').extra, 'chart');
  assert.equal(conceptTime('at 11pm sharp'), '23:00');
  assert.equal(conceptTime('ogni notte a mezzanotte'), '00:00');
  assert.equal(conceptTime('22ji ni'), '22:00');
  for (const c of [KONBINI, 'cats', 'a game with a map and music and a chart and secrets every night, lol']) {
    const list = pickTools({ name: 'N', concept: c, networks: { visual: 1 } });
    const generic = list.filter((t) => !['map', 'synth', 'game', 'chart'].includes(t.id));
    assert.ok(generic.length >= 3 && generic.length <= 4 && list.length <= 5 && list[0].id === 'token', c);
  }
  const spec = templateGenerate({ idea: { title: 'Konbini Confession', concept: KONBINI }, brain: { networks: { language: 1 } } }).spec;
  assert.deepEqual(spec.tools, chooseTools({ title: 'Konbini Confession', concept: KONBINI }, { networks: { language: 1 } }));
});

test('tool configs are validated strictly; the spec refuses a bad tools list', () => {
  const ok = validateTools([{ id: 'poll', config: { question: 'Which?', options: [' A ', 'B'] } }]);
  assert.deepEqual(ok[0].config, { question: 'Which?', options: ['A', 'B'], holdersOnly: false });
  const bad = [
    [{ id: 'nope' }], [{ id: 'wall' }, { id: 'wall' }], [{ id: 'map', config: defaultConfig('map') }, { id: 'game' }],
    [{ id: 'poll', config: { question: 'Q?', options: ['A'] } }], [{ id: 'poll', config: { question: 'Q?', options: ['A', 'a'] } }],
    [{ id: 'wall', config: { title: '<b>x</b>' } }], [{ id: 'wall', config: { colour: 'red' } }], [{ id: 'token', extra: 1 }],
    [{ id: 'event', config: { title: 'Party', daily: '23:00', at: '2026-12-01T20:00' } }], [{ id: 'event', config: { title: 'Party' } }],
    [{ id: 'event', config: { title: 'Party', daily: '25:00' } }], [{ id: 'event', config: { title: 'Party', at: '2026-02-30T10:00' } }],
    [{ id: 'event', config: { title: 'Party', daily: '20:00', link: 'https://evil.example/drain' } }],
    [{ id: 'event', config: { title: 'Party', daily: '20:00', link: 'http://x.com/a' } }],
    [{ id: 'drop', config: { prompt: 'Tell me', revealJst: '9:00' } }], [{ id: 'drop', config: { prompt: 'Tell me', maxLength: 5000 } }],
    [{ id: 'map', config: { center: [100, 0] } }], [{ id: 'synth', config: { bpm: 400 } }], [{ id: 'chart', config: { range: '1y' } }],
    Array.from({ length: 7 }, (_, i) => ({ id: TOOL_IDS[i] })),
  ];
  for (const b of bad) assert.throws(() => validateTools(b), undefined, JSON.stringify(b));
  assert.equal(validateTools([{ id: 'event', config: { title: 'Space', daily: '20:00', link: 'https://x.com/i/spaces/1' } }])[0].config.link, 'https://x.com/i/spaces/1');
  const spec = templateGenerate({ idea: { title: 'Konbini Confession', concept: KONBINI }, brain: { networks: { language: 1 } } }).spec;
  assert.throws(() => validateSpec({ ...spec, tools: [{ id: 'poll', config: { question: 'Which way?', options: ['10x gains', 'b'] } }] }), /financial promises/);
  assert.throws(() => validateSpec({ ...spec, tools: 'all' }), /tools/);
  assert.doesNotThrow(() => validateSpec({ ...spec, tools: undefined }), 'sites built before the kit have no tools');
});

test('JST clock: reveal instants and local dates', () => {
  const t = Date.parse('2026-10-12T13:59:00Z');                // 22:59 JST
  assert.equal(new Date(lastJst(t, '23:00')).toISOString(), '2026-10-11T14:00:00.000Z');
  assert.equal(new Date(nextJst(t, '23:00')).toISOString(), '2026-10-12T14:00:00.000Z');
  assert.equal(new Date(lastJst(Date.parse('2026-10-12T14:00:00Z'), '23:00')).toISOString(), '2026-10-12T14:00:00.000Z');
  assert.equal(parseJstLocal('2026-10-12T20:00'), Date.parse('2026-10-12T11:00:00Z'));
});

// --- the validator and the build --------------------------------------------------------------------------------------
test('validateHtml allows exactly the kit script and stylesheet, and still refuses every other script', async () => {
  const spec = templateGenerate({ idea: { title: 'Konbini Confession', concept: KONBINI }, brain: { networks: { language: 1 } } }).spec;
  spec.tools = validateTools([...spec.tools, { id: 'memes' }, { id: 'map', config: defaultConfig('map') }].slice(0, 6));
  const context = { preview: false, launched: false, submitter: 'So1', generatorLabel: 'a fixed template', links: [{ href: 'https://subzerone.live', label: 'room' }], token: { state: 'pre-launch', links: [] } };
  const html = await sandboxBuild({ spec, context });
  assert.deepEqual(validateHtml(html, ['https://subzerone.live']), { ok: true, problems: [] });
  assert.equal(html.match(/<script/g).length, 1);
  assert.ok(html.includes('<script src="/_kit/site-kit.v1.js" defer></script></body>'));
  for (const id of spec.tools.map((t) => t.id)) assert.match(html, new RegExp(`<section class="tool card reveal[^"]*" id="tool-${id}" data-tool="${id}" data-config="`));
  assert.match(html, /Pre-launch: no token exists yet/);
  const page = (extra) => html.replace('</body>', `${extra}</body>`);
  const refused = [
    '<script>alert(1)</script>', '<script src="https://evil.example/x.js"></script>', '<script src="/_kit/vendor/tone-15.1.22.js"></script>',
    '<script src="/_kit/site-kit.v1.js" defer></script>', '<script type="module">import("/x")</script>', '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<link rel="stylesheet" href="/_kit/site-kit.v1.css">', '<img src="./logo.png" onerror="alert(1)">',
  ];
  for (const bad of refused) assert.equal(validateHtml(page(bad), ['https://subzerone.live']).ok, false, bad);
  assert.equal(validateHtml(html.replace('<script src="/_kit/site-kit.v1.js" defer></script></body>', '</body>').replace('<main>', '<main><script src="/_kit/site-kit.v1.js" defer></script>'), []).ok, false, 'kit script only right before </body>');
  assert.equal(validateHtml(html.replace('<script src="/_kit/site-kit.v1.js" defer></script>', '<script src="/_kit/site-kit.v1.js" defer>alert(1)</script>'), ['https://subzerone.live']).ok, false);
  assert.equal(validateHtml('<html><script>x</script></html>', []).ok, false, 'an inline script is refused');
  assert.equal(validateHtml('<html><script src="https://cdn.example/a.js"></script></html>', []).ok, false, 'a foreign script src is refused');
});

test('the public CSP allows only same-origin scripts and fetches; the preview none; tiles only with the map', () => {
  const pub = siteCsp('https://city.subzerone.live', { scripts: true });
  assert.equal(pub, "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://city.subzerone.live");
  assert.match(siteCsp('o', { scripts: true, tiles: true }), /img-src 'self' data: blob: https:\/\/tile\.openstreetmap\.org;/);
  const prev = siteCsp('o', { scripts: false, tiles: true });
  assert.ok(!/script-src|connect-src|openstreetmap/.test(prev), prev);
});

// --- the project host --------------------------------------------------------------------------------------------------
test('project host: the kit files, the CSP, tool endpoints, and nothing else', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const page = await k.site('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /^default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self';.*; sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads$/);
    assert.ok(!/openstreetmap/.test(page.headers['content-security-policy']), 'no map, no tile host');
    for (const t of ['token', 'drop', 'poll', 'event']) assert.match(page.text, new RegExp(`data-tool="${t}"`));   // the test brain is reward-dominant: a poll
    const js = await k.site('GET', '/_kit/site-kit.v1.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(js.headers['x-content-type-options'], 'nosniff');
    assert.equal((await k.site('GET', '/_kit/vendor/leaflet-1.9.4.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
    const gz = await k.site('GET', '/_kit/vendor/tone-15.1.22.js', undefined, { 'accept-encoding': 'gzip, br' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(Number(gz.headers['content-length']) < 100_000, 'Tone.js travels gzipped');
    assert.match((await k.site('GET', '/_kit/LICENSES.txt')).text, /Leaflet 1\.9\.4 \(BSD-2-Clause\)/);
    for (const p of ['/_kit/../package.json', '/_kit/site-kit.v2.js', '/_kit/vendor/../../src/app.js', '/_api/nothing']) assert.equal((await k.site('GET', p)).status, 404, p);
    assert.equal((await k.site('POST', '/', {})).status, 405);
    assert.equal((await k.site('OPTIONS', '/_api/wall')).status, 405, 'no CORS preflight answered');
    assert.equal((await k.site('GET', '/_api/wall')).status, 404, 'the wall is off on this site');
    const tok = await k.site('GET', '/_api/token');
    assert.equal(tok.json.state, 'pre-launch');
    assert.equal(tok.json.priceUsd, null);
    // the launchpad origin serves the kit's stylesheet too (the preview), and the preview stays script-free
    assert.equal((await hostCall(h.base, 'localhost:8787', 'GET', '/_kit/site-kit.v1.css')).status, 200);
    const link = (await k.owner.call('GET', `/api/projects/${k.slug}/preview-link`)).json.url;
    const prev = await k.owner.call('GET', link);
    assert.ok(!/script-src/.test(prev.headers.get('content-security-policy')));
    assert.match(prev.headers.get('content-security-policy'), /; sandbox$/);
  } finally { h.close(); }
});

test('wall: anonymous posts through the filter, newest first; cross-site and oversized writes refused; the author hides', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    assert.equal((await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [{ id: 'token' }, { id: 'wall' }] })).status, 200);
    const a = await k.site('POST', '/_api/wall', { text: '  first   note ' });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.entry.text, 'first note');
    await k.site('POST', '/_api/wall', { text: 'second note' });
    assert.deepEqual((await k.site('GET', '/_api/wall')).json.entries.map((e) => e.text), ['second note', 'first note']);
    assert.equal((await k.site('POST', '/_api/wall', { text: 'buy at https://scam.example' })).json.error, 'no_links');
    assert.equal((await k.site('POST', '/_api/wall', { text: 'x'.repeat(281) })).json.error, 'bad_text');
    assert.equal((await k.site('POST', '/_api/wall', { text: 'kys' })).json.error, 'blocked');
    assert.equal((await k.site('POST', '/_api/wall', { text: 'hi' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await k.site('POST', '/_api/wall', { text: 'x'.repeat(5000) })).status, 413);
    const inbox = (await k.owner.call('GET', `/api/projects/${k.slug}/tools`)).json.inbox;
    const id = inbox.wall.find((e) => e.text === 'first note').id;
    const stranger = h.client(user(h.db)); await stranger.signIn();
    assert.equal((await stranger.call('POST', `/api/projects/${k.slug}/tools/entries/${id}`, { hidden: true })).status, 404);
    assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/tools/entries/${id}`, { hidden: true })).status, 200);
    assert.deepEqual((await k.site('GET', '/_api/wall')).json.entries.map((e) => e.text), ['second note']);
    assert.equal((await k.owner.call('GET', `/api/projects/${k.slug}/tools`)).json.inbox.wall.find((e) => e.id === id).hidden, true);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM tool_entries WHERE ip_hash LIKE ?', '127.%').n, 0, 'the IP is never stored, only a salted hash');
  } finally { h.close(); }
});

test('poll: one signed vote per wallet; replayed, altered or foreign signatures refused', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const put = await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [{ id: 'token' }, { id: 'poll', config: { question: 'Best konbini snack?', options: ['Onigiri', 'Karaage-kun', 'Oden'] } }] });
    assert.equal(put.status, 200, put.text);
    const voter = wallet();
    let n = 0;
    const rotate = () => { k.ip = `10.1.0.${++n}`; };
    const sign = async (choice, w = voter) => (rotate(), await k.site('POST', '/_api/sign', { action: 'poll.vote', wallet: w.address, choice })).json;
    const ch = await sign(1);
    assert.match(ch.message, new RegExp(`^${k.host.replace(/\./g, '\\.')} asks you to sign a message with your Solana account:\\n${voter.address}\\n\\nVote "Karaage-kun" in the poll "Best konbini snack\\?"`));
    assert.match(ch.message, /This is a message, not a transaction: it moves no funds/);
    const vote = await k.site('POST', '/_api/poll', { choice: 1, wallet: voter.address, nonce: ch.nonce, signature: voter.signText(ch.message) });
    assert.equal(vote.status, 200, vote.text);
    assert.deepEqual(vote.json.counts, [0, 1, 0]);
    assert.equal(vote.json.mine, 1);
    rotate();
    assert.equal((await k.site('POST', '/_api/poll', { choice: 1, wallet: voter.address, nonce: ch.nonce, signature: voter.signText(ch.message) })).json.error, 'nonce_used');
    const again = await sign(2);
    const dup = await k.site('POST', '/_api/poll', { choice: 2, wallet: voter.address, nonce: again.nonce, signature: voter.signText(again.message) });
    assert.equal(dup.status, 409); assert.equal(dup.json.choice, 1);
    const other = wallet(), c2 = await sign(0, other);
    assert.equal((await k.site('POST', '/_api/poll', { choice: 2, wallet: other.address, nonce: c2.nonce, signature: other.signText(c2.message) })).json.error, 'payload_changed');
    const c3 = await sign(0, other);
    assert.equal((await k.site('POST', '/_api/poll', { choice: 0, wallet: other.address, nonce: c3.nonce, signature: voter.signText(c3.message) })).json.error, 'bad_signature');
    const c4 = await sign(0, other);
    h.db.run('UPDATE tool_nonces SET expires_at = 1 WHERE nonce = ?', c4.nonce);
    assert.equal((await k.site('POST', '/_api/poll', { choice: 0, wallet: other.address, nonce: c4.nonce, signature: other.signText(c4.message) })).json.error, 'nonce_expired');
    assert.equal((await k.site('POST', '/_api/sign', { action: 'poll.vote', wallet: other.address, choice: 7 })).json.error, 'bad_choice');
    assert.equal((await k.site('POST', '/_api/sign', { action: 'transfer', wallet: other.address })).json.error, 'bad_action');
    assert.deepEqual((await k.site('GET', '/_api/poll')).json.counts, [0, 1, 0]);
    // the per-IP write limit: 12 a minute from one address
    k.ip = '10.9.9.9';
    const codes = [];
    for (let i = 0; i < 13; i++) codes.push((await k.site('POST', '/_api/sign', { action: 'poll.vote', wallet: other.address, choice: 0 })).status);
    assert.deepEqual([codes.slice(0, 12).every((c) => c === 200), codes[12]], [true, 429]);
  } finally { h.close(); }
});

test('holders only: a signature is required; the chain is read when the server can, otherwise any wallet (said on the page)', async () => {
  assert.equal(holderMode({ coinStats: { heliusUrl: '' } }, null, true).mode, 'any');
  assert.match(holderMode({ coinStats: { heliusUrl: '' } }, { provider: 'pumpfun', network: 'mainnet-beta' }, true).note, /Holder checks are off/);
  assert.match(holderMode({ coinStats: { heliusUrl: 'x' } }, { provider: 'mock', network: 'mock' }, true).note, /MOCK launch/);
  assert.equal(holderMode({ coinStats: { heliusUrl: 'x' } }, { provider: 'pumpfun', network: 'mainnet-beta' }, true).mode, 'holders');
  let calls = 0;
  const rpc = (amount, fail = false) => async (url, init) => {
    calls++;
    const b = JSON.parse(init.body);
    assert.equal(b.method, 'getTokenAccountsByOwner');
    assert.deepEqual(b.params[1], { mint: 'MINT' });
    if (fail) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ result: { value: amount == null ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] } }));
  };
  const cfg = { coinStats: { heliusUrl: 'https://mainnet.helius-rpc.com/?api-key=k' } };
  assert.equal(await createHolderCheck({ cfg, fetchImpl: rpc('5') })('MINT', 'W'), true);
  const check = createHolderCheck({ cfg, fetchImpl: rpc('0') });
  assert.equal(await check('MINT', 'W'), false);
  assert.equal(await check('MINT', 'W'), false);
  assert.equal(calls, 2, 'cached');
  assert.equal(await createHolderCheck({ cfg, fetchImpl: rpc(null) })('MINT', 'W'), false);
  await assert.rejects(createHolderCheck({ cfg, fetchImpl: rpc('1', true) })('MINT', 'W'), /holder check could not read the chain/);

  const h = await harness(TP);
  try {
    const k = await konbini(h);
    await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [{ id: 'wall', config: { title: 'Holders', holdersOnly: true } }] });
    const s = (await k.site('GET', '/_api/wall')).json;
    assert.equal(s.mode, 'any');
    assert.match(s.note, /Holders only starts when the coin is launched/);
    assert.equal((await k.site('POST', '/_api/wall', { text: 'no signature' })).status, 401);
    const w = wallet();
    const ch = (await k.site('POST', '/_api/sign', { action: 'wall.post', wallet: w.address, text: 'gm holders' })).json;
    assert.match(ch.message, /Post on the wall of Konbini Confession \(\$KONBINI\): "gm holders"/);
    const ok = await k.site('POST', '/_api/wall', { text: 'gm holders', wallet: w.address, nonce: ch.nonce, signature: w.signText(ch.message) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.entry.by, `${w.address.slice(0, 4)}…${w.address.slice(-4)}`);
  } finally { h.close(); }
});

test('drop box: private until featured; the author features one; the daily rule picks one at the reveal; per-IP daily cap', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const r = await k.site('POST', '/_api/drop', { text: 'I ate the last melon pan and blamed the cat.' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.private, true);
    let pub = (await k.site('GET', '/_api/drop')).json;
    assert.equal(pub.featured, null);
    assert.ok(!JSON.stringify(pub).includes('melon pan'), 'submissions are never on the public endpoint');
    for (let i = 0; i < 4; i++) assert.equal((await k.site('POST', '/_api/drop', { text: `confession ${i}` })).status, 200);
    assert.equal((await k.site('POST', '/_api/drop', { text: 'one too many' })).status, 429, '5 a day per connection');
    const inbox = (await k.owner.call('GET', `/api/projects/${k.slug}/tools`)).json.inbox.drop;
    assert.equal(inbox.length, 5);
    const pick = inbox.find((e) => e.text.includes('melon pan'));
    assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/tools/entries/${pick.id}`, { featured: true })).status, 200);
    pub = (await k.site('GET', '/_api/drop')).json;
    assert.equal(pub.featured.text, 'I ate the last melon pan and blamed the cat.');
    assert.equal(pub.featured.by, 'the author');
    // the daily rule: nothing featured in the 24 h before a reveal -> one of that window's submissions
    const p = k.project(), conf = { revealJst: '23:00', autoPick: true };
    const later = lastJst(Date.now(), '23:00') + 3 * 86_400_000 + 60_000;
    h.db.run(`UPDATE tool_entries SET created_at = ? WHERE project_id = ? AND tool = 'drop' AND featured_at IS NULL`, later - 3_600_000 - 60_000, p.id);
    const auto = runDropRule(h.db, p, conf, later);
    assert.ok(auto);
    assert.equal(runDropRule(h.db, p, conf, later + 1000), null, 'once per reveal');
    assert.equal(h.db.get('SELECT featured_by FROM tool_entries WHERE id = ?', auto).featured_by, 'rule:daily');
    assert.equal(runDropRule(h.db, p, { ...conf, autoPick: false }, later + 86_400_000), null);
  } finally { h.close(); }
});

test('room PC: PUT /tools rebuilds the site; owner only; frozen between approval and launch; editable after launch', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const view = (await k.owner.call('GET', `/api/projects/${k.slug}/tools`)).json;
    assert.equal(view.editable, true);
    assert.deepEqual(view.tools.map((t) => t.id), ['token', 'drop', 'poll', 'event']);
    assert.deepEqual(Object.keys(view.catalog).sort(), [...TOOL_IDS].sort());
    const before = k.project().live_site_version;
    const put = await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [{ id: 'token' }, { id: 'event', config: { title: 'Receipt printing', at: '2030-01-01T23:00' } }, { id: 'memes' }, { id: 'map' }] });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.version, before + 1);
    assert.equal(put.json.tools[1].config.daily, undefined, 'a one-off date replaces the daily default');
    assert.equal(put.json.tools[3].config.center[0], 35.6812, 'switched on without fields: SUB-01 fills the defaults');
    const page = await k.site('GET', '/');
    assert.match(page.text, /Receipt printing/);
    assert.match(page.headers['content-security-policy'], /img-src 'self' data: blob: https:\/\/tile\.openstreetmap\.org/);
    assert.equal((await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [{ id: 'map' }, { id: 'game' }] })).status, 400);
    assert.equal((await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [{ id: 'event', config: { title: 'x', daily: '20:00', link: 'https://evil.example' } }] })).status, 400);
    const stranger = h.client(user(h.db)); await stranger.signIn();
    assert.equal((await stranger.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [] })).status, 404);
    assert.equal((await stranger.call('GET', `/api/projects/${k.slug}/tools`)).status, 404);
    h.db.run(`UPDATE ideas SET status = 'approved' WHERE id = ?`, k.ideaId);
    assert.equal((await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [] })).status, 409);
    fakeLaunch(h, k.slug);
    const off = await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [] });
    assert.equal(off.status, 200, 'launched coins can change their tools');
    assert.ok(!/<script/.test((await k.site('GET', '/')).text), 'no tools, no kit script');
    assert.equal((await k.site('GET', '/_api/token')).status, 404);
  } finally { h.close(); }
});

test('token panel: stored numbers and samples only; a mock launch says MOCK', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const mint = fakeLaunch(h, k.slug);
    let s = (await k.site('GET', '/_api/token')).json;
    assert.equal(s.state, 'mock'); assert.equal(s.marketCapUsd, null, 'no stats yet: null, shown as a dash');
    await refreshCoinStats(h.db, h.cfg, mint, { t: Date.now() - 60_000 });
    await refreshCoinStats(h.db, h.cfg, mint);
    s = (await k.site('GET', '/_api/token')).json;
    assert.equal(s.source, 'mock');
    assert.ok(s.marketCapUsd > 0 && s.holders.count > 0);
    assert.equal(s.samples.length, 2);
    assert.equal(tokenState(h.db, k.project(), Date.now(), '7d').samples.length, 2);
  } finally { h.close(); }
});

test('backfill: launched coins without tools get SUB-01\'s pick as a new public version, once', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const p = k.project();
    const row = h.db.get('SELECT * FROM site_versions WHERE project_id = ? AND version = ?', p.id, p.live_site_version);
    const old = JSON.parse(row.spec_json); delete old.tools;
    h.db.run('UPDATE site_versions SET spec_json = ? WHERE id = ?', JSON.stringify(old), row.id);   // as built before 2026-10-12
    fakeLaunch(h, k.slug);
    const out = await backfillTools(h.db, h.cfg);
    assert.deepEqual(out.added.map((a) => [a.slug, a.tools]), [[k.slug, ['token', 'drop', 'poll', 'event']]]);
    assert.equal(k.project().live_site_version, p.live_site_version + 1);
    assert.match(h.db.get(`SELECT message FROM events WHERE kind = 'tools' ORDER BY id DESC LIMIT 1`).message, /^SUB-01 added tools to the site: token, drop, poll, event/);
    assert.deepEqual((await backfillTools(h.db, h.cfg)).added, [], 'idempotent');
  } finally { h.close(); }
});

// --- the built kit ---------------------------------------------------------------------------------------------------
test('the built kit: no eval or HTML sinks in the core, every vendored library pinned, licensed and present', () => {
  const dir = join(ROOT, 'public', '_kit');
  const core = readFileSync(join(dir, 'site-kit.v1.js'), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'new Function', 'eval(', 'signTransaction', 'sendTransaction']) assert.ok(!core.includes(bad), bad);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const licences = readFileSync(join(dir, 'LICENSES.txt'), 'utf8');
  for (const lib of Object.values(LIBS)) {
    if (lib.file) { assert.ok(existsSync(join(dir, 'vendor', lib.file)), lib.file); assert.ok(manifest.files[`vendor/${lib.file}`], lib.file); }
    assert.ok(licences.includes(`${lib.name} ${lib.version} (${lib.licence})`), lib.name);
  }
  for (const id of TOOL_IDS) assert.ok(CATALOG[id]?.name && CATALOG[id].line, id);
  assert.ok(manifest.files['site-kit.v1.js'].gzip < 20_000, 'the core stays small');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const [name, v] of Object.entries(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} pinned exactly`);

});
