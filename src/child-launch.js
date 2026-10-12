// Child launches (docs/APP-COMPOSER.md, "The launch block"): a coin site whose app has a `launch` block lets visitors
// create REAL coins there. Nothing here is a second launch path: a child coin is an ordinary SUBZERONE idea + project
// (its own building, its own site, SUB-01's vote first) that goes through the same launch machinery (launch.js
// createIntent / refreshIntent / submitSigned / confirmIntent, the pump.fun provider's Phantom-safe layout, the two-step
// dev buy, the simulation checks). What is new:
//   - the project host's /_api/launch* (no sessions there): the visitor's wallet signs ONE message that states the coin,
//     the image hash, the dev buy and the exact fee split; the page then holds a launch key (only its hash is stored)
//     for the transaction steps, which the wallet signs itself anyway;
//   - the split comes from the parent's launch block: creator (the visitor) / the parent's author / SUB-01, locked
//     on-chain by the existing fee-sharing config (launch.js CHILD_SPLIT_POLICY: SUB-01 >= 20%, creator >= 50%);
//   - the job child_build: when SUB-01 votes build, the project is made from what the visitor signed (their name,
//     ticker, description, image; a template site, no language model), its allocation is the signed one, and the
//     launch configuration is prepared right away (the visitor's signed message is their approval);
//   - every child launch is signed into the parent's post-quantum registry (pq.js events, kind child.launch).
import { timingSafeEqual } from 'node:crypto';
import { audit, isPaused } from './db.js';
import { Defer, Permanent, enqueue } from './jobs.js';
import { transition, note, LABELS } from './states.js';
import { moderateText } from './chat.js';
import { submitIdea, sniffImage, currentVersion } from './ideas.js';
import { getProvider, allocationStatement, feeMode, validateRecipients, CHILD_SPLIT_POLICY, requireSub01Wallet, parseInitialBuySol,
  maxInitialBuyLamports, createIntent, refreshIntent, submitSigned, abandonIntent, createDevBuy, refreshDevBuy, submitDevBuy, abandonDevBuy,
  skipDevBuy, devBuyView, solString, SUB01_LABEL, LAUNCH_COST_RESERVE_LAMPORTS } from './launch.js';
import { blockOf } from './app-blocks.js';
import { liveSpec, issue, consume, ipHash } from './tool-api.js';
import { publicStats } from './coin-stats.js';
import { PLOT_IDS, RESERVED_PLOTS } from './world.js';
import { mockSigningText } from './launch/mock.js';
import { HttpError, id, now, parseJson, sha256, token } from './util.js';

export const LIMITS = Object.freeze({ name: [2, 32], ticker: [2, 10], description: [20, 500], perIpDay: 5, perParentDay: 200, list: 24, bodyBytes: 2_200_000 });
const LAUNCH_STATES = ['launch_prepared', 'awaiting_signature', 'confirming', 'launched'];
const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

/** The parent's launch block, from its LIVE spec (the server's truth, never the page's copy), or 404. */
export function launchBlockOf(db, parent) {
  const spec = liveSpec(db, parent);
  const b = blockOf(spec?.app, 'launch');
  if (!b) throw new HttpError(404, 'launch_off', 'this site does not launch coins');
  if (parent.parent_project_id) throw new HttpError(404, 'launch_off', 'a coin launched from another site does not launch coins itself');
  return { spec, block: b };
}
const parentLaunched = (db, parent) => db.get('SELECT 1 FROM launches WHERE project_id = ?', parent.id);

/**
 * The exact split of a coin launched from `parent` by `wallet`: creator / the parent's author (its receiving wallet) /
 * SUB-01, the bps from the launch block. When two rows are the same wallet they merge (the author launching on their
 * own site keeps both shares; an author whose wallet is SUB-01's gives that share to SUB-01's row). Validated with
 * CHILD_SPLIT_POLICY, the same check buildLaunchConfig repeats before the transaction exists.
 */
export function splitFor(db, cfg, parent, block, wallet) {
  const sub01 = requireSub01Wallet(cfg);
  if (wallet === sub01) throw new HttpError(400, 'bad_wallet', 'that is SUB-01\'s own wallet; launch with yours');
  const author = currentVersion(db, parent.idea_id).receiving_wallet;
  const s = block.split;
  let rows = [{ label: 'Creator', wallet, bps: s.creator, role: 'submitter' }];
  const sub = { label: SUB01_LABEL, wallet: sub01, bps: s.sub01, role: 'sub01' };
  if (s.parent > 0) {
    if (author === wallet) rows[0].bps += s.parent;
    else if (author === sub01) sub.bps += s.parent;
    else rows.push({ label: clip(`Author of ${parent.name}`, 40), wallet: author, bps: s.parent, role: 'parent' });
  }
  rows.push(sub);
  rows = validateRecipients(cfg, rows, wallet, CHILD_SPLIT_POLICY);
  return { recipients: rows, statement: allocationStatement(rows, feeMode(rows, wallet)) };
}

/** The visitor's fields, normalised exactly as stored (and as hashed into the signed message). */
export function coinFields(cfg, b) {
  const name = moderateText(b.name, { max: LIMITS.name[1], where: 'in a coin name' });
  if ([...name].length < LIMITS.name[0]) throw new HttpError(400, 'bad_name', `name: ${LIMITS.name.join('–')} characters`);
  const ticker = String(b.ticker ?? '').trim().replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(ticker)) throw new HttpError(400, 'bad_ticker', 'ticker: 2–10 letters or digits');
  if (ticker === 'SUB01') throw new HttpError(400, 'bad_ticker', 'SUB01 is SUB-01\'s own token');
  const description = moderateText(b.description, { max: LIMITS.description[1], where: 'in a coin description' });
  if ([...description].length < LIMITS.description[0]) throw new HttpError(400, 'bad_description', `description: at least ${LIMITS.description[0]} characters (SUB-01 reads it)`);
  const initialBuyLamports = b.devBuySol == null || b.devBuySol === '' ? 0 : parseInitialBuySol(cfg, b.devBuySol);
  return { name, ticker, description, initialBuyLamports };
}

const payloadOf = (parent, f, imageSha256, recipients) => ({ parent: parent.slug, name: f.name, ticker: f.ticker, description: f.description, imageSha256,
  initialBuyLamports: f.initialBuyLamports, recipients: recipients.map(({ wallet, bps, role }) => ({ wallet, bps, role })) });

function summaryOf(parent, f, imageSha256, recipients, provider) {
  const who = { submitter: 'you, the creator', parent: `${parent.name}'s author`, sub01: 'SUB-01' };
  return [
    `Launch a coin from ${parent.name} ($${parent.ticker}): "${f.name}" ($${f.ticker}), on ${provider.isMock ? 'the MOCK provider (no blockchain)' : `pump.fun, Solana ${provider.network}`}.`,
    `Image sha256: ${imageSha256}`,
    `Creator fees, split on-chain and locked at launch: ${recipients.map((r) => `${pct(r.bps)} to ${who[r.role]} (${r.wallet})`).join('; ')}.`,
    f.initialBuyLamports > 0 ? `Dev buy: ${solString(f.initialBuyLamports)} SOL of your own coin, a separate signature after the launch.` : 'Dev buy: none.',
    'SUB-01 reads it first. If he builds it you review the launch transaction and sign it; this message creates and pays nothing. The coin, its name, image and description are public.',
  ].join('\n');
}

/** A free plot for the child's building: the parent's district first, then the next districts in city order. */
function freePlot(db, parent) {
  const taken = new Set(db.all('SELECT plot_id FROM plots').map((r) => r.plot_id));
  const home = db.get('SELECT plot_id FROM plots WHERE idea_id = ?', parent.idea_id)?.plot_id;
  const at = home ? Math.max(0, PLOT_IDS.indexOf(home) - (Number(home.split('-').pop()) - 1)) : 0;
  const order = [...PLOT_IDS.slice(at), ...PLOT_IDS.slice(0, at)];
  return order.find((p) => !taken.has(p) && !RESERVED_PLOTS.has(p)) || null;
}

const keyMatches = (row, key) => {
  if (typeof key !== 'string' || key.length < 20 || key.length > 100) return false;
  const a = Buffer.from(sha256(key)), b = Buffer.from(row.key_hash);
  return a.length === b.length && timingSafeEqual(a, b);
};

// --- reading ---------------------------------------------------------------------------------------------------------
const siteUrlOf = (cfg, slug) => `${cfg.projectsScheme}://${slug}.${cfg.projectsHost}/`;

/** The parent's side: the split it offers, its numbers, the coins launched here. */
export function parentView(db, cfg, parent, block, { before } = {}) {
  const provider = getProvider(cfg, db);
  const author = currentVersion(db, parent.idea_id).receiving_wallet;
  const kids = db.all(`SELECT p.id, p.slug, p.name, p.ticker, l.mint, l.network, l.provider, l.verified_at, cs.json cs_json,
      (SELECT MAX(version) FROM assets a WHERE a.project_id = p.id AND a.kind = 'logo') logo_v
    FROM projects p JOIN launches l ON l.project_id = p.id LEFT JOIN coin_stats cs ON cs.mint = l.mint
    WHERE p.parent_project_id = ? ${Number.isFinite(before) ? 'AND l.verified_at < ?' : ''} ORDER BY l.verified_at DESC LIMIT ?`,
  parent.id, ...(Number.isFinite(before) ? [before] : []), LIMITS.list);
  const all = db.all(`SELECT i.status, cs.json cs_json FROM child_launches c JOIN ideas i ON i.id = c.idea_id
    LEFT JOIN projects p ON p.idea_id = i.id LEFT JOIN launches l ON l.project_id = p.id LEFT JOIN coin_stats cs ON cs.mint = l.mint
    WHERE c.parent_project_id = ?`, parent.id);
  const stats = all.filter((r) => r.status === 'launched').map((r) => publicStats(parseJson(r.cs_json)));
  const total = (k) => (stats.some((s) => typeof s[k] === 'number') ? stats.reduce((a, s) => a + (typeof s[k] === 'number' ? s[k] : 0), 0) : null);
  return {
    title: block.title, prompt: block.prompt, split: block.split, devBuy: block.devBuy,
    maxDevBuySol: block.devBuy ? maxInitialBuyLamports(cfg) / 1e9 : 0, minDescription: LIMITS.description[0],
    authorWallet: author, sub01Wallet: cfg.sub01FeeWallet || null,
    provider: provider ? { name: provider.name, network: provider.network, mock: provider.isMock, label: provider.label } : null,
    open: Boolean(provider && cfg.sub01FeeWallet && !isPaused(db, 'launch') && !isPaused(db, 'submissions') && parentLaunched(db, parent)),
    pausedNote: isPaused(db, 'launch') || isPaused(db, 'submissions') ? 'Launches are paused right now.' : !provider ? 'Launching is switched off on this server.'
      : !parentLaunched(db, parent) ? `Launches open once ${parent.name} itself is launched.` : null,
    parentLaunched: Boolean(parentLaunched(db, parent)),
    counts: { launched: all.filter((r) => r.status === 'launched').length, inProgress: all.filter((r) => !['launched', 'declined', 'cancelled', 'failed'].includes(r.status)).length,
      passed: all.filter((r) => r.status === 'declined').length, volume24hUsd: total('volume24hUsd'), marketCapUsd: total('marketCapUsd') },
    children: kids.map((k) => { const s = publicStats(parseJson(k.cs_json)); return { name: k.name, ticker: k.ticker, slug: k.slug, siteUrl: siteUrlOf(cfg, k.slug),
      mint: k.mint, network: k.network, mock: k.provider === 'mock', launchedAt: k.verified_at, logoUrl: k.logo_v ? `/_api/launch/logo/${k.slug}` : null,
      marketCapUsd: s.marketCapUsd, volume24hUsd: s.volume24hUsd }; }),
    next: kids.length === LIMITS.list ? kids[kids.length - 1].verified_at : null,
    pq: Boolean(blockOf(liveSpec(db, parent)?.app, 'pq')),
  };
}

/** One child launch as its page shows it (public: the coin is public from the start). */
export function childView(db, cfg, cl) {
  const provider = getProvider(cfg, db);
  const idea = db.get('SELECT status, status_note, updated_at FROM ideas WHERE id = ?', cl.idea_id);
  const p = db.get('SELECT * FROM projects WHERE idea_id = ?', cl.idea_id);
  const ev = db.get('SELECT decision, feedback_json, brain_json, latency_ms, created_at FROM evaluations WHERE idea_id = ? ORDER BY idea_version DESC LIMIT 1', cl.idea_id);
  const launch = p ? db.get('SELECT * FROM launches WHERE project_id = ?', p.id) : null;
  const intent = p ? db.get('SELECT status, mint, tx_signature, error, network FROM launch_intents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', p.id) : null;
  const config = p && LAUNCH_STATES.includes(idea.status) ? parseJson(p.launch_config_json) || (intent ? parseJson(db.get('SELECT config_json FROM launch_intents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', p.id).config_json) : null) : null;
  const build = parseJson(ev?.brain_json)?.vote?.options?.find((o) => String(o.label).startsWith('build'));
  const fb = parseJson(ev?.feedback_json, null);
  const pqSeq = p ? db.get(`SELECT seq FROM pq_entries WHERE project_id = ? AND kind = 'child.launch' AND ref = ?`, cl.parent_project_id, p.id)?.seq ?? null : null;
  return {
    id: cl.id, status: idea.status, stageLabel: LABELS[idea.status] || idea.status, note: idea.status_note, updatedAt: idea.updated_at,
    coin: { name: cl.name, ticker: cl.ticker, description: cl.description, imageUrl: `/_api/launch/${cl.id}/image`, imageSha256: cl.image_sha256 },
    wallet: cl.wallet, recipients: parseJson(cl.recipients_json, []), statement: cl.statement, initialBuyLamports: cl.initial_buy_lamports,
    verdict: ev ? { verdict: ev.decision === 'selected' ? 'build' : 'pass', buildPct: build ? Math.round(build.p * 100) : null, latencyMs: ev.latency_ms ?? null,
      summary: fb?.summary ?? null, likes: fb?.likes ?? [], dislikes: fb?.dislikes ?? [], suggestions: fb?.suggestions ?? [] } : null,
    project: p ? { slug: p.slug, siteUrl: p.live_site_version ? siteUrlOf(cfg, p.slug) : null, cityUrl: `${cfg.publicOrigin}/#project/${p.slug}` } : null,
    config: config ? { version: config.version, network: config.network, providerLabel: config.providerLabel, mock: config.mock, configHash: p.launch_config_hash,
      token: { name: config.token?.name, symbol: config.token?.symbol, uri: config.token?.uri, decimals: config.token?.decimals, totalSupplyBase: config.token?.totalSupplyBase },
      recipients: config.feeSharing?.recipients, locked: config.feeSharing?.locked, initialBuyLamports: config.initialBuyLamports, devBuyMode: config.devBuyMode,
      tradingFees: config.tradingFees, irreversible: config.irreversible } : null,
    intent: intent ? { status: intent.status, mint: intent.mint, signature: intent.tx_signature, error: intent.error ? intent.error.replace(/ \[final\]$/, '') : null,
      explorerTx: intent.tx_signature && provider?.explorerTx ? provider.explorerTx(intent.tx_signature) : null } : null,
    launch: launch ? { mint: launch.mint, network: launch.network, provider: launch.provider, signature: launch.tx_signature, verifiedAt: launch.verified_at,
      checks: (parseJson(launch.verification, []) || []).length, explorerTx: provider?.explorerTx?.(launch.tx_signature) ?? null, explorerToken: provider?.explorerToken?.(launch.mint) ?? null } : null,
    devBuy: launch && p ? devBuyView(db, provider, p) : null,
    registry: pqSeq != null ? { project: db.get('SELECT slug FROM projects WHERE id = ?', cl.parent_project_id).slug, seq: pqSeq } : null,
  };
}

// --- the child's project (job child_build, after SUB-01 votes build) -----------------------------------------------------
export async function childBuild(ctx) {
  const { db, cfg } = ctx;
  const ideaId = ctx.job.idea_id;
  const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
  if (!idea || !['selected', 'generating'].includes(idea.status)) return { skipped: `idea is ${idea?.status}` };
  const cl = db.get('SELECT * FROM child_launches WHERE idea_id = ?', ideaId);
  if (!cl) throw new Permanent('not a child launch');
  if (isPaused(db, 'generation')) throw new Defer('generation paused by an admin', 10 * 60_000);
  const parent = db.get('SELECT * FROM projects WHERE id = ?', cl.parent_project_id);
  if (idea.status === 'selected') transition(db, ideaId, 'selected', 'generating', { actor: 'system', note: `SUB-01 builds its site; the coin is launched from ${parent.name}` });
  const { templateGenerate, chooseTools, validateSpec, brainNote } = await import('./generator.js');
  const { composeRules, toolsBeside } = await import('./composer.js');
  const { bannerSvg } = await import('./art.js');
  const { bannerCredit, buildSiteVersion } = await import('./site.js');
  const { publishSite } = await import('./site-qa.js');
  const { uniqueSlug } = await import('./pipeline.js');
  const v = currentVersion(db, ideaId);
  const evaluation = db.get(`SELECT * FROM evaluations WHERE idea_id = ? AND decision = 'selected' ORDER BY created_at DESC LIMIT 1`, ideaId);
  const brain = parseJson(evaluation.brain_json, {});
  const recipients = parseJson(cl.recipients_json, []);
  ctx.progress('writing the coin page from what its creator signed');
  // the template only (no language model): the visitor's own words, nothing invented, no cost
  const base = templateGenerate({ idea: v, brain }).spec;
  const split = recipients.map((r) => `${pct(r.bps)} ${r.role === 'submitter' ? 'to its creator' : r.role === 'parent' ? `to ${parent.name}'s author` : 'to SUB-01'}`).join(', ');
  const spec = { ...base, name: cl.name, ticker: cl.ticker, description: cl.description,
    tagline: clip(`Launched at ${parent.name}. SUB-01 voted to build it.`, 90),
    sections: [{ heading: 'The coin', body: cl.description }, { heading: 'Why SUB-01 built it', body: clip(brainNote(brain), 700) },
      { heading: `Launched at ${clip(parent.name, 40)}`, body: clip(`Its creator launched it from ${parent.name} ($${parent.ticker}), a SUBZERONE coin whose site launches coins. The creator fees are split on-chain and locked: ${split}.`, 700) },
      base.sections[base.sections.length - 1]] };
  spec.app = composeRules(v, { name: cl.name, ticker: cl.ticker, child: true }).app;
  spec.tools = toolsBeside(chooseTools(v, brain, { name: cl.name }), spec.app);
  validateSpec(spec);
  const t = now();
  const project = db.tx(() => {
    let p = db.get('SELECT * FROM projects WHERE idea_id = ?', ideaId);
    if (!p) {
      const pid = id('prj');
      db.run(`INSERT INTO projects (id, idea_id, slug, name, ticker, description, parent_project_id, initial_buy_lamports, submitter_approved_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pid, ideaId, uniqueSlug(db, cl.name), cl.name, cl.ticker, cl.description, parent.id, cl.initial_buy_lamports, cl.created_at, t, t);
      p = db.get('SELECT * FROM projects WHERE id = ?', pid);
      db.run(`INSERT INTO project_roles (project_id, wallet, role, granted_by, granted_at) VALUES (?, ?, 'founder', 'system', ?) ON CONFLICT DO NOTHING`, pid, cl.wallet, t);
      db.run(`INSERT INTO generations (id, project_id, version, generator, input_json, output_json, cost_usd, created_at) VALUES (?, ?, 1, 'template/1', ?, ?, 0, ?)`,
        id('gen'), pid, JSON.stringify({ idea_version: v.version, evaluation: evaluation.id, childLaunch: cl.id }), JSON.stringify(spec), t);
      // the logo is the creator's image, exactly the bytes they signed the hash of; the banner is drawn from the brain record
      db.run(`INSERT INTO assets (id, project_id, kind, version, mime, body, sha256, generator, created_at) VALUES (?, ?, 'logo', 1, ?, ?, ?, 'creator upload (child launch)', ?)`,
        id('asset'), pid, cl.image_mime, cl.image, cl.image_sha256, t);
      const banner = Buffer.from(bannerSvg({ name: cl.name, ticker: cl.ticker, tagline: spec.tagline, networks: brain.networks, seed: `${pid}:${evaluation.id}`, credit: bannerCredit(cfg) }));
      db.run(`INSERT INTO assets (id, project_id, kind, version, mime, body, sha256, generator, created_at) VALUES (?, ?, 'banner', 1, 'image/svg+xml', ?, ?, 'art/1 (from the brain record)', ?)`,
        id('asset'), pid, banner, sha256(banner), t);
      // the creator's signed start message is the approval of this exact split (child_launches.message / signature)
      db.run(`INSERT INTO fee_allocations (id, project_id, version, recipients_json, total_bps, status, approved_by, approved_at, approval_statement, created_at)
              VALUES (?, ?, 1, ?, 10000, 'approved', ?, ?, ?, ?)`, id('alloc'), pid, cl.recipients_json, cl.wallet, cl.created_at, cl.statement, t);
      audit(db, { actor: 'generator', kind: 'generation', ideaId, projectId: pid, isPublic: true,
        message: `Coin page written from what its creator signed (template, no AI); launched from ${parent.name}` });
    }
    return p;
  });
  ctx.progress('building the website in the sandbox');
  const site = await buildSiteVersion(db, cfg, project, spec, 'system');
  await publishSite(db, cfg, project, site.version, 'system');   // the first version goes live; SUB-01's QA report rides along
  db.tx(() => {
    transition(db, ideaId, 'generating', 'preview_ready', { actor: 'system', note: 'site built; the creator approved the split when they signed' });
    const p = db.get('SELECT * FROM projects WHERE id = ?', project.id);
    if (cfg.launch.requireAdminClearance && !p.admin_cleared_at) {
      note(db, ideaId, 'approved by its creator; waiting for a SUBZERONE reviewer to clear it for launch');
      return;
    }
    transition(db, ideaId, 'preview_ready', 'approved', { actor: 'system', note: 'approved by its creator\'s signature; preparing the launch configuration' });
    enqueue(db, { type: 'prepare_launch', key: `prepare:${p.id}:${p.submitter_approved_at}`, ideaId, projectId: p.id });
  });
  return { project: project.id, site: site.version };
}

/** After confirmIntent says "launched" (pipeline confirm_launch): the parent hears it and signs it into its registry. */
export async function afterLaunched(db, cfg, projectId) {
  const p = db.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p?.parent_project_id) return null;
  const parent = db.get('SELECT * FROM projects WHERE id = ?', p.parent_project_id);
  audit(db, { actor: 'system', kind: 'child_launch', projectId: parent.id, ideaId: parent.idea_id, isPublic: true, message: `${p.name} ($${p.ticker}) was launched from this site` });
  if (!blockOf(liveSpec(db, parent)?.app, 'pq')) return { registry: false };
  try {
    const { syncRegistry, pqAvailable } = await import('./pq.js');
    if (!pqAvailable(cfg)) return { registry: false };
    return { registry: true, added: syncRegistry(db, cfg, parent) };
  } catch (e) { return { registry: false, error: e.message }; }       // the next read of the registry appends it
}

// --- the project host: /_api/launch* --------------------------------------------------------------------------------------
/** handle({project: the parent, site: {host, origin}, method, path, ip, query, body}) -> {body, raw?}. wake(key): kick a job now. */
export function createLaunchApi({ db, cfg, limit, wake = () => {} }) {
  const childOf = (parent, cid) => {
    const cl = db.get('SELECT * FROM child_launches WHERE id = ? AND parent_project_id = ?', String(cid), parent.id);
    if (!cl) throw new HttpError(404, 'not_found', 'no such launch here');
    return cl;
  };
  const owned = (parent, cid, b) => {
    const cl = childOf(parent, cid);
    if (!keyMatches(cl, b.key)) throw new HttpError(403, 'bad_key', 'this page does not hold the key of that launch; open it with the wallet that started it on the launchpad');
    const p = db.get('SELECT * FROM projects WHERE idea_id = ?', cl.idea_id);
    if (!p) throw new HttpError(409, 'not_ready', 'SUB-01 has not built it yet');
    return { cl, p };
  };
  const mockText = (out) => (out?.mock && out.messageHash ? { ...out, mockSigningText: mockSigningText(out.messageHash) } : out);

  async function handle({ project: parent, site, method, path, ip, query, body }) {
    const t = now();
    const { block } = launchBlockOf(db, parent);
    if (method === 'GET') {
      if (path === '/_api/launch') return { body: parentView(db, cfg, parent, block, { before: query.get('before') ? Number(query.get('before')) : undefined }) };
      let m = /^\/_api\/launch\/logo\/([a-z0-9-]{1,40})$/.exec(path);
      if (m) {
        const k = db.get('SELECT p.id FROM projects p JOIN launches l ON l.project_id = p.id WHERE p.slug = ? AND p.parent_project_id = ?', m[1], parent.id);
        const a = k && db.get(`SELECT mime, body FROM assets WHERE project_id = ? AND kind = 'logo' ORDER BY version DESC LIMIT 1`, k.id);
        if (!a) throw new HttpError(404, 'not_found');
        return { raw: { type: a.mime, body: Buffer.from(a.body), cache: 'public, max-age=3600' } };
      }
      m = /^\/_api\/launch\/([A-Za-z0-9_-]{1,40})(\/image)?$/.exec(path);
      if (m) {
        const cl = childOf(parent, m[1]);
        if (!m[2]) return { body: childView(db, cfg, cl) };
        const st = db.get('SELECT status FROM ideas WHERE id = ?', cl.idea_id).status;
        if (['declined', 'cancelled'].includes(st)) throw new HttpError(404, 'not_found');
        return { raw: { type: cl.image_mime, body: Buffer.from(cl.image), cache: 'public, max-age=3600' } };
      }
      throw new HttpError(404, 'not_found');
    }
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (path === '/_api/launch/quote' || path === '/_api/launch/start') {
      if (isPaused(db, 'launch') || isPaused(db, 'submissions')) throw new HttpError(503, 'paused', 'launches are paused right now');
      const provider = getProvider(cfg, db);
      if (!provider) throw new HttpError(503, 'launch_off', 'launching is switched off on this server');
      if (!parentLaunched(db, parent)) throw new HttpError(409, 'parent_not_launched', `launches open once ${parent.name} itself is launched`);
      const wallet = String(b.wallet || '');
      const f = coinFields(cfg, b);
      if (f.initialBuyLamports > 0 && !block.devBuy) throw new HttpError(400, 'bad_initial_buy', 'this site launches without a dev buy');
      const { recipients, statement } = splitFor(db, cfg, parent, block, wallet);
      if (path === '/_api/launch/quote') {
        limit('siteSign', ip);
        if (!/^[0-9a-f]{64}$/.test(String(b.imageSha256 || ''))) throw new HttpError(400, 'bad_upload', 'pick an image first (PNG, JPEG, GIF or WebP, up to 1.5 MB)');
        const payload = payloadOf(parent, f, b.imageSha256, recipients);
        const out = issue(db, parent, site, { wallet, action: 'launch.start', payload, summary: summaryOf(parent, f, b.imageSha256, recipients, provider) }, t);
        return { body: { ...out, recipients, statement, initialBuyLamports: f.initialBuyLamports, network: provider.network, mock: provider.isMock } };
      }
      // start: the image must be the one whose hash was signed
      const img = sniffImage(b.image);
      const payload = payloadOf(parent, f, img.sha, recipients);
      const signature = consume(db, parent, { wallet, nonce: b.nonce, signature: b.signature, action: 'launch.start', payload }, t);
      limit('siteLaunch', `wallet:${wallet}`);
      if (db.get('SELECT banned_at FROM users WHERE wallet = ?', wallet)?.banned_at) throw new HttpError(403, 'banned');
      const hash = ipHash(db, ip), since = t - 86_400_000;
      if (db.get('SELECT COUNT(*) n FROM child_launches WHERE parent_project_id = ? AND ip_hash = ? AND created_at >= ?', parent.id, hash, since).n >= LIMITS.perIpDay) throw new HttpError(429, 'rate_limited', `at most ${LIMITS.perIpDay} launches a day from one connection`);
      if (db.get('SELECT COUNT(*) n FROM child_launches WHERE parent_project_id = ? AND created_at >= ?', parent.id, since).n >= LIMITS.perParentDay) throw new HttpError(429, 'rate_limited', 'this site took all the launches it can for today');
      if (f.initialBuyLamports > 0 && typeof provider.balance === 'function') {
        const bal = await provider.balance(wallet);
        if (bal != null && bal < f.initialBuyLamports + LAUNCH_COST_RESERVE_LAMPORTS) {
          throw new HttpError(400, 'insufficient_funds', `your wallet holds ${solString(bal)} SOL; the dev buy of ${solString(f.initialBuyLamports)} SOL plus about ${solString(LAUNCH_COST_RESERVE_LAMPORTS)} SOL of rent and fees needs ${solString(f.initialBuyLamports + LAUNCH_COST_RESERVE_LAMPORTS)} SOL`);
        }
      }
      const key = token(24), cid = id('child');
      const message = db.get('SELECT message FROM tool_nonces WHERE nonce = ?', String(b.nonce)).message;
      const ideaId = db.tx(() => {
        db.run('INSERT OR IGNORE INTO users (wallet, role, created_at) VALUES (?, \'user\', ?)', wallet, t);
        const plotId = freePlot(db, parent);
        const iid = submitIdea(db, cfg, wallet, { title: `${f.name} ($${f.ticker})`, concept: f.description, nameSuggestion: f.name, tickerSuggestion: f.ticker,
          receivingWallet: wallet, rightsConfirmed: true, links: [], contacts: {}, ...(plotId ? { plotId } : {}) });
        db.run(`UPDATE ideas SET visibility = 'public', published_at = ?, updated_at = ? WHERE id = ?`, t, t, iid);
        db.run(`INSERT INTO child_launches (id, parent_project_id, idea_id, wallet, key_hash, name, ticker, description, image_mime, image, image_sha256,
                  initial_buy_lamports, recipients_json, statement, message, signature, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cid, parent.id, iid, wallet, sha256(key), f.name, f.ticker, f.description, img.mime, img.buf, img.sha, f.initialBuyLamports,
        JSON.stringify(recipients), statement, message, signature, hash, t);
        audit(db, { actor: `wallet:${wallet}`, kind: 'child_launch', ideaId: iid, projectId: parent.id, isPublic: true,
          message: `${f.name} ($${f.ticker}) dropped for launch from ${parent.name}`, data: { childLaunch: cid, recipients: recipients.map(({ role, bps }) => ({ role, bps })), plot: plotId } });
        return iid;
      });
      wake(`evaluate:${ideaId}:v1`);                            // SUB-01's vote in seconds
      return { body: { id: cid, key, ideaId, status: 'submitted' } };
    }
    const m = /^\/_api\/launch\/([A-Za-z0-9_-]{1,40})\/(tx|refresh|signed|abandon|devbuy\/tx|devbuy\/refresh|devbuy\/signed|devbuy\/abandon|devbuy\/skip)$/.exec(path);
    if (!m) throw new HttpError(404, 'not_found');
    const { cl, p } = owned(parent, m[1], b);
    limit('siteLaunch', `wallet:${cl.wallet}`);
    const reason = b.reason === 'rejected' ? 'the wallet rejected the signature request' : 'signature request cancelled';
    switch (m[2]) {
      case 'tx': return { body: mockText(await createIntent(db, cfg, p, cl.wallet)) };
      case 'refresh': return { body: mockText(await refreshIntent(db, cfg, p, cl.wallet)) };
      case 'signed': return { body: await submitSigned(db, cfg, p, cl.wallet, String(b.signed || '')) };
      case 'abandon': abandonIntent(db, p, cl.wallet, reason); return { body: { ok: true } };
      case 'devbuy/tx': return { body: await createDevBuy(db, cfg, p, cl.wallet) };
      case 'devbuy/refresh': return { body: await refreshDevBuy(db, cfg, p, cl.wallet) };
      case 'devbuy/signed': return { body: await submitDevBuy(db, cfg, p, cl.wallet, String(b.signed || '')) };
      case 'devbuy/abandon': abandonDevBuy(db, p, cl.wallet, reason); return { body: { ok: true } };
      default: return { body: { ok: true, ...skipDevBuy(db, p, cl.wallet) } };
    }
  }
  return { handle };
}

export const isChildProject = (p) => Boolean(p?.parent_project_id);
