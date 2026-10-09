// The desk computer in a room (GET /api/rooms/:plotId -> desk): the owner's projects as tabs (framed site, X, launch
// page), owner vs visitor views, and the framing headers that let the city iframe project sites and previews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { harness, user, drain, IDEA } from './helpers.js';

const LOOK = { skin: '#c98e66', hair: '#1b1b1b', hairStyle: 'bun', top: '#ff6600', bottom: '#222222', outfit: 'hoodie' };
const KEYS = ['slug', 'name', 'ticker', 'stage', 'stageLabel', 'progress', 'launched', 'mint', 'explorerTx', 'siteUrl', 'previewLink',
  'logoUrl', 'bannerUrl', 'x', 'pagePath', 'officePath', 'kind'];

function getWithHost(base, host, path) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('desk: owner sees all projects with preview, office, X drafts and ideas; visitors only public projects', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    await owner.call('POST', '/api/residents', { name: 'Kenji', look: LOOK, plotId: 'shiba-1' });
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w, { plotId: 'ginza-3' }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const later = await owner.call('POST', '/api/ideas', IDEA(owner.w, { title: 'Soba Signal' }));   // not built yet
    const visitor = h.client(user(h.db));
    await visitor.signIn();

    // private project: invisible to visitors, fully there for the owner
    let v = await visitor.call('GET', '/api/rooms/shiba-1');
    assert.deepEqual(v.json.desk, { viewer: 'visitor', projects: [], ideas: null });
    let o = await owner.call('GET', '/api/rooms/shiba-1');
    assert.equal(o.status, 200, o.text);
    assert.equal(o.json.desk.viewer, 'owner');
    assert.equal(o.json.desk.projects.length, 1);
    let d = o.json.desk.projects[0];
    assert.deepEqual(Object.keys(d), KEYS);
    assert.equal(d.slug, slug);
    assert.equal(d.stage, 'preview_ready');
    assert.equal(d.progress, 0.65);
    assert.equal(d.kind, 'apartment-owner-project', 'shown in the owner\'s apartment');
    assert.equal(d.siteUrl, null, 'private: no public site');
    assert.match(d.previewLink, new RegExp(`^/preview/${slug}/[^/]+/index\\.html$`));
    assert.equal(d.logoUrl, d.previewLink.replace('index.html', 'logo.png'), 'private art comes through the preview capability');
    assert.equal(d.bannerUrl, d.previewLink.replace('index.html', 'banner.svg'));
    assert.equal(d.officePath, `/projects/${slug}/review`);
    assert.equal(d.pagePath, `/projects/${slug}`);
    assert.equal(d.launched, false);
    assert.equal(d.mint, null);
    assert.equal(d.x.status, 'planned');
    assert.ok(d.x.handle);
    assert.equal(d.x.url, null);
    assert.ok(d.x.posts.length >= 1 && d.x.posts.length <= 3);
    assert.deepEqual(Object.keys(d.x.posts[0]), ['id', 'text', 'status']);
    assert.equal(d.x.posts[0].status, 'draft');
    assert.deepEqual(o.json.desk.ideas, [{ id: later.json.id, title: 'Soba Signal', status: 'submitted', stageLabel: o.json.desk.ideas[0].stageLabel }]);
    assert.ok(o.json.desk.ideas[0].stageLabel);
    const prev = await owner.call('GET', d.previewLink);
    assert.equal(prev.status, 200);
    assert.match(prev.headers.get('content-security-policy'), /frame-ancestors 'self' http:\/\/localhost:8787; sandbox$/);
    assert.equal((await owner.call('GET', d.logoUrl)).status, 200);
    assert.equal((await owner.call('GET', d.bannerUrl)).headers.get('content-type'), 'image/svg+xml');
    for (const r of [o, v]) assert.ok(!r.text.includes(owner.w.address), 'never a wallet');

    // public: the visitor sees it, without anything owner-only
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    v = await visitor.call('GET', '/api/rooms/shiba-1');
    assert.equal(v.json.desk.projects.length, 1);
    d = v.json.desk.projects[0];
    assert.deepEqual(Object.keys(d), KEYS);
    assert.equal(d.siteUrl, `http://${slug}.projects.localhost:8787/`);
    assert.equal(d.previewLink, null);
    assert.equal(d.officePath, null);
    assert.equal(d.x.posts, null);
    assert.equal(v.json.desk.ideas, null);
    assert.equal(d.logoUrl, `/meta/${slug}/logo-v1.png`);
    assert.equal(d.bannerUrl, `/meta/${slug}/banner-v1.svg`);
    const banner = await visitor.call('GET', d.bannerUrl);
    assert.equal(banner.status, 200);
    assert.equal(banner.headers.get('content-type'), 'image/svg+xml');
    assert.match(banner.headers.get('content-security-policy'), /^default-src 'none'.*sandbox$/, 'the SVG is inert even when opened directly');
    assert.equal((await visitor.call('GET', d.logoUrl)).headers.get('content-type'), 'image/png');
    assert.ok(!v.text.includes(owner.w.address));
    // on the project's own plot it is the plot's project
    const plot = await visitor.call('GET', '/api/rooms/ginza-3');
    assert.equal(plot.json.desk.projects[0].kind, 'project');

    // siteUrl only with a live site version
    h.db.run('UPDATE projects SET live_site_version = NULL WHERE slug = ?', slug);
    assert.equal((await visitor.call('GET', '/api/rooms/shiba-1')).json.desk.projects[0].siteUrl, null);
    assert.equal((await owner.call('GET', '/api/rooms/shiba-1')).json.desk.projects[0].previewLink, null);
    h.db.run('UPDATE projects SET live_site_version = 1 WHERE slug = ?', slug);

    // made private again (allowed before launch): gone from the visitor's desk
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: false });
    assert.deepEqual((await visitor.call('GET', '/api/rooms/shiba-1')).json.desk.projects, []);
    assert.equal((await owner.call('GET', '/api/rooms/shiba-1')).json.desk.projects.length, 1);
    assert.equal((await visitor.call('GET', '/api/rooms/ginza-3')).status, 404);
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });

    // a connected X account (handle as X reported it) and a launch
    const pid = h.db.get('SELECT id FROM projects WHERE slug = ?', slug).id;
    h.db.run(`UPDATE x_accounts SET status = 'connected', x_handle = 'ramen_real' WHERE project_id = ?`, pid);
    h.db.run(`UPDATE ideas SET status = 'launched' WHERE id = ?`, sub.json.id);
    const alloc = h.db.get('SELECT id FROM fee_allocations WHERE project_id = ?', pid).id;
    h.db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, created_at, updated_at)
      VALUES ('in_d', ?, 'mock', 'mock', '{}', 'h', ?, 'MintDesk', ?, 'confirmed', 1, 1)`, pid, alloc, owner.w.address);
    h.db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, 'in_d', 'mock', 'mock', 'MintDesk', 'sig', '[]', 1)`, pid);
    d = (await visitor.call('GET', '/api/rooms/shiba-1')).json.desk.projects[0];
    assert.deepEqual(d.x, { handle: 'ramen_real', status: 'connected', url: 'https://x.com/ramen_real', posts: null });
    assert.equal(d.launched, true);
    assert.equal(d.mint, 'MintDesk');
    assert.equal(d.explorerTx, null, 'the mock provider has no explorer');
    assert.equal(d.progress, 1);

  } finally { h.close(); }
});

test('framing: the app CSP frames project sites, the city can frame app pages, project sites allow the app as ancestor', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;

    const csp = (await owner.call('GET', `/projects/${slug}`)).headers.get('content-security-policy');
    const frameSrc = csp.split('; ').find((x) => x.startsWith('frame-src'));
    assert.equal(frameSrc, `frame-src 'self' ${new URL(h.cfg.brain.publicRoomUrl).origin} http://*.projects.localhost:8787`);
    assert.match(csp, /frame-ancestors 'self'(;|$)/, 'same-origin framing allowed (the city), other sites not');
    const site = await getWithHost(h.base, `${slug}.${h.cfg.projectsHost}`, '/');
    assert.equal(site.status, 200);
    assert.match(site.headers['content-security-policy'], /frame-ancestors 'self' http:\/\/localhost:8787;/);
    assert.match(site.headers['content-security-policy'], /; sandbox allow-popups allow-popups-to-escape-sandbox$/);
    assert.match(site.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(site.headers['x-frame-options'], undefined);

    const prod = await harness({ PUBLIC_ORIGIN: 'https://launchpad.subzerone.live', PROJECTS_HOST: 'projects.subzerone.live', PROJECTS_SCHEME: 'https' });
    try {
      const c = (await prod.client(user(prod.db)).call('GET', '/launchpad')).headers.get('content-security-policy');
      assert.match(c, /frame-src [^;]* https:\/\/\*\.projects\.subzerone\.live(;|$)/);
    } finally { prod.close(); }
  } finally { h.close(); }
});
