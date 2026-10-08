// Shared helpers: an auto-escaping HTML template tag, the API client, base58, formatting.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

/** html`<p>${value}</p>`: every interpolation is escaped unless it is raw(...) or another html`` result. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : v instanceof Raw ? v.s : esc(v);
    out += part + strings[i + 1];
  });
  return raw(out);
}

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || body?.error || `HTTP ${status}`); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
export const toB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export const short = (a, n = 4) => (a && a.length > 2 * n + 3 ? `${a.slice(0, n)}…${a.slice(-n)}` : a || '');
export const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const ago = (t) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export const sol = (lamports) => (lamports == null ? '—' : `${(lamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`);
export const pct = (bps) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
export const usd = (x) => (x == null ? '—' : `$${Number(x).toLocaleString(undefined, { maximumFractionDigits: Number(x) < 1 ? 8 : 2 })}`);

export function copyButton(text, label = 'copy') {
  return html`<button class="ghost tiny" data-copy="${text}">${label}</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => { const t = b.textContent; b.textContent = 'copied'; setTimeout(() => { b.textContent = t; }, 1200); });
});
