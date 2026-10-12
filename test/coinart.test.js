// The black-and-white coin art (coinart.js, coinart-render.js, coinart-glyphs.js, art-choice.js; 2026-10-12): providers
// mocked (Higgsfield submit/poll/complete/failed/nsfw/timeout, Recraft), the SVG sanitiser, the rasteriser, the local
// fallback, owner-supplied art, the author's pick between the two options and the mime-correct serving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';
import { makeCoinArt, higgsfieldImage, recraftImages, premadeArt, download, logoPrompt, bannerPrompt, initialOf, HF_POLL } from '../src/coinart.js';
import { sanitizeSvg, normalizeImage, ArtError, sniff, localVariants, localLogoSvg, renderPng } from '../src/coinart-render.js';
import { pickSymbol, PICTOGRAMS } from '../src/coinart-glyphs.js';
import { decodeOwnPng } from '../src/postcard.js';
import { siteContext } from '../src/site.js';
import { harness, makeEnv, user, drain, IDEA, fakeBrain } from './helpers.js';

HF_POLL.delays = [5];                                       // poll fast in tests
const size = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];
const QWAVE_SVG = readFileSync(join(ROOT, 'art/qwave/logo.svg'));
const tinyPng = () => renderPng('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#000"/><circle cx="32" cy="32" r="20" fill="#fff"/></svg>');
const ART = (over = {}) => ({ hfKeyId: 'kid', hfKeySecret: 'ksecret', hfBase: 'https://api.higgsfield.ai', hfLogoModel: 'recraft/v4.1/text-to-image',
  hfBannerModel: 'recraft/v4.1/text-to-image', recraftModel: 'recraftv4_1_vector', timeoutMs: 5000, dir: join(ROOT, 'art'), ...over });
const IDEA_IN = { title: 'Agent Desk', concept: 'AI agents that watch new coins for you.' };
const SPEC = { name: 'Agent Desk', ticker: 'AGENT' };

/** A fake Higgsfield: script = per request the list of statuses to walk; records every call. */
function fakeHiggsfield(script = () => ['queued', 'in_progress', 'completed'], { image = () => tinyPng(), statusUrl } = {}) {
  const calls = [];
  let n = 0;
  const reqs = new Map();
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.hostname === 'cdn.higgsfield.test') return new Response(image(u.pathname), { status: 200 });
    if (init.method === 'POST') {
      const id = `00000000-0000-0000-0000-00000000000${n}`;
      reqs.set(id, { steps: script(n++, JSON.parse(init.body)), i: 0 });
      return Response.json({ status: 'queued', request_id: id, status_url: statusUrl ?? `https://api.higgsfield.ai/requests/${id}/status` });
    }
    const id = u.pathname.split('/')[2];
    const r = reqs.get(id);
    const status = r.steps[Math.min(++r.i, r.steps.length - 1)];
    return Response.json({ status, request_id: id, ...(status === 'completed' ? { images: [{ url: `https://cdn.higgsfield.test/${id}.png` }] } : {}),
      ...(status === 'failed' ? { error: 'Generation failed' } : {}) });
  };
  return { fetchImpl, calls };
}

test('higgsfield: submit with key, idempotency key and the B/W body; poll the status URL; download images[0]', async () => {
  const hf = fakeHiggsfield();
  const out = await higgsfieldImage(ART(), { model: 'recraft/v4.1/text-to-image', prompt: 'p', aspect: '1:1', key: 'k1' }, { fetchImpl: hf.fetchImpl });
  assert.equal(sniff(out.bytes), 'png');
  assert.equal(out.requestId, '00000000-0000-0000-0000-000000000000');
  const sub = hf.calls[0];
  assert.equal(sub.url, 'https://api.higgsfield.ai/recraft/v4.1/text-to-image');
  assert.equal(sub.init.headers.authorization, 'Key kid:ksecret');
  assert.equal(sub.init.headers['idempotency-key'], 'k1');
  assert.deepEqual(JSON.parse(sub.init.body), { prompt: 'p', resolution: '1k', aspect_ratio: '1:1', output_format: 'png',
    colors: [{ rgb: [255, 255, 255] }, { rgb: [0, 0, 0] }], background_color: { rgb: [0, 0, 0] } });
  assert.ok(hf.calls.slice(1, -1).every((c) => /\/requests\/[\w-]+\/status$/.test(c.url) && c.init.headers.authorization === 'Key kid:ksecret'));
  assert.equal(hf.calls.at(-1).init.headers?.authorization, undefined, 'the key never goes to the CDN');
});

test('higgsfield: a status_url on another host is ignored (the key stays on the API origin); HF_PARAMS merges into the body', async () => {
  const hf = fakeHiggsfield(undefined, { statusUrl: 'https://evil.test/requests/x/status' });
  await higgsfieldImage(ART({ hfParams: '{"model_type":"vector"}' }), { model: 'm/x', prompt: 'p', aspect: '16:9', key: 'k' }, { fetchImpl: hf.fetchImpl });
  assert.ok(hf.calls.every((c) => !c.url.startsWith('https://evil.test')));
  assert.equal(JSON.parse(hf.calls[0].init.body).model_type, 'vector');
});

test('higgsfield: failed, nsfw and canceled end the request with an error; HTTP errors carry the detail', async () => {
  for (const end of ['failed', 'nsfw', 'canceled']) {
    const hf = fakeHiggsfield(() => ['queued', end]);
    await assert.rejects(higgsfieldImage(ART(), { model: 'm', prompt: 'p', aspect: '1:1', key: 'k' }, { fetchImpl: hf.fetchImpl }), new RegExp(`ended ${end}`));
  }
  const denied = async () => Response.json({ detail: 'Insufficient credits' }, { status: 403 });
  await assert.rejects(higgsfieldImage(ART(), { model: 'm', prompt: 'p', aspect: '1:1', key: 'k' }, { fetchImpl: denied }), /higgsfield 403: Insufficient credits/);
});

test('makeCoinArt: Higgsfield gives both options, one request each with distinct stable keys; banners composed around the logos', async () => {
  const hf = fakeHiggsfield();
  const spent = [];
  const cfg = { art: ART({ priceUsd: 0.04 }) };
  const r = await makeCoinArt({ cfg, idea: IDEA_IN, spec: SPEC, seed: 's1', fetchImpl: hf.fetchImpl, spend: (u) => spent.push(u) });
  assert.deepEqual(r.provider, ['higgsfield', 'higgsfield']);
  assert.deepEqual(r.notes, []);
  assert.equal(r.symbol.id, 'robot', 'agents -> a robot face');
  const posts = hf.calls.filter((c) => c.init.method === 'POST');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].init.headers['idempotency-key'], posts[1].init.headers['idempotency-key']);
  assert.match(JSON.parse(posts[0].init.body).prompt, /robot face/);
  for (const c of r.candidates) {
    assert.deepEqual(size(c.logo.body), [512, 512]);
    assert.deepEqual(size(c.banner.body), [1500, 844]);
    assert.ok(decodeOwnPng(c.logo.body), 'readable by the postcard decoder (8-bit RGBA, filter 0)');
    const g = JSON.parse(c.logo.generator);
    assert.equal(g.provider, 'higgsfield');
    assert.equal(g.model, 'recraft/v4.1/text-to-image');
    assert.match(g.prompt, /letter "A"/);
    assert.ok(g.requestId);
  }
  // the same intent again (a retried job) sends the same keys: Higgsfield answers with the original requests
  const hf2 = fakeHiggsfield();
  await makeCoinArt({ cfg, idea: IDEA_IN, spec: SPEC, seed: 's1', fetchImpl: hf2.fetchImpl });
  assert.deepEqual(hf2.calls.filter((c) => c.init.method === 'POST').map((c) => c.init.headers['idempotency-key']), posts.map((c) => c.init.headers['idempotency-key']));
  assert.deepEqual(spent, [0.08]);
});

test('makeCoinArt: one Higgsfield request fails -> that option is drawn locally and the note says so', async () => {
  const hf = fakeHiggsfield((n) => (n === 1 ? ['queued', 'nsfw'] : ['queued', 'completed']));
  const r = await makeCoinArt({ cfg: { art: ART() }, idea: IDEA_IN, spec: SPEC, seed: 's', fetchImpl: hf.fetchImpl });
  assert.deepEqual(r.provider, ['higgsfield', 'local']);
  assert.match(r.notes[0], /higgsfield failed for option 2 .*nsfw/);
});

test('makeCoinArt: Higgsfield never finishes -> the deadline ends it and the local generator draws both, saying why', async () => {
  const hf = fakeHiggsfield(() => ['queued', 'in_progress']);
  const t = Date.now();
  const r = await makeCoinArt({ cfg: { art: ART({ timeoutMs: 150 }) }, idea: IDEA_IN, spec: SPEC, seed: 's', fetchImpl: hf.fetchImpl });
  assert.ok(Date.now() - t < 5000);
  assert.deepEqual(r.provider, ['local', 'local']);
  assert.equal(r.notes.length, 2);
  assert.match(r.notes[0], /no answer within/);
});

test('makeCoinArt: no keys -> the local generator, two deliberate variants, prompt and symbol recorded', async () => {
  const r = await makeCoinArt({ cfg: { art: { dir: join(ROOT, 'art') } }, idea: { title: 'Night Train', concept: 'A coin for the last train home.' }, spec: { name: 'Night Train', ticker: 'NIGHT' }, seed: 's' });
  assert.deepEqual(r.provider, ['local', 'local']);
  assert.equal(r.symbol.id, 'train');
  const [a, b] = r.candidates.map((c) => JSON.parse(c.logo.generator));
  assert.notDeepEqual([a.glyph, a.layout], [b.glyph, b.layout], 'two different variants');
  assert.match(a.prompt, /front of a train/);
  assert.notEqual(r.candidates[0].logo.body.equals(r.candidates[1].logo.body), true);
  assert.deepEqual(size(r.candidates[1].banner.body), [1500, 844]);
});

test('recraft: n images in one request with the vector model; SVG output is sanitised and rasterised', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://img.recraft.test/')) return new Response(QWAVE_SVG);
    return Response.json({ created: 1, data: [{ url: 'https://img.recraft.test/a.svg' }, { url: 'https://img.recraft.test/b.svg' }] });
  };
  const imgs = await recraftImages(ART({ recraftKey: 'rk' }), { prompt: 'p', aspect: '1:1', n: 2 }, { fetchImpl });
  assert.equal(imgs.length, 2);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://external.api.recraft.ai/v1/images/generations');
  assert.equal(calls[0].init.headers.authorization, 'Bearer rk');
  assert.deepEqual([body.model, body.n, body.size, body.controls.background_color], ['recraftv4_1_vector', 2, '1:1', { rgb: [0, 0, 0] }]);
  const r = await makeCoinArt({ cfg: { art: { recraftKey: 'rk', recraftModel: 'recraftv4_1_vector', timeoutMs: 5000 } }, idea: IDEA_IN, spec: SPEC, seed: 's', fetchImpl });
  assert.deepEqual(r.provider, ['recraft', 'recraft']);
  assert.deepEqual(size(r.candidates[0].logo.body), [512, 512]);
});

test('sanitizeSvg: keeps a real Recraft SVG (metadata dropped); refuses script, foreignObject, external refs, handlers, entities', () => {
  const clean = sanitizeSvg(QWAVE_SVG);
  assert.ok(!clean.includes('<metadata') && clean.startsWith('<svg'));
  const S = (inner, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;
  for (const bad of [
    S('<script>alert(1)</script>'), S('<foreignObject><div/></foreignObject>'), S('<image href="https://x.test/a.png"/>'),
    S('<use href="https://x.test/s.svg#a"/>'), S('<use xlink:href="file:///etc/passwd#a"/>'), S('<rect fill="url(https://x.test/p)"/>'),
    S('<rect style="fill:url(http://x.test/a)"/>'), S('<rect/>', ' onload="alert(1)"'), S('<style>@import url(x)</style>'),
    `<!DOCTYPE svg [<!ENTITY x "y">]>${S('<rect/>')}`, '<html><svg/></html>', S('<a href="javascript:alert(1)"><rect/></a>'),
    S('<rect fill="url(data:image/png;base64,AA)"/>'),
  ]) assert.throws(() => sanitizeSvg(bad), ArtError, bad.slice(0, 80));
  assert.ok(sanitizeSvg(S('<defs><clipPath id="c"><rect/></clipPath></defs><g clip-path="url(#c)"><use href="#c"/></g>')));
});

test('normalizeImage: SVG and PNG to exact sizes, colour removed; empty and unknown input refused', () => {
  const logo = normalizeImage(QWAVE_SVG, 512, 512);
  assert.deepEqual(size(logo), [512, 512]);
  const banner = normalizeImage(readFileSync(join(ROOT, 'art/qwave/banner.png')), 1500, 844);
  assert.deepEqual(size(banner), [1500, 844]);
  const yellow = renderPng('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ffcc00"/></svg>');
  const px = decodeOwnPng(normalizeImage(yellow, 64, 64)).rgba;
  assert.equal(px[0], px[1], 'grey: no colour survives');
  assert.throws(() => normalizeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'), 64, 64), /empty/);
  assert.throws(() => normalizeImage(Buffer.from('GIF89a....'), 64, 64), /unknown image format/);
});

test('download: https and public host names only', async () => {
  const ok = async () => new Response('x');
  for (const u of ['http://cdn.test/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://[::1]/a.png', 'https://u:p@cdn.test/a', 'file:///etc/passwd']) {
    await assert.rejects(download(u, { fetchImpl: ok }), ArtError, u);
  }
  assert.equal((await download('https://cdn.test/a.png', { fetchImpl: ok })).toString(), 'x');
  // redirects: followed only to targets that pass the same check
  const hop = (to) => async (u) => (u.includes('/a.png') ? new Response(null, { status: 302, headers: { location: to } }) : new Response('y'));
  assert.equal((await download('https://cdn.test/a.png', { fetchImpl: hop('https://signed.cdn.test/b.png') })).toString(), 'y');
  await assert.rejects(download('https://cdn.test/a.png', { fetchImpl: hop('https://169.254.169.254/latest') }), /refused/);
  await assert.rejects(download('https://cdn.test/a.png', { fetchImpl: hop('http://cdn.test/b.png') }), /refused/);
});

test('pickSymbol: the idea\'s main noun, literally (en/it/ja romaji); abstract only when nothing matches', () => {
  const pick = (title, concept = '') => pickSymbol({ name: title, title, concept }, 'seed').id;
  assert.equal(pick('Agent Desk', 'AI agents working on coins'), 'robot');
  assert.equal(pick('Quantum Launchpad'), 'qubit', 'the concrete subject beats the generic "launchpad"');
  assert.equal(pick('Ramen Map'), 'ramen');
  assert.equal(pick('Night Train'), 'train');
  assert.equal(pick('Cat Bar'), 'cat');
  assert.equal(pick('Receipt Confessions'), 'receipt');
  assert.equal(pick('Rocket Game'), 'rocket');
  assert.equal(pick('Sushi Club'), 'sushi');
  assert.equal(pick('Gatti di Roma'), 'cat');
  assert.equal(pick('Neko Densha', ''), 'cat');
  assert.equal(pick('Q-wave', 'quantum'), 'wave');
  const abs = pickSymbol({ name: 'Zorblat', title: 'Zorblat', concept: 'florp' }, 'x');
  assert.ok(abs.abstract && PICTOGRAMS[abs.id]);
  assert.equal(initialOf('Ölmo', 'X'), 'O');
  assert.match(logoPrompt({ initial: 'q', symbol: { say: 'S' } }), /lowercase letter "q".*S.*No other letters, no words/s);
  assert.match(bannerPrompt({ initial: 'q', symbol: { say: 'S' } }), /16:9.*No other letters or words/s);
});

test('local generator: every letter and digit draws, both variants', () => {
  for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789') {
    for (const v of localVariants(ch)) assert.deepEqual(size(renderPng(localLogoSvg({ ...v, symbol: 'robot' }))), [512, 512], `${ch} ${v.layout}`);
  }
});

test('premadeArt: art/qwave/ for $QWAVE or q-wave, only for an admin (or match.json) wallet', async () => {
  const art = { dir: join(ROOT, 'art') };
  assert.equal(premadeArt(art, { ticker: 'qwave', wallet: 'W', adminWallets: ['W'] })?.dir, 'qwave');
  assert.equal(premadeArt(art, { slug: 'q-wave', wallet: 'W', adminWallets: ['W'] })?.logoFile, 'logo.svg');
  assert.equal(premadeArt(art, { ticker: 'QWAVE', wallet: 'someone', adminWallets: ['W'] }), null, 'anyone else naming a coin QWAVE gets generated art');
  assert.equal(premadeArt(art, { ticker: 'RAMEN', wallet: 'W', adminWallets: ['W'] }), null);
  const r = await makeCoinArt({ cfg: { art, adminWallets: ['W'] }, idea: { title: 'Q-wave', concept: 'quantum-proof launchpad' }, spec: { name: 'Q-wave', ticker: 'QWAVE' }, wallet: 'W', seed: 's' });
  assert.deepEqual(r.provider, ['owner-supplied', 'local']);
  assert.equal(JSON.parse(r.candidates[0].logo.generator).source, 'art/qwave');
  assert.deepEqual(size(r.candidates[0].banner.body), [1500, 844]);
});

test('pipeline: Higgsfield mocked end to end; the audit line names the provider; assets carry provider and prompt', async () => {
  const { cfg, db } = makeEnv({ HF_API_KEY_ID: 'kid', HF_API_KEY_SECRET: 'ks' });
  const brain = fakeBrain('build');
  const hf = fakeHiggsfield();
  const fetchImpl = (url, init) => (String(url).startsWith('http://brain.test') ? brain.fetchImpl(url, init) : hf.fetchImpl(url, init));
  const w = user(db);
  const { submitIdea } = await import('../src/ideas.js');
  const id = submitIdea(db, cfg, w.address, IDEA(w));
  await drain(db, cfg, fetchImpl);
  const p = db.get('SELECT * FROM projects WHERE idea_id = ?', id);
  const logos = db.all(`SELECT version, mime, generator FROM assets WHERE project_id = ? AND kind = 'logo' ORDER BY version`, p.id);
  assert.deepEqual(logos.map((l) => [l.version, l.mime, JSON.parse(l.generator).provider]), [[1, 'image/png', 'higgsfield'], [2, 'image/png', 'higgsfield']]);
  assert.match(JSON.parse(logos[0].generator).prompt, /ramen bowl/);
  const ev = db.get(`SELECT message FROM events WHERE idea_id = ? AND kind = 'generation'`, id);
  assert.match(ev.message, /two logo options \(1: Higgsfield, 2: Higgsfield\), symbol a ramen for "ramen"/);
});

test('art choice: GET lists both options; PUT copies the pick live, rebuilds the site; the city/meta serve PNG under banner.svg', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const other = h.client(user(h.db));
    await other.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    let art = await owner.call('GET', `/api/projects/${slug}/art`);
    assert.equal(art.status, 200);
    assert.equal(art.json.choice, 0);
    assert.equal(art.json.chosen, false);
    assert.equal(art.json.locked, false);
    assert.deepEqual(art.json.candidates.map((c) => [c.index, c.live, c.provider]), [[0, true, 'local'], [1, false, 'local']]);
    const img = await owner.call('GET', art.json.candidates[1].bannerUrl);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await other.call('GET', `/api/projects/${slug}/art`)).status, 404, 'owner only');
    assert.equal((await other.call('GET', art.json.candidates[1].logoUrl)).status, 404);
    assert.equal((await owner.call('PUT', `/api/projects/${slug}/art`, { choice: 2 })).status, 400);
    assert.equal((await other.call('PUT', `/api/projects/${slug}/art`, { choice: 1 })).status, 404);

    const site0 = h.db.get('SELECT live_site_version v FROM projects WHERE slug = ?', slug).v;
    const put = await owner.call('PUT', `/api/projects/${slug}/art`, { choice: 1 });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.changed, true);
    assert.deepEqual(put.json.art.candidates.map((c) => c.live), [false, true]);
    const p = h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
    assert.equal(p.art_choice, 1);
    const cand = h.db.get('SELECT l.sha256 s FROM art_candidates c JOIN assets l ON l.id = c.logo_asset_id WHERE c.project_id = ? AND c.idx = 1', p.id).s;
    assert.equal(h.db.get(`SELECT sha256 FROM assets WHERE project_id = ? AND kind = 'logo' ORDER BY version DESC LIMIT 1`, p.id).sha256, cand);
    assert.equal(JSON.parse(h.db.get(`SELECT generator FROM assets WHERE project_id = ? AND kind = 'logo' AND version = 3`, p.id).generator).chosen, 1);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(h.db.get('SELECT live_site_version v FROM projects WHERE slug = ?', slug).v, site0 + 1, 'the site was rebuilt');
    assert.equal((await owner.call('PUT', `/api/projects/${slug}/art`, { choice: 1 })).json.changed, false, 'the same pick twice is a no-op');

    // public: /meta serves the stored type (PNG) under the kept .svg path; the site page carries the B/W hero
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const meta = await owner.call('GET', `/meta/${slug}/banner-v3.svg`);
    assert.equal(meta.headers.get('content-type'), 'image/png');
    assert.equal(meta.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(siteContext(h.db, h.cfg, p, { preview: true }).art, 'bw');
    assert.match(h.db.get('SELECT html FROM site_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1', p.id).html, /<body class="art-bw">/);
  } finally { h.close(); }
});

test('art choice: an old coin (SVG banner, no options) keeps its art and its SVG type', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const p = h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
    // as before 2026-10-12: no candidates, an SVG banner as the newest version
    h.db.run('DELETE FROM art_candidates WHERE project_id = ?', p.id);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 500"><rect width="1500" height="500"/></svg>');
    h.db.run(`INSERT INTO assets (id, project_id, kind, version, mime, body, sha256, generator, created_at) VALUES ('asset_old', ?, 'banner', 9, 'image/svg+xml', ?, 'x', 'art/1 (from the brain record)', 0)`, p.id, svg);
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const art = await owner.call('GET', `/api/projects/${slug}/art`);
    assert.deepEqual([art.json.choice, art.json.candidates], [null, []]);
    assert.equal((await owner.call('PUT', `/api/projects/${slug}/art`, { choice: 1 })).status, 404);
    const meta = await owner.call('GET', `/meta/${slug}/banner-v9.svg`);
    assert.equal(meta.headers.get('content-type'), 'image/svg+xml');
    assert.match(meta.headers.get('content-security-policy'), /sandbox$/);
    assert.equal(siteContext(h.db, h.cfg, p, { preview: true }).art, 'classic');
  } finally { h.close(); }
});

test('art choice: launch_prepared -> the configuration is rebuilt with the new logo; refused once a transaction exists', async () => {
  const h = await harness({ REQUIRE_ADMIN_CLEARANCE: '0' });
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    let proj = await owner.call('GET', `/api/projects/${slug}`);
    const ap = await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.json.allocation.id, statement: proj.json.allocation.statement, siteVersion: proj.json.liveSiteVersion });
    assert.equal(ap.status, 200, ap.text);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    proj = await owner.call('GET', `/api/projects/${slug}`);
    assert.equal(proj.json.status ?? h.db.get('SELECT status FROM ideas WHERE id = ?', sub.json.id).status, 'launch_prepared');
    const before = JSON.parse(h.db.get('SELECT launch_config_json c FROM projects WHERE slug = ?', slug).c).token.metadata.image;
    assert.match(before, /logo-v2\.png$/);
    const put = await owner.call('PUT', `/api/projects/${slug}/art`, { choice: 1 });
    assert.equal(put.json.reprepared, true);
    assert.equal(h.db.get('SELECT status FROM ideas WHERE id = ?', sub.json.id).status, 'approved');
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(h.db.get('SELECT status FROM ideas WHERE id = ?', sub.json.id).status, 'launch_prepared');
    const after = JSON.parse(h.db.get('SELECT launch_config_json c FROM projects WHERE slug = ?', slug).c).token.metadata.image;
    assert.match(after, /logo-v3\.png$/, 'the token metadata names the chosen logo');
    const tx = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(tx.status, 200, tx.text);
    const locked = await owner.call('PUT', `/api/projects/${slug}/art`, { choice: 0 });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error ?? locked.json.code, 'intent_exists');
    assert.equal((await owner.call('GET', `/api/projects/${slug}/art`)).json.locked, true);
  } finally { h.close(); }
});

test('config: HF_API_KEY="id:secret" works like the two variables; the pair wins when both are set', () => {
  const art = (env) => loadConfig({ LAUNCHPAD_NO_DOTENV: '1', ...env }).art;
  assert.deepEqual([art({ HF_API_KEY: 'kid:ks:ec' }).hfKeyId, art({ HF_API_KEY: 'kid:ks:ec' }).hfKeySecret], ['kid', 'ks:ec']);
  assert.deepEqual([art({ HF_API_KEY: 'x:y', HF_API_KEY_ID: 'a', HF_API_KEY_SECRET: 'b' }).hfKeyId, art({ HF_API_KEY: 'x:y', HF_API_KEY_ID: 'a', HF_API_KEY_SECRET: 'b' }).hfKeySecret], ['a', 'b']);
  assert.deepEqual([art({ HF_API_KEY: 'nocolon' }).hfKeyId, art({}).hfKeySecret], ['', '']);
});
