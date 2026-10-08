// SQLite (node:sqlite), WAL mode. Migrations are numbered SQL files applied in order, each inside a transaction.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from './config.js';
import { now, parseJson } from './util.js';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(resolve(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return wrap(db);
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0;
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => db.exec(sql),
    /** Nested calls join the outer transaction. */
    tx(fn) {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
    },
    close: () => db.close(),
  };
}

export function migrate(db, dir = join(ROOT, 'migrations')) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(db.all('SELECT name FROM schema_migrations').map((r) => r.name));
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    db.tx(() => {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', f, now());
    });
    applied.push(f);
  }
  return applied;
}

/** Consistent online copy (VACUUM INTO). Keeps the newest `keep` files. */
export function backup(db, dir, keep = 14) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `launchpad-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  if (existsSync(file)) rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir).filter((f) => f.startsWith('launchpad-') && f.endsWith('.db')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) rmSync(join(dir, f));
  return file;
}

// --- settings: pauses and caps, editable by admins -----------------------------------------------------------------
export const PAUSES = ['submissions', 'evaluation', 'generation', 'deployment', 'launch', 'x_publishing'];

export function getSetting(db, key, fallback) {
  const r = db.get('SELECT value_json FROM settings WHERE key = ?', key);
  return r ? parseJson(r.value_json, fallback) : fallback;
}
export function setSetting(db, key, value, by) {
  db.run(`INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`, key, JSON.stringify(value), by, now());
}
export const isPaused = (db, what) => Boolean(getSetting(db, `pause.${what}`, false));

/** Audit trail. `public` rows are shown on a published idea's timeline; the rest only to the owner and admins. */
export function audit(db, { actor, kind, message, ideaId = null, projectId = null, data = null, isPublic = false }) {
  db.run(`INSERT INTO events (at, actor, idea_id, project_id, kind, message, data_json, public)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, now(), actor, ideaId, projectId, kind, message,
  data == null ? null : JSON.stringify(data), isPublic ? 1 : 0);
}
