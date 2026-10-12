// "Ask SUB-01 to rewrite" (the room PC's Site tab): the author asks for the copy of an existing coin again, written with
// today's brief (generator.js rewriteSpec / writeCopy) for the app and tools the live site has NOW. The name and the
// ticker stay. Same window as the logo choice (art-choice.js): owner only, preview_ready / approved / launch_prepared,
// before any launch transaction; 3 requests a day per project (counted on the jobs table, so restarts do not reset it).
// A job (rewrite_copy) does the work: the copy (the template on any model problem, said in the result), a new site
// version through SUB-01's QA (site-qa.js), the X drafts, and, like the art choice, a launch configuration prepared
// again when the project has one (its token metadata carries the description).
import { audit } from './db.js';
import { enqueue, Permanent } from './jobs.js';
import { transition } from './states.js';
import { artLock } from './art-choice.js';
import { currentVersion } from './ideas.js';
import { recordSpend } from './budget.js';
import { HttpError, id, now, parseJson } from './util.js';

export const REWRITES_PER_DAY = 3;
const DAY = 86_400_000;
const OPEN = `SELECT * FROM jobs WHERE type = 'rewrite_copy' AND project_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`;
const recent = (db, projectId, t) => db.all(`SELECT created_at FROM jobs WHERE type = 'rewrite_copy' AND project_id = ? AND created_at > ? ORDER BY created_at`, projectId, t - DAY);

/** POST /api/projects/:slug/rewrite (owner). -> {queued, jobId, key, left, already?} */
export function requestRewrite(db, project, idea, wallet, t = now()) {
  if (idea.owner_wallet !== wallet) throw new HttpError(403, 'not_owner');
  const lock = artLock(db, project, idea);
  if (lock) throw new HttpError(409, 'locked', `the copy can no longer change: ${lock}`);
  if (!project.live_site_version) throw new HttpError(409, 'no_site', 'nothing is live yet');
  const open = db.get(OPEN, project.id);
  if (open) return { queued: true, jobId: open.id, key: open.idempotency_key, already: true, left: Math.max(0, REWRITES_PER_DAY - recent(db, project.id, t).length) };
  const done = recent(db, project.id, t);
  if (done.length >= REWRITES_PER_DAY) {
    const retryAfterS = Math.ceil((done[0].created_at + DAY - t) / 1000);
    throw new HttpError(429, 'rewrite_limit', `${REWRITES_PER_DAY} rewrites a day: the next one in about ${Math.max(1, Math.round(retryAfterS / 3600))} h`, { retryAfterS });
  }
  const job = enqueue(db, { type: 'rewrite_copy', key: `rewrite:${project.id}:${t}`, ideaId: idea.id, projectId: project.id, payload: { by: wallet } });
  return { queued: true, jobId: job.id, key: job.idempotency_key, left: REWRITES_PER_DAY - done.length - 1 };
}

/** GET /api/projects/:slug/rewrite (owner): the latest request and how many are left today. */
export function rewriteView(db, project, idea, t = now()) {
  const j = db.get(`SELECT * FROM jobs WHERE type = 'rewrite_copy' AND project_id = ? ORDER BY created_at DESC LIMIT 1`, project.id);
  const result = j ? parseJson(j.result_json, null) : null;
  const lock = artLock(db, project, idea);
  return {
    allowed: !lock && Boolean(project.live_site_version), lockedWhy: lock, perDay: REWRITES_PER_DAY,
    left: Math.max(0, REWRITES_PER_DAY - recent(db, project.id, t).length),
    last: j && {
      state: { queued: 'queued', running: 'running', succeeded: result?.skipped ? 'skipped' : 'done', dead: 'failed', failed: 'failed', cancelled: 'failed' }[j.status] || j.status,
      progress: j.progress || null, at: j.created_at, updatedAt: j.updated_at,
      version: result?.version ?? null, live: result?.live ?? null, qa: result?.qa ?? null, generator: result?.generator ?? null,
      fallback: result?.fallback ?? null, skipped: result?.skipped ?? null, error: j.status === 'dead' ? String(j.last_error || '').slice(0, 200) : null,
    },
    liveSiteVersion: project.live_site_version,
  };
}

/** The rewrite_copy job. */
export async function rewriteCopy(ctx) {
  const { db, cfg } = ctx;
  const project = db.get('SELECT * FROM projects WHERE id = ?', ctx.job.project_id);
  const idea = project && db.get('SELECT * FROM ideas WHERE id = ?', project.idea_id);
  if (!project || !idea) throw new Permanent('project not found');
  const lock = artLock(db, project, idea);
  if (lock) return { skipped: lock };
  const { liveSpec } = await import('./tool-api.js');
  const spec = liveSpec(db, project);
  if (!spec) throw new Permanent('nothing is live');
  const { rewriteSpec, submitterLabel } = await import('./generator.js');
  const { buildSiteVersion } = await import('./site.js');
  const { publishSite } = await import('./site-qa.js');
  const { replanDrafts } = await import('./x.js');
  const v = currentVersion(db, idea.id);
  const brain = parseJson(db.get(`SELECT brain_json FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, idea.id)?.brain_json, {});
  ctx.progress?.('SUB-01 rewrites the copy');
  const out = await rewriteSpec({ idea: v, brain, spec, cfg, signal: ctx.signal, fetchImpl: ctx.fetchImpl, submitter: submitterLabel(db, idea.owner_wallet) });
  const by = String(ctx.payload?.by || idea.owner_wallet);
  db.tx(() => {
    const gv = (db.get('SELECT MAX(version) v FROM generations WHERE project_id = ?', project.id)?.v || 0) + 1;
    db.run(`INSERT INTO generations (id, project_id, version, generator, input_json, output_json, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id('gen'), project.id, gv, out.generator, JSON.stringify({ idea_version: v.version, rewrite: true, from_site_version: project.live_site_version, by: `wallet:${by}`, fallback: out.fallback }),
      JSON.stringify(out.spec), out.costUsd, now());
    if (out.costUsd > 0) recordSpend(db, { projectId: project.id, kind: 'generation', usd: out.costUsd, jobId: ctx.job.id });
  });
  ctx.progress?.('building the site and checking it');
  const site = await buildSiteVersion(db, cfg, project, out.spec, `wallet:${by}`);
  const pub = await publishSite(db, cfg, project, site.version, `wallet:${by}`);   // SUB-01's QA first (site-qa.js)
  let reprepared = false;
  db.tx(() => {
    const fresh = db.get('SELECT status FROM ideas WHERE id = ?', idea.id);
    if (pub.live) {
      replanDrafts(db, project.id, out.spec);
      db.run('UPDATE projects SET description = ?, updated_at = ? WHERE id = ?', out.spec.description, now(), project.id);
      if (fresh.status === 'preview_ready') db.run('UPDATE projects SET submitter_approved_at = NULL, admin_cleared_at = NULL, admin_cleared_by = NULL WHERE id = ?', project.id);
      // the token metadata names the description: a prepared configuration is built again (as after a logo change)
      let status = fresh.status;
      if (status === 'launch_prepared') {
        db.run('UPDATE projects SET launch_config_json = NULL, launch_config_hash = NULL WHERE id = ?', project.id);
        transition(db, idea.id, 'launch_prepared', 'approved', { actor: `wallet:${by}`, note: 'copy rewritten; preparing the launch configuration again' });
        status = 'approved';
        reprepared = true;
      }
      if (status === 'approved') enqueue(db, { type: 'prepare_launch', key: `prepare:${project.id}:rewrite:${ctx.job.id}`, ideaId: idea.id, projectId: project.id });
    }
    const who = out.generator === 'template/1' ? 'the fixed template (no AI)' : out.generator;
    audit(db, { actor: `wallet:${by}`, kind: 'rewrite', ideaId: idea.id, projectId: project.id, isPublic: true,
      message: `Copy rewritten by SUB-01 at the author's request, written by ${who}${out.fallback ? ' (the language model failed)' : ''}: site v${site.version}${pub.live ? '' : ', held back by the QA'}` });
  });
  return { version: site.version, live: pub.live, qa: pub.qa?.line ?? null, generator: out.generator, fallback: out.fallback, reprepared };
}
