// Minimal HTTP plumbing on node:http: routing, JSON bodies with size limits, cookies, security headers, same-origin
// checks for every state-changing request, and in-memory token-bucket rate limits.
import { HttpError } from './util.js';
import { log } from './log.js';

export function router() {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, opts });
  };
  return {
    get: (p, h, o) => add('GET', p, h, o), post: (p, h, o) => add('POST', p, h, o), put: (p, h, o) => add('PUT', p, h, o),
    del: (p, h, o) => add('DELETE', p, h, o), patch: (p, h, o) => add('PATCH', p, h, o),
    match(method, path) {
      for (const r of routes) {
        if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
        const m = path.match(r.re);
        if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readJson(req, limit) {
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'json_required');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', `request larger than ${Math.round(limit / 1024)} KB`);
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'bad_json'); }
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Token buckets keyed by (bucket, key). Single-process; see docs/OPERATIONS.md for multi-instance. */
export function rateLimiter() {
  const buckets = new Map();
  const RULES = { auth: [10, 60_000], submit: [6, 3_600_000], write: [60, 60_000], read: [400, 60_000], brain: [20, 60_000], presence: [150, 60_000],
    // coin sites' tools (tool-api.js), per IP; signed writes also per wallet
    siteRead: [300, 60_000], siteWrite: [12, 60_000], siteSign: [12, 60_000], siteWallet: [10, 60_000],
    // a launch from a coin site (child-launch.js): quote, start, then the transaction steps (each one also signed by the wallet)
    siteLaunch: [30, 60_000], reward_read: [60,60_000], reward_publish: [4,60_000], reward_claim: [12,60_000] };
  setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.t > 3_600_000) buckets.delete(k); }, 600_000).unref();
  return (rule, key) => {
    const [cap, per] = RULES[rule];
    const k = `${rule}:${key}`;
    const t = Date.now();
    const b = buckets.get(k) || { tokens: cap, t };
    b.tokens = Math.min(cap, b.tokens + ((t - b.t) / per) * cap);
    b.t = t;
    if (b.tokens < 1) { buckets.set(k, b); throw new HttpError(429, 'rate_limited', 'slow down a little', { retryAfterS: Math.ceil(per / cap / 1000) }); }
    b.tokens -= 1;
    buckets.set(k, b);
  };
}

// frame-src: our own pages and previews, SUB-01's room, and the project sites (the city's desk computer frames them).
// frame-ancestors 'self': the city may frame the launchpad's own pages; no other site may.
export const APP_CSP = (roomOrigin, projectsFrameSource) => [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:", `frame-src 'self' ${roomOrigin} ${projectsFrameSource}`, "connect-src 'self'",
  "frame-ancestors 'self'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join('; ');

export function securityHeaders(res, csp) {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

export function sendJson(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(s);
}

export function sendError(res, err, reqId) {
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
  if (err?.constructor?.name === 'Permanent') return sendJson(res, 400, { error: 'refused', message: err.message });
  if (/UNIQUE constraint failed|constraint failed/.test(String(err?.message))) {
    return sendJson(res, 409, { error: 'conflict', message: 'that already exists or is already in progress' });
  }
  log.error('unhandled', { reqId, error: String(err?.stack || err).slice(0, 600) });
  return sendJson(res, 500, { error: 'internal', message: 'something broke on our side', reqId });
}
