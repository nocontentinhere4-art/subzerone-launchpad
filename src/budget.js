// Spending caps: a global daily cap (UTC day) and a per-project lifetime cap. Admins can override both in settings.
import { getSetting } from './db.js';
import { now, utcDay } from './util.js';

export function limits(db, cfg) {
  return {
    globalDailyUsd: Number(getSetting(db, 'budget.globalDailyUsd', cfg.budgets.globalDailyUsd)),
    perProjectUsd: Number(getSetting(db, 'budget.perProjectUsd', cfg.budgets.perProjectUsd)),
  };
}

export function spentToday(db) {
  return db.get('SELECT COALESCE(SUM(usd), 0) s FROM spend WHERE day = ?', utcDay()).s;
}

export function canSpend(db, cfg, projectId, usd) {
  const l = limits(db, cfg);
  const today = spentToday(db);
  if (today + usd > l.globalDailyUsd) return { ok: false, why: `today's global budget is used up ($${today.toFixed(2)} of $${l.globalDailyUsd})` };
  if (projectId) {
    const p = db.get('SELECT COALESCE(SUM(usd), 0) s FROM spend WHERE project_id = ?', projectId).s;
    if (p + usd > l.perProjectUsd) return { ok: false, why: `this project's budget is used up ($${p.toFixed(2)} of $${l.perProjectUsd})` };
  }
  return { ok: true };
}

export function recordSpend(db, { projectId, kind, usd, jobId }) {
  db.run('INSERT INTO spend (day, project_id, kind, usd, job_id, at) VALUES (?, ?, ?, ?, ?, ?)', utcDay(), projectId, kind, usd, jobId, now());
}
