// Anonymous, honest client telemetry from the city: how well the 3D city runs on real devices, nothing about who.
// No wallet, no cookie, no IP: the client's random session id and the IP are kept only as sha256 with a per-UTC-day
// salt. The salt lives in `settings` for the current day only; the first report of a new day replaces it (the old one
// is gone, so old hashes can no longer be linked to anything), clears the old IP hashes and drops rows older than 90
// days. Opt-out: `DNT: 1`, `Sec-GPC: 1` or `X-Telemetry: off` -> nothing is read or stored.
import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { sha256, now, utcDay, HttpError } from './util.js';

export const TELEMETRY = Object.freeze({ perSessionMs: 30_000, perIpPerDay: 500, keepDays: 90,
  fps: ['<20', '20-30', '30-45', '45+'], devices: ['phone', 'desktop'], gpu: ['weak', 'ok'] });
const KEYS = ['session', 'device', 'gpu_class', 'quality_level', 'fps_bucket', 'crash', 'context_lost', 'memory_mb', 'seconds'];

export const optedOut = (h) => h.dnt === '1' || h['sec-gpc'] === '1' || String(h['x-telemetry'] || '').toLowerCase() === 'off';

const bad = (msg) => new HttpError(400, 'bad_telemetry', msg);
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function validateReport(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('a JSON object');
  const extra = Object.keys(b).filter((k) => !KEYS.includes(k));
  if (extra.length) throw bad(`unknown field ${extra[0].slice(0, 20)}`);
  if (typeof b.session !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(b.session)) throw bad('session: 16–32 characters [A-Za-z0-9_-]');
  if (!TELEMETRY.devices.includes(b.device)) throw bad('device: phone | desktop');
  if (!(b.gpu_class == null || TELEMETRY.gpu.includes(b.gpu_class))) throw bad('gpu_class: weak | ok | null');
  if (!int(b.quality_level, 0, 3)) throw bad('quality_level: 0–3');
  if (!TELEMETRY.fps.includes(b.fps_bucket)) throw bad(`fps_bucket: ${TELEMETRY.fps.join(' | ')}`);
  if (typeof b.crash !== 'boolean' || typeof b.context_lost !== 'boolean') throw bad('crash, context_lost: true | false');
  if (!(b.memory_mb == null || int(b.memory_mb, 0, 65536))) throw bad('memory_mb: 0–65536 or null');
  if (!int(b.seconds, 0, 86400)) throw bad('seconds: 0–86400');
  return { session: b.session, device: b.device, gpu: b.gpu_class ?? null, quality: b.quality_level, fps: b.fps_bucket,
    crash: b.crash ? 1 : 0, lost: b.context_lost ? 1 : 0, memory: b.memory_mb ?? null, seconds: b.seconds };
}

/** Today's salt; a new day replaces yesterday's and forgets what it could link. */
function salt(db, day, t) {
  const cur = getSetting(db, 'telemetry.salt', null);
  if (cur?.day === day) return cur.salt;
  return db.tx(() => {
    const again = getSetting(db, 'telemetry.salt', null);
    if (again?.day === day) return again.salt;
    const s = randomBytes(32).toString('hex');
    setSetting(db, 'telemetry.salt', { day, salt: s }, 'system');
    db.run('UPDATE telemetry SET ip_hash = NULL WHERE day < ? AND ip_hash IS NOT NULL', day);
    db.run('DELETE FROM telemetry WHERE day < ?', utcDay(t - TELEMETRY.keepDays * 86_400_000));
    return s;
  });
}

export function recordTelemetry(db, body, ip, t = now()) {
  const r = validateReport(body);
  const day = utcDay(t);
  const s = salt(db, day, t);
  const session = sha256(`${s}:session:${r.session}`), ipHash = sha256(`${s}:ip:${ip}`);
  return db.tx(() => {
    const last = db.get('SELECT at FROM telemetry WHERE session_hash = ? ORDER BY at DESC LIMIT 1', session);
    if (last && t - last.at < TELEMETRY.perSessionMs) {
      throw new HttpError(429, 'rate_limited', 'one report per 30 s per session', { retryAfterS: Math.ceil((TELEMETRY.perSessionMs - (t - last.at)) / 1000) });
    }
    if (db.get('SELECT COUNT(*) n FROM telemetry WHERE day = ? AND ip_hash = ?', day, ipHash).n >= TELEMETRY.perIpPerDay) {
      throw new HttpError(429, 'rate_limited', 'daily report limit reached', { retryAfterS: Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - t) / 1000) });
    }
    db.run(`INSERT INTO telemetry (day, at, session_hash, ip_hash, device, gpu_class, quality_level, fps_bucket, crash, context_lost, memory_mb, seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, day, t, session, ipHash, r.device, r.gpu, r.quality, r.fps, r.crash, r.lost, r.memory, r.seconds);
    return { stored: true };
  });
}

const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

/** Admin view: one aggregate per UTC day, newest first. Rates are per session; distributions count reports. */
export function telemetryDaily(db, days = 14, t = now()) {
  const since = utcDay(t - (days - 1) * 86_400_000);
  const sessions = db.all(`SELECT day, COUNT(*) n, SUM(phone) phone, SUM(crash) crash, SUM(lost) lost FROM (
      SELECT day, session_hash, MAX(device = 'phone') phone, MAX(crash) crash, MAX(context_lost) lost FROM telemetry WHERE day >= ? GROUP BY day, session_hash)
    GROUP BY day ORDER BY day DESC`, since);
  const fps = db.all('SELECT day, fps_bucket k, COUNT(*) n FROM telemetry WHERE day >= ? GROUP BY day, fps_bucket', since);
  const quality = db.all('SELECT day, quality_level k, COUNT(*) n FROM telemetry WHERE day >= ? GROUP BY day, quality_level', since);
  const dist = (rows, day, keys) => Object.fromEntries(keys.map((k) => [k, rows.find((r) => r.day === day && String(r.k) === String(k))?.n || 0]));
  return {
    days: sessions.map((d) => {
      const f = dist(fps, d.day, TELEMETRY.fps), q = dist(quality, d.day, [0, 1, 2, 3]);
      return { day: d.day, sessions: d.n, reports: Object.values(f).reduce((a, b) => a + b, 0), phoneShare: ratio(d.phone, d.n),
        crashRate: ratio(d.crash, d.n), contextLossRate: ratio(d.lost, d.n), fps: f, quality: q };
    }),
    since, note: 'anonymous: no wallet, cookie or IP; session ids and IPs hashed with a salt that is discarded daily',
  };
}
