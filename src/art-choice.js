// The author's pick between the two logo+banner options of a new coin (coinart.js, migration 017). The live pair is the
// newest asset version of each kind, the reader everywhere else (sites, /meta, the city, the token metadata); choosing
// copies the chosen pair into new versions. Same rules as the dev buy (launch.js setInitialBuy): owner only, while
// preview_ready / approved / launch_prepared and before any launch transaction exists; a prepared launch configuration
// is rebuilt because its metadata names the logo version.
import { audit } from './db.js';
import { enqueue } from './jobs.js';
import { transition } from './states.js';
import { INITIAL_BUY_STATES } from './launch.js';
import { HttpError, id, now, parseJson, sha256 } from './util.js';

const ACTIVE_INTENT = `SELECT 1 FROM launch_intents WHERE project_id = ? AND status IN ('prepared','awaiting_signature','submitted','confirmed')`;

/** Why the choice cannot change now, or null. */
export function artLock(db, project, idea) {
  if (db.get('SELECT 1 FROM launches WHERE project_id = ?', project.id)) return 'the coin is launched: its logo is on chain';
  if (db.get(ACTIVE_INTENT, project.id)) return 'a launch transaction exists; cancel it first to change the logo';
  if (!INITIAL_BUY_STATES.includes(idea.status)) return `the project is ${idea.status}`;
  return null;
}

const candidates = (db, projectId) => db.all(`SELECT c.idx, l.id logo_id, l.sha256 logo_sha, l.generator logo_gen, b.id banner_id, b.sha256 banner_sha
  FROM art_candidates c JOIN assets l ON l.id = c.logo_asset_id JOIN assets b ON b.id = c.banner_asset_id WHERE c.project_id = ? ORDER BY c.idx`, projectId);
const live = (db, projectId, kind) => db.get('SELECT version, sha256 FROM assets WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1', projectId, kind);

/** GET /api/projects/:slug/art (owner): the options, which one is live, and whether it can still change. */
export function artView(db, project, idea) {
  const rows = candidates(db, project.id);
  const logo = live(db, project.id, 'logo'), banner = live(db, project.id, 'banner');
  const lockedWhy = artLock(db, project, idea);
  return {
    choice: rows.length ? (project.art_choice ?? 0) : null,
    chosen: project.art_choice !== null && project.art_choice !== undefined,
    locked: Boolean(lockedWhy), lockedWhy,
    candidates: rows.map((r) => {
      const g = parseJson(r.logo_gen) || {};
      return { index: r.idx, label: `Option ${r.idx + 1}`, provider: g.provider || null, symbol: g.symbol?.id || null,
        live: logo?.sha256 === r.logo_sha && banner?.sha256 === r.banner_sha,
        logoUrl: `/api/projects/${project.slug}/art/logo-${r.idx}.png`, bannerUrl: `/api/projects/${project.slug}/art/banner-${r.idx}.png` };
    }),
    // the live pair, as the coin site and the token metadata use it
    live: logo ? { logoVersion: logo.version, bannerVersion: banner?.version ?? null } : null,
  };
}

/** GET /api/projects/:slug/art/(logo|banner)-(0|1).png (owner): one option's image. -> { mime, body } */
export function artFile(db, project, file) {
  const m = String(file).match(/^(logo|banner)-([01])\.png$/);
  if (!m) throw new HttpError(404, 'not_found');
  const c = db.get('SELECT logo_asset_id, banner_asset_id FROM art_candidates WHERE project_id = ? AND idx = ?', project.id, Number(m[2]));
  if (!c) throw new HttpError(404, 'not_found');
  const a = db.get('SELECT mime, body FROM assets WHERE id = ?', m[1] === 'logo' ? c.logo_asset_id : c.banner_asset_id);
  if (!a) throw new HttpError(404, 'not_found');
  return { mime: a.mime, body: Buffer.from(a.body) };
}

/** PUT /api/projects/:slug/art {choice: 0|1} (owner). -> { choice, changed, status, reprepared } */
export function chooseArt(db, project, idea, wallet, choice) {
  if (idea.owner_wallet !== wallet) throw new HttpError(403, 'not_owner');
  if (choice !== 0 && choice !== 1) throw new HttpError(400, 'bad_choice', 'choice is 0 (option 1) or 1 (option 2)');
  const rows = candidates(db, project.id);
  const pick = rows.find((r) => r.idx === choice);
  if (!pick) throw new HttpError(404, 'no_candidates', 'this project has no logo options (made before 2026-10-12)');
  if (db.get('SELECT 1 FROM launches WHERE project_id = ?', project.id)) throw new HttpError(409, 'already_launched');
  if (db.get(ACTIVE_INTENT, project.id)) throw new HttpError(409, 'intent_exists', 'a transaction already exists; cancel it first to change the logo');
  if (!INITIAL_BUY_STATES.includes(idea.status)) throw new HttpError(409, 'bad_state', `idea is ${idea.status}`);
  const t = now();
  const changed = live(db, project.id, 'logo')?.sha256 !== pick.logo_sha || live(db, project.id, 'banner')?.sha256 !== pick.banner_sha;
  let status = idea.status;
  db.tx(() => {
    if (changed) {
      for (const [kind, assetId] of [['logo', pick.logo_id], ['banner', pick.banner_id]]) {
        const a = db.get('SELECT mime, body, generator FROM assets WHERE id = ?', assetId);
        const v = (db.get('SELECT MAX(version) v FROM assets WHERE project_id = ? AND kind = ?', project.id, kind)?.v || 0) + 1;
        const g = { ...(parseJson(a.generator) || { source: a.generator }), chosen: choice, by: `wallet:${wallet}` };
        db.run(`INSERT INTO assets (id, project_id, kind, version, mime, body, sha256, generator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id('asset'), project.id, kind, v, a.mime, a.body, sha256(Buffer.from(a.body)), JSON.stringify(g), t);
      }
    }
    db.run('UPDATE projects SET art_choice = ?, updated_at = ? WHERE id = ?', choice, t, project.id);
    audit(db, { actor: `wallet:${wallet}`, kind: 'art_choice', ideaId: idea.id, projectId: project.id, isPublic: true,
      message: `Logo option ${choice + 1} chosen`, data: { choice } });
    if (!changed) return;
    // the site carries the new pair from the next request on; a fresh build records it as its own version
    enqueue(db, { type: 'build_site', key: `build_site:${project.id}:art:${t}`, ideaId: idea.id, projectId: project.id });
    if (idea.status === 'launch_prepared') {
      db.run('UPDATE projects SET launch_config_json = NULL, launch_config_hash = NULL WHERE id = ?', project.id);
      transition(db, idea.id, 'launch_prepared', 'approved', { actor: `wallet:${wallet}`, note: 'logo changed; preparing the launch configuration again' });
      status = 'approved';
    }
    if (status === 'approved') enqueue(db, { type: 'prepare_launch', key: `prepare:${project.id}:art:${t}`, ideaId: idea.id, projectId: project.id });
  });
  return { choice, changed, status, reprepared: changed && idea.status === 'launch_prepared' };
}
