// The kick: an idea gets its verdict in seconds, not on the worker's next sweep. The web process runs the evaluate job
// itself right after answering the HTTP request, claiming it with the same lease the worker uses (jobs.js claimKey),
// so it never runs twice. A deferred job (brain offline, short backoff) is kicked again from here at its run_after;
// the worker process stays the safety net for everything this process misses (a restart, a long wait).
import { claimKey, runJob } from './jobs.js';
import { handlers, onDead } from './pipeline.js';
import { now } from './util.js';
import { log } from './log.js';

export function createKicker({ db, cfg, fetchImpl = fetch, services = {}, id = `web:${process.pid}`, maxDelayMs = 5 * 60_000 }) {
  const timers = new Map();                                 // key -> timeout
  const inflight = new Map();                               // key -> promise (a second kick joins the first)
  async function run(key) {
    timers.delete(key);
    const job = claimKey(db, id, key);
    if (!job) return null;                                  // not queued (done, running elsewhere, or not yet due)
    const out = await runJob(db, job, handlers, { cfg, fetchImpl, ...services }, onDead);
    if (out.status === 'retry') {
      const j = db.get('SELECT run_after FROM jobs WHERE id = ?', job.id);
      if (j) schedule(key, j.run_after - now());
    }
    return out;
  }
  function schedule(key, delayMs) {
    if (delayMs > maxDelayMs || timers.has(key) || inflight.has(key)) return false;
    const t = setTimeout(() => { kick(key); }, Math.max(0, delayMs));
    t.unref?.();
    timers.set(key, t);
    return true;
  }
  /** Runs the job now (if it is queued and due). -> the runJob outcome, or null. Never throws. */
  function kick(key) {
    if (inflight.has(key)) return inflight.get(key);
    const p = run(key).catch((e) => { log.error('kick failed', { key, error: String(e?.message || e) }); return null; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  return {
    kick, schedule,
    /** Tests and shutdown: wait for the kicks in flight. */
    idle: () => Promise.all([...inflight.values()]).then(() => undefined),
    close() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}
