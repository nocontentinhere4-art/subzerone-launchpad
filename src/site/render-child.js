// Sandboxed site build: runs as a separate Node process with the permission model on (no filesystem writes, no child
// processes, no workers, no addons), an empty environment (no secrets), a 64 MB heap and a wall-clock limit set by the
// parent. Input: {spec, context} JSON on stdin. Output: one static HTML page on stdout. No network access is used and
// none is needed. Self-contained on purpose: it may read only this file.
// The page carries no script of its own. Its one script is the audited kit (/_kit/site-kit.v1.js) and its one
// stylesheet the kit's (/_kit/site-kit.v2.css), both exact strings site.js validateHtml allows; the tools are
// <section data-tool="…" data-config="…"> blocks with a readable static body that the kit brings to life.
const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const KIT_CSS = '<link rel="stylesheet" href="/_kit/site-kit.v2.css">';
const KIT_JS = '<script src="/_kit/site-kit.v1.js" defer></script>';
const NAMES = { token: 'Token', wall: 'Community wall', poll: 'Poll', drop: 'Drop box', event: 'Next event', memes: 'Meme maker', map: 'Map', synth: 'Sound toy', game: 'Mini-game', chart: 'Chart',
  trades: 'Live trades', holders: 'Holders', devwatch: 'Dev watch', fees: 'Fee ledger', alerts: 'Alerts' };
// the holder tools (tools.js TRUST): read from the chain by the live site; title and what each one shows
const TRUST = { trades: ['Every buy and sell', 'Each trade on the bonding curve, decoded from the chain: time, side, SOL, tokens and the wallet, with the dev, top-10 holders and first buys flagged.'],
  holders: ['Who holds it', 'The top 20 holders and their share of the supply, the bonding curve labelled and left out, and how concentrated it is, in plain words.'],
  devwatch: ['Watch the dev', 'The author wallet: the dev buy at launch, what it holds now, and every sale with its time and size.'],
  fees: ['Where the fees go', 'The creator fees of this coin: who gets what, as locked on chain when it launched (SUB-01 keeps 20%), what was paid out and what is waiting.'],
  alerts: ['Alerts', 'Get told when the market cap crosses a line you set, or when the dev sells. Kept in your browser only.'] };
const DASH = '—';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; if (input.length > 256 * 1024) { process.stderr.write('input too large'); process.exit(2); } });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { process.stderr.write('bad json'); process.exit(2); }
  process.stdout.write(render(data));
});

function tool(t, title, body, { wide = false, note = 'Interactive on the live site.' } = {}) {
  return `<section class="tool card reveal${wide ? ' wide' : ''}" id="tool-${esc(t.id)}" data-tool="${esc(t.id)}" data-config="${esc(JSON.stringify(t.config || {}))}">
<header class="tool-h"><span class="eyebrow">${esc(NAMES[t.id] || t.id)}</span><h3>${esc(title)}</h3></header>
<div class="tool-body" data-slot>${body}</div>
<p class="tool-note" data-static>${esc(note)}</p>
</section>`;
}
const stat = (k, label) => `<div class="stat"><span class="stat-k">${esc(label)}</span><span class="stat-v" data-k="${k}">${DASH}</span></div>`;
const link = (l, cls = 'btn') => `<a class="${cls}" href="${esc(l.href)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.label)}</a>`;

function toolHtml(t, spec, context) {
  const c = t.config || {}, tk = context.token || {};
  switch (t.id) {
    case 'token': {
      const head = tk.state === 'pre-launch' ? '<p class="chip">Pre-launch: no token exists yet, so there are no numbers.</p>'
        : tk.state === 'mock' ? '<p class="chip">MOCK launch: rehearsal numbers, no blockchain.</p>' : `<p class="chip ok">Live on ${esc(tk.network || 'Solana')}</p>`;
      const ca = tk.mint ? `<div class="ca"><span class="stat-k">Contract address</span><code data-ca>${esc(tk.mint)}</code></div>` : '';
      return tool(t, `$${spec.ticker} live`, `${head}<div class="stats">${stat('price', 'Price')}${stat('mcap', 'Market cap')}${stat('vol', '24h volume')}${stat('chg', '24h change')}${stat('holders', 'Holders')}</div>
${ca}<div class="spark" data-spark></div><p class="fine" data-k="updated">${tk.state === 'pre-launch' ? 'Numbers appear after the launch.' : 'Numbers load on the live site.'}</p>
${(tk.links || []).length ? `<div class="row">${tk.links.map((l) => link(l, 'btn btn-ghost')).join('')}</div>` : ''}`, { wide: true });
    }
    case 'wall': return tool(t, c.title || 'Wall', `<p>Leave a short note (280 characters)${c.holdersOnly ? ', signed by a wallet that holds the coin' : ''}. Newest first.</p>`);
    case 'poll': return tool(t, c.question || 'Poll', `<ol class="poll-static">${(c.options || []).map((o) => `<li>${esc(o)}</li>`).join('')}</ol><p class="fine">One vote per wallet, signed (a message, never a transaction).${c.holdersOnly ? ' Holders only.' : ''}</p>`);
    case 'drop': return tool(t, c.title || 'Drop box', `<p>${esc(c.prompt)}</p><p class="fine">Submissions stay private. One is featured every day at ${esc(c.revealJst)} JST.</p>`);
    case 'event': {
      const when = c.daily ? `Every day at ${esc(c.daily)} JST` : `${esc(String(c.at || '').replace('T', ' '))} JST`;
      return tool(t, c.title || 'Next event', `<p class="when">${when}</p><div class="count" data-count>${DASH}</div>${c.link ? `<div class="row">${link({ href: c.link, label: 'Event link' }, 'btn btn-ghost')}</div>` : ''}`);
    }
    case 'memes': return tool(t, 'Make a meme', `<img class="meme-logo" src="./logo.png" alt="${esc(spec.name)} logo" width="160" height="160"><p class="fine">The logo plus your text, saved as a PNG. Made in your browser; nothing is uploaded.</p>`);
    case 'map': return tool(t, c.title || 'Map', `<div class="map" data-map></div>${(c.places || []).length ? `<ul class="places">${c.places.map((p) => `<li>${esc(p.name)}</li>`).join('')}</ul>` : ''}<p class="fine">Map data © OpenStreetMap contributors.</p>`, { wide: true });
    case 'synth': return tool(t, c.title || 'Sound toy', `<p>An eight-step loop on the ${esc(c.scale)} scale at ${esc(c.bpm)} BPM. Tap the grid, press play.</p>`);
    case 'game': return tool(t, c.title || 'Mini-game', '<p>Thirty seconds: catch the falling coins, dodge the red ones.</p>', { wide: true });
    case 'trades': case 'holders': case 'devwatch': case 'fees': case 'alerts': {
      const note = tk.state === 'pre-launch' ? 'Goes live at launch: there is no coin on chain yet.' : tk.state === 'mock' ? 'MOCK launch: no blockchain, nothing to read.' : 'Reads the chain on the live site.';
      // the fee ledger of a coin whose split is not locked yet never says "locked"
      const open = t.id === 'fees' && context.launched && context.split && !context.split.locked;
      const text = open ? 'The creator fees of this coin. Its fee split is NOT locked on chain yet: until its author signs step 2, creator fees go to the author\'s own wallet vault.' : TRUST[t.id][1];
      return tool(t, TRUST[t.id][0], `<p>${esc(text)}</p>`, { wide: t.id === 'trades' || t.id === 'holders', note });
    }
    case 'chart': return tool(t, c.title || 'Chart', `<div class="chart" data-chart></div><p class="fine">Price over the last ${c.range === '7d' ? 'week' : 'day'}, from the stored samples. No samples, no line.</p>`, { wide: true });
    default: return '';
  }
}

// The idea app (docs/APP-COMPOSER.md): one <section data-app data-config> holding the validated app spec; the static body
// says in plain words what each block does, the kit (kit/app/*.js) turns it into the working app on the live site.
const BLOCK_NAMES = { submit: 'Form', schedule: 'Schedule', reveal: 'Reveal', vote: 'Vote', collection: 'Archive', card: 'Card', leaderboard: 'Leaderboard', counter: 'Counter', map: 'Map', timer: 'Countdown', note: 'Note', pq: 'Post-quantum registry', launch: 'Launch a coin', tree: 'Family tree' };
const pctOf = (bps) => `${Number(bps) / 100}%`;
function blockStatic(b, app, ctx = {}) {
  switch (b.type) {
    case 'submit': return `<p>${esc(b.prompt)}</p><ul class="app-fields">${b.fields.map((f) => `<li>${esc(f.label)}${f.required ? '' : ' (optional)'}</li>`).join('')}</ul>`;
    case 'schedule': return `<p class="when">${esc(b.label)}</p><div class="count" data-count>${DASH}</div>`;
    case 'reveal': return `<p>At the scheduled moment one ${esc(app.noun.one)} is chosen: ${esc(b.pick.map((x) => ({ owner: "the author's pick", votes: "the holders' votes", random: 'a random draw seeded by a Solana blockhash' }[x])).join(', else '))}.</p>`;
    case 'vote': return `<p>One signed vote per wallet (a message, never a transaction)${b.holdersOnly ? ', holders only' : ''}.</p>`;
    case 'collection': return `<p>${b.show === 'all' ? `Every ${esc(app.noun.one)} people sent` : `Every published ${esc(app.noun.one)}`}, newest first.</p>`;
    case 'card': return `<p>Each ${esc(app.noun.one)} as a ${esc(b.template)} image you can download.</p>`;
    case 'leaderboard': return `<p>${b.of === 'wallets' ? 'Wallets' : 'The ' + esc(app.noun.many)} ranked by ${esc(b.by)}.</p>`;
    case 'counter': return '<p>Live counts.</p>';
    case 'map': return `<div class="map" data-map></div><p class="fine">Map data © OpenStreetMap contributors.</p>`;
    case 'timer': return `<p class="when">${b.daily ? `Every day at ${esc(b.daily)} JST` : `${esc(String(b.at || '').replace('T', ' '))} JST`}</p><div class="count" data-count>${DASH}</div>`;
    case 'note': return `<p>${esc(b.body)}</p>`;
    case 'pq': return '<p>Every step the launchpad took for this coin, signed with ML-DSA-65 (FIPS 204) and checked by your browser.</p>';
    case 'launch': {
      // a family (family.js): from the second generation the grandparent's author gets up to 10% of the creator's share
      const fam = ctx.family || { depth: 0, maxDepth: 5 }, g = fam.depth > 0 ? Math.max(0, Math.min(1000, b.split.creator - 5000)) : 0;
      const kids = b.children === 'launchpads' ? `<p class="fine">Every coin launched here is a launchpad too: its own site launches coins, down to depth ${esc(fam.maxDepth)} of the family (this site is at depth ${esc(fam.depth)}).</p>`
        : b.children === 'choice' ? `<p class="fine">The launcher chooses: a coin, or a launchpad whose own site launches coins too, down to depth ${esc(fam.maxDepth)} of the family (this site is at depth ${esc(fam.depth)}).</p>` : '';
      return `<p>${esc(b.prompt)}</p>${kids}<p class="fine">The coin is created by your own wallet, after you review the transaction. SUB-01 reads every one first. Creator fees, split on-chain and locked: ${esc(pctOf(b.split.creator - g))} to its creator, ${esc(pctOf(b.split.parent))} to this site's author, ${g ? `${esc(pctOf(g))} to the author of the launchpad above this one, ` : ''}${esc(pctOf(b.split.sub01))} to SUB-01.${b.children && b.children !== 'coins' ? ' The fees go to the creators of the launchpads up the family tree, never to buyers or holders.' : ''}</p>`;
    }
    case 'tree': return '<p>The live family tree of this launchpad\'s family: who launched whom, when, at which depth; the fastest-growing branch and the launchpads with the most descendants.</p><p class="fine">Creator fees of every coin born in the family flow up the tree to the creators of the launchpads above it and to SUB-01, split on-chain and locked at launch. Buying or holding a coin pays nobody anything.</p>';
    default: return '';
  }
}
function appHtml(app, index = '01', context = {}) {
  if (!app || !Array.isArray(app.screens)) return '';
  const screens = app.screens.map((s) => `<div class="app-screen" data-screen="${esc(s.id)}"><h3 class="app-screen-h">${esc(s.title)}</h3>
${s.blocks.map((b, i) => `<div class="app-block app-${esc(b.type)}" data-type="${esc(b.type)}" data-i="${i}"><span class="eyebrow">${esc(b.type === 'launch' && b.children === 'launchpads' ? 'Launch a launchpad' : BLOCK_NAMES[b.type] || b.type)}</span>${b.title ? `<h3>${esc(b.title)}</h3>` : ''}<div data-slot>${blockStatic(b, app, context)}</div></div>`).join('\n')}</div>`).join('\n');
  return `<section class="app card reveal" id="app" data-app data-config="${esc(JSON.stringify(app))}" aria-label="The app">
<div class="wrap">
<header class="sect-h app-h"><span class="sect-i">${index} / The app</span><h2>${esc(app.title)}</h2>${app.lede ? `<p class="app-lede sect-lede">${esc(app.lede)}</p>` : ''}</header>
<div class="app-body" data-app-body>${screens}</div>
<p class="tool-note" data-static>Interactive on the live site.</p>
</div>
</section>`;
}


// ---- the page (docs/DESIGN.md): top bar, hero, figures, the app, the other tools, Check the chain, About, footer ----
const blocksOf = (app) => (app && Array.isArray(app.screens) ? app.screens.flatMap((s) => s.blocks || []) : []);
const appLaunches = (app) => blocksOf(app).some((b) => b.type === 'launch');
/** The hero's one action, from the app spec: what a visitor comes to do. */
function ctaOf(app, tools) {
  const blocks = blocksOf(app);
  if (blocks.some((b) => b.type === 'launch')) return blocks.some((b) => b.type === 'launch' && b.children === 'launchpads') ? 'Launch a launchpad' : 'Launch a coin';
  const sub = blocks.find((b) => b.type === 'submit');
  if (sub) return sub.title && [...sub.title].length <= 28 ? sub.title : sub.button || 'Send yours';
  if (blocks.some((b) => b.type === 'vote')) return 'Vote';
  if (blocks.some((b) => b.type === 'pq')) return 'Check the registry';
  if (blocks.length) return 'Open the app';
  const t = tools.find((x) => ['drop', 'wall', 'poll', 'memes', 'map', 'synth', 'game'].includes(x.id));
  return t ? { drop: 'Drop yours', wall: 'Write on the wall', poll: 'Vote in the poll', memes: 'Make a meme', map: 'Open the map', synth: 'Play the sound toy', game: 'Play' }[t.id] : null;
}
/** Name size class: the longest word must fit one line of the hero, the whole name at most three. */
function nameSize(name) {
  const words = String(name).split(/\s+/), lw = Math.max(...words.map((w) => [...w].length)), n = [...String(name)].length;
  const byWord = lw <= 7 ? 0 : lw <= 8 ? 1 : lw <= 10 ? 2 : lw <= 13 ? 3 : 4;
  const byAll = n <= 10 ? 0 : n <= 16 ? 1 : n <= 22 ? 2 : n <= 28 ? 3 : 4;
  return ['', ' len-m', ' len-l', ' len-xl', ' len-xxl'][Math.max(byWord, byAll)];
}

/** The hero's one-line pitch: the tagline, unless it is the template's generic one; then the idea's first sentence. */
const GENERIC_TAGLINE = /^An idea SUB-01 decided to build\b/;
function pitchOf(spec) {
  if (spec.tagline && !GENERIC_TAGLINE.test(spec.tagline)) return spec.tagline;
  const name = String(spec.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let s = (String(spec.description || '').replace(/^concept:\s*/i, '').match(/^[^.!?]+[.!?]?/) || [''])[0].trim();
  s = s.replace(new RegExp(`^${name}\\s*[:\u2013\u2014-]\\s*`, 'i'), '');
  if ([...s].length > 140) s = `${[...s].slice(0, 139).join('').replace(/\s+\S*$/, '')}\u2026`;
  return s ? s[0].toUpperCase() + s.slice(1) : spec.tagline || '';
}

function render({ spec, context }) {
  const all = Array.isArray(spec.tools) ? spec.tools : [];
  const trust = all.filter((t) => TRUST[t.id]), token = all.find((t) => t.id === 'token');
  const tools = all.filter((t) => !TRUST[t.id] && t.id !== 'token');
  const chain = [...(token ? [token] : []), ...trust];
  const tk = context.token || {};
  const bw = context.art === 'bw';
  const mock = context.launched && context.network === 'mock';
  const pump = (tk.links || []).find((l) => /pump\.fun/.test(l.href));
  const app = spec.app && Array.isArray(spec.app.screens) ? spec.app : null;
  const cta = ctaOf(app, tools);
  const target = app ? '#app' : tools.length ? '#tools' : null;
  // sections in order, numbered
  const order = [app && 'app', tools.length && 'tools', chain.length && 'chain', 'about'].filter(Boolean);
  const idx = (k) => String(order.indexOf(k) + 1).padStart(2, '0');
  // a two-step launch whose creator-fee split is not locked yet (site.js siteContext split): never "locked" before it is
  const splitOpen = Boolean(context.launched && context.split && !context.split.locked);
  const splitLine = splitOpen ? (context.split.state === 'mismatch'
    ? 'The creator-fee split on chain is NOT the approved one. SUBZERONE has been alerted.'
    : `Coin created. Step 2: its author locks the creator-fee split (${context.split.text || 'the approved split'}) with one more signature. Until then the fee split is NOT locked.`) : '';
  const splitChip = !splitOpen ? '' : context.split.state === 'mismatch' ? '<span class="state pre">Fee split on chain is NOT the approved one</span>'
    : '<span class="state pre">Coin created · fee split not locked yet</span>';
  const state = mock ? `<span class="state mock">MOCK launch · no blockchain</span>${splitChip}`
    : splitOpen ? splitChip
    : context.launched ? `<span class="state ok">Live on ${context.network === 'mainnet-beta' ? 'Solana' : `Solana ${esc(context.network)}`}</span>`
    : `<span class="state pre">${context.preview ? 'Preview · not launched' : 'Not launched yet'}</span>`;
  const statusLong = mock ? `MOCK launch: rehearsal only, no blockchain, no token exists.${splitOpen ? ` ${esc(splitLine)}` : ''}`
    : splitOpen ? `Created on ${esc(context.network)}. Mint ${esc(context.mint)}, verified by the launchpad. ${esc(splitLine)}`
    : context.launched ? `Launched on ${esc(context.network)}. Mint ${esc(context.mint)}, verified by the launchpad.`
    : context.preview ? 'PREVIEW — not launched. No token exists yet.' : 'Not launched yet. No token exists yet.';
  const ca = tk.mint ? `<div class="ca-chip reveal-hero${mock ? ' mockca' : ''}" data-ca-copy><span class="ca-k">${mock ? 'MOCK' : 'CA'}</span><code data-ca>${esc(tk.mint)}</code></div>` : '';
  const ctaBtn = (cls) => (cta && target ? `<a class="btn btn-primary${cls}" href="${target}">${esc(cta)}</a>` : '');
  const buyBtn = (cls, label) => (pump ? `<a class="btn btn-line${cls}" href="${esc(pump.href)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>` : '');
  const nav = [app && ['#app', 'App'], tools.length && ['#tools', 'Tools'], chain.length && ['#chain', 'Chain'], ['#about', 'About']].filter(Boolean)
    .map(([h, l]) => `<a href="${h}">${l}</a>`).join('');
  const parent = context.parent?.href && context.parent?.name ? `<p class="hero-parent reveal-hero">Launched at <a href="${esc(context.parent.href)}" rel="noopener noreferrer" target="_blank">${esc(context.parent.name)}${context.parent.ticker ? ` ($${esc(context.parent.ticker)})` : ''}</a></p>` : '';
  const figures = token && context.launched ? `<div class="figures" aria-label="Market"><div class="wrap"><dl>
<div><dt>Price</dt><dd data-k="price">${DASH}</dd></div><div><dt>Market cap</dt><dd data-k="mcap">${DASH}</dd></div><div><dt>24h change</dt><dd data-k="chg">${DASH}</dd></div><div><dt>Holders</dt><dd data-k="holders">${DASH}</dd></div>
</dl></div></div>` : '';
  const head = (k, title, lede) => `<header class="sect-h"><span class="sect-i">${idx(k)} / ${esc({ tools: 'On this site', chain: 'Check the chain', about: 'About' }[k])}</span>${title}${lede ? `<p class="sect-lede">${lede}</p>` : ''}</header>`;
  const toolsSec = tools.length ? `<section class="sect" id="tools" aria-label="On this site"><div class="wrap">
${head('tools', '<h2 class="sec">On this site</h2>', '')}
<div class="tools">
${tools.map((t) => toolHtml(t, spec, context)).join('\n')}
</div></div></section>` : '';
  const chainSec = chain.length ? `<section class="sect" id="chain" aria-label="Check the chain"><div class="wrap">
${head('chain', '<h2 class="sec">Check the chain</h2>', 'Every number here is read from Solana or left blank with the reason. Nothing is estimated.')}
<div class="tools trust">
${chain.map((t) => toolHtml(t, spec, context)).join('\n')}
</div></div></section>` : '';
  const sections = (spec.sections || []).filter((s) => s.body && s.body !== spec.disclaimer);
  const usesTx = appLaunches(app);
  const notes = [
    ['Status', statusLong],
    spec.disclaimer && ['What this is', esc(spec.disclaimer)],
    ['The copy', `Written by ${esc(context.generatorLabel)}.`],
    (all.length || app) && ['The tools', usesTx
      ? 'The launch block asks your wallet for a transaction only to create the coin you asked for, after you have reviewed it here; every other tool on this page only reads public chain data and asks for signed messages.'
      : 'The tools on this page only read public chain data and ask for signed messages; they never ask for a transaction.'],
    ['Built by', `SUB-01, a brain simulation, on the SUBZERONE launchpad at <a href="${esc(context.launchpad?.href || 'https://subzerone.live')}" rel="noopener noreferrer" target="_blank">${esc(context.launchpad?.host || 'subzerone.live')}</a>.`],
    ['Idea by', `<code>${esc(context.submitter)}</code>`],
  ].filter(Boolean);
  const aboutSec = `<section class="sect" id="about" aria-label="About"><div class="wrap">
${head('about', '<h2 class="sec">Why SUB-01 built it</h2>', '')}
<div class="about">
${sections.map((s, i) => `<article class="reveal${i === 0 ? ' lead' : ''}"><h3>${esc(s.heading)}</h3><p>${esc(s.body)}</p></article>`).join('\n')}
<ul class="notes" aria-label="Notes">${notes.map(([k, v]) => `<li><b>${esc(k)}</b><span>${v}</span></li>`).join('')}</ul>
</div></div></section>`;
  const links = (context.links || []).map((l) => `<li><a href="${esc(l.href)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.label)}</a></li>`).join('');
  const dock = cta && target ? `<nav class="dock" aria-label="Quick actions">${ctaBtn('')}${buyBtn('', 'Buy')}</nav>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="icon" type="image/png" href="./logo.png"><link rel="apple-touch-icon" href="./logo.png"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(spec.name)} ($${esc(spec.ticker)})</title>
<meta name="description" content="${esc(spec.description)}">
<meta name="theme-color" content="#000000">
<meta name="referrer" content="no-referrer">
${KIT_CSS}
</head><body class="${bw ? 'art-bw' : 'art-classic'}${dock ? ' has-dock' : ''}">
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap top-in">
<a class="brand" href="#top"><img src="./logo.png" alt="" width="28" height="28"><span class="brand-n">${esc(spec.name)}</span><span class="brand-t">$${esc(spec.ticker)}</span></a>
<nav class="top-nav" aria-label="On this page">${nav}</nav>${ctaBtn(' btn-sm top-cta')}
</div></header>
<section class="hero" id="top" aria-label="${esc(spec.name)}">
${bw ? '<img class="hero-art" src="./banner.svg" alt="" width="1536" height="864" fetchpriority="high">' : '<img class="hero-mark" src="./logo.png" alt="" width="512" height="512">'}
<div class="wrap hero-in">
<p class="hero-k reveal-hero"><span class="tk">$${esc(spec.ticker)}</span>${state}</p>
<h1 class="hero-name${nameSize(spec.name)} reveal-hero">${esc(spec.name)}</h1>
<p class="hero-pitch reveal-hero">${esc(pitchOf(spec))}</p>
${cta || pump ? `<div class="hero-cta reveal-hero">${ctaBtn(' btn-lg')}${buyBtn(' btn-lg', 'Buy on pump.fun')}</div>` : ''}
${ca}${parent}${splitOpen ? `<p class="hero-parent reveal-hero" data-split-pending>${esc(splitLine)}${context.split.state !== 'mismatch' && context.launchpad?.href ? ` <a class="btn btn-line" href="${esc(context.launchpad.href)}" rel="noopener noreferrer" target="_blank">Author: lock the fee split</a>` : ''}</p>` : ''}
</div>
</section>
${figures}
<main id="main">
${appHtml(app, idx('app'), context)}
${toolsSec}
${chainSec}
${aboutSec}
</main>
<footer class="foot"><div class="wrap foot-grid">
<div class="foot-mark"><img src="./logo.png" alt="" width="40" height="40"><div>${esc(spec.name)}<br><span>$${esc(spec.ticker)}</span></div></div>
<ul class="foot-links" aria-label="Links">${links}</ul>
<p class="foot-word${nameSize(spec.name)}" aria-hidden="true">${esc(spec.name)}</p>
<div class="foot-credit"><p>Made on the SUBZERONE launchpad at <a href="${esc(context.launchpad?.href || 'https://subzerone.live')}" rel="noopener noreferrer" target="_blank">${esc(context.launchpad?.host || 'subzerone.live')}</a>, built by SUB-01.</p><p>Idea by <code>${esc(context.submitter)}</code>.</p><p>${esc(spec.disclaimer || '')}</p></div>
</div></footer>
${dock}${all.length || app ? KIT_JS : ''}</body></html>`;
}
