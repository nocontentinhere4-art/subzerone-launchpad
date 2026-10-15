// End to end over HTTP with the MOCK launch provider (no blockchain): submit -> brain vote -> preview -> approvals ->
// launch config -> signature -> confirmation -> launched, plus the launch failure cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { user, drain, IDEA, ideaStatus, SUB01_WALLET, harness } from './helpers.js';
import { setSetting } from '../src/db.js';
import { mockSigningText } from '../src/launch/mock.js';
import { sweepSubmitted, setProviderForTests, getProvider, simulationMessage } from '../src/launch.js';
import { LaunchBuildError } from '../src/launch/pumpfun.js';

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
  const h = await harness({ LAUNCH_SPLIT_TX: '0' });
  try {
    const { owner, ideaId, slug, proj } = await toLaunchPrepared(h);
    const cfg = proj.json.launchConfig;
    assert.equal(cfg.mock, true);
    assert.equal(cfg.initialBuyLamports, 0);
    assert.equal(cfg.feeSharing.mode, 'sharing_config', '80/20 is always an on-chain split');
    assert.deepEqual(cfg.feeSharing.shareholders, [{ wallet: owner.w.address, bps: 8000 }, { wallet: SUB01_WALLET, bps: 2000 }]);
    assert.ok(cfg.irreversible.length >= 2);
    // review-before-sign: what the wallet will see, read from the built transaction; the same on resume
    const MOCK_REVIEW = { network: 'mock', feePayer: owner.w.address, programs: [{ id: 'MockLaunch', name: 'MockLaunch', direct: true }],
      accountsWritable: 0, signers: 1, launchProgramsOnly: true };
    const built = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    const pick = (j) => Object.fromEntries(Object.keys(MOCK_REVIEW).map((k) => [k, j[k]]));
    assert.deepEqual(pick(built.json), MOCK_REVIEW);
    const resumed = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(resumed.json.resumed, true);
    assert.deepEqual(pick(resumed.json), MOCK_REVIEW);
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
    // the project site on its own host: strict CSP; its only script is the audited kit (docs/SITE-KIT.md)
    const site = await getWithHost(h.base, `${slug}.${h.cfg.projectsHost}`, '/');
    assert.equal(site.status, 200);
    assert.match(site.headers['content-security-policy'], /default-src 'none'; script-src 'self'; connect-src 'self'/);
    const html = site.body;
    assert.equal((await getWithHost(h.base, `nope.${h.cfg.projectsHost}`, '/')).status, 404);
    assert.deepEqual(html.match(/<script[^>]*>/gi), ['<script src="/_kit/site-kit.v1.js" defer>']);
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
  const h = await harness({ LAUNCH_SPLIT_TX: '0' });
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

test('dev buy (launch options): owner only, cap, re-prepared config with a new hash, locked by a transaction, recorded by the mock', async () => {
  const h = await harness({ MAX_INITIAL_BUY_SOL: '2', LAUNCH_SPLIT_TX: '0' });
  try {
    const { owner, ideaId, slug, proj } = await toLaunchPrepared(h);
    const put = (c, body) => c.call('PUT', `/api/projects/${slug}/launch/options`, body);
    const before = h.db.get('SELECT launch_config_hash h FROM projects WHERE slug = ?', slug).h;
    assert.deepEqual(proj.json.launchOptions, { initialBuyLamports: 0, maxInitialBuyLamports: 2_000_000_000, locked: false, editable: true });
    // validation and permissions
    assert.equal((await put(owner, { initialBuySol: -1 })).status, 400);
    assert.equal((await put(owner, { initialBuySol: 'abc' })).status, 400);
    assert.equal((await put(owner, { initialBuySol: 2.5 })).status, 400, 'above MAX_INITIAL_BUY_SOL');
    assert.equal((await put(owner, {})).status, 400);
    const other = h.client(user(h.db));
    await other.signIn();
    assert.equal((await put(other, { initialBuySol: 0.1 })).status, 404, 'not the owner');
    const anon = h.client(user(h.db));
    assert.equal((await put(anon, { initialBuySol: 0.1 })).status, 401);
    // set while launch_prepared: the configuration is rebuilt by the job and its hash changes
    const set = await put(owner, { initialBuySol: 0.25 });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual([set.json.initialBuyLamports, set.json.status, set.json.reprepared], [250_000_000, 'approved', true]);
    assert.equal(ideaStatus(h.db, ideaId).status, 'approved');
    assert.equal(h.db.get('SELECT launch_config_json j FROM projects WHERE slug = ?', slug).j, null);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {})).status, 409, 'no transaction without a prepared configuration');
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
    const after = await owner.call('GET', `/api/projects/${slug}`);
    assert.equal(after.json.launchConfig.initialBuyLamports, 250_000_000);
    assert.equal(after.json.launchConfig.initialBuySlippageBps, 500);
    assert.equal(after.json.launchConfig.devBuyMode, 'second_tx', 'the buy is its own transaction (the mock does what pump.fun must)');
    assert.match(after.json.launchConfig.irreversible.at(-1), /Your dev buy of 0\.25 SOL is a second signature right after the launch.*moves more than 5% first, it does not go through and you keep your SOL/);
    assert.notEqual(h.db.get('SELECT launch_config_hash h FROM projects WHERE slug = ?', slug).h, before);
    assert.equal(after.json.launchOptions.initialBuyLamports, 250_000_000);
    // the same value again changes nothing and does not re-prepare
    const same = await put(owner, { initialBuySol: '0.25' });
    assert.equal(same.json.reprepared, false);
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
    // a transaction exists: the option is locked until it is cancelled
    const tx = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.equal(tx.status, 200, tx.text);
    assert.equal(tx.json.estimate.initialBuyLamports, 0, 'tx1 buys nothing');
    assert.deepEqual([tx.json.estimate.devBuyMode, tx.json.estimate.devBuy.requestedLamports], ['second_tx', 250_000_000], 'the buy that follows, quoted');
    assert.equal(tx.json.launchProgramsOnly, true);
    const locked = await put(owner, { initialBuySol: 0 });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error, 'intent_exists');
    assert.equal((await owner.call('GET', `/api/projects/${slug}`)).json.launchOptions.locked, true);
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/abandon`, { reason: 'cancelled' })).status, 200);
    assert.equal((await put(owner, { initialBuySol: 0.5 })).status, 200);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    // sign the mock launch: launched without waiting for the buy, which is step 2
    const { res } = await signAndSubmit(h, owner, slug);
    assert.equal(res.status, 200, res.text);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
    const done = await owner.call('GET', `/api/projects/${slug}`);
    assert.equal(done.json.launch.verification.find((c) => /dev buy/.test(c.name)), undefined, 'tx1 is verified without the buy');
    assert.equal(done.json.intent.dev_buy_mode, 'second_tx');
    assert.match(done.json.statusNote, /next: your dev buy of 0.5 SOL, a second signature \(step 2\)/);
    assert.deepEqual([done.json.devBuy.status, done.json.devBuy.lamports, done.json.devBuy.attempt], ['pending', 500_000_000, null]);
    assert.equal(done.json.launch.dev_buy_status, 'pending');
    assert.equal((await put(owner, { initialBuySol: 0 })).status, 409, 'launched: no more changes');
  } finally { h.close(); }
});

test('dev buy: set at preview_ready it lands in the first configuration; the hard cap is 5 SOL whatever the env says', async () => {
  const h = await harness({ MAX_INITIAL_BUY_SOL: '50', LAUNCH_SPLIT_TX: '0' });
  try {
    const owner = h.client(user(h.db));
    await owner.signIn();
    const sub = await owner.call('POST', '/api/ideas', IDEA(owner.w));
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const slug = (await owner.call('GET', `/api/ideas/${sub.json.id}`)).json.project.slug;
    const put = (body) => owner.call('PUT', `/api/projects/${slug}/launch/options`, body);
    assert.equal((await owner.call('GET', `/api/projects/${slug}`)).json.launchOptions.maxInitialBuyLamports, 5_000_000_000);
    assert.equal((await put({ initialBuySol: 5.01 })).status, 400);
    assert.equal((await put({ initialBuySol: 5 })).status, 200);
    assert.equal((await put({ initialBuySol: 0.01 })).status, 200);
    assert.equal(ideaStatus(h.db, sub.json.id).status, 'preview_ready', 'nothing to re-prepare yet');
    const admin = h.client(user(h.db, 'admin'));
    await admin.signIn();
    await owner.call('POST', `/api/ideas/${sub.json.id}/publish`, { public: true });
    const proj = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.equal((await owner.call('POST', `/api/projects/${slug}/approve`, { allocationId: proj.allocation.id, statement: proj.allocation.statement, siteVersion: proj.liveSiteVersion })).status, 200);
    assert.equal((await admin.call('POST', `/api/admin/projects/${slug}/clear`, {})).status, 200);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const cfg = (await owner.call('GET', `/api/projects/${slug}`)).json.launchConfig;
    assert.equal(cfg.initialBuyLamports, 10_000_000);
    assert.equal(cfg.irreversible.filter((l) => /dev buy of 0.01 SOL is a second signature/.test(l)).length, 1);
    // the public view never shows the option
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('GET', `/api/projects/${slug}`)).json.launchOptions, undefined);
  } finally { h.close(); }
});

test('dev buy guards (single-transaction path): minimum and wallet balance at PUT time; a failed simulation, a coded build error or short funds never store an intent', async () => {
  const h = await harness({ LAUNCH_SPLIT_TX: '0' });
  try {
    setSetting(h.db, 'mock.devbuy_one_tx', true, 'test');               // the buy fits inside tx1 (a provider that says so)
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    const put = (body) => owner.call('PUT', `/api/projects/${slug}/launch/options`, body);
    const mock = getProvider(h.cfg, h.db);
    const fake = { ...mock };
    setProviderForTests(h.db, fake, h.cfg);
    const r = await put({ initialBuySol: 0.0005 });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /at least 0.001 SOL/);
    // balance: 0.03 SOL covers 0.01 + the 0.02 reserve, not 0.5
    fake.balance = async () => 30_000_000;
    const poor = await put({ initialBuySol: 0.5 });
    assert.equal(poor.status, 400);
    assert.equal(poor.json.error, 'insufficient_funds');
    assert.match(poor.json.message, /your wallet holds 0.03 SOL; the dev buy of 0.5 SOL plus about 0.02 SOL of rent and fees needs 0.52 SOL/);
    assert.equal(h.db.get('SELECT initial_buy_lamports b FROM projects WHERE slug = ?', slug).b, 0, 'nothing stored');
    // no size limit any more: a buy that does not fit tx1 is step 2
    assert.equal((await put({ initialBuySol: 0.01 })).status, 200);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
    assert.equal((await owner.call('GET', `/api/projects/${slug}`)).json.launchConfig.devBuyMode, 'same_tx');
    assert.match((await owner.call('GET', `/api/projects/${slug}`)).json.launchConfig.irreversible.at(-1), /You buy 0.01 SOL of your own coin in the creation transaction, pump.fun's fees included/);
    const tx = () => owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    const intents = () => h.db.get('SELECT COUNT(*) n FROM launch_intents').n;
    // 1. the simulation failed: the author reads why, nothing is stored, the state stays launch_prepared
    fake.prepare = async (c) => ({ ...(await mock.prepare(c)), estimate: { networkFeeLamports: 10_000, accountsLamports: null, initialBuyLamports: 10_000_000, signerBalanceLamports: 5_000_000,
      simulation: { ok: false, err: '{"InstructionError":[4,{"Custom":1}]}', logs: ['Program 6EF8 invoke [1]', 'Program log: Error: insufficient lamports 5000000, need 10500000', 'Program 6EF8 failed: custom program error: 0x1'] } } });
    let res = await tx();
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error, 'simulation_failed');
    assert.match(res.json.message, /your wallet cannot cover it: your wallet holds 0.005 SOL; the dev buy of 0.01 SOL plus about 0.02 SOL of rent and fees needs 0.03 SOL/);
    assert.equal(intents(), 0);
    assert.equal(ideaStatus(h.db, ideaId).status, 'launch_prepared');
    fake.prepare = async (c) => ({ ...(await mock.prepare(c)), estimate: { simulation: { ok: false, err: '{"InstructionError":[1,"ProgramFailedToComplete"]}', logs: ['Program pfee invoke [1]', 'Program log: AnchorError: ConstraintSeeds', 'Program pfee failed: custom program error: 0x7d6'] } } });
    res = await tx();
    assert.equal(res.json.error, 'simulation_failed');
    assert.match(res.json.message, /rejected the transaction \(AnchorError: ConstraintSeeds\); nothing was created/);
    // 2. a coded build error (does not fit, would complete the curve)
    fake.prepare = async () => { throw new LaunchBuildError('buy_completes_curve', 'the dev buy would buy the whole bonding curve and complete it; choose a smaller amount'); };
    res = await tx();
    assert.deepEqual([res.status, res.json.error], [409, 'buy_completes_curve']);
    // 3. the simulation passed but the balance is short of fee + rent + buy
    fake.prepare = async (c) => ({ ...(await mock.prepare(c)), estimate: { networkFeeLamports: 10_000, accountsLamports: 15_133_320, initialBuyLamports: 10_000_000, initialBuyTokensBase: '5000000', signerBalanceLamports: 25_000_000, simulation: { ok: true } } });
    res = await tx();
    assert.deepEqual([res.status, res.json.error], [409, 'insufficient_funds']);
    assert.match(res.json.message, /holds 0.025 SOL; the dev buy of 0.01 SOL plus 0.01514332 SOL of rent and fees needs 0.02514332 SOL/);
    assert.equal(intents(), 0);
    // 4. enough: the intent stores the reviewed token amount, and the launched note says what was bought
    fake.prepare = async (c) => ({ ...(await mock.prepare(c)), estimate: { networkFeeLamports: 10_000, accountsLamports: 15_133_320, initialBuyLamports: 10_000_000, initialBuyTokensBase: '10493886257633', signerBalanceLamports: 1_000_000_000, simulation: { ok: true } } });
    res = await tx();
    assert.equal(res.status, 200, res.text);
    assert.equal(h.db.get('SELECT buy_tokens_base b FROM launch_intents').b, '10493886257633');
    const sig = owner.w.signText(mockSigningText(res.json.messageHash));
    assert.equal((await owner.call('POST', `/api/projects/${slug}/launch/signed`, { signed: sig })).status, 200);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
    assert.match(ideaStatus(h.db, ideaId).status_note, /dev buy: 0.01 SOL for 10,493,886 tokens, in your wallet/);
    assert.equal(h.db.get('SELECT dev_buy_status s FROM launches').s, null, 'bought inside tx1: no step 2');
    assert.equal(h.db.get('SELECT dev_buy_mode m FROM launch_intents').m, 'same_tx');
    // the plain-words helper on its own
    assert.match(simulationMessage({ simulation: { ok: false, err: 'x', logs: [] } }, 0), /unknown reason|rejected the transaction \(x\)/);
    assert.match(simulationMessage({ simulation: { ok: false, logs: ['Program log: Transfer: insufficient lamports'] } }, 2_000_000), /cannot cover the dev buy of 0.002 SOL/);
  } finally { h.close(); }
});

test('dev buy: a configuration that cannot be prepared leaves a plain note on the idea (dead prepare job)', async () => {
  const h = await harness();
  try {
    const { owner, ideaId, slug } = await toLaunchPrepared(h);
    assert.equal((await owner.call('PUT', `/api/projects/${slug}/launch/options`, { initialBuySol: 0.01 })).status, 200);
    assert.equal(ideaStatus(h.db, ideaId).status, 'approved');
    h.db.run('UPDATE projects SET initial_buy_lamports = 6000000000 WHERE slug = ?', slug);      // above the hard cap, behind the API's back
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    assert.equal(ideaStatus(h.db, ideaId).status, 'approved');
    assert.match(ideaStatus(h.db, ideaId).status_note, /could not be prepared: the dev buy of 6 SOL is above the cap of 5 SOL/);
    assert.equal(h.db.get(`SELECT status FROM jobs WHERE type = 'prepare_launch' ORDER BY created_at DESC LIMIT 1`).status, 'dead');
  } finally { h.close(); }
});

// --- step 2: the dev buy as its own transaction (launch.js createDevBuy … confirmDevBuy) ----------------------------
async function launchedWithBuy(h, sol = 0.01) {
  const { owner, ideaId, slug } = await toLaunchPrepared(h);
  assert.equal((await owner.call('PUT', `/api/projects/${slug}/launch/options`, { initialBuySol: sol })).status, 200);
  await drain(h.db, h.cfg, h.brain.fetchImpl);
  const { res } = await signAndSubmit(h, owner, slug);
  assert.equal(res.status, 200, res.text);
  await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
  assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
  return { owner, ideaId, slug };
}
const devbuy = (c, slug, what, body = {}) => c.call('POST', `/api/projects/${slug}/launch/devbuy/${what}`, body);

test('dev buy step 2 (MOCK): launched first, then the author\'s own second signature: build, resume, cancel, sign, verify, done', async () => {
  const h = await harness({ LAUNCH_SPLIT_TX: '0' });
  try {
    const { owner, ideaId, slug } = await launchedWithBuy(h, 0.01);
    // nobody else can build it; nothing to sign before it is built
    const other = h.client(user(h.db)); await other.signIn();
    assert.equal((await devbuy(other, slug, 'transaction')).status, 404);
    assert.equal((await devbuy(owner, slug, 'signed', { signed: 'x' })).json.error, 'no_intent');
    // build: one signer (the author), its own review, the buy's amounts
    const tx = await devbuy(owner, slug, 'transaction');
    assert.equal(tx.status, 200, tx.text);
    assert.deepEqual([tx.json.step, tx.json.mock, tx.json.signers, tx.json.feePayer, tx.json.launchProgramsOnly], [2, true, 1, owner.w.address, true]);
    assert.equal(tx.json.mockSigningText, mockSigningText(tx.json.messageHash), 'the mock text for step 2 comes with it');
    assert.deepEqual([tx.json.requestedLamports, tx.json.maxLamports, tx.json.estimate.initialBuyLamports, tx.json.estimate.initialBuyMaxLamports], [10_000_000, 10_500_000, 10_000_000, 10_500_000]);
    let view = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([view.status, view.devBuy.status, view.devBuy.attempt.status], ['launched', 'awaiting_signature', 'awaiting_signature'], 'still launched');
    // a second request resumes the same one; refresh keeps it (mock: no blockhash)
    const again = await devbuy(owner, slug, 'transaction');
    assert.deepEqual([again.json.resumed, again.json.attemptId], [true, tx.json.attemptId]);
    assert.equal((await devbuy(owner, slug, 'refresh')).json.attemptId, tx.json.attemptId);
    // a signature for something else is refused, nothing changes
    const bad = await devbuy(owner, slug, 'signed', { signed: owner.w.signText(mockSigningText('0'.repeat(64))) });
    assert.deepEqual([bad.status, bad.json.error], [400, 'bad_signed_tx']);
    // the wallet declines: back to pending; a new one is built (the mock has no window to wait for)
    assert.equal((await devbuy(owner, slug, 'abandon', { reason: 'rejected' })).status, 200);
    assert.equal(h.db.get('SELECT dev_buy_status s FROM launches').s, 'pending');
    const tx2 = await devbuy(owner, slug, 'transaction');
    assert.equal(tx2.status, 200, tx2.text);
    assert.notEqual(tx2.json.attemptId, tx.json.attemptId);
    // signed by the author alone -> submitted -> confirmed -> verified -> done
    const sig = owner.w.signText(mockSigningText(tx2.json.messageHash));
    const sent = await devbuy(owner, slug, 'signed', { signed: sig });
    assert.equal(sent.status, 200, sent.text);
    assert.equal((await devbuy(owner, slug, 'signed', { signed: sig })).status, 409, 'not twice');
    assert.equal(h.db.get('SELECT dev_buy_status s FROM launches').s, 'submitted');
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    view = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([view.status, view.devBuy.status, view.devBuy.attempt.status], ['launched', 'done', 'done']);
    assert.ok(view.devBuy.attempt.verification.every((c) => c.ok), JSON.stringify(view.devBuy.attempt.verification));
    assert.match(view.statusNote, /MOCK dev buy: 0.01 SOL, in your wallet/);
    assert.equal((await devbuy(owner, slug, 'transaction')).json.error, 'bad_state', 'done: nothing more to buy');
    assert.equal((await devbuy(owner, slug, 'skip')).status, 409);
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM dev_buy_attempts WHERE status = 'done'`).n, 1);
    // the public view never shows the attempt
    const anon = h.client(user(h.db));
    assert.equal((await anon.call('GET', `/api/projects/${slug}`)).json.devBuy, undefined);
    assert.ok(ideaId);
  } finally { h.close(); }
});

test('dev buy step 2: fails on-chain (price moved) -> try again or skip; a preflight rejection; skip is final; a launch without a buy has no step 2', async () => {
  const h = await harness({ LAUNCH_SPLIT_TX: '0' });
  try {
    const { owner, ideaId, slug } = await launchedWithBuy(h, 0.02);
    // the network rejects it on-chain: failed, the launch stays launched, the author may try again
    setSetting(h.db, 'mock.behaviour', 'reject_on_chain', 'test');
    let tx = await devbuy(owner, slug, 'transaction');
    assert.equal((await devbuy(owner, slug, 'signed', { signed: owner.w.signText(mockSigningText(tx.json.messageHash)) })).status, 200);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    let view = (await owner.call('GET', `/api/projects/${slug}`)).json;
    assert.deepEqual([view.status, view.devBuy.status, view.devBuy.attempt.status], ['launched', 'failed', 'failed']);
    assert.match(view.statusNote, /dev buy failed on-chain.*nothing was bought but the network fee. Try again, or skip it/);
    // try again: a preflight rejection this time (never forwarded)
    setSetting(h.db, 'mock.behaviour', 'preflight_reject', 'test');
    tx = await devbuy(owner, slug, 'transaction');
    assert.equal(tx.status, 200, tx.text);
    const rej = await devbuy(owner, slug, 'signed', { signed: owner.w.signText(mockSigningText(tx.json.messageHash)) });
    assert.deepEqual([rej.status, rej.json.error], [400, 'rejected']);
    assert.match(rej.json.message, /rejected the dev buy before it ran/);
    assert.equal(h.db.get('SELECT dev_buy_status s FROM launches').s, 'failed');
    // skip: final, a waiting transaction is cancelled with it
    setSetting(h.db, 'mock.behaviour', 'ok', 'test');
    tx = await devbuy(owner, slug, 'transaction');
    const skip = await devbuy(owner, slug, 'skip');
    assert.deepEqual([skip.status, skip.json.status], [200, 'skipped']);
    assert.equal(h.db.get(`SELECT status FROM dev_buy_attempts WHERE id = ?`, tx.json.attemptId).status, 'cancelled');
    assert.equal((await devbuy(owner, slug, 'transaction')).json.error, 'bad_state');
    assert.match(ideaStatus(h.db, ideaId).status_note, /dev buy skipped by the author; nothing was bought/);
    assert.equal(ideaStatus(h.db, ideaId).status, 'launched');
    // a launch with no buy has no step 2
    const h2 = await harness();
    try {
      const { owner: o2, slug: s2 } = await toLaunchPrepared(h2);
      const { res } = await signAndSubmit(h2, o2, s2);
      assert.equal(res.status, 200);
      await later(5000, () => drain(h2.db, h2.cfg, h2.brain.fetchImpl));
      assert.equal((await devbuy(o2, s2, 'transaction')).json.error, 'no_dev_buy');
      assert.equal((await o2.call('GET', `/api/projects/${s2}`)).json.devBuy, null);
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('dev buy step 2: tx1\'s funds check counts the buy that follows; an open earlier tx2 must expire first; a landed one is verified instead; the sweep re-queues', async () => {
  const h = await harness({ LAUNCH_SPLIT_TX: '0' });
  try {
    const { owner, slug } = await toLaunchPrepared(h);
    assert.equal((await owner.call('PUT', `/api/projects/${slug}/launch/options`, { initialBuySol: 0.01 })).status, 200);
    await drain(h.db, h.cfg, h.brain.fetchImpl);
    const mock = getProvider(h.cfg, h.db), fake = { ...mock };
    setProviderForTests(h.db, fake, h.cfg);
    // tx1 costs 0.015 SOL, the buy after it 0.01: a 0.02 SOL wallet cannot do both
    fake.prepare = async (c, o) => { const b = await mock.prepare(c, o); return { ...b, estimate: { ...b.estimate, networkFeeLamports: 10_000, accountsLamports: 15_000_000, signerBalanceLamports: 20_000_000 } }; };
    const poor = await owner.call('POST', `/api/projects/${slug}/launch/transaction`, {});
    assert.deepEqual([poor.status, poor.json.error], [409, 'insufficient_funds']);
    assert.match(poor.json.message, /the dev buy of 0.01 SOL plus 0.01501 SOL of rent and fees needs 0.02501 SOL/);
    fake.prepare = mock.prepare;
    const { res } = await signAndSubmit(h, owner, slug);
    assert.equal(res.status, 200);
    await later(5000, () => drain(h.db, h.cfg, h.brain.fetchImpl));
    // an abandoned tx2 whose window is still open blocks a new one; one that landed after all is verified instead
    const first = await devbuy(owner, slug, 'transaction');
    assert.equal((await devbuy(owner, slug, 'abandon')).status, 200);
    fake.devBuyLandCheck = async () => ({ state: 'open', blocksLeft: 100 });
    const wait = await devbuy(owner, slug, 'transaction');
    assert.deepEqual([wait.status, wait.json.error], [409, 'previous_open']);
    assert.match(wait.json.message, /could still land for about 40 more seconds/);
    fake.devBuyLandCheck = async () => ({ state: 'landed', signature: 'MOCKlanded' });
    const landed = await devbuy(owner, slug, 'transaction');
    assert.deepEqual([landed.status, landed.json.error], [409, 'previous_landed']);
    assert.deepEqual({ ...h.db.get('SELECT status, tx_signature FROM dev_buy_attempts WHERE id = ?', first.json.attemptId) }, { status: 'submitted', tx_signature: 'MOCKlanded' });
    assert.equal(h.db.get('SELECT dev_buy_status s FROM launches').s, 'submitted');
    // its confirm job gave up: the sweep queues a new one
    h.db.run(`UPDATE jobs SET status = 'dead' WHERE type = 'confirm_dev_buy'`);
    assert.equal(sweepSubmitted(h.db), 1);
    assert.equal(h.db.get(`SELECT COUNT(*) n FROM jobs WHERE type = 'confirm_dev_buy' AND status = 'queued'`).n, 1);
  } finally { h.close(); }
});
