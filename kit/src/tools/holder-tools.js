// The holder tools of the site kit (docs/SITE-KIT.md "Holder tools"): live trades, holders, dev watch, fee ledger and
// browser alerts. Same rules as the core (core.js): text only (textContent / attributes, never HTML), same-origin GETs
// to /_api/*, no wallet, no transaction. Every number comes from the server's chain read; a missing one is "—" with
// the server's reason next to it. Polls pause while the tab is hidden.
export function holderTools(k) {
  const { h, api, msg, say, busy, usd, count, slideIn, store, isNum, DASH, doc, win } = k;
  const every = (ms, fn) => setInterval(() => { if (!doc.hidden) fn(); }, ms);
  const ext = (href, text, cls = 'lnk') => (href ? h('a', { href, text, cls, target: '_blank', rel: 'noopener noreferrer nofollow' }) : h('span', { text }));
  const sol = (n) => (isNum(n) ? `${n === 0 ? '0' : n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(4)} SOL` : DASH);
  const tokens = (n) => { if (!isNum(n)) return DASH; const a = Math.abs(n); return `${n < 0 ? '−' : ''}${a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a.toFixed(0)}`; };
  const pc = (n) => (isNum(n) ? `${n >= 10 ? n.toFixed(1) : n.toFixed(2)}%` : DASH);
  const today = (t) => new Date(t).toDateString() === new Date().toDateString();
  const time = (t) => (!isNum(t) ? DASH : today(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }));
  const when = (t) => (isNum(t) ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : DASH);
  const chip = (text, cls = '') => h('span', { cls: `flag ${cls}`, text });
  const stat = (label, value, sub) => h('div', { cls: 'stat' }, h('span', { cls: 'stat-k', text: label }), h('span', { cls: 'stat-v', text: value }), sub ? h('small', { cls: 'fine', text: sub }) : null);
  // pre-launch / mock: what the tool does (the page's own text stays) and why there are no numbers yet
  const blank = (slot, s) => { slot.append(h('p', { cls: 'chip', text: s.note || 'Nothing to show yet.' })); };
  const errLine = (s) => (s.error ? h('p', { cls: 'msg err', text: `Chain read: ${s.error}. Numbers below are the last ones read.` }) : null);
  const histLine = (hi, what) => {
    if (!hi) return null;
    const unread = hi.unreadable ? ` ${count(hi.unreadable)} could not be read from the RPC and are left out.` : '';
    if (hi.complete) return `${what}: complete (${count(hi.done - (hi.unreadable || 0))} transactions read).${unread}`;
    return `${what}: ${count(hi.done)} of ${count(hi.listed)} transactions read so far${hi.listedAll ? '' : ' (older ones still being listed)'}; it fills in while this page is open.`;
  };
  async function live(slot, path, draw, ms) {
    let s = await api(path);
    if (s.state !== 'live') { blank(slot, s); return; }
    draw(s, true);
    every(ms, async () => { try { s = await api(path); draw(s, false); } catch { /* offline for a moment */ } });
  }

  // ---- live trades ----------------------------------------------------------------------------------------------
  async function trades(sec, slot) {
    const list = h('ol', { cls: 'trades', 'aria-live': 'polite' }), head = h('div', { cls: 'stats' }), foot = h('p', { cls: 'fine' }), m = h('div', {});
    const FLAG = { dev: ['DEV', 'warn'], top10: ['TOP 10', 'info'], first: ['1ST BUY', 'ok'] };
    const row = (x) => h('li', { cls: `trade ${x.side}`, 'data-sig': `${x.sig}` },
      h('span', { cls: 'tt', text: time(x.at), title: when(x.at) }),
      h('span', { cls: `side ${x.side}`, text: x.side === 'buy' ? 'BUY' : 'SELL' }),
      h('span', { cls: 'num', text: x.quote === 'SOL' ? sol(x.sol) : `${count(x.quoteAmount)} (quote)` }),
      h('span', { cls: 'num dim', text: tokens(x.tokens) }),
      h('span', { cls: 'who' }, ext(x.walletUrl, x.short), ...x.flags.map((f) => chip(FLAG[f]?.[0] || f, FLAG[f]?.[1]))),
      ext(x.txUrl, '↗', 'lnk tx'));
    const draw = (s, first) => {
      const d = s.last24h;
      head.replaceChildren(stat('Buys · 24h', d ? count(d.buys) : DASH), stat('Sells · 24h', d ? count(d.sells) : DASH), stat('SOL in · 24h', d ? sol(d.solIn) : DASH),
        stat('SOL out · 24h', d ? sol(d.solOut) : DASH), stat('Wallets · 24h', d ? count(d.wallets) : DASH));
      if (!d) head.append(h('p', { cls: 'fine wide', text: 'The 24 h totals appear once the history read reaches back a full day.' }));
      const have = new Set([...list.children].map((li) => li.dataset.sig));
      if (first || !have.size) list.replaceChildren(...s.trades.map(row));
      else for (const x of s.trades.filter((t) => !have.has(t.sig)).reverse()) { const li = row(x); list.prepend(li); slideIn(li); }
      while (list.children.length > 50) list.lastChild.remove();
      if (!s.trades.length) list.replaceChildren(h('li', { cls: 'fine', text: s.syncing ? 'Reading the chain…' : 'No trades read yet.' }));
      m.replaceChildren(...[errLine(s), s.note ? h('p', { cls: 'chip', text: s.note }) : null, s.migrated && s.links?.dexscreener ? h('div', { cls: 'row' }, ext(s.links.dexscreener, 'Trades on DexScreener', 'btn btn-ghost btn-sm')) : null].filter(Boolean));
      foot.textContent = `${histLine(s.history, 'History') || ''} Source: ${s.source}. Times are yours (local).`;
    };
    slot.replaceChildren(head, m, h('div', { cls: 'trades-h' }, ...['Time', 'Side', 'SOL', 'Tokens', 'Wallet', ''].map((t) => h('span', { text: t }))), list, foot);
    await live(slot, '/_api/trades', draw, 15_000);
  }

  // ---- holders ----------------------------------------------------------------------------------------------------
  async function holders(sec, slot) {
    const risk = h('p', { cls: 'risk' }), head = h('div', { cls: 'stats' }), list = h('ol', { cls: 'holders' }), foot = h('p', { cls: 'fine' }), m = h('div', {});
    const draw = (s) => {
      risk.textContent = s.risk?.line || DASH; risk.className = `risk ${s.risk?.level || ''}`;
      head.replaceChildren(stat('Holders', isNum(s.count) ? `${s.countExact ? '' : '≥ '}${count(s.count)}` : DASH, isNum(s.count) ? null : 'count needs the Helius reader'),
        stat('Top 10 hold', pc(s.top10Pct), isNum(s.top10CircPct) ? `${pc(s.top10CircPct)} of the tokens in circulation` : null), stat('Largest wallet', pc(s.top1Pct)), stat('Supply', tokens(s.supply)));
      list.replaceChildren(...(s.holders || []).map((x) => h('li', { cls: x.excluded ? 'excluded' : '' },
        h('span', { cls: 'rank', text: `#${x.rank}` }), h('span', { cls: 'who' }, ext(x.url, x.short), x.label ? chip(x.label, x.excluded ? '' : x.label.startsWith('author') ? 'warn' : 'info') : null),
        h('span', { cls: 'num', text: pc(x.pct) }), h('i', { cls: 'hbar', style: `width:${Math.min(100, Math.max(0.5, (x.pct || 0) * (x.excluded ? 1 : 2)))}%` }))));
      m.replaceChildren(...[errLine(s)].filter(Boolean));
      foot.textContent = `Source: ${s.source || DASH}.${s.countSource ? ` Holder count: ${s.countSource}.` : ''}${s.countNote ? ` ${s.countNote}` : ''} Updated ${when(s.at)}; refreshes every 5 minutes.`;
    };
    slot.replaceChildren(risk, head, m, list, foot);
    await live(slot, '/_api/holders', draw, 60_000);
  }

  // ---- dev watch --------------------------------------------------------------------------------------------------
  async function devwatch(sec, slot) {
    const status = h('p', { cls: 'risk' }), head = h('div', { cls: 'stats' }), list = h('ol', { cls: 'moves' }), foot = h('p', { cls: 'fine' }), who = h('p', { cls: 'fine' }), m = h('div', {});
    const draw = (s) => {
      status.textContent = s.status || DASH; status.className = `risk ${s.level === 'warn' ? 'high' : s.level === 'ok' ? 'low' : 'moderate'}`;
      head.replaceChildren(stat('Dev buy', isNum(s.devBuy) ? tokens(s.devBuy) : DASH, s.devBuySource ? null : 'not known'), stat('Holds now', tokens(s.balance)),
        stat('Of the dev buy', pc(s.heldPct)), stat('Sold', tokens(s.sold)));
      who.replaceChildren('Author wallet ', ext(s.authorUrl, s.authorShort), s.devBuySource ? ` · ${s.devBuySource}` : '');
      list.replaceChildren(...(s.moves || []).map((x) => h('li', {}, h('span', { cls: 'tt', text: when(x.at) }), chip(x.kind.toUpperCase(), x.tokens < 0 ? 'warn' : 'ok'),
        h('span', { cls: 'num', text: `${x.tokens > 0 ? '+' : ''}${tokens(x.tokens)}` }), h('span', { cls: 'num dim', text: isNum(x.sol) && x.sol ? sol(x.sol) : '' }), ext(x.txUrl, '↗', 'lnk tx'))));
      if (!s.moves?.length) list.replaceChildren(h('li', { cls: 'fine', text: s.syncing ? 'Reading the author account…' : 'No moves of the coin in or out of the author account.' }));
      m.replaceChildren(...[errLine(s)].filter(Boolean));
      foot.textContent = histLine(s.history, 'Author account history') || '';
    };
    slot.replaceChildren(status, head, who, m, list, foot);
    await live(slot, '/_api/devwatch', draw, 30_000);
  }

  // ---- fee ledger -------------------------------------------------------------------------------------------------
  async function fees(sec, slot) {
    const head = h('div', { cls: 'stats' }), split = h('div', { cls: 'split' }), dist = h('ol', { cls: 'moves' }), foot = h('p', { cls: 'fine' }), lock = h('p', { cls: 'fine lock' }), m = h('div', {});
    const draw = (s) => {
      const floor = s.partial ? '≥ ' : '';                     // payout history still loading: a floor, said as one
      head.replaceChildren(stat('Accrued (total)', `${floor}${sol(s.accrued)}`, s.partial ? 'payout history still loading' : null), stat('Paid out', `${floor}${sol(s.distributed)}`), stat('Waiting', sol(s.waiting),
        s.waitingParts ? `vault ${sol(s.waitingParts.vault)} · on the curve ${sol(s.waitingParts.curve)}${isNum(s.waitingParts.amm) ? ` · PumpSwap ${sol(s.waitingParts.amm)}` : ''}` : null));
      lock.replaceChildren(...(s.sharingConfig ? [chip(s.adminRevoked ? 'SPLIT LOCKED ON CHAIN' : 'SPLIT NOT LOCKED', s.adminRevoked ? 'ok' : 'warn'), ' Sharing config ', ext(s.links?.sharingConfig, `${s.sharingConfig.slice(0, 4)}…${s.sharingConfig.slice(-4)}`),
        ' · creator vault ', ext(s.links?.vault, 'on Solscan')] : []));
      split.replaceChildren(...(s.shareholders || []).map((x) => h('div', { cls: 'share' },
        h('div', { cls: 'share-h' }, h('b', { text: `${x.pct}%` }), ' ', x.label ? chip(x.label, x.label === 'SUB-01' ? 'info' : 'ok') : null, ' ', ext(x.url, x.short)),
        h('i', { cls: 'hbar', style: `width:${x.pct}%` }),
        h('small', { cls: 'fine', text: `accrued ${sol(x.accrued)} · received ${sol(x.received)} · waiting ${sol(x.waiting)}` }))));
      dist.replaceChildren(...(s.distributions || []).map((d) => h('li', {}, h('span', { cls: 'tt', text: when(d.at) }), chip('PAID OUT', 'ok'), h('span', { cls: 'num', text: sol(d.sol) }), ext(d.txUrl, '↗', 'lnk tx'))));
      if (!s.distributions?.length) dist.replaceChildren(h('li', { cls: 'fine', text: 'No payout yet: pump.fun distributes the vault to the shareholders from time to time.' }));
      m.replaceChildren(...[errLine(s), s.note ? h('p', { cls: 'chip', text: s.note }) : null].filter(Boolean));
      const ft = s.fromTrades;
      foot.textContent = `Accrued = paid out + waiting, both read on chain now.${ft ? ` Cross-check: the ${count(ft.trades)} curve trades read so far carried ${sol(ft.sol)} of creator fees${ft.complete ? ' (complete history)' : ' (history still loading)'}.` : ''}${s.migrated ? ' After the migration, PumpSwap fees are counted in "waiting" when they sit in the AMM creator vault.' : ''}`;
    };
    slot.replaceChildren(head, lock, m, h('span', { cls: 'eyebrow', text: 'The split' }), split, h('span', { cls: 'eyebrow', text: 'Payouts' }), dist, foot);
    await live(slot, '/_api/fees', draw, 60_000);
  }

  // ---- alerts (this browser only) ---------------------------------------------------------------------------------
  let toasts = null;
  function toast(text) {
    if (!toasts) { toasts = h('div', { cls: 'toasts', role: 'status', 'aria-live': 'polite' }); doc.body.append(toasts); }
    const t = h('div', { cls: 'toast' }, h('b', { text: 'Alert' }), h('span', { text }), h('button', { type: 'button', cls: 'x', text: '×', 'aria-label': 'Dismiss', onclick: () => t.remove() }));
    toasts.append(t); slideIn(t); setTimeout(() => t.remove(), 20_000);
  }
  function notify(text) {
    toast(text);
    try { if (win.Notification?.permission === 'granted') new win.Notification(doc.title || 'Alert', { body: text, icon: './logo.png', tag: `${location.host}-${text.slice(0, 40)}` }); } catch { /* some browsers only notify from a service worker */ }
  }
  async function alerts(sec, slot) {
    const KEY = `kit.alerts.${location.host}`;
    const load = () => { try { return JSON.parse(store.get(KEY) || '[]').filter((a) => a && typeof a.kind === 'string'); } catch { return []; } };
    let list = load();
    const save = () => store.set(KEY, JSON.stringify(list));
    const kind = h('select', { 'aria-label': 'Alert type' }, h('option', { value: 'mcAbove', text: 'Market cap rises above' }), h('option', { value: 'mcBelow', text: 'Market cap falls below' }),
      h('option', { value: 'devSell', text: 'The dev sells or moves tokens out' }));
    const amount = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'USD, e.g. 50000', 'aria-label': 'Market cap in USD' });
    kind.addEventListener('change', () => { amount.hidden = kind.value === 'devSell'; });
    const ul = h('ul', { cls: 'feed' }), m = msg(), status = h('p', { cls: 'fine' });
    let token = null, dev = null;
    const describe = (a) => (a.kind === 'devSell' ? 'when the dev sells or moves tokens out' : `when the market cap goes ${a.kind === 'mcAbove' ? 'above' : 'below'} ${usd(a.usd)}`);
    const draw = () => {
      ul.replaceChildren(...list.map((a, i) => h('li', {}, h('span', { text: `${a.fired ? 'Fired' : 'Armed'}: tell me ${describe(a)}` }),
        h('small', { text: a.fired ? `fired ${when(a.fired)}` : `set ${when(a.at)}` }), h('button', { type: 'button', cls: 'btn btn-ghost btn-sm', text: 'Remove', onclick: () => { list.splice(i, 1); save(); draw(); } }))));
      if (!list.length) ul.append(h('li', { cls: 'fine', text: 'No alerts yet.' }));
    };
    const perm = () => (!('Notification' in win) ? 'this browser has no notifications: alerts show on this page only'
      : win.Notification.permission === 'granted' ? 'browser notifications on' : win.Notification.permission === 'denied' ? 'browser notifications blocked: alerts show on this page only' : 'browser notifications not asked yet');
    const lastOut = (d) => (d?.moves || []).filter((x) => x.tokens < 0).map((x) => x.sig)[0] || null;
    const add = h('button', { cls: 'btn', type: 'button', text: 'Set alert', onclick: () => busy(add, async () => {
      const a = { kind: kind.value, at: Date.now() };
      if (a.kind !== 'devSell') { const v = Number(amount.value); if (!(v > 0)) { say(m, 'Type a market cap in US dollars first.', 'err'); return; } a.usd = v; }
      else { try { dev = await api('/_api/devwatch'); } catch { /* checked below */ } a.seen = lastOut(dev); }
      if ('Notification' in win && win.Notification.permission === 'default') { try { await win.Notification.requestPermission(); } catch { /* old Safari */ } }
      list.push(a); save(); draw(); amount.value = ''; say(m, `Alert set (${perm()}). It is stored in this browser only.`, 'ok');
      await check();                                            // a line already crossed fires now, not in a minute
    }) });
    const check = async () => {
      if (!list.some((a) => !a.fired)) return;
      try { if (list.some((a) => !a.fired && a.kind !== 'devSell')) token = await api('/_api/token'); } catch { /* next round */ }
      try { if (list.some((a) => a.kind === 'devSell')) dev = await api('/_api/devwatch'); } catch { /* next round */ }
      const mc = token?.marketCapUsd;
      for (const a of list) {
        if (a.fired) continue;
        if (a.kind === 'mcAbove' && isNum(mc) && mc > a.usd) { a.fired = Date.now(); notify(`Market cap is ${usd(mc)}: above your ${usd(a.usd)} line.`); }
        if (a.kind === 'mcBelow' && isNum(mc) && mc < a.usd) { a.fired = Date.now(); notify(`Market cap is ${usd(mc)}: below your ${usd(a.usd)} line.`); }
        if (a.kind === 'devSell') {
          const last = lastOut(dev);
          if (last && last !== a.seen) { a.seen = last; const x = dev.moves.find((y) => y.sig === last); notify(`The dev ${x?.kind === 'sell' ? 'sold' : 'moved out'} ${tokens(Math.abs(x?.tokens))} tokens. ${dev.status || ''}`); }
        }
      }
      save(); draw();
      status.textContent = `Checks every minute while this page is open (${perm()}). Market cap ${isNum(mc) ? usd(mc) : DASH}${token?.at ? `, from ${token.sourceLabel || token.source}, updated ${when(token.at)}` : ''}.`;
    };
    const s = await api('/_api/token').catch(() => null);
    if (s?.state === 'pre-launch' || s?.state === 'mock') { slot.append(h('p', { cls: 'chip', text: s.state === 'mock' ? 'MOCK launch: no market to watch.' : 'Goes live at launch: there is no market cap to watch yet.' })); return; }
    token = s;
    draw();
    slot.replaceChildren(h('div', { cls: 'alert-form' }, kind, amount, add), m, ul, status,
      h('p', { cls: 'fine', text: 'Nothing is sent anywhere: the alerts live in this browser (localStorage) and run only while this page is open. The market cap is the stored DexScreener figure (refreshed every 5–30 minutes); dev sales come from the dev watch.' }));
    await check();
    every(60_000, check);
  }

  return { trades, holders, devwatch, fees, alerts };
}
