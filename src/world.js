// The shared city: 24 Tokyo districts × 6 plots. A plot is claimed once, first come first served, either as a
// resident's apartment or as a project's building (reserved with the idea). Claims are rows in `plots`; the primary
// key makes a double claim impossible even across processes. Everything returned by worldView() is public.
import { audit } from './db.js';
import { LABELS } from './states.js';
import { now, HttpError, parseJson } from './util.js';

export const DISTRICTS = ['shiba', 'shinjuku', 'akihabara', 'shibuya', 'harajuku', 'nakameguro', 'ebisu', 'roppongi', 'ginza',
  'asakusa', 'ueno', 'ikebukuro', 'nakano', 'kanda', 'tsukiji', 'odaiba', 'yoyogi', 'meguro', 'shinagawa', 'sumida',
  'daikanyama', 'nihonbashi', 'koenji', 'shimokitazawa'];
export const PLOTS_PER_DISTRICT = 6;
export const PLOT_IDS = DISTRICTS.flatMap((d) => Array.from({ length: PLOTS_PER_DISTRICT }, (_, i) => `${d}-${i + 1}`));
const PLOT_SET = new Set(PLOT_IDS);

export const LOOK = Object.freeze({
  skin: ['#f6d5b8', '#e8b48f', '#c98e66', '#a26a45', '#7a4a2e', '#4f3020'],
  hair: ['#1b1b1b', '#3b2a20', '#6b4428', '#a87443', '#d9b26f', '#b23a2e', '#e8e8e8', '#4a6cd4'],
  hairStyle: ['short', 'long', 'bun', 'buzz', 'curly'],
  outfit: ['hoodie', 'jacket', 'tee', 'suit'],
});
export const FREE_COLORS = ['top', 'bottom'];          // any #rrggbb
const HEX = /^#[0-9a-f]{6}$/;
export const NAME = { min: 2, max: 24 };

export const ROOM = Object.freeze({
  floor: ['white_oak', 'honey_oak', 'walnut', 'smoked_oak', 'concrete', 'tatami'],
  walls: ['chalk', 'sand', 'sage', 'navy', 'terracotta', 'concrete'],
  accent: ['navy', 'linen', 'rust', 'olive', 'charcoal', 'blush'],
  lighting: ['morning', 'midday', 'evening', 'night'],
  items: ['bed', 'desk', 'chair', 'couch', 'shelf', 'lamp', 'plant', 'rug', 'table'],
  rot: [0, 90, 180, 270],
  coord: [-3.5, 3.5],                                   // x and z, metres from the room centre
  maxFurniture: 24,
});
export const DEFAULT_ROOM = Object.freeze({
  materials: { floor: 'honey_oak', walls: 'chalk', accent: 'navy' },
  lighting: 'evening',
  furniture: [
    { item: 'bed', x: -2.5, z: -2.5, rot: 0 }, { item: 'desk', x: 2.5, z: -3, rot: 0 }, { item: 'chair', x: 2.5, z: -2, rot: 180 },
    { item: 'couch', x: -2.5, z: 2.5, rot: 90 }, { item: 'shelf', x: 3.2, z: 1, rot: 270 }, { item: 'lamp', x: 3, z: 3, rot: 0 },
    { item: 'plant', x: -3.2, z: 0, rot: 0 }, { item: 'rug', x: 0, z: 0, rot: 0 },
  ],
});

export function validateRoom(room) {
  const bad = (m) => new HttpError(400, 'bad_room', m);
  if (!room || typeof room !== 'object' || Array.isArray(room)) throw bad('room must be an object');
  const extra = Object.keys(room).filter((k) => !['materials', 'lighting', 'furniture'].includes(k));
  if (extra.length) throw bad(`unknown room field ${extra[0].slice(0, 20)}`);
  const m = room.materials;
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some((k) => !['floor', 'walls', 'accent'].includes(k))) throw bad('materials: {floor, walls, accent}');
  for (const k of ['floor', 'walls', 'accent']) if (!ROOM[k].includes(m[k])) throw bad(`materials.${k}: one of ${ROOM[k].join(', ')}`);
  if (!ROOM.lighting.includes(room.lighting)) throw bad(`lighting: one of ${ROOM.lighting.join(', ')}`);
  if (!Array.isArray(room.furniture) || room.furniture.length > ROOM.maxFurniture) throw bad(`furniture: an array of at most ${ROOM.maxFurniture}`);
  const inRange = (v) => typeof v === 'number' && Number.isFinite(v) && v >= ROOM.coord[0] && v <= ROOM.coord[1];
  const furniture = room.furniture.map((f) => {
    if (!f || typeof f !== 'object' || Object.keys(f).some((k) => !['item', 'x', 'z', 'rot'].includes(k))) throw bad('furniture entries: {item, x, z, rot}');
    if (!ROOM.items.includes(f.item)) throw bad(`furniture item: one of ${ROOM.items.join(', ')}`);
    if (!inRange(f.x) || !inRange(f.z)) throw bad(`furniture x and z: numbers from ${ROOM.coord[0]} to ${ROOM.coord[1]}`);
    if (!ROOM.rot.includes(f.rot)) throw bad('furniture rot: 0, 90, 180 or 270');
    return { item: f.item, x: Math.round(f.x * 100) / 100, z: Math.round(f.z * 100) / 100, rot: f.rot };
  });
  return { materials: { floor: m.floor, walls: m.walls, accent: m.accent }, lighting: room.lighting, furniture };
}

export function saveRoom(db, wallet, room) {
  const v = validateRoom(room);
  const r = db.run('UPDATE residents SET room_json = ?, updated_at = ? WHERE wallet = ?', JSON.stringify(v), now(), wallet);
  if (!r.changes) throw new HttpError(409, 'no_resident', 'create your resident first (POST /api/residents)');
  return v;
}

/** Public: the interior behind a plot. Apartments show their resident; a project plot shows its submitter's room
 * only once the idea is public (a private idea must not be linkable to a person). */
export function roomView(db, plotId) {
  validatePlotId(plotId);
  const pl = db.get('SELECT pl.*, i.visibility FROM plots pl LEFT JOIN ideas i ON i.id = pl.idea_id WHERE pl.plot_id = ?', plotId);
  if (!pl || (pl.kind === 'project' && pl.visibility !== 'public')) return null;
  const r = db.get('SELECT * FROM residents WHERE wallet = ?', pl.wallet);
  if (!r) return null;
  return { plotId, kind: pl.kind, owner: { name: r.name, look: parseJson(r.look_json) }, room: parseJson(r.room_json) || DEFAULT_ROOM };
}

export const PROGRESS = { submitted: 0.05, evaluating: 0.12, selected: 0.2, generating: 0.45, preview_ready: 0.65, approved: 0.75,
  launch_prepared: 0.82, awaiting_signature: 0.88, confirming: 0.94, launched: 1, failed: 0, declined: 0, cancelled: 0 };
// generate-job progress texts (pipeline.js) -> a finer position inside 'generating'
const GEN_STEPS = { 'writing the project identity': 0.5, 'building the website in the sandbox': 0.58 };

export function validatePlotId(plotId) {
  if (typeof plotId !== 'string' || !PLOT_SET.has(plotId)) throw new HttpError(400, 'bad_plot', 'unknown plot (see /api/world/options)');
  return plotId;
}

export function validateLook(look) {
  if (!look || typeof look !== 'object' || Array.isArray(look)) throw new HttpError(400, 'bad_look', 'look must be an object');
  const keys = [...Object.keys(LOOK), ...FREE_COLORS];
  const extra = Object.keys(look).filter((k) => !keys.includes(k));
  if (extra.length) throw new HttpError(400, 'bad_look', `unknown look field ${extra[0].slice(0, 20)}`);
  const out = {};
  for (const [k, allowed] of Object.entries(LOOK)) {
    const v = typeof look[k] === 'string' ? look[k].toLowerCase() : look[k];
    if (!allowed.includes(v)) throw new HttpError(400, 'bad_look', `${k}: one of ${allowed.join(', ')}`);
    out[k] = v;
  }
  for (const k of FREE_COLORS) {
    const v = String(look[k] ?? '').toLowerCase();
    if (!HEX.test(v)) throw new HttpError(400, 'bad_look', `${k}: a #rrggbb colour`);
    out[k] = v;
  }
  return out;
}

export function validateName(name) {
  const v = String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (v.length < NAME.min || v.length > NAME.max || !/^[\p{L}\p{N} ._'-]+$/u.test(v)) {
    throw new HttpError(400, 'bad_name', `${NAME.min}–${NAME.max} letters, digits, spaces or . _ ' -`);
  }
  return v;
}

/** Inside a transaction: claim a free plot or 409. The pre-check gives a clear error; the primary key is the guard. */
export function claimPlot(db, { plotId, kind, wallet, ideaId = null }) {
  validatePlotId(plotId);
  if (db.get('SELECT 1 FROM plots WHERE plot_id = ?', plotId)) throw new HttpError(409, 'plot_taken', `${plotId} is already taken`);
  try {
    db.run('INSERT INTO plots (plot_id, kind, wallet, idea_id, claimed_at) VALUES (?, ?, ?, ?, ?)', plotId, kind, wallet, ideaId, now());
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY/.test(String(e.message))) throw new HttpError(409, 'plot_taken', `${plotId} is already taken`);
    throw e;
  }
}

/** Create or update the caller's resident. A new plotId moves the apartment (the old one is released). */
export function saveResident(db, wallet, input) {
  const name = validateName(input.name);
  const look = validateLook(input.look);
  const plotId = input.plotId == null ? null : validatePlotId(input.plotId);
  const t = now();
  return db.tx(() => {
    const cur = db.get('SELECT * FROM residents WHERE wallet = ?', wallet);
    if (!cur && !plotId) throw new HttpError(400, 'bad_plot', 'choose an apartment plot');
    const target = plotId || cur.plot_id;
    if (cur && target !== cur.plot_id) {
      claimPlot(db, { plotId: target, kind: 'apartment', wallet });
      db.run('UPDATE residents SET name = ?, look_json = ?, plot_id = ?, updated_at = ? WHERE wallet = ?', name, JSON.stringify(look), target, t, wallet);
      db.run(`DELETE FROM plots WHERE plot_id = ? AND kind = 'apartment' AND wallet = ?`, cur.plot_id, wallet);
      audit(db, { actor: `wallet:${wallet}`, kind: 'resident', isPublic: true, message: `${name} moved to ${target}`, data: { from: cur.plot_id, to: target } });
    } else if (cur) {
      db.run('UPDATE residents SET name = ?, look_json = ?, updated_at = ? WHERE wallet = ?', name, JSON.stringify(look), t, wallet);
    } else {
      claimPlot(db, { plotId: target, kind: 'apartment', wallet });
      db.run('INSERT INTO residents (wallet, name, look_json, plot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', wallet, name, JSON.stringify(look), target, t, t);
      audit(db, { actor: `wallet:${wallet}`, kind: 'resident', isPublic: true, message: `${name} moved into ${target}`, data: { to: target } });
    }
    return residentOf(db, wallet);
  });
}

export function residentOf(db, wallet) {
  const r = db.get('SELECT * FROM residents WHERE wallet = ?', wallet);
  return r && { name: r.name, look: parseJson(r.look_json), plotId: r.plot_id, room: parseJson(r.room_json) || DEFAULT_ROOM, createdAt: r.created_at, updatedAt: r.updated_at };
}

export const plotsOf = (db, wallet) => db.all('SELECT plot_id plotId, kind, idea_id ideaId, claimed_at claimedAt FROM plots WHERE wallet = ? ORDER BY claimed_at', wallet);

/** first4…last4: enough to recognise a wallet, not to copy it. */
export const shortWallet = (w) => (w && w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);
const scrub = (text) => String(text).replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, shortWallet);

const JOB_VERBS = { evaluate: 'Thinking about', generate: 'Building', build_site: 'Rebuilding the site of', prepare_launch: 'Preparing the launch of',
  confirm_launch: 'Watching the launch of', reconcile_fees: 'Counting the fees of', publish_x_post: 'Posting for' };
const STAGE_WORD = { submitted: 'dropped', evaluating: 'reading', selected: 'selected', generating: 'building', preview_ready: 'preview',
  approved: 'approved', launch_prepared: 'launch ready', awaiting_signature: 'signature', confirming: 'confirming', launched: 'launched' };

/** The public city snapshot. Private ideas show as 'Private project' with stage only; no wallet ever appears. */
export function worldView(db, cfg) {
  const genProgress = new Map(db.all(`SELECT idea_id, progress FROM jobs WHERE type = 'generate' AND status = 'running' AND idea_id IS NOT NULL`)
    .map((j) => [j.idea_id, j.progress]));
  const projectOf = (x) => {
    const stage = x.status;
    let progress = PROGRESS[stage] ?? 0;
    if (stage === 'generating' && GEN_STEPS[genProgress.get(x.idea_id)]) progress = GEN_STEPS[genProgress.get(x.idea_id)];
    const base = { stage, stageLabel: LABELS[stage] || stage, progress };
    if (x.visibility !== 'public') return { slug: null, name: 'Private project', ticker: null, ...base, launched: false, mint: null };
    const launched = stage === 'launched' && Boolean(x.mint);
    return { slug: x.slug || null, name: x.pname || x.title, ticker: x.ticker || x.ticker_suggestion || null, ...base, launched, mint: launched ? x.mint : null };
  };
  const rows = db.all(`SELECT pl.plot_id, pl.kind, pl.idea_id, r.name rname, r.look_json, i.status, i.visibility, v.title, v.ticker_suggestion,
      p.slug, p.name pname, p.ticker, l.mint
    FROM plots pl LEFT JOIN residents r ON r.plot_id = pl.plot_id LEFT JOIN ideas i ON i.id = pl.idea_id
    LEFT JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
    LEFT JOIN projects p ON p.idea_id = i.id LEFT JOIN launches l ON l.project_id = p.id ORDER BY pl.claimed_at`);
  const plots = rows.map((x) => ({ plotId: x.plot_id, kind: x.kind,
    resident: x.kind === 'apartment' && x.rname ? { name: x.rname, look: parseJson(x.look_json) } : null,
    project: x.kind === 'project' && x.status ? projectOf(x) : null }));

  // SUB-01: working on whatever job is running now; otherwise what the brain last answered (no network call here)
  const job = db.get(`SELECT j.type, COALESCE(j.idea_id, p.idea_id) idea_id FROM jobs j LEFT JOIN projects p ON p.id = j.project_id
    WHERE j.status = 'running' AND COALESCE(j.idea_id, p.idea_id) IS NOT NULL ORDER BY j.updated_at DESC LIMIT 1`);
  let sub01;
  if (job) {
    const x = db.get(`SELECT i.id, i.status, i.visibility, v.title, p.name pname, pl.plot_id FROM ideas i
      JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version LEFT JOIN projects p ON p.idea_id = i.id
      LEFT JOIN plots pl ON pl.idea_id = i.id WHERE i.id = ?`, job.idea_id);
    const pub = x.visibility === 'public';
    sub01 = { state: 'working', ideaId: pub ? x.id : null, plotId: x.plot_id || null, stage: x.status,
      text: `${JOB_VERBS[job.type] || 'Working on'} ${pub ? (x.pname || x.title) : 'a private project'} (${STAGE_WORD[x.status] || x.status})` };
  } else {
    const recent = db.get(`SELECT last_error FROM jobs WHERE type = 'evaluate' AND status = 'queued' AND updated_at > ?
      AND (last_error LIKE 'brain asleep%' OR last_error LIKE 'brain unavailable%') ORDER BY updated_at DESC LIMIT 1`, now() - 30 * 60_000);
    const state = !cfg.brain.url || !cfg.brain.secret ? 'offline' : recent?.last_error.startsWith('brain asleep') ? 'asleep' : recent ? 'offline' : 'idle';
    sub01 = { state, ideaId: null, plotId: null, stage: null,
      text: { idle: 'SUB-01 is in his room', asleep: 'SUB-01 is asleep', offline: 'SUB-01\'s brain is offline' }[state] };
  }

  // last 20 public events, never from a private idea or project
  const news = db.all(`SELECT e.at, e.kind, e.message, i.id idea_id, COALESCE(p.name, v.title) name, pl.plot_id
    FROM events e LEFT JOIN projects pe ON pe.id = e.project_id
    LEFT JOIN ideas i ON i.id = COALESCE(e.idea_id, pe.idea_id)
    LEFT JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version LEFT JOIN projects p ON p.idea_id = i.id
    LEFT JOIN plots pl ON pl.idea_id = i.id
    WHERE e.public = 1 AND (e.idea_id IS NULL OR i.visibility = 'public') AND (e.project_id IS NULL OR i.visibility = 'public')
    ORDER BY e.id DESC LIMIT 20`).map((e) => ({ at: e.at, kind: e.kind, plotId: e.plot_id ?? (e.kind === 'resident' ? residentPlot(e.message) : null),
    text: scrub(e.name ? `${e.name}: ${e.message}` : e.message) }));
  return { now: now(), sub01, plots, news };
}

const residentPlot = (msg) => msg.match(/ (?:into|to) ([a-z]+-[1-6])$/)?.[1] ?? null;
