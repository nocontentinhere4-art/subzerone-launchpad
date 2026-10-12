// Sandboxed site build: runs as a separate Node process with the permission model on (no filesystem writes, no child
// processes, no workers, no addons), an empty environment (no secrets), a 64 MB heap and a wall-clock limit set by the
// parent. Input: {spec, context} JSON on stdin. Output: one static HTML page on stdout. No network access is used and
// none is needed. Self-contained on purpose: it may read only this file.
// The page carries no script of its own. Its one script is the audited kit (/_kit/site-kit.v1.js) and its one
// stylesheet the kit's (/_kit/site-kit.v1.css), both exact strings site.js validateHtml allows; the tools are
// <section data-tool="…" data-config="…"> blocks with a readable static body that the kit brings to life.
const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const color = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(String(c)) ? c : d);
const KIT_CSS = '<link rel="stylesheet" href="/_kit/site-kit.v1.css">';
const KIT_JS = '<script src="/_kit/site-kit.v1.js" defer></script>';
const NAMES = { token: 'Token', wall: 'Community wall', poll: 'Poll', drop: 'Drop box', event: 'Next event', memes: 'Meme maker', map: 'Map', synth: 'Sound toy', game: 'Mini-game', chart: 'Chart' };
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
    case 'chart': return tool(t, c.title || 'Chart', `<div class="chart" data-chart></div><p class="fine">Price over the last ${c.range === '7d' ? 'week' : 'day'}, from the stored samples. No samples, no line.</p>`, { wide: true });
    default: return '';
  }
}

// The idea app (docs/APP-COMPOSER.md): one <section data-app data-config> holding the validated app spec; the static body
// says in plain words what each block does, the kit (kit/app/*.js) turns it into the working app on the live site.
const BLOCK_NAMES = { submit: 'Form', schedule: 'Schedule', reveal: 'Reveal', vote: 'Vote', collection: 'Archive', card: 'Card', leaderboard: 'Leaderboard', counter: 'Counter', map: 'Map', timer: 'Countdown', note: 'Note', pq: 'Post-quantum registry' };
function blockStatic(b, app) {
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
    default: return '';
  }
}
function appHtml(app) {
  if (!app || !Array.isArray(app.screens)) return '';
  const screens = app.screens.map((s) => `<div class="app-screen" data-screen="${esc(s.id)}"><h4 class="app-screen-h">${esc(s.title)}</h4>
${s.blocks.map((b, i) => `<div class="app-block app-${esc(b.type)}" data-type="${esc(b.type)}" data-i="${i}"><span class="eyebrow">${esc(BLOCK_NAMES[b.type] || b.type)}</span>${b.title ? `<h3>${esc(b.title)}</h3>` : ''}<div data-slot>${blockStatic(b, app)}</div></div>`).join('\n')}</div>`).join('\n');
  return `<section class="app card reveal" id="app" data-app data-config="${esc(JSON.stringify(app))}">
<header class="app-h"><span class="eyebrow">The app</span><h2>${esc(app.title)}</h2>${app.lede ? `<p class="app-lede">${esc(app.lede)}</p>` : ''}</header>
<div class="app-body" data-app-body>${screens}</div>
<p class="tool-note" data-static>Interactive on the live site.</p>
</section>`;
}

function render({ spec, context }) {
  const p = spec.palette || {};
  const accent = color(p.accent, '#fb752b'), second = color(p.second, '#ff9a3c');
  const tools = Array.isArray(spec.tools) ? spec.tools : [];
  const tk = context.token || {};
  const links = (context.links || []).map((l) => link(l, 'btn')).join('');
  const sections = spec.sections.map((s, i) => `<article class="card reveal${i === 0 ? ' big' : ''}"><h2>${esc(s.heading)}</h2><p>${esc(s.body)}</p></article>`).join('\n');
  const status = context.launched && context.network === 'mock'
    ? '<p class="chip">MOCK launch: rehearsal only, no blockchain, no token exists</p>'
    : context.launched
    ? `<p class="chip ok">Launched on ${esc(context.network)} · mint <code>${esc(context.mint)}</code></p>`
    : `<p class="chip">${esc(context.preview ? 'PREVIEW — not launched' : 'Not launched yet')}</p>`;
  // the ticker strip: the CA and the numbers, twice (the CSS marquee scrolls one copy out as the other comes in)
  const strip = `<span>$${esc(spec.ticker)}</span><span>CA <b data-ca-short>${esc(tk.mint ? `${tk.mint.slice(0, 6)}…${tk.mint.slice(-6)}` : 'pre-launch')}</b></span><span>Price <b data-k="price">${DASH}</b></span><span>MC <b data-k="mcap">${DASH}</b></span><span>Holders <b data-k="holders">${DASH}</b></span><span>Built by SUB-01</span>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="icon" type="image/png" href="./logo.png"><link rel="apple-touch-icon" href="./logo.png"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.name)} ($${esc(spec.ticker)})</title>
<meta name="description" content="${esc(spec.description)}">
<meta name="referrer" content="no-referrer">
${KIT_CSS}
<style>
:root{--ac:${accent};--ac2:${second}}
</style></head><body>
<div class="hero"><img class="banner" src="./banner.svg" alt=""><div class="hero-glow"></div></div>
<main>
<header class="head reveal-hero"><img class="logo" src="./logo.png" alt="${esc(spec.name)} logo"><div><h1 class="grad">${esc(spec.name)}</h1><span class="tk">$${esc(spec.ticker)}</span></div></header>
<p class="tag reveal-hero">${esc(spec.tagline)}</p>
<div class="reveal-hero">${status}</div>
${tools.some((t) => t.id === 'token') ? `<div class="marquee" aria-hidden="true"><div class="marquee-track">${strip}${strip}</div></div>` : ''}
${appHtml(spec.app)}
<div class="bento">
${sections}
</div>
${tools.length ? `<h2 class="sec">On this site</h2>\n<div class="tools">\n${tools.map((t) => toolHtml(t, spec, context)).join('\n')}\n</div>` : ''}
<nav>${links}</nav>
<footer>Idea by <code>${esc(context.submitter)}</code>. Made on the SUBZERONE launchpad at <a href="${esc(context.launchpad?.href || 'https://subzerone.live')}" rel="noopener noreferrer" target="_blank">${esc(context.launchpad?.host || 'subzerone.live')}</a>
and built by SUB-01, a brain simulation; the copy on this page was written by ${esc(context.generatorLabel)}. ${esc(spec.disclaimer || '')}${tools.length || spec.app ? ' The tools on this page only read public chain data and ask for signed messages; they never ask for a transaction.' : ''}</footer>
</main>${tools.length || spec.app ? KIT_JS : ''}</body></html>`;
}
