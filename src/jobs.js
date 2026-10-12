// Durable job queue in SQLite. A job is claimed with a lease; a crashed worker's lease expires and the job runs again.
// Every job has an idempotency key (enqueue twice = one job) and handlers re-check state before acting, so a duplicate
// delivery is harmless. Failures retry with backoff up to max_attempts, then the job is dead (the dead-letter list).
import { audit } from './db.js';
import { id, now, parseJson } from './util.js';
import { log } from './log.js';

/** Expected waits (brain asleep, indexing delay): retry later without it being an error. Still counts as an attempt. */
export class Defer extends Error {
  constructor(message, delayMs) { super(message); this.delayMs = delayMs; }
}
/** Do not retry: the input is wrong or a rule forbids it. */
export class Permanent extends Error {}

const backoff = (base, cap) => (attempt) => Math.min(cap, base * 2 ** Math.max(0, attempt - 1));

export const POLICIES = {
  evaluate: { maxAttempts: 60, timeoutMs: 45_000, backoff: backoff(60_000, 30 * 60_000) },
  generate: { maxAttempts: 3, timeoutMs: 180_000, backoff: backoff(30_000, 10 * 60_000) },
  build_site: { maxAttempts: 3, timeoutMs: 240_000, backoff: backoff(10_000, 60_000) },   // the build + SUB-01's QA (site-qa.js)
  child_build: { maxAttempts: 3, timeoutMs: 240_000, backoff: backoff(10_000, 5 * 60_000) },   // child-launch.js childBuild (+ SUB-01's QA)
  site_qa: { maxAttempts: 2, timeoutMs: 120_000, backoff: backoff(60_000, 10 * 60_000) },
  prepare_launch: { maxAttempts: 3, timeoutMs: 30_000, backoff: backoff(10_000, 60_000) },
  confirm_launch: { maxAttempts: 40, timeoutMs: 30_000, backoff: backoff(5_000, 60_000) },
  confirm_dev_buy: { maxAttempts: 40, timeoutMs: 30_000, backoff: backoff(5_000, 60_000) },   // launch.js confirmDevBuy (tx2)
  reconcile_fees: { maxAttempts: 5, timeoutMs: 30_000, backoff: backoff(60_000, 30 * 60_000) },
  publish_x_post: { maxAttempts: 3, timeoutMs: 20_000, backoff: backoff(30_000, 5 * 60_000) },
  // coin-stats.js: a failed fetch keeps the last good value, the next cadence slot tries again (so few attempts; the
  // attempts mostly absorb DexScreener pacing deferrals)
  coin_stats: { maxAttempts: 8, timeoutMs: 45_000, backoff: backoff(5_000, 60_000) },
};

export function enqueue(db, { type, key, ideaId = null, projectId = null, payload = {}, runAfter = now() }) {
  const p = POLICIES[type];
  if (!p) throw new Error(`unknown job type ${type}`);
  const jobId = id('job');
  const t = now();
  db.run(`INSERT INTO jobs (id, type, idempotency_key, idea_id, project_id, payload_json, status, max_attempts,
            timeout_ms, run_after, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
          ON CONFLICT(idempotency_key) DO NOTHING`,
  jobId, type, key, ideaId, projectId, JSON.stringify(payload), p.maxAttempts, p.timeoutMs, runAfter, t, t);
  return db.get('SELECT * FROM jobs WHERE idempotency_key = ?', key);
}

/** Expired leases go back to the queue (or to dead when out of attempts). */
export function reap(db, t = now()) {
  const stale = db.all("SELECT * FROM jobs WHERE status = 'running' AND lease_until < ?", t);
  for (const j of stale) {
    if (j.attempts >= j.max_attempts) {
      db.run("UPDATE jobs SET status = 'dead', last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
        'lease expired on the last attempt (worker crashed or timed out)', t, j.id);
    } else {
      db.run("UPDATE jobs SET status = 'queued', lease_until = NULL, locked_by = NULL, last_error = ?, updated_at = ? WHERE id = ?",
        'lease expired (worker crashed or timed out); requeued', t, j.id);
    }
  }
  return stale.length;
}

export function claim(db, workerId, t = now(), types = null) {
  return db.tx(() => {
    reap(db, t);
    const filter = types ? `AND type IN (${types.map(() => '?').join(',')})` : '';
    const j = db.get(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ${filter}
                      ORDER BY run_after, created_at LIMIT 1`, t, ...(types || []));
    if (!j) return null;
    const r = db.run(`UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, locked_by = ?,
                      updated_at = ? WHERE id = ? AND status = 'queued'`, t + j.timeout_ms + 5_000, workerId, t, j.id);
    if (r.changes !== 1) return null;
    return db.get('SELECT * FROM jobs WHERE id = ?', j.id);
  });
}

/** Claim one specific queued job by its idempotency key (the in-process kick, kick.js). Same lease as claim(). */
export function claimKey(db, workerId, key, t = now()) {
  return db.tx(() => {
    const j = db.get(`SELECT * FROM jobs WHERE idempotency_key = ? AND status = 'queued' AND run_after <= ?`, key, t);
    if (!j) return null;
    const r = db.run(`UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, locked_by = ?,
                      updated_at = ? WHERE id = ? AND status = 'queued'`, t + j.timeout_ms + 5_000, workerId, t, j.id);
    if (r.changes !== 1) return null;
    return db.get('SELECT * FROM jobs WHERE id = ?', j.id);
  });
}

export function succeed(db, job, result = null) {
  db.run(`UPDATE jobs SET status = 'succeeded', result_json = ?, lease_until = NULL, progress = NULL, updated_at = ?
          WHERE id = ? AND status = 'running'`, result == null ? null : JSON.stringify(result), now(), job.id);
}

export function fail(db, job, err, t = now()) {
  const p = POLICIES[job.type];
  const msg = String(err?.message || err).slice(0, 500);
  if (err instanceof Permanent || job.attempts >= job.max_attempts) {
    db.run(`UPDATE jobs SET status = 'dead', last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`, msg, t, job.id);
    return 'dead';
  }
  const delay = err instanceof Defer && err.delayMs ? err.delayMs : p.backoff(job.attempts);
  db.run(`UPDATE jobs SET status = 'queued', last_error = ?, run_after = ?, lease_until = NULL, locked_by = NULL,
          updated_at = ? WHERE id = ?`, msg, t + delay, t, job.id);
  return 'retry';
}

export function progress(db, jobId, text) {
  db.run('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?', text, now(), jobId);
}

/** Admin: give a dead job a fresh set of attempts. */
/** Evaluate jobs parked by a brain outage or his sleep are made due now: called once when a worker boots (the brain
 * may be back after a restart) so an idea never waits a whole 30 min backoff. -> number of jobs nudged. */
export function nudgeDeferredEvaluations(db, t = now()) {
  return db.run(`UPDATE jobs SET run_after = ?, updated_at = ? WHERE status = 'queued' AND type = 'evaluate' AND run_after > ?
                 AND (last_error LIKE 'brain unavailable%' OR last_error LIKE 'brain asleep%')`, t, t, t).changes;
}

export function retryDead(db, jobId, actor) {
  const r = db.run(`UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, last_error = NULL, updated_at = ?
                    WHERE id = ? AND status = 'dead'`, now(), now(), jobId);
  if (r.changes) audit(db, { actor, kind: 'admin', message: `requeued dead job ${jobId}` });
  return r.changes === 1;
}

export function cancelJobs(db, { ideaId, projectId }) {
  db.run(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE status = 'queued'
          AND (idea_id = ? OR project_id = ?)`, now(), ideaId ?? null, projectId ?? null);
}

/**
 * Run one claimed job. `handlers[type](ctx)` returns a result object. Time limit: the job's timeout_ms
 * (an AbortSignal is passed in; handlers pass it to their network calls).
 */
export async function runJob(db, job, handlers, services, onDead) {
  const handler = handlers[job.type];
  const signal = AbortSignal.timeout(job.timeout_ms);
  const ctx = { db, job, payload: parseJson(job.payload_json, {}), signal, ...services,
    progress: (text) => progress(db, job.id, text) };
  try {
    if (!handler) throw new Permanent(`no handler for ${job.type}`);
    const result = await Promise.race([
      handler(ctx),
      new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error(`time limit ${job.timeout_ms} ms`)), { once: true })),
    ]);
    succeed(db, job, result);
    return { status: 'succeeded', result };
  } catch (err) {
    const outcome = fail(db, job, err);
    const level = err instanceof Defer ? 'info' : 'warn';
    log[level]('job not done', { job: job.id, type: job.type, attempt: job.attempts, outcome, error: String(err?.message || err) });
    if (outcome === 'dead' && onDead) {
      try { onDead(db, { ...job, last_error: String(err?.message || err) }); } catch (e) { log.error('onDead failed', e); }
    }
    return { status: outcome, error: err };
  }
}
