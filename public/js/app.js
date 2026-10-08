// Router, header (wallet, nav), banners, toasts. Pages live in pages.js, project.js and admin.js.
import { api, html, esc, short } from './lib.js';
import { listWallets, onWallets, signIn } from './wallet.js';
import * as pages from './pages.js';
import * as project from './project.js';
import * as admin from './admin.js';

export const state = { config: null, me: null, timers: [] };

const ROUTES = [
  [/^\/$/, pages.home], [/^\/submit$/, pages.submit], [/^\/ideas\/([^/]+)$/, pages.idea], [/^\/how$/, pages.how],
  [/^\/token$/, pages.token], [/^\/fees$/, pages.fees], [/^\/me$/, pages.me], [/^\/admin$/, admin.page],
  [/^\/projects\/([^/]+)\/review$/, project.review], [/^\/projects\/([^/]+)$/, project.publicPage],
];

export function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }

export async function render() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  const path = location.pathname;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === path));
  const el = document.getElementById('app');
  const hit = ROUTES.find(([re]) => re.test(path));
  if (!hit) { el.innerHTML = html`<h1>Not here.</h1><p class="dim">This page does not exist. <a href="/" data-link>Back to his room.</a></p>`.s; return; }
  const params = path.match(hit[0]).slice(1).map(decodeURIComponent);
  try {
    await hit[1](el, ...params);
  } catch (e) {
    el.innerHTML = html`<h1>${e.status === 404 ? 'Not found' : 'Something broke'}</h1><p class="dim">${e.message}</p>`.s;
  }
  window.scrollTo?.(0, 0);
}

export function go(path) { history.pushState({}, '', path); render(); }

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link], a[href^="/"]');
  if (!a || a.target || e.metaKey || e.ctrlKey || a.hasAttribute('data-external')) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('/api/') || href.startsWith('/meta/')) return;
  e.preventDefault();
  go(href);
});
window.addEventListener('popstate', render);

export function toast(msg, bad = false) {
  const t = document.createElement('div');
  t.className = `toast${bad ? ' bad' : ''}`;
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

export function modal(content) {
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="box">${content}</div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); };
  return { el: m, close };
}

/** Ask the user to pick a wallet and sign in. Resolves when signed in. */
export function requireSignIn() {
  return new Promise((resolve) => {
    const draw = () => {
      const ws = listWallets();
      const m = modal(html`<h3>Connect a Solana wallet</h3>
        <p class="dim small">You sign a short text message to prove the wallet is yours. It is not a transaction: it moves no funds and costs nothing. We never ask for your seed phrase.</p>
        ${ws.length ? ws.map((w) => html`<button class="wallet-choice" data-wallet="${w.name}">${w.icon ? html`<img src="${w.icon}" alt="">` : ''}${w.name}</button>`)
    : html`<div class="empty">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</div>`}
        <p class="row" style="margin-top:12px"><button class="ghost" data-close>cancel</button></p>`.s);
      m.el.querySelectorAll('[data-wallet]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await signIn(b.dataset.wallet);
          m.close();
          await refreshMe();
          toast('Signed in.');
          resolve(true);
        } catch (e) {
          b.disabled = false;
          toast(e.message || 'sign-in failed', true);
        }
      }));
    };
    draw();
    const off = onWallets(() => { if (!document.getElementById('modal').hidden) draw(); });
    setTimeout(off, 15000);
  });
}

export async function refreshMe() {
  state.me = await api('/api/me').catch(() => ({ user: null }));
  const box = document.getElementById('walletbox');
  const u = state.me.user;
  document.getElementById('nav-me').hidden = !u;
  document.getElementById('nav-admin').hidden = !(u && (u.role === 'admin' || u.role === 'reviewer'));
  if (u) {
    box.innerHTML = html`<span class="pill" title="${u.wallet}">${short(u.wallet)}</span>${u.role !== 'user' ? html`<span class="chip or">${u.role}</span>` : ''}<button class="ghost" id="logout">sign out</button>`.s;
    box.querySelector('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); await refreshMe(); render(); };
  } else {
    box.innerHTML = '<button id="connect">connect wallet</button>';
    box.querySelector('#connect').onclick = async () => { if (await requireSignIn()) render(); };
  }
  return state.me;
}

async function boot() {
  state.config = await api('/api/config');
  const b = document.getElementById('banner');
  const l = state.config.launch;
  if (l.mock) { b.className = 'mock'; b.textContent = 'PREVIEW · Launches here use a MOCK provider: no blockchain, no tokens, no fees. The launchpad is a planned feature and not live yet.'; b.hidden = false; }
  else if (l.network === 'devnet') { b.textContent = 'PREVIEW · Launches here happen on Solana DEVNET: test tokens with no value. The launchpad is a planned feature and not live yet.'; b.hidden = false; }
  else if (l.provider === 'none') { b.textContent = 'PREVIEW · Ideas and builds work; launching is switched off. The launchpad is a planned feature and not live yet.'; b.hidden = false; }
  await refreshMe();
  await render();
}
boot().catch((e) => { document.getElementById('app').innerHTML = `<p class="pad">Could not load: ${esc(e.message)}</p>`; });
