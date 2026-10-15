// Launchpad families (family.js, docs/APP-COMPOSER.md "Launchpad families"): the PadPad idea, "a launchpad for
// launchpads". The composer gives such an idea launch{children: 'launchpads'} + the family tree and nothing else; a coin
// launched from it is a launchpad with its own working launch block, recursively, down to MAX_DEPTH; its creator fees
// flow up the tree (creator / parent / grandparent / SUB-01, computed on the server and re-checked at prepare and at
// signing); the tree API and block show who launched whom; the city gets the family as a neighbourhood.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { harness, user, drain, IDEA, wallet, SUB01_WALLET } from './helpers.js';
import { validateApp, blockOf, blocksOf } from '../src/app-blocks.js';
import { composeRules, composeApp, readIdea, toolsBeside } from '../src/composer.js';
import { childKind, familyBps, MAX_DEPTH, FAMILY_RULE, forgetTree } from '../src/family.js';
import { mockSigningText } from '../src/launch/mock.js';
import { makePumpfunProvider, launchInstructions, decodeFeeShares, checkSignedShares, MAX_SHAREHOLDERS, compiledTxBytes } from '../src/launch/pumpfun.js';
import { worldView } from '../src/world.js';
import { sha256 } from '../src/util.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const ENV = { TRUST_PROXY: '1', APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), REQUIRE_ADMIN_CLEARANCE: '0' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// the idea as the owner submitted it (2026-10-12)
export const PADPAD = { title: 'PadPad', ticker: 'PADPAD', concept: 'PadPad ($PADPAD). A launchpad for launchpads. You don\'t launch a coin here, you launch a launchpad, and every launchpad born here can launch coins that can be launchpads too. Creator fees flow up the family tree, split and locked on-chain at launch: the creator, the parent launchpad, the grandparent, and SUB-01. The site shows the live family tree: who launched whom, which branch is growing fastest, which launchpad has the most descendants. In the city, every launchpad becomes a building and its children grow around it as a neighbourhood.' };

function hostCall(base, host, method, path, body, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ host: u.hostname, port: u.port, path, method, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* raw */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function later(ms, fn) { const real = Date.now; Date.now = () => real() + ms; try { return await fn(); } finally { Date.now = real; } }
const siteOf = (h, slug, ip = '10.0.0.1') => {
  const host = `${slug}.${h.cfg.projectsHost}`, origin = `http://${host}`;
  return { slug, host, site: (method, path, body, headers = {}) => hostCall(h.base, host, method, path, body, { 'x-forwarded-for': ip, ...(method === 'POST' ? { origin } : {}), ...headers }) };
};

/** The root: an idea submitted in the city (a plot), built by SUB-01, MOCK-launched by its owner. */
async function root(h, idea = PADPAD) {
  const owner = h.client(user(h.db));
  await owner.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: idea.title, nameSuggestion: idea.title, tickerSuggestion: idea.ticker, concept: idea.concept, plotId: 'ginza-2' }));
  assert.equal(sub.status, 200, sub.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true })).status, 200);
  const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
  const p = (await owner.call('GET', `/api/projects/${slug}`)).json;
  assert.equal((await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: p.allocation.id, statement: p.allocation.statement, siteVersion: p.liveSiteVersion })).status, 200);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  const tx = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
  assert.equal(tx.status, 200, tx.text);
  assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: owner.w.signText(mockSigningText(tx.json.messageHash)) })).status, 200);
  await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
  return { owner, slug, ideaId: sub.json.id, ...siteOf(h, slug) };
}
const N = { n: 0 };
/** A visitor launches from `k`'s site, signs, SUB-01 builds it, the visitor signs the reviewed (mock) launch. */
async function launchFrom(h, k, w, extra = {}, { finish = true } = {}) {
  const i = ++N.n;
  const fields = { name: `Pad Gen ${i}`, ticker: `PADG${i}`, description: `Generation ${i} of the PadPad family: a launchpad that launches the next one.`, devBuySol: 0, ...extra };
  const q = await k.site('POST', '/_api/launch/quote', { wallet: w.address, ...fields, imageSha256: sha256(Buffer.from(PNG, 'base64')) });
  if (q.status !== 200) return { q };
  const s = await k.site('POST', '/_api/launch/start', { wallet: w.address, nonce: q.json.nonce, signature: w.signText(q.json.message), ...fields, image: PNG });
  assert.equal(s.status, 200, s.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  const child = h.db.get('SELECT * FROM projects WHERE idea_id = ?', s.json.ideaId);
  const out = { q, s, child, w, key: s.json.key, id: s.json.id, ...siteOf(h, child.slug) };
  if (!finish) return out;
  const tx = await k.site('POST', `/_api/launch/${s.json.id}/tx`, { key: s.json.key });
  assert.equal(tx.status, 200, tx.text);
  const sg = await k.site('POST', `/_api/launch/${s.json.id}/signed`, { key: s.json.key, signed: w.signText(tx.json.mockSigningText) });
  assert.equal(sg.status, 200, sg.text);
  await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
  assert.equal((await k.site('GET', `/_api/launch/${s.json.id}`)).json.status, 'launched');
  return out;
}
const rows = (r) => r.map((x) => [x.role, x.wallet, x.bps]);
const authorOfIdea = (h, ideaId) => h.db.get('SELECT receiving_wallet FROM idea_versions WHERE idea_id = ?', ideaId).receiving_wallet;

test('composer: the PadPad idea gets launch{children: launchpads} + the family tree and nothing else, by the rules and through the model', async () => {
  const r = composeRules(PADPAD, { name: 'PadPad', ticker: 'PADPAD' });
  assert.equal(r.app.kind, 'launchpad-family');
  assert.deepEqual(r.app.screens.flatMap((s) => s.blocks).map((b) => b.type), ['launch', 'tree'], 'the launcher and its tree, no form, votes or map');
  assert.equal(blockOf(r.app, 'launch').children, 'launchpads');
  assert.deepEqual(blockOf(r.app, 'launch').split, { creator: 7000, parent: 1000, sub01: 2000 });
  assert.match(r.honest, /never to buyers or holders/);
  assert.doesNotMatch(JSON.stringify(r.app), /holders? (get|earn|receive)|yield|returns?/i);
  // the site's other tools: the coin's own and the fixed wall (no meme maker, map, poll…)
  const tools = ['token', 'wall', 'memes', 'map', 'poll', 'drop', 'event', 'chart', 'trades', 'holders', 'devwatch', 'fees', 'alerts'].map((id) => ({ id }));
  assert.deepEqual(toolsBeside(tools, r.app).map((t) => t.id), ['token', 'wall', 'chart', 'trades', 'holders', 'devwatch', 'fees', 'alerts']);
  // other ways of saying it (en / it / ja romaji); a single launchpad is still a plain launchpad
  for (const c of ['a launchpad of launchpads', 'launchpads that launch launchpads', 'you launch a launchpad here, not a coin', 'a launchpad with the family tree of every coin launched from it',
    'una piattaforma dove lanciare un launchpad', 'Shibuya no raunchipaddo no raunchipaddo']) {
    assert.equal(composeRules({ title: 'X', concept: c }).app.kind, 'launchpad-family', c);
  }
  for (const c of ['build a launchpad where anyone can launch coins', 'A token factory for the ramen shops of Tokyo', 'Q-wave is the launchpad with the first post-quantum registry of every launch']) {
    const a = composeRules({ title: 'X', concept: c }).app;
    assert.equal(a.kind, 'launchpad', c);
    assert.equal(blockOf(a, 'launch').children, 'coins');
    assert.equal(blockOf(a, 'tree'), null);
  }
  assert.equal(readIdea('a tiny coin about ramen in the family tree of noodles').recursive, false, 'a family tree without launchpads is not a family of launchpads');
  // a child never hosts launches through the rules (the launchpad children get launchpadFamilyApp from child-launch.js)
  assert.notEqual(composeRules(PADPAD, { child: true }).app.kind, 'launchpad-family');

  // the model path: it keeps the launcher's children and the tree, adds nothing irrelevant, else the rules
  const cfg = { generator: { anthropicKey: 'test-key' } };
  const reply = (app) => async () => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(app) }], stop_reason: 'end_turn' }), { status: 200 });
  const good = { ...r.app, title: 'PadPad: launch a launchpad, by the model' };
  let out = await composeApp(PADPAD, {}, { name: 'PadPad', ticker: 'PADPAD', cfg, fetchImpl: reply(good) });
  assert.equal(out.app.title, 'PadPad: launch a launchpad, by the model');
  assert.equal(out.app.kind, 'launchpad-family');
  const coinsOnly = JSON.parse(JSON.stringify(good)); blockOf(coinsOnly, 'launch').children = 'coins';
  out = await composeApp(PADPAD, {}, { name: 'PadPad', ticker: 'PADPAD', cfg, fetchImpl: reply(coinsOnly) });
  assert.equal(blockOf(out.app, 'launch').children, 'launchpads', 'the children option is SUB-01\'s, not the model\'s');
  const noTree = { ...good, screens: [{ id: 'launch', title: 'Launch', blocks: [blockOf(good, 'launch')] }] };
  const withMap = { ...good, screens: [{ ...good.screens[0], blocks: [...good.screens[0].blocks, { type: 'map', title: 'Where', center: [35.6, 139.7], zoom: 12, places: [], community: true }] }] };
  const withForm = { ...good, screens: [...good.screens, { id: 'ideas', title: 'Ideas', blocks: [{ type: 'submit', title: 'Suggest', prompt: 'Suggest a launchpad name', fields: [{ key: 'text', label: 'Name', kind: 'text', required: true }] }] }] };
  for (const [why, app] of [['dropped the tree', noTree], ['added a map', withMap], ['added a form', withForm]]) {
    out = await composeApp(PADPAD, {}, { name: 'PadPad', ticker: 'PADPAD', cfg, fetchImpl: reply(app) });
    assert.equal(out.source, 'rules', why);
    assert.match(out.fallback, /family tree|does not use/, why);
    assert.deepEqual(out.app.screens.flatMap((s) => s.blocks).map((b) => b.type), ['launch', 'tree'], why);
  }
  // a plain launchpad idea cannot get a tree from the model
  const plain = composeRules({ title: 'Coin Forge', concept: 'A token factory for the ramen shops of Tokyo' }, { name: 'Coin Forge', ticker: 'FORGE' }).app;
  const plainTree = { ...plain, screens: [{ ...plain.screens[0], blocks: [...plain.screens[0].blocks, { type: 'tree' }] }] };
  out = await composeApp({ title: 'Coin Forge', concept: 'A token factory for the ramen shops of Tokyo' }, {}, { name: 'Coin Forge', ticker: 'FORGE', cfg, fetchImpl: reply(plainTree) });
  assert.equal(out.source, 'rules');
  assert.equal(blockOf(out.app, 'tree'), null);
});

test('the DSL: launch.children and the tree block are validated', () => {
  const app = (blocks) => ({ v: 1, title: 'Family', screens: [{ id: 'l', title: 'Launch', blocks }] });
  assert.equal(blockOf(validateApp(app([{ type: 'launch' }])), 'launch').children, 'coins', 'default: coins, as before');
  for (const c of ['coins', 'launchpads', 'choice']) assert.equal(blockOf(validateApp(app([{ type: 'launch', children: c }])), 'launch').children, c);
  assert.throws(() => validateApp(app([{ type: 'launch', children: 'everything' }])), /children: one of coins, launchpads, choice/);
  assert.deepEqual(blockOf(validateApp(app([{ type: 'launch' }, { type: 'tree' }])), 'tree'), { type: 'tree', title: 'The family tree', rankings: true });
  assert.throws(() => validateApp(app([{ type: 'tree' }])), /family tree needs the launch block/);
  assert.throws(() => validateApp(app([{ type: 'launch' }, { type: 'tree' }, { type: 'tree' }])), /one tree block/);
  assert.throws(() => validateApp(app([{ type: 'launch' }, { type: 'tree', script: 'x' }])), /unknown field/);
});

test('the fee rule and the depth limit (pure): 70/10/20 below a root, 60/10/10/20 below that, coins only at the last generation', () => {
  assert.equal(MAX_DEPTH, 5);
  assert.deepEqual(FAMILY_RULE, { depth1: { creator: 7000, parent: 1000, sub01: 2000 }, deeper: { creator: 6000, parent: 1000, grandparent: 1000, sub01: 2000 } });
  // a stub database: a chain root <- p1 <- p2 <- p3 <- p4 <- p5
  const P = {}; for (let i = 0; i <= 5; i++) P[`p${i}`] = { id: `p${i}`, name: `P${i}`, parent_project_id: i ? `p${i - 1}` : null };
  const db = { get: (_sql, id) => P[id] };
  const split = { creator: 7000, parent: 1000, sub01: 2000 };
  const bps = (p) => { const { grandparentProject, ...r } = familyBps(db, p, split); return r; };
  assert.deepEqual(bps(P.p0), { creator: 7000, parent: 1000, grandparent: 0, sub01: 2000 }, 'launched from the root (depth 1)');
  assert.deepEqual(bps(P.p1), { creator: 6000, parent: 1000, grandparent: 1000, sub01: 2000 }, 'depth 2');
  assert.deepEqual(bps(P.p2), { creator: 6000, parent: 1000, grandparent: 1000, sub01: 2000 }, 'depth 3: still only the grandparent, no great-grandparent');
  // the creator keeps 50% at least: a block that gives the parent 30% leaves the grandparent nothing
  const { grandparentProject, ...big } = familyBps(db, P.p2, { creator: 5000, parent: 3000, sub01: 2000 });
  assert.deepEqual(big, { creator: 5000, parent: 3000, grandparent: 0, sub01: 2000 });
  // what a coin launched from pN is
  const pads = { children: 'launchpads' }, choice = { children: 'choice' }, coins = { children: 'coins' };
  assert.deepEqual(childKind(db, P.p0, pads), { depth: 1, launchpad: true, mode: 'launchpads', can: true });
  assert.deepEqual(childKind(db, P.p3, pads), { depth: 4, launchpad: true, mode: 'launchpads', can: true });
  assert.deepEqual(childKind(db, P.p4, pads), { depth: 5, launchpad: false, mode: 'launchpads', can: false }, 'generation 5 is a coin');
  assert.equal(childKind(db, P.p0, choice, false).launchpad, false);
  assert.equal(childKind(db, P.p0, choice, true).launchpad, true);
  assert.throws(() => childKind(db, P.p4, choice, true), /max depth 5/);
  assert.throws(() => childKind(db, P.p0, coins, true), /launches coins, not launchpads/);
  assert.equal(childKind(db, P.p0, {}, false).launchpad, false, 'a block from before families launches coins');
});

test('pump.fun: the split instruction in the signed bytes is checked share by share (at most 10 shareholders); a tampered or mismatched split is refused', async () => {
  assert.equal(MAX_SHAREHOLDERS, 10);
  const pumpSdk = require('@pump-fun/pump-sdk');
  assert.equal(pumpSdk.MAX_SHAREHOLDERS ?? 10, 10, 'the SDK\'s own limit');
  const payer = web3.Keypair.generate(), mint = web3.Keypair.generate();
  const holders = [payer.publicKey, web3.Keypair.generate().publicKey, web3.Keypair.generate().publicKey, web3.Keypair.generate().publicKey].map((k) => k.toBase58());
  const shares = [[holders[0], 6000], [holders[1], 1000], [holders[2], 1000], [holders[3], 2000]].map(([wallet, bps]) => ({ wallet, bps }));
  const config = { name: 'Pad Gen', symbol: 'PADG', uri: 'https://subzerone.live/m/0123456789abcdef.json', initialBuyLamports: 0, feeSharing: { mode: 'sharing_config', shareholders: shares } };
  const { ixs } = await launchInstructions({ config, mint: mint.publicKey, signer: payer.publicKey });
  // the launch lookup table (every static account) as `npm run lookup-table` makes it
  const keys = [...new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()))].filter((k) => k !== payer.publicKey.toBase58() && k !== mint.publicKey.toBase58());
  const table = new web3.AddressLookupTableAccount({ key: web3.Keypair.generate().publicKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: keys.map((k) => new web3.PublicKey(k)) } });
  const blockhash = web3.Keypair.generate().publicKey.toBase58();
  const msg = new web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([table]);
  assert.deepEqual(decodeFeeShares(ixs[2].data), shares, 'the SDK wrote exactly these shares');
  assert.deepEqual(checkSignedShares(msg, config), shares);
  // 4 shareholders fit the Phantom-safe layout with room for the wallet's guards (measured offline)
  const size = await compiledTxBytes({ ...config, name: 'A'.repeat(32), symbol: 'B'.repeat(10) });
  assert.ok(size.fits && size.phantomSafe && size.bytes <= 1232 - 150, JSON.stringify(size));

  const conn = { getAddressLookupTable: async () => ({ value: table }) };
  const provider = makePumpfunProvider({ launch: { rpcUrl: 'http://127.0.0.1:1', network: 'devnet', lookupTable: table.key.toBase58() } }, { connection: conn });
  const tx = new web3.VersionedTransaction(msg);
  const intent = { signer_wallet: payer.publicKey.toBase58(), mint: mint.publicKey.toBase58(), tx_base64: Buffer.from(tx.serialize()).toString('base64'),
    tx_message_hash: createHash('sha256').update(msg.serialize()).digest('hex'), config_json: JSON.stringify(config) };
  const mintSecret = Buffer.from(mint.secretKey).toString('base64');
  const signed = new web3.VersionedTransaction(msg); signed.sign([payer]);
  const ok = await provider.verifySigned(intent, Buffer.from(signed.serialize()).toString('base64'), { mintSecret });
  assert.ok(ok.signature);
  // the wallet (or anything between) changed one share: not the reviewed launch
  const bad = web3.VersionedTransaction.deserialize(signed.serialize());
  const ix = bad.message.compiledInstructions.find((c) => decodeFeeShares(c.data));
  const d = Buffer.from(ix.data); d.writeUInt16LE(5000, 12 + 32); d.writeUInt16LE(3000, 12 + 34 + 32); ix.data = d;   // creator 50%, the parent 30%
  bad.sign([payer]);
  await assert.rejects(() => provider.verifySigned(intent, Buffer.from(bad.serialize()).toString('base64'), { mintSecret }), /differs from the reviewed one/);
  // the reviewed bytes themselves do not carry the approved split (a config whose rows changed): refused before anything is sent
  const other = { ...config, feeSharing: { ...config.feeSharing, shareholders: shares.map((s, i) => ({ ...s, bps: [7000, 1000, 0, 2000][i] })).filter((s) => s.bps) } };
  await assert.rejects(() => provider.verifySigned({ ...intent, config_json: JSON.stringify(other) }, Buffer.from(signed.serialize()).toString('base64'), { mintSecret }), /differ from the approved split/);
  await assert.rejects(() => provider.verifySigned({ ...intent, config_json: JSON.stringify({ ...config, feeSharing: { mode: 'direct', shareholders: [shares[0]] } }) }, Buffer.from(signed.serialize()).toString('base64'), { mintSecret }), /a fee split the approved configuration does not have/);
  assert.throws(() => decodeFeeShares(Buffer.concat([d.subarray(0, 8), Buffer.from([11, 0, 0, 0]), Buffer.alloc(11 * 34)])), /malformed/, 'more than 10 shareholders cannot be decoded as a valid split');
});

test('PadPad end to end (MOCK): launchpads launched from launchpads down to 5 generations, the fee tree at every depth, strict re-checks, the tree, the city', async () => {
  const h = await harness({ ...ENV, LAUNCH_SPLIT_TX: '0' });
  try {
    const k0 = await root(h);
    const rootAuthor = authorOfIdea(h, k0.ideaId);
    const p0 = h.db.get('SELECT * FROM projects WHERE slug = ?', k0.slug);
    // depth 0: a city coin, 80/20 as always
    assert.deepEqual(JSON.parse(h.db.get(`SELECT recipients_json FROM fee_allocations WHERE project_id = ? AND status = 'locked'`, p0.id).recipients_json).map((r) => [r.role, r.bps]), [['submitter', 8000], ['sub01', 2000]]);
    // the root site: the launcher of launchpads and the tree; no wall, meme maker or map
    const spec0 = JSON.parse(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p0.id, p0.live_site_version).spec_json);
    assert.deepEqual(spec0.app.screens.flatMap((s) => s.blocks).map((b) => [b.type, b.children ?? null]), [['launch', 'launchpads'], ['tree', null]]);
    assert.deepEqual(spec0.tools.map((t) => t.id).filter((id) => ['memes', 'map', 'poll', 'drop', 'event', 'game', 'synth'].includes(id)), []);
    let page = (await k0.site('GET', '/')).text;
    assert.match(page, /data-type="tree"/);
    assert.match(page, /Launch a launchpad/);
    assert.match(page, /Every coin launched here is a launchpad too: its own site launches coins, down to depth 5 of the family \(this site is at depth 0\)/);
    assert.match(page, /70% to its creator, 10% to this site's author, 20% to SUB-01\. The fees go to the creators of the launchpads up the family tree, never to buyers or holders\./);
    let v = (await k0.site('GET', '/_api/launch')).json;
    assert.deepEqual([v.childrenMode, v.depth, v.childDepth, v.childCanBeLaunchpad, v.maxDepth], ['launchpads', 0, 1, true, 5]);
    assert.deepEqual(v.familySplit, { creator: 7000, parent: 1000, grandparent: 0, sub01: 2000 });

    // generation 1, from the root: 70 / 10 / 20, and it is a launchpad
    const A = wallet(), B = wallet(), C = wallet(), D = wallet(), E = wallet();
    const g1 = await launchFrom(h, k0, A);
    assert.equal(g1.q.json.launchpad, true); assert.equal(g1.q.json.depth, 1);
    assert.match(g1.q.json.message, /Launch a LAUNCHPAD from PadPad/);
    assert.match(g1.q.json.message, /depth 1 of at most 5/);
    assert.match(g1.q.json.message, /Buying or holding the coin pays nobody anything/);
    assert.deepEqual(rows(g1.q.json.recipients), [['submitter', A.address, 7000], ['parent', rootAuthor, 1000], ['sub01', SUB01_WALLET, 2000]]);
    assert.equal(h.db.get('SELECT plot_id FROM plots WHERE idea_id = ?', g1.child.idea_id), undefined, 'no city address of its own');
    // its own site: a working launch block (launchpads, inheriting the root's options) and the tree
    const spec1 = JSON.parse(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', g1.child.id, h.db.get('SELECT live_site_version v FROM projects WHERE id = ?', g1.child.id).v).spec_json);
    assert.deepEqual(spec1.app.screens.flatMap((s) => s.blocks).map((b) => [b.type, b.children ?? null]), [['launch', 'launchpads'], ['tree', null]]);
    page = (await g1.site('GET', '/')).text;
    assert.match(page, /Launched at <a href="http:\/\/padpad\./);
    assert.match(page, /this site is at depth 1/);
    assert.match(page, /60% to its creator, 10% to this site's author, 10% to the author of the launchpad above this one, 20% to SUB-01/);
    v = (await g1.site('GET', '/_api/launch')).json;
    assert.equal(v.open, true, 'a launched launchpad of the family opens its launches');
    assert.deepEqual([v.depth, v.childDepth, v.root], [1, 2, 'padpad']);
    assert.deepEqual(v.familySplit, { creator: 6000, parent: 1000, grandparent: 1000, sub01: 2000 });
    assert.deepEqual(v.ancestors.map((a) => a.slug), ['padpad']);

    // generation 2: 60 / 10 / 10 / 20, the grandparent is the root's author
    const g2 = await launchFrom(h, g1, B);
    assert.deepEqual(rows(g2.q.json.recipients), [['submitter', B.address, 6000], ['parent', A.address, 1000], ['grandparent', rootAuthor, 1000], ['sub01', SUB01_WALLET, 2000]]);
    assert.match(g2.q.json.message, /10\.00% to PadPad's author \(the grandparent launchpad\)/);
    // what went on the (mock) chain is that split, and the allocation locked
    const cfg2 = JSON.parse(h.db.get('SELECT config_json FROM launch_intents WHERE project_id = ?', g2.child.id).config_json);
    assert.deepEqual(cfg2.feeSharing.shareholders, [{ wallet: B.address, bps: 6000 }, { wallet: A.address, bps: 1000 }, { wallet: rootAuthor, bps: 1000 }, { wallet: SUB01_WALLET, bps: 2000 }]);
    assert.equal(h.db.get('SELECT status FROM fee_allocations WHERE project_id = ?', g2.child.id).status, 'locked');

    // generation 3: the grandparent is generation 1, the root gets nothing any more (it stops at the grandparent)
    const g3 = await launchFrom(h, g2, C);
    assert.deepEqual(rows(g3.q.json.recipients), [['submitter', C.address, 6000], ['parent', B.address, 1000], ['grandparent', A.address, 1000], ['sub01', SUB01_WALLET, 2000]]);
    assert.ok(!g3.q.json.recipients.some((r) => r.wallet === rootAuthor));
    // the creator is their own grandparent: the shares merge (A launches from g2, whose parent g1 is A's)
    const merged = await launchFrom(h, g2, A, {}, { finish: false });
    assert.deepEqual(rows(merged.q.json.recipients), [['submitter', A.address, 7000], ['parent', B.address, 1000], ['sub01', SUB01_WALLET, 2000]]);

    // generation 4: still a launchpad; its children are generation 5, coins
    const g4 = await launchFrom(h, g3, D);
    v = (await g4.site('GET', '/_api/launch')).json;
    assert.deepEqual([v.depth, v.childDepth, v.childCanBeLaunchpad], [4, 5, false]);
    const g5 = await launchFrom(h, g4, E);
    assert.equal(g5.q.json.launchpad, false, 'generation 5 is a coin');
    assert.match(g5.q.json.message, /It is a coin, not a launchpad \(depth 5 is the family's maximum\)/);
    assert.deepEqual(rows(g5.q.json.recipients), [['submitter', E.address, 6000], ['parent', D.address, 1000], ['grandparent', C.address, 1000], ['sub01', SUB01_WALLET, 2000]]);
    const st5 = await g5.site('GET', '/_api/launch');
    assert.equal(st5.status, 404); assert.equal(st5.json.error, 'launch_off');
    assert.doesNotMatch((await g5.site('GET', '/')).text, /data-type="launch"/);
    // a plain coin of a family cannot become a launchpad by editing its app
    const app5 = { v: 1, title: 'Sneaky', screens: [{ id: 'l', title: 'L', blocks: [{ type: 'launch', children: 'launchpads' }, { type: 'tree' }] }] };
    const eOwner = h.client(E); await eOwner.signIn();
    assert.equal((await eOwner.call('PUT', `/api/projects/${g5.slug}/app`, { app: app5 })).json.error, 'launch_locked');

    // strict re-checks: a launch configuration whose rows were changed after the visitor signed is refused at signing
    const F = wallet();
    const t1 = await launchFrom(h, g1, F, {}, { finish: false });
    const tx = await g1.site('POST', `/_api/launch/${t1.id}/tx`, { key: t1.key });
    assert.equal(tx.status, 200, tx.text);
    const intent = h.db.get(`SELECT * FROM launch_intents WHERE project_id = ? AND status = 'awaiting_signature'`, t1.child.id);
    const c = JSON.parse(intent.config_json);
    c.feeSharing.shareholders = c.feeSharing.shareholders.map((s) => (s.wallet === F.address ? { ...s, bps: 5000 } : s.wallet === A.address ? { ...s, bps: 2000 } : s));
    h.db.run('UPDATE launch_intents SET config_json = ? WHERE id = ?', JSON.stringify(c), intent.id);
    let sg = await g1.site('POST', `/_api/launch/${t1.id}/signed`, { key: t1.key, signed: F.signText(tx.json.mockSigningText) });
    assert.equal(sg.status, 409); assert.equal(sg.json.error, 'split_mismatch');
    // … and the signed record itself cannot be swapped for a different (still valid-looking) split either
    h.db.run('UPDATE launch_intents SET config_json = ? WHERE id = ?', intent.config_json, intent.id);
    const cl = h.db.get('SELECT * FROM child_launches WHERE id = ?', t1.id);
    h.db.run('UPDATE child_launches SET split_json = ? WHERE id = ?', JSON.stringify({ creator: 6000, parent: 2000, sub01: 2000 }), t1.id);
    sg = await g1.site('POST', `/_api/launch/${t1.id}/signed`, { key: t1.key, signed: F.signText(tx.json.mockSigningText) });
    assert.equal(sg.status, 409); assert.match(sg.json.message, /family rule/);
    h.db.run('UPDATE child_launches SET split_json = ? WHERE id = ?', cl.split_json, t1.id);
    sg = await g1.site('POST', `/_api/launch/${t1.id}/signed`, { key: t1.key, signed: F.signText(tx.json.mockSigningText) });
    assert.equal(sg.status, 200, sg.text);
    await later(3000, () => drain(h.db, h.cfg, h.brain.fetchImpl));

    // the tree: the same family from any of its sites, public, cached
    forgetTree();
    const tr = await fetch(`${h.base}/api/projects/${g3.slug}/tree`);
    assert.equal(tr.status, 200);
    assert.match(tr.headers.get('cache-control'), /public, max-age=15/);
    const t = await tr.json();
    assert.equal(t.root, 'padpad'); assert.equal(t.focus, g3.slug); assert.equal(t.maxDepth, 5);
    const byS = new Map(t.nodes.map((n) => [n.slug, n]));
    assert.deepEqual([g1, g2, g3, g4, g5, t1].map((x) => [byS.get(x.slug).depth, byS.get(x.slug).parent, byS.get(x.slug).launchpad]),
      [[1, 'padpad', true], [2, g1.slug, true], [3, g2.slug, true], [4, g3.slug, true], [5, g4.slug, false], [2, g1.slug, true]]);
    assert.equal(byS.get('padpad').descendants, 6);
    assert.equal(byS.get(g1.slug).descendants, 5);
    assert.equal(byS.get(g1.slug).children, 2);
    assert.equal(byS.get(g1.slug).launches24h, 2);
    assert.equal(byS.get(g1.slug).branch24h, 5);
    assert.equal(byS.get(g2.slug).inProgress, 1, 'A\'s coin from g2 is on its way');
    assert.ok(byS.get(g2.slug).siteUrl.startsWith(`http://${g2.slug}.`));
    assert.ok(byS.get(g5.slug).launchedAt > 0 && byS.get(g5.slug).mock === true);
    assert.deepEqual(t.totals, { coins: 6, launchpads: 5, launched24h: 6, deepest: 5, inProgress: 1 });
    assert.equal(t.fastest[0].slug, g1.slug, 'the fastest-growing branch: generation 1, five launches in 24 h');
    assert.equal(t.fastest[0].branch24h, 5);
    assert.deepEqual(t.mostDescendants.map((x) => [x.slug, x.descendants]).slice(0, 3), [['padpad', 6], [g1.slug, 5], [g2.slug, 3]]);
    assert.match(t.note, /never to buyers or holders/);
    assert.equal(t.nodes.some((n) => n.slug === merged.slug), false, 'not launched yet: counted as on its way, not drawn');
    // the site's own route answers the same family, focused on that site
    const ts = await g4.site('GET', '/_api/tree');
    assert.equal(ts.status, 200); assert.equal(ts.json.focus, g4.slug); assert.equal(ts.json.root, 'padpad');
    // tomorrow nothing is "fastest"
    forgetTree();
    const { treeView } = await import('../src/family.js');
    const tomorrow = treeView(h.db, h.cfg, p0, Date.now() + 2 * 86_400_000);
    assert.deepEqual(tomorrow.fastest, []); assert.equal(tomorrow.totals.launched24h, 0);
    assert.equal((await fetch(`${h.base}/api/projects/nope/tree`)).status, 404);

    // the city: the root's plot carries the family; nobody else has a plot
    const w = worldView(h.db, h.cfg);
    const home = w.plots.find((x) => x.project?.slug === 'padpad').project;
    assert.equal(home.family.total, 7, 'six launched + the one on its way');
    assert.deepEqual(home.family.members.slice(0, 2).map((m) => [m.depth, m.parent]), [[1, 'padpad'], [2, g1.slug]], 'breadth first');
    assert.deepEqual(home.family.members.find((m) => m.slug === g5.slug), { slug: g5.slug, name: g5.child.name, ticker: g5.child.ticker, depth: 5, parent: g4.slug, stage: 'launched', launched: true, mock: true, launchpad: false, siteUrl: `http://${g5.slug}.${h.cfg.projectsHost}/` });
    assert.equal(w.plots.filter((x) => x.kind === 'project').length, 1);
  } finally { h.close(); }
});

test('the launch block\'s "choice": the launcher ticks it, and what they ticked is what they signed', async () => {
  const h = await harness(ENV);
  try {
    const k0 = await root(h);
    const p0 = h.db.get('SELECT * FROM projects WHERE slug = ?', k0.slug);
    const app = JSON.parse(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p0.id, p0.live_site_version).spec_json).app;
    blockOf(app, 'launch').children = 'choice';
    const put = await k0.owner.call('PUT', `/api/projects/${k0.slug}/app`, { app });
    assert.equal(put.status, 200, put.text);
    assert.match((await k0.site('GET', '/')).text, /The launcher chooses: a coin, or a launchpad/);
    const coin = await launchFrom(h, k0, wallet(), { launchpad: false });
    assert.equal(coin.q.json.launchpad, false);
    assert.equal((await coin.site('GET', '/_api/launch')).json.error, 'launch_off', 'a coin is a coin');
    const pad = await launchFrom(h, k0, wallet(), { launchpad: true });
    assert.equal(pad.q.json.launchpad, true);
    const v = (await pad.site('GET', '/_api/launch')).json;
    assert.equal(v.childrenMode, 'choice', 'the child inherits the choice');
    // the tick is part of the signed payload: flipping it after the quote is refused
    const w = wallet(), fields = { name: 'Flip Pad', ticker: 'FLIP', description: 'A launchpad that tries to become a coin after the signature.', devBuySol: 0 };
    const q = await k0.site('POST', '/_api/launch/quote', { wallet: w.address, ...fields, launchpad: true, imageSha256: sha256(Buffer.from(PNG, 'base64')) });
    const s = await k0.site('POST', '/_api/launch/start', { wallet: w.address, nonce: q.json.nonce, signature: w.signText(q.json.message), ...fields, launchpad: false, image: PNG });
    assert.equal(s.json.error, 'payload_changed');
    assert.equal((await k0.site('POST', '/_api/launch/quote', { wallet: w.address, ...fields, launchpad: 'yes', imageSha256: sha256(Buffer.from(PNG, 'base64')) })).json.error, 'bad_launchpad');
    // a root whose block says coins refuses a launchpad
    blockOf(app, 'launch').children = 'coins';
    assert.equal((await k0.owner.call('PUT', `/api/projects/${k0.slug}/app`, { app })).status, 200);
    assert.equal((await k0.site('POST', '/_api/launch/quote', { wallet: w.address, ...fields, launchpad: true, imageSha256: sha256(Buffer.from(PNG, 'base64')) })).json.error, 'coins_only');
  } finally { h.close(); }
});

test('the built kit: the tree block is in the app module, text only, and the launch module offers the launchpad choice', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('../src/config.js');
  const dir = join(ROOT, 'public', '_kit');
  const appJs = readFileSync(join(dir, 'site-app.v1.js'), 'utf8'), launchJs = readFileSync(join(dir, 'site-launch.v1.js'), 'utf8'), css = readFileSync(join(dir, 'site-kit.v2.css'), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'new Function', 'eval(']) { assert.ok(!appJs.includes(bad), bad); assert.ok(!launchJs.includes(bad), bad); }
  assert.ok(appJs.includes('/_api/tree'));
  assert.ok(appJs.includes('Fastest-growing branch') && appJs.includes('Most descendants') && appJs.includes('Who launched whom'));
  assert.ok(launchJs.includes('Make it a launchpad'));
  assert.ok(css.includes('.tr-kids') && css.includes('.tr-row'));
});

test('tree: a root still in private preview (not public yet) still has a tree, never a crash', async () => {
  const { treeView } = await import('../src/family.js');
  const rows = [];
  const db = { all: (sql) => (/COUNT\(\*\)/.test(sql) ? [] : [{ id: 'r', slug: 'padpad', name: 'PadPad', ticker: 'PADPAD', parent_project_id: null, idea_id: 'i', live_site_version: 1, depth: 0, status: 'preview_ready', visibility: 'private', verified_at: null }]),
    get: () => null };
  const v = treeView(db, { projectsScheme: 'https', projectsHost: 'projects.example' }, { id: 'r', slug: 'padpad', parent_project_id: null });
  assert.equal(v.focus, 'padpad');
  void rows;
});
