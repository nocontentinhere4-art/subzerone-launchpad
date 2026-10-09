import { api, html, raw, short, when, sol, pct, copyButton } from './lib.js';
import { state, toast, requireSignIn, every, go } from './app.js';
import { statusChip, brainCard } from './pages.js';
import { connected, signTransaction, signMessageText } from './wallet.js';

const tokenAmount = (base, decimals) => (base == null ? '—' : (Number(base) / 10 ** decimals).toLocaleString());

function verification(launch) {
  return html`<div class="card ${launch.provider === 'mock' ? '' : 'accent'}"><h3>Launch verification ${launch.provider === 'mock' ? html`<span class="chip mock">MOCK · no blockchain</span>` : html`<span class="chip ok">verified on ${launch.network}</span>`}</h3>
    <div class="kv small">
      <span>mint</span><span class="addr">${launch.mint} ${copyButton(launch.mint)}</span>
      <span>transaction</span><span class="addr">${launch.explorerTx ? html`<a href="${launch.explorerTx}" target="_blank" rel="noopener" data-external>${short(launch.tx_signature, 10)}</a>` : short(launch.tx_signature, 10)}</span>
      <span>slot</span><span>${launch.slot ?? '—'}</span><span>verified</span><span>${when(launch.verified_at)}</span>
    </div>
    <ul class="small" style="margin:10px 0 0;padding-left:18px">${launch.verification.map((c) => html`<li>${c.ok ? '✓' : '✗'} ${c.name}${c.detail != null && c.detail !== 'ok' ? html` <span class="faint">(${String(c.detail).slice(0, 60)})</span>` : ''}</li>`)}</ul></div>`;
}

function ledgerCard(l) {
  if (!l) return '';
  return html`<div class="card"><h3>Creator fees ${l.mock ? html`<span class="chip mock">mock</span>` : ''}</h3>
    <div class="kv small">
      <span>split</span><span>${l.mode === 'sharing_config' ? 'on-chain fee sharing, locked' : 'direct to the creator wallet'}</span>
      <span>verified undistributed</span><span>${sol(l.verifiedUndistributedLamports)} <span class="faint">(${l.vaultScope})</span></span>
      <span>confirmed payouts</span><span>${sol(l.confirmedPayoutsLamports)}</span>
      <span>observed</span><span>${when(l.vaultObservedAt)}${l.vaultSlot ? ` · slot ${l.vaultSlot}` : ''}</span>
      <span>trading fees at launch</span><span>${l.tradingFees?.protocolFeeBps != null ? `protocol ${pct(l.tradingFees.protocolFeeBps)} · creator ${pct(l.tradingFees.creatorFeeBps)}` : 'n/a'} <span class="faint">${l.tradingFees?.source || ''}</span></span>
    </div>
    <table style="margin-top:10px"><tr><th>recipient</th><th>share</th><th>paid out</th><th>share if distributed now (estimate)</th></tr>
      ${l.recipients.map((r) => html`<tr><td>${r.label}<div class="addr tiny faint">${r.wallet}</div></td><td>${pct(r.bps)}</td><td>${sol(r.confirmedPayouts)}</td><td>${r.estimatedShareOfUndistributed == null ? 'n/a' : sol(r.estimatedShareOfUndistributed)}</td></tr>`)}
    </table>
    ${l.payouts.length ? html`<p class="small" style="margin-top:8px">Payout transactions: ${l.payouts.map((p) => html`<span class="addr tiny">${short(p.tx, 8)} </span>`)}</p>` : ''}
  </div>`;
}

// --- public project page -------------------------------------------------------------------------------------------
export async function publicPage(el, slug) {
  const p = await api(`/api/projects/${slug}`);
  el.innerHTML = html`
  <p class="small"><a href="/ideas/${p.ideaId}" data-link class="dim">← the idea</a></p>
  <div class="row" style="justify-content:space-between"><h1>${p.name} <span class="pill">$${p.ticker}</span></h1>${statusChip(p.status, p.launch?.provider, p.launch?.network)}</div>
  <p class="dim">${p.description}</p>
  <p class="small">Idea by <span class="addr">${short(p.submittedBy, 6)}</span> · built by SUB-01 · copy by ${p.generator?.startsWith('anthropic') ? `a language model (${p.generator.split(':')[1]})` : 'a fixed template (no AI)'}</p>
  <p class="row">${p.siteUrl ? html`<a class="btn" href="${p.siteUrl}" target="_blank" rel="noopener" data-external>Project site ↗</a>` : ''}
    ${p.owner ? html`<a class="btn primary" href="/projects/${slug}/review" data-link>Review & launch →</a>` : ''}
    ${p.x?.x_handle ? html`<a class="btn" href="https://x.com/${p.x.x_handle}" target="_blank" rel="noopener" data-external>@${p.x.x_handle}</a>` : ''}</p>
  <div class="grid2" style="margin-top:16px">
    <div>${p.launch ? verification(p.launch) : html`<div class="card"><h3>Not launched</h3><p class="small dim">${p.statusNote || 'No token exists for this project.'}</p></div>`}
      <div style="margin-top:14px">${p.ledger ? ledgerCard(p.ledger) : html`<div class="card"><h3>Creator fees</h3><p class="small dim">No fees: nothing is launched. Planned split: ${(p.allocation?.recipients || []).map((r) => `${r.label} ${pct(r.bps)}`).join(', ') || '—'}.</p></div>`}</div>
    </div>
    <div>${p.brain ? raw(brainCard(p.brain, p.scores).s) : ''}</div>
  </div>
  <p class="faint tiny" style="margin-top:20px">This token is separate from SUB-01's own token. No promises, no rights, no advice.</p>`.s;
}

// --- owner review ----------------------------------------------------------------------------------------------------
export async function review(el, slug) {
  if (!state.me?.user && !(await requireSignIn())) return;
  let p;
  const draw = async () => {
    p = await api(`/api/projects/${slug}`);
    p.previewUrl = (await api(`/api/projects/${slug}/preview-link`)).url;
    if (!p.owner && !p.staff) { el.innerHTML = html`<h1>Not yours</h1><p class="dim">Only the idea's submitter can review this project. <a href="/projects/${slug}" data-link>Public page →</a></p>`.s; return; }
    const editable = p.status === 'preview_ready' && p.owner;
    const spec = p.spec || {};
    const live = p.liveSiteVersion;
    el.innerHTML = html`
    <p class="small"><a href="/ideas/${p.ideaId}" data-link class="dim">← the idea</a></p>
    <div class="row" style="justify-content:space-between"><h1>${p.name} <span class="pill">$${p.ticker}</span></h1>${statusChip(p.status, p.launch?.provider, p.launch?.network)}</div>
    ${p.statusNote ? html`<div class="notice">${p.statusNote}</div>` : ''}
    ${p.launch ? raw(verification(p.launch).s) : ''}

    <h2>1 · The website</h2>
    <div class="grid2">
      <div><iframe class="preview-frame" title="site preview" src="${p.previewUrl}" sandbox="" referrerpolicy="no-referrer"></iframe>
        <p class="faint tiny"><a href="${p.previewUrl}" target="_blank" rel="noopener" data-external>Open the preview in a new tab ↗</a> · Preview of version ${live}. It's a static page with no scripts, served under a "sandbox" policy. ${p.siteUrl ? html`Public address: <a href="${p.siteUrl}" target="_blank" rel="noopener" data-external>${p.siteUrl}</a>` : 'It gets a public address once the idea is published.'}</p></div>
      <div>
        ${editable ? html`<form id="edit">
          <div class="grid2"><div><label>Name</label><input name="name" maxlength="32" value="${spec.name}"></div><div><label>Ticker</label><input name="ticker" maxlength="10" value="${spec.ticker}"></div></div>
          <label>Tagline</label><input name="tagline" maxlength="90" value="${spec.tagline}">
          <label>Description (also the token metadata)</label><textarea name="description" maxlength="500" style="min-height:80px">${spec.description}</textarea>
          ${(spec.sections || []).map((s, i) => html`<label>Section ${i + 1}</label><input name="h${i}" maxlength="60" value="${s.heading}"><textarea name="b${i}" maxlength="700" style="min-height:70px;margin-top:6px">${s.body}</textarea>`)}
          <p class="row" style="margin-top:12px"><button class="primary">Save as version ${(p.versions[0]?.version || live) + 1}</button></p></form>`
    : html`<div class="kv small"><span>name</span><span>${spec.name}</span><span>ticker</span><span>$${spec.ticker}</span><span>tagline</span><span>${spec.tagline}</span></div><p class="faint tiny">${p.status === 'preview_ready' ? '' : 'Editing is open while the preview is under review.'}</p>`}
        <h3 style="margin-top:16px">Versions</h3>
        <table><tr><th>v</th><th>build</th><th>by</th><th></th></tr>${p.versions.map((v) => html`<tr><td>${v.version}${v.version === live ? ' ●' : ''}</td><td>${v.build_status}</td><td class="tiny">${String(v.created_by || '').startsWith('wallet:') ? 'you' : v.created_by}</td>
          <td>${v.build_status === 'ok' && v.version !== live && editable ? html`<button class="tiny" data-rollback="${v.version}">use this</button>` : ''}</td></tr>`)}</table>
        <h3 style="margin-top:16px">Art</h3>
        <div class="row"><img class="logo-big" src="${p.previewUrl.replace('index.html', 'logo.png')}" alt="logo"><span class="faint tiny">Drawn from SUB-01's brain record: ring colours are the networks your idea drove, thickness is how strongly. The banner is on the site.</span></div>
      </div>
    </div>

    <h2 id="x">2 · X presence</h2>
    ${xSection(p)}

    <h2>3 · Creator-fee split</h2>
    ${allocationSection(p, editable)}

    <h2>4 · Approve</h2>
    ${approveSection(p)}

    ${['launch_prepared', 'awaiting_signature', 'confirming', 'launched'].includes(p.status) && p.launchConfig ? html`<h2>5 · Launch</h2>${launchSection(p)}` : ''}
    `.s;
    bind();
  };

  function bind() {
    el.querySelector('#edit')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const sections = (p.spec.sections || []).map((_, i) => ({ heading: f[`h${i}`].value, body: f[`b${i}`].value }));
      try { await api(`/api/projects/${slug}/site`, { method: 'PUT', body: { name: f.name.value, ticker: f.ticker.value, tagline: f.tagline.value, description: f.description.value, sections } }); toast('New version built and checked.'); draw(); }
      catch (err) { toast(err.message, true); }
    });
    el.querySelectorAll('[data-rollback]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/projects/${slug}/site/live`, { method: 'POST', body: { version: Number(b.dataset.rollback) } }); draw(); } catch (err) { toast(err.message, true); }
    }));
    el.querySelectorAll('[data-post-save]').forEach((b) => b.addEventListener('click', async () => {
      const text = el.querySelector(`[data-post="${b.dataset.postSave}"]`).value;
      try { await api(`/api/x-posts/${b.dataset.postSave}`, { method: 'PUT', body: { text } }); toast('Draft saved.'); } catch (err) { toast(err.message, true); }
    }));
    el.querySelectorAll('[data-post-approve]').forEach((b) => b.addEventListener('click', async () => {
      const text = el.querySelector(`[data-post="${b.dataset.postApprove}"]`).value;
      if (!confirm(`Publish this on @${p.x.x_handle}?\n\n${text}`)) return;
      try { await api(`/api/x-posts/${b.dataset.postApprove}/approve`, { method: 'POST', body: { text } }); toast('Approved; publishing.'); draw(); } catch (err) { toast(err.message, true); }
    }));
    const split = el.querySelector('#split');
    if (split) {
      split.querySelector('#addrow')?.addEventListener('click', () => {
        const rows = split.querySelector('#rows');
        rows.insertAdjacentHTML('beforeend', html`<div class="split-row"><input data-k="label" placeholder="label" value="collaborator"><input class="w" data-k="wallet" placeholder="Solana address"><input data-k="pct" type="number" min="0.01" max="100" step="0.01" value="0"><button type="button" class="ghost" data-del>×</button></div>`.s);
      });
      split.addEventListener('click', (e) => { if (e.target.matches('[data-del]')) e.target.closest('.split-row').remove(); });
      split.addEventListener('submit', async (e) => {
        e.preventDefault();
        const recipients = [...split.querySelectorAll('.split-row')].map((r, i) => ({
          label: r.querySelector('[data-k=label]').value, wallet: r.querySelector('[data-k=wallet]').value.trim(),
          bps: Math.round(Number(r.querySelector('[data-k=pct]').value) * 100), role: r.dataset.role || (i === 0 ? 'submitter' : 'collaborator') }));
        try { await api(`/api/projects/${slug}/allocation`, { method: 'PUT', body: { recipients } }); toast('Split saved as a new draft.'); draw(); } catch (err) { toast(err.message, true); }
      });
    }
    el.querySelector('#approve')?.addEventListener('click', async () => {
      if (!el.querySelector('#ack').checked) { toast('Tick the box to confirm you read the split.', true); return; }
      try { await api(`/api/projects/${slug}/approve`, { method: 'POST', body: { allocationId: p.allocation.id, statement: p.allocation.statement, siteVersion: p.liveSiteVersion } }); toast('Approved.'); draw(); }
      catch (err) { toast(err.message, true); }
    });
    el.querySelector('#publish')?.addEventListener('click', async () => { try { await api(`/api/ideas/${p.ideaId}/publish`, { method: 'POST', body: { public: true } }); draw(); } catch (err) { toast(err.message, true); } });
    el.querySelector('#reopen')?.addEventListener('click', async () => { try { await api(`/api/projects/${slug}/back-to-preview`, { method: 'POST', body: {} }); draw(); } catch (err) { toast(err.message, true); } });
    el.querySelector('#gettx')?.addEventListener('click', getTransaction);
    el.querySelector('#resume')?.addEventListener('click', () => getTransaction(true));
    el.querySelector('#abandon')?.addEventListener('click', async () => { try { await api(`/api/projects/${slug}/launch/abandon`, { method: 'POST', body: {} }); draw(); } catch (err) { toast(err.message, true); } });
  }

  async function getTransaction(resume = false) {
    const box = el.querySelector('#txbox');
    if (resume !== true && !el.querySelector('#ack2').checked) { toast('Confirm you checked the launch details first.', true); return; }
    if (!connected() || connected().address !== state.me.user.wallet) {
      toast('Reconnect the wallet you signed in with.');
      if (!(await requireSignIn())) return;
    }
    try {
      const tx = await api(`/api/projects/${slug}/launch/transaction`, { method: 'POST', body: {} });
      const e = tx.estimate || {};
      box.innerHTML = html`<div class="card accent"><h3>${tx.mock ? 'MOCK transaction (nothing on-chain)' : 'Transaction ready'}</h3><div class="kv small">
        <span>new mint address</span><span class="addr">${tx.mint}</span>
        ${tx.resumed ? html`<span>request</span><span>resumed: the same transaction you built earlier</span>` : ''}
        <span>network fee</span><span>${e.networkFeeLamports != null ? sol(e.networkFeeLamports) : 'unknown'}</span>
        <span>accounts created (rent + program costs)</span><span>${e.accountsLamports != null ? sol(e.accountsLamports) : 'unknown'} <span class="faint">${e.simulation?.ok ? '(from a simulation)' : e.simulation?.err ? `(simulation failed: ${e.simulation.err})` : ''}</span></span>
        ${e.signerBalanceLamports != null ? html`<span>your balance</span><span>${sol(e.signerBalanceLamports)}</span>` : ''}
        <span>size</span><span>${tx.txBytes} bytes</span><span>valid until block</span><span>${tx.lastValidBlockHeight}</span></div>
        <p class="small dim">Your wallet shows the transaction again before you sign. ${tx.mock ? 'For the mock, it asks you to sign a plain text message instead.' : 'Check the network and the amounts there too.'}</p>
        <p class="row"><button class="primary" id="sign">Sign with ${connected()?.name || 'wallet'}</button> <button id="cancelSign">cancel</button></p></div>`.s;
      box.querySelector('#cancelSign').onclick = async () => { await api(`/api/projects/${slug}/launch/abandon`, { method: 'POST', body: {} }); draw(); };
      box.querySelector('#sign').onclick = async () => {
        let signed;
        try {
          signed = tx.mock ? await signMessageText((await api(`/api/projects/${slug}`)).mockSigningText) : await signTransaction(tx.txBase64, p.launchConfig.network);
        } catch (err) {
          await api(`/api/projects/${slug}/launch/abandon`, { method: 'POST', body: { reason: 'rejected' } }).catch(() => {});
          toast(`Not signed: ${err.message}`, true);
          return draw();
        }
        try { const r = await api(`/api/projects/${slug}/launch/signed`, { method: 'POST', body: { signed } }); toast(`Submitted ${short(r.signature, 8)}; confirming on the network…`); }
        catch (err) { toast(err.message, true); }
        draw();
      };
    } catch (err) { toast(err.message, true); draw(); }
  }

  await draw();
  every(6000, () => { if (['generating', 'approved', 'confirming'].includes(p?.status) || (p?.status === 'preview_ready' && p?.submitterApprovedAt)) draw().catch(() => {}); });
}

function xSection(p) {
  const x = p.x;
  if (!x) return html`<div class="empty">No X plan yet.</div>`;
  return html`<div class="grid2"><div class="card">
    ${x.status === 'connected' ? html`<h3>Connected: @${x.x_handle} <span class="chip ok">reported by X</span></h3><p class="small dim">Connected ${when(x.connected_at)} through X's own authorization. We hold an access token, never your password or cookies.</p>`
    : html`<h3>Planned account <span class="chip">not created</span></h3>
      <p class="small">This account doesn't exist yet. X doesn't let apps create accounts, so you create it yourself:</p>
      <ol class="small"><li>Sign up at <a href="https://x.com/i/flow/signup" target="_blank" rel="noopener" data-external>x.com</a> with the handle <b>@${x.planned_handle}</b> (or any free one you like).</li>
        <li>Set the bio: <code>${x.planned_bio}</code> ${copyButton(x.planned_bio)}</li><li>Use the logo and banner from the preview.</li>
        <li>Connect it here. X asks you to authorize posting. You never give us your password.</li></ol>
      ${p.xConfigured ? html`<a class="btn" href="/api/projects/${p.slug}/x/connect" data-external>Connect X account</a>` : html`<p class="notice small">Connecting needs the launchpad's X API credentials, which aren't set up yet. You can still create the account and post the drafts by hand.</p>`}`}
  </div><div>
    <h3>Post drafts</h3><p class="faint tiny">Nothing is posted until you approve each post.</p>
    ${(x.posts || []).map((post) => html`<div class="card" style="margin:8px 0"><div class="row" style="justify-content:space-between"><span class="pill">${post.kind}</span><span class="chip ${post.status === 'published' ? 'ok' : post.status === 'failed' ? 'bad' : ''}">${post.status}</span></div>
      <textarea data-post="${post.id}" maxlength="280" style="min-height:80px;margin-top:8px" ${['draft', 'failed'].includes(post.status) ? '' : 'disabled'}>${post.text}</textarea>
      ${post.error ? html`<p class="err">${post.error}</p>` : ''}
      ${['draft', 'failed'].includes(post.status) && p.owner ? html`<p class="row"><button class="tiny" data-post-save="${post.id}">save</button>${x.status === 'connected' ? html`<button class="tiny primary" data-post-approve="${post.id}">approve & post</button>` : ''}</p>` : ''}
      ${post.x_post_id ? html`<p class="small"><a href="https://x.com/i/web/status/${post.x_post_id}" target="_blank" rel="noopener" data-external>view on X ↗</a></p>` : ''}</div>`)}
  </div></div>`;
}

function allocationSection(p, editable) {
  const a = p.allocation;
  if (!a) return html`<div class="empty">No split drafted yet.</div>`;
  return html`<div class="grid2"><div>
    ${editable ? html`<form id="split"><div id="rows">${a.recipients.map((r) => html`<div class="split-row" data-role="${r.role}"><input data-k="label" value="${r.label}" ${r.role !== 'collaborator' ? 'readonly' : ''}><input class="w" data-k="wallet" value="${r.wallet || ''}" ${r.role !== 'collaborator' ? 'readonly' : ''}><input data-k="pct" type="number" min="0.01" max="100" step="0.01" value="${r.bps / 100}" ${r.role === 'sub01' ? 'readonly' : ''}><button type="button" class="ghost" data-del ${r.role !== 'collaborator' ? 'disabled' : ''}>×</button></div>`)}</div>
      <p class="row"><button type="button" id="addrow" class="tiny">+ add recipient</button><button class="tiny">save split</button></p>
      <p class="faint tiny">Up to ${state.config.maxRecipients} recipients, totalling 100%. The first row is your receiving wallet. To change it, edit the idea (that's recorded publicly). SUB-01's 20% row is fixed: you can share your 80% with collaborators.</p></form>`
    : html`<table><tr><th>recipient</th><th>share</th><th>address</th></tr>${a.recipients.map((r) => html`<tr><td>${r.label}</td><td>${pct(r.bps)}</td><td class="addr tiny">${r.wallet}</td></tr>`)}</table>`}
  </div><div>
    <div class="card"><h3>${a.mode === 'sharing_config' ? 'On-chain split, locked at launch' : 'Direct to you'}</h3>
      <p class="small">${a.mode === 'sharing_config' ? 'Creator fees are split on-chain by pump.fun\'s fee-sharing program. The split is set inside the launch transaction and then locked: you can\'t change it afterwards, and neither can SUBZERONE.' : 'The whole creator-fee share goes to the wallet that creates the token, which is you. Nothing is split.'}</p>
      <p class="small dim">These are <b>creator fees</b>, a part of each trade's fee. They aren't the trading fees themselves and they don't cover hosting costs. SUB-01's 20% row is the only part SUB-01 receives. If nobody trades, there are no fees.</p>
      <p class="small dim">Every project splits creator fees 80% to the idea submitter's side and 20% to SUB-01. ${state.config.sub01Share?.configured ? '' : html`<b>SUB-01's fee wallet is not configured yet, so this split can't be approved.</b>`}</p>
      <p class="faint tiny">Status: ${a.status} · version ${a.version}</p></div>
  </div></div>`;
}

function approveSection(p) {
  if (p.status !== 'preview_ready') {
    return html`<p class="small dim">${p.submitterApprovedAt ? `Approved by you ${when(p.submitterApprovedAt)}.` : ''} ${p.adminClearedAt ? `Cleared by a reviewer ${when(p.adminClearedAt)}.` : ''}</p>
      ${['approved', 'launch_prepared'].includes(p.status) && p.owner ? html`<button id="reopen">Reopen for edits</button>` : ''}`;
  }
  if (!p.owner) return html`<p class="dim small">Waiting for the submitter.</p>`;
  if (p.visibility !== 'public') return html`<div class="notice">A launched token is public, so publish the idea before you approve. <button id="publish">Publish idea</button></div>`;
  return html`<div class="card">
    <p class="small">You approve site version <b>${p.liveSiteVersion}</b> and this creator-fee statement:</p>
    <pre class="small" style="white-space:pre-wrap;background:var(--bg2);padding:10px;border:1px solid var(--line)">${p.allocation.statement}</pre>
    <label class="check"><input type="checkbox" id="ack"> <span>I've read the split above and I approve it.</span></label>
    <button class="primary" id="approve" ${p.submitterApprovedAt ? 'disabled' : ''}>${p.submitterApprovedAt ? 'Approved: waiting for reviewer clearance' : 'Approve preview & split'}</button>
    ${p.requireAdminClearance ? html`<p class="faint tiny">A SUBZERONE reviewer also clears each project before its launch configuration is prepared. ${p.adminClearedAt ? `Cleared ${when(p.adminClearedAt)}.` : 'Not cleared yet.'}</p>` : ''}</div>`;
}

function launchSection(p) {
  const c = p.launchConfig;
  const t = c.token;
  if (p.status === 'launched') return html`<p class="dim small">Launched. See verification above.</p>`;
  const signing = p.status === 'awaiting_signature';
  return html`
  ${c.mock ? html`<div class="notice mock"><b>MOCK provider.</b> This rehearses the flow. No blockchain is used, no token is created and no fees will exist.</div>` : ''}
  <div class="grid2"><div class="card">
    <h3>What you are about to sign</h3>
    <div class="kv small">
      <span>token name</span><span>${t.name}</span><span>ticker</span><span>$${t.symbol}</span>
      <span>metadata</span><span class="addr"><a href="${t.uri}" target="_blank" rel="noopener" data-external>${t.uri}</a></span>
      <span>description</span><span>${t.metadata.description}</span>
      <span>network</span><span><b>${c.network}</b></span><span>launch provider</span><span>${c.providerLabel}</span>
      <span>supply</span><span>${tokenAmount(t.totalSupplyBase, t.decimals)} (${t.decimals} decimals, ${t.tokenProgram})</span>
      <span>authorities</span><span>mint: ${t.authorities.mint} · freeze: ${t.authorities.freeze}</span>
      <span>initial purchase</span><span><b>${sol(c.initialBuyLamports)}</b> (no automatic buying)</span>
      <span>signer, payer and creator</span><span class="addr">${c.signer} (your wallet)</span>
      <span>creator of record</span><span class="addr">${c.creator}</span>
      <span>trading fees now</span><span>${c.tradingFees?.protocolFeeBps != null ? `protocol ${pct(c.tradingFees.protocolFeeBps)} + creator ${pct(c.tradingFees.creatorFeeBps)} per trade` : c.tradingFees?.error || 'n/a'} <span class="faint">${c.tradingFees?.source || ''}</span></span>
    </div>
    <h3 style="margin-top:12px">Creator-fee recipients</h3>
    <table><tr><th>who</th><th>share</th><th>exact address</th></tr>${c.feeSharing.recipients.map((r) => html`<tr><td>${r.label}</td><td>${pct(r.bps)}</td><td class="addr tiny">${r.wallet}</td></tr>`)}</table>
  </div><div>
    <div class="irreversible"><b>Irreversible once it lands:</b><ul class="small">${c.irreversible.map((x) => html`<li>${x}</li>`)}</ul></div>
    <p class="small dim">Network and account costs are estimated when the transaction is built. You'll see them before your wallet opens.</p>
    ${signing ? html`<div class="notice">A transaction is waiting for your signature. <button id="resume" class="primary">Sign it now</button> <button id="abandon">Cancel it</button></div>`
    : p.status === 'confirming' ? html`<div class="notice">Submitted ${p.intent?.tx_signature ? short(p.intent.tx_signature, 8) : ''}. Waiting for the network to finalize, then we check the result on-chain.</div>`
      : html`<label class="check"><input type="checkbox" id="ack2"> <span>I checked the name, ticker, network, supply, recipients and addresses above.</span></label>
      <p class="row"><button class="primary" id="gettx">Build the transaction</button> <button id="reopen">Back to edits</button></p>`}
    <div id="txbox"></div>
    ${p.intent?.error && !['confirmed'].includes(p.intent.status) ? html`<p class="small faint">Last attempt: ${p.intent.status} · ${p.intent.error}</p>` : ''}
  </div></div>`;
}

export { go };
