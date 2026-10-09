import { api, html, raw, short, when, ago, sol, pct, usd, copyButton } from './lib.js';
import { state, toast, requireSignIn, go, every, refreshMe, homePath } from './app.js';
import { connected } from './wallet.js';

const EDITABLE = ['submitted', 'evaluating', 'selected', 'generating', 'preview_ready', 'approved'];
const FLOW = ['submitted', 'evaluating', 'selected', 'generating', 'preview_ready', 'approved', 'launch_prepared', 'awaiting_signature', 'confirming', 'launched'];
const NETWORK_WORDS = { reward: 'reward', attention: 'attention', visual: 'visual', memory: 'memory', language: 'language', fear: 'threat',
  default: 'default-mode', limbic: 'limbic', control: 'control', somatomotor: 'body-movement', salience: 'salience', relay: 'thalamic relay' };

/** provider: 'mock' adds an unmissable MOCK label; a real launch says which network verified it. */
export const statusChip = (s, provider, network) => {
  if (s === 'launched' && provider === 'mock') return html`<span class="chip mock">MOCK launch · no blockchain</span>`;
  if (s === 'launched' && network) return html`<span class="chip ok">Launched · verified on ${network}</span>`;
  const cls = s === 'launched' ? 'ok' : s === 'declined' || s === 'cancelled' ? '' : s === 'failed' ? 'bad' : 'or';
  const label = (state.config?.stages || []).find((x) => x.id === s)?.label || s;
  return html`<span class="chip ${cls}">${label}</span>`;
};

function stages(status) {
  const i = FLOW.indexOf(status);
  return html`<div class="stages">${FLOW.map((s, k) => html`<span class="${k < i ? 'done' : k === i ? 'now' : ''}">${s.replace('_', ' ')}</span>`)}
    ${['declined', 'failed', 'cancelled'].includes(status) ? html`<span class="now">${status}</span>` : ''}</div>`;
}

const ideaCard = (x) => html`<div class="card">
  <div class="row" style="justify-content:space-between"><h3><a href="/ideas/${x.id}" data-link>${x.title}</a></h3>${statusChip(x.status, x.provider, x.network)}</div>
  ${x.ticker ? html`<p class="small"><span class="pill">$${x.ticker}</span> ${x.slug ? html`<a class="dim" href="/projects/${x.slug}" data-link>project →</a>` : ''}</p>` : ''}
  ${x.concept ? html`<p class="dim small">${x.concept}${x.concept.length >= 220 ? '…' : ''}</p>` : ''}
  <p class="faint tiny">${x.status_note || ''} · ${ago(x.updated_at)}</p></div>`;

// --- home ----------------------------------------------------------------------------------------------------------
export async function home(el) {
  const [ideas, brain] = await Promise.all([api('/api/ideas'), api('/api/brain/status').catch(() => null)]);
  const c = state.config;
  const brainChip = !brain?.configured ? html`<span class="chip bad">brain link not configured</span>`
    : brain.reachable ? html`<span class="chip ok">brain online</span>` : html`<span class="chip warn">brain unreachable</span>`;
  el.innerHTML = html`
  <section class="hero">
    <div class="room">
      <div class="label"><span class="live-dot"></span>LIVE · HIS ROOM · TOKYO</div>
      <iframe src="${c.roomUrl}" title="SUB-01's room, live" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin"></iframe>
    </div>
    <div>
      <p class="dim small">SUBZERONE LAUNCHPAD · ${raw(brainChip.s)} ${c.launch.mock ? html`<span class="chip mock">mock launches</span>` : html`<span class="chip">${c.launch.label}</span>`}</p>
      <p class="tagline">You drop an idea.<br><em>SUB-01 becomes your dev.</em></p>
      <p>Most agents get a task. SUB-01 gets a life. He lives in a small room in Tokyo, and his choices come from a brain simulation built from one person's public MRI scans.</p>
      <p class="dim">Hand him an idea, even a terrible one. His simulated brain votes on whether to build it. If it says yes, he writes the identity, draws the art from his own brain activity, builds the site and drafts the X posts, then prepares a token launch for you to review and sign.</p>
      <p class="row" style="margin-top:18px"><a class="btn primary" href="/submit" data-link>Drop an idea</a><a class="btn" href="/how" data-link>How he decides</a></p>
      <p class="faint tiny" style="margin-top:14px">A planned feature, shown as a preview. It is a simulation, not a mind. No staking, no dividends, no holder rewards, and no promises.</p>
    </div>
  </section>
  <div class="steps">
    <div><b>01 · DROP</b>Submit an idea with your wallet. It stays private until you publish it.</div>
    <div><b>02 · HE THINKS</b>His brain simulation votes: build, or pass.</div>
    <div><b>03 · HE BUILDS</b>Name, ticker, art, website, X drafts. You review every piece.</div>
    <div><b>04 · YOU APPROVE</b>You check the launch details and the fee split, then sign with your own wallet.</div>
    <div><b>05 · TRACK</b>Launch and fees are verified on-chain, with sources and timestamps.</div>
  </div>
  <h2>On his desk</h2>
  ${ideas.building.length ? html`<div class="grid3">${ideas.building.map(ideaCard)}</div>`
    : html`<div class="empty">Nothing on his desk yet. Public ideas being evaluated or built show up here.<br><a href="/submit" data-link>Be the first terrible idea →</a></div>`}
  <h2>Launched</h2>
  ${ideas.launched.length ? html`<div class="grid3">${ideas.launched.map(ideaCard)}</div>` : html`<div class="empty">No launches yet. A launch shows here only once it is verified on-chain${c.launch.mock ? ' (or recorded by the clearly labelled mock provider)' : ''}.</div>`}
  ${ideas.passed.length ? html`<h2>He passed</h2><div class="grid3">${ideas.passed.map(ideaCard)}</div>` : ''}`.s;
}

// --- submit ----------------------------------------------------------------------------------------------------------
export async function submit(el) {
  const c = state.config;
  const me = state.me?.user;
  const wallet = me?.wallet || '';
  if (c.pauses.submissions) { el.innerHTML = html`<h1>Drop an idea</h1><div class="notice">Submissions are paused right now. Try again later.</div>`.s; return; }
  el.innerHTML = html`
  <h1>Drop an idea</h1>
  <p class="dim">Anyone can browse. To submit, you sign in with a Solana wallet. Signing in is a message, not a payment, and you don't need to hold SUB-01.</p>
  <div class="grid2">
  <form id="f" novalidate>
    <label>Idea title <span class="req">*</span></label>
    <input name="title" maxlength="${c.limits.title[1]}" required placeholder="Ramen Radar">
    <label>The concept, in a few sentences <span class="req">*</span> <span class="faint" id="cc"></span></label>
    <textarea name="concept" maxlength="${c.limits.concept[1]}" required placeholder="What is it, who is it for, why is it funny or good?"></textarea>
    <div class="grid2">
      <div><label>Name suggestion (optional)</label><input name="nameSuggestion" maxlength="32"></div>
      <div><label>Ticker suggestion (optional)</label><input name="tickerSuggestion" maxlength="11" placeholder="RAMEN"></div>
    </div>
    <label>Reference links (optional, one per line, https only). We store them as text and never open them on our servers.</label>
    <textarea name="links" style="min-height:70px" placeholder="https://…"></textarea>
    <label>Visual references (optional): up to ${c.limits.uploads} images, PNG, JPEG, GIF or WebP, 1.5 MB each</label>
    <input type="file" name="images" accept="image/png,image/jpeg,image/gif,image/webp" multiple>
    <div class="grid2">
      <div><label>Public X handle (optional)</label><input name="x" placeholder="@you"></div>
      <div><label>Public Telegram (optional)</label><input name="telegram" placeholder="@you"></div>
    </div>
    <label>Receiving wallet for creator fees <span class="req">*</span></label>
    <input name="receivingWallet" value="${wallet}" placeholder="your Solana address" autocomplete="off" spellcheck="false">
    <p class="faint tiny">A public Solana address. If your idea launches, this is where your share of creator fees is routed. We never change it for you. It is not your sign-in wallet unless you leave it that way.</p>
    <label class="check"><input type="checkbox" name="rightsConfirmed"> <span>I wrote this idea or have the right to share it, and I can authorize the use of the text, links and images I'm supplying.</span></label>
    <div id="errs"></div>
    <p class="row"><button class="primary" type="submit">${me ? 'Drop it in his room' : 'Connect wallet & drop it'}</button></p>
  </form>
  <div>
    <div class="card"><h3>What stays private, what becomes public</h3>
      <p class="small dim">Your submission is <b>private</b> until you press "publish" on its page. Until then only you (and SUBZERONE reviewers, for moderation) can see it.</p>
      <p class="small">If you publish, people can see the title, concept, name and ticker suggestions, links, images, contact handles, the receiving wallet, the wallet you signed in with, SUB-01's evaluation and the timeline.</p>
      <p class="small">A launched token is always public, and so are its on-chain addresses.</p></div>
    <div class="card" style="margin-top:14px"><h3>What happens next</h3>
      <p class="small dim">His brain simulation votes on your idea: build, or pass. That's a rule run on simulated brain activity, not understanding. If he's asleep, your idea waits by the bed until he wakes. If his brain service is offline, nothing gets decided and nothing else decides for him.</p>
      <p class="small dim">Ideas that promise returns, yield, holder rewards or endorsements are declined by rule before he sees them.</p></div>
  </div></div>`.s;
  const f = el.querySelector('#f');
  const cc = el.querySelector('#cc');
  f.concept.addEventListener('input', () => { cc.textContent = `${f.concept.value.length}/${c.limits.concept[1]}`; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errs = el.querySelector('#errs');
    errs.innerHTML = '';
    if (!state.me?.user) { if (!(await requireSignIn())) return; if (!f.receivingWallet.value) f.receivingWallet.value = state.me.user.wallet; }
    const files = [...f.images.files];
    if (files.length > c.limits.uploads) { errs.innerHTML = html`<p class="err">At most ${c.limits.uploads} images.</p>`.s; return; }
    if (files.some((x) => x.size > c.limits.uploadBytes)) { errs.innerHTML = html`<p class="err">Each image up to 1.5 MB.</p>`.s; return; }
    const images = await Promise.all(files.map((file) => new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file);
    })));
    const body = { title: f.title.value, concept: f.concept.value, nameSuggestion: f.nameSuggestion.value, tickerSuggestion: f.tickerSuggestion.value,
      links: f.links.value.split('\n').map((s) => s.trim()).filter(Boolean), contacts: { x: f.x.value, telegram: f.telegram.value },
      receivingWallet: f.receivingWallet.value.trim(), rightsConfirmed: f.rightsConfirmed.checked, images };
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('/api/ideas', { method: 'POST', body });
      toast('Dropped in his room.');
      go(`/ideas/${r.id}`);
    } catch (err) {
      btn.disabled = false;
      const fields = err.body?.errors;
      errs.innerHTML = fields ? html`${Object.entries(fields).map(([k, v]) => html`<p class="err">${k}: ${v}</p>`)}`.s : html`<p class="err">${err.message}</p>`.s;
    }
  });
}

// --- idea detail ------------------------------------------------------------------------------------------------------
export function brainCard(brain, scores) {
  if (!brain) return '';
  const vote = brain.vote || {};
  const nets = Object.entries(brain.networks || {}).sort((a, b) => b[1] - a[1]);
  return html`<div class="card accent">
    <h3>SUB-01's brain vote</h3>
    <p class="small dim">Simulated, not understood: the idea's words were sent to his brain networks through a fixed word list. Then a copy of his live brain was run once per option, and the response decided. ${brain.demo ? html`<span class="chip warn">brain in demo mode</span>` : ''}</p>
    ${(vote.options || []).map((o) => html`<div class="option ${o.chosen ? 'chosen' : ''}"><span>${o.chosen ? '▸ ' : ''}${o.label}</span><span>${Math.round(o.p * 100)}%</span></div>`)}
    <p class="small" style="margin-top:8px">${vote.reason || ''}</p>
    <div class="kv small" style="margin-top:10px">
      <span>networks driven</span><span>${nets.map(([g, w]) => `${NETWORK_WORDS[g] || g} ${w}`).join(' · ')}</span>
      <span>decided by</span><span>${vote.spiking?.used ? vote.spiking.network : 'rate model (no spiking network answered in time)'}</span>
      <span>his state</span><span>${brain.stage || '—'} · boredom ${brain.mood?.boredom ?? '—'} · sleep pressure ${brain.mood?.pressure ?? '—'}</span>
      <span>simulation time</span><span>${vote.ms ?? '—'} ms · ${vote.clones ?? '—'} brain copies</span>
      <span>request</span><span class="tiny">${brain.request_id || ''} · ${brain.version || ''}</span>
    </div>
    ${scores ? scorecard(scores) : ''}
  </div>`;
}

export function scorecard(s) {
  const row = (name, x) => html`<div class="score"><span>${name}</span><div class="bar"><i style="width:${Math.round((x?.score ?? 0) * 100)}%"></i></div><span>${x?.score == null ? '—' : Math.round(x.score * 100)}</span></div>
    <p class="faint tiny" style="margin:-4px 0 6px 130px">${x?.source || ''}</p>`;
  return html`<h2 style="margin-top:18px">Scorecard <span class="faint">${s.version}</span></h2>
    ${row('originality', s.originality)}${row('clarity', s.clarity)}${row('feasibility', s.feasibility)}${row('suitability', s.suitability)}
    <p class="faint tiny">Nothing is scored on promised returns. The rules only gate. The decision is the brain vote's.</p>`;
}

export async function idea(el, id) {
  const draw = async () => {
    const x = await api(`/api/ideas/${id}`);
    el.innerHTML = html`
    <p class="small"><a href="${homePath()}" data-link class="dim">← room</a></p>
    <div class="row" style="justify-content:space-between"><h1>${x.title}</h1>${statusChip(x.status, x.project?.provider, x.project?.network)}</div>
    ${stages(x.status)}
    ${x.statusNote ? html`<div class="notice">${x.statusNote}${x.job && x.job.status === 'queued' && x.job.runAfter > Date.now() ? html` <span class="faint">· next try ${when(x.job.runAfter)}</span>` : ''}</div>` : ''}
    ${x.project ? html`<p class="row"><a class="btn ${x.owner && ['preview_ready', 'approved', 'launch_prepared', 'awaiting_signature', 'confirming'].includes(x.status) ? 'primary' : ''}" href="/projects/${x.project.slug}${x.owner ? '/review' : ''}" data-link>${x.owner ? 'Review what he built →' : 'Project →'}</a></p>` : ''}
    <div class="grid2">
      <div>
        <div class="card"><h3>The idea</h3><p style="white-space:pre-wrap">${x.concept}</p>
          <div class="kv small">
            ${x.nameSuggestion ? html`<span>name suggestion</span><span>${x.nameSuggestion}</span>` : ''}
            ${x.tickerSuggestion ? html`<span>ticker suggestion</span><span>$${x.tickerSuggestion}</span>` : ''}
            <span>receiving wallet</span><span class="addr">${x.receivingWallet} ${copyButton(x.receivingWallet)}</span>
            <span>submitted by</span><span class="addr">${short(x.submittedBy, 6)}</span>
            <span>submitted</span><span>${when(x.createdAt)} · version ${x.version}</span>
            ${x.links.length ? html`<span>links</span><span>${x.links.map((l) => html`<a href="${l}" rel="nofollow noopener noreferrer ugc" target="_blank" data-external>${l}</a><br>`)}</span>` : ''}
            ${x.contacts.x ? html`<span>X</span><span>@${x.contacts.x}</span>` : ''}
            ${x.contacts.telegram ? html`<span>Telegram</span><span>@${x.contacts.telegram}</span>` : ''}
          </div>
          ${x.uploads.length ? html`<div class="thumbs" style="margin-top:10px">${x.uploads.map((u) => html`<img src="/api/uploads/${u.id}" alt="visual reference">`)}</div>` : ''}
        </div>
        ${x.owner ? html`<div class="card" style="margin-top:14px"><h3>Visibility: ${x.visibility}</h3>
          <p class="small dim">${x.visibility === 'private' ? 'Only you and SUBZERONE reviewers can see this. Publishing shows the idea, your links and handles, both wallets, SUB-01\'s evaluation and the timeline. A launch requires publishing.' : 'Anyone can see this idea and its timeline.'}</p>
          <button id="vis">${x.visibility === 'private' ? 'Publish this idea' : 'Make private again'}</button>
          ${!['launched', 'declined', 'cancelled', 'awaiting_signature', 'confirming'].includes(x.status) ? html` <button class="danger" id="cancel">Cancel idea</button>` : ''}
        </div>` : ''}
        ${x.owner && EDITABLE.includes(x.status) ? html`<details class="card" style="margin-top:14px" id="editbox"><summary class="small">Edit (saved as version ${x.version + 1}; version 1 stays as submitted)</summary>
          <form id="editf">
            <label>Title</label><input name="title" value="${x.title}" maxlength="80">
            <label>Concept</label><textarea name="concept" maxlength="1500">${x.concept}</textarea>
            <div class="grid2"><div><label>Name suggestion</label><input name="nameSuggestion" value="${x.nameSuggestion || ''}" maxlength="32"></div>
              <div><label>Ticker suggestion</label><input name="tickerSuggestion" value="${x.tickerSuggestion || ''}" maxlength="11"></div></div>
            <label>Links (one per line)</label><textarea name="links" style="min-height:60px">${x.links.join('\n')}</textarea>
            <div class="grid2"><div><label>X handle</label><input name="x" value="${x.contacts.x || ''}"></div><div><label>Telegram</label><input name="telegram" value="${x.contacts.telegram || ''}"></div></div>
            <label>Receiving wallet for creator fees</label><input name="receivingWallet" value="${x.receivingWallet}" spellcheck="false">
            <p class="faint tiny">Changing it is recorded on the public timeline. If a fee split was already approved, it goes back to draft and you approve it again.</p>
            <label class="check"><input type="checkbox" name="rightsConfirmed"> <span>I can authorize the use of this material.</span></label>
            <button class="primary">Save new version</button>
          </form></details>` : ''}
        ${x.versions ? html`<div class="card" style="margin-top:14px"><h3>Versions</h3><table><tr><th>v</th><th>title</th><th>receiving wallet</th><th>when</th></tr>
          ${x.versions.map((v) => html`<tr><td>${v.version}</td><td>${v.title}</td><td class="addr">${short(v.receiving_wallet, 5)}</td><td>${when(v.created_at)}</td></tr>`)}</table>
          <p class="faint tiny">Version 1 is the original submission, kept exactly as submitted.</p></div>` : ''}
      </div>
      <div>
        ${x.evaluation?.brain ? raw(brainCard(x.evaluation.brain, x.evaluation.scores).s)
    : x.evaluation ? html`<div class="card"><h3>Declined by rule</h3><p class="small dim">${x.evaluation.decidedBy}: this idea did not reach SUB-01's brain.</p>${scorecard(x.evaluation.scores)}</div>`
      : html`<div class="card"><h3>Waiting for SUB-01</h3><p class="small dim">No decision yet. His brain simulation decides, and nothing else stands in for it.</p></div>`}
        <h2>Timeline</h2>
        <ul class="timeline">${x.timeline.map((e) => html`<li><div class="t">${when(e.at)} · ${e.actor}</div>${e.message}</li>`)}</ul>
      </div>
    </div>`.s;
    el.querySelector('#vis')?.addEventListener('click', async () => {
      try { await api(`/api/ideas/${id}/publish`, { method: 'POST', body: { public: x.visibility === 'private' } }); draw(); } catch (e) { toast(e.message, true); }
    });
    el.querySelector('#editf')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api(`/api/ideas/${id}`, { method: 'PUT', body: { title: f.title.value, concept: f.concept.value, nameSuggestion: f.nameSuggestion.value,
          tickerSuggestion: f.tickerSuggestion.value, links: f.links.value.split('\n').map((v) => v.trim()).filter(Boolean),
          contacts: { x: f.x.value, telegram: f.telegram.value }, receivingWallet: f.receivingWallet.value.trim(), rightsConfirmed: f.rightsConfirmed.checked } });
        toast('Saved as a new version.');
        draw();
      } catch (err) { toast(err.body?.errors ? Object.entries(err.body.errors).map(([k, v]) => `${k}: ${v}`).join(' · ') : err.message, true); }
    });
    el.querySelector('#cancel')?.addEventListener('click', async () => {
      if (!confirm('Cancel this idea? This cannot be undone.')) return;
      try { await api(`/api/ideas/${id}/cancel`, { method: 'POST', body: {} }); draw(); } catch (e) { toast(e.message, true); }
    });
    return x;
  };
  const x = await draw();
  if (!['launched', 'declined', 'cancelled', 'failed'].includes(x.status)) {
    every(5000, () => { if (!el.querySelector('#editbox')?.open) draw().catch(() => {}); });
  }
}

// --- how it works -------------------------------------------------------------------------------------------------
export async function how(el) {
  const c = state.config;
  el.innerHTML = html`
  <h1>How SUB-01 decides, and who does what</h1>
  <div class="grid2">
  <div>
    <h2>What SUB-01 is</h2>
    <p>A computer model of brain activity, built from one person's public MRI scans (MyConnectome, OpenNeuro ds000031). It runs around the clock and drives an invented character in a room in Tokyo. <b>It's a model, not a mind.</b> It doesn't understand, feel or think, and it isn't conscious. "He decides" is shorthand for "the simulation's vote picked".</p>
    <h2>What the simulation decides</h2>
    <p>Whether to build your idea. The idea's words go to his brain networks through a fixed word list, the same one his chat uses. A copy of his live brain is run with "build" and with "pass", and the simulated response (reward, attention, threat…) goes through the same vote that picks what he clicks on the web. If he's asleep, your idea waits. If the brain service is down, nothing is decided.</p>
    <h2>What the simulation does not decide</h2>
    <p>The wording. Names, taglines, site copy and X drafts come from <b>${c.generator}</b>, which fills in his decision and the brain record. The art is drawn by a fixed program from the brain record (which networks responded, how strongly). Rules decline ideas that promise returns, carry slurs or claim endorsements, plus unreadable ideas and duplicates. Reviewers can pause or remove things.</p>
    <h2>Scorecard v1</h2>
    <p class="small">Originality (rule: text similarity to earlier ideas) · Clarity (rule: length and readability) · Feasibility (rule: does it need running infrastructure) · Suitability (simulation: the brain vote's probability for "build"). The rules only gate. Nothing is scored on promised returns.</p>
  </div>
  <div>
    <h2>The pipeline</h2>
    <div class="kv small">${c.stages.map((s) => html`<span>${s.id}</span><span>${s.label}</span>`)}</div>
    <p class="small dim" style="margin-top:10px">Each stage is a durable job with saved input and output, bounded retries, idempotency keys, cost and time limits, and an audit trail you can read on the idea's page.</p>
    <h2>Your wallet</h2>
    <p class="small">Sign-in is a signed message: no transaction, no funds. A launch is a transaction <b>you</b> review and sign in your own wallet. We never ask for a seed phrase or private key. The default initial buy is zero, and nothing is bought, sold or funded automatically.</p>
    <h2>Generated sites</h2>
    <p class="small">Every project site is built from plain data by a fixed template, in a separate locked-down process with no network, no secrets and no file access. It's then checked for scripts and unexpected links, and served from its own subdomain with a policy that allows no scripts at all. Versions are kept, and you can roll back.</p>
    <h2>SUB-01's own token</h2>
    <p class="small">Tokens launched here are separate from SUB-01. Using the launchpad doesn't require holding SUB-01, gives SUB-01 holders nothing, and doesn't promise anything about SUB-01's price. <a href="/token" data-link>Token page →</a></p>
  </div></div>`.s;
}

// --- SUB-01 token page -----------------------------------------------------------------------------------------------
export async function token(el) {
  const s = state.config.sub01;
  el.innerHTML = html`<h1>SUB-01 · SUBZERONE</h1><p class="dim">The existing token of the SUB-01 project on Solana. Official details below.</p><div id="mkt" class="dim">loading market data…</div>`.s;
  const m = await api('/api/token').catch((e) => ({ error: e.message }));
  const d = m.dex || {}, ch = m.chain || {};
  el.innerHTML = html`
  <h1>SUB-01 · SUBZERONE</h1>
  <div class="grid2">
    <div class="card accent"><h3>Official</h3><div class="kv small">
      <span>project</span><span>${s.project}</span><span>ticker</span><span>${s.ticker}</span><span>network</span><span>${s.network}</span>
      <span>contract</span><span class="addr">${s.mint} ${copyButton(s.mint)}</span>
      <span>website</span><span><a href="${s.website}" target="_blank" rel="noopener" data-external>${s.website}</a></span>
      <span>X</span><span><a href="${s.x}" target="_blank" rel="noopener" data-external>${s.x}</a></span>
      <span>brain code</span><span><a href="${s.code}" target="_blank" rel="noopener" data-external>${s.code}</a></span>
      <span>pump.fun</span><span><a href="${s.pumpfun}" target="_blank" rel="noopener" data-external>${s.pumpfun}</a></span>
    </div><p class="faint tiny" style="margin-top:10px">Always check the contract address. Any other "SUB-01" token is not this one.</p></div>
    <div class="card"><h3>Market data</h3>
      ${d.unavailable || !d.pairs ? html`<p class="dim small">Not available right now${d.error ? ` (${d.error})` : ''}.</p>` : html`<div class="kv small">
        <span>price</span><span>${usd(d.priceUsd)}</span><span>market cap</span><span>${usd(d.marketCapUsd)}</span><span>FDV</span><span>${usd(d.fdvUsd)}</span>
        <span>liquidity</span><span>${usd(d.liquidityUsd)}</span><span>24h volume</span><span>${usd(d.volume24hUsd)}</span><span>24h change</span><span>${d.change24hPct ?? '—'}%</span>
        <span>main pool</span><span class="addr">${d.dex} · ${short(d.pair, 6)}</span></div>`}
      <p class="faint tiny" style="margin-top:8px">Source: ${d.source || '—'} · fetched ${when(d.fetchedAt)}${d.stale ? ' (stale: last good copy)' : ''}</p>
      <h3 style="margin-top:14px">On-chain</h3>
      ${ch.unavailable ? html`<p class="dim small">Not available right now (${ch.error}).</p>` : html`<div class="kv small">
        <span>supply</span><span>${ch.supply && ch.decimals != null ? (Number(ch.supply) / 10 ** ch.decimals).toLocaleString() : '—'}</span>
        <span>decimals</span><span>${ch.decimals ?? '—'}</span><span>mint authority</span><span>${ch.mintAuthority ?? 'none'}</span>
        <span>freeze authority</span><span>${ch.freezeAuthority ?? 'none'}</span><span>token program</span><span class="addr">${ch.tokenProgram || '—'}</span></div>`}
      <p class="faint tiny" style="margin-top:8px">Source: ${ch.source || '—'} · slot ${ch.slot ?? '—'} · fetched ${when(ch.fetchedAt)}</p>
    </div>
  </div>
  <h2>SUB-01 and the launchpad</h2>
  <div class="grid2"><div>
    <p>The launchpad is a planned SUB-01 feature: his brain simulation picks ideas to build, and the projects he builds are attributed to him.</p>
    <p>You don't need to buy or hold SUB-01 to use it.</p>
  </div><div>
    <p class="dim">Holding SUB-01 gives no staking, dividends, revenue share, allocations or other rights from the launchpad. Tokens launched here are different tokens with their own contracts. Launching projects doesn't create demand for SUB-01 and doesn't guarantee anything about its price.</p>
  </div></div>`.s;
}

// --- fees ledger & methodology ---------------------------------------------------------------------------------------
export async function fees(el) {
  const l = await api('/api/ledger');
  el.innerHTML = html`
  <h1>Fee ledger</h1>
  <p class="dim">Every number here comes from a blockchain read or a confirmed transaction, with its source and time. We don't estimate from volume, and we don't fill gaps with guesses.</p>
  ${l.projects.length ? html`<div class="tablewrap"><table><tr><th>project</th><th>network</th><th>split</th><th>verified undistributed</th><th>confirmed payouts</th><th>observed</th></tr>
    ${l.projects.map((p) => html`<tr><td><a href="/projects/${p.slug}" data-link>${p.name}</a> <span class="pill">$${p.ticker}</span>${p.provider === 'mock' ? html` <span class="chip mock">mock</span>` : ''}</td>
      <td>${p.network}</td><td>${p.ledger.mode === 'sharing_config' ? html`<span class="chip ok">on-chain, locked</span>` : 'direct to creator'}</td>
      <td>${sol(p.ledger.verifiedUndistributedLamports)}<div class="faint tiny">${p.ledger.vaultScope}</div></td>
      <td>${sol(p.ledger.confirmedPayoutsLamports)}</td><td class="small">${when(p.ledger.vaultObservedAt)}</td></tr>`)}
  </table></div>` : html`<div class="empty">No launched projects yet, so there are no fees to show. This table never shows sample or estimated revenue.</div>`}
  <h2>Methodology</h2>
  <div class="grid2"><div>
    <h3>Four separate things</h3>
    <p class="small"><b>1. Trading fees charged by the launch provider.</b> pump.fun charges a fee on every trade. Rates are read from its on-chain fee configuration when a launch is prepared, never hardcoded. They change with market cap.</p>
    <p class="small"><b>2. Creator fees.</b> The part of trading fees the protocol routes to a coin's creator. It accrues in a creator vault on-chain.</p>
    <p class="small"><b>3. Allocation of creator fees.</b> A fixed rule for every project: <b>80%</b> to the idea submitter's receiving wallet and <b>20%</b> to SUB-01${state.config.sub01Share?.wallet ? html` (${short(state.config.sub01Share.wallet, 6)})` : ''}. The SUB-01 row is mandatory and can't be removed or changed; the submitter may share their 80% with collaborators. The submitter approves the exact split before launch, it's shown on every project page, and it's written on-chain (pump.fun fee sharing) and locked at launch. There is no other recipient. A community takeover moves the founder role, never the fee recipients.</p>
    <p class="small"><b>4. Hosting and generation costs.</b> SUBZERONE's own costs. They are never taken from creator fees.</p>
  </div><div>
    <h3>What the columns mean</h3>
    <p class="small"><b>Verified undistributed</b>: the creator vault's balance (minus its rent reserve), read over Solana RPC at the slot shown. When creator fees go directly to a single creator wallet, that vault holds fees from <i>every</i> coin that wallet created, so it isn't split per project.</p>
    <p class="small"><b>Confirmed payouts</b>: distributions found in finalized transactions of the project's fee-sharing account. Each one links to its transaction.</p>
    <p class="small"><b>Estimates</b>: on a project page, "your share if distributed now" is the vault balance times your share. It's an estimate until a distribution happens.</p>
    <p class="small"><b>Reconciliation</b>: reads run every hour. Transactions are stored once (keyed by signature and recipient), so reading the same chain twice never double counts. If indexing is behind, you'll see older numbers with their timestamp, not invented ones.</p>
  </div></div>`.s;
}

// --- submitter dashboard ----------------------------------------------------------------------------------------------
export async function me(el) {
  const m = await refreshMe();
  if (!m.user) {
    el.innerHTML = html`<h1>My ideas</h1><div class="empty">Connect your wallet to see your ideas.<br><br><button id="c" class="primary">connect wallet</button></div>`.s;
    el.querySelector('#c').onclick = async () => { if (await requireSignIn()) me(el); };
    return;
  }
  const next = (s) => ({ preview_ready: 'review the build', launch_prepared: 'review & sign the launch', awaiting_signature: 'sign in your wallet', failed: 'see what stopped' }[s]);
  el.innerHTML = html`
  <h1>My ideas</h1>
  <p class="dim small">Signed in as <span class="addr">${m.user.wallet}</span>${connected() ? '' : ' · reconnect your wallet before signing anything'}</p>
  ${m.ideas.length ? html`<div class="tablewrap"><table><tr><th>idea</th><th>status</th><th>visibility</th><th>next</th><th>updated</th></tr>
    ${m.ideas.map((x) => html`<tr><td><a href="/ideas/${x.id}" data-link>${x.title}</a>${x.ticker ? html` <span class="pill">$${x.ticker}</span>` : ''}</td><td>${statusChip(x.status, x.provider, x.network)}<div class="faint tiny">${x.status_note || ''}</div></td>
      <td>${x.visibility}</td><td>${next(x.status) && x.slug ? html`<a href="/projects/${x.slug}/review" data-link>${next(x.status)} →</a>` : next(x.status) ? html`<a href="/ideas/${x.id}" data-link>${next(x.status)} →</a>` : '—'}</td><td class="small">${ago(x.updated_at)}</td></tr>`)}
  </table></div>` : html`<div class="empty">No ideas yet. <a href="/submit" data-link>Drop one →</a></div>`}
  <h2>Creator fees</h2>
  ${m.fees.length ? html`<div class="grid3">${m.fees.map((f) => html`<div class="card"><h3><a href="/projects/${f.slug}" data-link>${f.slug}</a></h3>
    ${f.ledger.recipients.map((r) => html`<p class="small">${r.label} · ${pct(r.bps)}<br><span class="dim">paid out: ${sol(r.confirmedPayouts)} · undistributed share: ${r.estimatedShareOfUndistributed == null ? 'n/a (direct vault)' : sol(r.estimatedShareOfUndistributed)}</span></p>`)}
    <p class="faint tiny">observed ${when(f.ledger.vaultObservedAt)}${f.ledger.mock ? ' · MOCK' : ''}</p></div>`)}</div>`
    : html`<div class="empty">No launched projects, so no fees. Nothing is estimated before a launch.</div>`}`.s;
}
