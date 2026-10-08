// Project websites: versioned specs -> sandboxed build -> validation -> stored HTML. Served on <slug>.<PROJECTS_HOST>
// (a separate origin from the launchpad, so a page there can never read launchpad cookies) with a strict CSP that
// allows no scripts at all.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { audit, isPaused } from './db.js';
import { validateSpec } from './generator.js';
import { id, now, sha256, HttpError, parseJson } from './util.js';
import { Permanent } from './jobs.js';

const CHILD = join(import.meta.dirname, 'site', 'render-child.js');
export const SITE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

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
  [/^<(iframe|object|embed|form|input|button|link|base|frame|applet|svg|math)\b/i, 'forbidden element'],
  [/^<meta[^>]+http-equiv/i, 'meta refresh/CSP override'], [/data:text\/html/i, 'html data URL'], [/style\s*=/i, 'inline style attribute'],
];
const CSS_RULES = [[/url\(/i, 'CSS url()'], [/@import/i, 'CSS import'], [/expression\(/i, 'CSS expression'], [/javascript:/i, 'javascript: in CSS']];

/** -> {ok, problems[]}. Every href/src must be one we put there. */
export function validateHtml(html, allowedUrls) {
  const problems = [];
  if (html.length > 300_000) problems.push('page larger than 300 KB');
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const markup = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
  for (const tag of markup.match(/<[^>]*>?/g) || []) {
    // values are checked separately (URLs against the allowlist); text inside alt/content/title is escaped data
    const shape = tag.replace(/"[^"]*"/g, '""');
    for (const [re, why] of TAG_RULES) if (re.test(shape) && !problems.includes(why)) problems.push(why);
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

/** Links the server adds to a site (never submitter-supplied URLs). */
export function siteContext(db, cfg, project, { preview }) {
  const launch = db.get('SELECT * FROM launches WHERE project_id = ?', project.id);
  const x = db.get("SELECT x_handle FROM x_accounts WHERE project_id = ? AND status = 'connected'", project.id);
  const idea = db.get('SELECT owner_wallet FROM ideas WHERE id = ?', project.idea_id);
  const gen = db.get('SELECT generator FROM generations WHERE project_id = ? ORDER BY version DESC LIMIT 1', project.id);
  const links = [{ href: `${cfg.publicOrigin}/projects/${project.slug}`, label: 'Project on the SUBZERONE launchpad' }];
  if (launch && launch.network === 'mainnet-beta' && launch.provider === 'pumpfun') links.push({ href: `https://pump.fun/coin/${launch.mint}`, label: 'pump.fun' });
  if (launch && launch.provider === 'pumpfun') links.push({ href: `https://solscan.io/token/${launch.mint}${launch.network === 'devnet' ? '?cluster=devnet' : ''}`, label: 'Token on Solscan' });
  if (x?.x_handle) links.push({ href: `https://x.com/${x.x_handle}`, label: `@${x.x_handle} on X` });
  links.push({ href: 'https://subzerone.live', label: 'SUB-01\'s room' });
  const generatorLabel = (gen?.generator || 'template/1').startsWith('anthropic')
    ? `a language model (${gen.generator.split(':')[1]}) from SUB-01's brain record`
    : 'a fixed template (no AI) from SUB-01\'s brain record';
  return { preview, launched: Boolean(launch), network: launch?.network, mint: launch?.mint,
    submitter: idea.owner_wallet, generatorLabel, links };
}

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
  const check = validateHtml(html, context.links.map((l) => l.href));
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
