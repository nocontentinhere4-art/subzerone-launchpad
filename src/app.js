// The launchpad web application: JSON API, the single-page front end, generated project sites (by Host) and token
// metadata. createApp() returns a node:http request handler; server.js listens.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT, SUB01 } from './config.js';
import { router, parseCookies, readJson, clientIp, rateLimiter, securityHeaders, APP_CSP, sendJson, sendError } from './http.js';
import { issueNonce, verifySignIn, sessionUser, signOut } from './auth.js';
import { submitIdea, editIdea, reviseIdea, publishIdea, viewIdea, readUpload, currentVersion, LIMITS, MAX_VERSIONS } from './ideas.js';
import { createKicker } from './kick.js';
import { transition, LABELS, STAGES } from './states.js';
import { audit, getSetting, setSetting, PAUSES, isPaused, backup } from './db.js';
import { enqueue, retryDead, cancelJobs } from './jobs.js';
import { buildSiteVersion, setLiveVersion, siteCspFor } from './site.js';
import { CATALOG, EXTRAS, LIBS, defaultConfig, validateTools, isToolError } from './tools.js';
import { createSiteApi, liveSpec, ownerInbox, moderateEntry } from './tool-api.js';
import { registerAppRoutes } from './app-api.js';
import { validateSpec } from './generator.js';
import { getProvider, validateRecipients, draftAllocation, allocationStatement, feeMode, createIntent, submitSigned,
  abandonIntent, feeLedger, MAX_RECIPIENTS, SUB01_FEE_BPS, SUB01_LABEL, setInitialBuy, parseInitialBuySol, maxInitialBuyLamports,
  INITIAL_BUY_STATES, refreshIntent, createDevBuy, refreshDevBuy, submitDevBuy, abandonDevBuy, skipDevBuy, devBuyView } from './launch.js';
import { DISTRICTS, PLOTS_PER_DISTRICT, PLOT_IDS, RESERVED_PLOT_IDS, LOOK, FREE_COLORS, NAME, ROOM, DEFAULT_ROOM, PROGRESS, ACCESSORIES, MAX_ACCESSORIES, PETS,
  PET_NAME, TRAITS, DEFAULT_TRAITS, UNLOCKS, TEXT_ITEMS, ITEM_TEXT_MAX, GUESTBOOK, saveResident, residentOf, plotsOf, worldView, roomView, saveRoom,
  unlocksFor, postGuestbook, deleteGuestbook, deskView, validatePlotId, readLook } from './world.js';
import { rolesView, setRole, requestTakeover, decideTakeover, withdrawTakeover } from './roles.js';
import { mockSigningText } from './launch/mock.js';
import { startOAuth, finishOAuth, approvePost, xConfigured } from './x.js';
import { xDonePage, X_DONE_CSP } from './x-done.js';
import { sub01Market } from './market.js';
import { coinStatsView } from './coin-stats.js';
import { brainStatus } from './brain.js';
import { limits, spentToday } from './budget.js';
import { listVotes, voteHead, verifyChain, disclosure } from './trust.js';
import { calendarView, jstDate } from './calendar.js';
import { drawOmikuji, todayOmikuji, predict, predictionView, leaderboard, emaList, cheerEma, touchSeen, recordVisit, awayView } from './rituals.js';
import { diaryFor, latestDiary } from './diary.js';
import { postcardSvg, postcardPng } from './postcard.js';
import { optedOut, recordTelemetry, telemetryDaily } from './telemetry.js';
import { createChat } from './chat.js';
import { HttpError, parseJson, now, token, escapeHtml } from './util.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { log } from './log.js';

const PUBLIC = join(ROOT, 'public');
const PAGES = [/^\/$/, /^\/launchpad$/, /^\/submit$/, /^\/ideas\/[^/]+$/, /^\/projects\/[^/]+(\/review)?$/, /^\/token$/, /^\/me$/, /^\/admin$/, /^\/fees$/, /^\/how$/];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm' };
const COOKIE = 'lp_session';
const ACTIVE = ['submitted', 'evaluating', 'selected', 'generating', 'preview_ready', 'approved', 'launch_prepared', 'awaiting_signature', 'confirming'];

/** `chat`: {connect, fetchMind, relayOpts, limits} for tests (the SUB-01 transport and quotas; see chat.js).
 *  `kick`: run an idea's evaluate job in this process right after the submit answers (kick.js); tests that drain the
 *  queue by hand pass false. */
export function createApp({ cfg, db, fetchImpl = fetch, chat: chatOpts = {}, kick = true }) {
  const r = router();
  const limit = rateLimiter();
  const origin = new URL(cfg.publicOrigin);
  const roomOrigin = new URL(cfg.brain.publicRoomUrl).origin;
  const projectsHost = cfg.projectsHost.toLowerCase();
  // every project site, for the city's desk computer: <slug>.<PROJECTS_HOST> with the same scheme as siteUrl
  const projectsFrameSource = `${cfg.projectsScheme}://*.${projectsHost}`;
  const appCsp = APP_CSP(roomOrigin, projectsFrameSource);
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
  // RFC 9116: who to contact and where the code lives (reputation scanners and wallets look for it; 2026-10-11)
  r.get('/.well-known/security.txt', (ctx) => ctx.raw(200, Buffer.from([
    'Contact: https://github.com/nocontentinhere4-art/subzerone-launchpad/security/advisories/new',
    'Contact: https://x.com/SUBZERONE01',
    `Canonical: ${cfg.publicOrigin}/.well-known/security.txt`,
    'Policy: https://github.com/nocontentinhere4-art/subzerone-launchpad/blob/main/SECURITY.md',
    'Preferred-Languages: en, it',
    `Expires: ${new Date(Date.now() + 365 * 86400000).toISOString()}`,
    '', '# SUBZERONE: a memecoin launchpad lived as a 3D Tokyo city. Open source:',
    '# https://github.com/nocontentinhere4-art/subzerone-launchpad (server)',
    '# https://github.com/nocontentinhere4-art/sub01-launchpad (client)', ''].join('\n')),
  { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' }));
  r.get('/api/config', async () => {
    const provider = getProvider(cfg, db);
    return {
      sub01: SUB01, deployEnv: cfg.deployEnv, roomUrl: cfg.brain.publicRoomUrl,
      launch: provider ? { provider: provider.name, network: provider.network, label: provider.label, mock: provider.isMock } : { provider: 'none', label: 'launching disabled' },
      generator: cfg.generator.provider === 'anthropic' ? `language model (${cfg.generator.anthropicModel})` : 'fixed template (no AI)',
      brainConfigured: Boolean(cfg.brain.url && cfg.brain.secret), xConfigured: xConfigured(cfg),
      pauses: Object.fromEntries(PAUSES.map((p) => [p, isPaused(db, p)])),
      sub01Share: { label: SUB01_LABEL, bps: SUB01_FEE_BPS, wallet: cfg.sub01FeeWallet || null, configured: Boolean(cfg.sub01FeeWallet) },
      city: Boolean(cfg.cityDist), maxRecipients: MAX_RECIPIENTS, limits: LIMITS,
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
    chat.leave(ctx.user?.wallet);                            // the walker goes home with the session
    ctx.setCookie(`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? '; Secure' : ''}`);
    return { ok: true };
  });
  r.get('/api/me', (ctx) => {
    if (!ctx.user) return { user: null };
    touchSeen(db, ctx.user.wallet);                          // "while you were away" (rituals.js)
    const ideas = db.all(`SELECT i.id, i.status, i.status_note, i.visibility, i.created_at, i.updated_at, v.title, p.slug, p.ticker, l.provider, l.network
      FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version LEFT JOIN projects p ON p.idea_id = i.id
      LEFT JOIN launches l ON l.project_id = p.id
      WHERE i.owner_wallet = ? ORDER BY i.created_at DESC`, ctx.user.wallet);
    const launched = db.all(`SELECT p.slug FROM projects p JOIN ideas i ON i.id = p.idea_id JOIN launches l ON l.project_id = p.id WHERE i.owner_wallet = ?`, ctx.user.wallet);
    const projectRoles = db.all('SELECT p.slug, r.role FROM project_roles r JOIN projects p ON p.id = r.project_id WHERE r.wallet = ? ORDER BY r.granted_at', ctx.user.wallet);
    return { user: ctx.user, ideas, fees: launched.map((x) => ({ slug: x.slug, ledger: feeLedger(db, projectBySlug(x.slug).id) })),
      resident: residentOf(db, ctx.user.wallet) || null, plots: plotsOf(db, ctx.user.wallet), projectRoles, unlocks: unlocksFor(db, ctx.user.wallet) };
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
    const pin = db.get('SELECT pinned_hash, pinned_at FROM ideas WHERE id = ?', ideaId);
    wake(`evaluate:${ideaId}:v1`);                           // his verdict in seconds, not on the worker's next sweep
    return { id: ideaId, pinnedHash: pin.pinned_hash, pinnedAt: pin.pinned_at };
  }, { bodyLimit: 7_000_000 });
  r.get('/api/ideas/:id', (ctx) => {
    const v = viewIdea(db, ctx.params.id, ctx.user);
    if (!v) throw new HttpError(404, 'not_found', 'not found, or private');
    return v;
  });
  // the revise loop: a passed idea, rewritten and read again (ideas.js reviseIdea: 409 not_declined | max_versions, 429 too_fast)
  r.patch('/api/ideas/:id', async (ctx) => {
    const u = requireUser(ctx);
    limit('write', u.wallet);
    const out = reviseIdea(db, ctx.params.id, u.wallet, await ctx.body(64_000));
    log.info('idea revised', { idea: ctx.params.id, version: out.version });
    wake(out.key);
    return { id: ctx.params.id, version: out.version, maxVersions: MAX_VERSIONS };
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
    const intent = (owner || staff) ? db.get(`SELECT id, status, mint, tx_signature, error, provider, network, created_at, updated_at, last_valid_block_height, dev_buy_mode
      FROM launch_intents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`, p.id) : undefined;
    const provider = getProvider(cfg, db);
    const gen = db.get('SELECT generator, cost_usd, created_at FROM generations WHERE project_id = ? ORDER BY version DESC LIMIT 1', p.id);
    const evaluation = db.get(`SELECT brain_json, scores_json FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, idea.id);
    const v1 = currentVersion(db, idea.id);
    const vote = db.get(`SELECT l.seq FROM evaluations e JOIN vote_ledger l ON l.request_id = e.brain_request_id WHERE e.idea_id = ? AND l.decision = 'build'
      ORDER BY l.seq LIMIT 1`, idea.id);
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
      // the author's dev buy (PUT …/launch/options): the stored setting; locked while a transaction exists
      launchOptions: (owner || staff) ? (() => {
        const locked = !!db.get(`SELECT 1 FROM launch_intents WHERE project_id = ? AND status IN ('prepared','awaiting_signature','submitted','confirmed')`, p.id);
        return { initialBuyLamports: Number(p.initial_buy_lamports ?? 0), maxInitialBuyLamports: maxInitialBuyLamports(cfg), locked,
          editable: owner && !locked && !launch && INITIAL_BUY_STATES.includes(idea.status) };
      })() : undefined,
      // step 2 of a launch with a dev buy (launch.js devBuyView): status, amount, the latest attempt
      devBuy: (owner || staff) && launch ? devBuyView(db, provider, p) : undefined,
      ledger: launch ? feeLedger(db, p.id) : null,
      pinnedHash: idea.pinned_hash ?? null, pinnedAt: idea.pinned_at ?? null, ledgerSeq: vote?.seq ?? null,
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
  // --- the site kit's tools, the author's side (tools.js, tool-api.js; docs/SITE-KIT.md) -------------------------------
  // Editable while the preview is open and after launch (between approval and launch the site is frozen: review #5).
  const TOOL_STATES = ['preview_ready', 'launched'];
  const toolsProject = (ctx, slug, { staffToo = false } = {}) => {
    const u = requireUser(ctx);
    const p = projectBySlug(slug);
    if (!p) throw new HttpError(404, 'not_found');
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', p.idea_id);
    const owner = idea.owner_wallet === u.wallet;
    if (!owner && !(staffToo && u.role === 'admin')) throw new HttpError(404, 'not_found');
    return { p, idea, u, owner };
  };
  r.get('/api/projects/:slug/tools', (ctx) => {
    const { p, idea, owner } = toolsProject(ctx, ctx.params.slug, { staffToo: true });
    const spec = liveSpec(db, p);
    return { editable: owner && TOOL_STATES.includes(idea.status), status: idea.status,
      lockedNote: TOOL_STATES.includes(idea.status) ? null : 'The site is frozen between your approval and the launch; tools can change again after the launch (or reopen the preview).',
      tools: spec?.tools || [], catalog: CATALOG, extras: EXTRAS, libs: LIBS, holderChecks: Boolean(cfg.coinStats.heliusUrl),
      liveSiteVersion: p.live_site_version, inbox: ownerInbox(db, cfg, p) };
  });
  r.put('/api/projects/:slug/tools', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    if (!TOOL_STATES.includes(idea.status)) throw new HttpError(409, 'locked', 'tools can change while the preview is open, or after the launch');
    const b = await ctx.body(16_000);
    if (!Array.isArray(b.tools)) throw new HttpError(400, 'invalid', 'tools: an array of {id, config}');
    const cur = liveSpec(db, p);
    const concept = currentVersion(db, idea.id).concept;
    // a tool switched on without its fields gets SUB-01's defaults; the author's fields win over them
    const list = b.tools.map((t) => {
      if (!t || typeof t !== 'object' || !CATALOG[t.id]) throw new HttpError(400, 'invalid', `unknown tool ${String(t?.id).slice(0, 20)}`);
      const base = defaultConfig(t.id, { name: cur.name, concept });
      const given = t.config && typeof t.config === 'object' && !Array.isArray(t.config) ? t.config : {};
      const merged = { ...base, ...given };
      if (t.id === 'event' && given.at) delete merged.daily;
      if (t.id === 'event' && given.daily) delete merged.at;
      return { id: t.id, config: merged };
    });
    let tools;
    try { tools = validateTools(list); } catch (e) { if (isToolError(e)) throw new HttpError(400, 'invalid', e.message); throw e; }
    const spec = { ...cur, tools };
    try { validateSpec(spec); } catch (e) { throw new HttpError(400, 'invalid', e.message.replace('generated spec invalid: ', '')); }
    const site = await buildSiteVersion(db, cfg, p, spec, `wallet:${u.wallet}`);
    setLiveVersion(db, p, site.version, `wallet:${u.wallet}`);
    if (idea.status === 'preview_ready') db.run('UPDATE projects SET submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL, updated_at = ? WHERE id = ?', now(), p.id);
    audit(db, { actor: `wallet:${u.wallet}`, kind: 'tools', projectId: p.id, ideaId: idea.id, isPublic: true,
      message: `Site tools set by the author: ${tools.map((t) => t.id).join(', ') || 'none'} (site v${site.version})` });
    return { version: site.version, tools };
  });
  r.post('/api/projects/:slug/tools/entries/:id', async (ctx) => {
    const { p, u, owner } = toolsProject(ctx, ctx.params.slug, { staffToo: true });
    limit('write', u.wallet);
    return moderateEntry(db, p, ctx.params.id, await ctx.body(1_000), `${owner ? 'wallet' : 'admin'}:${u.wallet}`);
  });
  // the idea app (app-api.js, docs/APP-COMPOSER.md): the owner's App section in the room PC
  registerAppRoutes(r, { db, cfg, fetchImpl, limit, toolsProject, ownedProject, TOOL_STATES, liveSpec, currentVersion });

  // previews: same origin, served with CSP "sandbox" (opaque origin, no scripts). The sandboxed page cannot send the
  // session cookie, so its address carries a short-lived signed capability instead (issued to viewers who may see it).
  const previewKey = randomBytes(32);
  const previewToken = (slug, version, exp) => `${version}.${exp}.${createHmac('sha256', previewKey).update(`${slug}:${version}:${exp}`).digest('base64url').slice(0, 32)}`;
  const previewLink = (slug, version) => `/preview/${slug}/${previewToken(slug, version, Date.now() + 3_600_000)}/index.html`;
  r.get('/api/projects/:slug/preview-link', (ctx) => {
    const v = visibleProject(ctx, ctx.params.slug);
    if (!v) throw new HttpError(404, 'not_found');
    const asked = Number(ctx.query.get('version')) || v.p.live_site_version;
    const version = v.owner || isStaff(ctx.user) ? asked : v.p.live_site_version;     // drafts stay with the owner
    return { url: previewLink(v.p.slug, version) };
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
    // the SUB-01 row's wallet is the configured one; a client may send it without the address
    const rows = Array.isArray(b.recipients) ? b.recipients.map((x) => (x?.role === 'sub01' && !x.wallet ? { ...x, wallet: cfg.sub01FeeWallet } : x)) : b.recipients;
    const recipients = validateRecipients(cfg, rows, v.receiving_wallet);
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
    validateRecipients(cfg, recipients, currentVersion(db, idea.id).receiving_wallet);
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
  // the dev buy: {initialBuySol} (0 = none), owner only, before a transaction exists (409 intent_exists otherwise)
  r.put('/api/projects/:slug/launch/options', async (ctx) => {
    const { p, idea, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    const b = await ctx.body();
    const lamports = parseInitialBuySol(cfg, b.initialBuySol);
    return { ok: true, ...(await setInitialBuy(db, cfg, p, idea, u.wallet, lamports)), maxInitialBuyLamports: maxInitialBuyLamports(cfg) };
  });
  r.post('/api/projects/:slug/launch/transaction', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    return createIntent(db, cfg, p, u.wallet);
  });
  r.post('/api/projects/:slug/launch/refresh', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    return refreshIntent(db, cfg, p, u.wallet);
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
  // step 2, the dev buy as its own transaction (launch.js createDevBuy …): the same four calls as the launch, plus skip
  r.post('/api/projects/:slug/launch/devbuy/transaction', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    return createDevBuy(db, cfg, p, u.wallet);
  });
  r.post('/api/projects/:slug/launch/devbuy/refresh', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    limit('write', u.wallet);
    return refreshDevBuy(db, cfg, p, u.wallet);
  });
  r.post('/api/projects/:slug/launch/devbuy/signed', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    const b = await ctx.body(64_000);
    return submitDevBuy(db, cfg, p, u.wallet, String(b.signed || ''));
  });
  r.post('/api/projects/:slug/launch/devbuy/abandon', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    const b = await ctx.body();
    abandonDevBuy(db, p, u.wallet, b.reason === 'rejected' ? 'the wallet rejected the signature request' : 'signature request cancelled');
    return { ok: true };
  });
  r.post('/api/projects/:slug/launch/devbuy/skip', async (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    return { ok: true, ...skipDevBuy(db, p, u.wallet) };
  });

  // --- X ------------------------------------------------------------------------------------------------------------
  r.get('/api/projects/:slug/x/connect', (ctx) => {
    const { p, u } = ownedProject(ctx, ctx.params.slug);
    return ctx.redirect(startOAuth(db, cfg, p.id, u.wallet));
  });
  r.get('/api/x/callback', async (ctx) => {
    // Lands in the pop-up the room PC opened; the city polls the project and updates its X tab by itself (desk.js).
    const page = (body) => ctx.raw(200, Buffer.from(body), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': X_DONE_CSP, 'cache-control': 'no-store' });
    try {
      const u = requireUser(ctx);
      const res = await finishOAuth(db, cfg, { state: ctx.query.get('state'), code: ctx.query.get('code') }, u.wallet, fetchImpl);
      return page(xDonePage({ ok: true, handle: res.handle }));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return page(xDonePage({ ok: false, error: err.message }));
    }
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

  // --- city (world.js, roles.js; contract in docs/CITY-API.md) -------------------------------------------------------
  r.get('/api/world/options', (ctx) => ctx.raw(200, Buffer.from(JSON.stringify({
    districts: DISTRICTS, plotsPerDistrict: PLOTS_PER_DISTRICT, plotIds: PLOT_IDS, reservedPlotIds: RESERVED_PLOT_IDS,
    look: { ...LOOK, freeColors: FREE_COLORS, colorPattern: '^#[0-9a-f]{6}$', accessories: ACCESSORIES, maxAccessories: MAX_ACCESSORIES, pets: PETS, petName: PET_NAME },
    traits: { keys: TRAITS, range: [0, 1], default: DEFAULT_TRAITS }, name: NAME,
    room: { ...ROOM, textItems: TEXT_ITEMS, textMax: ITEM_TEXT_MAX, default: DEFAULT_ROOM }, progress: PROGRESS, unlocks: UNLOCKS,
    guestbook: { max: GUESTBOOK.max, keep: GUESTBOOK.keep, perPlotSeconds: GUESTBOOK.perPlotMs / 1000, perDay: GUESTBOOK.perDay },
    sub01: SUB01,                                          // the CA chip next to the logo (city main.js caChip)
  })), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600' }));
  let worldCache = null;                                     // one snapshot for everyone, at most 3 s old
  r.get('/api/world', (ctx) => {
    if (!worldCache || Date.now() - worldCache.at > 3000) worldCache = { at: Date.now(), body: Buffer.from(JSON.stringify(worldView(db, cfg))) };
    return ctx.raw(200, worldCache.body, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3' });
  });
  r.post('/api/residents', async (ctx) => {
    const u = requireUser(ctx);
    limit('write', u.wallet);
    const resident = saveResident(db, u.wallet, await ctx.body());
    return { resident, plots: plotsOf(db, u.wallet) };
  });
  r.get('/api/rooms/:plotId', (ctx) => {
    const v = roomView(db, ctx.params.plotId);
    if (!v) throw new HttpError(404, 'not_found', 'nobody lives there (or it is private)');
    const pl = db.get('SELECT wallet, idea_id FROM plots WHERE plot_id = ?', ctx.params.plotId);
    recordVisit(db, ctx.user?.wallet, ctx.params.plotId, pl.wallet);   // for the owner's "while you were away"
    const provider = getProvider(cfg, db);
    const desk = deskView(db, cfg, { wallet: pl.wallet, owner: ctx.user?.wallet === pl.wallet, plotIdeaId: pl.idea_id,
      previewLink: (p) => previewLink(p.slug, p.live_site_version), explorerTx: (sig) => provider?.explorerTx?.(sig) });
    return { ...v, desk };
  });
  r.post('/api/rooms/:plotId/guestbook', async (ctx) => {
    const u = requireUser(ctx);
    limit('write', u.wallet);
    return { entry: postGuestbook(db, u.wallet, ctx.params.plotId, (await ctx.body()).text) };
  });
  r.del('/api/rooms/:plotId/guestbook/:id', (ctx) => { deleteGuestbook(db, requireUser(ctx).wallet, ctx.params.plotId, ctx.params.id); return { ok: true }; });
  r.put('/api/rooms/me', async (ctx) => {
    const u = requireUser(ctx);
    limit('write', u.wallet);
    const b = await ctx.body();
    return { room: saveRoom(db, u.wallet, b.room) };
  });
  r.get('/api/projects/:slug/roles', (ctx) => {
    const v = visibleProject(ctx, ctx.params.slug);
    if (!v) throw new HttpError(404, 'not_found', 'not found, or private');
    return rolesView(db, v.p, ctx.user);
  });
  r.post('/api/projects/:slug/roles', async (ctx) => {
    const u = requireUser(ctx);
    const p = projectBySlug(ctx.params.slug);
    if (!p) throw new HttpError(404, 'not_found');
    const b = await ctx.body();
    setRole(db, p, u.wallet, { wallet: String(b.wallet || ''), role: b.role ?? null });
    return rolesView(db, p, u);
  });
  r.post('/api/projects/:slug/takeover', async (ctx) => {
    const u = requireUser(ctx);
    limit('write', u.wallet);
    const v = visibleProject(ctx, ctx.params.slug);
    if (!v) throw new HttpError(404, 'not_found');
    return requestTakeover(db, v.p, u.wallet, (await ctx.body()).reason);
  });
  r.post('/api/takeover/:id/decide', async (ctx) => {
    const u = requireUser(ctx);
    const b = await ctx.body();
    if (typeof b.approve !== 'boolean') throw new HttpError(400, 'bad_request', 'approve: true or false');
    return decideTakeover(db, ctx.params.id, u, b.approve);
  });
  r.post('/api/takeover/:id/withdraw', (ctx) => withdrawTakeover(db, ctx.params.id, requireUser(ctx).wallet));

  // --- live city chat and SUB-01 relay (chat.js, sub01relay.js; contract in docs/CITY-API.md "Chat") ----------------
  const fetchMind = cfg.brain.url ? async () => {
    const res = await fetchImpl(new URL('/api/mind', cfg.brain.url), { signal: AbortSignal.timeout(5000), redirect: 'error' });
    return res.ok ? res.json() : null;
  } : null;
  const chat = createChat({ db, cfg, fetchMind, ...chatOpts });
  r.get('/api/chat/stream', (ctx) => { chat.stream(ctx.req, ctx.res, { user: ctx.user, ip: ctx.ip }); return RAW; });
  r.post('/api/chat', async (ctx) => chat.post(requireUser(ctx), await ctx.body(4_000)));
  r.post('/api/chat/presence', async (ctx) => chat.ping(requireUser(ctx), await ctx.body(1_000)));
  r.post('/api/chat/report', async (ctx) => chat.report(requireUser(ctx), await ctx.body(1_000)));
  r.post('/api/chat/sub01', async (ctx) => chat.sub01(requireUser(ctx), await ctx.body(4_000)));
  // live walkers (chat.js validateWalk / walk; frames `walker` / `walkers` on the stream): guests get the 401
  r.post('/api/presence', async (ctx) => chat.walk(requireUser(ctx), await ctx.body(600)));
  r.get('/api/admin/chat', (ctx) => { requireAdmin(ctx); return chat.adminList(ctx.query); });
  r.del('/api/admin/chat/:id', (ctx) => chat.adminDelete(requireAdmin(ctx), ctx.params.id));

  // --- the verdict, live (kick.js, pipeline.js tellVerdict; SSE `verdict` in docs/CITY-API.md) -------------------------
  // A public idea's verdict goes to every stream; a private idea's only to its author's own streams, never with its title
  // on the public stream. Either way the city's next /api/world read sees the new status at once.
  const onVerdict = (v) => {
    const idea = db.get('SELECT visibility, owner_wallet FROM ideas WHERE id = ?', v.ideaId);
    if (!idea) return;
    worldCache = null;
    const plot = db.get(`SELECT plot_id FROM plots WHERE idea_id = ? AND kind = 'project'`, v.ideaId);
    const base = { ideaId: v.ideaId, version: v.version, verdict: v.verdict, status: v.decision, summary: v.summary, latencyMs: v.latencyMs, at: v.at, plotId: plot?.plot_id ?? null };
    if (idea.visibility === 'public') {
      const title = db.get('SELECT title FROM idea_versions WHERE idea_id = ? AND version = ?', v.ideaId, v.version)?.title ?? null;
      chat.broadcast('verdict', { ...base, title, private: false });
    } else {
      chat.sendTo(idea.owner_wallet, 'verdict', { ...base, private: true });
    }
  };
  const kicker = createKicker({ db, cfg, fetchImpl, services: { onVerdict } });
  const wake = (key) => { if (kick) setImmediate(() => kicker.kick(key)); };

  // --- trust: vote ledger, disclosure, calendar, telemetry (trust.js, calendar.js, telemetry.js) ------------------------
  const JSON_TYPE = 'application/json; charset=utf-8';
  const disclosureBody = Buffer.from(JSON.stringify(disclosure(cfg)));
  r.get('/api/disclosure', (ctx) => ctx.raw(200, disclosureBody, { 'content-type': JSON_TYPE, 'cache-control': 'public, max-age=3600' }));
  // a launched public coin's stored stats (coin-stats.js): read from the database only, never a network call here
  r.get('/api/coins/:mint/stats', (ctx) => {
    if (!/^[A-Za-z0-9]{3,64}$/.test(ctx.params.mint)) throw new HttpError(400, 'bad_mint', 'a token mint address');
    const v = coinStatsView(db, ctx.params.mint);
    if (!v) throw new HttpError(404, 'not_found', 'no launched public project with that mint');
    return ctx.raw(200, Buffer.from(JSON.stringify(v)), { 'content-type': JSON_TYPE, 'cache-control': 'public, max-age=60' });
  });
  r.get('/api/votes', (ctx) => listVotes(db, ctx.query));
  r.get('/api/votes/head', () => voteHead(db));
  r.get('/api/votes/verify', (ctx) => verifyChain(db, ctx.query));
  let calendarCache = null;                                  // one snapshot for everyone, at most 60 s old
  r.get('/api/calendar', (ctx) => {
    if (!calendarCache || Date.now() - calendarCache.at > 60_000) calendarCache = { at: Date.now(), body: Buffer.from(JSON.stringify(calendarView(db, cfg))) };
    return ctx.raw(200, calendarCache.body, { 'content-type': JSON_TYPE, 'cache-control': 'public, max-age=60' });
  });
  r.post('/api/telemetry', async (ctx) => {
    if (optedOut(ctx.req.headers)) return { stored: false, reason: 'opted_out' };
    return recordTelemetry(db, await ctx.body(2_000), ctx.ip);
  });
  r.get('/api/admin/telemetry', (ctx) => {
    requireAdmin(ctx);
    const d = ctx.query.get('days') ?? '14';
    if (!/^\d{1,2}$/.test(d) || Number(d) < 1 || Number(d) > 90) throw new HttpError(400, 'bad_request', 'days: 1–90');
    return telemetryDaily(db, Number(d));
  });

  // --- rituals: omikuji, predictions, ema, "while you were away" (rituals.js); diary (diary.js); postcards ------------
  r.post('/api/omikuji', (ctx) => drawOmikuji(db, requireUser(ctx).wallet));
  r.get('/api/omikuji/today', (ctx) => todayOmikuji(db, requireUser(ctx).wallet));
  r.post('/api/predictions', async (ctx) => { const u = requireUser(ctx); limit('write', u.wallet); return predict(db, u.wallet, await ctx.body()); });
  r.get('/api/predictions/:ideaId', (ctx) => predictionView(db, ctx.params.ideaId, ctx.user?.wallet));
  r.get('/api/leaderboard', (ctx) => leaderboard(db, ctx.query));
  r.get('/api/ema', (ctx) => emaList(db, ctx.query));
  r.post('/api/ema/:ideaId/cheer', (ctx) => { const u = requireUser(ctx); limit('write', u.wallet); return cheerEma(db, u.wallet, ctx.params.ideaId); });
  r.get('/api/away', (ctx) => awayView(db, requireUser(ctx).wallet));
  r.get('/api/diary/latest', () => latestDiary(db, cfg));
  r.get('/api/diary', (ctx) => {
    const extra = [...ctx.query.keys()].filter((k) => k !== 'date');
    if (extra.length) throw new HttpError(400, 'bad_request', `unknown parameter ${extra[0].slice(0, 20)}`);
    return diaryFor(db, cfg, ctx.query.get('date') ?? undefined);
  });

  /** The card data of a public project, or null. */
  const projectCard = (slug) => {
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) return null;
    const p = projectBySlug(slug);
    const idea = p && db.get('SELECT status, visibility FROM ideas WHERE id = ?', p.idea_id);
    if (!p || idea.visibility !== 'public') return null;
    const ev = db.get(`SELECT brain_json FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, p.idea_id);
    const logo = db.get(`SELECT body FROM assets WHERE project_id = ? AND kind = 'logo' ORDER BY version DESC LIMIT 1`, p.id);
    const plot = db.get('SELECT plot_id FROM plots WHERE idea_id = ?', p.idea_id);
    return { kind: 'project', slug: p.slug, name: p.name, ticker: p.ticker, stage: idea.status, stageLabel: LABELS[idea.status] || idea.status,
      networks: parseJson(ev?.brain_json)?.networks || {}, logo: logo ? Buffer.from(logo.body) : null, date: jstDate(now()), plotId: plot?.plot_id || null };
  };
  /** The card data of an apartment with a resident, or null. */
  const roomCard = (plotId) => {
    try { validatePlotId(plotId); } catch { return null; }
    const x = db.get(`SELECT r.name, r.look_json FROM plots pl JOIN residents r ON r.plot_id = pl.plot_id WHERE pl.plot_id = ? AND pl.kind = 'apartment'`, plotId);
    if (!x) return null;
    const d = plotId.replace(/-\d+$/, '');
    return { kind: 'room', plotId, name: x.name, district: d[0].toUpperCase() + d.slice(1), look: readLook(x.look_json), date: jstDate(now()) };
  };
  const CARD_HEADERS = { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' };
  const cardCache = new Map();                             // rendered cards, 5 min, at most 200 (a PNG takes ~40 ms)
  const sendCard = (ctx, card, ext) => {
    if (!card) throw new HttpError(404, 'not_found', 'not found, or private');
    const key = `${ext}:${JSON.stringify({ ...card, logo: card.logo?.length ?? 0 })}`;
    let hit = cardCache.get(key);
    if (!hit || Date.now() - hit.at > 300_000) {
      hit = { at: Date.now(), body: ext === 'png' ? postcardPng(card) : Buffer.from(postcardSvg(card)) };
      cardCache.delete(key);
      cardCache.set(key, hit);
      if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
    }
    if (ext === 'png') return ctx.raw(200, hit.body, { ...CARD_HEADERS, 'content-type': 'image/png' });
    return ctx.raw(200, hit.body, { ...CARD_HEADERS, 'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" });
  };
  r.get('/api/postcard/room/:file', (ctx) => {
    const m = String(ctx.params.file).match(/^([a-z]+-[1-6])\.(svg|png)$/);
    return sendCard(ctx, m && roomCard(m[1]), m?.[2]);
  });
  r.get('/api/postcard/:file', (ctx) => {
    const m = String(ctx.params.file).match(/^([a-z0-9-]{1,40})\.(svg|png)$/);
    return sendCard(ctx, m && projectCard(m[1]), m?.[2]);
  });
  // share pages: Open Graph tags (the PNG postcard: most sites do not take SVG previews) and a redirect into the city
  const sharePage = (ctx, card, path, target) => {
    if (!card) return ctx.raw(404, Buffer.from('not found'), { 'content-type': 'text/plain; charset=utf-8' });
    const title = card.kind === 'room' ? `${card.name}'s room in ${card.district}` : `${card.name}${card.ticker ? ` ($${card.ticker})` : ''}`;
    const desc = card.kind === 'room' ? `An apartment in ${card.district}, SUBZERONE city, Tokyo.` : `${card.stageLabel}. Built by SUB-01 in the SUBZERONE city.`;
    const image = `${origin.origin}/api/postcard/${card.kind === 'room' ? `room/${card.plotId}` : card.slug}.png`;
    const e = escapeHtml;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(title)} · SUBZERONE</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${e(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="SUBZERONE"><meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(desc)}"><meta property="og:url" content="${e(origin.origin + path)}">
<meta property="og:image" content="${e(image)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${e(title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(desc)}"><meta name="twitter:image" content="${e(image)}">
<meta http-equiv="refresh" content="0; url=${e(target)}"></head>
<body><p><a href="${e(target)}">Open ${e(title)} in the city</a></p></body></html>`;
    return ctx.raw(200, Buffer.from(html), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
  };
  r.get('/p/:slug', (ctx) => {
    const card = projectCard(ctx.params.slug);
    return sharePage(ctx, card, `/p/${ctx.params.slug}`, card?.plotId ? `/?focus=${card.plotId}` : `/projects/${ctx.params.slug}`);
  });
  r.get('/r/:plotId', (ctx) => sharePage(ctx, roomCard(ctx.params.plotId), `/r/${ctx.params.plotId}`, `/?focus=${ctx.params.plotId}`));

  // --- ledger & SUB-01 token -----------------------------------------------------------------------------------------
  r.get('/api/ledger', () => {
    const rows = db.all(`SELECT p.id, p.slug, p.name, p.ticker, l.mint, l.network, l.provider, l.verified_at FROM launches l JOIN projects p ON p.id = l.project_id ORDER BY l.verified_at DESC`);
    return { projects: rows.filter((x) => !(cfg.production && x.provider === 'mock')).map((x) => ({ ...x, ledger: feeLedger(db, x.id) })), at: now() };
  });
  r.get('/api/token', async () => sub01Market(db, cfg, fetchImpl));

  // --- token metadata (frozen in the reviewed launch configuration) ---------------------------------------------------
  // Token metadata by hash alone (the launch URI since 2026-10-11; /meta/<slug>/<hash>.json stays for older tokens).
  r.get('/m/:file', (ctx) => {
    const m = ctx.params.file.match(/^([0-9a-f]{16})\.json$/);
    if (!m) throw new HttpError(404, 'not_found');
    const tail = `/m/${m[1]}.json`;
    const rows = [...db.all('SELECT project_id, config_json FROM launch_intents'), ...db.all('SELECT id project_id, launch_config_json config_json FROM projects WHERE launch_config_json IS NOT NULL')];
    for (const row of rows) {
      const c = parseJson(row.config_json);
      if (!c?.token?.uri?.endsWith(tail)) continue;
      const p = db.get('SELECT idea_id FROM projects WHERE id = ?', row.project_id);
      if (!p || db.get('SELECT visibility FROM ideas WHERE id = ?', p.idea_id)?.visibility !== 'public') throw new HttpError(404, 'not_found');
      return ctx.raw(200, Buffer.from(JSON.stringify(c.token.metadata)), { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
    }
    throw new HttpError(404, 'not_found');
  });
  r.get('/meta/:slug/:file', (ctx) => {
    const p = projectBySlug(ctx.params.slug);
    if (!p) throw new HttpError(404, 'not_found');
    const f = ctx.params.file;
    const logo = f.match(/^logo-v(\d+)\.png$/);
    const banner = f.match(/^banner-v(\d+)\.svg$/);
    if (db.get('SELECT visibility FROM ideas WHERE id = ?', p.idea_id).visibility !== 'public') throw new HttpError(404, 'not_found');
    if (logo) {
      const a = db.get(`SELECT body FROM assets WHERE project_id = ? AND kind = 'logo' AND version = ?`, p.id, Number(logo[1]));
      if (!a) throw new HttpError(404, 'not_found');
      return ctx.raw(200, Buffer.from(a.body), { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
    }
    if (banner) {                                            // our own SVG (art.js); opened directly it is still inert
      const a = db.get(`SELECT body FROM assets WHERE project_id = ? AND kind = 'banner' AND version = ?`, p.id, Number(banner[1]));
      if (!a) throw new HttpError(404, 'not_found');
      return ctx.raw(200, Buffer.from(a.body), { 'content-type': 'image/svg+xml', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
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
      budget: { ...limits(db, cfg), spentToday: spentToday(db) }, sub01Share: { bps: SUB01_FEE_BPS, wallet: cfg.sub01FeeWallet || null },
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
    // a dev buy (step 2) that landed but failed verification is checked again the same way
    const buy = !intent && db.get(`SELECT * FROM dev_buy_attempts WHERE project_id = ? AND error LIKE 'landed:%' ORDER BY updated_at DESC LIMIT 1`, p.id);
    if (buy) {
      db.tx(() => {
        db.run(`UPDATE dev_buy_attempts SET status = 'submitted', error = NULL, updated_at = ? WHERE id = ?`, now(), buy.id);
        db.run(`UPDATE launches SET dev_buy_status = 'submitted' WHERE project_id = ?`, p.id);
        audit(db, { actor: `admin:${u.wallet}`, kind: 'admin', ideaId: p.idea_id, projectId: p.id, message: 're-verifying the landed dev buy on-chain' });
        enqueue(db, { type: 'confirm_dev_buy', key: `confirm-buy:${buy.id}:reverify:${now()}`, ideaId: p.idea_id, projectId: p.id, payload: { attemptId: buy.id } });
      });
      return { ok: true, devBuy: buy.id };
    }
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
  // 2026-10-10 the owner removed the reviewer step (REQUIRE_ADMIN_CLEARANCE=0): projects that were approved by their
  // author while it still applied would otherwise wait forever, so each boot lets them through.
  if (!cfg.launch.requireAdminClearance) {
    for (const row of db.all(`SELECT p.id FROM projects p JOIN ideas i ON i.id = p.idea_id WHERE i.status = 'preview_ready' AND p.submitter_approved_at IS NOT NULL`)) {
      try { maybeApprove(row.id); } catch (e) { console.error(`boot: could not release ${row.id}: ${e.message}`); }
    }
  }

  // --- generated project sites ----------------------------------------------------------------------------------------
  // The public site runs the kit (CSP script-src 'self', a sandbox that keeps its own origin); the owner's preview on the
  // launchpad origin stays script-free. Both: the CSP of site.js siteCspFor. docs/SITE-KIT.md has the reasoning.
  function serveSiteFile(ctx, p, version, file, preview) {
    const s = db.get(`SELECT html, spec_json FROM site_versions WHERE project_id = ? AND version = ? AND build_status = 'ok'`, p.id, version);
    if (!s) throw new HttpError(404, 'not_found');
    const headers = { 'content-security-policy': siteCspFor(origin.origin, parseJson(s.spec_json), preview), 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'cache-control': preview ? 'private, no-store' : 'public, max-age=60' };
    if (file === 'index.html' || file === '') return ctx.raw(200, Buffer.from(s.html), { ...headers, 'content-type': 'text/html; charset=utf-8' });
    const kind = file === 'logo.png' || file === 'favicon.ico' ? 'logo' : file === 'banner.svg' ? 'banner' : null;   // favicon = the coin logo
    if (!kind) throw new HttpError(404, 'not_found');
    const a = db.get('SELECT mime, body FROM assets WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1', p.id, kind);
    if (!a) throw new HttpError(404, 'not_found');
    return ctx.raw(200, Buffer.from(a.body), { ...headers, 'content-type': a.mime });
  }

  // the kit's files (public/_kit, built by kit/build.mjs and committed): on every project host, and on the launchpad
  // origin for the preview's stylesheet and fonts. Read once, kept in memory. Versioned vendor files never change.
  const KIT_DIR = join(PUBLIC, '_kit');
  const KIT_FILE = /^\/_kit\/(site-kit\.v1\.(?:js|css)|site-app\.v1\.js|LICENSES\.txt|fonts\/[a-z0-9-]+\.woff2|vendor\/[a-z0-9.-]+\.(?:js|css))$/;
  const KIT_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
  const kitCache = new Map();
  function serveKit(req, res, path) {
    const m = KIT_FILE.exec(path);
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    let hit = kitCache.get(m[1]);
    if (!hit) {
      const file = join(KIT_DIR, m[1]);
      if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
      const raw = readFileSync(file);
      hit = { raw, gz: m[1].endsWith('.woff2') ? null : gzipSync(raw, { level: 9 }) };   // woff2 is compressed already
      kitCache.set(m[1], hit);
    }
    const gz = hit.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')), body = gz ? hit.gz : hit.raw;
    const immutable = /^(vendor|fonts)\//.test(m[1]);
    // public, audited static files: readable by any page (the owner's preview is a sandboxed, opaque-origin frame, so its
    // stylesheet and fonts are cross-origin requests; fonts need CORS). Nothing private is ever served under /_kit.
    res.writeHead(200, { 'content-type': KIT_TYPES[extname(m[1])], 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'cross-origin', 'access-control-allow-origin': '*',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=86400', 'content-length': body.length,
      ...(hit.gz ? { vary: 'accept-encoding' } : {}), ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  const siteApi = createSiteApi({ db, cfg, fetchImpl, limit });
  const API_HEADERS = { 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  async function siteApiRoute(req, res, p, site, url) {
    const reqId = token(6);
    try {
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');   // no CORS: OPTIONS is refused too
      // writes come from the site's own page (same origin; browsers send Origin on POST). No cookies exist here, so this
      // is not CSRF protection: it keeps other web pages from driving visitors' browsers at a site's tools.
      if (req.method === 'POST' && req.headers.origin !== site.origin) throw new HttpError(403, 'bad_origin', 'cross-site request refused');
      const body = req.method === 'POST' ? await readJson(req, 4_096) : null;
      const out = await siteApi({ project: p, site, method: req.method, path: url.pathname, ip: clientIp(req, cfg.trustProxy), query: url.searchParams, body });
      sendJson(res, 200, out.body, { ...API_HEADERS, 'cache-control': out.cache || 'no-store' });
    } catch (err) {
      for (const [k, v] of Object.entries(API_HEADERS)) res.setHeader(k, v);
      sendError(res, err, reqId);
    } finally {
      log.info('site-api', { reqId, slug: p.slug, method: req.method, path: url.pathname, status: res.statusCode });
    }
  }

  async function projectSite(req, res, host, url) {
    const path = url.pathname;
    const slug = host.slice(0, host.length - projectsHost.length - 1);
    const p = /^[a-z0-9-]{1,40}$/.test(slug) && projectBySlug(slug);
    const idea = p && db.get('SELECT visibility FROM ideas WHERE id = ?', p.idea_id);
    const ctx = { raw: (status, body, headers) => { res.writeHead(status, headers); res.end(body); } };
    if (!p || idea.visibility !== 'public' || !p.live_site_version) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    if (path.startsWith('/_kit/')) return serveKit(req, res, path);
    if (path.startsWith('/_api/')) return siteApiRoute(req, res, p, { host, origin: `${cfg.projectsScheme}://${host}` }, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' }); return res.end('method not allowed'); }
    try { serveSiteFile(ctx, p, p.live_site_version, path === '/' ? 'index.html' : path.slice(1), false); } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  }

  // --- static files ---------------------------------------------------------------------------------------------------
  // CITY_DIST set: the city client owns / (its index.html), /assets/* (hashed, immutable), and its brand files
  // (/brand/*, /manifest.webmanifest, cached an hour). A missing owned file is a 404; the rest is the launchpad's
  // (its home page moves to /launchpad).
  function serveCity(res, path) {
    if (!cfg.cityDist) return false;
    const root = normalize(cfg.cityDist);
    const dir = ['assets', 'brand'].find((d) => path.startsWith(`/${d}/`));
    const manifest = path === '/manifest.webmanifest';
    if (path !== '/' && !dir && !manifest) return false;
    let rel = 'index.html';
    if (path !== '/') {
      try { rel = decodeURIComponent(path.slice(1)); } catch { return false; }
    }
    const file = normalize(join(root, rel));
    const inside = dir ? file.startsWith(join(root, dir) + sep) : true;
    if (rel.includes('\0') || !inside || !existsSync(file) || !statSync(file).isFile()) {
      if (dir || manifest) { sendJson(res, 404, { error: 'not_found' }); return true; }
      return false;
    }
    const cache = path === '/' ? 'no-cache' : dir === 'assets' ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': cache });
    res.end(readFileSync(file));
    return true;
  }

  // 2026-10-10 the owner: the old launchpad pages must not show up any more. With the city deployed they bounce into
  // it with a hash the city understands (main.js applyHash); /admin keeps the old app (operators only).
  const CITY_LINKS = [
    [/^\/launchpad$/, () => '/'], [/^\/submit$/, () => '/#idea'], [/^\/ideas\/([^/]+)$/, (m) => `/#idea/${m[1]}`],
    [/^\/projects\/([^/]+)\/review$/, () => '/#room/pc'], [/^\/projects\/([^/]+)$/, (m) => `/#project/${m[1]}`],
    [/^\/token$/, () => '/#token'], [/^\/me$/, () => '/#account'], [/^\/fees$/, () => '/#about'], [/^\/how$/, () => '/#about'],
  ];
  function cityLink(path) {
    for (const [re, to] of CITY_LINKS) { const m = re.exec(path); if (m) return to(m); }
    return null;
  }
  function serveStatic(res, path) {
    if (serveCity(res, path)) return true;
    const to = cfg.cityDist ? cityLink(path) : null;
    if (to) { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); return true; }
    const file = normalize(join(PUBLIC, path === '/' || PAGES.some((re) => re.test(path)) ? 'index.html' : path));
    if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache' });
    res.end(readFileSync(file));
    return true;
  }

  handle.chat = chat;                                         // tests and server shutdown
  handle.kicker = kicker;                                     // tests: await kicker.idle() for the verdict
  return handle;
  async function handle(req, res) {
    const reqId = token(6);
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    const host = String(req.headers.host || '').toLowerCase();
    try {
      if (host.endsWith(`.${projectsHost}`)) return await projectSite(req, res, host, url);
      if (url.pathname.startsWith('/_kit/')) return serveKit(req, res, url.pathname);
      securityHeaders(res, appCsp);
      const route = r.match(req.method, url.pathname);
      if (!route) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(res, url.pathname)) return;
        return sendJson(res, 404, { error: 'not_found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // state-changing requests must come from our own pages
        const o = req.headers.origin;
        if (o !== origin.origin) throw new HttpError(403, 'bad_origin', 'cross-site request refused');
        if (url.pathname !== '/api/telemetry' && !url.pathname.startsWith('/api/chat')) worldCache = null;   // a write may change the city; the next read rebuilds it
      }
      const cookies = parseCookies(req.headers.cookie);
      const ip = clientIp(req, cfg.trustProxy);
      const ctx = {
        req, res, params: route.params, query: url.searchParams, cookies, ip,
        user: sessionUser(db, cookies[COOKIE]),
        body: (lim) => readJson(req, lim || route.opts.bodyLimit || 64_000),
        setCookie: (c) => res.setHeader('set-cookie', c),
        raw: (status, body, headers) => { res.writeHead(status, headers); res.end(body); return RAW; },
        redirect: (to) => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); return RAW; },
      };
      // presence fixes come every ~2 s while a resident walks: their own rule, not the 60/min of real writes
      limit(req.method === 'GET' ? 'read' : url.pathname === '/api/presence' ? 'presence' : 'write', ctx.user?.wallet || ip);
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
