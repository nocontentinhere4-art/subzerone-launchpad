// The city: plots (first come first served), residents, rooms, /api/world privacy, roles and community takeovers,
// and single-origin hosting of the city client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { harness, makeEnv, user, drain, IDEA, ideaStatus, SUB01_WALLET } from './helpers.js';
import { worldView, PLOT_IDS, DEFAULT_ROOM, claimPlot } from '../src/world.js';
import { INACTIVE_MS } from '../src/roles.js';

const LOOK = { skin: '#c98e66', hair: '#1b1b1b', hairStyle: 'bun', top: '#FF6600', bottom: '#222222', outfit: 'hoodie' };

async function signedIn(h, role = 'user') {
  const c = h.client(user(h.db, role));
  await c.signIn();
  return c;
}

/** A launched project inserted directly (the launch flow itself is covered in flow.test.js). */
function launchedProject(db, founder, slug = 'ramen') {
  const t = Date.now();
  const recipients = [{ label: 'Idea submitter', wallet: founder, bps: 8000, role: 'submitter' }, { label: 'SUB-01', wallet: SUB01_WALLET, bps: 2000, role: 'sub01' }];
  db.run(`INSERT INTO ideas (id, owner_wallet, status, visibility, created_at, updated_at) VALUES (?, ?, 'launched', 'public', ?, ?)`, `idea_${slug}`, founder, t, t);
  db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES (?, ?, ?, 'Ramen', 'RAMEN', 'd', ?, ?)`, `prj_${slug}`, `idea_${slug}`, slug, t, t);
  db.run(`INSERT INTO project_roles (project_id, wallet, role, granted_by, granted_at) VALUES (?, ?, 'founder', 'system', ?)`, `prj_${slug}`, founder, t);
  db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, created_at) VALUES (?, ?, 1, ?, 10000, 'locked', ?)`, `al_${slug}`, `prj_${slug}`, JSON.stringify(recipients), t);
  const config = { feeSharing: { mode: 'sharing_config', shareholders: recipients.map(({ wallet, bps }) => ({ wallet, bps })), recipients, locked: true } };
  db.run(`INSERT INTO launch_intents (id, project_id, provider, network, config_json, config_hash, allocation_id, mint, signer_wallet, status, created_at, updated_at)
          VALUES (?, ?, 'mock', 'mock', ?, 'h', ?, 'MintRamen', ?, 'confirmed', ?, ?)`, `in_${slug}`, `prj_${slug}`, JSON.stringify(config), `al_${slug}`, founder, t, t);
  db.run(`INSERT INTO launches (project_id, intent_id, provider, network, mint, tx_signature, verification, verified_at) VALUES (?, ?, 'mock', 'mock', 'MintRamen', 'sig', '[]', ?)`, `prj_${slug}`, `in_${slug}`, t);
  return { id: `prj_${slug}`, slug, recipients };
}

test('world options: 24 districts × 6 = 144 plot ids, look and room whitelists', async () => {
  const h = await harness();
  try {
    const o = await h.client(user(h.db)).call('GET', '/api/world/options');
    assert.equal(o.status, 200);
    assert.equal(o.json.plotIds.length, 144);
    assert.equal(new Set(o.json.plotIds).size, 144);
    assert.ok(o.json.plotIds.includes('shimokitazawa-6') && o.json.plotIds.includes('shiba-1'));
    assert.equal(o.json.look.skin.length, 6);
    assert.equal(o.json.look.hair.length, 8);
    assert.deepEqual(o.json.look.hairStyle, ['short', 'long', 'bun', 'buzz', 'curly']);
    assert.deepEqual(o.json.room.lighting, ['morning', 'midday', 'evening', 'night']);
    assert.deepEqual(o.json.room.default, DEFAULT_ROOM);
    assert.equal(PLOT_IDS.length, 144);
  } finally { h.close(); }
});

test('residents: create, validation, one apartment per wallet, moving releases the old plot, /api/me shows it', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    assert.equal((await a.call('POST', '/api/residents', { name: 'Kenji', look: LOOK, plotId: 'shiba-1' }, { cookie: '' })).status, 401);
    assert.equal((await a.call('POST', '/api/residents', { name: 'K', look: LOOK, plotId: 'shiba-1' })).json.error, 'bad_name');
    assert.equal((await a.call('POST', '/api/residents', { name: 'Kenji', look: { ...LOOK, skin: '#000000' }, plotId: 'shiba-1' })).json.error, 'bad_look');
    assert.equal((await a.call('POST', '/api/residents', { name: 'Kenji', look: { ...LOOK, hat: 'yes' }, plotId: 'shiba-1' })).json.error, 'bad_look');
    assert.equal((await a.call('POST', '/api/residents', { name: 'Kenji', look: { ...LOOK, top: 'red' }, plotId: 'shiba-1' })).json.error, 'bad_look');
    assert.equal((await a.call('POST', '/api/residents', { name: 'Kenji', look: LOOK, plotId: 'osaka-1' })).json.error, 'bad_plot');
    assert.equal((await a.call('POST', '/api/residents', { name: 'Kenji', look: LOOK, plotId: 'shiba-7' })).json.error, 'bad_plot');
    assert.equal((await a.call('POST', '/api/residents', { name: 'Kenji', look: LOOK })).json.error, 'bad_plot', 'a new resident needs an apartment');
    const ok = await a.call('POST', '/api/residents', { name: 'Kenji', look: LOOK, plotId: 'shiba-1' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.resident.look.top, '#ff6600', 'colours normalised');
    assert.deepEqual(ok.json.plots.map((p) => [p.plotId, p.kind]), [['shiba-1', 'apartment']]);
    const rename = await a.call('POST', '/api/residents', { name: 'Kenji S', look: LOOK });
    assert.equal(rename.json.resident.plotId, 'shiba-1', 'no plotId keeps the apartment');
    const move = await a.call('POST', '/api/residents', { name: 'Kenji S', look: LOOK, plotId: 'ginza-2' });
    assert.equal(move.json.resident.plotId, 'ginza-2');
    assert.deepEqual(h.db.all(`SELECT plot_id FROM plots WHERE wallet = ?`, a.w.address).map((p) => p.plot_id), ['ginza-2'], 'old apartment released');
    const b = await signedIn(h);
    assert.equal((await b.call('POST', '/api/residents', { name: 'Yui', look: LOOK, plotId: 'shiba-1' })).status, 200, 'the released plot is free again');
    assert.equal((await b.call('POST', '/api/residents', { name: 'Yui', look: LOOK, plotId: 'ginza-2' })).json.error, 'plot_taken');
    const me = await a.call('GET', '/api/me');
    assert.equal(me.json.resident.name, 'Kenji S');
    assert.deepEqual(me.json.resident.room, DEFAULT_ROOM);
    assert.deepEqual(me.json.plots.map((p) => p.plotId), ['ginza-2']);
    assert.deepEqual(me.json.projectRoles, []);
  } finally { h.close(); }
});

test('plots race: concurrent claims of one plot, exactly one wins (apartments and ideas alike)', async () => {
  const h = await harness();
  try {
    const cs = await Promise.all([1, 2, 3, 4, 5].map(() => signedIn(h)));
    const res = await Promise.all(cs.map((c, i) => (i % 2
      ? c.call('POST', '/api/residents', { name: `Racer ${i}`, look: LOOK, plotId: 'shibuya-3' })
      : c.call('POST', '/api/ideas', IDEA(c.w, { title: `Race idea ${i}`, plotId: 'shibuya-3' })))));
    assert.equal(res.filter((r) => r.status === 200).length, 1, res.map((r) => r.status).join(','));
    assert.ok(res.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.json.error === 'plot_taken'));
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM plots WHERE plot_id = 'shibuya-3'`).n, 1);
    // a losing idea submission leaves nothing behind (same transaction)
    assert.equal(h.db.get('SELECT COUNT(*) n FROM ideas').n + h.db.get('SELECT COUNT(*) n FROM residents').n, 1);
    // and the database guard holds even without the pre-check
    const { db } = makeEnv();
    const w = user(db).address;
    db.tx(() => claimPlot(db, { plotId: 'ueno-1', kind: 'apartment', wallet: w }));
    assert.throws(() => db.run(`INSERT INTO plots (plot_id, kind, wallet, claimed_at) VALUES ('ueno-1', 'apartment', ?, 1)`, w), /UNIQUE|PRIMARY/);
  } finally { h.close(); }
});

test('idea plots: reserved with the idea, released when declined or cancelled, bad plot refuses the idea', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    const bad = await a.call('POST', '/api/ideas', IDEA(a.w, { plotId: 'nowhere-1' }));
    assert.equal(bad.json.error, 'bad_plot');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM ideas').n, 0);
    const one = await a.call('POST', '/api/ideas', IDEA(a.w, { plotId: 'akihabara-2' }));
    assert.equal(one.status, 200, one.text);
    assert.equal(h.db.get(`SELECT idea_id FROM plots WHERE plot_id = 'akihabara-2'`).idea_id, one.json.id);
    assert.equal((await a.call('POST', `/api/ideas/${one.json.id}/cancel`, {})).status, 200);
    assert.equal(h.db.get(`SELECT 1 x FROM plots WHERE plot_id = 'akihabara-2'`), undefined, 'cancelled -> released');
    h.brain.state.mode = 'pass';
    const two = await a.call('POST', '/api/ideas', IDEA(a.w, { title: 'Another one', plotId: 'akihabara-2' }));
    assert.equal(two.status, 200, two.text);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, two.json.id).status, 'declined');
    assert.equal(h.db.get(`SELECT 1 x FROM plots WHERE plot_id = 'akihabara-2'`), undefined, 'declined -> released');
    const me = await a.call('GET', '/api/me');
    assert.deepEqual(me.json.plots, []);
  } finally { h.close(); }
});

test('/api/world: a private idea leaks nothing; public data appears once published; never a wallet', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    await a.call('POST', '/api/residents', { name: 'Kenji', look: LOOK, plotId: 'ebisu-1' });
    const sub = await a.call('POST', '/api/ideas', IDEA(a.w, { title: 'Secret Sauce Coin', tickerSuggestion: 'SAUCE', plotId: 'ebisu-2' }));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, sub.json.id).status, 'preview_ready');
    const anon = h.client(user(h.db));
    let w = await anon.call('GET', '/api/world');
    assert.equal(w.status, 200);
    assert.equal(w.headers.get('cache-control'), 'public, max-age=3');
    const plot = w.json.plots.find((p) => p.plotId === 'ebisu-2');
    assert.deepEqual(plot, { plotId: 'ebisu-2', kind: 'project', resident: null,
      project: { slug: null, name: 'Private project', ticker: null, stage: 'preview_ready', stageLabel: 'Preview ready for your review', progress: 0.65, launched: false, mint: null } });
    assert.deepEqual(w.json.plots.find((p) => p.plotId === 'ebisu-1').resident, { name: 'Kenji', look: { ...LOOK, top: '#ff6600' } });
    for (const secret of ['Secret Sauce', 'SAUCE', 'Ramen', a.w.address, sub.json.id, a.w.address.slice(0, 12)]) assert.ok(!w.text.includes(secret), `leaked ${secret}`);
    assert.ok(w.json.news.some((n) => n.text === 'Kenji moved into ebisu-1' && n.plotId === 'ebisu-1'));
    assert.equal(w.json.news.filter((n) => n.plotId === 'ebisu-2').length, 0, 'no news from a private idea');
    // published: name, ticker, slug and its public history become visible (the write busts the 3 s cache)
    await a.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    w = await anon.call('GET', '/api/world');
    const pub = w.json.plots.find((p) => p.plotId === 'ebisu-2').project;
    assert.equal(pub.ticker, 'SAUCE');
    assert.ok(pub.slug && pub.name !== 'Private project');
    assert.ok(w.json.news.some((n) => n.plotId === 'ebisu-2' && n.text.startsWith(`${pub.name}: `)));
    assert.ok(!w.text.includes(a.w.address), 'still no wallet');
    assert.ok(w.json.news.length <= 20);
  } finally { h.close(); }
});

test('/api/world sub01: working on a running job (private name hidden), asleep / offline from the brain\'s last answer', async () => {
  const { cfg, db } = makeEnv();
  const w = user(db);
  const { submitIdea } = await import('../src/ideas.js');
  const id = submitIdea(db, cfg, w.address, IDEA(w, { plotId: 'odaiba-4' }));
  db.run(`UPDATE ideas SET status = 'generating' WHERE id = ?`, id);
  db.run(`UPDATE jobs SET type = 'generate', status = 'running', progress = 'building the website in the sandbox' WHERE idea_id = ?`, id);
  let v = worldView(db, cfg);
  assert.deepEqual(v.sub01, { state: 'working', ideaId: null, plotId: 'odaiba-4', stage: 'generating', text: 'Building a private project (building)' });
  assert.equal(v.plots[0].project.progress, 0.58, 'generating + job progress');
  db.run(`UPDATE ideas SET visibility = 'public' WHERE id = ?`, id);
  v = worldView(db, cfg);
  assert.equal(v.sub01.ideaId, id);
  assert.equal(v.sub01.text, 'Building Ramen Radar (building)');
  db.run(`UPDATE jobs SET type = 'evaluate', status = 'queued', last_error = 'brain asleep (NREM)', updated_at = ?`, Date.now());
  assert.equal(worldView(db, cfg).sub01.state, 'asleep');
  db.run(`UPDATE jobs SET last_error = 'brain unavailable: timeout'`);
  assert.equal(worldView(db, cfg).sub01.state, 'offline');
  db.run(`UPDATE jobs SET status = 'succeeded'`);
  assert.equal(worldView(db, cfg).sub01.state, 'idle');
  assert.equal(worldView(db, { ...cfg, brain: { ...cfg.brain, url: '' } }).sub01.state, 'offline');
});

test('rooms: default room, strict validation, own room only, public read by plot, private project plot hidden', async () => {
  const h = await harness();
  try {
    const a = await signedIn(h);
    assert.equal((await a.call('PUT', '/api/rooms/me', { room: DEFAULT_ROOM })).json.error, 'no_resident');
    await a.call('POST', '/api/residents', { name: 'Kenji', look: LOOK, plotId: 'kanda-1' });
    const anon = h.client(user(h.db));
    let r = await anon.call('GET', '/api/rooms/kanda-1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { plotId: 'kanda-1', kind: 'apartment', owner: { name: 'Kenji', look: { ...LOOK, top: '#ff6600' } }, room: DEFAULT_ROOM });
    assert.equal((await anon.call('GET', '/api/rooms/kanda-2')).status, 404);
    assert.equal((await anon.call('GET', '/api/rooms/mars-1')).status, 400);
    const room = { materials: { floor: 'tatami', walls: 'sage', accent: 'rust' }, lighting: 'night', furniture: [{ item: 'bed', x: -3.5, z: 3.5, rot: 270 }, { item: 'table', x: 0.123, z: 0, rot: 0 }] };
    const bad = (patch) => a.call('PUT', '/api/rooms/me', { room: { ...room, ...patch } });
    assert.equal((await bad({ lighting: 'disco' })).json.error, 'bad_room');
    assert.equal((await bad({ materials: { ...room.materials, floor: 'marble' } })).json.error, 'bad_room');
    assert.equal((await bad({ furniture: [{ item: 'tv', x: 0, z: 0, rot: 0 }] })).json.error, 'bad_room');
    assert.equal((await bad({ furniture: [{ item: 'bed', x: 3.6, z: 0, rot: 0 }] })).json.error, 'bad_room');
    assert.equal((await bad({ furniture: [{ item: 'bed', x: 0, z: 0, rot: 45 }] })).json.error, 'bad_room');
    assert.equal((await bad({ furniture: [{ item: 'bed', x: '1', z: 0, rot: 0 }] })).json.error, 'bad_room');
    assert.equal((await bad({ furniture: Array.from({ length: 25 }, () => ({ item: 'plant', x: 0, z: 0, rot: 0 })) })).json.error, 'bad_room');
    assert.equal((await bad({ script: '<x>' })).json.error, 'bad_room');
    const ok = await a.call('PUT', '/api/rooms/me', { room });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.room.furniture[1].x, 0.12);
    r = await anon.call('GET', '/api/rooms/kanda-1');
    assert.equal(r.json.room.lighting, 'night');
    assert.equal((await a.call('GET', '/api/me')).json.resident.room.materials.floor, 'tatami');
    // a project plot shows its submitter's room only once the idea is public
    const sub = await a.call('POST', '/api/ideas', IDEA(a.w, { plotId: 'kanda-3' }));
    assert.equal((await anon.call('GET', '/api/rooms/kanda-3')).status, 404, 'private idea: not linkable to a person');
    await a.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    r = await anon.call('GET', '/api/rooms/kanda-3');
    assert.equal(r.json.kind, 'project');
    assert.equal(r.json.owner.name, 'Kenji');
    assert.ok(!r.text.includes(a.w.address));
  } finally { h.close(); }
});

test('roles: founder grants and revokes, others cannot; public view shortens wallets', async () => {
  const h = await harness();
  try {
    const founder = await signedIn(h);
    const p = launchedProject(h.db, founder.w.address);
    const mod = user(h.db);
    const stranger = await signedIn(h);
    assert.equal((await stranger.call('POST', `/api/projects/${p.slug}/roles`, { wallet: mod.address, role: 'moderator' })).status, 403);
    assert.equal((await founder.call('POST', `/api/projects/${p.slug}/roles`, { wallet: mod.address, role: 'founder' })).json.error, 'bad_role');
    assert.equal((await founder.call('POST', `/api/projects/${p.slug}/roles`, { wallet: founder.w.address, role: 'moderator' })).json.error, 'bad_wallet');
    const g = await founder.call('POST', `/api/projects/${p.slug}/roles`, { wallet: mod.address, role: 'moderator' });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.you, 'founder');
    const pub = await h.client(user(h.db)).call('GET', `/api/projects/${p.slug}/roles`);
    assert.deepEqual(pub.json.roles.map((r) => [r.wallet, r.role]), [[`${founder.w.address.slice(0, 4)}…${founder.w.address.slice(-4)}`, 'founder'], [`${mod.address.slice(0, 4)}…${mod.address.slice(-4)}`, 'moderator']]);
    assert.ok(!JSON.stringify(pub.json.roles).includes(mod.address));
    assert.equal((await founder.call('POST', `/api/projects/${p.slug}/roles`, { wallet: mod.address, role: 'community_lead' })).status, 200);
    assert.equal((await founder.call('POST', `/api/projects/${p.slug}/roles`, { wallet: mod.address, role: null })).status, 200);
    assert.equal((await founder.call('GET', `/api/projects/${p.slug}/roles`)).json.roles.length, 1);
    assert.equal((await founder.call('POST', `/api/projects/${p.slug}/roles`, { wallet: mod.address, role: null })).status, 404);
    // a launched project's building shows its mint, still no wallet
    h.db.run(`INSERT INTO plots (plot_id, kind, wallet, idea_id, claimed_at) VALUES ('roppongi-1', 'project', ?, 'idea_ramen', 1)`, founder.w.address);
    const w = await stranger.call('GET', '/api/world');
    assert.deepEqual(w.json.plots.find((x) => x.plotId === 'roppongi-1').project,
      { slug: 'ramen', name: 'Ramen', ticker: 'RAMEN', stage: 'launched', stageLabel: 'Launched', progress: 1, launched: true, mint: 'MintRamen' });
    assert.ok(!w.text.includes(founder.w.address) && !w.text.includes(mod.address));
  } finally { h.close(); }
});

test('takeover: launched only, not by the founder, one open at a time; founder decides; admin only after 30 silent days; fees never change', async () => {
  const h = await harness();
  try {
    const founder = await signedIn(h);
    const p = launchedProject(h.db, founder.w.address);
    const asker = await signedIn(h);
    const admin = await signedIn(h, 'admin');
    const stranger = await signedIn(h);
    // not launched -> refused
    const own = await founder.call('POST', '/api/ideas', IDEA(founder.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    await founder.call('POST', `/api/ideas/${own.json.id}/publish`, { public: true });
    const unlaunched = h.db.get('SELECT slug FROM projects WHERE idea_id = ?', own.json.id).slug;
    assert.equal((await asker.call('POST', `/api/projects/${unlaunched}/takeover`, { reason: 'x' })).json.error, 'not_launched');
    assert.equal((await founder.call('POST', `/api/projects/${p.slug}/takeover`, { reason: 'me' })).json.error, 'already_founder');
    assert.equal((await asker.call('POST', `/api/projects/${p.slug}/takeover`, { reason: '' })).json.error, 'bad_reason');
    assert.equal((await asker.call('POST', `/api/projects/${p.slug}/takeover`, { reason: 'x'.repeat(501) })).json.error, 'bad_reason');
    const req = await asker.call('POST', `/api/projects/${p.slug}/takeover`, { reason: 'The founder left; we run the community now.' });
    assert.equal(req.status, 200, req.text);
    assert.deepEqual(req.json.feeRecipients, p.recipients);
    assert.match(req.json.feeNote, /never changes fee recipients/);
    assert.ok(req.json.feeNote.includes(SUB01_WALLET) && req.json.feeNote.includes(founder.w.address));
    assert.equal((await stranger.call('POST', `/api/projects/${p.slug}/takeover`, { reason: 'me too' })).json.error, 'takeover_open');
    assert.equal((await h.client(user(h.db)).call('GET', `/api/projects/${p.slug}/roles`)).json.openTakeover.id, req.json.id);
    // who may decide
    assert.equal((await stranger.call('POST', `/api/takeover/${req.json.id}/decide`, { approve: true })).status, 403);
    assert.equal((await asker.call('POST', `/api/takeover/${req.json.id}/decide`, { approve: true })).status, 403, 'not your own request');
    const early = await admin.call('POST', `/api/takeover/${req.json.id}/decide`, { approve: true });
    assert.equal(early.json.error, 'founder_active', 'founder signed in recently');
    // 30 days of silence: the founder's audited activity and role grant are older than the window
    const old = Date.now() - INACTIVE_MS - 60_000;
    h.db.run('UPDATE events SET at = ? WHERE actor = ?', old, `wallet:${founder.w.address}`);
    h.db.run('UPDATE project_roles SET granted_at = ? WHERE project_id = ?', old, p.id);
    const before = h.db.get('SELECT config_json FROM launch_intents WHERE project_id = ?', p.id).config_json;
    const ok = await admin.call('POST', `/api/takeover/${req.json.id}/decide`, { approve: true });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'approved');
    assert.deepEqual(ok.json.feeRecipients, p.recipients, 'the response restates the unchanged recipients');
    assert.match(ok.json.feeNote, /locked on-chain/);
    assert.equal(h.db.get('SELECT config_json FROM launch_intents WHERE project_id = ?', p.id).config_json, before, 'fee config untouched');
    assert.deepEqual(h.db.all('SELECT wallet, role FROM project_roles WHERE project_id = ?', p.id).map((x) => ({ ...x })), [{ wallet: asker.w.address, role: 'founder' }], 'old founder has no role');
    const ev = h.db.get(`SELECT * FROM events WHERE kind = 'takeover' ORDER BY id DESC LIMIT 1`);
    assert.equal(ev.public, 1);
    assert.match(ev.message, /Fee recipients unchanged/);
    assert.equal((await admin.call('POST', `/api/takeover/${req.json.id}/decide`, { approve: false })).json.error, 'not_open');
    // the new founder decides the next one; a rejection and a withdrawal change nothing
    const r2 = await stranger.call('POST', `/api/projects/${p.slug}/takeover`, { reason: 'again' });
    assert.equal((await founder.call('POST', `/api/takeover/${r2.json.id}/decide`, { approve: true })).status, 403, 'the old founder lost the role');
    const no = await asker.call('POST', `/api/takeover/${r2.json.id}/decide`, { approve: false });
    assert.equal(no.json.status, 'rejected');
    const r3 = await stranger.call('POST', `/api/projects/${p.slug}/takeover`, { reason: 'third time' });
    assert.equal((await asker.call('POST', `/api/takeover/${r3.json.id}/withdraw`, {})).status, 404, 'only the requester withdraws');
    assert.equal((await stranger.call('POST', `/api/takeover/${r3.json.id}/withdraw`, {})).json.status, 'withdrawn');
    assert.equal(h.db.get(`SELECT wallet FROM project_roles WHERE project_id = ? AND role = 'founder'`, p.id).wallet, asker.w.address);
    assert.deepEqual((await asker.call('GET', '/api/me')).json.projectRoles, [{ slug: p.slug, role: 'founder' }]);
  } finally { h.close(); }
});

function rawGet(base, path) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('CITY_DIST: city at /, immutable assets with model MIME types, traversal refused, launchpad at /launchpad', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'city-'));
  mkdirSync(join(dist, 'assets', 'city'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SUB-01 · The neighborhood</title><script type="module" src="/assets/index-x.js"></script>');
  writeFileSync(join(dist, 'assets', 'index-x.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'city', 'bench.gltf'), '{}');
  writeFileSync(join(dist, 'assets', 'city', 'bench.bin'), 'b');
  writeFileSync(join(dist, 'assets', 'char.glb'), 'g');
  writeFileSync(join(dist, 'secret.txt'), 'nope');
  const h = await harness({ CITY_DIST: dist });
  try {
    const home = await rawGet(h.base, '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /The neighborhood/);
    assert.match(home.headers['content-security-policy'], /script-src 'self'/, 'served under the app CSP');
    const js = await rawGet(h.base, '/assets/index-x.js');
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await rawGet(h.base, '/assets/city/bench.gltf')).headers['content-type'], 'model/gltf+json');
    assert.equal((await rawGet(h.base, '/assets/city/bench.bin')).headers['content-type'], 'application/octet-stream');
    assert.equal((await rawGet(h.base, '/assets/char.glb')).headers['content-type'], 'model/gltf-binary');
    for (const p of ['/assets/..%2fsecret.txt', '/assets/..%2f..%2fpackage.json', '/assets/%2e%2e/secret.txt', '/assets/../secret.txt', '/assets/missing.js', '/assets/city%00.js']) {
      const r = await rawGet(h.base, p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('nope'), p);
    }
    const lp = await rawGet(h.base, '/launchpad');
    assert.equal(lp.status, 200);
    assert.match(lp.body, /id="app"/);
    assert.doesNotMatch(lp.body, /The neighborhood/);
    assert.equal((await rawGet(h.base, '/js/app.js')).status, 200, 'launchpad scripts still served');
    assert.equal((await h.client(user(h.db)).call('GET', '/api/config')).json.city, true);
  } finally { h.close(); }
  const plain = await harness();
  try {
    const home = await rawGet(plain.base, '/');
    assert.doesNotMatch(home.body, /The neighborhood/, 'without CITY_DIST / is the launchpad as before');
    assert.equal((await rawGet(plain.base, '/assets/index-x.js')).status, 404);
  } finally { plain.close(); }
});
