// SUB-01's build, step by step (2026-10-12): what the author watches after "He builds it". The generate job
// (pipeline.js) records each step's start, end, outcome and provider in build_steps (migration 018); this module turns
// those rows into the timeline and an honest ETA:
//   - per step, the median duration of the last 20 finished builds (per provider when it has 3+ runs of its own),
//     the defaults below until there is data;
//   - remaining = the medians of the steps not started + what is left of the running one; a step that runs past its
//     median is extended to its p90, past that by another p90 at a time; never negative;
//   - while it waits: its place in line and when it starts (one worker runs the builds one after another).
// Observation only: nothing here changes what gets built, and a recording problem never stops a build.
import { now } from './util.js';
import { log } from './log.js';
import { providerOf } from './coinart.js';

export const STEPS = [
  { id: 'queued', label: 'In line' },
  // 2026-10-12: SUB-01 composes the app first, then writes the words for that app (generator.js)
  { id: 'app', label: 'The app' },
  { id: 'brief', label: 'The words: name, tagline, story, X posts' },
  { id: 'art', label: 'Two logo + banner options' },
  { id: 'site', label: 'The website (sandbox build + safety check)' },
  { id: 'qa', label: 'Quality check' },
  { id: 'ready', label: 'Ready for your review' },
];
const LABEL = Object.fromEntries(STEPS.map((s) => [s.id, s.label]));
/** The generate job's steps, in order (qa: SUB-01's QA gate, site-qa.js publishSite). */
export const PIPELINE = ['queued', 'app', 'brief', 'art', 'site', 'qa', 'ready'];
/** The steps that are work (timed, counted in the percentage). */
const WORK = new Set(['brief', 'app', 'art', 'site', 'qa']);
export const DEFAULT_SECONDS = { brief: 25, app: 20, art: 40, site: 5, qa: 30 };
// providers with no network call take about a second; their own default until they have data
export const PROVIDER_DEFAULT_SECONDS = { 'template (no AI)': 1, 'rules (no AI)': 1, 'local drawing': 3, 'owner-supplied art': 1, 'static checks': 1 };
export const SAMPLE = 20, MIN_SAMPLES = 3, P90_FACTOR = 1.6;

// --- pure ------------------------------------------------------------------------------------------------------------
export function quantile(xs, q) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
export const median = (xs) => quantile(xs, 0.5);

/** -> {expected, p90, samples, source: 'provider'|'step'|'default'} in seconds, from the stats {step: {all: [s], by: {provider: [s]}}}. */
export function expectFor(stats, step, provider) {
  const s = stats?.[step] || {}, own = provider ? s.by?.[provider] || [] : [];
  const pick = own.length >= MIN_SAMPLES ? ['provider', own] : (s.all || []).length >= MIN_SAMPLES && !(provider in PROVIDER_DEFAULT_SECONDS) ? ['step', s.all] : null;
  if (pick) {
    const expected = Math.max(0.5, median(pick[1])), p90 = Math.max(expected, quantile(pick[1], 0.9));
    return { expected: round1(expected), p90: round1(p90 > expected ? p90 : expected * P90_FACTOR), samples: pick[1].length, source: pick[0] };
  }
  const expected = PROVIDER_DEFAULT_SECONDS[provider] ?? DEFAULT_SECONDS[step] ?? 10;
  return { expected, p90: round1(expected * P90_FACTOR), samples: 0, source: 'default' };
}
const round1 = (x) => Math.round(x * 10) / 10;

/** Seconds left in a running step: to its median, past it to its p90, past that by another p90 at a time. Never negative. */
export function remainingFor({ expected, p90 }, elapsed) {
  const e = Math.max(0, elapsed);
  if (e < expected) return expected - e;
  if (e < p90) return p90 - e;
  const chunk = Math.max(1, p90);
  return chunk - ((e - p90) % chunk);
}

/**
 * The ETA of a timeline at time t (ms). steps: [{id, state, startedAt, endedAt, expectedSeconds, p90Seconds}].
 * -> {remaining (s), done (s of work done), percent 0–100}. Queue waits are not here (queueStart adds them).
 */
export function estimate(steps, t) {
  let remaining = 0, done = 0;
  for (const s of steps) {
    if (!WORK.has(s.id)) continue;
    if (s.state === 'done' || s.state === 'skipped') { done += Math.max(0, ((s.endedAt ?? s.startedAt) - s.startedAt) / 1000); continue; }
    if (s.state === 'failed') continue;
    if (s.state === 'running') {
      const el = Math.max(0, (t - s.startedAt) / 1000);
      done += el;
      remaining += remainingFor({ expected: s.expectedSeconds, p90: s.p90Seconds }, el);
    } else remaining += s.expectedSeconds;
  }
  const total = done + remaining;
  return { remaining: round1(remaining), done: round1(done), percent: total > 0 ? Math.min(99, Math.floor((100 * done) / total)) : 0 };
}

/** "2nd in line, starts in ~1 min" pieces: when a build that waits starts (s), given the builds ahead (their remaining s). */
export function queueStart({ ahead = [], dueInSeconds = 0 }) {
  return round1(Math.max(Math.max(0, dueInSeconds), ahead.reduce((a, b) => a + Math.max(0, b), 0)));
}

/** The provider words the timeline shows. */
export const PROVIDERS = { brief: (cfg) => (cfg.generator.provider === 'anthropic' ? 'language model' : 'template (no AI)'),
  app: (cfg) => (cfg.generator.provider === 'anthropic' ? 'language model' : 'rules (no AI)'),
  art: (cfg) => ({ higgsfield: 'Higgsfield', recraft: 'Recraft' }[providerOf(cfg.art)] || 'local drawing'),
  site: () => 'sandbox', qa: (cfg) => (!cfg.siteQa || cfg.siteQa.browser === 'off' ? 'static checks' : 'Chromium') };
const ART_NAMES = { higgsfield: 'Higgsfield', recraft: 'Recraft', local: 'local drawing', 'owner-supplied': 'owner-supplied art' };

/** The art step's outcome in words: who drew the two options, and what fell back (coinart.js makeCoinArt result). */
export function artOutcome(art, cfg) {
  if (!art) return { provider: 'procedural fallback', note: 'the black-and-white renderer was unavailable; drawn from the brain record' };
  const planned = providerOf(cfg.art), ps = (art.provider || []).map(String), local = ps.filter((p) => p === 'local').length;
  if (planned && local === ps.length && ps.length) return { provider: 'local fallback', note: `${ART_NAMES[planned]} did not deliver in time; both options drawn locally` };
  if (planned && local) return { provider: `${ART_NAMES[planned]} + local fallback`, note: `${local} of ${ps.length} options drawn locally` };
  return { provider: [...new Set(ps)].map((p) => ART_NAMES[p] || p).join(' + ') || 'local drawing', note: null };
}

/** The QA step's outcome (site-qa.js publishSite `qa`): who checked it and what it found. */
export function qaOutcome(qa) {
  if (!qa) return { provider: 'static checks', note: 'not checked' };
  return { provider: qa.browser === 'ran' ? 'Chromium' : 'static checks', note: `${qa.line}${qa.held ? '; this version was held back' : ''}` };
}

// --- recording (pipeline.js) -------------------------------------------------------------------------------------------
/**
 * One generate run's recorder. Every call is safe: a database problem is logged, never thrown into the build.
 * begin(): the wait in line ends, the app starts. start(step, provider), done(step, {provider, note, state}).
 * observe(event, info): the hook generator.js calls between the app and the words ('app:done', 'brief:start', 'brief:done').
 */
export function buildRecorder(db, job, { cfg, progress } = {}) {
  const ideaId = job.idea_id, jobId = job.id, attempt = job.attempts || 1;
  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { log.error('build step not recorded', e); return undefined; } };
  const start = safe((step, provider = null, note = null, t = now()) => {
    db.run(`INSERT INTO build_steps (idea_id, job_id, attempt, step, state, provider, planned, note, started_at, ended_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, ?)
            ON CONFLICT(idea_id, job_id, attempt, step) DO UPDATE SET state = 'running', provider = excluded.provider, planned = excluded.planned, note = excluded.note,
              started_at = excluded.started_at, ended_at = NULL, updated_at = excluded.updated_at`, ideaId, jobId, attempt, step, provider, provider, note, t, t);
  });
  const done = safe((step, { provider = null, note = null, state = 'done', startedAt = null } = {}, t = now()) => {
    const r = db.run(`UPDATE build_steps SET state = ?, provider = COALESCE(?, provider), note = COALESCE(?, note), ended_at = ?, updated_at = ?
                      WHERE idea_id = ? AND job_id = ? AND attempt = ? AND step = ?`, state, provider, note, t, t, ideaId, jobId, attempt, step);
    if (r.changes === 0) {
      db.run(`INSERT INTO build_steps (idea_id, job_id, attempt, step, state, provider, planned, note, started_at, ended_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ideaId, jobId, attempt, step, state, provider, provider, note, startedAt ?? t, t, t);
    }
  });
  const begin = safe((t = now()) => {
    // in line since the job was queued (a retry: since the previous run ended)
    const prev = db.get(`SELECT MAX(COALESCE(ended_at, updated_at)) t FROM build_steps WHERE idea_id = ? AND job_id = ? AND attempt < ?`, ideaId, jobId, attempt)?.t;
    done('queued', { startedAt: Math.min(t, prev ?? job.created_at ?? t), note: attempt > 1 ? `try ${attempt} after a failed run` : null }, t);
    start('app', PROVIDERS.app(cfg), null, t);
  });
  const observe = safe((event, info = {}) => {
    if (event === 'app:done') {
      const fellBack = Boolean(info.fallback) && cfg?.generator?.provider === 'anthropic';
      done('app', fellBack ? { provider: 'rules (no AI)', note: "the language model's app did not pass the checks; built from the rules" } : { provider: info.provider || null });
    } else if (event === 'brief:start') { start('brief', info.provider || PROVIDERS.brief(cfg)); try { progress?.('writing the words for the app'); } catch { /* the progress text is cosmetic */ } }
    else if (event === 'brief:done') {
      const fellBack = Boolean(info.fallback) && cfg?.generator?.provider === 'anthropic';
      done('brief', fellBack ? { provider: 'template (no AI)', note: `the language model failed (${String(info.fallback).slice(0, 120)}); the template wrote the words` } : { provider: info.provider || null });
    }
  });
  return { begin, start, done, observe, ideaId, jobId, attempt };
}

// --- the view (GET /api/ideas/:id `build`, the SSE `build` frame, /api/world) ------------------------------------------
const statsCache = new WeakMap();                           // db -> {at, stats}: the medians, at most 5 s old
/** Durations (s) of the last SAMPLE finished runs per step (all providers) and per planned provider (a Higgsfield run
 * that fell back to the local drawing counts as a Higgsfield run: that is what the next one will try). Finished = reached ready. */
export function loadStats(db, t = now(), maxAgeMs = 5000) {
  const c = statsCache.get(db);
  if (c && t - c.at < maxAgeMs) return c.stats;
  const stats = {};
  for (const step of WORK) {
    const rows = db.all(`SELECT COALESCE(b.planned, b.provider) provider, (b.ended_at - b.started_at) ms FROM build_steps b
      WHERE b.step = ? AND b.state = 'done' AND b.ended_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM build_steps r WHERE r.idea_id = b.idea_id AND r.job_id = b.job_id AND r.attempt = b.attempt AND r.step = 'ready' AND r.state = 'done')
      ORDER BY b.ended_at DESC LIMIT 200`, step);
    const all = rows.slice(0, SAMPLE).map((r) => r.ms / 1000), by = {};
    for (const r of rows) { const k = r.provider || ''; (by[k] ||= []).length < SAMPLE && by[k].push(r.ms / 1000); }
    stats[step] = { all, by };
  }
  statsCache.set(db, { at: t, stats });
  return stats;
}
export const clearStatsCache = (db) => statsCache.delete(db);

const latestJob = (db, ideaId) => db.get(`SELECT id, status, attempts, run_after, created_at, updated_at, last_error FROM jobs
  WHERE idea_id = ? AND type = 'generate' ORDER BY created_at DESC, rowid DESC LIMIT 1`, ideaId);
const latestRun = (db, ideaId) => db.get(`SELECT job_id, attempt FROM build_steps WHERE idea_id = ? ORDER BY updated_at DESC, attempt DESC LIMIT 1`, ideaId);

/** The timeline of one idea's latest run, without the queue: {state, steps, est, startedAt, endedAt, job} or null. */
function timeline(db, cfg, ideaId, t, stats, { owner = false } = {}) {
  const idea = db.get('SELECT status FROM ideas WHERE id = ?', ideaId);
  if (!idea) return null;
  const job = latestJob(db, ideaId), run = latestRun(db, ideaId);
  const live = job && ['queued', 'running'].includes(job.status);
  if (!run && !(live && ['selected', 'generating'].includes(idea.status))) return null;
  // a newer job than the recorded run (a regeneration not started yet): a fresh timeline, in line
  const rows = run && (!job || run.job_id === job.id) ? db.all('SELECT * FROM build_steps WHERE idea_id = ? AND job_id = ? AND attempt = ?', ideaId, run.job_id, run.attempt) : [];
  const byStep = new Map(rows.map((r) => [r.step, r]));
  const runActive = job && job.status === 'running' && run && run.job_id === job.id && run.attempt === job.attempts;
  const ids = [...PIPELINE];
  let failedAt = null;
  const steps = ids.map((id) => {
    const r = byStep.get(id), plan = WORK.has(id) ? expectFor(stats, id, r?.planned || r?.provider || PROVIDERS[id](cfg)) : null;
    let state = r ? r.state : 'todo', note = r?.note ?? null;
    // a step left 'running' by a run that is over (the job failed, timed out, or its worker died): it failed there
    if (state === 'running' && rows.length && !runActive) { state = 'failed'; failedAt = id; note = owner && job?.last_error ? String(job.last_error).slice(0, 160) : 'stopped here'; }
    if (state === 'failed') failedAt ||= id;
    const s = { id, label: LABEL[id], state, startedAt: r?.started_at ?? null, endedAt: r?.ended_at ?? null,
      provider: r?.provider ?? null, plannedProvider: !r && WORK.has(id) ? PROVIDERS[id](cfg) : null, note,
      expectedSeconds: plan?.expected ?? null, p90Seconds: plan?.p90 ?? null, estimateFrom: plan ? (plan.source === 'default' ? 'default' : `median of ${plan.samples}`) : null,
      elapsedSeconds: r ? round1(Math.max(0, ((r.ended_at ?? t) - r.started_at) / 1000)) : null };
    return s;
  });
  // the queue step before the run starts: since the job was queued
  const q = steps[0];
  if (q.state === 'todo' && live) Object.assign(q, { state: 'running', startedAt: job.created_at, elapsedSeconds: round1(Math.max(0, (t - job.created_at) / 1000)) });
  const ready = byStep.get('ready')?.state === 'done';
  // a run that ended without a running step and without 'ready' (a check failed between steps): the next step failed
  if (!ready && !failedAt && rows.length && !runActive && !(live && job.status === 'queued' && !rows.length)) {
    const next = steps.find((s) => s.state === 'todo');
    if (next) { next.state = 'failed'; next.note = owner && job?.last_error ? String(job.last_error).slice(0, 160) : 'stopped here'; failedAt = next.id; }
  }
  const state = ready ? 'ready' : failedAt ? (live ? 'retrying' : 'failed') : steps.some((s) => s.id !== 'queued' && s.state === 'running') ? 'running' : 'queued';
  if (!owner) for (const s of steps) if (s.state === 'failed') s.note = 'stopped here';
  const est = estimate(state === 'retrying' ? steps.map((s) => (s.id === 'queued' ? s : { ...s, state: 'todo' })) : steps, t);
  const startedAt = steps[0].startedAt ?? steps.find((s) => s.startedAt)?.startedAt ?? job?.created_at ?? t;
  const endedAt = ready ? byStep.get('ready').ended_at : null;
  return { state, steps, est, startedAt, endedAt, job, ideaStatus: idea.status };
}

/**
 * GET /api/ideas/:id `build` (and the SSE `build` frame): null when the idea has no build (never selected, or built
 * before 2026-10-12). owner: the failed step's reason (the job's error) for the author and admins only.
 * -> {state:'queued'|'running'|'retrying'|'ready'|'failed', steps:[{id,label,state:'todo'|'running'|'done'|'failed'|'skipped',
 *     startedAt,endedAt,provider,plannedProvider,note,expectedSeconds,p90Seconds,estimateFrom,elapsedSeconds}],
 *     startedAt, etaSeconds, etaAt, elapsedSeconds, percent, queue:{position,ahead,startsInSeconds}|null, attempt, now}
 */
export function buildView(db, cfg, ideaId, { owner = false, t = now() } = {}) {
  const stats = loadStats(db, t);
  const tl = timeline(db, cfg, ideaId, t, stats, { owner });
  if (!tl) return null;
  let queue = null, wait = 0;
  if ((tl.state === 'queued' || tl.state === 'retrying') && tl.job && ['queued', 'running'].includes(tl.job.status)) {
    // one worker runs the builds one after another: the running builds, then the queued ones due before this one
    const mine = tl.job;
    const others = db.all(`SELECT idea_id, status, run_after, created_at FROM jobs WHERE type = 'generate' AND status IN ('queued', 'running') AND id != ?
      ORDER BY status = 'running' DESC, run_after, created_at`, mine.id);
    const ahead = others.filter((o) => o.status === 'running' || o.run_after < mine.run_after || (o.run_after === mine.run_after && o.created_at < mine.created_at));
    const left = ahead.map((o) => {
      const x = timeline(db, cfg, o.idea_id, t, stats);
      return x ? (x.state === 'queued' ? fullSeconds(x.steps) : x.est.remaining) : fullSeconds(null, cfg, stats);
    });
    wait = mine.status === 'running' ? 0 : queueStart({ ahead: left, dueInSeconds: (mine.run_after - t) / 1000 });
    queue = { position: ahead.length + 1, ahead: ahead.length, startsInSeconds: wait };
  }
  const eta = tl.state === 'ready' || tl.state === 'failed' ? 0 : round1(wait + tl.est.remaining);
  return { state: tl.state, steps: tl.steps, startedAt: tl.startedAt, etaSeconds: eta, etaAt: tl.state === 'failed' ? null : Math.round(t + eta * 1000),
    elapsedSeconds: round1(Math.max(0, ((tl.endedAt ?? t) - tl.startedAt) / 1000)), percent: tl.state === 'ready' ? 100 : tl.state === 'queued' ? 0 : tl.est.percent,
    queue, attempt: tl.job?.attempts || 1, now: t };
}
// the whole build's expected seconds (a build still in line)
function fullSeconds(steps, cfg, stats) {
  if (steps) return steps.filter((s) => WORK.has(s.id)).reduce((a, s) => a + (s.expectedSeconds || 0), 0);
  return [...WORK].filter((id) => PIPELINE.includes(id)).reduce((a, id) => a + expectFor(stats, id, PROVIDERS[id](cfg)).expected, 0);
}

/** The city's building card: {state, percent, etaSeconds, etaAt, step:{id,label}, queuePosition, now} or null. */
export function buildSummary(view) {
  if (!view) return null;
  const cur = view.steps.find((s) => s.state === 'running' && s.id !== 'queued') || view.steps.find((s) => s.state === 'running') || null;
  return { state: view.state, percent: view.percent, etaSeconds: view.etaSeconds, etaAt: view.etaAt, elapsedSeconds: view.elapsedSeconds,
    step: cur ? { id: cur.id, label: cur.label } : null, queuePosition: view.queue?.position ?? null, now: view.now };
}

/** What changed for the stream (not the clock): the frame goes out only when this differs. */
export const buildSignature = (v) => (v ? JSON.stringify([v.state, v.queue?.position ?? 0, v.steps.map((s) => [s.id, s.state, s.provider])]) : 'null');

/**
 * The web process's watch (app.js): the worker is another process, so every `everyMs` the web process reads which
 * builds changed and sends one `build` frame per change to the streams (public idea: everyone; private: its author).
 * The city counts down between frames itself (the steps carry their expected seconds). Cheap: two indexed reads a
 * tick, nothing when no stream is open. -> {tick(), stop()}
 */
export function createBuildWatch({ db, cfg, send, hasListeners = () => true, everyMs = 1000, keepMs = 10 * 60_000 }) {
  const sent = new Map();                                   // ideaId -> {sig, at}
  let since = now() - keepMs;
  function tick(t = now()) {
    if (!hasListeners()) return 0;
    const ids = new Set([
      ...db.all(`SELECT DISTINCT idea_id FROM jobs WHERE type = 'generate' AND status IN ('queued', 'running') AND idea_id IS NOT NULL`).map((r) => r.idea_id),
      ...db.all('SELECT DISTINCT idea_id FROM build_steps WHERE updated_at >= ?', since).map((r) => r.idea_id),
      ...sent.keys(),
    ]);
    since = t - 2000;                                       // a little overlap: rows written in the same millisecond are not missed
    let n = 0;
    for (const ideaId of ids) {
      let v = null;
      try { v = buildView(db, cfg, ideaId, { t }); } catch (e) { log.error('build view failed', e); continue; }
      const sig = buildSignature(v), last = sent.get(ideaId);
      if (!last || last.sig !== sig) { send(ideaId, v); n++; sent.set(ideaId, { sig, at: t }); }
      // a finished build is forgotten after a while (its last frame went out)
      if ((!v || v.state === 'ready' || v.state === 'failed') && t - (sent.get(ideaId)?.at ?? t) > keepMs) sent.delete(ideaId);
    }
    return n;
  }
  const timer = everyMs > 0 ? setInterval(() => { try { tick(); } catch (e) { log.error('build watch', e); } }, everyMs) : null;
  timer?.unref?.();
  return { tick, stop: () => clearInterval(timer), sent };
}
