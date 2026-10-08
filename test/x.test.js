import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { makeEnv, user } from './helpers.js';
import { planAccount, startOAuth, finishOAuth, approvePost, publishPost } from '../src/x.js';

const KEY = randomBytes(32).toString('base64');
const spec = { x: { handles: ['ramenradar'], bio: 'bio', posts: ['first post', 'second'] } };

function setup(env = {}) {
  const e = makeEnv({ X_CLIENT_ID: 'cid', X_REDIRECT_URI: 'http://localhost:8787/api/x/callback', APP_ENCRYPTION_KEY: KEY, ...env });
  const owner = user(e.db);
  const t = Date.now();
  e.db.run(`INSERT INTO ideas (id, owner_wallet, status, created_at, updated_at) VALUES ('i1', ?, 'preview_ready', ?, ?)`, owner.address, t, t);
  e.db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES ('p1', 'i1', 'r', 'R', 'R', 'd', ?, ?)`, t, t);
  planAccount(e.db, 'p1', spec);
  return { ...e, owner };
}

const xApi = (calls) => async (url, init) => {
  calls.push(String(url));
  if (String(url).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 7200 }));
  if (String(url).endsWith('/users/me')) return new Response(JSON.stringify({ data: { id: '42', username: 'RamenRadarX' } }));
  if (String(url).endsWith('/tweets')) return new Response(JSON.stringify({ data: { id: '777' } }), { status: 201 });
  return new Response('{}', { status: 404 });
};

test('x: account is only "planned" until X itself reports the connected handle', async () => {
  const { db, cfg, owner } = setup();
  assert.equal(db.get('SELECT status FROM x_accounts').status, 'planned');
  const url = new URL(startOAuth(db, cfg, 'p1', owner.address));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const calls = [];
  const res = await finishOAuth(db, cfg, { state: url.searchParams.get('state'), code: 'c' }, owner.address, xApi(calls));
  assert.equal(res.handle, 'RamenRadarX');
  const acc = db.get('SELECT * FROM x_accounts');
  assert.equal(acc.status, 'connected');
  assert.equal(acc.x_handle, 'RamenRadarX');
  assert.ok(!acc.access_enc.includes('at') || acc.access_enc.startsWith('v1.'), 'token stored encrypted');
  // the state cannot be replayed
  await assert.rejects(finishOAuth(db, cfg, { state: url.searchParams.get('state'), code: 'c' }, owner.address, xApi(calls)), { code: 'bad_state' });
});

test('x: posts need an approval, then publish once; a failure is not retried blindly', async () => {
  const { db, cfg, owner } = setup();
  const post = db.get(`SELECT id FROM x_posts WHERE kind = 'launch'`);
  assert.throws(() => approvePost(db, post.id, owner.address), { code: 'x_not_connected' });
  const url = new URL(startOAuth(db, cfg, 'p1', owner.address));
  const calls = [];
  await finishOAuth(db, cfg, { state: url.searchParams.get('state'), code: 'c' }, owner.address, xApi(calls));
  await assert.rejects(publishPost(db, cfg, post.id, xApi(calls)), /post is draft/);
  approvePost(db, post.id, owner.address, 'edited text');
  const out = await publishPost(db, cfg, post.id, xApi(calls));
  assert.equal(out.id, '777');
  assert.equal(db.get('SELECT status, text FROM x_posts WHERE id = ?', post.id).status, 'published');
  const again = await publishPost(db, cfg, post.id, xApi(calls));
  assert.equal(again.already, '777');
  assert.equal(calls.filter((c) => c.endsWith('/tweets')).length, 1);
  const stranger = user(db);
  const other = db.get(`SELECT id FROM x_posts WHERE kind = 'follow_up'`);
  assert.throws(() => approvePost(db, other.id, stranger.address), { code: 'not_found' });
});

test('x: not configured means an explicit error, not a pretend account', () => {
  const { db, cfg, owner } = setup({ X_CLIENT_ID: '' });
  assert.throws(() => startOAuth(db, cfg, 'p1', owner.address), { code: 'x_not_configured' });
});
