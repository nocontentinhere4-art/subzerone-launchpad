// Adapter to the SUB-01 brain service (the live server's POST /api/launchpad/evaluate, signed with HMAC).
// The brain's answer is used as-is. When the service is down, asleep or not configured, the result says so;
// nothing here substitutes another decision-maker.
import { createHmac } from 'node:crypto';

export function sign(secret, ts, body) {
  return createHmac('sha256', secret).update(`${ts}.`).update(body).digest('hex');
}

/**
 * -> {kind: 'ok', record} | {kind: 'asleep', stage} | {kind: 'unavailable', reason}
 * `fetchImpl` is injectable for tests.
 */
export async function askBrain(cfg, { requestId, title, concept }, { signal, fetchImpl = fetch } = {}) {
  if (!cfg.brain.url || !cfg.brain.secret) return { kind: 'unavailable', reason: 'brain service not configured' };
  const body = JSON.stringify({ request_id: requestId, title, concept });
  const ts = Math.floor(Date.now() / 1000);
  let res;
  try {
    res = await fetchImpl(new URL('/api/launchpad/evaluate', cfg.brain.url), {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-launchpad-timestamp': String(ts),
        'x-launchpad-signature': sign(cfg.brain.secret, ts, body) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(cfg.brain.timeoutMs)]) : AbortSignal.timeout(cfg.brain.timeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    return { kind: 'unavailable', reason: `brain service unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 409 && json?.status === 'asleep') return { kind: 'asleep', stage: json.stage };
  if (res.status === 200 && json?.status === 'ok' && (json.decision === 'build' || json.decision === 'pass') && json.vote) {
    return { kind: 'ok', record: json };
  }
  return { kind: 'unavailable', reason: `brain service answered ${res.status}${json?.status ? ` (${json.status})` : ''}` };
}

/** Public health line for the home page: is the brain reachable right now? Never throws. */
export async function brainStatus(cfg, fetchImpl = fetch) {
  if (!cfg.brain.url) return { reachable: false, reason: 'not configured' };
  try {
    const r = await fetchImpl(new URL('/healthz', cfg.brain.url), { signal: AbortSignal.timeout(4000), redirect: 'error' });
    return { reachable: r.ok, reason: r.ok ? null : `healthz ${r.status}` };
  } catch (e) {
    return { reachable: false, reason: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}
