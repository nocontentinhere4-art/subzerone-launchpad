// X (Twitter) integration through X's official OAuth 2.0 (authorization code + PKCE) and the v2 API.
// No passwords, no cookies, no automated sign-up: the submitter creates the account by hand (X does not offer
// account creation through its API), then connects it here. The handle we show is the one X reports after OAuth.
// Posts are drafts until a human approves them; publishing is a job that can be paused.
import { createHash, randomBytes } from 'node:crypto';
import { audit, isPaused } from './db.js';
import { encrypt, decrypt, now, HttpError, id } from './util.js';
import { enqueue, Permanent } from './jobs.js';

const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API = 'https://api.x.com/2';
const SCOPES = 'tweet.read tweet.write users.read offline.access';

export const xConfigured = (cfg) => Boolean(cfg.x.clientId && cfg.x.redirectUri && cfg.encryptionKey);

export function planAccount(db, projectId, spec) {
  db.run(`INSERT INTO x_accounts (project_id, planned_handle, planned_bio, status) VALUES (?, ?, ?, 'planned')
          ON CONFLICT(project_id) DO UPDATE SET planned_handle = excluded.planned_handle, planned_bio = excluded.planned_bio
          WHERE x_accounts.status = 'planned'`, projectId, spec.x.handles[0], spec.x.bio);
  const existing = db.get(`SELECT COUNT(*) n FROM x_posts WHERE project_id = ?`, projectId).n;
  if (!existing) {
    spec.x.posts.forEach((text, i) => db.run(`INSERT INTO x_posts (id, project_id, kind, text, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)`,
      id('xpost'), projectId, i === 0 ? 'launch' : 'follow_up', text, now()));
  }
}

/** The copy was rewritten (rewrite.js): the planned bio follows, and the drafts take the new posts in order. Posts
 * already approved, publishing or published are never touched; drafts beyond the new count are dropped (never posted). */
export function replanDrafts(db, projectId, spec) {
  planAccount(db, projectId, spec);
  db.run('UPDATE x_accounts SET planned_bio = ? WHERE project_id = ?', spec.x.bio, projectId);
  const drafts = db.all(`SELECT id FROM x_posts WHERE project_id = ? AND status = 'draft' ORDER BY created_at, rowid`, projectId);
  const sent = db.get(`SELECT COUNT(*) n FROM x_posts WHERE project_id = ? AND status != 'draft'`, projectId).n;
  const t = now();
  spec.x.posts.forEach((text, i) => {
    if (drafts[i]) db.run(`UPDATE x_posts SET text = ?, error = NULL WHERE id = ? AND status = 'draft'`, text, drafts[i].id);
    else db.run(`INSERT INTO x_posts (id, project_id, kind, text, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)`,
      id('xpost'), projectId, i === 0 && !sent ? 'launch' : 'follow_up', text, t + i);
  });
  for (const d of drafts.slice(spec.x.posts.length)) db.run(`DELETE FROM x_posts WHERE id = ? AND status = 'draft'`, d.id);
}

export function startOAuth(db, cfg, projectId, wallet) {
  if (!xConfigured(cfg)) throw new HttpError(503, 'x_not_configured', 'X integration needs X_CLIENT_ID, X_REDIRECT_URI and APP_ENCRYPTION_KEY');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(18).toString('base64url');
  db.run(`INSERT INTO oauth_states (state, project_id, wallet, verifier_enc, expires_at) VALUES (?, ?, ?, ?, ?)`,
    state, projectId, wallet, encrypt(cfg.encryptionKey, verifier), now() + 10 * 60_000);
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({ response_type: 'code', client_id: cfg.x.clientId, redirect_uri: cfg.x.redirectUri,
    scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return u.toString();
}

function basicAuth(cfg) {
  return cfg.x.clientSecret ? { authorization: `Basic ${Buffer.from(`${cfg.x.clientId}:${cfg.x.clientSecret}`).toString('base64')}` } : {};
}

export async function finishOAuth(db, cfg, { state, code }, wallet, fetchImpl = fetch) {
  const row = db.get('SELECT * FROM oauth_states WHERE state = ?', String(state || ''));
  if (!row || row.used_at || row.expires_at < now() || row.wallet !== wallet) throw new HttpError(400, 'bad_state', 'X sign-in expired or not yours; start again');
  db.run('UPDATE oauth_states SET used_at = ? WHERE state = ?', now(), row.state);
  const verifier = decrypt(cfg.encryptionKey, row.verifier_enc).toString();
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...basicAuth(cfg) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code || ''), redirect_uri: cfg.x.redirectUri,
      code_verifier: verifier, client_id: cfg.x.clientId }) });
  if (!res.ok) throw new HttpError(502, 'x_token_failed', `X refused the authorization (${res.status})`);
  const tok = await res.json();
  const me = await (await fetchImpl(`${API}/users/me`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  if (!me?.data?.id) throw new HttpError(502, 'x_me_failed', 'could not read the connected X account');
  db.run(`UPDATE x_accounts SET status = 'connected', x_user_id = ?, x_handle = ?, access_enc = ?, refresh_enc = ?, expires_at = ?,
          connected_at = ?, connected_by = ? WHERE project_id = ?`, me.data.id, me.data.username,
  encrypt(cfg.encryptionKey, tok.access_token), tok.refresh_token ? encrypt(cfg.encryptionKey, tok.refresh_token) : null,
  now() + (tok.expires_in || 7200) * 1000, now(), wallet, row.project_id);
  audit(db, { actor: `wallet:${wallet}`, kind: 'x', projectId: row.project_id, isPublic: true, message: `X account @${me.data.username} connected (reported by X)` });
  return { projectId: row.project_id, handle: me.data.username };
}

async function accessToken(db, cfg, acc, fetchImpl) {
  if (acc.expires_at > now() + 60_000) return decrypt(cfg.encryptionKey, acc.access_enc).toString();
  if (!acc.refresh_enc) throw new Permanent('X token expired; reconnect the account');
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...basicAuth(cfg) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decrypt(cfg.encryptionKey, acc.refresh_enc).toString(), client_id: cfg.x.clientId }) });
  if (!res.ok) throw new Permanent(`X token refresh failed (${res.status}); reconnect the account`);
  const tok = await res.json();
  db.run('UPDATE x_accounts SET access_enc = ?, refresh_enc = ?, expires_at = ? WHERE project_id = ?',
    encrypt(cfg.encryptionKey, tok.access_token), tok.refresh_token ? encrypt(cfg.encryptionKey, tok.refresh_token) : acc.refresh_enc,
    now() + (tok.expires_in || 7200) * 1000, acc.project_id);
  return tok.access_token;
}

export function approvePost(db, postId, wallet, text) {
  const p = db.get('SELECT p.*, i.owner_wallet FROM x_posts p JOIN projects pr ON pr.id = p.project_id JOIN ideas i ON i.id = pr.idea_id WHERE p.id = ?', postId);
  if (!p || p.owner_wallet !== wallet) throw new HttpError(404, 'not_found');
  if (!['draft', 'failed'].includes(p.status)) throw new HttpError(409, 'bad_state');
  const body = String(text ?? p.text).trim();
  if (!body || body.length > 280) throw new HttpError(400, 'bad_text', '1–280 characters');
  const acc = db.get("SELECT * FROM x_accounts WHERE project_id = ? AND status = 'connected'", p.project_id);
  if (!acc) throw new HttpError(409, 'x_not_connected', 'connect the X account first');
  db.run(`UPDATE x_posts SET text = ?, status = 'approved', approved_by = ?, approved_at = ?, error = NULL WHERE id = ?`, body, wallet, now(), postId);
  audit(db, { actor: `wallet:${wallet}`, kind: 'x', projectId: p.project_id, message: 'X post approved for publishing' });
  enqueue(db, { type: 'publish_x_post', key: `xpost:${postId}:${now()}`, projectId: p.project_id, payload: { postId } });
}

export async function publishPost(db, cfg, postId, fetchImpl = fetch) {
  if (isPaused(db, 'x_publishing')) throw new Permanent('X publishing is paused');
  const claimed = db.run(`UPDATE x_posts SET status = 'publishing' WHERE id = ? AND status = 'approved'`, postId);
  const p = db.get('SELECT * FROM x_posts WHERE id = ?', postId);
  if (p.status === 'published') return { already: p.x_post_id };
  if (claimed.changes !== 1) throw new Permanent(`post is ${p.status}`);
  const acc = db.get("SELECT * FROM x_accounts WHERE project_id = ? AND status = 'connected'", p.project_id);
  try {
    if (!acc) throw new Permanent('X account not connected');
    const tokenValue = await accessToken(db, cfg, acc, fetchImpl);
    const res = await fetchImpl(`${API}/tweets`, { method: 'POST', headers: { authorization: `Bearer ${tokenValue}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: p.text }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.data?.id) throw new Error(`X API ${res.status}${j?.title ? `: ${j.title}` : ''}`);
    db.run(`UPDATE x_posts SET status = 'published', x_post_id = ?, published_at = ? WHERE id = ?`, j.data.id, now(), postId);
    audit(db, { actor: 'system', kind: 'x', projectId: p.project_id, isPublic: true, message: `Posted on X (${j.data.id})` });
    return { id: j.data.id };
  } catch (e) {
    // never retried blindly: a post that may have gone out must not be sent twice; the human approves again
    db.run(`UPDATE x_posts SET status = 'failed', error = ? WHERE id = ?`, String(e.message).slice(0, 200), postId);
    throw new Permanent(e.message);
  }
}
