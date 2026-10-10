// Sandboxed site build: runs as a separate Node process with the permission model on (no filesystem writes, no child
// processes, no workers, no addons), an empty environment (no secrets), a 64 MB heap and a wall-clock limit set by the
// parent. Input: {spec, context} JSON on stdin. Output: one static HTML page on stdout. No network access is used and
// none is needed. Self-contained on purpose: it may read only this file.
const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const color = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(String(c)) ? c : d);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; if (input.length > 256 * 1024) { process.stderr.write('input too large'); process.exit(2); } });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { process.stderr.write('bad json'); process.exit(2); }
  const { spec, context } = data;
  const p = spec.palette || {};
  const accent = color(p.accent, '#ff6a00'), second = color(p.second, '#ff9a3c');
  const links = (context.links || []).map((l) => `<a href="${esc(l.href)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.label)}</a>`).join('');
  const sections = spec.sections.map((s) => `<section><h2>${esc(s.heading)}</h2><p>${esc(s.body)}</p></section>`).join('\n');
  const status = context.launched && context.network === 'mock'
    ? '<p class="chip">MOCK launch: rehearsal only, no blockchain, no token exists</p>'
    : context.launched
    ? `<p class="chip ok">Launched on ${esc(context.network)} · mint <code>${esc(context.mint)}</code></p>`
    : `<p class="chip">${esc(context.preview ? 'PREVIEW — not launched' : 'Not launched yet')}</p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="icon" type="image/png" href="./logo.png"><link rel="apple-touch-icon" href="./logo.png"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.name)} ($${esc(spec.ticker)})</title>
<meta name="description" content="${esc(spec.description)}">
<meta name="referrer" content="no-referrer">
<style>
:root{--bg:#08080b;--fg:#ececf2;--dim:#8f8fa3;--line:rgba(255,255,255,.1);--ac:${accent};--ac2:${second}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.banner{width:100%;aspect-ratio:3/1;object-fit:cover;display:block;border-bottom:1px solid var(--line)}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;gap:20px;align-items:center;margin-top:-72px}
header img{width:120px;height:120px;border-radius:50%;border:3px solid var(--bg);background:var(--bg)}
h1{margin:52px 0 0;font-size:clamp(28px,6vw,44px);line-height:1.1}
.tk{display:inline-block;background:var(--ac);color:#0a0a0a;padding:2px 10px;letter-spacing:.12em;font-size:14px;margin-top:8px}
.tag{color:var(--dim);margin:20px 0}
h2{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--ac);margin:36px 0 8px}
p{margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.chip{display:inline-block;border:1px solid var(--line);padding:4px 10px;font-size:12px;color:var(--dim)}.chip.ok{border-color:var(--ac);color:var(--fg)}
nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}nav a{color:var(--fg);border:1px solid var(--line);padding:8px 12px;text-decoration:none}nav a:hover{border-color:var(--ac)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
code{overflow-wrap:anywhere}
</style></head><body>
<img class="banner" src="./banner.svg" alt="">
<main>
<header><img src="./logo.png" alt="${esc(spec.name)} logo"><div><h1>${esc(spec.name)}</h1><span class="tk">$${esc(spec.ticker)}</span></div></header>
<p class="tag">${esc(spec.tagline)}</p>
${status}
${sections}
<nav>${links}</nav>
<footer>Idea by <code>${esc(context.submitter)}</code>. Made on the SUBZERONE launchpad at <a href="${esc(context.launchpad?.href || 'https://subzerone.live')}" rel="noopener noreferrer" target="_blank">${esc(context.launchpad?.host || 'subzerone.live')}</a>
and built by SUB-01, a brain simulation; the copy on this page was written by ${esc(context.generatorLabel)}. ${esc(spec.disclaimer || '')}</footer>
</main></body></html>`;
  process.stdout.write(html);
});
