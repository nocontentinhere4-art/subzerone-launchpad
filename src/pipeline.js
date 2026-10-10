// Stage handlers for the job queue. Each handler re-reads state first (so duplicate delivery is a no-op), writes its
// output with unique keys, moves the idea through states.js, and reports progress in plain words.
import { audit, isPaused } from './db.js';
import { Defer, Permanent, enqueue } from './jobs.js';
import { transition, note } from './states.js';
import { currentVersion } from './ideas.js';
import { askBrain } from './brain.js';
import { appendVote } from './trust.js';
import { preGate, scores, SCORECARD_VERSION } from './scorecard.js';
import { generate, estimateCostUsd } from './generator.js';
import { logoPng, bannerSvg } from './art.js';
import { buildSiteVersion, setLiveVersion } from './site.js';
import { planAccount, publishPost } from './x.js';
import { buildLaunchConfig, configHash, confirmIntent, reconcileFees, defaultAllocation, draftAllocation } from './launch.js';
import { canSpend, recordSpend } from './budget.js';
import { id, now, sha256, parseJson } from './util.js';

const BRAIN_WAIT = { asleep: 20 * 60_000 };

export const handlers = {
  async evaluate(ctx) {
    const { db, cfg, payload } = ctx;
    const ideaId = ctx.job.idea_id;
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
    if (!idea || !['submitted', 'evaluating'].includes(idea.status)) return { skipped: `idea is ${idea?.status}` };
    if (isPaused(db, 'evaluation')) throw new Defer('evaluation paused by an admin', 10 * 60_000);
    if (idea.status === 'submitted') transition(db, ideaId, 'submitted', 'evaluating', { note: 'reading it' });
    const v = currentVersion(db, ideaId);
    const others = db.all(`SELECT i.id, v.title, v.concept FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
                           WHERE i.id != ? AND i.created_at <= ?`, ideaId, idea.created_at);
    const input = { title: v.title, concept: v.concept, nameSuggestion: v.name_suggestion, tickerSuggestion: v.ticker_suggestion };
    const pre = preGate(input, others);
    const requestId = `${ideaId}.v${v.version}`;
    if (pre.declined) {
      db.tx(() => {
        db.run(`INSERT INTO evaluations (id, idea_id, idea_version, scorecard_version, brain_request_id, brain_json, scores_json, decision, decided_by, created_at)
                VALUES (?, ?, ?, ?, ?, 'null', ?, 'declined', ?, ?) ON CONFLICT(idea_id, idea_version) DO NOTHING`,
        id('eval'), ideaId, v.version, SCORECARD_VERSION, requestId, JSON.stringify(scores(pre, null)), pre.declined.decidedBy, now());
        transition(db, ideaId, 'evaluating', 'declined', { actor: 'system', note: `declined by rule before reaching SUB-01: ${pre.declined.why}` });
      });
      return { decision: 'declined', by: pre.declined.decidedBy };
    }
    ctx.progress('asking SUB-01\'s brain');
    const ans = await askBrain(cfg, { requestId, title: v.title, concept: v.concept }, { signal: ctx.signal, fetchImpl: ctx.fetchImpl });
    if (ans.kind === 'asleep') {
      note(db, ideaId, `SUB-01 is asleep (${ans.stage}). Your idea waits by his bed; he looks at it when he wakes.`, { actor: 'brain' });
      throw new Defer(`brain asleep (${ans.stage})`, BRAIN_WAIT.asleep);
    }
    if (ans.kind === 'unavailable') {
      note(db, ideaId, `Waiting for SUB-01's brain (${ans.reason}). Nothing has been decided; no other system decides for him.`, { actor: 'system' });
      throw new Defer(`brain unavailable: ${ans.reason}`);
    }
    const rec = ans.record;
    const decision = rec.decision === 'build' ? 'selected' : 'declined';
    db.tx(() => {
      const ins = db.run(`INSERT INTO evaluations (id, idea_id, idea_version, scorecard_version, brain_request_id, brain_json, scores_json, decision, decided_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'brain_vote', ?) ON CONFLICT(idea_id, idea_version) DO NOTHING`,
      id('eval'), ideaId, v.version, SCORECARD_VERSION, requestId, JSON.stringify(rec), JSON.stringify(scores(pre, rec)), decision, now());
      // the public vote ledger: one hash-chained row per brain answer, in the same transaction (trust.js)
      if (ins.changes === 1) appendVote(db, { requestId, title: v.title, concept: v.concept, version: v.version, rec });
      const stored = db.get('SELECT decision FROM evaluations WHERE idea_id = ? AND idea_version = ?', ideaId, v.version);
      const build = rec.vote.options.find((o) => o.label.startsWith('build'));
      transition(db, ideaId, 'evaluating', stored.decision, { actor: 'brain',
        note: `brain vote: ${stored.decision === 'selected' ? 'build' : 'pass'} (build ${Math.round(build.p * 100)}%, ${rec.vote.spiking?.network || 'rate model'})${rec.demo ? ' [brain in demo mode]' : ''}`,
        data: { request_id: requestId } });
      if (stored.decision === 'selected') enqueue(db, { type: 'generate', key: `generate:${ideaId}:1`, ideaId, payload: {} });
    });
    return { decision };
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
    ctx.progress('writing the project identity');
    const out = await generate({ idea: v, brain, cfg, signal: ctx.signal, fetchImpl: ctx.fetchImpl });
    const spec = out.spec;
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
      const seed = `${p.id}:${evaluation.id}`;
      const build = brain.vote.options.find((o) => o.label.startsWith('build'));
      const logo = logoPng({ networks: brain.networks, seed, strength: build?.p });
      const banner = Buffer.from(bannerSvg({ name: spec.name, ticker: spec.ticker, tagline: spec.tagline, networks: brain.networks, seed }));
      for (const [kind, mime, body] of [['logo', 'image/png', logo], ['banner', 'image/svg+xml', banner]]) {
        const av = (db.get('SELECT MAX(version) v FROM assets WHERE project_id = ? AND kind = ?', p.id, kind)?.v || 0) + 1;
        db.run(`INSERT INTO assets (id, project_id, kind, version, mime, body, sha256, generator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id('asset'), p.id, kind, av, mime, body, sha256(body), 'art/1 (from the brain record)', t);
      }
      planAccount(db, p.id, spec);
      if (!db.get(`SELECT 1 FROM fee_allocations WHERE project_id = ? AND status IN ('draft','approved')`, p.id)) {
        draftAllocation(db, p.id, defaultAllocation(cfg, v.receiving_wallet), 'system');
      }
      audit(db, { actor: 'generator', kind: 'generation', ideaId, projectId: p.id, isPublic: true,
        message: `Identity written by ${out.generator === 'template/1' ? 'the fixed template (no AI)' : out.generator}; art drawn from the brain record` });
      return p;
    });
    ctx.progress('building the website in the sandbox');
    const site = await buildSiteVersion(db, cfg, project, spec, 'system');
    setLiveVersion(db, project, site.version, 'system');
    transition(db, ideaId, 'generating', 'preview_ready', { actor: 'system', note: 'preview ready: review the site, the X drafts and the fee split' });
    return { project: project.id, site: site.version };
  },

  async build_site(ctx) {
    const { db, cfg } = ctx;
    const project = db.get('SELECT * FROM projects WHERE id = ?', ctx.job.project_id);
    if (!project) throw new Permanent('project not found');
    const last = db.get(`SELECT spec_json FROM site_versions WHERE project_id = ? AND version = ?`, project.id, project.live_site_version);
    const site = await buildSiteVersion(db, cfg, project, parseJson(last.spec_json), 'system');
    setLiveVersion(db, project, site.version, 'system');
    return { version: site.version };
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
      db.run('UPDATE projects SET launch_config_json = ?, launch_config_hash = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(config), configHash(config), now(), project.id);
      transition(db, idea.id, 'approved', 'launch_prepared', { actor: 'system',
        note: config.mock ? 'MOCK launch configuration ready for review' : `launch configuration ready (${config.providerLabel})` });
    });
    return { provider: config.provider, network: config.network };
  },

  async confirm_launch(ctx) {
    return confirmIntent(ctx.db, ctx.cfg, ctx.payload.intentId, ctx.progress);
  },

  async reconcile_fees(ctx) {
    return reconcileFees(ctx.db, ctx.cfg, ctx.job.project_id);
  },

  async publish_x_post(ctx) {
    return publishPost(ctx.db, ctx.cfg, ctx.payload.postId, ctx.fetchImpl);
  },
};

function uniqueSlug(db, name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'project';
  let slug = base, n = 1;
  const reserved = new Set(['www', 'api', 'admin', 'app', 'mail', 'sub01', 'sub-01', 'subzerone', 'launchpad', 'static', 'meta']);
  while (reserved.has(slug) || db.get('SELECT 1 FROM projects WHERE slug = ?', slug)) slug = `${base}-${++n}`;
  return slug;
}

/** When a job runs out of attempts: say so on the idea, plainly. */
export function onDead(db, job) {
  if (!job.idea_id) return;
  const idea = db.get('SELECT status FROM ideas WHERE id = ?', job.idea_id);
  if (!idea) return;
  const why = String(job.last_error || '').slice(0, 160);
  if (job.type === 'evaluate' && idea.status === 'evaluating') {
    transition(db, job.idea_id, 'evaluating', 'failed', { note: `evaluation unavailable: SUB-01's brain did not answer (${why}). Nothing was decided.` });
  } else if (job.type === 'generate' && ['generating', 'selected'].includes(idea.status)) {
    transition(db, job.idea_id, ['generating', 'selected'], 'failed', { note: `building failed: ${why}` });
  } else if (job.type === 'confirm_launch') {
    note(db, job.idea_id, 'not confirmed yet; the network is still being checked every few minutes', { actor: 'system' });
  } else {
    audit(db, { actor: 'system', kind: 'dead_job', ideaId: job.idea_id, message: `${job.type} stopped: ${why}` });
  }
}
