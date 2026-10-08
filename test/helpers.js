import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { b58encode } from '../src/util.js';
import { setLogSink } from '../src/log.js';
import { claim, runJob } from '../src/jobs.js';
import { handlers, onDead } from '../src/pipeline.js';

export const logs = [];
setLogSink((l) => logs.push(l));

export function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = b58encode(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
  return { address, signText: (text) => b58encode(sign(null, Buffer.from(text, 'utf8'), privateKey)), signBytes: (b) => sign(null, Buffer.from(b), privateKey) };
}

export function makeEnv(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lp-test-'));
  const cfg = loadConfig({ LAUNCHPAD_NO_DOTENV: '1', DATA_DIR: dir, PUBLIC_ORIGIN: 'http://localhost:8787', PORT: '8787',
    BRAIN_URL: 'http://brain.test', LAUNCHPAD_BRAIN_SECRET: 'secret', LAUNCH_PROVIDER: 'mock', BACKUP_EVERY_HOURS: '0', ...env });
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { cfg, db, dir };
}

/** A fake brain service. mode: 'build' | 'pass' | 'asleep' | 'offline' | 'error'. Counts calls. */
export function fakeBrain(mode = 'build') {
  const state = { mode, calls: 0, seen: new Map() };
  const fetchImpl = async (url, init) => {
    state.calls++;
    if (state.mode === 'offline') throw new TypeError('fetch failed');
    const body = JSON.parse(init.body);
    if (state.mode === 'asleep') return new Response(JSON.stringify({ status: 'asleep', stage: 'NREM' }), { status: 409 });
    if (state.mode === 'error') return new Response('{"status":"bad"}', { status: 500 });
    if (state.seen.has(body.request_id)) return new Response(JSON.stringify({ ...state.seen.get(body.request_id), replayed: true }), { status: 200 });
    const build = state.mode === 'build';
    const rec = { status: 'ok', request_id: body.request_id, version: 'launchpad-eval/1', decision: build ? 'build' : 'pass',
      networks: { reward: 1, attention: 0.5, language: 0.8 }, stage: 'AWAKE', demo: true,
      vote: { chosen: build ? 0 : 1, reason: 'chose it: reward areas responded most', spiking: { used: false, net: 'rate', network: 'rate model only' },
        options: [{ action: 'build', label: `build: ${body.title}`, p: build ? 0.8 : 0.2, value: 1, response: 0.01, chosen: build },
          { action: 'pass', label: 'pass: keep doing what he is doing', p: build ? 0.2 : 0.8, value: 0.1, response: 0.001, chosen: !build }] } };
    state.seen.set(body.request_id, rec);
    return new Response(JSON.stringify(rec), { status: 200 });
  };
  return { state, fetchImpl };
}

/** Run queued jobs until none is ready (or `max` runs). `t` lets tests jump past backoffs. */
export async function drain(db, cfg, fetchImpl, { max = 50, t } = {}) {
  const ran = [];
  for (let i = 0; i < max; i++) {
    const job = claim(db, 'test', t ?? Date.now());
    if (!job) break;
    const out = await runJob(db, job, handlers, { cfg, fetchImpl }, onDead);
    ran.push({ type: job.type, status: out.status, error: out.error?.message });
  }
  return ran;
}

/** A signed-up user (normally created by wallet sign-in). */
export function user(db, role = 'user') {
  const w = wallet();
  db.run('INSERT INTO users (wallet, role, created_at) VALUES (?, ?, ?)', w.address, role, Date.now());
  return w;
}

export const IDEA = (w, extra = {}) => ({
  title: 'Ramen Radar', concept: 'A tiny coin about a hand-drawn map of the best late-night ramen in Tokyo, updated by the community.',
  nameSuggestion: 'Ramen Radar', tickerSuggestion: 'RAMEN', links: ['https://example.com/ref'], contacts: { x: 'ramen_fan' },
  receivingWallet: w.address, rightsConfirmed: true, ...extra,
});

export const ideaStatus = (db, id) => db.get('SELECT status, status_note FROM ideas WHERE id = ?', id);
