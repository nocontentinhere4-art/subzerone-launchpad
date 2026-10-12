// SUBZERONE site kit v1 (docs/SITE-KIT.md). The only script a coin site runs: built by kit/build.mjs into
// public/_kit/site-kit.v1.js and served by the launchpad on every project host at /_kit/site-kit.v1.js.
// Rules this file keeps (and test/tools.test.js checks on the built bundle): no eval, no new Function, no innerHTML /
// outerHTML / insertAdjacentHTML / document.write: everything a visitor or an author typed reaches the page through
// textContent or attribute setters only. Network: same-origin fetches to /_api/* without credentials; vendor modules
// from /_kit/vendor/ by dynamic import, only on sites whose tool needs them. Wallets: Wallet Standard (plus the legacy
// injected providers) for solana:signMessage only. No transaction is ever built, asked for or signed here.
import { animate } from 'motion/mini';
import { inView, stagger } from 'motion';

/* global __VENDOR__ */
const VENDOR = __VENDOR__;                                   // {anime, leaflet, leafletCss, tone, kaplay, uplot, uplotCss, qrcode, pq}: file names (build.mjs)
const doc = document, win = window;
const reduce = (() => { try { return win.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
const DASH = '—';

// ---- tiny DOM helpers (text only) -------------------------------------------------------------------------------
function h(tag, props, ...kids) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k === 'cls') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : doc.createTextNode(String(c)));
  return n;
}
const svgEl = (tag, attrs) => { const n = doc.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
const store = { get(k) { try { return win.localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { win.localStorage.setItem(k, v); } catch { /* private mode */ } } };

// ---- formatting ---------------------------------------------------------------------------------------------------
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function usd(n) {
  if (!isNum(n)) return DASH;
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  if (a === 0) return '$0';
  return `$${n.toPrecision(3)}`;
}
const pct = (n) => (isNum(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}%` : DASH);
const count = (n) => (isNum(n) ? Math.round(n).toLocaleString('en-US') : DASH);
const ago = (t) => { if (!isNum(t)) return ''; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const short = (w) => (w && w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w || '');

// ---- network ------------------------------------------------------------------------------------------------------
class ApiError extends Error { constructor(status, body) { super(body?.message || body?.error || `request failed (${status})`); this.status = status; this.body = body; } }
async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}
const loaded = new Map();
const vendor = (name) => { if (!loaded.has(name)) loaded.set(name, import(/* @vite-ignore */ `/_kit/vendor/${VENDOR[name]}`)); return loaded.get(name); };
function vendorCss(name) {
  if (doc.querySelector(`link[data-vendor="${name}"]`)) return;
  doc.head.append(h('link', { rel: 'stylesheet', href: `/_kit/vendor/${VENDOR[name]}`, 'data-vendor': name }));
}

// ---- motion -------------------------------------------------------------------------------------------------------
const anime = () => (reduce ? Promise.resolve(null) : vendor('anime').catch(() => null));
function tick(el, to, fmt) {
  const from = Number(el.dataset.v);
  el.dataset.v = isNum(to) ? String(to) : '';
  if (!isNum(to)) { el.textContent = DASH; return; }
  if (!isNum(from) || from === to) { el.textContent = fmt(to); return; }
  anime().then((a) => {
    if (!a) { el.textContent = fmt(to); return; }
    const o = { v: from };
    a.animate(o, { v: to, duration: 900, ease: 'outExpo', onUpdate: () => { el.textContent = fmt(o.v); }, onComplete: () => { el.textContent = fmt(to); } });
  });
}
function slideIn(el) { if (!reduce) animate(el, { opacity: [0, 1], transform: ['translateY(-10px)', 'none'] }, { duration: 0.45, easing: 'ease-out' }); }
function motionIn() {
  if (reduce) return;
  const hero = [...doc.querySelectorAll('.reveal-hero')];
  const EASE = [0.2, 0.7, 0.1, 1];
  if (hero.length) animate(hero, { opacity: [0, 1], transform: ['translateY(22px)', 'none'] }, { duration: 0.8, delay: stagger(0.07), easing: EASE });
  const art = doc.querySelector('.hero-art,.hero-mark');
  if (art) animate(art, { opacity: [0, 1] }, { duration: 1.2, easing: 'ease-out' });
  const cards = [...doc.querySelectorAll('.reveal')];
  for (const c of cards) c.style.opacity = '0';
  inView(cards, (el) => { animate(el, { opacity: [0, 1], transform: ['translateY(16px)', 'none'] }, { duration: 0.6, easing: EASE }); }, { amount: 0.08 });
  setTimeout(() => { for (const c of cards) if (c.style.opacity === '0' && !c.getAnimations?.().length) c.style.opacity = ''; }, 4000);   // never leave a card invisible
}

// ---- wallets (Wallet Standard first, then the legacy injected providers) -----------------------------------------
const wallets = new Map();
const usable = (w) => (w?.chains || []).some((c) => String(c).startsWith('solana:')) && typeof w.features?.['standard:connect']?.connect === 'function'
  && typeof w.features?.['solana:signMessage']?.signMessage === 'function';
const registerApi = Object.freeze({ register: (...list) => { for (const w of list) if (usable(w)) wallets.set(w.name, w); return () => {}; } });
win.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(registerApi); } catch { /* a bad wallet */ } });
try { win.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registerApi })); } catch { /* old browser */ }
function legacy() {
  const out = [];
  const add = (name, p) => { if (p && typeof p.connect === 'function' && typeof p.signMessage === 'function' && !out.some((x) => x.p === p)) out.push({ name, p }); };
  try { add('Phantom', win.phantom?.solana); add('Solflare', win.solflare); add('Backpack', win.backpack); add('Solana wallet', win.solana); } catch { /* getters may throw */ }
  return out.filter((x) => ![...wallets.keys()].some((n) => n.toLowerCase().startsWith(x.name.toLowerCase().split(' ')[0])));
}
const b58a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) + BigInt(b); let o = ''; while (n > 0n) { o = b58a[Number(n % 58n)] + o; n /= 58n; } for (const b of bytes) { if (b === 0) o = `1${o}`; else break; } return o; }
const u8 = (x) => (x instanceof Uint8Array ? x : x?.buffer instanceof ArrayBuffer ? new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength) : Array.isArray(x) ? Uint8Array.from(x) : null);
const keyStr = (k) => k?.toBase58?.() ?? k?.toString?.() ?? '';
let chosen = null;
function pickWallet() {
  const std = [...wallets.values()].map((w) => ({ name: w.name, std: w })), old = legacy().map((x) => ({ name: x.name, old: x.p }));
  const list = [...std, ...old];
  if (!list.length) return Promise.reject(new Error('No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, or open this page in your wallet app.'));
  if (chosen && list.some((w) => w.name === chosen.name)) return Promise.resolve(chosen);
  if (list.length === 1) return Promise.resolve((chosen = list[0]));
  return new Promise((resolve, reject) => {
    const close = (v, err) => { box.remove(); if (err) reject(err); else resolve((chosen = v)); };
    const box = h('div', { cls: 'picker', role: 'dialog', 'aria-label': 'Pick a wallet', onclick: (e) => { if (e.target === box) close(null, new Error('No wallet picked. Nothing was signed.')); } },
      h('div', { cls: 'card' }, h('span', { cls: 'eyebrow', text: 'Sign with' }), h('p', { cls: 'fine', text: 'A message, not a transaction: it moves no funds.' }),
        list.map((w) => h('button', { cls: 'btn btn-ghost', type: 'button', text: w.name, onclick: () => close(w) }))));
    doc.body.append(box);
  });
}
async function connectAndSign(w, makeMessage) {
  if (w.std) {
    const res = await w.std.features['standard:connect'].connect();
    const account = res?.accounts?.[0] || w.std.accounts?.[0];
    if (!account?.address) throw new Error('The wallet shared no account. Unlock it and try again.');
    const { message } = await makeMessage(account.address);
    const out = await w.std.features['solana:signMessage'].signMessage({ account, message: new TextEncoder().encode(message) });
    const sig = u8((Array.isArray(out) ? out[0] : out)?.signature);
    if (!sig || sig.length !== 64) throw new Error('The wallet answered without a valid signature.');
    return { address: account.address, signature: b58(sig) };
  }
  const r = await w.old.connect();
  const address = keyStr(w.old.publicKey) || keyStr(r?.publicKey);
  if (!address) throw new Error('The wallet shared no account. Unlock it and try again.');
  const { message } = await makeMessage(address);
  const out = await w.old.signMessage(new TextEncoder().encode(message), 'utf8');
  const sig = u8(out?.signature ?? out);
  if (!sig || sig.length !== 64) throw new Error('The wallet answered without a valid signature.');
  return { address, signature: b58(sig) };
}
/** Ask the server for the exact message, have the wallet sign it, return the fields the write carries. */
async function signed(action, payload) {
  const w = await pickWallet();
  let nonce = null;
  const { address, signature } = await connectAndSign(w, async (wallet) => { const r = await api('/_api/sign', { action, wallet, ...payload }); nonce = r.nonce; return r; });
  return { wallet: address, nonce, signature };
}
const explain = (e) => (e?.code === 4001 || /reject|denied|cancel|closed/i.test(String(e?.message)) ? 'Cancelled in the wallet. Nothing was signed.' : e?.message || 'Something went wrong; try again.');

// ---- the tools ----------------------------------------------------------------------------------------------------
const textBox = (max, placeholder) => {
  const ta = h('textarea', { rows: 3, maxlength: max, placeholder });
  const c = h('span', { cls: 'counter', text: `0 / ${max}` });
  ta.addEventListener('input', () => { c.textContent = `${[...ta.value].length} / ${max}`; });
  return { ta, c };
};
const msg = () => h('p', { cls: 'msg', role: 'status' });
const say = (m, text, kind = '') => { m.textContent = text; m.className = `msg${kind ? ` ${kind}` : ''}`; };
async function busy(btn, fn) { btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; } }

const TOOLS = {
  async token(sec, slot) {
    const ticker = doc.querySelector('.tk')?.textContent || '';
    const ca = slot.querySelector('[data-ca]');
    if (ca) {
      const row = ca.parentElement, mint = ca.textContent.trim();
      const copy = h('button', { cls: 'btn btn-sm', type: 'button', text: 'Copy CA', onclick: async () => { try { await navigator.clipboard.writeText(mint); copy.textContent = 'Copied'; } catch { const r = doc.createRange(); r.selectNodeContents(ca); const s = win.getSelection(); s.removeAllRanges(); s.addRange(r); copy.textContent = 'Selected: copy it'; } setTimeout(() => { copy.textContent = 'Copy CA'; }, 1600); } });
      const qrBtn = h('button', { cls: 'btn btn-sm btn-ghost', type: 'button', text: 'QR', onclick: () => busy(qrBtn, async () => {
        const old = row.parentElement.querySelector('.qr'); if (old) { old.remove(); return; }
        const q = (await vendor('qrcode')).default(0, 'M'); q.addData(mint); q.make();
        row.after(h('div', { cls: 'qr' }, h('img', { src: q.createDataURL(6, 2), alt: `QR code of the ${ticker} contract address`, width: 180, height: 180 })));
      }) });
      row.append(copy, qrBtn);
    }
    const refresh = async () => {
      let s; try { s = await api('/_api/token'); } catch { return; }
      const set = (k, v, fmt) => { for (const el of doc.querySelectorAll(`[data-k="${k}"]`)) tick(el, v, fmt); };
      set('price', s.priceUsd, usd); set('mcap', s.marketCapUsd, usd); set('vol', s.volume24hUsd, usd);
      set('holders', s.holders?.count ?? null, (n) => `${s.holders?.atLeast ? '≥ ' : ''}${count(n)}`);
      for (const el of doc.querySelectorAll('[data-k="chg"]')) { el.textContent = pct(s.priceChange24hPct); el.classList.toggle('up', s.priceChange24hPct > 0); el.classList.toggle('down', s.priceChange24hPct < 0); }
      const up = slot.querySelector('[data-k="updated"]');
      if (up) up.textContent = s.state === 'pre-launch' ? 'Pre-launch: numbers appear after the launch.' : s.at ? `Updated ${ago(s.at)} · ${s.sourceLabel || s.source || 'stored stats'}${s.fresh ? '' : ' · may be stale'}${s.state === 'mock' ? ' · MOCK numbers' : ''}` : 'No market data yet.';
      spark(slot.querySelector('[data-spark]'), s.samples || []);
    };
    await refresh();
    setInterval(refresh, 60_000);
  },

  async wall(sec, slot) {
    const s = await api('/_api/wall');
    const { ta, c } = textBox(s.max, 'Say something nice (no links)…');
    const m = msg(), feed = h('ul', { cls: 'feed' });
    const item = (e) => h('li', { 'data-id': e.id }, h('span', { text: e.text }), h('small', { text: `${e.by ? `${e.by} · ` : ''}${new Date(e.at).toLocaleString()}` }));
    const draw = (entries) => { feed.replaceChildren(...entries.map(item)); if (!entries.length) feed.append(h('li', { cls: 'fine', text: 'Nothing yet. Be the first.' })); };
    const post = h('button', { cls: 'btn', type: 'button', text: s.holdersOnly ? 'Sign and post' : 'Post', onclick: () => busy(post, async () => {
      say(m, s.holdersOnly ? 'Waiting for your wallet…' : 'Posting…');
      try {
        const extra = s.holdersOnly ? await signed('wall.post', { text: ta.value }) : {};
        const r = await api('/_api/wall', { text: ta.value, ...extra });
        if (feed.firstChild?.classList?.contains('fine')) feed.firstChild.remove();
        const li = item(r.entry); feed.prepend(li); slideIn(li);
        ta.value = ''; c.textContent = `0 / ${s.max}`; say(m, 'Posted.', 'ok');
      } catch (e) { say(m, explain(e), 'err'); }
    }) });
    draw(s.entries);
    slot.replaceChildren(...(s.note ? [h('p', { cls: 'fine', text: s.note })] : []), ta, h('div', { cls: 'row' }, post, c), m, feed);
    setInterval(async () => {
      try {
        const n = await api('/_api/wall'), have = new Set([...feed.querySelectorAll('li[data-id]')].map((x) => x.dataset.id));
        if (!have.size) { if (n.entries.length) draw(n.entries); return; }
        for (const e of n.entries.filter((x) => !have.has(x.id)).reverse()) { const li = item(e); feed.prepend(li); slideIn(li); }
      } catch { /* offline for a moment */ }
    }, 30_000);
  },

  async poll(sec, slot) {
    let s = await api('/_api/poll');
    const m = msg(), opts = h('div', {});
    const mineKey = `kit.poll.${s.pollKey}`;
    let mine = store.get(mineKey);
    const draw = (animateBars) => {
      opts.replaceChildren(...s.options.map((o, i) => {
        const share = s.total ? s.counts[i] / s.total : 0;
        const bar = h('i', { cls: 'bar' });
        const b = h('button', { cls: `poll-opt${String(i) === mine ? ' mine' : ''}`, type: 'button', 'aria-label': `Vote ${o}`, onclick: () => vote(i, b) },
          bar, h('span', { text: o }), h('span', { cls: 'pct', text: s.total ? `${Math.round(share * 100)}%` : '' }));
        if (animateBars && !reduce) anime().then((a) => { if (a) a.animate(bar, { width: ['0%', `${share * 100}%`], duration: 900, ease: 'outExpo' }); else bar.style.width = `${share * 100}%`; });
        else bar.style.width = `${share * 100}%`;
        return b;
      }));
    };
    const vote = (choice, btn) => busy(btn, async () => {
      say(m, 'Waiting for your wallet… (a message, not a transaction)');
      try {
        const sig = await signed('poll.vote', { choice });
        s = await api('/_api/poll', { choice, ...sig });
        mine = String(choice); store.set(mineKey, mine); draw(true); say(m, `Vote counted: "${s.options[choice]}". ${s.total} vote${s.total === 1 ? '' : 's'} so far.`, 'ok');
      } catch (e) {
        if (e.body?.error === 'already_voted') { mine = String(e.body.choice); store.set(mineKey, mine); draw(false); }
        say(m, explain(e), 'err');
      }
    });
    draw(true);
    slot.replaceChildren(...(s.note ? [h('p', { cls: 'fine', text: s.note })] : []), opts, h('p', { cls: 'fine', text: 'One vote per wallet. Your wallet signs a message, never a transaction.' }), m);
  },

  async drop(sec, slot) {
    const s = await api('/_api/drop');
    const { ta, c } = textBox(s.maxLength, s.prompt);
    const m = msg(), nextLine = h('p', { cls: 'fine' });
    const send = h('button', { cls: 'btn', type: 'button', text: 'Drop it', onclick: () => busy(send, async () => {
      try { await api('/_api/drop', { text: ta.value }); ta.value = ''; c.textContent = `0 / ${s.maxLength}`; say(m, 'Received. It stays private; only the author sees it unless it is picked.', 'ok'); }
      catch (e) { say(m, explain(e), 'err'); }
    }) });
    const until = () => { const ms = s.nextRevealAt - Date.now(); nextLine.textContent = `Next pick at ${s.revealJst} JST · in ${Math.max(0, Math.floor(ms / 3600000))} h ${Math.max(0, Math.floor(ms / 60000) % 60)} min`; };
    until(); setInterval(until, 30_000);
    const feat = s.featured ? [h('span', { cls: 'eyebrow', text: `Today's pick · ${s.featured.day} · chosen by ${s.featured.by}` }), h('p', { cls: 'featured', text: s.featured.text })]
      : [h('p', { cls: 'fine', text: 'Nothing featured yet.' })];
    slot.replaceChildren(...feat, h('p', { text: s.prompt }), ta, h('div', { cls: 'row' }, send, c), m, nextLine);
  },

  event(sec, slot, conf) {
    const at = () => {
      const now = Date.now();
      if (conf.daily) { const [hh, mm] = conf.daily.split(':').map(Number); const d = new Date(now + 9 * 3600e3); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - 9 * 3600e3; if (t <= now) t += 86400e3; return t; }
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(conf.at || ''); if (!m) return null;
      const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600e3; return t > now ? t : null;
    };
    const box = slot.querySelector('[data-count]') || h('div', { cls: 'count' });
    const seg = (n, u) => [String(n).padStart(2, '0'), h('small', { text: u })];
    const draw = () => { const t = at(); if (!t) { box.textContent = 'This event has passed.'; return; } let s = Math.floor((t - Date.now()) / 1000); const d = Math.floor(s / 86400); s %= 86400;
      box.replaceChildren(...(d ? seg(d, 'd') : []), ...seg(Math.floor(s / 3600), 'h'), ...seg(Math.floor(s / 60) % 60, 'm'), ...seg(s % 60, 's')); };
    draw(); setInterval(draw, 1000);
    const ics = h('button', { cls: 'btn btn-sm', type: 'button', text: 'Add to calendar (.ics)', onclick: () => {
      const t = at(); if (!t) return;
      const z = (x) => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const clean = (x) => String(x).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SUBZERONE//site kit v1//EN', 'BEGIN:VEVENT', `UID:${z(t)}-${location.host}`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(t)}`,
        `DTEND:${z(t + 30 * 60000)}`, ...(conf.daily ? ['RRULE:FREQ=DAILY'] : []), `SUMMARY:${clean(conf.title)}`, `URL:${location.origin}/`, ...(conf.link ? [`DESCRIPTION:${clean(conf.link)}`] : []), 'END:VEVENT', 'END:VCALENDAR'];
      save(new Blob([lines.join('\r\n')], { type: 'text/calendar' }), 'event.ics');
    } });
    (slot.querySelector('.row') || slot.appendChild(h('div', { cls: 'row' }))).prepend(ics);
  },

  memes(sec, slot, conf) {
    const name = doc.querySelector('h1')?.textContent || 'meme';
    const cv = h('canvas', { width: 640, height: 640, 'aria-label': 'Meme preview' }), g = cv.getContext('2d');
    const top = h('input', { type: 'text', maxlength: 60, value: conf.top || '', placeholder: 'Top text', 'aria-label': 'Top text' });
    const bottom = h('input', { type: 'text', maxlength: 60, value: conf.bottom || '', placeholder: 'Bottom text', 'aria-label': 'Bottom text' });
    const img = new Image();
    const line = (text, y, base) => {
      text = text.toUpperCase(); let size = 72; g.font = `800 ${size}px Inter, Impact, sans-serif`;
      while (size > 22 && g.measureText(text).width > 600) { size -= 4; g.font = `800 ${size}px Inter, Impact, sans-serif`; }
      g.textAlign = 'center'; g.textBaseline = base; g.lineWidth = Math.max(4, size / 9); g.strokeStyle = '#000'; g.fillStyle = '#fff'; g.lineJoin = 'round';
      g.strokeText(text, 320, y); g.fillText(text, 320, y);
    };
    const draw = () => {
      g.fillStyle = '#000'; g.fillRect(0, 0, 640, 640);
      if (img.complete && img.naturalWidth) g.drawImage(img, 120, 120, 400, 400);
      line(top.value, 26, 'top'); line(bottom.value, 614, 'bottom');
    };
    img.onload = draw; img.src = './logo.png';
    top.addEventListener('input', draw); bottom.addEventListener('input', draw);
    const dl = h('button', { cls: 'btn', type: 'button', text: 'Download PNG', onclick: () => cv.toBlob((b) => { if (b) save(b, `${name.replace(/[^\w-]+/g, '-').toLowerCase()}-meme.png`); }, 'image/png') });
    draw();
    slot.replaceChildren(h('div', { cls: 'meme' }, cv, h('div', { cls: 'fields' }, top, bottom), h('div', { cls: 'row' }, dl), h('p', { cls: 'fine', text: 'Made in your browser; nothing is uploaded.' })));
  },

  async map(sec, slot) {
    const s = await api('/_api/map');
    vendorCss('leafletCss');
    const L = (await vendor('leaflet')).default;
    const box = slot.querySelector('[data-map]') || h('div', { cls: 'map' });
    const accent = '#ffffff';
    const map = L.map(box, { scrollWheelZoom: false, attributionControl: true }).setView(s.center, s.zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }).addTo(map);
    const label = (title, sub) => h('div', {}, h('strong', { text: title }), sub ? h('div', { cls: 'fine', text: sub }) : null);
    const pin = (p, mineOrAuthor) => L.circleMarker([p.lat, p.lng], { radius: mineOrAuthor ? 9 : 7, color: '#000', weight: 2, fillColor: mineOrAuthor ? accent : '#8e8e8e', fillOpacity: 0.95 })
      .bindPopup(label(p.name || p.text, mineOrAuthor ? 'from the author' : `pinned ${new Date(p.at).toLocaleDateString()}`)).addTo(map);
    for (const p of s.places) pin(p, true);
    for (const p of s.pins) pin({ ...p, name: p.text }, false);
    const m = msg(), kids = [box];
    if (s.community) {
      const name = h('input', { type: 'text', maxlength: 40, placeholder: 'Tap the map, name the place', 'aria-label': 'Place name' });
      let at = null, ghost = null;
      map.on('click', (e) => { at = e.latlng; if (ghost) ghost.remove(); ghost = L.circleMarker(at, { radius: 8, color: accent, weight: 3, fillOpacity: 0 }).addTo(map); name.focus(); });
      const add = h('button', { cls: 'btn', type: 'button', text: 'Pin it', onclick: () => busy(add, async () => {
        if (!at) { say(m, 'Tap the map where the place is first.', 'err'); return; }
        try { const r = await api('/_api/map', { name: name.value, lat: at.lat, lng: at.lng }); pin({ ...r.pin, name: r.pin.text }, false); ghost?.remove(); name.value = ''; at = null; say(m, 'Pinned.', 'ok'); }
        catch (e) { say(m, explain(e), 'err'); }
      }) });
      kids.push(h('div', { cls: 'pinform' }, name, add), m);
    }
    kids.push(h('p', { cls: 'fine', text: 'Map data © OpenStreetMap contributors · Leaflet (BSD-2-Clause).' }));
    slot.replaceChildren(...kids);
    setTimeout(() => map.invalidateSize(), 200);
  },

  synth(sec, slot, conf) {
    const SCALES = { pentatonic: ['C4', 'D4', 'E4', 'G4', 'A4', 'C5'], minor: ['A3', 'C4', 'D4', 'E4', 'G4', 'A4'], major: ['C4', 'E4', 'F4', 'G4', 'B4', 'C5'], insen: ['D4', 'Eb4', 'G4', 'A4', 'C5', 'D5'] };
    const notes = (SCALES[conf.scale] || SCALES.pentatonic).slice().reverse();
    const grid = h('div', { cls: 'synth-grid', role: 'grid', 'aria-label': 'Step sequencer' });
    const on = notes.map(() => Array(8).fill(false));
    [[5, 0], [3, 2], [4, 4], [1, 6], [2, 7]].forEach(([r, c]) => { if (on[r]) on[r][c] = true; });
    const cells = notes.map((n, r) => Array.from({ length: 8 }, (_, c) => {
      const b = h('button', { type: 'button', cls: on[r][c] ? 'on' : '', 'aria-label': `${n} step ${c + 1}`, onclick: () => { on[r][c] = !on[r][c]; b.classList.toggle('on', on[r][c]); } });
      grid.append(b); return b;
    }));
    let T = null, seq = null, playing = false;
    const m = msg();
    const play = h('button', { cls: 'btn', type: 'button', text: 'Play', onclick: () => busy(play, async () => {
      try {
        if (!T) {
          say(m, 'Loading the sound engine (Tone.js)…');
          T = await vendor('tone');
          T.setContext(new T.Context({ clockSource: 'timeout', latencyHint: 'interactive' }));
          const synth = new T.PolySynth(T.Synth, { oscillator: { type: 'triangle' }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.2, release: 0.6 } }).toDestination();
          synth.volume.value = -10;
          seq = new T.Sequence((time, step) => {
            const chord = notes.filter((_, r) => on[r][step]); if (chord.length) synth.triggerAttackRelease(chord, '8n', time);
            T.getDraw().schedule(() => { cells.forEach((row) => row.forEach((b, c) => b.classList.toggle('now', c === step))); }, time);
          }, [0, 1, 2, 3, 4, 5, 6, 7], '8n');
          T.getTransport().bpm.value = conf.bpm || 96;
          say(m, '');
        }
        await T.start();
        if (playing) { T.getTransport().stop(); seq.stop(); playing = false; play.textContent = 'Play'; cells.forEach((row) => row.forEach((b) => b.classList.remove('now'))); }
        else { seq.start(0); T.getTransport().start(); playing = true; play.textContent = 'Stop'; }
      } catch (e) { say(m, `Sound could not start: ${e.message}`, 'err'); }
    }) });
    slot.replaceChildren(grid, h('div', { cls: 'row' }, play, h('button', { cls: 'btn btn-ghost', type: 'button', text: 'Clear', onclick: () => { on.forEach((row, r) => row.fill(false).forEach((_, c) => cells[r][c].classList.remove('on'))); } })),
      m, h('p', { cls: 'fine', text: `Scale: ${conf.scale} · ${conf.bpm} BPM · sound by Tone.js (MIT), made in your browser.` }));
  },

  game(sec, slot) {
    const cv = h('canvas', { width: 640, height: 480, 'aria-label': 'Mini-game' });
    const poster = h('div', { cls: 'game-poster', 'aria-hidden': 'true' }, h('img', { src: './logo.png', alt: '' }), h('p', { text: 'Thirty seconds. Catch the coins, dodge the red ones. Press Play.' }));
    const m = msg(), bestKey = `kit.game.${location.host}`;
    const best = () => Number(store.get(bestKey)) || 0;
    let started = false;
    const start = h('button', { cls: 'btn', type: 'button', text: 'Play (30 s)', onclick: () => busy(start, async () => {
      if (started) return; started = true;
      say(m, 'Loading the game engine (KAPLAY)…');
      try { const kaplay = (await vendor('kaplay')).default; poster.remove(); say(m, 'Move with the mouse, a finger or the arrow keys.'); runGame(kaplay, cv, m, best, (v) => store.set(bestKey, String(v)), () => { started = false; }); }
      catch (e) { started = false; say(m, `The game could not start: ${e.message}`, 'err'); }
    }) });
    slot.replaceChildren(h('div', { cls: 'game' }, cv, poster), h('div', { cls: 'row' }, start), m, h('p', { cls: 'fine', text: `Best on this device: ${best()} · engine: KAPLAY (MIT).` }));
  },

  async chart(sec, slot, conf) {
    const box = slot.querySelector('[data-chart]') || h('div', { cls: 'chart' });
    const s = await api(`/_api/token?range=${conf.range === '7d' ? '7d' : '24h'}`);
    const pts = (s.samples || []).filter((x) => isNum(x[1]));
    if (pts.length < 2) { box.replaceChildren(h('p', { cls: 'fine', text: s.state === 'pre-launch' ? 'Pre-launch: the chart starts with the first trades.' : 'Not enough samples yet: the chart fills in as the stats refresh.' })); return; }
    vendorCss('uplotCss');
    const UPlot = (await vendor('uplot')).default;
    const accent = '#ffffff';
    box.replaceChildren();
    const plot = new UPlot({ width: Math.max(280, box.clientWidth || 600), height: 220, legend: { show: false }, cursor: { drag: { x: false, y: false } },
      axes: [{ stroke: '#8e8e8e', font: '12px "JetBrains Mono", monospace', grid: { stroke: 'rgba(255,255,255,.1)', width: 1 }, ticks: { stroke: 'rgba(255,255,255,.16)', width: 1 } },
        { stroke: '#8e8e8e', font: '12px "JetBrains Mono", monospace', size: 86, grid: { stroke: 'rgba(255,255,255,.1)', width: 1 }, ticks: { stroke: 'rgba(255,255,255,.16)', width: 1 }, values: (u, v) => v.map(usd) }],
      series: [{}, { label: 'Price', stroke: accent, width: 1.5, fill: 'rgba(255,255,255,.06)' }] }, [pts.map((x) => x[0] / 1000), pts.map((x) => x[1])], box);
    win.addEventListener('resize', () => plot.setSize({ width: Math.max(280, box.clientWidth), height: 220 }));
  },
};

// the holder tools (trades, holders, devwatch, fees, alerts): kit/src/tools/holder-tools.js, a chunk of its own
// (/_kit/vendor/holder-tools.<hash>.js) loaded once on the sites that carry them, run on the same helpers as the core
let holder = null;
for (const id of ['trades', 'holders', 'devwatch', 'fees', 'alerts']) {
  TOOLS[id] = async (sec, slot, conf) => {
    holder ??= vendor('holderTools').then((m) => m.holderTools({ h, api, msg, say, busy, usd, count, slideIn, store, isNum, DASH, doc, win }));
    return (await holder)[id](sec, slot, conf);
  };
}

function runGame(kaplay, cv, m, best, setBest, done) {
  const k = kaplay({ canvas: cv, width: 640, height: 480, global: false, background: [0, 0, 0], letterbox: true, loadingScreen: false, burp: false, crisp: true, touchToMouse: true, maxFPS: 60, focus: false });
  k.loadSprite('logo', './logo.png');
  k.scene('play', () => {
    let score = 0, left = 30;
    const player = k.add([k.rect(96, 16, { radius: 8 }), k.pos(320, 452), k.anchor('center'), k.color(255, 255, 255), k.area(), 'player']);
    const hud = k.add([k.text('', { size: 22 }), k.pos(16, 14), k.color(241, 239, 232)]);
    k.onUpdate(() => {
      const mx = k.mousePos().x; if (mx > 0) player.pos.x = mx;
      if (k.isKeyDown('left')) player.pos.x -= 520 * k.dt(); if (k.isKeyDown('right')) player.pos.x += 520 * k.dt();
      player.pos.x = Math.max(48, Math.min(592, player.pos.x)); hud.text = `score ${score}   ${Math.ceil(left)} s`;
    });
    k.loop(0.55, () => {
      const bad = k.rand() < 0.25, x = k.rand(30, 610);
      k.add(bad ? [k.circle(14), k.color(255, 92, 92), k.pos(x, -20), k.anchor('center'), k.area(), k.move(k.DOWN, k.rand(180, 300)), k.offscreen({ destroy: true }), 'bad']
        : [k.sprite('logo', { width: 40, height: 40 }), k.pos(x, -20), k.anchor('center'), k.area(), k.move(k.DOWN, k.rand(160, 260)), k.offscreen({ destroy: true }), 'coin']);
    });
    player.onCollide('coin', (c) => { k.destroy(c); score += 1; });
    player.onCollide('bad', (c) => { k.destroy(c); score = Math.max(0, score - 3); k.shake(6); });
    k.loop(0.1, () => { left -= 0.1; if (left <= 0) k.go('over', score); });
  });
  k.scene('over', (score) => {
    if (score > best()) setBest(score);
    k.add([k.text(`${score} coins`, { size: 48 }), k.pos(320, 200), k.anchor('center'), k.color(255, 255, 255)]);
    k.add([k.text(`best on this device: ${best()}   ·   click to play again`, { size: 18 }), k.pos(320, 260), k.anchor('center'), k.color(241, 239, 232)]);
    k.onClick(() => k.go('play'));
    say(m, `Game over: ${score}. Click the game to play again.`);
    done();
  });
  k.go('play');
}

function spark(box, samples) {
  if (!box) return;
  const pts = samples.filter((x) => isNum(x[1]));
  if (pts.length < 2) { box.replaceChildren(); return; }
  const xs = pts.map((x) => x[0]), ys = pts.map((x) => x[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 600, H = 64, px = (x) => ((x - x0) / (x1 - x0 || 1)) * W, py = (y) => H - 4 - ((y - y0) / (y1 - y0 || 1)) * (H - 8);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join('');
  const up = ys[ys.length - 1] >= ys[0], stroke = up ? '#38d47a' : '#ff5c5c';
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Price over the last ${pts.length} samples` });
  svg.append(svgEl('path', { d: `${d}L${W},${H}L0,${H}Z`, fill: stroke, 'fill-opacity': '0.12' }), svgEl('path', { d, fill: 'none', stroke, 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke' }));
  box.replaceChildren(svg);
  if (!reduce) animate(svg, { opacity: [0, 1] }, { duration: 0.6 });
}

function save(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  doc.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function hydrate(sec) {
  const id = sec.dataset.tool, run = TOOLS[id], slot = sec.querySelector('[data-slot]');
  if (!run || !slot) return;
  let conf = {}; try { conf = JSON.parse(sec.dataset.config || '{}'); } catch { /* the server's copy rules anyway */ }
  try {
    await run(sec, slot, conf);
    sec.querySelector('[data-static]')?.remove();
    sec.classList.add('live');
  } catch (e) {
    const note = sec.querySelector('[data-static]');
    if (note) note.textContent = e?.status === 404 ? 'This tool is switched off.' : `Could not load this tool right now (${e?.message || 'error'}).`;
  }
}

function copyButton(code) {
  const mint = code.textContent.trim();
  const b = h('button', { cls: 'btn btn-sm', type: 'button', text: 'Copy', 'aria-label': 'Copy the contract address', onclick: async () => {
    try { await navigator.clipboard.writeText(mint); b.textContent = 'Copied'; }
    catch { const r = doc.createRange(); r.selectNodeContents(code); const s = win.getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1600);
  } });
  return b;
}
function chrome() {
  for (const box of doc.querySelectorAll('[data-ca-copy]')) { const code = box.querySelector('[data-ca]'); if (code) box.append(copyButton(code)); }
  const dock = doc.querySelector('.dock');
  const watch = [doc.querySelector('.hero-cta'), doc.querySelector('#app')].filter(Boolean);
  if (dock && watch.length && 'IntersectionObserver' in win) {
    const seen = new Set();
    const io = new IntersectionObserver((list) => { for (const e of list) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); } dock.classList.toggle('is-away', seen.size > 0); });
    for (const w of watch) io.observe(w);
  }
}

function boot() {
  doc.documentElement.classList.add('kit');
  chrome();
  motionIn();
  for (const sec of doc.querySelectorAll('section[data-tool]')) hydrate(sec);
  // the idea app (kit/app/*.js, docs/APP-COMPOSER.md): the same helpers, the same text-only rules
  const K = { h, api, signed, save, vendor, msg, say, busy, explain, store, slideIn, tick, TOOLS };
  for (const sec of doc.querySelectorAll('section[data-app]')) import(/* @vite-ignore */ '/_kit/site-app.v1.js').then((m) => m.hydrateApp(sec, K)).catch((e) => {
    const n = sec.querySelector('[data-static]'); if (n) n.textContent = `The app could not load right now (${e?.message || 'error'}).`;
  });
}
if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
