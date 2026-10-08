// The launchpad web application: JSON API, the single-page front end, generated project sites (by Host) and token
// metadata. createApp() returns a node:http request handler; server.js listens.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { ROOT, SUB01 } from './config.js';
import { router, parseCookies, readJson, clientIp, rateLimiter, securityHeaders, APP_CSP, sendJson, sendError } from './http.js';
import { issueNonce, verifySignIn, sessionUser, signOut } from './auth.js';
import { submitIdea, editIdea, publishIdea, viewIdea, readUpload, currentVersion, LIMITS } from './ideas.js';
import { transition, LABELS, STAGES } from './states.js';
import { audit, getSetting, setSetting, PAUSES, isPaused, backup } from './db.js';
import { enqueue, retryDead, cancelJobs } from './jobs.js';
import { buildSiteVersion, setLiveVersion, SITE_CSP } from './site.js';
import { validateSpec } from './generator.js';
import { getProvider, validateRecipients, draftAllocation, allocationStatement, feeMode, createIntent, submitSigned,
  abandonIntent, feeLedger, MAX_RECIPIENTS } from './launch.js';
import { mockSigningText } from './launch/mock.js';
import { startOAuth, finishOAuth, approvePost, xConfigured } from './x.js';
import { sub01Market } from './market.js';
import { brainStatus } from './brain.js';
import { limits, spentToday } from './budget.js';
import { HttpError, parseJson, now, token, isSolanaAddress } from './util.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { log } from './log.js';

const PUBLIC = join(ROOT, 'public');
const PAGES = [/^\/$/, /^\/submit$/, /^\/ideas\/[^/]+$/, /^\/projects\/[^/]+(\/review)?$/, /^\/token$/, /^\/me$/, /^\/admin$/, /^\/fees$/, /^\/how$/];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const COOKIE = 'lp_session';
const ACTIVE = ['submitted', 'evaluating', 'selected', 'generating', 'preview_ready', 'approved', 'launch_prepared', 'awaiting_signature', 'confirming'];

export function createApp({ cfg, db, fetchImpl = fetch }) {
  const r = router();
  const limit = rateLimiter();
  const origin = new URL(cfg.publicOrigin);
  const roomOrigin = new URL(cfg.brain.publicRoomUrl).origin;
  const projectsHost = cfg.projectsHost.toLowerCase();
  const secureCookie = origin.protocol === 'https:';

  const requireUser = (ctx) => { if (!ctx.user) throw new HttpError(401, 'sign_in', 'connect and sign in with your wallet'); return ctx.user; };
  const requireAdmin = (ctx, roles = ['admin']) => {
    const u = requireUser(ctx);
    if (!roles.includes(u.role)) throw new HttpError(403, 'forbidden');
    return u;
  };
  const isStaff = (u) => u && (u.role === 'admin' || u.role === 'reviewer');
  const projectBySlug = (slug) => db.get('SELECT * FROM projects WHERE slug = ?', slug);
  const ownedProject = (ctx, slug) => {
    const u = requireUser(ctx);
    const p = projectBySlug(slug);
    if (!p) throw new HttpError(404, 'not_found');
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', p.idea_id);
    if (idea.owner_wallet !== u.wallet) throw new HttpError(404, 'not_found');
    return { p, idea, u };
  };
  const visibleProject = (ctx, slug) => {
    const p = projectBySlug(slug);
    if (!p) return null;
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', p.idea_id);
    const owner = ctx.user?.wallet === idea.owner_wallet;
    if (idea.visibility !== 'public' && !owner && !isStaff(ctx.user)) return null;
    return { p, idea, owner };
  };

  // --- public config & health --------------------------------------------------------------------------------------
  r.get('/healthz', () => ({ ok: true }));
  r.get('/api/config', async () => {
    const provider = getProvider(cfg, db);
    return {
      sub01: SUB01, deployEnv: cfg.deployEnv, roomUrl: cfg.brain.publicRoomUrl,
      launch: provider ? { provider: provider.name, network: provider.network, label: provider.label, mock: provider.isMock } : { provider: 'none', label: 'launching disabled' },
      generator: cfg.generator.provider === 'anthropic' ? `language model (${cfg.generator.anthropicModel})` : 'fixed template (no AI)',
      brainConfigured: Boolean(cfg.brain.url && cfg.brain.secret), xConfigured: xConfigured(cfg),
      pauses: Object.fromEntries(PAUSES.map((p) => [p, isPaused(db, p)])),
      platformShare: getSetting(db, 'allocation.platform', null), maxRecipients: MAX_RECIPIENTS, limits: LIMITS,
      stages: STAGES.map((s) => ({ id: s, label: LABELS[s] })), requireAdminClearance: cfg.launch.requireAdminClearance,
    };
  });
  r.get('/api/brain/status', async () => ({ ...(await brainStatus(cfg, fetchImpl)), configured: Boolean(cfg.brain.url && cfg.brain.secret), at: now() }));

  // --- auth -------------------------------------------------------------------------------------------------------
  r.post('/api/auth/nonce', async (ctx) => { limit('auth', ctx.ip); const b = await ctx.body(); return issueNonce(db, cfg, String(b.wallet || '')); });
  r.post('/api/auth/verify', async (ctx) => {
    limit('auth', ctx.ip);
    const b = await ctx.body();
    const value = verifySignIn(db, cfg, { wallet: String(b.wallet || ''), nonce: b.nonce, signature: b.signature });
    ctx.setCookie(`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.sessionDays * 86400}${secureCookie ? '; Secure' : ''}`);
    return { wallet: b.wallet };
  });
  r.post('/api/auth/logout', async (ctx) => {
    signOut(db, ctx.cookies[COOKIE]);
    ctx.setCookie(`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? '; Secure' : ''}`);
    return { ok: true };
  });
  r.get('/api/me', (ctx) => {
    if (!ctx.user) return { user: null };
    const ideas = db.all(`SELECT i.id, i.status, i.status_note, i.visibility, i.created_at, i.updated_at, v.title, p.slug, p.ticker, l.provider, l.network
      FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version LEFT JOIN projects p ON p.idea_id = i.id
      LEFT JOIN launches l ON l.project_id = p.id
      WHERE i.owner_wallet = ? ORDER BY i.created_at DESC`, ctx.user.wallet);
    const launched = db.all(`SELECT p.slug FROM projects p JOIN ideas i ON i.id = p.idea_id JOIN launches l ON l.project_id = p.id WHERE i.owner_wallet = ?`, ctx.user.wallet);
    return { user: ctx.user, ideas, fees: launched.map((x) => ({ slug: x.slug, ledger: feeLedger(db, projectBySlug(x.slug).id) })) };
  });

  // --- ideas ------------------------------------------------------------------------------------------------------
  r.get('/api/ideas', () => {
    const rows = db.all(`SELECT i.id, i.status, i.status_note, i.created_at, i.updated_at, v.title, substr(v.concept, 1, 220) concept,
        p.slug, p.name, p.ticker, l.network, l.provider
      FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
      LEFT JOIN projects p ON p.idea_id = i.id LEFT JOIN launches l ON l.project_id = p.id
      WHERE i.visibility = 'public' ORDER BY i.updated_at DESC LIMIT 100`);
    const hideMock = cfg.production;
    return {
      building: rows.filter((x) => ACTIVE.includes(x.status)),
      launched: rows.filter((x) => x.status === 'launched' && !(hideMock && x.provider === 'mock')),
      passed: rows.filter((x) => x.status === 'declined').slice(0, 12),
    };
  });
  r.post('/api/ideas', async (ctx) => {
    const u = requireUser(ctx);
    limit('submit', ctx.ip);
    const b = await ctx.body(7_000_000);
    const ideaId = submitIdea(db, cfg, u.wallet, b);
    log.info('idea submitted', { idea: ideaId });
    return { id: ideaId };
  }, { bodyLimit: 7_000_000 });
  r.get('/api/ideas/:id', (ctx) => {
    const v = viewIdea(db, ctx.params.id, ctx.user);
    if (!v) throw new HttpError(404, 'not_found', 'not found, or private');
    return v;
  });
  r.put('/api/ideas/:id', async (ctx) => { const u = requireUser(ctx); limit('write', u.wallet); return { version: editIdea(db, ctx.params.id, u.wallet, await ctx.body()) }; });
  r.post('/api/ideas/:id/publish', async (ctx) => { const u = requireUser(ctx); const b = await ctx.body(); publishIdea(db, ctx.params.id, u.wallet, b.public === true); return { ok: true }; });
  r.post('/api/ideas/:id/cancel', async (ctx) => {
    const u = requireUser(ctx);
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', ctx.params.id);
    if (!idea || idea.owner_wallet !== u.wallet) throw new HttpError(404, 'not_found');
    if (['awaiting_signature', 'confirming'].includes(idea.status)) throw new HttpError(409, 'in_flight', 'a transaction may be in flight; abandon the signature request first');
    db.tx(() => { transition(db, idea.id, idea.status, 'cancelled', { actor: `wallet:${u.wallet}`, note: 'cancelled by the submitter' }); cancelJobs(db, { ideaId: idea.id }); });
    return { ok: true };
  });
  r.get('/api/uploads/:id', (ctx) => {
    const f = readUpload(db, cfg, ctx.params.id, ctx.user);
    if (!f) throw new HttpError(404, 'not_found');
    return ctx.raw(200, f.body, { 'content-type': f.mime, 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline', 'cache-control': 'private, max-age=3600' });
  });

  // --- projects ---------------------------------------------------------------------------------------------------
  r.get('/api/projects/:slug', (ctx) => {
    const v = visibleProject(ctx, ctx.params.slug);
    if (!v) throw new HttpError(404, 'not_found', 'not found, or private');
    const { p, idea, owner } = v;
    const staff = isStaff(ctx.user);
    const versions = db.all('SELECT version, build_status, build_report, created_by, created_at, sha256 FROM site_versions WHERE project_id = ? ORDER BY version DESC', p.id);
    const live = db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p.id, p.live_site_version);
    const alloc = db.get(`SELECT * FROM fee_allocations WHERE project_id = ? AND status IN ('draft','approved','locked') ORDER BY version DESC LIMIT 1`, p.id);
    const recipients = alloc ? parseJson(alloc.recipients_json) : [];
    const mode = feeMode(recipients, idea.owner_wallet);
    const xa = db.get('SELECT planned_handle, planned_bio, status, x_handle, connected_at FROM x_accounts WHERE project_id = ?', p.id);
    const posts = (owner || staff) ? db.all('SELECT id, kind, text, status, x_post_id, error, approved_at, published_at FROM x_posts WHERE project_id = ? ORDER BY created_at', p.id) : undefined;
    const launch = db.get('SELECT * FROM launches WHERE project_id = ?', p.id);
    const intent = (owner || staff) ? db.get(`SELECT id, status, mint, tx_signature, error, provider, network, created_at, updated_at, last_valid_block_height
      FROM launch_intents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`, p.id) : undefined;
    const provider = getProvider(cfg, db);
    const gen = db.get('SELECT generator, cost_usd, created_at FROM generations WHERE project_id = ? ORDER BY version DESC LIMIT 1', p.id);
    const evaluation = db.get(`SELECT brain_json, scores_json FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, idea.id);
    const v1 = currentVersion(db, idea.id);
    return {
      id: p.id, slug: p.slug, name: p.name, ticker: p.ticker, description: p.description, ideaId: idea.id, ideaTitle: v1.title,
      status: idea.status, statusNote: idea.status_note, visibility: idea.visibility, owner, staff,
      submittedBy: idea.owner_wallet, receivingWallet: v1.receiving_wallet,
      siteUrl: idea.visibility === 'public' ? `${cfg.projectsScheme}://${p.slug}.${cfg.projectsHost}/` : null,
      liveSiteVersion: p.live_site_version, spec: live ? parseJson(live.spec_json) : null, versions: (owner || staff) ? versions : versions.filter((x) => x.build_status === 'ok').map(({ version, created_at }) => ({ version, created_at })),
      generator: gen?.generator, brain: evaluation ? parseJson(evaluation.brain_json) : null, scores: evaluation ? parseJson(evaluation.scores_json) : null,
      submitterApprovedAt: p.submitter_approved_at, adminClearedAt: p.admin_cleared_at, requireAdminClearance: cfg.launch.requireAdminClearance,
      allocation: alloc && { id: alloc.id, version: alloc.version, status: alloc.status, recipients, mode,
        statement: allocationStatement(recipients, mode), approvedAt: alloc.approved_at },
      x: xa && { ...xa, posts }, xConfigured: xConfigured(cfg),
      launchConfig: parseJson(p.launch_config_json), launch: launch && { ...launch, verification: parseJson(launch.verification),
        explorerTx: provider?.explorerTx?.(launch.tx_signature) ?? null, explorerToken: provider?.explorerToken?.(launch.mint) ?? null },
      intent, mockSigningText: intent && provider?.isMock ? mockSigningText(db.get('SELECT tx_message_hash h FROM launch_intents WHERE id = ?', intent.id).h) : undefined,
      ledger: launch ? feeLedger(db, p.id) : null,
    };
  });

  r.put('/api/projects/:slug/site', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    if (!['preview_ready'].includes(idea.status)) throw new HttpError(409, 'locked', 'the site can be edited while the preview is open');
    const b = await ctx.body();
    const cur = parseJson(db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p.id, p.live_site_version).spec_json);
    const pick = (k, max) => (typeof b[k] === 'string' ? b[k].replace(/[<>`]/g, '').trim().slice(0, max) : cur[k]);
    const spec = { ...cur, name: pick('name', 32), ticker: (pick('ticker', 10) || '').toUpperCase(), tagline: pick('tagline', 90), description: pick('description', 500) };
    if (Array.isArray(b.sections)) spec.sections = b.sections.slice(0, 5).map((s) => ({ heading: String(s.heading || '').replace(/[<>`]/g, '').slice(0, 60), body: String(s.body || '').replace(/[<>`]/g, '').slice(0, 700) }));
    try { validateSpec(spec); } catch (e) { throw new HttpError(400, 'invalid', e.message.replace('generated spec invalid: ', '')); }
    const site = await buildSiteVersion(db, cfg, p, spec, `wallet:${u.wallet}`);
    setLiveVersion(db, p, site.version, `wallet:${u.wallet}`);
    db.run('UPDATE projects SET name = ?, ticker = ?, description = ?, submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL, updated_at = ? WHERE id = ?', spec.name, spec.ticker, spec.description, now(), p.id);
    return { version: site.version };
  });
  r.post('/api/projects/:slug/site/live', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    if (!['preview_ready', 'launched'].includes(idea.status)) throw new HttpError(409, 'locked', 'the live version can change while the preview is open, or after launch');
    const b = await ctx.body();
    setLiveVersion(db, p, Number(b.version), `wallet:${u.wallet}`);
    const spec = parseJson(db.get('SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?', p.id, Number(b.version)).spec_json);
    if (!db.get('SELECT 1 FROM launches WHERE project_id = ?', p.id)) {
      db.run('UPDATE projects SET name = ?, ticker = ?, description = ?, submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL WHERE id = ?', spec.name, spec.ticker, spec.description, p.id);
    }
    return { ok: true };
  });
  // previews: same origin, served with CSP "sandbox" (opaque origin, no scripts). The sandboxed page cannot send the
  // session cookie, so its address carries a short-lived signed capability instead (issued to viewers who may see it).
  const previewKey = randomBytes(32);
  const previewToken = (slug, version, exp) => `${version}.${exp}.${createHmac('sha256', previewKey).update(`${slug}:${version}:${exp}`).digest('base64url').slice(0, 32)}`;
  r.get('/api/projects/:slug/preview-link', (ctx) => {
    const v = visibleProject(ctx, ctx.params.slug);
    if (!v) throw new HttpError(404, 'not_found');
    const asked = Number(ctx.query.get('version')) || v.p.live_site_version;
    const version = v.owner || isStaff(ctx.user) ? asked : v.p.live_site_version;     // drafts stay with the owner
    return { url: `/preview/${v.p.slug}/${previewToken(v.p.slug, version, Date.now() + 3_600_000)}/index.html` };
  });
  r.get('/preview/:slug/:token/:file', (ctx) => {
    const [version, exp, mac] = String(ctx.params.token).split('.');
    const good = previewToken(ctx.params.slug, Number(version), Number(exp));
    const given = Buffer.from(String(ctx.params.token));
    if (!mac || Number(exp) < Date.now() || given.length !== Buffer.byteLength(good) || !timingSafeEqual(Buffer.from(good), given)) {
      throw new HttpError(404, 'not_found');
    }
    const p = projectBySlug(ctx.params.slug);
    if (!p) throw new HttpError(404, 'not_found');
    return serveSiteFile(ctx, p, Number(version), ctx.params.file, true);
  });
  r.put('/api/projects/:slug/allocation', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    if (!['preview_ready'].includes(idea.status)) throw new HttpError(409, 'locked', 'the split can change only while the preview is open');
    const b = await ctx.body();
    const v = currentVersion(db, idea.id);
    const recipients = validateRecipients(db, b.recipients, v.receiving_wallet);
    db.tx(() => { draftAllocation(db, p.id, recipients, `wallet:${u.wallet}`); db.run('UPDATE projects SET submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL WHERE id = ?', p.id); });
    return { ok: true };
  });
  r.post('/api/projects/:slug/approve', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    if (idea.status !== 'preview_ready') throw new HttpError(409, 'bad_state', `idea is ${idea.status}`);
    const b = await ctx.body();
    const alloc = db.get(`SELECT * FROM fee_allocations WHERE project_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1`, p.id);
    if (!alloc || alloc.id !== b.allocationId) throw new HttpError(409, 'allocation_changed', 'the split changed; review it again');
    const recipients = parseJson(alloc.recipients_json);
    validateRecipients(db, recipients, currentVersion(db, idea.id).receiving_wallet);
    const statement = allocationStatement(recipients, feeMode(recipients, idea.owner_wallet));
    if (b.statement !== statement || b.siteVersion !== p.live_site_version) throw new HttpError(409, 'changed', 'what you reviewed changed; review it again');
    if (idea.visibility !== 'public') throw new HttpError(409, 'private', 'make the idea public first: a launched token is public');
    db.tx(() => {
      db.run(`UPDATE fee_allocations SET status = 'approved', approved_by = ?, approved_at = ?, approval_statement = ? WHERE id = ?`, u.wallet, now(), statement, alloc.id);
      db.run('UPDATE projects SET submitter_approved_at = ? WHERE id = ?', now(), p.id);
      audit(db, { actor: `wallet:${u.wallet}`, kind: 'approval', ideaId: idea.id, projectId: p.id, isPublic: true,
        message: `Submitter approved site v${p.live_site_version} and fee split v${alloc.version}`, data: { recipients } });
      maybeApprove(p.id);
    });
    return { ok: true };
  });
  r.post('/api/projects/:slug/back-to-preview', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    db.tx(() => {
      transition(db, idea.id, ['approved', 'launch_prepared'], 'preview_ready', { actor: `wallet:${u.wallet}`, note: 'reopened for edits by the submitter' });
      db.run('UPDATE projects SET submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL, launch_config_json = NULL, launch_config_hash = NULL WHERE id = ?', p.id);
      db.run(`UPDATE fee_allocations SET status = 'draft' WHERE project_id = ? AND status = 'approved'`, p.id);
    });
    return { ok: true };
  });
  r.post('/api/projects/:slug/launch/transaction', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    return createIntent(db, cfg, p, u.wallet);
  });
  r.post('/api/projects/:slug/launch/signed', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    const b = await ctx.body(64_000);
    return submitSigned(db, cfg, p, u.wallet, String(b.signed || ''));
  });
  r.post('/api/projects/:slug/launch/abandon', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    const b = await ctx.body();
    abandonIntent(db, p, u.wallet, b.reason === 'rejected' ? 'the wallet rejected the signature request' : 'signature request cancelled');
    return { ok: true };
  });

  // --- X ------------------------------------------------------------------------------------------------------------
  r.get('/api/projects/:slug/x/connect', (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    return ctx.redirect(startOAuth(db, cfg, p.id, u.wallet));
  });
  r.get('/api/x/callback', async (ctx) => {
    const u = requireUser(ctx);
    const res = await finishOAuth(db, cfg, { state: ctx.query.get('state'), code: ctx.query.get('code') }, u.wallet, fetchImpl);
    const p = db.get('SELECT slug FROM projects WHERE id = ?', res.projectId);
    return ctx.redirect(`/projects/${p.slug}/review#x`);
  });
  r.put('/api/x-posts/:id', async (ctx) => {
    const u = requireUser(ctx);
    const b = await ctx.body();
    const post = db.get('SELECT p.*, i.owner_wallet FROM x_posts p JOIN projects pr ON pr.id = p.project_id JOIN ideas i ON i.id = pr.idea_id WHERE p.id = ?', ctx.params.id);
    if (!post || post.owner_wallet !== u.wallet) throw new HttpError(404, 'not_found');
    if (!['draft', 'failed'].includes(post.status)) throw new HttpError(409, 'bad_state');
    const text = String(b.text || '').trim();
    if (!text || text.length > 280) throw new HttpError(400, 'bad_text', '1–280 characters');
    db.run(`UPDATE x_posts SET text = ?, status = 'draft' WHERE id = ?`, text, post.id);
    return { ok: true };
  });
  r.post('/api/x-posts/:id/approve', async (ctx) => { const u = requireUser(ctx); const b = await ctx.body(); approvePost(db, ctx.params.id, u.wallet, b.text); return { ok: true }; });

  // --- ledger & SUB-01 token -----------------------------------------------------------------------------------------
  r.get('/api/ledger', () => {
    const rows = db.all(`SELECT p.id, p.slug, p.name, p.ticker, l.mint, l.network, l.provider, l.verified_at FROM launches l JOIN projects p ON p.id = l.project_id ORDER BY l.verified_at DESC`);
    return { projects: rows.filter((x) => !(cfg.production && x.provider === 'mock')).map((x) => ({ ...x, ledger: feeLedger(db, x.id) })), at: now() };
  });
  r.get('/api/token', async () => sub01Market(db, cfg, fetchImpl));

  // --- token metadata (frozen in the reviewed launch configuration) ---------------------------------------------------
  r.get('/meta/:slug/:file', (ctx) => {
    const p = projectBySlug(ctx.params.slug);
    if (!p) throw new HttpError(404, 'not_found');
    const f = ctx.params.file;
    const logo = f.match(/^logo-v(\d+)\.png$/);
    if (db.get('SELECT visibility FROM ideas WHERE id = ?', p.idea_id).visibility !== 'public') throw new HttpError(404, 'not_found');
    if (logo) {
      const a = db.get(`SELECT body FROM assets WHERE project_id = ? AND kind = 'logo' AND version = ?`, p.id, Number(logo[1]));
      if (!a) throw new HttpError(404, 'not_found');
      return ctx.raw(200, Buffer.from(a.body), { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
    }
    const m = f.match(/^([0-9a-f]{16})\.json$/);
    const configs = db.all('SELECT config_json FROM launch_intents WHERE project_id = ?', p.id).map((x) => parseJson(x.config_json));
    if (p.launch_config_json) configs.push(parseJson(p.launch_config_json));
    const hit = m && configs.find((c) => c?.token?.uri?.endsWith(`/${m[1]}.json`));
    if (!hit) throw new HttpError(404, 'not_found');
    return ctx.raw(200, Buffer.from(JSON.stringify(hit.token.metadata)), { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
  });

  // --- admin ----------------------------------------------------------------------------------------------------------
  r.get('/api/admin/overview', (ctx) => {
    requireAdmin(ctx, ['admin', 'reviewer']);
    const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM ideas GROUP BY status').map((x) => [x.status, x.n]));
    const jobs = db.all(`SELECT id, type, status, attempts, max_attempts, run_after, progress, last_error, idea_id, project_id, updated_at FROM jobs
      WHERE status IN ('queued','running','dead') ORDER BY CASE status WHEN 'dead' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, updated_at DESC LIMIT 100`);
    const clearance = db.all(`SELECT p.slug, p.name, p.ticker, i.id idea_id, i.status, p.submitter_approved_at, p.admin_cleared_at FROM projects p JOIN ideas i ON i.id = p.idea_id
      WHERE i.status IN ('preview_ready','approved') ORDER BY p.updated_at DESC`);
    const failed = db.all(`SELECT i.id, i.status_note, v.title FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version WHERE i.status = 'failed'`);
    const audits = db.all('SELECT at, actor, kind, message, idea_id, project_id FROM events ORDER BY id DESC LIMIT 80');
    const intents = db.all(`SELECT li.id, li.project_id, p.slug, li.status, li.mint, li.tx_signature, li.error, li.provider, li.network, li.updated_at
      FROM launch_intents li JOIN projects p ON p.id = li.project_id ORDER BY li.updated_at DESC LIMIT 30`);
    return { counts, jobs, clearance, failed, audits, intents, pauses: Object.fromEntries(PAUSES.map((p) => [p, isPaused(db, p)])),
      budget: { ...limits(db, cfg), spentToday: spentToday(db) }, platformShare: getSetting(db, 'allocation.platform', null),
      mockBehaviour: cfg.production ? undefined : getSetting(db, 'mock.behaviour', 'ok'), role: ctx.user.role,
      users: db.all("SELECT wallet, role, created_at, banned_at FROM users WHERE role != 'user' OR banned_at IS NOT NULL") };
  });
  r.post('/api/admin/pause', async (ctx) => {
    const u = requireAdmin(ctx);
    const b = await ctx.body();
    if (!PAUSES.includes(b.what)) throw new HttpError(400, 'bad_pause');
    setSetting(db, `pause.${b.what}`, b.paused === true, u.wallet);
    audit(db, { actor: `admin:${u.wallet}`, kind: 'admin', message: `${b.paused ? 'paused' : 'resumed'} ${b.what}` });
    return { ok: true };
  });
  r.post('/api/admin/budget', async (ctx) => {
    const u = requireAdmin(ctx);
    const b = await ctx.body();
    for (const k of ['globalDailyUsd', 'perProjectUsd']) {
      if (b[k] != null) { const v = Number(b[k]); if (!(v >= 0 && v < 10000)) throw new HttpError(400, 'bad_budget'); setSetting(db, `budget.${k}`, v, u.wallet); }
    }
    audit(db, { actor: `admin:${u.wallet}`, kind: 'admin', message: 'budget changed', data: b });
    return { ok: true };
  });
  r.post('/api/admin/platform-share', async (ctx) => {
    const u = requireAdmin(ctx);
    const b = await ctx.body();
    if (b.share === null) setSetting(db, 'allocation.platform', null, u.wallet);
    else {
      const bps = Number(b.share?.bps);
      if (!isSolanaAddress(b.share?.wallet) || !Number.isInteger(bps) || bps < 1 || bps > 5000) throw new HttpError(400, 'bad_share', 'wallet + 1–5000 bps');
      setSetting(db, 'allocation.platform', { wallet: b.share.wallet, bps, label: String(b.share.label || 'SUBZERONE platform').slice(0, 40) }, u.wallet);
    }
    audit(db, { actor: `admin:${u.wallet}`, kind: 'admin', isPublic: false, message: 'platform share changed (applies to new drafts only; disclosed publicly)', data: b.share });
    return { ok: true };
  });
  r.post('/api/admin/jobs/:id/retry', (ctx) => { const u = requireAdmin(ctx); if (!retryDead(db, ctx.params.id, `admin:${u.wallet}`)) throw new HttpError(409, 'not_dead'); return { ok: true }; });
  r.post('/api/admin/projects/:slug/clear', async (ctx) => {
    const u = requireAdmin(ctx, ['admin', 'reviewer']);
    const p = projectBySlug(ctx.params.slug);
    if (!p) throw new HttpError(404, 'not_found');
    const owner = db.get('SELECT owner_wallet, status FROM ideas WHERE id = ?', p.idea_id);
    if (owner.owner_wallet === u.wallet) throw new HttpError(403, 'own_project', 'a reviewer cannot clear their own project');
    if (owner.status !== 'preview_ready') throw new HttpError(409, 'bad_state', `idea is ${owner.status}`);
    db.tx(() => {
      db.run('UPDATE projects SET admin_cleared_at = ?, admin_cleared_by = ? WHERE id = ?', now(), u.wallet, p.id);
      audit(db, { actor: `admin:${u.wallet}`, kind: 'clearance', ideaId: p.idea_id, projectId: p.id, isPublic: true, message: 'Cleared for launch by a SUBZERONE reviewer' });
      maybeApprove(p.id);
    });
    return { ok: true };
  });
  r.post('/api/admin/ideas/:id/retry', (ctx) => {
    const u = requireAdmin(ctx);
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', ctx.params.id);
    if (!idea || idea.status !== 'failed') throw new HttpError(409, 'not_failed');
    const p = db.get('SELECT * FROM projects WHERE idea_id = ?', idea.id);
    const evaluated = db.get(`SELECT 1 FROM evaluations WHERE idea_id = ? AND decision = 'selected'`, idea.id);
    const t = now();
    db.tx(() => {
      if (!evaluated) {
        transition(db, idea.id, 'failed', 'evaluating', { actor: `admin:${u.wallet}`, note: 'retrying evaluation' });
        enqueue(db, { type: 'evaluate', key: `evaluate:${idea.id}:retry:${t}`, ideaId: idea.id });
      } else if (!p?.live_site_version) {
        transition(db, idea.id, 'failed', 'selected', { actor: `admin:${u.wallet}`, note: 'retrying the build' });
        enqueue(db, { type: 'generate', key: `generate:${idea.id}:retry:${t}`, ideaId: idea.id });
      } else {
        if (db.get(`SELECT 1 FROM launch_intents WHERE project_id = ? AND (error LIKE 'landed:%' OR status IN ('submitted','confirmed'))`, p.id)) {
          throw new HttpError(409, 'landed', 'a transaction for this project landed or may land; resolve it on-chain first');
        }
        transition(db, idea.id, 'failed', 'launch_prepared', { actor: `admin:${u.wallet}`, note: 'reopened for a new signature' });
      }
    });
    return { ok: true };
  });
  r.post('/api/admin/projects/:slug/reverify', (ctx) => {
    const u = requireAdmin(ctx);
    const p = projectBySlug(ctx.params.slug);
    if (!p) throw new HttpError(404, 'not_found');
    const intent = db.get(`SELECT * FROM launch_intents WHERE project_id = ? AND error LIKE 'landed:%' ORDER BY updated_at DESC LIMIT 1`, p.id);
    if (!intent) throw new HttpError(409, 'nothing_to_verify');
    db.tx(() => {
      db.run(`UPDATE launch_intents SET status = 'submitted', error = NULL, updated_at = ? WHERE id = ?`, now(), intent.id);
      transition(db, p.idea_id, 'failed', 'confirming', { actor: `admin:${u.wallet}`, note: 're-verifying the landed transaction on-chain' });
      enqueue(db, { type: 'confirm_launch', key: `confirm:${intent.id}:reverify:${now()}`, ideaId: p.idea_id, projectId: p.id, payload: { intentId: intent.id } });
    });
    return { ok: true };
  });
  r.post('/api/admin/ideas/:id/cancel', (ctx) => {
    const u = requireAdmin(ctx);
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', ctx.params.id);
    if (!idea) throw new HttpError(404, 'not_found');
    if (['awaiting_signature', 'confirming', 'launched'].includes(idea.status)) throw new HttpError(409, 'in_flight');
    db.tx(() => { transition(db, idea.id, idea.status, 'cancelled', { actor: `admin:${u.wallet}`, note: 'removed by a SUBZERONE admin' }); cancelJobs(db, { ideaId: idea.id }); });
    return { ok: true };
  });
  r.post('/api/admin/users/:wallet/role', async (ctx) => {
    const u = requireAdmin(ctx);
    const b = await ctx.body();
    if (!['user', 'reviewer', 'admin'].includes(b.role)) throw new HttpError(400, 'bad_role');
    if (cfg.adminWallets.includes(ctx.params.wallet) && b.role !== 'admin') throw new HttpError(409, 'env_admin', 'set by ADMIN_WALLETS');
    db.run('UPDATE users SET role = ? WHERE wallet = ?', b.role, ctx.params.wallet);
    audit(db, { actor: `admin:${u.wallet}`, kind: 'admin', message: `role of ${ctx.params.wallet} set to ${b.role}` });
    return { ok: true };
  });
  r.post('/api/admin/users/:wallet/ban', async (ctx) => {
    const u = requireAdmin(ctx);
    const b = await ctx.body();
    db.run('UPDATE users SET banned_at = ? WHERE wallet = ? AND role = ?', b.banned ? now() : null, ctx.params.wallet, 'user');
    if (b.banned) db.run('UPDATE sessions SET revoked_at = ? WHERE wallet = ?', now(), ctx.params.wallet);
    audit(db, { actor: `admin:${u.wallet}`, kind: 'admin', message: `${b.banned ? 'banned' : 'unbanned'} ${ctx.params.wallet}` });
    return { ok: true };
  });
  r.post('/api/admin/mock-behaviour', async (ctx) => {
    const u = requireAdmin(ctx);
    if (cfg.production) throw new HttpError(404, 'not_found');
    const b = await ctx.body();
    if (!['ok', 'reject_on_chain', 'never_lands', 'late', 'slow_index', 'preflight_reject', 'timeout_but_lands'].includes(b.behaviour)) throw new HttpError(400, 'bad_behaviour');
    setSetting(db, 'mock.behaviour', b.behaviour, u.wallet);
    return { ok: true };
  });
  r.post('/api/admin/backup', (ctx) => { const u = requireAdmin(ctx); const f = backup(db, join(cfg.dataDir, 'backups'), cfg.backups.keep); audit(db, { actor: `admin:${u.wallet}`, kind: 'admin', message: 'backup taken' }); return { file: f.split('/').pop() }; });

  /** Both approvals in place -> approved, and the launch configuration is prepared by a job. */
  function maybeApprove(projectId) {
    const p = db.get('SELECT * FROM projects WHERE id = ?', projectId);
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', p.idea_id);
    if (idea.status !== 'preview_ready' || !p.submitter_approved_at) return;
    if (cfg.launch.requireAdminClearance && !p.admin_cleared_at) {
      db.run(`UPDATE ideas SET status_note = 'approved by you; waiting for a SUBZERONE reviewer to clear it for launch' WHERE id = ?`, idea.id);
      return;
    }
    transition(db, idea.id, 'preview_ready', 'approved', { actor: 'system', note: 'approved; preparing the launch configuration' });
    enqueue(db, { type: 'prepare_launch', key: `prepare:${p.id}:${p.submitter_approved_at}`, ideaId: idea.id, projectId: p.id });
  }

  // --- generated project sites ----------------------------------------------------------------------------------------
  function serveSiteFile(ctx, p, version, file, preview) {
    const headers = { 'content-security-policy': preview ? `${SITE_CSP}; sandbox` : SITE_CSP, 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'cache-control': preview ? 'private, no-store' : 'public, max-age=60' };
    if (file === 'index.html' || file === '') {
      const s = db.get(`SELECT html FROM site_versions WHERE project_id = ? AND version = ? AND build_status = 'ok'`, p.id, version);
      if (!s) throw new HttpError(404, 'not_found');
      return ctx.raw(200, Buffer.from(s.html), { ...headers, 'content-type': 'text/html; charset=utf-8' });
    }
    const kind = file === 'logo.png' ? 'logo' : file === 'banner.svg' ? 'banner' : null;
    if (!kind) throw new HttpError(404, 'not_found');
    const a = db.get('SELECT mime, body FROM assets WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1', p.id, kind);
    if (!a) throw new HttpError(404, 'not_found');
    return ctx.raw(200, Buffer.from(a.body), { ...headers, 'content-type': a.mime });
  }

  function projectSite(req, res, host, path) {
    const slug = host.slice(0, host.length - projectsHost.length - 1);
    const p = /^[a-z0-9-]{1,40}$/.test(slug) && projectBySlug(slug);
    const idea = p && db.get('SELECT visibility FROM ideas WHERE id = ?', p.idea_id);
    const ctx = { raw: (status, body, headers) => { res.writeHead(status, headers); res.end(body); } };
    if (!p || idea.visibility !== 'public' || !p.live_site_version) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    try { serveSiteFile(ctx, p, p.live_site_version, path === '/' ? 'index.html' : path.slice(1), false); } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  }

  // --- static files ---------------------------------------------------------------------------------------------------
  function serveStatic(res, path) {
    const file = normalize(join(PUBLIC, path === '/' || PAGES.some((re) => re.test(path)) ? 'index.html' : path));
    if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache' });
    res.end(readFileSync(file));
    return true;
  }

  return async function handle(req, res) {
    const reqId = token(6);
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    const host = String(req.headers.host || '').toLowerCase();
    try {
      if (host.endsWith(`.${projectsHost}`)) return projectSite(req, res, host, url.pathname);
      securityHeaders(res, APP_CSP(roomOrigin));
      const route = r.match(req.method, url.pathname);
      if (!route) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(res, url.pathname)) return;
        return sendJson(res, 404, { error: 'not_found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // state-changing requests must come from our own pages
        const o = req.headers.origin;
        if (o !== origin.origin) throw new HttpError(403, 'bad_origin', 'cross-site request refused');
      }
      const cookies = parseCookies(req.headers.cookie);
      const ip = clientIp(req, cfg.trustProxy);
      const ctx = {
        req, params: route.params, query: url.searchParams, cookies, ip,
        user: sessionUser(db, cookies[COOKIE]),
        body: (lim) => readJson(req, lim || route.opts.bodyLimit || 64_000),
        setCookie: (c) => res.setHeader('set-cookie', c),
        raw: (status, body, headers) => { res.writeHead(status, headers); res.end(body); return RAW; },
        redirect: (to) => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); return RAW; },
      };
      limit(req.method === 'GET' ? 'read' : 'write', ctx.user?.wallet || ip);
      const out = await route.handler(ctx);
      if (out !== RAW) sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      sendError(res, err, reqId);
    } finally {
      if (url.pathname.startsWith('/api/')) log.info('http', { reqId, method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
    }
  };
}

const RAW = Symbol('raw');
