// The tree block (docs/APP-COMPOSER.md "Launchpad families"; server: src/family.js treeView, GET /_api/tree): the live
// family tree of the launchpads born from this one. Who launched whom (name, ticker, link to its site, launch time,
// depth), descendant counts, the fastest-growing branch (launches in the last 24 hours) and the most descendants.
// Read-only: nothing to sign. Same rules as the rest of the kit: text only (textContent and attribute setters, no HTML
// sinks), same-origin /_api without credentials. Branches are <details>, so they fold without any script state.
const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const usd = (n) => (typeof n !== 'number' ? null : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const SHOW = 30;                                          // children drawn per branch before "show all"

export function treeBlock(slot, b, K) {
  const { h, api, msg, say, explain } = K;
  const m = msg(), body = h('div', { cls: 'tr-body' });
  slot.replaceChildren(body, m);
  let last = '';

  function nodeView(n, kids, focus, open) {
    const me = n.slug === focus;
    const meta = [n.depth === 0 ? 'the root' : `generation ${n.depth}`, n.launchpad ? 'launchpad' : 'coin', n.launched ? `${n.mock ? 'MOCK launch' : 'launched'} ${when(n.launchedAt)}` : 'not launched yet',
      n.descendants ? `${n.descendants} descendant${n.descendants === 1 ? '' : 's'}` : null, n.branch24h ? `+${n.branch24h} in 24 h` : null,
      n.inProgress ? `${n.inProgress} on the way` : null, usd(n.marketCapUsd) ? `MC ${usd(n.marketCapUsd)}` : null].filter(Boolean).join(' · ');
    const name = n.siteUrl ? h('a', { href: n.siteUrl, target: me ? null : '_blank', rel: 'noopener noreferrer', text: n.name }) : h('span', { text: n.name });
    const row = h('div', { cls: `tr-row${me ? ' me' : ''}${n.launchpad ? ' pad' : ''}` },
      h('span', { cls: 'tr-g', text: `G${n.depth}`, 'aria-label': `generation ${n.depth}` }),
      h('div', { cls: 'tr-who' }, h('div', { cls: 'tr-name' }, name, h('code', { text: `$${n.ticker}` }), me ? h('span', { cls: 'tr-here', text: 'this site' }) : null),
        h('small', { text: meta })));
    const list = kids.get(n.slug) || [];
    if (!list.length) return h('li', { cls: 'tr-leaf' }, row);
    const ul = h('ul', { cls: 'tr-kids' });
    const draw = (all) => ul.replaceChildren(...(all ? list : list.slice(0, SHOW)).map((k) => nodeView(k, kids, focus, open)),
      ...(!all && list.length > SHOW ? [h('li', { cls: 'tr-more' }, h('button', { cls: 'btn btn-sm btn-ghost', type: 'button', text: `Show all ${list.length}`, onclick: () => draw(true) }))] : []));
    draw(false);
    const sum = h('summary', {}, row);
    return h('li', {}, h('details', { open: open(n) }, sum, ul));
  }

  function ranking(title, rows, value, empty) {
    return h('div', { cls: 'tr-rank' }, h('h4', { text: title }),
      rows.length ? h('ol', { cls: 'app-board' }, ...rows.map((r) => h('li', {}, h('span', {}, r.siteUrl ? h('a', { href: r.siteUrl, target: '_blank', rel: 'noopener noreferrer', text: `${r.name} $${r.ticker}` }) : `${r.name} $${r.ticker}`,
        h('small', { text: ` generation ${r.depth}` })), h('b', { text: value(r) }))))
        : h('p', { cls: 'fine', text: empty }));
  }

  function draw(t) {
    const kids = new Map(), bySlug = new Map(t.nodes.map((n) => [n.slug, n]));
    for (const n of t.nodes) if (n.parent) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
    // the path to this site stays open; the first two generations open; deeper branches fold
    const path = new Set();
    for (let n = bySlug.get(t.focus); n; n = bySlug.get(n.parent)) path.add(n.slug);
    const open = (n) => n.depth < 2 || path.has(n.slug);
    const root = t.nodes[0];
    const tiles = [[t.totals.coins, 'born in the family'], [t.totals.launchpads, t.totals.launchpads === 1 ? 'of them a launchpad' : 'of them launchpads'],
      [t.totals.launched24h, 'launched in 24 h'], [`${t.totals.deepest}/${t.maxDepth}`, 'generations deep']];
    const kidsOf = root ? kids.get(root.slug) || [] : [];
    body.replaceChildren(...[
      h('div', { cls: 'app-tiles' }, ...tiles.map(([v, l]) => h('div', { cls: 'app-tile' }, h('span', { cls: 'app-n', text: String(v) }), h('span', { cls: 'fine', text: l })))),
      h('p', { cls: 'fine tr-note', text: `${t.note} At most ${t.maxDepth} generations: a coin at generation ${t.maxDepth} does not launch coins.` }),
      ...(b.rankings ? [h('div', { cls: 'tr-ranks' },
        ranking('Fastest-growing branch', t.fastest, (r) => `+${r.branch24h} in 24 h`, 'No branch grew in the last 24 hours.'),
        ranking('Most descendants', t.mostDescendants, (r) => String(r.descendants), 'No launchpad has descendants yet.'))] : []),
      h('h4', { cls: 'tr-h', text: 'Who launched whom' }),
      root ? h('ul', { cls: 'tr-tree' }, nodeView(root, kids, t.focus, open)) : null,
      kidsOf.length ? null : h('p', { cls: 'fine', text: 'Nothing launched from the root yet: the first launchpad born here starts the tree.' }),
      t.truncated ? h('p', { cls: 'fine', text: `Showing the first ${t.nodes.length} members of the family.` }) : null,
      h('p', { cls: 'fine tr-at', text: `Read from the launch records ${when(t.generatedAt)}. Counts only: nothing here is estimated.` })].filter(Boolean));
  }

  async function load() {
    try {
      const t = await api('/_api/tree');
      const sig = JSON.stringify([t.nodes, t.totals, t.fastest, t.mostDescendants]);
      if (sig !== last) { last = sig; draw(t); }
      say(m, '');
    } catch (e) { say(m, explain(e), 'err'); }
  }
  return load().then(() => { setInterval(load, 60_000); });
}
