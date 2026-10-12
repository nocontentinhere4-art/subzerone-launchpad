import { api, html, short, when, ago, pct } from './lib.js';
import { state, toast, every } from './app.js';
import { statusChip } from './pages.js';
import { supportSection } from './support-admin.js';

export async function page(root) {
  // the support inbox (support-admin.js) on top, drawn on its own so a reply being typed survives the refresh below
  root.innerHTML = '<h1>Admin</h1><section id="support"></section><div id="admin-main"></div>';
  const support = supportSection(root.querySelector('#support'));
  const el = root.querySelector('#admin-main');
  const draw = async () => {
    const o = await api('/api/admin/overview');
    const admin = o.role === 'admin';
    el.innerHTML = html`
    <h2>Ideas</h2>
    <div class="grid3">
      ${Object.entries(o.counts).map(([k, v]) => html`<div class="card"><div class="dim tiny">${k}</div><div style="font-size:24px">${v}</div></div>`)}
      ${Object.keys(o.counts).length ? '' : html`<div class="empty">No ideas yet.</div>`}
    </div>

    <h2>Emergency pauses</h2>
    <div class="row">${Object.entries(o.pauses).map(([k, v]) => html`<button class="${v ? 'danger' : ''}" data-pause="${k}" data-to="${!v}" ${admin ? '' : 'disabled'}>${v ? '■ paused' : '▶ running'} · ${k}</button>`)}</div>

    <div class="grid2">
      <div><h2>Budgets</h2>
        <form id="budget" class="row"><span class="small">spent today $${o.budget.spentToday.toFixed(2)}</span>
          <label style="margin:0">global/day $<input name="g" type="number" step="0.01" value="${o.budget.globalDailyUsd}" style="width:90px"></label>
          <label style="margin:0">per project $<input name="p" type="number" step="0.01" value="${o.budget.perProjectUsd}" style="width:90px"></label>
          <button ${admin ? '' : 'disabled'}>save</button></form></div>
      <div><h2>SUB-01 fee share</h2>
        <p class="small">Fixed: ${pct(o.sub01Share.bps)} of every project's creator fees to ${o.sub01Share.wallet ? html`<span class="addr tiny">${o.sub01Share.wallet}</span>` : html`<b>nobody yet: set SUB01_FEE_WALLET, approvals are refused until then</b>`}.</p></div>
    </div>

    <h2>Clearance queue</h2>
    ${o.clearance.length ? html`<table><tr><th>project</th><th>status</th><th>submitter approved</th><th>cleared</th><th></th></tr>${o.clearance.map((c) => html`<tr>
      <td><a href="/projects/${c.slug}/review" data-link>${c.name}</a> <span class="pill">$${c.ticker}</span></td><td>${statusChip(c.status)}</td><td>${when(c.submitter_approved_at)}</td><td>${when(c.admin_cleared_at)}</td>
      <td>${c.admin_cleared_at ? '' : html`<button class="tiny primary" data-clear="${c.slug}">clear for launch</button>`} <button class="tiny danger" data-cancel="${c.idea_id}" ${admin ? '' : 'disabled'}>remove</button></td></tr>`)}</table>`
    : html`<div class="empty">Nothing waiting for clearance.</div>`}

    <h2>Most requested missing capabilities</h2>
    <p class="small dim">What ideas keep asking for that SUB-01 could not build (or built only in part), from each idea's latest "Does it match the idea?" check.</p>
    ${(o.missingCapabilities || []).length ? html`<div class="tablewrap"><table><tr><th>capability</th><th>ideas</th><th>missing</th><th>in part</th><th>last asked</th></tr>${o.missingCapabilities.map((c) => html`<tr>
      <td><b>${c.capability}</b><div class="faint tiny">${c.feature}</div></td><td>${c.ideas}</td><td>${c.missing}</td><td>${c.partial}</td><td class="small">${ago(c.lastAt)}</td></tr>`)}</table></div>`
    : html`<div class="empty">Every idea checked so far was built as described.</div>`}

    <h2>Stopped ideas</h2>
    ${o.failed.length ? html`<table>${o.failed.map((f) => html`<tr><td><a href="/ideas/${f.id}" data-link>${f.title}</a></td><td class="small">${f.status_note}</td><td><button class="tiny" data-retry="${f.id}" ${admin ? '' : 'disabled'}>retry</button></td></tr>`)}</table>` : html`<div class="empty">None.</div>`}

    <h2>Jobs: dead letters, running, queued</h2>
    ${o.jobs.length ? html`<div class="tablewrap"><table><tr><th>job</th><th>status</th><th>tries</th><th>next</th><th>progress / error</th><th></th></tr>${o.jobs.map((j) => html`<tr>
      <td class="small">${j.type}<div class="faint tiny">${j.id}</div></td><td><span class="chip ${j.status === 'dead' ? 'bad' : j.status === 'running' ? 'or' : ''}">${j.status}</span></td>
      <td>${j.attempts}/${j.max_attempts}</td><td class="small">${j.status === 'queued' ? when(j.run_after) : ''}</td><td class="small">${j.progress || ''}<div class="faint tiny">${j.last_error || ''}</div></td>
      <td>${j.status === 'dead' ? html`<button class="tiny" data-requeue="${j.id}" ${admin ? '' : 'disabled'}>requeue</button>` : ''}</td></tr>`)}</table></div>` : html`<div class="empty">Queue empty.</div>`}

    <h2>Launch intents</h2>
    ${o.intents.length ? html`<div class="tablewrap"><table><tr><th>intent</th><th>status</th><th>network</th><th>mint</th><th>signature</th><th>error</th><th>updated</th></tr>${o.intents.map((i) => html`<tr>
      <td class="tiny">${i.id}</td><td>${i.status}</td><td>${i.provider}/${i.network}</td><td class="addr tiny">${short(i.mint, 6)}</td><td class="addr tiny">${short(i.tx_signature, 6)}</td><td class="small">${i.error || ''}${String(i.error || '').startsWith('landed:') ? html` <button class="tiny" data-reverify="${i.slug}" ${admin ? '' : 'disabled'}>re-verify on-chain</button>` : ''}</td><td class="small">${ago(i.updated_at)}</td></tr>`)}</table></div>` : html`<div class="empty">No launch attempts yet.</div>`}

    <div class="grid2"><div>
      <h2>Roles</h2>
      <form id="role" class="row"><input name="wallet" placeholder="wallet" style="flex:2"><select name="role" style="width:120px"><option>user</option><option>reviewer</option><option>admin</option></select><button ${admin ? '' : 'disabled'}>set</button></form>
      <table>${o.users.map((u) => html`<tr><td class="addr tiny">${u.wallet}</td><td>${u.role}</td><td>${u.banned_at ? 'banned' : ''}</td></tr>`)}</table>
      <form id="ban" class="row" style="margin-top:8px"><input name="wallet" placeholder="wallet to ban / unban" style="flex:2"><button name="b" value="1" ${admin ? '' : 'disabled'}>ban</button><button name="b" value="0" ${admin ? '' : 'disabled'}>unban</button></form>
    </div><div>
      <h2>Operations</h2>
      <p class="row"><button id="backup" ${admin ? '' : 'disabled'}>Take a database backup now</button></p>
      ${o.mockBehaviour !== undefined ? html`<p class="small">Mock provider behaviour (for testing failure paths):</p>
        <select id="mock" style="width:auto">${['ok', 'reject_on_chain', 'never_lands', 'late', 'slow_index', 'preflight_reject', 'timeout_but_lands'].map((b) => html`<option ${b === o.mockBehaviour ? 'selected' : ''}>${b}</option>`)}</select>` : ''}
    </div></div>

    <h2>Audit log</h2>
    <div class="tablewrap"><table>${o.audits.map((a) => html`<tr><td class="small">${when(a.at)}</td><td class="tiny">${a.actor.replace(/^(wallet|admin):(.{4}).*(.{4})$/, '$1:$2…$3')}</td><td class="tiny">${a.kind}</td><td class="small">${a.message}</td></tr>`)}</table></div>`.s;

    const post = async (path, body, msg) => { try { await api(path, { method: 'POST', body }); if (msg) toast(msg); draw(); } catch (e) { toast(e.message, true); } };
    el.querySelectorAll('[data-pause]').forEach((b) => { b.onclick = () => post('/api/admin/pause', { what: b.dataset.pause, paused: b.dataset.to === 'true' }); });
    el.querySelectorAll('[data-clear]').forEach((b) => { b.onclick = () => post(`/api/admin/projects/${b.dataset.clear}/clear`, {}, 'Cleared.'); });
    el.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => confirm('Remove this idea?') && post(`/api/admin/ideas/${b.dataset.cancel}/cancel`, {}); });
    el.querySelectorAll('[data-retry]').forEach((b) => { b.onclick = () => post(`/api/admin/ideas/${b.dataset.retry}/retry`, {}); });
    el.querySelectorAll('[data-reverify]').forEach((b) => { b.onclick = () => post(`/api/admin/projects/${b.dataset.reverify}/reverify`, {}, 'Re-verifying.'); });
    el.querySelectorAll('[data-requeue]').forEach((b) => { b.onclick = () => post(`/api/admin/jobs/${b.dataset.requeue}/retry`, {}); });
    el.querySelector('#budget').onsubmit = (e) => { e.preventDefault(); post('/api/admin/budget', { globalDailyUsd: e.target.g.value, perProjectUsd: e.target.p.value }, 'Saved.'); };
    el.querySelector('#role').onsubmit = (e) => { e.preventDefault(); post(`/api/admin/users/${encodeURIComponent(e.target.wallet.value.trim())}/role`, { role: e.target.role.value }); };
    el.querySelector('#ban').onsubmit = (e) => { e.preventDefault(); post(`/api/admin/users/${encodeURIComponent(e.target.wallet.value.trim())}/ban`, { banned: e.submitter?.value === '1' }); };
    el.querySelector('#backup').onclick = () => post('/api/admin/backup', {}, 'Backup written.');
    const mock = el.querySelector('#mock');
    if (mock) mock.onchange = () => post('/api/admin/mock-behaviour', { behaviour: mock.value }, `Mock: ${mock.value}`);
  };
  if (!state.me?.user || !['admin', 'reviewer'].includes(state.me.user.role)) { root.innerHTML = html`<h1>Admin</h1><div class="empty">Admins and reviewers only.</div>`.s; return; }
  await Promise.all([draw(), support.draw().catch((x) => toast(x.message, true))]);
  if (location.hash === '#support') root.querySelector('#support').scrollIntoView();
  const idle = (box) => { const a = document.activeElement; return !box.contains(a) || a.tagName === 'BUTTON' || a === document.body; };
  every(10000, () => { if (idle(el)) draw().catch(() => {}); if (idle(root.querySelector('#support'))) support.draw().catch(() => {}); });
}
