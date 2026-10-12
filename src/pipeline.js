// Stage handlers for the job queue. Each handler re-reads state first (so duplicate delivery is a no-op), writes its
// output with unique keys, moves the idea through states.js, and reports progress in plain words.
import { audit, isPaused } from './db.js';
import { Defer, Permanent, enqueue, POLICIES } from './jobs.js';
import { buildFeedback, polishFeedback } from './feedback.js';
import { log } from './log.js';
import { transition, note } from './states.js';
import { currentVersion } from './ideas.js';
import { askBrain } from './brain.js';
import { appendVote } from './trust.js';
import { settlePredictions } from './rituals.js';
import { preGate, scores, SCORECARD_VERSION } from './scorecard.js';
import { generate, estimateCostUsd , networkLabel, submitterLabel } from './generator.js';
import { rewriteCopy } from './rewrite.js';
import { logoPng, bannerSvg } from './art.js';
import { makeCoinArt, slugBase } from './coinart.js';
import { bannerCredit } from './site.js';
import { buildSiteVersion } from './site.js';
import { publishSite } from './site-qa.js';
import { planAccount, publishPost } from './x.js';
import { buildLaunchConfig, configHash, confirmIntent, confirmDevBuy, reconcileFees, defaultAllocation, draftAllocation } from './launch.js';
import { canSpend, recordSpend } from './budget.js';
import { refreshCoinStats } from './coin-stats.js';
import { childBuild, afterLaunched } from './child-launch.js';
import { id, now, sha256, parseJson } from './util.js';
import { buildRecorder, artOutcome, qaOutcome, PROVIDERS } from './build-steps.js';

const BRAIN_WAIT = { asleep: 20 * 60_000 };
// brain offline: short retries first (the author is watching), then the job policy's minutes
export const UNAVAILABLE_BACKOFF = [5_000, 15_000, 60_000];
const POLISH_TIMEOUT_MS = 12_000;

/** What the city hears the moment a verdict lands (app.js forwards it over the chat stream; SSE `verdict`). */
function tellVerdict(ctx, { ideaId, version, decision, requestId, feedback, latencyMs }) {
  if (typeof ctx.onVerdict !== 'function') return;
  try {
    ctx.onVerdict({ ideaId, version, decision, verdict: decision === 'selected' ? 'build' : 'pass', requestId, summary: feedback.summary, latencyMs, at: now() });
  } catch (e) { log.error('onVerdict failed', e); }
}

export const handlers = {
  async evaluate(ctx) {
    const { db, cfg, payload } = ctx;
    const ideaId = ctx.job.idea_id;
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
    if (!idea || !['submitted', 'evaluating'].includes(idea.status)) return { skipped: `idea is ${idea?.status}` };
    if (isPaused(db, 'evaluation')) throw new Defer('evaluation paused by an admin', 10 * 60_000);
    if (idea.status === 'submitted') transition(db, ideaId, 'submitted', 'evaluating', { note: 'reading it' });
    const v = currentVersion(db, ideaId);
    const others = db.all(`SELECT i.id, i.visibility, v.title, v.concept FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
                           WHERE i.id != ? AND i.created_at <= ?`, ideaId, idea.created_at);
    const input = { title: v.title, concept: v.concept, nameSuggestion: v.name_suggestion, tickerSuggestion: v.ticker_suggestion };
    const pre = preGate(input, others);
    const requestId = `${ideaId}.v${v.version}`;
    const latency = () => Math.max(0, now() - v.created_at);       // from the drop of this version to the verdict
    if (pre.declined) {
      const feedback = buildFeedback({ input, pre, rec: null, decision: 'declined', others });
      const latencyMs = latency();
      db.tx(() => {
        db.run(`INSERT INTO evaluations (id, idea_id, idea_version, scorecard_version, brain_request_id, brain_json, scores_json, decision, decided_by, created_at, feedback_json, latency_ms)
                VALUES (?, ?, ?, ?, ?, 'null', ?, 'declined', ?, ?, ?, ?) ON CONFLICT(idea_id, idea_version) DO NOTHING`,
        id('eval'), ideaId, v.version, SCORECARD_VERSION, requestId, JSON.stringify(scores(pre, null)), pre.declined.decidedBy, now(), JSON.stringify(feedback), latencyMs);
        transition(db, ideaId, 'evaluating', 'declined', { actor: 'system', note: `declined by rule before reaching SUB-01: ${pre.declined.why}` });
      });
      tellVerdict(ctx, { ideaId, version: v.version, decision: 'declined', requestId, feedback, latencyMs });
      return { decision: 'declined', by: pre.declined.decidedBy, latencyMs };
    }
    ctx.progress('asking SUB-01\'s brain');
    const ans = await askBrain(cfg, { requestId, title: v.title, concept: v.concept }, { signal: ctx.signal, fetchImpl: ctx.fetchImpl });
    if (ans.kind === 'asleep') {
      note(db, ideaId, `SUB-01 is asleep (${ans.stage}). Your idea waits by his bed; he reads it when he wakes.`, { actor: 'brain',
        data: { retry_at: now() + BRAIN_WAIT.asleep } });
      throw new Defer(`brain asleep (${ans.stage})`, BRAIN_WAIT.asleep);
    }
    if (ans.kind === 'unavailable') {
      const delay = UNAVAILABLE_BACKOFF[Math.max(0, ctx.job.attempts - 1)] ?? POLICIES.evaluate.backoff(ctx.job.attempts);
      const inS = Math.round(delay / 1000);
      note(db, ideaId, `SUB-01 is offline right now (${ans.reason}). Your idea waits by his door; he reads it the moment he is back. ` +
        `Next try in ${inS < 90 ? `${inS} s` : `${Math.round(inS / 60)} min`}. Nothing has been decided; no other system decides for him.`,
      { actor: 'system', data: { retry_at: now() + delay } });
      throw new Defer(`brain unavailable: ${ans.reason}`, delay);
    }
    const rec = ans.record;
    const decision = rec.decision === 'build' ? 'selected' : 'declined';
    const feedback = buildFeedback({ input, pre, rec, decision, others });
    const latencyMs = latency();
    let evalId = null;
    db.tx(() => {
      const ins = db.run(`INSERT INTO evaluations (id, idea_id, idea_version, scorecard_version, brain_request_id, brain_json, scores_json, decision, decided_by, created_at, feedback_json, latency_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'brain_vote', ?, ?, ?) ON CONFLICT(idea_id, idea_version) DO NOTHING`,
      id('eval'), ideaId, v.version, SCORECARD_VERSION, requestId, JSON.stringify(rec), JSON.stringify(scores(pre, rec)), decision, now(), JSON.stringify(feedback), latencyMs);
      // the public vote ledger: one hash-chained row per brain answer, in the same transaction (trust.js)
      if (ins.changes === 1) {
        appendVote(db, { requestId, title: v.title, concept: v.concept, version: v.version, rec });
        settlePredictions(db, ideaId, rec.decision === 'build' ? 'build' : 'pass');   // residents' guesses, scored in this transaction
      }
      const stored = db.get('SELECT id, decision FROM evaluations WHERE idea_id = ? AND idea_version = ?', ideaId, v.version);
      evalId = stored.id;
      const build = rec.vote.options.find((o) => o.label.startsWith('build'));
      transition(db, ideaId, 'evaluating', stored.decision, { actor: 'brain',
        note: `brain vote: ${stored.decision === 'selected' ? 'build' : 'pass'} (build ${Math.round(build.p * 100)}%, ${rec.vote.spiking?.used ? networkLabel(rec.vote.spiking) : 'rate model'})${rec.demo ? ' [brain in demo mode]' : ''}`,
        data: { request_id: requestId } });
      // a coin launched from another coin's site (child-launch.js) is built from what its creator signed
      if (stored.decision === 'selected') {
        const child = db.get('SELECT 1 FROM child_launches WHERE idea_id = ?', ideaId);
        enqueue(db, child ? { type: 'child_build', key: `child:${ideaId}:1`, ideaId, payload: {} } : { type: 'generate', key: `generate:${ideaId}:1`, ideaId, payload: {} });
      }
    });
    tellVerdict(ctx, { ideaId, version: v.version, decision, requestId, feedback, latencyMs });
    // the optional language-model polish, after the verdict is out: capped, never a reason to fail the job
    if (cfg.generator.provider === 'anthropic' && evalId) {
      ctx.progress('polishing the feedback');
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(POLISH_TIMEOUT_MS)]);
      const polish = await polishFeedback(db, cfg, { evaluationId: evalId, idea: v, signal, fetchImpl: ctx.fetchImpl, jobId: ctx.job.id });
      if (!polish.done) log.info('feedback not polished', { idea: ideaId, why: polish.why });
      return { decision, latencyMs, polished: polish.done };
    }
    return { decision, latencyMs };
  },

  async generate(ctx) {
    const { db, cfg } = ctx;
    const ideaId = ctx.job.idea_id;
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
    if (!idea || !['selected', 'generating'].includes(idea.status)) return { skipped: `idea is ${idea?.status}` };
    if (isPaused(db, 'generation')) throw new Defer('generation paused by an admin', 10 * 60_000);
    const active = db.get(`SELECT COUNT(*) n FROM ideas WHERE status = 'generating' AND id != ?`, ideaId).n;
    if (idea.status === 'selected' && active >= cfg.budgets.maxActiveGenerations) throw new Defer('other projects are being built; queued', 5 * 60_000);
    const existing = db.get('SELECT * FROM projects WHERE idea_id = ?', ideaId);
    const est = estimateCostUsd(cfg);
    const budget = canSpend(db, cfg, existing?.id ?? null, est);
    if (!budget.ok) { note(db, ideaId, `queued: ${budget.why}`); throw new Defer(budget.why, 60 * 60_000); }
    if (idea.status === 'selected') transition(db, ideaId, 'selected', 'generating', { actor: 'system', note: 'SUB-01 starts building' });
    const v = currentVersion(db, ideaId);
    const evaluation = db.get(`SELECT * FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, ideaId);
    const brain = parseJson(evaluation.brain_json);
    // the build timeline the author watches (build-steps.js): observed and recorded, never a reason to fail
    const steps = buildRecorder(db, ctx.job, { cfg, progress: ctx.progress });
    steps.begin();
    ctx.progress('composing the app');
    const out = await generate({ idea: v, brain, cfg, signal: ctx.signal, fetchImpl: ctx.fetchImpl, submitter: submitterLabel(db, idea.owner_wallet), observe: steps.observe });
    const spec = out.spec;
    // the coin art (coinart.js): two black-and-white candidates, drawn before the transaction (providers are slow);
    // a provider problem ends in the local drawing, only a missing renderer falls back to the old procedural art
    ctx.progress('drawing the logo and banner');
    steps.start('art', PROVIDERS.art(cfg));
    let art = null;
    const artSpend = [];
    try {
      art = await makeCoinArt({ cfg, idea: v, spec, slug: existing?.slug || slugBase(spec.name), wallet: idea.owner_wallet, seed: `${ideaId}:${evaluation.id}`,
        credit: bannerCredit(cfg), fetchImpl: ctx.fetchImpl, signal: ctx.signal, spend: (usd) => artSpend.push(usd) });
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      log.error('coin art failed; using the procedural art', e);
    }
    steps.done('art', artOutcome(art, cfg));
    const t = now();
    const project = db.tx(() => {
      let p = existing;
      if (!p) {
        const slug = uniqueSlug(db, spec.name);
        const pid = id('prj');
        db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          pid, ideaId, slug, spec.name, spec.ticker, spec.description, t, t);
        p = db.get('SELECT * FROM projects WHERE id = ?', pid);
        db.run(`INSERT INTO project_roles (project_id, wallet, role, granted_by, granted_at) VALUES (?, ?, 'founder', 'system', ?)
                ON CONFLICT DO NOTHING`, pid, idea.owner_wallet, t);
      }
      const gv = (db.get('SELECT MAX(version) v FROM generations WHERE project_id = ?', p.id)?.v || 0) + 1;
      db.run(`INSERT INTO generations (id, project_id, version, generator, input_json, output_json, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id('gen'), p.id, gv, out.generator, JSON.stringify({ idea_version: v.version, evaluation: evaluation.id }), JSON.stringify(spec), out.costUsd, t);
      if (out.costUsd > 0) recordSpend(db, { projectId: p.id, kind: 'generation', usd: out.costUsd, jobId: ctx.job.id });
      const insertAsset = (kind, mime, body, generator) => {
        const av = (db.get('SELECT MAX(version) v FROM assets WHERE project_id = ? AND kind = ?', p.id, kind)?.v || 0) + 1;
        const aid = id('asset');
        db.run(`INSERT INTO assets (id, project_id, kind, version, mime, body, sha256, generator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          aid, p.id, kind, av, mime, body, sha256(body), generator, t);
        return aid;
      };
      if (art) {
        // option 2 first, option 1 last: the newest version of each kind is the live one, so option 1 is the default
        for (const idx of [1, 0]) {
          const c = art.candidates[idx];
          const logoId = insertAsset('logo', c.logo.mime, c.logo.body, c.logo.generator);
          const bannerId = insertAsset('banner', c.banner.mime, c.banner.body, c.banner.generator);
          db.run(`INSERT INTO art_candidates (project_id, idx, logo_asset_id, banner_asset_id, created_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(project_id, idx) DO UPDATE SET logo_asset_id = excluded.logo_asset_id, banner_asset_id = excluded.banner_asset_id, created_at = excluded.created_at`,
          p.id, idx, logoId, bannerId, t);
        }
        db.run('UPDATE projects SET art_choice = NULL WHERE id = ?', p.id);
        const usd = artSpend.reduce((a, b) => a + b, 0);
        if (usd > 0) recordSpend(db, { projectId: p.id, kind: 'art', usd, jobId: ctx.job.id });
      } else {
        const seed = `${p.id}:${evaluation.id}`;
        const build = brain.vote.options.find((o) => o.label.startsWith('build'));
        insertAsset('logo', 'image/png', logoPng({ networks: brain.networks, seed, strength: build?.p }), 'art/1 (from the brain record)');
        insertAsset('banner', 'image/svg+xml', Buffer.from(bannerSvg({ name: spec.name, ticker: spec.ticker, tagline: spec.tagline, networks: brain.networks, seed, credit: bannerCredit(cfg) })), 'art/1 (from the brain record)');
      }
      planAccount(db, p.id, spec);
      if (!db.get(`SELECT 1 FROM fee_allocations WHERE project_id = ? AND status IN ('draft','approved')`, p.id)) {
        draftAllocation(db, p.id, defaultAllocation(cfg, v.receiving_wallet), 'system');
      }
      audit(db, { actor: 'generator', kind: 'generation', ideaId, projectId: p.id, isPublic: true,
        message: `Identity written by ${out.generator === 'template/1' ? 'the fixed template (no AI)' : out.generator}${out.fallback ? ` (the language model failed: ${out.fallback.slice(0, 120)})` : ''}; ${artLine(art)}` });
      return p;
    });
    ctx.progress('building the website in the sandbox');
    steps.start('site', PROVIDERS.site(cfg));
    const site = await buildSiteVersion(db, cfg, project, spec, 'system');
    steps.done('site', { note: `version ${site.version} built and passed the safety check` });
    steps.start('qa', PROVIDERS.qa(cfg));
    const pub = await publishSite(db, cfg, project, site.version, 'system');   // the first version goes live; the QA report rides along
    steps.done('qa', qaOutcome(pub.qa));
    transition(db, ideaId, 'generating', 'preview_ready', { actor: 'system', note: 'preview ready: review the site, the X drafts and the fee split' });
    steps.done('ready');
    return { project: project.id, site: site.version, qa: pub.qa?.line };
  },

  child_build: (ctx) => childBuild(ctx),

  // "Ask SUB-01 to rewrite" (rewrite.js): the copy again for the app the site has now, through the QA gate
  rewrite_copy: (ctx) => rewriteCopy(ctx),

  async build_site(ctx) {
    const { db, cfg } = ctx;
    const project = db.get('SELECT * FROM projects WHERE id = ?', ctx.job.project_id);
    if (!project) throw new Permanent('project not found');
    const last = db.get(`SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?`, project.id, project.live_site_version);
    const site = await buildSiteVersion(db, cfg, project, parseJson(last.spec_json), 'system');
    const pub = await publishSite(db, cfg, project, site.version, 'system');
    return { version: site.version, live: pub.live, qa: pub.qa?.line };
  },

  // SUB-01's QA of the live version again (site-qa.js): after a boot refresh, or asked for; the version stays live
  async site_qa(ctx) {
    const { db, cfg } = ctx;
    const project = db.get('SELECT * FROM projects WHERE id = ?', ctx.job.project_id);
    if (!project?.live_site_version) return { skipped: 'nothing live' };
    const pub = await publishSite(db, cfg, project, project.live_site_version, 'system:qa');
    return { version: project.live_site_version, qa: pub.qa?.line };
  },

  async prepare_launch(ctx) {
    const { db, cfg } = ctx;
    const project = db.get('SELECT * FROM projects WHERE id = ?', ctx.job.project_id);
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', project.idea_id);
    if (idea.status !== 'approved') return { skipped: `idea is ${idea.status}` };
    if (!project.submitter_approved_at || (cfg.launch.requireAdminClearance && !project.admin_cleared_at)) {
      throw new Permanent('approval or reviewer clearance was withdrawn after approval; reopen and approve again');
    }
    if (isPaused(db, 'launch')) throw new Defer('launches paused by an admin', 10 * 60_000);
    ctx.progress('reading the launch program\'s current parameters');
    const config = await buildLaunchConfig(db, cfg, project);
    db.tx(() => {
      // the author may change the dev buy while this job reads the chain: the stored configuration must match the row
      const fresh = db.get('SELECT initial_buy_lamports FROM projects WHERE id = ?', project.id);
      if (Number(fresh?.initial_buy_lamports ?? 0) !== config.initialBuyLamports) throw new Defer('the dev buy changed while preparing; building the configuration again', 500);
      db.run('UPDATE projects SET launch_config_json = ?, launch_config_hash = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(config), configHash(config), now(), project.id);
      transition(db, idea.id, 'approved', 'launch_prepared', { actor: 'system',
        note: config.mock ? 'MOCK launch configuration ready for review' : `launch configuration ready (${config.providerLabel})` });
    });
    return { provider: config.provider, network: config.network };
  },

  async confirm_launch(ctx) {
    const out = await confirmIntent(ctx.db, ctx.cfg, ctx.payload.intentId, ctx.progress);
    if (out.state === 'launched') await afterLaunched(ctx.db, ctx.cfg, ctx.job.project_id);    // a child launch: the parent's registry
    return out;
  },

  async confirm_dev_buy(ctx) {
    return confirmDevBuy(ctx.db, ctx.cfg, ctx.payload.attemptId, ctx.progress);
  },

  async reconcile_fees(ctx) {
    return reconcileFees(ctx.db, ctx.cfg, ctx.job.project_id);
  },

  async publish_x_post(ctx) {
    return publishPost(ctx.db, ctx.cfg, ctx.payload.postId, ctx.fetchImpl);
  },

  async coin_stats(ctx) {
    return refreshCoinStats(ctx.db, ctx.cfg, ctx.payload.mint, { fetchImpl: ctx.fetchImpl, signal: ctx.signal });
  },
};

/** The audit line about the art: who drew the two options and what fell back. */
function artLine(art) {
  if (!art) return 'art drawn from the brain record (the black-and-white renderer was unavailable)';
  const who = { 'owner-supplied': "the owner's own art", local: 'the local generator (no AI)', higgsfield: 'Higgsfield', recraft: 'Recraft' };
  const sym = art.symbol.abstract ? `an abstract ${art.symbol.id}` : `a ${art.symbol.id} for "${art.symbol.keyword}"`;
  return `two logo options (${art.provider.map((p, i) => `${i + 1}: ${who[p] || p}`).join(', ')}), symbol ${sym}${art.notes.length ? `; ${art.notes.join('; ')}` : ''}`;
}

export function uniqueSlug(db, name) {
  const base = slugBase(name);
  let slug = base, n = 1;
  const reserved = new Set(['www', 'api', 'admin', 'app', 'mail', 'sub01', 'sub-01', 'subzerone', 'launchpad', 'static', 'meta']);
  while (reserved.has(slug) || db.get('SELECT 1 FROM projects WHERE slug = ?', slug)) slug = `${base}-${++n}`;
  return slug;
}

/** When a job runs out of attempts: say so on the idea, plainly. */
/** Builds that died only because a provider key or setting was wrong (HTTP 400/401/403 from the language model,
 *  e.g. an organization key without its workspace, 2026-10-12) are retried once the server restarts with the fix:
 *  the idea goes back to "selected" and its generate job is queued again. Only the last 48 h; each job once. */
export function recoverConfigFailedBuilds(db, t = Date.now()) {
  const rows = db.all(`SELECT j.id job_id, j.idea_id FROM jobs j JOIN ideas i ON i.id = j.idea_id
    WHERE j.type = 'generate' AND j.status = 'dead' AND j.updated_at > ? AND i.status = 'failed'
      AND (j.last_error LIKE 'generator HTTP 40%' OR j.last_error LIKE 'composer HTTP 40%')
      AND COALESCE(j.result_json, '') NOT LIKE '%"recovered":true%'`, t - 48 * 3_600_000);
  let n = 0;
  for (const r of rows) {
    db.tx(() => {
      transition(db, r.idea_id, 'failed', 'selected', { actor: 'system', note: 'building again: the language model settings were fixed' });
      db.run(`UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, last_error = NULL, result_json = '{"recovered":true}', updated_at = ? WHERE id = ?`, t, t, r.job_id);
    });
    n++;
  }
  return n;
}

export function onDead(db, job) {
  if (!job.idea_id) return;
  const idea = db.get('SELECT status FROM ideas WHERE id = ?', job.idea_id);
  if (!idea) return;
  const why = String(job.last_error || '').slice(0, 160);
  if (job.type === 'evaluate' && idea.status === 'evaluating') {
    transition(db, job.idea_id, 'evaluating', 'failed', { note: `evaluation unavailable: SUB-01's brain did not answer (${why}). Nothing was decided.` });
  } else if ((job.type === 'generate' || job.type === 'child_build') && ['generating', 'selected'].includes(idea.status)) {
    transition(db, job.idea_id, ['generating', 'selected'], 'failed', { note: `building failed: ${why}` });
  } else if (job.type === 'confirm_launch') {
    note(db, job.idea_id, 'not confirmed yet; the network is still being checked every few minutes', { actor: 'system' });
  } else if (job.type === 'confirm_dev_buy') {
    note(db, job.idea_id, 'the dev buy is not confirmed yet; the network is still being checked every few minutes', { actor: 'system' });
  } else if (job.type === 'prepare_launch' && idea.status === 'approved') {
    // the author reads this on the Launch tab (a dev buy that does not fit, a cap lowered since, …) and changes the option
    note(db, job.idea_id, `the launch configuration could not be prepared: ${why}`, { actor: 'system' });
  } else {
    audit(db, { actor: 'system', kind: 'dead_job', ideaId: job.idea_id, message: `${job.type} stopped: ${why}` });
  }
}
