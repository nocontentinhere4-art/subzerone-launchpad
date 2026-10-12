// Launchpad families (docs/APP-COMPOSER.md "Launchpad families"; the PadPad idea: "a launchpad for launchpads").
// A coin launched from a launchpad's site (child-launch.js) can itself be a launchpad, with its own working launch
// block, down to MAX_DEPTH. Its creator fees flow UP the family tree, split on-chain and locked at launch by the same
// pump.fun fee-sharing config every child coin uses (launch.js, launch/pumpfun.js):
//
//   depth 1 (launched from a root launchpad)   creator 70 / parent 10 / SUB-01 20            (the launch block's split)
//   depth >= 2 (the parent has a parent)       creator 60 / parent 10 / grandparent 10 / SUB-01 20
//
// The grandparent's 10% comes out of the creator's share and stops there (no great-grandparent). The creator keeps
// at least 50% (CHILD_SPLIT_POLICY), so with a block whose parent share leaves the creator under 60% the grandparent
// gets what is left above 50% (never below 0). SUB-01's 20% is fixed. Rows that are the same wallet merge, as before.
// The shareholders are the ancestors' AUTHOR wallets as recorded: the creator row of the fee split their own coin was
// launched with (the approved/locked allocation), else the idea's receiving wallet. pump.fun allows at most 10
// shareholders, each > 0 bps, totalling 10,000, no duplicates, set once (@pump-fun/pump-sdk 4.0.0 updateFeeSharesV2,
// MAX_SHAREHOLDERS = 10; pump-fees errors 6010-6017): a family split has 2 to 4.
//
// Everything is computed here, on the server, from the database: never from the page. The visitor signs the exact
// rows; prepare_launch and the signed-transaction step recompute them (checkFamilySplit) and refuse any difference.
// The fees go to the creators of launchpads up the tree. Nobody who buys or holds a coin receives anything from it.
import { HttpError, parseJson } from './util.js';
import { currentVersion } from './ideas.js';
import { requireSub01Wallet, validateRecipients, allocationStatement, feeMode, CHILD_SPLIT_POLICY, SUB01_LABEL } from './launch.js';
import { blockOf, FAMILY_MAX_DEPTH } from './app-blocks.js';
import { liveSpec } from './tool-api.js';
import { publicStats } from './coin-stats.js';

export const MAX_DEPTH = FAMILY_MAX_DEPTH;  // 5: the deepest coin in a family; a launchpad lives at depth MAX_DEPTH - 1 at most
export const GRANDPARENT_BPS = 1000;
export const FAMILY_RULE = Object.freeze({ depth1: { creator: 7000, parent: 1000, sub01: 2000 }, deeper: { creator: 6000, parent: 1000, grandparent: 1000, sub01: 2000 } });
const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };

/** [parent, grandparent, …] up to the root, as project rows (a cycle or a missing row stops the walk). */
export function ancestors(db, project) {
  const out = [], seen = new Set([project.id]);
  let pid = project.parent_project_id;
  while (pid && !seen.has(pid) && out.length <= MAX_DEPTH + 1) {
    const p = db.get('SELECT * FROM projects WHERE id = ?', pid);
    if (!p) break;
    out.push(p); seen.add(p.id); pid = p.parent_project_id;
  }
  return out;
}
export const depthOf = (db, project) => ancestors(db, project).length;
export const rootOf = (db, project) => ancestors(db, project).at(-1) || project;

/** The wallet that receives a coin's creator share, as recorded when it was launched. */
export function authorOf(db, project) {
  const alloc = db.get(`SELECT recipients_json FROM fee_allocations WHERE project_id = ? AND status IN ('locked','approved') ORDER BY version DESC LIMIT 1`, project.id);
  const row = parseJson(alloc?.recipients_json, []).find((r) => r.role === 'submitter');
  return row?.wallet || currentVersion(db, project.idea_id).receiving_wallet;
}

/** Is this project a launchpad that may launch coins now? Roots: their app has the launch block (SUB-01 gave it). A
 * coin of a family: only when it was launched as a launchpad (what its creator signed) and is above MAX_DEPTH. */
export function launchpadState(db, project) {
  const depth = depthOf(db, project);
  if (!project.parent_project_id) return { launchpad: true, depth };
  const cl = db.get('SELECT as_launchpad FROM child_launches WHERE parent_project_id = ? AND idea_id = ?', project.parent_project_id, project.idea_id);
  return { launchpad: Boolean(cl?.as_launchpad) && depth < MAX_DEPTH, depth };
}

/** What a coin launched from `parent` (whose launch block is `block`) will be: a launchpad or a coin. */
export function childKind(db, parent, block, wanted) {
  const depth = depthOf(db, parent) + 1;
  const mode = block.children || 'coins';
  const can = depth < MAX_DEPTH;
  if (mode === 'coins') {
    if (wanted === true) throw new HttpError(400, 'coins_only', 'this site launches coins, not launchpads');
    return { depth, launchpad: false, mode, can };
  }
  if (mode === 'choice' && wanted === true && !can) throw new HttpError(400, 'max_depth', `a launchpad at depth ${depth} would be past the family's limit: coins launched here are coins (max depth ${MAX_DEPTH})`);
  return { depth, launchpad: can && (mode === 'launchpads' || wanted === true), mode, can };
}

/** The bps rule for a coin launched from `parent` with the parent's block split: {creator, parent, grandparent, sub01}. */
export function familyBps(db, parent, split) {
  const gp = parent.parent_project_id ? ancestors(db, parent)[0] : null;
  const grandparent = gp ? Math.max(0, Math.min(GRANDPARENT_BPS, split.creator - CHILD_SPLIT_POLICY.minSubmitterBps)) : 0;
  return { creator: split.creator - grandparent, parent: split.parent, grandparent, sub01: split.sub01, grandparentProject: gp };
}

/**
 * The exact split of a coin launched from `parent` by `wallet`, from the parent's launch-block `split`: creator /
 * the parent's author / the grandparent's author / SUB-01. Same-wallet rows merge (the creator's own ancestor keeps
 * both shares; an ancestor whose wallet is SUB-01's gives that share to SUB-01's row). -> {recipients, statement, bps}
 */
export function familySplit(db, cfg, parent, split, wallet) {
  const sub01 = requireSub01Wallet(cfg);
  if (wallet === sub01) throw new HttpError(400, 'bad_wallet', 'that is SUB-01\'s own wallet; launch with yours');
  const bps = familyBps(db, parent, split);
  const rows = [{ label: 'Creator', wallet, bps: bps.creator, role: 'submitter' }];
  const sub = { label: SUB01_LABEL, wallet: sub01, bps: bps.sub01, role: 'sub01' };
  const up = [{ label: clip(`Author of ${parent.name}`, 40), wallet: authorOf(db, parent), bps: bps.parent, role: 'parent' }];
  if (bps.grandparentProject && bps.grandparent > 0) up.push({ label: clip(`Author of ${bps.grandparentProject.name}`, 40), wallet: authorOf(db, bps.grandparentProject), bps: bps.grandparent, role: 'grandparent' });
  for (const r of up) {
    if (!(r.bps > 0)) continue;
    const same = r.wallet === sub01 ? sub : rows.find((x) => x.wallet === r.wallet);
    if (same) same.bps += r.bps; else rows.push(r);
  }
  rows.push(sub);
  const recipients = validateRecipients(cfg, rows, wallet, CHILD_SPLIT_POLICY);
  const { grandparentProject, ...rule } = bps;
  return { recipients, statement: allocationStatement(recipients, feeMode(recipients, wallet)), bps: rule };
}

const key = (rows) => (rows || []).map((r) => `${r.role}:${r.wallet}:${r.bps}`).sort().join('|');
const holders = (rows) => (rows || []).map((r) => `${r.wallet}:${r.bps}`).sort().join('|');

/**
 * The strict re-check (prepare_launch and the signed-transaction step): the rows about to go on-chain must be exactly
 * the family split recomputed now from the database (the split the visitor signed, the recorded author wallets, SUB-01's
 * wallet) and exactly what the visitor signed. A city coin (no parent) passes through. Throws HttpError 409.
 * rows: [{role, wallet, bps}] (an allocation) or, with {shareholdersOnly: true}, [{wallet, bps}] (a launch config).
 */
export function checkFamilySplit(db, cfg, project, rows, { shareholdersOnly = false } = {}) {
  if (!project.parent_project_id) return null;
  const cl = db.get('SELECT * FROM child_launches WHERE parent_project_id = ? AND idea_id = ?', project.parent_project_id, project.idea_id);
  if (!cl) throw new HttpError(409, 'split_mismatch', 'a coin launched from another site has no signed launch record');
  const signed = parseJson(cl.recipients_json, []);
  const cmp = shareholdersOnly ? holders : key;
  const why = (what) => { throw new HttpError(409, 'split_mismatch', `the fee split differs from ${what}; nothing was signed or sent`); };
  if (cmp(rows) !== cmp(signed)) why('what its creator signed');
  // before migration 020 the parent's split was not recorded: what was signed is the reference
  const split = parseJson(cl.split_json, null);
  if (!split) return signed;
  const parent = db.get('SELECT * FROM projects WHERE id = ?', cl.parent_project_id);
  const expected = familySplit(db, cfg, parent, split, cl.wallet).recipients;
  if (cmp(rows) !== cmp(expected)) why('the family rule (creator, parent, grandparent, SUB-01)');
  return expected;
}

// --- the tree (GET /api/projects/:slug/tree, the site's /_api/tree, the tree block) -----------------------------------
export const TREE_LIMIT = 400;
const TTL_MS = 15_000;
const cache = new Map();                    // root project id -> {at, view}
export const forgetTree = (rootId) => { if (rootId) cache.delete(rootId); else cache.clear(); };
const DAY = 86_400_000;

/** The whole family of `project`'s root: every launched coin (and the root, launched or not), public ideas only. */
function familyRows(db, root) {
  return db.all(`WITH RECURSIVE fam(id, depth) AS (SELECT ?, 0 UNION ALL SELECT p.id, fam.depth + 1 FROM projects p JOIN fam ON p.parent_project_id = fam.id WHERE fam.depth < ?)
    SELECT p.id, p.slug, p.name, p.ticker, p.parent_project_id, p.idea_id, p.live_site_version, fam.depth, i.status, i.visibility,
      l.mint, l.network, l.provider, l.verified_at, cs.json cs_json, c.as_launchpad
    FROM fam JOIN projects p ON p.id = fam.id JOIN ideas i ON i.id = p.idea_id
    LEFT JOIN launches l ON l.project_id = p.id LEFT JOIN coin_stats cs ON cs.mint = l.mint
    LEFT JOIN child_launches c ON c.idea_id = p.idea_id AND c.parent_project_id = p.parent_project_id`, root.id, MAX_DEPTH + 1);
}

/** The family tree as the tree block and the city read it. Numbers are counts from the launch records (and the stored
 * market numbers of coin-stats.js when there are some: nothing is fetched here). */
export function treeView(db, cfg, project, t = Date.now()) {
  const root = rootOf(db, project);
  const hit = cache.get(root.id);
  let view = hit && t - hit.at < TTL_MS ? hit.view : null;
  if (!view) { view = buildTree(db, cfg, root, t); cache.set(root.id, { at: t, view }); }
  return { ...view, focus: project.slug };
}

function buildTree(db, cfg, root, t) {
  const rows = familyRows(db, root).filter((r) => r.visibility === 'public' && (r.id === root.id || r.verified_at));
  const byId = new Map(rows.map((r) => [r.id, { ...r, kids: [] }]));
  for (const r of byId.values()) if (r.id !== root.id) byId.get(r.parent_project_id)?.kids.push(r);
  const inProgress = new Map();
  for (const x of db.all(`WITH RECURSIVE fam(id, depth) AS (SELECT ?, 0 UNION ALL SELECT p.id, fam.depth + 1 FROM projects p JOIN fam ON p.parent_project_id = fam.id WHERE fam.depth < ?)
      SELECT c.parent_project_id pid, COUNT(*) n FROM child_launches c JOIN fam ON fam.id = c.parent_project_id JOIN ideas i ON i.id = c.idea_id
      WHERE i.status NOT IN ('launched','declined','cancelled','failed') GROUP BY c.parent_project_id`, root.id, MAX_DEPTH + 1)) inProgress.set(x.pid, x.n);
  const rootSpec = liveSpec(db, root), rootLaunch = blockOf(rootSpec?.app, 'launch');
  // post-order: descendants and the last 24 h, per node
  const walk = (n) => {
    n.kids.sort((a, b) => a.verified_at - b.verified_at);
    let desc = 0, day = 0;
    for (const k of n.kids) { walk(k); desc += 1 + k.desc; day += (k.verified_at >= t - DAY ? 1 : 0) + k.day; }
    n.desc = desc; n.day = day;
  };
  const top = byId.get(root.id);
  walk(top);
  const site = (r) => (r.live_site_version ? `${cfg.projectsScheme}://${r.slug}.${cfg.projectsHost}/` : null);
  const nodes = [];
  const queue = [top];
  while (queue.length && nodes.length < TREE_LIMIT) {
    const n = queue.shift();
    const s = n.cs_json ? publicStats(parseJson(n.cs_json), t) : null;
    nodes.push({ slug: n.slug, name: n.name, ticker: n.ticker, depth: n.depth, parent: n.id === root.id ? null : byId.get(n.parent_project_id)?.slug ?? null,
      launchpad: n.id === root.id ? Boolean(rootLaunch) : Boolean(n.as_launchpad) && n.depth < MAX_DEPTH,
      launched: Boolean(n.verified_at), launchedAt: n.verified_at || null, mock: n.provider === 'mock', network: n.network || null, mint: n.mint || null, siteUrl: site(n),
      children: n.kids.length, descendants: n.desc, launches24h: n.kids.filter((k) => k.verified_at >= t - DAY).length, branch24h: n.day,
      inProgress: inProgress.get(n.id) || 0, marketCapUsd: s?.marketCapUsd ?? null, volume24hUsd: s?.volume24hUsd ?? null });
    queue.push(...n.kids);
  }
  const pads = nodes.filter((n) => n.launchpad);
  const rank = (k) => pads.filter((n) => n[k] > 0).sort((a, b) => b[k] - a[k] || b.descendants - a.descendants || a.depth - b.depth || (a.launchedAt || 0) - (b.launchedAt || 0))
    .slice(0, 5).map((n) => ({ slug: n.slug, name: n.name, ticker: n.ticker, depth: n.depth, siteUrl: n.siteUrl, [k]: n[k], descendants: n.descendants }));
  // the fastest-growing branch: a launchpad below the root, by its branch's launches in the last 24 h
  const fastest = rank('branch24h').filter((n) => n.slug !== root.slug);
  return {
    v: 1, root: root.slug, maxDepth: MAX_DEPTH, generatedAt: t, rule: FAMILY_RULE,
    note: 'Creator fees of every coin born in this family are split on-chain and locked at launch: its creator, the parent launchpad\'s author, the grandparent\'s author (from depth 2) and SUB-01 (20%). They go to the creators of launchpads up the tree, never to buyers or holders.',
    totals: { coins: nodes.length - 1, launchpads: pads.filter((n) => n.depth > 0).length, launched24h: top.day, deepest: Math.max(0, ...nodes.map((n) => n.depth)), inProgress: [...inProgress.values()].reduce((a, b) => a + b, 0) },
    fastest, mostDescendants: rank('descendants'), nodes, truncated: nodes.length < rows.length,
  };
}

/** The city's neighbourhood (world.js): a plotted project's descendants that have no plot of their own, breadth first. */
export function neighbourhood(db, cfg, project, limit = 24) {
  const rows = db.all(`WITH RECURSIVE fam(id, depth) AS (SELECT ?, 0 UNION ALL SELECT p.id, fam.depth + 1 FROM projects p JOIN fam ON p.parent_project_id = fam.id
      WHERE fam.depth < ? AND (fam.depth = 0 OR NOT EXISTS (SELECT 1 FROM plots pl JOIN projects q ON q.idea_id = pl.idea_id WHERE q.id = fam.id)))
    SELECT p.id, p.slug, p.name, p.ticker, p.parent_project_id, p.live_site_version, fam.depth, i.status, i.visibility, l.verified_at, l.provider, c.as_launchpad,
      (SELECT 1 FROM plots pl WHERE pl.idea_id = p.idea_id) has_plot
    FROM fam JOIN projects p ON p.id = fam.id JOIN ideas i ON i.id = p.idea_id LEFT JOIN launches l ON l.project_id = p.id
    LEFT JOIN child_launches c ON c.idea_id = p.idea_id AND c.parent_project_id = p.parent_project_id
    WHERE fam.depth > 0 ORDER BY fam.depth, COALESCE(l.verified_at, p.created_at), p.id`, project.id, MAX_DEPTH + 1);
  const slugOf = new Map([[project.id, project.slug], ...rows.map((r) => [r.id, r.slug])]);
  const kept = rows.filter((r) => r.visibility === 'public' && !r.has_plot && !['declined', 'cancelled'].includes(r.status));
  return { total: kept.length, members: kept.slice(0, limit).map((r) => ({ slug: r.slug, name: r.name, ticker: r.ticker, depth: r.depth, parent: slugOf.get(r.parent_project_id) || null,
    stage: r.status, launched: Boolean(r.verified_at), mock: r.provider === 'mock', launchpad: Boolean(r.as_launchpad) && r.depth < MAX_DEPTH,
    siteUrl: r.live_site_version ? `${cfg.projectsScheme}://${r.slug}.${cfg.projectsHost}/` : null })) };
}
