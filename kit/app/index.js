// The idea app's interpreter (docs/APP-COMPOSER.md): reads the validated app spec from <section data-app data-config>
// and builds the working app from the fixed blocks. Same rules as the core (kit/src/core.js): text only (textContent and
// attribute setters, no HTML sinks), same-origin /_api/app* without credentials, wallets for solana:signMessage only,
// no transaction ever (the launch block's own module, /_kit/site-launch.v1.js, is the one exception, kit/launch/). The
// core passes its helpers in K.
import { renderCard, cardNumber, jst } from './cards.js';
import { pqBlock } from './pq.js';
import { treeBlock } from './tree.js';

const METRIC_LABELS = { submitted_today: 'today', submitted_total: 'in total', published_total: 'published', votes_today: 'votes today', voters_today: 'voters today', days_running: 'days running' };
const HOW = { owner: "the author's pick", votes: "the holders' votes", random: 'a verifiable random draw' };
const all = (app, type) => app.screens.flatMap((s) => s.blocks).filter((b) => b.type === type);

export function hydrateApp(sec, K) {
  const { h, api, signed, save, vendor, msg, say, busy, explain, store, slideIn, tick, TOOLS } = K;
  let app; try { app = JSON.parse(sec.dataset.config || '{}'); } catch { return; }
  if (!app || !Array.isArray(app.screens)) return;
  const doc = document, body = sec.querySelector('[data-app-body]');
  const ticker = (doc.querySelector('.tk')?.textContent || '').replace(/^\$/, '');
  const name = doc.querySelector('h1')?.textContent || '';
  const accent = getComputedStyle(doc.documentElement).getPropertyValue('--ac').trim() || '#ffffff';
  const card = all(app, 'card')[0] || null;
  const voteBlock = (of) => all(app, 'vote').find((b) => b.of === of) || null;
  const subs = new Set();                                   // blocks redrawn when the state changes
  let state = null;

  // --- shared: logo, QR, the card image ------------------------------------------------------------------------------
  const logo = new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = './logo.png'; });
  const fonts = doc.fonts?.load ? Promise.all(['400 24px "JetBrains Mono"', '700 24px "JetBrains Mono"', '800 40px Inter', '400 28px Inter'].map((f) => doc.fonts.load(f).catch(() => null))) : Promise.resolve();
  const itemUrl = (item) => `${location.origin}/#item-${item.id || 'preview'}`;
  async function qrImage(text) {
    try { const q = (await vendor('qrcode')).default(0, 'M'); q.addData(text); q.make(); const i = new Image(); await new Promise((r) => { i.onload = r; i.onerror = r; i.src = q.createDataURL(6, 2); }); return i; } catch { return null; }
  }
  async function cardCanvas(item) {
    await fonts;
    return renderCard(card, item, { name, ticker, host: location.host, accent, noun: app.noun.one, logo: await logo, qr: await qrImage(item.id ? itemUrl(item) : `${location.origin}/`) });
  }
  const fileName = (item) => `${(ticker || 'coin').toLowerCase()}-${card.template}-${item.number ?? 'mine'}.png`;
  function cardView(item, { big = false, own = false } = {}) {
    const box = h('div', { cls: `app-cardimg${big ? ' big' : ''}` }), m = msg();
    const canvasP = cardCanvas(item).then((c) => { c.setAttribute('role', 'img'); c.setAttribute('aria-label', `${card.template} for ${app.noun.one} #${item.number ?? ''}: ${item.text}`); box.replaceChildren(c); return c; });
    const dl = h('button', { cls: 'btn btn-sm', type: 'button', text: `Download ${card.template} (PNG)`, onclick: () => busy(dl, async () => { const c = await canvasP; c.toBlob((b) => { if (b) save(b, fileName(item)); }, 'image/png'); }) });
    const share = h('button', { cls: 'btn btn-sm btn-ghost', type: 'button', text: 'Share', onclick: () => busy(share, async () => {
      const url = itemUrl(item), c = await canvasP;
      try {
        const blob = await new Promise((r) => c.toBlob(r, 'image/png')), file = blob && new File([blob], fileName(item), { type: 'image/png' });
        if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: `${name} #${item.number}`, url }); return; }
        if (navigator.share && !own) { await navigator.share({ title: `${name} #${item.number}`, url }); return; }
        await navigator.clipboard.writeText(url); say(m, 'Link copied.', 'ok');
      } catch (e) { if (!/abort/i.test(String(e?.name))) say(m, `Link: ${url}`); }
    }) });
    return h('div', { cls: 'app-cardwrap' }, box, h('div', { cls: 'row' }, dl, own ? null : share), m);
  }

  // --- the proof of a reveal, recomputed in the browser ----------------------------------------------------------------
  async function sha256hex(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  function proofView(item) {
    const r = item.reveal; if (!r) return item.how === 'owner' ? h('p', { cls: 'fine', text: 'Published by the author.' }) : null;
    const p = r.proof || {}, seed = p.seed;
    const lines = [`Chosen by ${HOW[r.method] || r.method}${r.dev ? ' (dev trigger, not a scheduled reveal)' : ''} at ${new Date(r.slotAt).toLocaleString()}.`];
    if (p.votes) lines.push(`Votes: ${Object.values(p.votes).reduce((a, b) => a + b, 0)} from signed wallets across ${Object.keys(p.votes).length} candidate${Object.keys(p.votes).length === 1 ? '' : 's'}${p.tie ? `; a tie of ${p.tie.length} settled by the draw` : ''}.`);
    if (seed?.source === 'solana') lines.push(`Seed: Solana slot ${seed.slot}, the first block at or after the reveal time; blockhash ${seed.blockhash}.`);
    else if (seed) lines.push(seed.note || 'Seed: the reveal instant.');
    const kids = lines.map((t) => h('p', { cls: 'fine', text: t }));
    if (seed && (p.tie || r.method === 'random')) {
      const out = msg(), ids = [...(p.tie || p.candidates || [])].sort();
      const s0 = seed.source === 'solana' ? seed.blockhash : `time:${seed.value}`;
      kids.push(h('button', { cls: 'btn btn-sm btn-ghost', type: 'button', text: 'Check the draw', onclick: async () => {
        try { const scored = await Promise.all(ids.map(async (i) => [await sha256hex(`${s0}:${i}`), i])); scored.sort((a, b) => (a[0] < b[0] ? -1 : 1));
          say(out, scored[0][1] === item.id ? `Recomputed here: sha256(seed:id) is lowest for this one among ${ids.length}. ✓` : 'Recomputed here: it does not match. ✗', scored[0][1] === item.id ? 'ok' : 'err'); }
        catch (e) { say(out, `Could not check here (${e.message}).`, 'err'); }
      } }), out);
      if (seed.source === 'solana') kids.push(h('a', { cls: 'fine', href: `https://solscan.io/block/${seed.slot}`, target: '_blank', rel: 'noopener noreferrer nofollow', text: `Look up slot ${seed.slot} on Solscan ↗` }));
    }
    return h('details', { cls: 'app-proof' }, h('summary', { text: 'How it was chosen' }), ...kids);
  }

  // --- voting --------------------------------------------------------------------------------------------------------
  function voteButton(item, block, roundKey, onDone) {
    const key = `kit.app.vote.${roundKey}`, mine = store.get(key);
    const m = msg();
    const b = h('button', { cls: `btn btn-sm${mine === item.id ? '' : ' btn-ghost'}`, type: 'button', text: mine === item.id ? 'Your vote ✓' : block.button, disabled: !!mine && roundKey.startsWith('slot:'),
      onclick: () => busy(b, async () => {
        say(m, 'Waiting for your wallet… (a message, not a transaction)');
        try {
          const sig = await signed('app.vote', { itemId: item.id });
          const r = await api('/_api/app/vote', { itemId: item.id, ...sig });
          store.set(key, item.id); say(m, `Vote counted (${r.votes}).`, 'ok'); b.textContent = 'Your vote ✓'; b.classList.remove('btn-ghost'); onDone?.(r);
        } catch (e) { if (e.body?.error === 'already_voted') store.set(key, e.body.itemId || 'x'); say(m, explain(e), 'err'); }
      }) });
    return h('div', { cls: 'app-voter' }, b, m);
  }

  // --- items -----------------------------------------------------------------------------------------------------------
  const fieldsLine = (item) => Object.entries(item.fields || {}).slice(1).map(([, v]) => String(v)).join(' · ');
  function itemCard(item, { layout = 'cards', votable = null } = {}) {
    const meta = [`#${item.number}`, new Date(item.publishedAt || item.at).toLocaleDateString(), item.how ? `by ${HOW[item.how] || item.how}` : null, item.by, item.votes ? `${item.votes} vote${item.votes === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
    const open = h('a', { cls: 'btn btn-sm btn-ghost', href: `#item-${item.id}`, text: card ? `View ${card.template}` : 'Open' });
    return h('li', { cls: `app-item ${layout}${card ? ` t-${card.template}` : ''}`, 'data-id': item.id },
      h('p', { cls: 'app-item-text', text: item.text }), fieldsLine(item) ? h('p', { cls: 'fine', text: fieldsLine(item) }) : null,
      h('small', { text: meta }), h('div', { cls: 'row' }, open, votable ? voteButton(item, votable, `item:${item.id}`) : null));
  }

  // --- blocks ----------------------------------------------------------------------------------------------------------
  const B = {
    counter(slot, b) {
      const tiles = b.metrics.map((k) => { const v = h('span', { cls: 'app-n', text: '—' }); return [k, v, h('div', { cls: 'app-tile' }, v, h('span', { cls: 'fine', text: METRIC_LABELS[k] || k }))]; });
      slot.replaceChildren(h('div', { cls: 'app-tiles' }, ...tiles.map((x) => x[2])));
      subs.add(() => { for (const [k, v] of tiles) tick(v, state.counts?.[k] ?? null, (n) => Math.round(n).toLocaleString('en-US')); });
    },
    submit(slot, b) {
      const inputs = b.fields.map((f) => {
        const label = h('label', { cls: 'app-label', text: `${f.label}${f.required ? '' : ' (optional)'}` });
        let el;
        if (f.kind === 'longtext') { el = h('textarea', { rows: 4, maxlength: f.max, placeholder: f.placeholder || '' }); }
        else if (f.kind === 'choice') { el = h('select', {}, h('option', { value: '', text: '—' }), ...f.choices.map((c) => h('option', { value: c, text: c }))); }
        else if (f.kind === 'number') { el = h('input', { type: 'number', min: f.min, max: f.max, step: 1, placeholder: f.placeholder || '' }); }
        else { el = h('input', { type: 'text', maxlength: f.max, placeholder: f.placeholder || '' }); }
        el.setAttribute('aria-label', f.label);
        const cnt = f.kind === 'longtext' || f.kind === 'text' ? h('span', { cls: 'counter', text: `0 / ${f.max}` }) : null;
        if (cnt) el.addEventListener('input', () => { cnt.textContent = `${[...el.value].length} / ${f.max}`; });
        return { f, el, cnt, wrap: h('div', { cls: 'app-field' }, label, el, cnt) };
      });
      const m = msg(), mine = h('div', { cls: 'app-mine' });
      const note = h('p', { cls: 'fine app-disclose' });
      const send = h('button', { cls: 'btn', type: 'button', text: b.holdersOnly ? `Sign and ${b.button.toLowerCase()}` : b.button, onclick: () => busy(send, async () => {
        const fields = {};
        for (const { f, el } of inputs) { const v = el.value.trim(); if (v !== '') fields[f.key] = f.kind === 'number' ? Number(v) : v; }
        say(m, b.holdersOnly ? 'Waiting for your wallet… (a message, not a transaction)' : 'Sending…');
        try {
          const extra = b.holdersOnly ? await signed('app.submit', { fields }) : {};
          const r = await api('/_api/app/submit', { fields, ...extra });
          for (const { el, cnt, f } of inputs) { el.value = ''; if (cnt) cnt.textContent = `0 / ${f.max}`; }
          say(m, `${b.thanks} (#${r.number})`, 'ok');
          const own = { id: r.item?.id, number: r.number, text: fields[b.fields[0].key], fields, at: Date.now() };
          mine.replaceChildren(...(card ? [h('p', { cls: 'fine', text: `Your copy of #${r.number}: keep it, it is made in your browser.` }), cardView(own, { own: true })] : []));
          await refresh();
        } catch (e) { say(m, explain(e), 'err'); }
      }) });
      subs.add(() => {
        const ex = state.exposure, hm = state.submit;
        note.textContent = [ex === 'private' ? `It stays private: only the author sees it, unless it is chosen.` : ex === 'candidates' ? `It shows up, anonymous, in the current round's candidates so holders can vote; one is chosen at the reveal.` : 'It shows up on this page right away (anonymous). The author can hide anything.',
          hm?.note || ''].filter(Boolean).join(' ');
      });
      slot.replaceChildren(h('p', { text: b.prompt }), ...inputs.map((x) => x.wrap), h('div', { cls: 'row' }, send), m, note, mine);
    },
    schedule(slot, b) {
      if (b.every === 'day') { TOOLS.event(null, slot, { title: b.label, daily: b.at }); return; }
      const box = slot.querySelector('[data-count]') || slot.appendChild(h('div', { cls: 'count' }));
      const seg = (n, u) => [String(n).padStart(2, '0'), h('small', { text: u })];
      const draw = () => { if (!state?.schedule) return; let s = Math.max(0, Math.floor((state.schedule.nextAt - Date.now()) / 1000)); const d = Math.floor(s / 86400); s %= 86400;
        box.replaceChildren(...(d ? seg(d, 'd') : []), ...seg(Math.floor(s / 3600), 'h'), ...seg(Math.floor(s / 60) % 60, 'm'), ...seg(s % 60, 's')); };
      subs.add(draw); setInterval(draw, 1000);
    },
    reveal(slot, b) {
      subs.add(() => {
        const it = state.latest, kids = [];
        if (it) {
          const j = jst(it.publishedAt);
          kids.push(h('span', { cls: 'eyebrow', text: `${j.y}-${j.m}-${j.d} ${j.hh}:${j.mm} JST · #${it.number}${it.reveal?.dev ? ' · dev trigger' : ''}` }), h('p', { cls: 'featured', text: it.text }));
          if (card) kids.push(cardView(it, { big: true }));
          const pv = proofView(it); if (pv) kids.push(pv);
        } else kids.push(h('p', { cls: 'fine', text: state.lastReveal?.method === 'empty' ? b.empty : `The first one is chosen ${state.schedule ? `at ${state.schedule.at} JST` : 'soon'}.` }));
        if (state.schedule) kids.push(h('p', { cls: 'fine', text: `Next: ${new Date(state.schedule.nextAt).toLocaleString()} (${state.schedule.at} JST). Order: ${b.pick.map((x) => HOW[x]).join(', then ')}.` }));
        slot.replaceChildren(...kids);
      });
    },
    vote(slot, b) {
      if (b.of === 'published') {
        slot.replaceChildren(h('p', { cls: 'fine', text: `Vote on any ${app.noun.one} in the list: one signed vote per wallet per ${app.noun.one} (a message, never a transaction).` }), h('p', { cls: 'fine', 'data-note': '' }));
        subs.add(() => { slot.querySelector('[data-note]').textContent = state.vote?.note || ''; });
        return;
      }
      const list = h('ol', { cls: 'app-cands' }), note = h('p', { cls: 'fine' });
      subs.add(() => {
        note.textContent = [`One signed vote per wallet this round (a message, never a transaction).`, state.vote?.note || ''].join(' ');
        const c = state.candidates || [];
        list.replaceChildren(...(c.length ? c.map((it) => h('li', { cls: 'app-cand' }, h('p', { text: it.text }), fieldsLine(it) ? h('p', { cls: 'fine', text: fieldsLine(it) }) : null,
          h('small', { text: `#${it.number} · ${new Date(it.at).toLocaleTimeString()} · ${it.votes} vote${it.votes === 1 ? '' : 's'}` }), voteButton(it, b, state.round.key, () => refresh())))
          : [h('li', { cls: 'fine', text: `No ${app.noun.many} in this round yet.` })]));
      });
      slot.replaceChildren(note, list);
    },
    collection(slot, b) {
      const list = h('ul', { cls: `app-items ${b.layout}` }), m = msg();
      const month = b.filters.includes('month') ? h('select', { 'aria-label': 'Month' }, h('option', { value: '', text: 'All months' })) : null;
      const q = b.filters.includes('search') ? h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search', maxlength: 40 }) : null;
      const more = h('button', { cls: 'btn btn-ghost btn-sm', type: 'button', text: 'More', hidden: true });
      const votable = voteBlock('published');
      let next = null, timer = null;
      const load = async (append) => {
        const p = new URLSearchParams({ show: b.show, limit: '24' });
        if (month?.value) p.set('month', month.value); if (q?.value.trim()) p.set('q', q.value.trim()); if (append && next) p.set('before', String(next));
        try {
          const r = await api(`/_api/app/items?${p}`);
          if (month && month.options.length === 1) for (const mo of r.months) month.append(h('option', { value: mo, text: mo }));
          const nodes = r.items.map((it) => itemCard(it, { layout: b.layout, votable }));
          if (append) list.append(...nodes); else list.replaceChildren(...(nodes.length ? nodes : [h('li', { cls: 'fine', text: b.empty })]));
          next = r.next; more.hidden = !next; say(m, '');
        } catch (e) { say(m, explain(e), 'err'); }
      };
      month?.addEventListener('change', () => load(false));
      q?.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(false), 300); });
      more.onclick = () => busy(more, () => load(true));
      slot.replaceChildren(...(month || q ? [h('div', { cls: 'row app-filters' }, month, q)] : []), list, more, m);
      let last = -1; subs.add(() => { const n = (state.counts?.published_total ?? 0) + (state.counts?.submitted_total ?? 0); if (n !== last) { last = n; load(false); } });
    },
    card(slot, b) {
      if (!b.input) { slot.replaceChildren(h('p', { cls: 'fine', text: `Every ${app.noun.one} becomes a ${b.template} you can download.` })); return; }
      const ta = h('textarea', { rows: 3, maxlength: 200, placeholder: 'Your text (stays in your browser)', 'aria-label': 'Card text' });
      const box = h('div');
      const draw = () => { const own = { number: null, text: ta.value.trim() || `Your ${app.noun.one} here`, fields: {}, at: Date.now() }; box.replaceChildren(cardView(own, { own: true })); };
      let t = null; ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 250); });
      draw();
      slot.replaceChildren(h('p', { cls: 'fine', text: `Make your own ${b.template}: type, then download the PNG. Made in your browser; nothing is uploaded or saved.` }), ta, box);
    },
    leaderboard(slot, b, i) {
      const list = h('ol', { cls: 'app-board' });
      const load = async () => { try { const r = await api(`/_api/app/leaderboard?i=${i}`);
        list.replaceChildren(...(r.rows.length ? r.rows.map((x) => h('li', {}, h('span', { text: r.of === 'items' ? x.text : x.wallet }), h('b', { text: String(x.score) }))) : [h('li', { cls: 'fine', text: 'Nobody on the board yet.' })])); } catch { /* later */ } };
      subs.add(load);
      slot.replaceChildren(list);
    },
    map(slot) { return TOOLS.map(null, slot); },
    timer(slot, b) { TOOLS.event(null, slot, b); },
    note() {},
    pq(slot, b) { pqBlock(slot, b, { ...K, launches: all(app, 'launch').length > 0 }); },
    // visitors launch real coins here (child-launch.js): its own module, the only one in the kit that asks a wallet to
    // sign a transaction, loaded only on a site whose app has this block
    // the live family tree of a launchpad family (family.js): read-only
    tree(slot, b) { return treeBlock(slot, b, K); },
    launch(slot, b) { return import(/* @vite-ignore */ '/_kit/site-launch.v1.js').then((m) => m.launchBlock(slot, b, K)); },
  };

  // --- screens (tabs) and the item viewer -------------------------------------------------------------------------------
  const screens = [...body.querySelectorAll('.app-screen')];
  const tabs = h('div', { cls: 'app-tabs', role: 'tablist' });
  const show = (id) => {
    for (const s of screens) { const on = s.dataset.screen === id; s.hidden = !on; }
    for (const t of tabs.children) { t.setAttribute('aria-selected', String(t.dataset.screen === id)); t.classList.toggle('on', t.dataset.screen === id); }
  };
  if (screens.length === 1) screens[0].querySelector('.app-screen-h')?.remove();
  if (screens.length > 1) {
    for (const s of screens) tabs.append(h('button', { type: 'button', role: 'tab', 'data-screen': s.dataset.screen, text: s.querySelector('.app-screen-h')?.textContent || s.dataset.screen, onclick: () => show(s.dataset.screen) }));
    body.before(tabs);
    for (const s of screens) s.querySelector('.app-screen-h')?.remove();
    show(screens[0].dataset.screen);
  }
  app.screens.forEach((s, si) => {
    const el = screens[si]; if (!el) return;
    s.blocks.forEach((b, bi) => {
      const node = el.querySelector(`.app-block[data-i="${bi}"]`), slot = node?.querySelector('[data-slot]');
      if (!slot || !B[b.type]) return;
      const idx = s.blocks.slice(0, bi).filter((x) => x.type === b.type).length + app.screens.slice(0, si).flatMap((x) => x.blocks).filter((x) => x.type === b.type).length;
      try { const p = B[b.type](slot, b, idx); if (p?.catch) p.catch((e) => { slot.append(h('p', { cls: 'fine', text: `Could not load (${e.message}).` })); }); }
      catch (e) { slot.append(h('p', { cls: 'fine', text: `Could not load (${e.message}).` })); }
    });
  });

  async function openItem(id) {
    let it; try { it = await api(`/_api/app/items/${encodeURIComponent(id)}`); } catch (e) { return; }
    const close = () => { box.remove(); if (location.hash === `#item-${id}`) history.replaceState(null, '', location.pathname + location.search); };
    const box = h('div', { cls: 'picker app-viewer', role: 'dialog', 'aria-label': `${app.noun.one} #${it.number}`, onclick: (e) => { if (e.target === box) close(); } },
      h('div', { cls: 'card' }, h('span', { cls: 'eyebrow', text: `${app.noun.one} #${it.number}` }), h('p', { cls: 'featured', text: it.text }),
        card ? cardView(it, { big: true }) : null, proofView(it), voteBlock('published') ? voteButton(it, voteBlock('published'), `item:${it.id}`) : null,
        h('button', { cls: 'btn btn-ghost', type: 'button', text: 'Close', onclick: close })));
    doc.body.append(box); slideIn(box.firstChild);
  }
  const onHash = () => { const m = /^#item-([A-Za-z0-9_-]{1,40})$/.exec(location.hash); if (m) openItem(m[1]); };
  addEventListener('hashchange', onHash);

  async function refresh() {
    try { state = await api('/_api/app'); } catch (e) { const n = sec.querySelector('[data-static]'); if (n) n.textContent = `The app could not load right now (${e.message}).`; return; }
    for (const f of subs) { try { await f(); } catch { /* one block failing never blanks the others */ } }
  }
  return refresh().then(() => { sec.querySelector('[data-static]')?.remove(); sec.classList.add('live'); onHash(); setInterval(refresh, 60_000); });
}

export { cardNumber };
