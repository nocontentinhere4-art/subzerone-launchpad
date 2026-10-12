// SUB-01's QA gate (src/site-qa.js, docs/SITE-QA.md) and the redesign's page contract (docs/DESIGN.md): the static
// checks, the hold / first-version / override / recheck rules, the QA ticket on the project host (read-only, one
// version), the room PC's QA routes and screenshots, the boot refresh of coins still on the v1 stylesheet. The browser
// half runs where a Chromium exists; here SITE_QA_BROWSER is off, as on any machine without one, and the report says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { harness, user, drain, IDEA, wallet } from './helpers.js';
import { staticQa, publishSite, qaTicket, refreshSiteDesign, qaLine, _test } from '../src/site-qa.js';
import { validateHtml, sandboxBuild, buildSiteVersion } from '../src/site.js';
import { id, now, sha256, parseJson } from '../src/util.js';

const KONBINI = 'Konbini Confession: every night people drop an anonymous confession at the konbini; at 23:00 JST one gets printed on the receipt.';
const TP = { TRUST_PROXY: '1' };

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

async function konbini(h, { publish = true } = {}) {
  const owner = h.client(user(h.db));
  await owner.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: 'Konbini Confession', nameSuggestion: 'Konbini Confession', tickerSuggestion: 'KONBINI', concept: KONBINI }));
  assert.equal(sub.status, 200, sub.text);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  if (publish) assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true })).status, 200);
  const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
  const host = `${slug}.${h.cfg.projectsHost}`;
  const site = (method, path, body, headers = {}) => hostCall(h.base, host, method, path, body, { 'x-forwarded-for': '10.0.0.9', ...(method === 'POST' ? { origin: `http://${host}` } : {}), ...headers });
  const project = () => h.db.get('SELECT * FROM projects WHERE slug = ?', slug);
  return { owner, slug, host, site, project, ideaId: sub.json.id };
}

/** A built version whose page breaks a static rule (no alt on an image), as a broken template would make. */
function brokenVersion(h, p) {
  const live = h.db.get('SELECT * FROM site_versions WHERE project_id = ? AND version = ?', p.id, p.live_site_version);
  const v = h.db.get('SELECT MAX(version) v FROM site_versions WHERE project_id = ?', p.id).v + 1;
  const html = live.html.replace(/(<img class="hero-(?:art|mark)" src="[^"]+") alt=""/, '$1');
  assert.notEqual(html, live.html);
  h.db.run(`INSERT INTO site_versions (id, project_id, version, spec_json, build_status, html, sha256, build_report, created_by, created_at) VALUES (?, ?, ?, ?, 'ok', ?, ?, 'passed', 'test', ?)`,
    id('site'), p.id, v, live.spec_json, html, sha256(html), now());
  return v;
}

test('the page: one h1, the app first, a CTA from the app, in-page links only to sections that exist, no inline style', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const page = await k.site('GET', '/');
    assert.equal(page.status, 200);
    const st = staticQa(page.text, parseJson(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', k.project().id, k.project().live_site_version).spec_json));
    assert.deepEqual(st.issues, [], JSON.stringify(st.issues));
    assert.match(page.text, /<link rel="stylesheet" href="\/_kit\/site-kit\.v2\.css">/);
    assert.match(page.text, /<h1 class="hero-name len-l reveal-hero">Konbini Confession<\/h1>/, 'the name size follows its longest word');
    assert.match(page.text, /<a class="btn btn-primary btn-lg" href="#app">Drop your confession<\/a>/, 'the hero action is the app\'s form');
    assert.match(page.text, /<nav class="dock" aria-label="Quick actions"><a class="btn btn-primary" href="#app">/, 'the phone action bar');
    assert.ok(page.text.indexOf('id="app"') < page.text.indexOf('id="chain"') && page.text.indexOf('id="chain"') < page.text.indexOf('id="about"'), 'app, then the chain, then about');
    assert.ok(!/\sstyle=/.test(page.text) && !/<style/.test(page.text), 'no inline styles at all');
    assert.ok(!/class="figures"/.test(page.text), 'no market strip before a launch');
    assert.match(page.text, /<body class="art-(bw|classic) has-dock">/, 'new coins get the B/W art (coinart.js)');
    // a launchpad app's action is "Launch a coin"; the B/W art fills the hero
    const spec = parseJson(h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', k.project().id, k.project().live_site_version).spec_json);
    const html = await sandboxBuild({ spec: { ...spec, app: { ...spec.app, screens: [{ id: 'l', title: 'Launch', blocks: [{ type: 'launch', prompt: 'x', split: { creator: 7000, parent: 1000, sub01: 2000 } }] }] } },
      context: { preview: false, launched: false, submitter: 'w', generatorLabel: 'g', links: [], launchpad: { href: 'https://city.subzerone.live/', host: 'city.subzerone.live' }, token: { state: 'pre-launch', links: [] }, art: 'bw' } });
    assert.match(html, /href="#app">Launch a coin<\/a>/);
    assert.match(html, /<body class="art-bw has-dock">[\s\S]*<img class="hero-art" src=".\/banner.svg" alt=""/);
  } finally { h.close(); }
});

test('validator: in-page #section links are allowed, nothing that only looks like one', () => {
  const page = (href) => `<!doctype html><html lang="en"><head><title>x</title></head><body><a href="${href}">x</a></body></html>`;
  for (const ok of ['#app', '#chain', '#tool-token', '#about']) assert.equal(validateHtml(page(ok), []).ok, true, ok);
  for (const bad of ['#', '#1app', '#javascript:alert(1)', '#a b', '#app" onclick="alert(1)', 'javascript:#app', '/#app', `#${'a'.repeat(60)}`]) assert.equal(validateHtml(page(bad), []).ok, false, bad);
});

test('static QA names what is wrong: two h1, an image without alt, a duplicate id, a link to a missing section', () => {
  const bad = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Bad page</title></head><body>'
    + '<h1>A</h1><h1 id="x">B</h1><div id="x"></div><img src="./logo.png"><a href="#nowhere">go</a><h2>s</h2><h4>t</h4></body></html>';
  const r = staticQa(bad, {});
  assert.deepEqual(r.issues.map((x) => x.check).sort(), ['anchors', 'img-alt', 'one-h1', 'unique-ids']);
  assert.deepEqual(r.warnings.map((x) => x.check), ['heading-order']);
  assert.equal(staticQa(bad.replace('<html lang="en">', '<html>'), {}).issues.some((x) => x.check === 'lang'), true);
});

test('gate: a version that fails keeps the previous one live, the owner sees why and can publish it anyway', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const p = k.project();
    const first = h.db.get('SELECT * FROM site_qa WHERE project_id = ? ORDER BY created_at LIMIT 1', p.id);
    assert.equal(first.status, 'passed', 'the generated site passed');
    assert.equal(first.browser, 'skipped');
    assert.match(qaLine(first), /^passed \(static checks only: browser QA off \(SITE_QA_BROWSER\)\)$/);
    const v = brokenVersion(h, p);
    const pub = await publishSite(h.db, h.cfg, p, v, 'test');
    assert.equal(pub.live, false);
    assert.equal(pub.qa.status, 'failed');
    assert.equal(pub.qa.held, true);
    assert.deepEqual(pub.qa.issues.map((x) => x.check), ['img-alt']);
    assert.equal(k.project().live_site_version, p.live_site_version, 'the previous version stays live');
    assert.ok(h.db.get(`SELECT 1 FROM events WHERE project_id = ? AND message LIKE ?`, p.id, `Website version ${v} held back by SUB-01's QA (1 issue%`));
    // the room PC: owner only
    const view = await k.owner.call('GET', `/api/projects/${k.slug}/site/qa`);
    assert.equal(view.status, 200);
    assert.equal(view.json.reports[0].version, v);
    assert.equal(view.json.reports[0].line, '1 issue (static checks only: browser QA off (SITE_QA_BROWSER))');
    const stranger = h.client(user(h.db)); await stranger.signIn();
    assert.equal((await stranger.call('GET', `/api/projects/${k.slug}/site/qa`)).status, 404);
    assert.equal((await stranger.call('POST', `/api/projects/${k.slug}/site/qa/${v}/override`, {})).status, 404);
    // override: live, marked, audited
    assert.equal((await k.owner.call('POST', `/api/projects/${k.slug}/site/qa/${p.live_site_version}/override`, {})).status, 409, 'a passed version needs no override');
    const o = await k.owner.call('POST', `/api/projects/${k.slug}/site/qa/${v}/override`, {});
    assert.equal(o.status, 200, o.text);
    assert.equal(o.json.qa.status, 'overridden');
    assert.equal(k.project().live_site_version, v);
    assert.ok(h.db.get(`SELECT 1 FROM events WHERE project_id = ? AND message LIKE 'The author published website version % despite SUB-01''s QA%'`, p.id));
    // a recheck of the live version reports and leaves it live
    const before = h.db.get(`SELECT COUNT(*) n FROM events WHERE project_id = ? AND message LIKE 'Website now serves%'`, p.id).n;
    const re = await k.owner.call('POST', `/api/projects/${k.slug}/site/qa/recheck`, {});
    assert.equal(re.status, 200);
    assert.equal(re.json.qa.status, 'failed');
    assert.equal(re.json.live, true);
    assert.equal(k.project().live_site_version, v);
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM events WHERE project_id = ? AND message LIKE 'Website now serves%'`, p.id).n, before, 'no new live switch');
  } finally { h.close(); }
});

test('gate: the first version goes live even when it fails (nothing earlier to keep); SITE_QA_GATE=0 publishes with issues', async () => {
  const h = await harness({ ...TP, SITE_QA_GATE: '0' });
  try {
    const k = await konbini(h);
    const p = k.project();
    const v = brokenVersion(h, p);
    const pub = await publishSite(h.db, h.cfg, p, v, 'test');
    assert.equal(pub.live, true);
    assert.equal(pub.qa.status, 'failed');
    assert.equal(k.project().live_site_version, v);
  } finally { h.close(); }
  const h2 = await harness(TP);
  try {
    const k = await konbini(h2);
    const p = k.project();
    h2.db.run('UPDATE projects SET live_site_version = NULL WHERE id = ?', p.id);
    const v = brokenVersion(h2, { ...p });
    const pub = await publishSite(h2.db, h2.cfg, { ...p, live_site_version: null }, v, 'test');
    assert.equal(pub.live, true, 'a first version is never held');
  } finally { h2.close(); }
});

test('QA ticket: the project host serves the candidate version to the QA browser only, read-only, not cached', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h, { publish: false });                    // private idea: no public site at all
    const p = k.project();
    assert.equal((await k.site('GET', '/')).status, 404);
    const v = brokenVersion(h, p);
    const ticket = 'tkt-' + wallet().address;
    h.db.run(`INSERT INTO site_qa (id, project_id, version, status, browser, ticket_hash, ticket_until, created_at) VALUES (?, ?, ?, 'running', 'pending', ?, ?, ?)`,
      id('qa'), p.id, v, sha256(ticket), now() + 60_000, now());
    assert.deepEqual(qaTicket(h.db, p, ticket), { version: v });
    assert.equal(qaTicket(h.db, p, 'nope'), null);
    const page = await k.site('GET', '/', undefined, { 'x-sub01-qa': ticket });
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.text, /<img class="hero-(art|mark)" src="[^"]+" width=/, 'the candidate, not the live version');
    assert.equal((await k.site('GET', '/_api/token', undefined, { 'x-sub01-qa': ticket })).status, 200, 'its tools answer');
    assert.equal((await k.site('POST', '/_api/app/submit', { fields: { text: 'x' } }, { 'x-sub01-qa': ticket })).status, 403, 'nothing is written through a ticket');
    assert.equal((await k.site('GET', '/', undefined, { 'x-sub01-qa': 'wrong' })).status, 404);
    h.db.run(`UPDATE site_qa SET ticket_until = ? WHERE project_id = ?`, now() - 1, p.id);
    assert.equal((await k.site('GET', '/', undefined, { 'x-sub01-qa': ticket })).status, 404, 'an expired ticket is nothing');
    // a finished QA clears its ticket
    const pub = await publishSite(h.db, h.cfg, p, p.live_site_version, 'test');
    assert.equal(h.db.get('SELECT ticket_hash FROM site_qa WHERE id = ?', pub.qa.id).ticket_hash, null);
  } finally { h.close(); }
});

test('QA screenshots: the owner gets the files the report lists, nothing else', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const p = k.project();
    const pub = await publishSite(h.db, h.cfg, p, p.live_site_version, 'test');
    const name = `v${p.live_site_version}-mobile-fold.jpg`;
    h.db.run('UPDATE site_qa SET shots_json = ? WHERE id = ?', JSON.stringify([{ file: name, viewport: 'mobile', kind: 'fold', width: 390 }]), pub.qa.id);
    _test.writeShot(h.cfg, p, name, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const ok = await k.owner.call('GET', `/api/projects/${k.slug}/site/qa/${p.live_site_version}/${name}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    for (const bad of [`v${p.live_site_version}-desktop-fold.jpg`, '..%2F..%2Ftest.db', 'v1-mobile-fold.png']) {
      assert.equal((await k.owner.call('GET', `/api/projects/${k.slug}/site/qa/${p.live_site_version}/${bad}`)).status, 404, bad);
    }
    const stranger = h.client(user(h.db)); await stranger.signIn();
    assert.equal((await stranger.call('GET', `/api/projects/${k.slug}/site/qa/${p.live_site_version}/${name}`)).status, 404);
  } finally { h.close(); }
});

test('the redesign reaches the coins built before it: rebuilt once from the same spec, checked, live, browser QA queued', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const p = k.project();
    // as built before 2026-10-12: the page links the v1 stylesheet
    h.db.run(`UPDATE site_versions SET html = replace(html, '/_kit/site-kit.v2.css', '/_kit/site-kit.v1.css') WHERE project_id = ? AND version = ?`, p.id, p.live_site_version);
    const out = await refreshSiteDesign(h.db, h.cfg);
    assert.equal(out.rebuilt.length, 1, JSON.stringify(out));
    const now2 = k.project();
    assert.equal(now2.live_site_version, p.live_site_version + 1);
    const row = h.db.get('SELECT * FROM site_versions WHERE project_id = ? AND version = ?', p.id, now2.live_site_version);
    assert.equal(row.spec_json, h.db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p.id, p.live_site_version).spec_json, 'same content');
    assert.ok(row.html.includes('/_kit/site-kit.v2.css'));
    assert.ok(h.db.get(`SELECT 1 FROM jobs WHERE type = 'site_qa' AND project_id = ?`, p.id), 'the worker re-checks it in a browser');
    assert.equal((await refreshSiteDesign(h.db, h.cfg)).rebuilt.length, 0, 'once');
    const ran = await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.deepEqual(ran.filter((x) => x.type === 'site_qa').map((x) => x.status), ['succeeded']);
  } finally { h.close(); }
});

test('the owner edit endpoints answer with the QA verdict', async () => {
  const h = await harness(TP);
  try {
    const k = await konbini(h);
    const r = await k.owner.call('PUT', `/api/projects/${k.slug}/tools`, { tools: [{ id: 'token' }, { id: 'wall' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.live, true);
    assert.equal(r.json.qa.status, 'passed');
    assert.equal(k.project().live_site_version, r.json.version);
    const s = await k.owner.call('PUT', `/api/projects/${k.slug}/site`, { tagline: 'Confess at the konbini.' });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.qa.status, 'passed');
  } finally { h.close(); }
});
