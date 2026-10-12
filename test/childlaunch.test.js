// Child launches (child-launch.js, docs/APP-COMPOSER.md "The launch block"): a launchpad coin's site launches REAL coins.
// The composer gives launchpad ideas the launch block; the block's split is validated; a visitor signs ONE message (coin,
// image hash, dev buy, exact split), SUB-01 votes, the child is built from what they signed, its launch goes through
// the same launch machinery (MOCK provider here), the 3-way split is the locked on-chain one, the launch is signed into
// the parent's post-quantum registry, and the child is its own building linked to the parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { harness, user, drain, IDEA, wallet, SUB01_WALLET } from './helpers.js';
import { validateApp, blockOf } from '../src/app-blocks.js';
import { composeRules, readIdea } from '../src/composer.js';
import { validateRecipients, CHILD_SPLIT_POLICY } from '../src/launch.js';
import { mockSigningText } from '../src/launch/mock.js';
import { verifyRegistry } from '../src/pq.js';
import { verifyEntries } from '../kit/app/pq.js';
import { worldView } from '../src/world.js';
import { setSetting } from '../src/db.js';
import { sha256 } from '../src/util.js';

const ENV = { TRUST_PROXY: '1', APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), REQUIRE_ADMIN_CLEARANCE: '0' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const QL = { title: 'Quantum launchpad', concept: 'a launchpad where everything is managed quantum-proof: anyone can launch their own coin here', ticker: 'QLAUNCH' };

function hostCall(base, host, method, path, body, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ host: u.hostname, port: u.port, path, method, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { const buf = Buffer.concat(chunks), text = buf.toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* raw */ } resolve({ status: res.statusCode, headers: res.headers, text, json, buf }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function later(ms, fn) { const real = Date.now; Date.now = () => real() + ms; try { return await fn(); } finally { Date.now = real; } }

/** A launchpad coin (MOCK-launched for real through the owner's routes) and a client for its host. */
async function launchpad(h, { idea = QL } = {}) {
  const owner = h.client(user(h.db));
  await owner.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: idea.title, nameSuggestion: idea.title, tickerSuggestion: idea.ticker, concept: idea.concept }));
  assert.equal(sub.status, 200, sub.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true })).status, 200);
  const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
  const host = `${slug}.${h.cfg.projectsHost}`, origin = `http://${host}`;
  const k = { ip: '10.0.0.1' };
  const site = (method, path, body, headers = {}) => hostCall(h.base, host, method, path, body, { 'x-forwarded-for': k.ip, ...(method === 'POST' ? { origin } : {}), ...headers });
  return Object.assign(k, { owner, slug, host, origin, site, ideaId: sub.json.id, project: () => h.db.get('SELECT * FROM projects WHERE slug = ?', slug) });
}
async function ownerLaunch(h, k) {
  const p = (await k.owner.call('GET', `/api/projects/${k.slug}`)).json;
  assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/approve`, { allocationId: p.allocation.id, statement: p.allocation.statement, siteVersion: p.liveSiteVersion })).status, 200);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  const tx = await k.owner.call('POST', `/api/projects/${k.slug}/launch/transaction`, {});
  assert.equal(tx.status, 200, tx.text);
  assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/launch/signed`, { signed: k.owner.w.signText(mockSigningText(tx.json.messageHash)) })).status, 200);
  await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
  assert.equal(h.db.get('SELECT status FROM ideas WHERE id = ?', k.ideaId).status, 'launched');
}
const COIN = { name: 'Lattice Cat', ticker: 'LCAT', description: 'A cat that guards the city with lattice signatures, launched from the quantum launchpad.' };
/** quote -> the visitor's wallet signs the message -> start. */
async function start(k, w, extra = {}, { image = PNG } = {}) {
  const fields = { ...COIN, devBuySol: 0, ...extra };
  const q = await k.site('POST', '/_api/launch/quote', { wallet: w.address, ...fields, imageSha256: sha256(Buffer.from(image, 'base64')) });
  if (q.status !== 200) return { q };
  const s = await k.site('POST', '/_api/launch/start', { wallet: w.address, nonce: q.json.nonce, signature: w.signText(q.json.message), ...fields, image });
  return { q, s };
}

test('composer: launchpad / token factory / create coins (en, it, ja romaji) get the launch block; a mention of "this launchpad" does not', () => {
  const kind = (concept, title = 'X') => composeRules({ title, concept }).app.kind;
  assert.equal(kind('a launchpad where everything is managed quantum-proof', 'Quantum launchpad'), 'launchpad');
  for (const c of ['A token factory for the ramen shops of Tokyo', 'Anyone can create coins here in one click', 'launch coins for your friends',
    'Una piattaforma di lancio dove tutti possono creare monete', 'crea il tuo token in un minuto', 'Shibuya no raunchipaddo: koin wo tsukuru basho', 'tokun hakkou no machi']) {
    assert.equal(kind(c), 'launchpad', c);
  }
  // SUBZERONE itself is "the launchpad": saying so does not make an idea a launchpad
  assert.equal(kind('It\'s a Tokyo Cat token representing bar in this city for people with cats and firs cat deployed on this launchpad.', 'Tokyo Bar for Cats'), 'places');
  assert.equal(readIdea('a launchpad where everything is managed quantum-proof').quantum, true);
  const q = composeRules({ title: 'Quantum launchpad', concept: 'a launchpad where everything is managed quantum-proof' }).app;
  assert.ok(blockOf(q, 'launch') && blockOf(q, 'pq'), 'quantum-themed: the launch block and the registry');
  assert.equal(blockOf(composeRules({ title: 'Coin Forge', concept: 'A token factory for the ramen shops of Tokyo' }).app, 'pq'), null, 'not quantum: no registry');
  assert.equal(composeRules({ title: 'Quantum launchpad', concept: 'a launchpad where everything is managed quantum-proof' }, { child: true }).app.kind, 'pq', 'a child never hosts launches');
});

test('launch block: the split is the author\'s within the limits (SUB-01 >= 20%, creator >= 50%), validated on the server', () => {
  const app = (split) => ({ v: 1, title: 'Launch here', screens: [{ id: 'l', title: 'Launch', blocks: [{ type: 'launch', ...(split ? { split } : {}) }] }] });
  assert.deepEqual(blockOf(validateApp(app()), 'launch').split, { creator: 7000, parent: 1000, sub01: 2000 });
  assert.deepEqual(blockOf(validateApp(app({ creator: 6000, parent: 2000, sub01: 2000 })), 'launch').split, { creator: 6000, parent: 2000, sub01: 2000 });
  assert.deepEqual(blockOf(validateApp(app({ creator: 8000, parent: 0, sub01: 2000 })), 'launch').split.parent, 0);
  for (const bad of [{ creator: 7000, parent: 1500, sub01: 1500 }, { creator: 4000, parent: 3000, sub01: 3000 }, { creator: 7000, parent: 1000, sub01: 1000 }, { creator: 7000, parent: 1000, sub01: 2001 }, { creator: 7000, parent: 1000 }]) {
    assert.throws(() => validateApp(app(bad)), /split/, JSON.stringify(bad));
  }
  assert.throws(() => validateApp({ v: 1, title: 'Two', screens: [{ id: 'l', title: 'L', blocks: [{ type: 'launch' }, { type: 'launch' }] }] }), /one launch block/);
  // the recipients check the launch configuration repeats
  const cfg = { sub01FeeWallet: SUB01_WALLET };
  const c = wallet().address, a = wallet().address;
  const rows = (cb, pb, sb) => [{ role: 'submitter', wallet: c, bps: cb, label: 'Creator' }, ...(pb ? [{ role: 'parent', wallet: a, bps: pb, label: 'Author' }] : []), { role: 'sub01', wallet: SUB01_WALLET, bps: sb }];
  assert.equal(validateRecipients(cfg, rows(7000, 1000, 2000), c, CHILD_SPLIT_POLICY).length, 3);
  assert.throws(() => validateRecipients(cfg, rows(7000, 1500, 1500), c, CHILD_SPLIT_POLICY), /at least 20%/);
  assert.throws(() => validateRecipients(cfg, rows(4000, 3000, 3000), c, CHILD_SPLIT_POLICY), /at least 50%/);
  assert.throws(() => validateRecipients(cfg, rows(7000, 1000, 2000), c), /unknown role parent/, 'a city coin has no parent row');
});

test('child launch (MOCK): one signed message -> SUB-01 build -> the child built from what was signed -> reviewed tx -> launched with the locked 3-way split, registry, city', async () => {
  const h = await harness(ENV);
  try {
    const k = await launchpad(h);
    // before the parent is launched, its site does not launch coins
    let st = await k.site('GET', '/_api/launch');
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.open, false);
    assert.match(st.json.pausedNote, /once Quantum Launchpad itself is launched/);
    const visitor = wallet();
    assert.equal((await start(k, visitor)).q.json.error, 'parent_not_launched');
    await ownerLaunch(h, k);
    st = await k.site('GET', '/_api/launch');
    assert.equal(st.json.open, true);
    assert.deepEqual(st.json.split, { creator: 7000, parent: 1000, sub01: 2000 });
    assert.equal(st.json.counts.launched, 0);
    const page = (await k.site('GET', '/')).text;
    assert.match(page, /data-type="launch"/);
    assert.match(page, /70% to its creator, 10% to this site's author, 20% to SUB-01/);
    assert.match(page, /The launch block asks your wallet for a transaction only to create the coin you asked for/);

    // the review: the exact split is in the message the wallet signs
    const author = h.db.get(`SELECT receiving_wallet FROM idea_versions WHERE idea_id = ?`, k.ideaId).receiving_wallet;
    const { q, s } = await start(k, visitor, { devBuySol: 0.01 });
    assert.equal(q.status, 200, q.text);
    assert.deepEqual(q.json.recipients.map((r) => [r.role, r.wallet, r.bps]), [['submitter', visitor.address, 7000], ['parent', author, 1000], ['sub01', SUB01_WALLET, 2000]]);
    assert.match(q.json.message, /This is a message, not a transaction/);
    assert.match(q.json.message, new RegExp(`70\\.00% to you, the creator \\(${visitor.address}\\); 10\\.00% to Quantum Launchpad's author \\(${author}\\); 20\\.00% to SUB-01 \\(${SUB01_WALLET}\\)`));
    assert.match(q.json.message, /Dev buy: 0\.01 SOL/);
    assert.match(q.json.message, new RegExp(`Image sha256: ${sha256(Buffer.from(PNG, 'base64'))}`));
    assert.equal(s.status, 200, s.text);
    const { id: cid, key } = s.json;
    // the signature binds the image: another image with a fresh quote for the first one is refused
    const q2 = await k.site('POST', '/_api/launch/quote', { wallet: visitor.address, ...COIN, devBuySol: 0, imageSha256: sha256(Buffer.from(PNG, 'base64')) });
    const swapped = await k.site('POST', '/_api/launch/start', { wallet: visitor.address, nonce: q2.json.nonce, signature: visitor.signText(q2.json.message), ...COIN, devBuySol: 0, image: PNG2 });
    assert.equal(swapped.json.error, 'payload_changed');
    // replay, another site's origin
    assert.equal((await k.site('POST', '/_api/launch/start', { wallet: visitor.address, nonce: q.json.nonce, signature: visitor.signText(q.json.message), ...COIN, devBuySol: 0.01, image: PNG })).json.error, 'nonce_used');
    assert.equal((await k.site('POST', '/_api/launch/quote', { wallet: visitor.address, ...COIN }, { origin: 'http://evil.test' })).status, 403);

    let v = (await k.site('GET', `/_api/launch/${cid}`)).json;
    assert.equal(v.status, 'submitted');
    const idea = h.db.get('SELECT * FROM ideas WHERE id = ?', s.json.ideaId);
    assert.equal(idea.visibility, 'public');
    assert.equal(idea.owner_wallet, visitor.address);
    const plot = h.db.get('SELECT plot_id FROM plots WHERE idea_id = ?', idea.id);
    assert.ok(plot, 'the child has its own building plot');

    // SUB-01 votes build -> child_build -> prepare_launch (no reviewer, the creator's signature is the approval)
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    v = (await k.site('GET', `/_api/launch/${cid}`)).json;
    assert.equal(v.status, 'launch_prepared', JSON.stringify(v.note));
    assert.equal(v.verdict.verdict, 'build');
    assert.ok(v.verdict.summary);
    const child = h.db.get('SELECT * FROM projects WHERE idea_id = ?', idea.id);
    assert.equal(child.parent_project_id, k.project().id);
    assert.equal(child.name, 'Lattice Cat'); assert.equal(child.ticker, 'LCAT');
    assert.equal(h.db.get(`SELECT sha256 FROM assets WHERE project_id = ? AND kind = 'logo'`, child.id).sha256, sha256(Buffer.from(PNG, 'base64')), 'the logo is the signed image');
    assert.equal(v.config.locked, true);
    assert.deepEqual(v.config.recipients.map((r) => [r.role, r.bps]), [['submitter', 7000], ['parent', 1000], ['sub01', 2000]]);
    assert.equal(v.config.initialBuyLamports, 10_000_000);
    assert.equal(v.config.devBuyMode, 'second_tx');
    assert.equal((await k.owner.call('PUT', `/api/projects/${child.slug}/allocation`, { recipients: [] })).status, 404, 'not the parent author\'s to change');
    const childSite = await hostCall(h.base, `${child.slug}.${h.cfg.projectsHost}`, 'GET', '/');
    assert.match(childSite.text, /Launched at <a href="http:\/\/quantum-launchpad\.projects\.localhost:8787\/"/);
    assert.doesNotMatch(childSite.text, /data-type="launch"/, 'a child never launches coins itself');

    // the transaction: the key is needed; the visitor's wallet signs the reviewed (mock) transaction
    assert.equal((await k.site('POST', `/_api/launch/${cid}/tx`, { key: 'x'.repeat(32) })).json.error, 'bad_key');
    const tx = await k.site('POST', `/_api/launch/${cid}/tx`, { key });
    assert.equal(tx.status, 200, tx.text);
    assert.equal(tx.json.mock, true);
    assert.equal(tx.json.mockSigningText, mockSigningText(tx.json.messageHash));
    const ref = await k.site('POST', `/_api/launch/${cid}/refresh`, { key });
    assert.equal(ref.json.mint, tx.json.mint);
    assert.equal((await k.site('POST', `/_api/launch/${cid}/signed`, { key, signed: wallet().signText(tx.json.mockSigningText) })).json.error, 'bad_signed_tx', 'another wallet cannot sign it');
    const sg = await k.site('POST', `/_api/launch/${cid}/signed`, { key, signed: visitor.signText(tx.json.mockSigningText) });
    assert.equal(sg.status, 200, sg.text);
    await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    v = (await k.site('GET', `/_api/launch/${cid}`)).json;
    assert.equal(v.status, 'launched');
    assert.equal(v.launch.mint, tx.json.mint);
    assert.equal(v.devBuy.status, 'pending');
    // the 3-way split is what the (mock) chain verification compared: the locked allocation
    assert.equal(h.db.get(`SELECT status FROM fee_allocations WHERE project_id = ?`, child.id).status, 'locked');

    // step 2: the dev buy
    const b1 = await k.site('POST', `/_api/launch/${cid}/devbuy/tx`, { key });
    assert.equal(b1.status, 200, b1.text);
    const b2 = await k.site('POST', `/_api/launch/${cid}/devbuy/refresh`, { key });
    assert.equal((await k.site('POST', `/_api/launch/${cid}/devbuy/signed`, { key, signed: visitor.signText(b2.json.mockSigningText) })).status, 200);
    await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal((await k.site('GET', `/_api/launch/${cid}`)).json.devBuy.status, 'done');

    // the parent's post-quantum registry: the child launch is signed in, and verifies the way the browser does it
    v = (await k.site('GET', `/_api/launch/${cid}`)).json;
    assert.ok(v.registry && v.registry.seq > 0, 'signed into the parent registry at launch');
    const reg = (await k.site('GET', '/_api/app/pq')).json;
    const entry = reg.entries.find((e) => e.kind === 'child.launch');
    const payload = JSON.parse(entry.payload);
    assert.equal(payload.mint, tx.json.mint);
    assert.equal(payload.configSha256, child.launch_config_hash ?? h.db.get('SELECT config_hash FROM launch_intents WHERE project_id = ?', child.id).config_hash);
    assert.deepEqual(payload.split.map((x) => x.bps), [7000, 1000, 2000]);
    assert.equal(payload.locked, true);
    const checked = await verifyEntries(ml_dsa65, reg, reg.entries);
    assert.ok(checked.every((x) => x.sig && x.payload && x.link !== false));
    assert.deepEqual(verifyRegistry(h.db, k.project()), { ok: true, problems: [] });

    // the parent's list and numbers; the child's logo served on the parent's origin; the city
    st = (await k.site('GET', '/_api/launch')).json;
    assert.equal(st.counts.launched, 1);
    assert.equal(st.children[0].slug, child.slug);
    const logo = await k.site('GET', st.children[0].logoUrl);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers['content-type'], 'image/png');
    assert.match(logo.headers['content-security-policy'], /sandbox/);
    const w = worldView(h.db, h.cfg);
    const kid = w.plots.find((x) => x.project?.slug === child.slug);
    assert.deepEqual(kid.project.parent, { slug: k.slug, name: 'Quantum Launchpad' });
    assert.equal(w.plots.find((x) => x.project?.slug === k.slug)?.project?.childrenLaunched ?? 1, 1);
    // the token metadata image is the creator's image, served as what it is
    const cfgJson = JSON.parse(h.db.get('SELECT config_json FROM launch_intents WHERE project_id = ?', child.id).config_json);
    const meta = await fetch(`${h.base}${new URL(cfgJson.token.metadata.image).pathname}`);
    assert.equal(meta.headers.get('content-type'), 'image/png');
  } finally { h.close(); }
});

test('child launch: SUB-01 passes -> nothing built, his feedback shown; the author launching on their own site keeps both shares; a reviewer when clearance is on', async () => {
  const h = await harness({ ...ENV, REQUIRE_ADMIN_CLEARANCE: '1' });
  try {
    const k = await launchpad(h);
    const admin = h.client(user(h.db, 'admin')); await admin.signIn();
    const p = (await k.owner.call('GET', `/api/projects/${k.slug}`)).json;
    assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/approve`, { allocationId: p.allocation.id, statement: p.allocation.statement, siteVersion: p.liveSiteVersion })).status, 200);
    assert.equal((await admin.call('POST', `/api/admin/projects/${k.slug}/clear`, {})).status, 200);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const tx = await k.owner.call('POST', `/api/projects/${k.slug}/launch/transaction`, {});
    await k.owner.call('POST', `/api/projects/${k.slug}/launch/signed`, { signed: k.owner.w.signText(mockSigningText(tx.json.messageHash)) });
    await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));

    h.brain.state.mode = 'pass';
    const visitor = wallet();
    const { s } = await start(k, visitor, { name: 'Rooftop Pigeon', ticker: 'PIGEON', description: 'A census of rooftop pigeons over Shibuya, counted by hand every morning.' });
    assert.equal(s.status, 200, s.text);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const v = (await k.site('GET', `/_api/launch/${s.json.id}`)).json;
    assert.equal(v.status, 'declined');
    assert.equal(v.verdict.verdict, 'pass');
    assert.match(v.verdict.summary, /^Pass/);
    assert.equal(v.project, null);
    assert.equal((await k.site('GET', `/_api/launch/${s.json.id}/image`)).status, 404, 'a passed coin\'s image is not served');
    assert.equal(h.db.get('SELECT 1 FROM plots WHERE idea_id = ?', s.json.ideaId), undefined, 'the plot is given back');

    // the author launches on their own site: creator + parent shares merge into one row (80 / 20)
    h.brain.state.mode = 'build';
    const own = await start(k, k.owner.w, { name: 'Author Coin', ticker: 'AUTH', description: 'The author of the quantum launchpad launches a coin on it too.' });
    assert.equal(own.s.status, 200, own.s.text);
    assert.deepEqual(own.q.json.recipients.map((r) => [r.role, r.bps]), [['submitter', 8000], ['sub01', 2000]]);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal((await k.site('GET', `/_api/launch/${own.s.json.id}`)).json.status, 'preview_ready', 'waits for a reviewer');
    const slug = h.db.get('SELECT slug FROM projects WHERE idea_id = ?', own.s.json.ideaId).slug;
    assert.equal((await admin.call('POST', `/api/admin/projects/${slug}/clear`, {})).status, 200);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal((await k.site('GET', `/_api/launch/${own.s.json.id}`)).json.status, 'launch_prepared');

    // limits: a pause closes it; the author edits the split within the limits and the next quote uses it
    setSetting(h.db, 'pause.launch', true, 'test');
    assert.equal((await start(k, wallet())).q.status, 503);
    setSetting(h.db, 'pause.launch', false, 'test');
    const app = JSON.parse(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', k.project().id, k.project().live_site_version).spec_json).app;
    blockOf(app, 'launch').split = { creator: 6000, parent: 2000, sub01: 2000 };
    assert.equal((await k.owner.call('PUT', `/api/projects/${k.slug}/app`, { app })).status, 200);
    const q = await k.site('POST', '/_api/launch/quote', { wallet: wallet().address, ...COIN, imageSha256: sha256(Buffer.from(PNG, 'base64')) });
    assert.deepEqual(q.json.recipients.map((r) => r.bps), [6000, 2000, 2000]);
    blockOf(app, 'launch').split = { creator: 6500, parent: 2000, sub01: 1500 };
    assert.equal((await k.owner.call('PUT', `/api/projects/${k.slug}/app`, { app })).status, 400, 'SUB-01 below 20% is refused');
  } finally { h.close(); }
});

test('the launch block is SUB-01\'s to give: an idea that is not a launchpad cannot add it', async () => {
  const h = await harness(ENV);
  try {
    const k = await launchpad(h, { idea: { title: 'Ramen Radar', concept: 'A tiny coin about a hand-drawn map of the best late-night ramen in Tokyo, updated by the community.', ticker: 'RAMEN' } });
    assert.equal((await k.site('GET', '/_api/launch')).json.error, 'launch_off');
    const app = { v: 1, title: 'Sneaky launcher', screens: [{ id: 'l', title: 'Launch', blocks: [{ type: 'launch' }] }] };
    const r = await k.owner.call('PUT', `/api/projects/${k.slug}/app`, { app });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'launch_locked');
  } finally { h.close(); }
});

test('the built launch module: the only kit file that asks for a transaction (sign only, never send), no HTML sinks; loaded by the app module', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('../src/config.js');
  const dir = join(ROOT, 'public', '_kit'), code = readFileSync(join(dir, 'site-launch.v1.js'), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'new Function', 'eval(', 'sendTransaction', 'signAndSendTransaction']) assert.ok(!code.includes(bad), bad);
  assert.ok(code.includes('solana:signTransaction'));
  for (const f of ['site-kit.v1.js', 'site-app.v1.js']) assert.ok(!readFileSync(join(dir, f), 'utf8').includes('signTransaction'), f);
  assert.ok(readFileSync(join(dir, 'site-app.v1.js'), 'utf8').includes('/_kit/site-launch.v1.js'));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files['site-launch.v1.js'].gzip < 12_000, 'the launch module stays small');
});
