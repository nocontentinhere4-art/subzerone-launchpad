// The owner's support inbox on /admin (#support): reports from the city's Help button and launch errors, newest first,
// with what the browser and the database said at the time. Reply (signed "SUBZERONE support" to the author), set the
// status, filter. Drafts survive the page's 10 s refresh.
import { api, html, short, when, ago } from './lib.js';
import { toast } from './app.js';

const CATS = { launch: 'Launch', wallet: 'Wallet/Phantom', devbuy: 'Dev buy', site: 'My site', x: 'X', other: 'Other' };
const STATUS = { open: 'open', in_progress: 'in progress', answered: 'answered', closed: 'closed' };
const chipClass = (s) => (s === 'open' ? 'bad' : s === 'in_progress' ? 'or' : s === 'answered' ? 'ok' : '');
const pretty = (o) => JSON.stringify(o, null, 2);

export function supportSection(box) {
  const drafts = new Map();
  const filter = { status: 'open,in_progress', category: '', q: '' };
  const open = new Set();
  const draw = async () => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    const o = await api(`/api/admin/support?${qs}`);
    box.innerHTML = html`
      <h2 style="display:flex;gap:10px;align-items:center">Support <span class="chip ${o.open ? 'bad' : ''}" id="support-open">${o.open} open</span></h2>
      <form class="row" id="support-filter" style="margin-bottom:12px">
        <select name="status" style="width:auto">${[['open,in_progress', 'open + in progress'], ['', 'all'], ...Object.entries(STATUS)].map(([v, l]) => html`<option value="${v}" ${v === filter.status ? 'selected' : ''}>${l}${v && !v.includes(',') ? ` (${o.counts[v] ?? 0})` : ''}</option>`)}</select>
        <select name="category" style="width:auto"><option value="">every category</option>${Object.entries(CATS).map(([v, l]) => html`<option value="${v}" ${v === filter.category ? 'selected' : ''}>${l}</option>`)}</select>
        <input name="q" placeholder="search text, wallet, slug, sup_…" value="${filter.q}" style="flex:1;min-width:180px">
        <button>filter</button>
      </form>
      ${o.tickets.length ? o.tickets.map((t) => ticketCard(t, open.has(t.id))) : html`<div class="empty">No reports here.</div>`}`.s;
    for (const [k, v] of drafts) { const ta = box.querySelector(`[data-draft="${k}"]`); if (ta) ta.value = v; }
    box.querySelector('#support-filter').onsubmit = (e) => { e.preventDefault(); const f = e.target; Object.assign(filter, { status: f.status.value, category: f.category.value, q: f.q.value.trim() }); draw(); };
    box.querySelectorAll('details[data-ticket]').forEach((d) => { d.ontoggle = () => { if (d.open) open.add(d.dataset.ticket); else open.delete(d.dataset.ticket); }; });
    box.querySelectorAll('[data-draft]').forEach((ta) => { ta.oninput = () => drafts.set(ta.dataset.draft, ta.value); });
    box.querySelectorAll('[data-reply]').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const id = f.dataset.reply, text = f.text.value.trim();
        if (!text) return toast('Write the reply first.', true);
        try { await api(`/api/admin/support/${id}/reply`, { method: 'POST', body: { text, status: f.status.value } }); drafts.delete(id); toast('Reply sent.'); draw(); } catch (x) { toast(x.message, true); }
      };
    });
    box.querySelectorAll('[data-set-status]').forEach((b) => {
      b.onclick = async () => {
        try { await api(`/api/admin/support/${b.dataset.id}/status`, { method: 'POST', body: { status: b.dataset.setStatus } }); draw(); } catch (x) { toast(x.message, true); }
      };
    });
  };
  return { draw };
}

function ticketCard(t, isOpen) {
  const lc = t.clientContext?.launch;
  const firstErr = lc?.message || t.clientContext?.errors?.at(-1)?.message || t.serverContext?.projects?.[0]?.intents?.find((i) => i.error)?.error || '';
  return html`<details class="card support-ticket" data-ticket="${t.id}" ${isOpen ? 'open' : ''} style="margin-bottom:10px">
    <summary style="cursor:pointer;list-style:none">
      <div class="row" style="gap:8px">
        <span class="chip ${chipClass(t.status)}">${STATUS[t.status] || t.status}</span><b>${CATS[t.category] || t.category}</b>
        <span class="small dim">${ago(t.createdAt)} · ${t.signedIn ? html`<span class="addr">${short(t.wallet, 5)}</span>` : 'anonymous'}${t.projectSlug ? html` · <code>${t.projectSlug}</code>` : ''}${t.source !== 'help' ? ` · from ${t.source.replace('_', ' ')}` : ''}${t.replies.length ? ` · ${t.replies.length} repl${t.replies.length === 1 ? 'y' : 'ies'}` : ''}</span>
        ${t.redacted ? html`<span class="chip bad tiny" title="Something that looked like a key, a seed phrase or a signed transaction was removed before it was stored">secret removed</span>` : ''}
        <span class="faint tiny" style="margin-left:auto">${t.id}</span>
      </div>
      <p style="margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere">${t.message.length > 260 && !isOpen ? `${t.message.slice(0, 260)}…` : t.message}</p>
      ${firstErr ? html`<p class="small" style="color:var(--bad);margin:4px 0 0;overflow-wrap:anywhere">${firstErr}</p>` : ''}
    </summary>
    <div style="margin-top:12px">
      <div class="kv small">
        <span>when</span><span>${when(t.createdAt)}</span>
        <span>contact</span><span>${t.contact || '—'}</span>
        <span>wallet</span><span class="addr">${t.wallet || 'not signed in'}${t.clientContext?.wallet && t.clientContext.wallet !== t.wallet ? html` <span class="dim">(browser says ${short(t.clientContext.wallet, 5)})</span>` : ''}</span>
        ${lc ? html`<span>launch flow</span><span>${[lc.step && `step ${lc.step}`, lc.status, lc.intentId, lc.code, lc.httpStatus].filter(Boolean).join(' · ')}</span>` : ''}
        ${t.clientContext ? html`<span>browser</span><span>${[t.clientContext.viewport, (t.clientContext.wallets || []).join(', ') || 'no wallet extension', t.clientContext.bundle].filter(Boolean).join(' · ')}<div class="faint tiny">${t.clientContext.userAgent || ''}</div></span>` : html`<span>browser</span><span class="dim">context not shared by the author</span>`}
      </div>
      <details style="margin-top:10px"><summary class="small dim" style="cursor:pointer">Server context (database)</summary><pre class="tiny" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto">${pretty(t.serverContext)}</pre></details>
      ${t.clientContext ? html`<details><summary class="small dim" style="cursor:pointer">Browser context (as sent)</summary><pre class="tiny" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto">${pretty(t.clientContext)}</pre></details>` : ''}
      ${t.replies.length ? html`<h3 style="margin-top:14px">Replies</h3>${t.replies.map((r) => html`<div class="card" style="padding:10px;margin-bottom:6px"><div class="tiny dim">${r.author === 'operator' ? 'AI operator' : short(r.author.replace(/^admin:/, ''), 5)} · ${when(r.at)} · shown as "${r.from}"</div><div style="white-space:pre-wrap;overflow-wrap:anywhere">${r.text}</div></div>`)}` : ''}
      <form data-reply="${t.id}" style="margin-top:10px">
        <textarea name="text" data-draft="${t.id}" rows="3" maxlength="4000" placeholder="Reply to the author (they see it as “SUBZERONE support”)"></textarea>
        <div class="row" style="margin-top:6px"><select name="status" style="width:auto">${Object.entries(STATUS).map(([v, l]) => html`<option value="${v}" ${v === 'answered' ? 'selected' : ''}>then: ${l}</option>`)}</select><button class="primary">Send reply</button>
          ${t.status !== 'closed' ? html`<button type="button" data-id="${t.id}" data-set-status="closed">Close</button>` : html`<button type="button" data-id="${t.id}" data-set-status="open">Reopen</button>`}
          ${t.status === 'open' ? html`<button type="button" data-id="${t.id}" data-set-status="in_progress">Mark in progress</button>` : ''}</div>
      </form>
    </div>
  </details>`;
}
