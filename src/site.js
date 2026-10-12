// Project websites: versioned specs -> sandboxed build -> validation -> stored HTML. Served on <slug>.<PROJECTS_HOST>
// (a separate origin from the launchpad, so a page there can never read launchpad cookies) with a strict CSP. The only
// script a site runs is the audited site kit served by this app on its own host (docs/SITE-KIT.md); the page itself
// carries none (validateHtml allows exactly the kit's <script src> and <link rel=stylesheet>, nothing else).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { audit, isPaused } from './db.js';
import { validateSpec } from './generator.js';
import { usesTiles, toolOf, OSM_TILES } from './tools.js';
import { id, now, sha256, HttpError, parseJson } from './util.js';
import { Permanent } from './jobs.js';

const CHILD = join(import.meta.dirname, 'site', 'render-child.js');
export const KIT_SCRIPT = '<script src="/_kit/site-kit.v1.js" defer></script>';
export const KIT_STYLE = '<link rel="stylesheet" href="/_kit/site-kit.v1.css">';
/** CSP of a project site. frame-ancestors: the site itself and the launchpad/city origin (the desk computer in a room
 * frames it); nothing else. `scripts`: the public site on its own host (the kit, its vendor modules and its /_api, all
 * 'self'); off for the owner's preview, which is served on the launchpad origin and stays script-free. `tiles`: the
 * map tool's OpenStreetMap tile host, only on a site whose map is on. The caller appends the sandbox flags. */
export const siteCsp = (publicOrigin, { scripts = false, tiles = false } = {}) => [
  "default-src 'none'", ...(scripts ? ["script-src 'self'", "connect-src 'self'"] : []),
  `img-src 'self' data:${scripts ? ' blob:' : ''}${tiles && scripts ? ` ${OSM_TILES}` : ''}`, "style-src 'self' 'unsafe-inline'", "font-src 'self'",
  "base-uri 'none'", "form-action 'none'", `frame-ancestors 'self' ${publicOrigin}`,
].join('; ');
/** The sandbox flags. Public: scripts with the site's own origin (a real origin, so the wallet sees the domain it signs
 * for and the kit's same-origin fetches and canvas work); no forms, no top navigation, no modals. Preview: everything off. */
export const SITE_SANDBOX = { public: 'sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads', preview: 'sandbox' };
export const siteCspFor = (publicOrigin, spec, preview) => `${siteCsp(publicOrigin, { scripts: !preview, tiles: !preview && usesTiles(spec) })}; ${preview ? SITE_SANDBOX.preview : SITE_SANDBOX.public}`;

/** Build in a separate, restricted process. -> html string. */
export function sandboxBuild(input, { timeoutMs = 5000, maxBytes = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${CHILD}`, '--max-old-space-size=64', '--disable-warning=ExperimentalWarning', CHILD], {
      env: {}, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL',
    });
    let out = '', err = '', size = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { size += d.length; if (size > maxBytes) { child.kill('SIGKILL'); err = 'output too large'; } else out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0 && !err) resolve(out);
      else reject(new Error(`site build failed (${signal || `exit ${code}`}): ${String(err).slice(0, 200)}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// checked on markup only (tags and CSS); text content is escaped by the template and may mention anything
const TAG_RULES = [
  [/^<script\b/i, 'script tag'], [/\son[a-z]+\s*=/i, 'inline event handler'], [/javascript:/i, 'javascript: URL'],
  [/^<(iframe|object|embed|form|input|button|base|frame|applet|svg|math)\b/i, 'forbidden element'],
  // <link> only as the favicon (rel icon / apple-touch-icon, href checked below against ./logo.png): no stylesheets, no preload
  [/^<link\b(?!\s+rel=""(?:\s+type="")?\s+href=""\s*\/?>$)/i, 'link element'],
  [/^<meta[^>]+http-equiv/i, 'meta refresh/CSP override'], [/data:text\/html/i, 'html data URL'], [/style\s*=/i, 'inline style attribute'],
];
const CSS_RULES = [[/url\(/i, 'CSS url()'], [/@import/i, 'CSS import'], [/expression\(/i, 'CSS expression'], [/javascript:/i, 'javascript: in CSS']];

/** -> {ok, problems[]}. Every href/src must be one we put there. The kit is allowed as two exact strings only: the
 * stylesheet link once, in the head, and the script once, directly before </body>; any other script or link is refused. */
export function validateHtml(html, allowedUrls) {
  const problems = [];
  if (html.length > 300_000) problems.push('page larger than 300 KB');
  const once = (s) => html.split(s).length - 1;
  if (once(KIT_SCRIPT) > 1 || once(KIT_STYLE) > 1) problems.push('kit included twice');
  let page = html;
  if (once(KIT_STYLE) === 1) {
    const at = page.indexOf(KIT_STYLE), head = page.indexOf('</head>');
    if (head < 0 || at > head) problems.push('kit stylesheet outside the head');
    page = page.replace(KIT_STYLE, '');
  }
  if (once(KIT_SCRIPT) === 1) {
    if (!page.includes(`${KIT_SCRIPT}</body>`)) problems.push('kit script not directly before </body>');
    page = page.replace(`${KIT_SCRIPT}</body>`, '</body>');
  }
  const css = [...page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const markup = page.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
  for (const tag of markup.match(/<[^>]*>?/g) || []) {
    // values are checked separately (URLs against the allowlist); text inside alt/content/title is escaped data
    const shape = tag.replace(/"[^"]*"/g, '""');
    for (const [re, why] of TAG_RULES) if (re.test(shape) && !problems.includes(why)) problems.push(why);
    if (/^<link\b/i.test(tag) && !/\srel="(icon|apple-touch-icon)"/i.test(tag) && !problems.includes('link element')) problems.push('link element');
    for (const m of tag.matchAll(/\b(href|src)\s*=\s*"\s*javascript:/gi)) problems.push(`javascript: URL in ${m[1]}`);
  }
  for (const [re, why] of CSS_RULES) if (re.test(css)) problems.push(why);
  const allowed = new Set(['./logo.png', './banner.svg', ...allowedUrls]);
  for (const tag of markup.match(/<[^>]*>/g) || []) {
    for (const m of tag.matchAll(/\b(href|src)\s*=\s*"([^"]*)"/gi)) {
      const url = m[2].replace(/&amp;/g, '&');
      if (!allowed.has(url)) problems.push(`unexpected ${m[1]}: ${url.slice(0, 80)}`);
    }
    if (/\b(href|src)\s*=\s*[^"\s>]/i.test(tag)) problems.push('unquoted URL attribute');
  }
  return { ok: problems.length === 0, problems };
}

/** The launchpad's host as people read it (city.subzerone.live), and the credit line the banner carries. */
export const launchpadHost = (cfg) => { try { return new URL(cfg.publicOrigin).host; } catch { return 'subzerone.live'; } };
export const bannerCredit = (cfg) => `made on ${launchpadHost(cfg)} · built by SUB-01`;

/** Links the server adds to a site (never submitter-supplied URLs). */
export function siteContext(db, cfg, project, { preview }) {
  const launch = db.get('SELECT * FROM launches WHERE project_id = ?', project.id);
  const x = db.get("SELECT x_handle FROM x_accounts WHERE project_id = ? AND status = 'connected'", project.id);
  const idea = db.get('SELECT owner_wallet FROM ideas WHERE id = ?', project.idea_id);
  const gen = db.get('SELECT generator FROM generations WHERE project_id = ? ORDER BY version DESC LIMIT 1', project.id);
  const launchpad = { href: `${cfg.publicOrigin}/#project/${project.slug}`, host: launchpadHost(cfg) };   // 2026-10-10 the owner: say it was made on the launchpad
  const links = [{ href: launchpad.href, label: `${project.name || 'This project'} on ${launchpad.host}` }];
  if (launch && launch.network === 'mainnet-beta' && launch.provider === 'pumpfun') links.push({ href: `https://pump.fun/coin/${launch.mint}`, label: 'pump.fun' });
  if (launch && launch.provider === 'pumpfun') links.push({ href: `https://solscan.io/token/${launch.mint}${launch.network === 'devnet' ? '?cluster=devnet' : ''}`, label: 'Token on Solscan' });
  if (x?.x_handle) links.push({ href: `https://x.com/${x.x_handle}`, label: `@${x.x_handle} on X` });
  links.push({ href: 'https://subzerone.live', label: 'SUB-01\'s room' });
  const generatorLabel = (gen?.generator || 'template/1').startsWith('anthropic')
    ? `a language model (${gen.generator.split(':')[1]}) from SUB-01's brain record`
    : 'a fixed template (no AI) from SUB-01\'s brain record';
  // the token panel's links (tools.js): server-built from the verified launch, never from the spec
  const token = !launch ? { state: 'pre-launch', mint: null, network: null, links: [] } : {
    state: launch.provider === 'mock' ? 'mock' : 'live', mint: launch.mint, network: launch.network,
    links: launch.provider !== 'pumpfun' ? [] : [
      ...(launch.network === 'mainnet-beta' ? [{ href: `https://pump.fun/coin/${launch.mint}`, label: 'Trade on pump.fun' }] : []),
      { href: `https://solscan.io/token/${launch.mint}${launch.network === 'devnet' ? '?cluster=devnet' : ''}`, label: 'Solscan' },
      ...(launch.network === 'mainnet-beta' ? [{ href: `https://dexscreener.com/solana/${launch.mint}`, label: 'DexScreener' }] : []),
    ] };
  return { preview, launched: Boolean(launch), network: launch?.network, mint: launch?.mint,
    submitter: idea.owner_wallet, generatorLabel, links, launchpad, token };
}

/** Every URL a built page may carry: the server's links, the token panel's, the event tool's (checked by tools.js). */
export const allowedUrls = (context, spec) => [...context.links.map((l) => l.href), ...(context.token?.links || []).map((l) => l.href),
  ...(toolOf(spec, 'event')?.config?.link ? [toolOf(spec, 'event').config.link] : [])];

/** Create site version N+1 from `spec` and build it. Returns the version row. Idempotent on (project, version). */
export async function buildSiteVersion(db, cfg, project, spec, createdBy) {
  if (isPaused(db, 'deployment')) throw new HttpError(503, 'paused', 'site deployment is paused');
  validateSpec(spec);
  const last = db.get('SELECT MAX(version) v FROM site_versions WHERE project_id = ?', project.id);
  const version = (last?.v || 0) + 1;
  const rowId = id('site');
  db.run(`INSERT INTO site_versions (id, project_id, version, spec_json, build_status, created_by, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`, rowId, project.id, version, JSON.stringify(spec), createdBy, now());
  return finishBuild(db, cfg, project, rowId);
}

export async function finishBuild(db, cfg, project, rowId) {
  const row = db.get('SELECT * FROM site_versions WHERE id = ?', rowId);
  if (row.build_status !== 'pending') return row;
  const spec = parseJson(row.spec_json);
  const context = siteContext(db, cfg, project, { preview: !db.get('SELECT 1 FROM launches WHERE project_id = ?', project.id) });
  let html;
  try {
    html = await sandboxBuild({ spec, context });
  } catch (e) {
    db.run(`UPDATE site_versions SET build_status = 'failed', build_report = ? WHERE id = ?`, e.message, rowId);
    throw e;
  }
  const check = validateHtml(html, allowedUrls(context, spec));
  if (!check.ok) {
    db.run(`UPDATE site_versions SET build_status = 'rejected', build_report = ? WHERE id = ?`, JSON.stringify(check.problems), rowId);
    audit(db, { actor: 'system', kind: 'site', projectId: project.id, ideaId: project.idea_id,
      message: `Site version ${row.version} rejected by the safety check`, data: check.problems });
    throw new Permanent(`site rejected: ${check.problems.join('; ')}`);
  }
  db.run(`UPDATE site_versions SET build_status = 'ok', html = ?, sha256 = ?, build_report = 'passed' WHERE id = ?`, html, sha256(html), rowId);
  audit(db, { actor: 'system', kind: 'site', projectId: project.id, ideaId: project.idea_id, isPublic: true,
    message: `Website version ${row.version} built and checked` });
  return db.get('SELECT * FROM site_versions WHERE id = ?', rowId);
}

/** Point the project subdomain at a built version (also rollback). */
export function setLiveVersion(db, project, version, actor) {
  const v = db.get(`SELECT version FROM site_versions WHERE project_id = ? AND version = ? AND build_status = 'ok'`, project.id, version);
  if (!v) throw new HttpError(404, 'no_such_version', 'that version did not build');
  db.run('UPDATE projects SET live_site_version = ?, updated_at = ? WHERE id = ?', version, now(), project.id);
  audit(db, { actor, kind: 'site', projectId: project.id, ideaId: project.idea_id, isPublic: true,
    message: `Website now serves version ${version}` });
}
