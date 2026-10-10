// Worker process: claims jobs from the durable queue and runs periodic sweeps (late confirmations, fee
// reconciliation, backups, cleanup). Several workers may run; leases keep a job on one worker at a time.
import { join } from 'node:path';
import { hostname } from 'node:os';
import { loadConfig } from './config.js';
import { openDb, migrate, backup, getSetting, setSetting } from './db.js';
import { claim, runJob, enqueue, nudgeDeferredEvaluations } from './jobs.js';
import { handlers, onDead } from './pipeline.js';
import { sweepSubmitted } from './launch.js';
import { scheduleCoinStats } from './coin-stats.js';
import { log } from './log.js';
import { now } from './util.js';

export function makeWorker({ cfg, db, fetchImpl = fetch, id = `${hostname()}:${process.pid}` }) {
  const services = { cfg, fetchImpl };
  const nudged = nudgeDeferredEvaluations(db);
  if (nudged) log.info('deferred evaluations made due at boot', { nudged });
  async function tick() {
    const job = claim(db, id);
    if (!job) return false;
    await runJob(db, job, handlers, services, onDead);
    return true;
  }
  function periodic(t = now()) {
    sweepSubmitted(db, t);
    const hour = Math.floor(t / 3_600_000);
    for (const p of db.all('SELECT project_id FROM launches')) {
      enqueue(db, { type: 'reconcile_fees', key: `fees:${p.project_id}:${hour}`, projectId: p.project_id });
    }
    scheduleCoinStats(db, cfg, t);                          // launched coins' stats for the city (coin-stats.js)
    db.run('DELETE FROM auth_nonces WHERE expires_at < ?', t - 86_400_000);
    db.run('DELETE FROM oauth_states WHERE expires_at < ?', t - 86_400_000);
    db.run('DELETE FROM sessions WHERE expires_at < ?', t - 30 * 86_400_000);
    const last = getSetting(db, 'backup.last', 0);
    if (cfg.backups.everyHours > 0 && t - last > cfg.backups.everyHours * 3_600_000) {
      const f = backup(db, join(cfg.dataDir, 'backups'), cfg.backups.keep);
      setSetting(db, 'backup.last', t, 'worker');
      log.info('backup written', { file: f.split('/').pop() });
    }
  }
  return { tick, periodic };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = openDb(join(cfg.dataDir, 'launchpad.db'));
  migrate(db);
  const w = makeWorker({ cfg, db });
  let stop = false;
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
  log.info('worker started', { provider: cfg.launch.provider, brain: Boolean(cfg.brain.url) });
  let lastPeriodic = 0;
  while (!stop) {
    try {
      if (Date.now() - lastPeriodic > 60_000) { w.periodic(); lastPeriodic = Date.now(); }
      const worked = await w.tick();
      if (!worked) await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {
      log.error('worker loop', e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log.info('worker stopped');
  db.close();
}
