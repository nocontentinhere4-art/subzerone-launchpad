// End to end over HTTP with the MOCK launch provider (no blockchain): submit -> brain vote -> preview -> approvals ->
// launch config -> signature -> confirmation -> launched, plus the launch failure cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { user, drain, IDEA, ideaStatus, SUB01_WALLET, harness } from './helpers.js';
import { setSetting } from '../src/db.js';
import { mockSigningText } from '../src/launch/mock.js';
import { sweepSubmitted } from '../src/launch.js';

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

/** Run fn with the clock moved forward (the mock chain's indexing delay, blockhash windows). */
async function later(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

async function toLaunchPrepared(h) {
  const owner = h.client(user(h.db));
  await owner.signIn();
  const admin = h.client(user(h.db, 'admin'));
  await admin.signIn();
  const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
  assert.equal(sub.status, 200, sub.text);
  const ideaId = sub.json.id;
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  const idea = await owner.call('GET', `/api/ideas/${ideaId}`);
  assert.equal(idea.json.status, 'preview_ready');
  const slug = idea.json.project.slug;
  let proj = await owner.call('GET', `/api/projects/${slug}`);
  // approving while private is refused: a launch is public
  let ap = await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.json.allocation.id, statement: proj.json.allocation.statement, siteVersion: proj.json.liveSiteVersion });
  assert.equal(ap.status, 409);
  assert.equal((await owner.call('POST', `/api/ideas/${ideaId}/publish`, { public: true })).status, 200);
  ap = await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.json.allocation.id, statement: proj.json.allocation.statement, siteVersion: proj.json.liveSiteVersion });
  assert.equal(ap.status, 200, ap.text);
  assert.equal(ideaStatus(h.db, ideaId).status, 'preview_ready', 'waits for admin clearance');
  assert.equal((await admin.call('POST', `/api/admin/projects/${slug}/clear`, {})).status, 200);
  assert.equal(ideaStatus(h.db, ideaId).status, 'approved');
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
  proj = await owner.call('GET', `/api/projects/${slug}`);
  return { owner, admin, ideaId, slug, proj };
}

async function signAndSubmit(h, owner, slug) {
  const tx = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
  assert.equal(tx.status, 200, tx.text);
  assert.equal(tx.json.mock, true);
  const sig = owner.w.signText(mockSigningText(tx.json.messageHash));
  return { tx, res: await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: sig }) };
}

test('complete flow (MOCK provider): idea -> preview -> approved config -> signed -> verified -> launched', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug, proj } = await toLaunchPrepared(h);
    const cfg = proj.json.launchConfig;
    assert.equal(cfg.mock, true);
    assert.equal(cfg.initialBuyLamports, 0);
    assert.equal(cfg.feeSharing.mode, 'sharing_config', '80/20 is always an on-chain split');
    assert.deepEqual(cfg.feeSharing.shareholders, [{ wallet: owner.w.address, bps: 8000 }, { wallet: SUB01_WALLET, bps: 2000 }]);
    assert.ok(cfg.irreversible.length >= 2);
    const { res } = await signAndSubmit(h, owner, slug);
    assert.equal(res.status, 200, res.text);
    assert.equal(ideaStatus(h.db, ideaId).status, 'confirming');
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
    const done = await owner.call('GET', `/api/projects/${slug}`);
    assert.equal(done.json.launch.provider, 'mock');
    assert.ok(done.json.launch.verification.every((c) => c.ok));
    assert.equal(done.json.allocation.status, 'locked');
    // the public sees it; the ledger shows no invented revenue
    const anon = h.client(user(h.db));
    const pub = await anon.call('GET', `/api/projects/${slug}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.json.intent, undefined);
    const ledger = await anon.call('GET', '/api/ledger');
    assert.equal(ledger.json.projects[0].ledger.confirmedPayoutsLamports, 0);
    assert.equal(ledger.json.projects[0].ledger.mock, true);
    // the project site on its own host: strict CSP, no scripts
    const site = await getWithHost(h.base, `${slug}.${h.cfg.projectsHost}`, '/');
    assert.equal(site.status, 200);
    assert.match(site.headers['content-security-policy'], /default-src 'none'/);
    const html = site.body;
    assert.equal((await getWithHost(h.base, `nope.${h.cfg.projectsHost}`, '/')).status, 404);
    assert.ok(!/<script/i.test(html));
    assert.match(html, /MOCK launch: rehearsal only/);
  } finally { h.close(); }
});

test('duplicate launch attempts: second transaction request and a second signed submit are refused', async () => {
  const h = await harness();
  try {
    const { owner, slug } = await toLaunchPrepared(h);
    const first = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(first.status, 200);
    const second = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(second.status, 200);
    assert.equal(second.json.resumed, true, 'a second request resumes the same transaction');
    assert.equal(second.json.mint, first.json.mint);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM launch_intents').n, 1);
    const sig = owner.w.signText(mockSigningText(first.json.messageHash));
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: sig })).status, 200);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: sig })).status, 409);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {})).status, 409);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM launches').n, 1);
  } finally { h.close(); }
});

test('wallet rejects the signature: back to launch_prepared, nothing created', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    const ab = await owner.call('POST', `/api/projects/${slug}/launch/abandon`, { reason: 'rejected' });
    assert.equal(ab.status, 200);
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
    assert.match(ideaStatus(h.db, ideaId).status_note, /rejected/);
    assert.equal(h.db.get(`SELECT status FROM launch_intents`).status, 'cancelled');
    const again = await signAndSubmit(h, owner, slug);           // a fresh attempt works
    assert.equal(again.res.status, 200);
  } finally { h.close(); }
});

test('signature for a different transaction is refused', async () => {
  const h = await harness();
  try {
    const { owner, slug } = await toLaunchPrepared(h);
    await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    const bad = owner.w.signText(mockSigningText('0'.repeat(64)));
    const res = await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: bad });
    assert.equal(res.status, 400);
    const other = h.client(user(h.db));
    await other.signIn();
    assert.equal((await other.call('POST', `/api/projects/${slug}/launch/signed`, { signed: bad })).status, 404);
  } finally { h.close(); }
});

test('transaction rejected on-chain: back to launch_prepared with the reason', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    setSetting(h.db, 'mock.behaviour', 'reject_on_chain', 'test');
    await signAndSubmit(h, owner, slug);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
    assert.match(ideaStatus(h.db, ideaId).status_note, /failed on-chain/);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM launches').n, 0);
  } finally { h.close(); }
});

test('transaction expired (never landed): back to launch_prepared after the blockhash window', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    setSetting(h.db, 'mock.behaviour', 'never_lands', 'test');
    await signAndSubmit(h, owner, slug);
    const intent = h.db.get('SELECT * FROM launch_intents');
    // freeze "now" past the window for the mock's block height
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try { await drain(h.db, h.cfg, h.brain.fetchImpl); } finally { Date.now = realNow; }
    assert.equal(h.db.get('SELECT status FROM launch_intents WHERE id = ?', intent.id).status, 'expired');
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
  } finally { h.close(); }
});

test('confirmed after the confirm job gave up: the sweep finds it and the project becomes launched', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    setSetting(h.db, 'mock.behaviour', 'late', 'test');
    await signAndSubmit(h, owner, slug);
    // the confirm job runs out of attempts while the transaction is not yet visible
    h.db.run(`UPDATE jobs SET max_attempts = 1 WHERE type = 'confirm_launch'`);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(h.db.get(`SELECT status FROM jobs WHERE type = 'confirm_launch'`).status, 'dead');
    assert.equal(ideaStatus(h.db, ideaId).status, 'confirming');
    assert.match(ideaStatus(h.db, ideaId).status_note, /still being checked/);
    const realNow = Date.now;
    Date.now = () => realNow() + 200_000;
    try {
      assert.equal(sweepSubmitted(h.db, Date.now()), 1);
      await drain(h.db, h.cfg, h.brain.fetchImpl);
    } finally { Date.now = realNow; }
    assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
  } finally { h.close(); }
});

test('incorrect fee recipients: wrong submitter wallet, bad totals, missing or altered SUB-01 row are refused', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const draft = (await owner.call('GET', `/api/projects/${slug}`)).json.allocation;
    assert.deepEqual(draft.recipients.map((r) => [r.role, r.wallet, r.bps]), [['submitter', owner.w.address, 8000], ['sub01', SUB01_WALLET, 2000]], 'default 80/20');
    const other = user(h.db), third = user(h.db);
    const S1 = { wallet: SUB01_WALLET, bps: 2000, role: 'sub01' };
    const put = (recipients) => owner.call('PUT', `/api/projects/${slug}/allocation`, { recipients });
    assert.equal((await put([{ wallet: other.address, bps: 8000, role: 'submitter' }, S1])).status, 400, 'submitter row must be the receiving wallet');
    assert.equal((await put([{ wallet: owner.w.address, bps: 6000, role: 'submitter' }, { wallet: other.address, bps: 1000 }, S1])).status, 400, 'must total 100%');
    assert.equal((await put([{ wallet: owner.w.address, bps: 10000, role: 'submitter' }])).status, 400, 'SUB-01 row cannot be removed');
    assert.equal((await put([{ wallet: owner.w.address, bps: 9000, role: 'submitter' }, { ...S1, bps: 1000 }])).status, 400, 'SUB-01 row is exactly 20%');
    assert.equal((await put([{ wallet: owner.w.address, bps: 8000, role: 'submitter' }, { ...S1, wallet: other.address }])).status, 400, 'SUB-01 row goes to SUB01_FEE_WALLET');
    assert.equal((await put([{ wallet: owner.w.address, bps: 7000, role: 'submitter' }, { wallet: other.address, bps: 1000, role: 'collaborator' }, { wallet: third.address, bps: 2000, role: 'collaborator' }])).status, 400, 'SUB-01 row cannot be replaced by a collaborator');
    assert.equal((await put([{ wallet: owner.w.address, bps: 7000, role: 'submitter' }, { wallet: other.address, bps: 1000, role: 'platform' }, S1])).status, 400, 'no platform role any more');
    assert.equal((await put([{ wallet: owner.w.address, bps: 4000, role: 'submitter' }, { wallet: owner.w.address, bps: 4000 }, S1])).status, 400, 'duplicates');
    const ok = await put([{ wallet: owner.w.address, bps: 5000, role: 'submitter' }, { wallet: other.address, bps: 2000, label: 'artist' }, { wallet: third.address, bps: 1000 }, { role: 'sub01', bps: 2000 }]);
    assert.equal(ok.status, 200, ok.text);
    const proj = await owner.call('GET', `/api/projects/${slug}`);
    assert.equal(proj.json.allocation.mode, 'sharing_config');
    assert.equal(proj.json.allocation.recipients.find((r) => r.role === 'sub01').wallet, SUB01_WALLET, 'the server fills SUB-01\'s wallet');
    assert.match(proj.json.allocation.statement, /LOCKED/);
    assert.match(proj.json.allocation.statement, /SUB-01 \(sub01\): 20\.00%/);
    // approving with a stale statement is refused
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const stale = await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.json.allocation.id, statement: 'something else', siteVersion: proj.json.liveSiteVersion });
    assert.equal(stale.status, 409);
  } finally { h.close(); }
});

test('SUB01_FEE_WALLET missing: the draft is still 80/20, but approval and launch preparation fail with sub01_wallet_missing', async () => {
  const h = await harness({ SUB01_FEE_WALLET: '' });
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const proj = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual(proj.allocation.recipients.map((r) => [r.role, r.bps, r.wallet]), [['submitter', 8000, owner.w.address], ['sub01', 2000, null]], 'never 100% to someone');
    const ap = await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.allocation.id, statement: proj.allocation.statement, siteVersion: proj.liveSiteVersion });
    assert.equal(ap.status, 409);
    assert.equal(ap.json.error, 'sub01_wallet_missing');
    const put = await owner.call('PUT', `/api/projects/${slug}/allocation`, { recipients: [{ wallet: owner.w.address, bps: 10000, role: 'submitter' }] });
    assert.equal(put.json.error, 'sub01_wallet_missing');
    assert.equal(ideaStatus(h.db, sub.json.id).status, 'preview_ready');
    // and the launch preparation job refuses on its own, even if an approved row slipped through
    const { buildLaunchConfig } = await import('../src/launch.js');
    await assert.rejects(buildLaunchConfig(h.db, h.cfg, h.db.get('SELECT * FROM projects WHERE slug = ?', slug)), /sub01_wallet_missing/);
    assert.equal((await owner.call('GET', '/api/config')).json.sub01Share.configured, false);
    assert.equal((await owner.call('POST', '/api/admin/platform-share', { share: null })).status, 404, 'the old platform-share endpoint is gone');
  } finally { h.close(); }
});

test('on-chain result that does not match the approved recipients: not launched, admin alerted, no relaunch', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    await signAndSubmit(h, owner, slug);
    // tamper with what "landed" (the mock ledger) so the recipients differ
    const row = h.db.get('SELECT * FROM mock_chain');
    const payload = JSON.parse(row.payload);
    payload.feeSharing.shareholders = [{ wallet: user(h.db).address, bps: 10000 }];
    h.db.run('UPDATE mock_chain SET payload = ? WHERE signature = ?', JSON.stringify(payload), row.signature);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal(ideaStatus(h.db, ideaId).status, 'failed');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM launches').n, 0);
    const admin = h.client(user(h.db, 'admin'));
    await admin.signIn();
    assert.equal((await admin.call('POST', `/api/admin/ideas/${ideaId}/retry`, {})).status, 409);
  } finally { h.close(); }
});

test('http: cross-site writes refused, private ideas hidden, security headers set, admin gated', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    const evil = await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('GET', `/api/ideas/${sub.json.id}`)).status, 404);
    assert.equal((await anon.call('GET', '/api/admin/overview')).status, 401);
    await anon.signIn();
    assert.equal((await anon.call('GET', '/api/admin/overview')).status, 403);
    const page = await anon.call('GET', '/');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const noSession = await anon.call('POST', '/api/ideas', IDEA(anon.w), { cookie: '' });
    assert.equal(noSession.status, 401);
  } finally { h.close(); }
});

test('admin pause on launch blocks new transactions', async () => {
  const h = await harness();
  try {
    const { owner, admin, slug } = await toLaunchPrepared(h);
    assert.equal((await admin.call('POST', '/api/admin/pause', { what: 'launch', paused: true })).status, 200);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {})).status, 503);
  } finally { h.close(); }
});


test('review #1: broadcast times out but the transaction lands -> still tracked, launched, no second mint', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    setSetting(h.db, 'mock.behaviour', 'timeout_but_lands', 'test');
    const { res } = await signAndSubmit(h, owner, slug);
    assert.equal(res.status, 200);
    assert.equal(res.json.uncertain, true);
    assert.equal(ideaStatus(h.db, ideaId).status, 'confirming');
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {})).status, 409);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM launch_intents').n, 1);
  } finally { h.close(); }
});

test('review #1: a failed preflight is a definite rejection; a new attempt is allowed', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    setSetting(h.db, 'mock.behaviour', 'preflight_reject', 'test');
    const { res } = await signAndSubmit(h, owner, slug);
    assert.equal(res.status, 400);
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
    assert.match(h.db.get('SELECT error FROM launch_intents').error, /^preflight:/);
    setSetting(h.db, 'mock.behaviour', 'ok', 'test');
    assert.equal((await signAndSubmit(h, owner, slug)).res.status, 200);
  } finally { h.close(); }
});

test('review #2: a cancelled request whose signed copy landed anyway is found and verified, not duplicated', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    const tx = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    await owner.call('POST', `/api/projects/${slug}/launch/abandon`, {});
    // someone broadcast the signed copy outside the app
    const intent = h.db.get('SELECT * FROM launch_intents');
    h.db.run(`INSERT INTO mock_chain (signature, mint, payload, status, visible_at) VALUES ('MOCKexternal', ?, ?, 'ok', ?)`, intent.mint, intent.config_json, Date.now());
    const again = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'previous_landed');
    assert.equal(ideaStatus(h.db, ideaId).status, 'confirming');
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
    assert.equal(h.db.get('SELECT mint FROM launches').mint, tx.json.mint);
  } finally { h.close(); }
});

test('review #4/#5/#7: edits revoke reviewer clearance; no live-version swap or going private after approval; no self-clearance', async () => {
  const h = await harness({ REQUIRE_ADMIN_CLEARANCE: '1' });
  try {
    const owner = h.client(user(h.db, 'reviewer'));
    await owner.signIn();
    const admin = h.client(user(h.db, 'admin'));
    await admin.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    assert.equal((await owner.call('POST', `/api/admin/projects/${slug}/clear`, {})).status, 403, 'reviewer cannot clear own project');
    assert.equal((await admin.call('POST', `/api/admin/projects/${slug}/clear`, {})).status, 200);
    // the owner edits after clearance: clearance is gone
    const ed = await owner.call('PUT', `/api/projects/${slug}/site`, { name: 'Totally Different', ticker: 'DIFF' });
    assert.equal(ed.status, 200, ed.text);
    assert.equal(h.db.get('SELECT admin_cleared_at a FROM projects').a, null);
    let p = (await owner.call('GET', `/api/projects/${slug}`)).json;
    await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: p.allocation.id, statement: p.allocation.statement, siteVersion: p.liveSiteVersion });
    assert.equal(ideaStatus(h.db, sub.json.id).status, 'preview_ready', 'needs a fresh clearance');
    await admin.call('POST', `/api/admin/projects/${slug}/clear`, {});
    assert.equal(ideaStatus(h.db, sub.json.id).status, 'approved');
    assert.equal((await owner.call('POST', `/api/projects/${slug}/site/live`, { version: 1 })).status, 409);
    assert.equal((await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: false })).status, 409);
  } finally { h.close(); }
});

test('review #8: non-owners only get preview links for the live version; private logos are not served', async () => {
  const h = await harness();
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    assert.equal((await owner.call('GET', `/meta/${slug}/logo-v1.png`)).status, 404, 'private project');
    await owner.call('PUT', `/api/projects/${slug}/site`, { tagline: 'v2 draft text' });
    await owner.call('POST', `/api/projects/${slug}/site/live`, { version: 1 });
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const anon = h.client(user(h.db));
    const link = await anon.call('GET', `/api/projects/${slug}/preview-link?version=2`);
    assert.match(link.json.url, new RegExp(`/preview/${slug}/1\\.`));
    assert.equal((await anon.call('GET', `/meta/${slug}/logo-v1.png`)).status, 200);
  } finally { h.close(); }
});
