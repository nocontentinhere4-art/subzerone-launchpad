// The shared city: 48 Tokyo districts × 6 plots (a 7×7 grid around the hero block; the third ring was appended in
// wave 4A so the first 24 districts and their 144 plot ids keep their order). A plot is claimed once, first come first
// served, either as a resident's apartment or as a project's building (reserved with the idea). Claims are rows in
// `plots`; the primary key makes a double claim impossible even across processes. Everything returned by worldView() is public.
import { audit } from './db.js';
import { LABELS } from './states.js';
import { jstDate } from './calendar.js';
import { now, HttpError, parseJson, utcDay } from './util.js';

export const DISTRICTS = ['shiba', 'shinjuku', 'akihabara', 'shibuya', 'harajuku', 'nakameguro', 'ebisu', 'roppongi', 'ginza',
  'asakusa', 'ueno', 'ikebukuro', 'nakano', 'kanda', 'tsukiji', 'odaiba', 'yoyogi', 'meguro', 'shinagawa', 'sumida',
  'daikanyama', 'nihonbashi', 'koenji', 'shimokitazawa',
  // third ring (wave 4A), the same order as the city client's city-state.js RING3
  'kiyosumi', 'ryogoku', 'oshiage', 'yanaka', 'sugamo', 'takadanobaba', 'ogikubo', 'kinshicho', 'kichijoji', 'ochanomizu',
  'kagurazaka', 'toyosu', 'omotesando', 'gotanda', 'jiyugaoka', 'tsukishima', 'sangenjaya', 'kitasenju', 'nippori', 'aoyama',
  'shinbashi', 'akasaka', 'iidabashi', 'mejiro'];
export const PLOTS_PER_DISTRICT = 6;
export const PLOT_IDS = DISTRICTS.flatMap((d) => Array.from({ length: PLOTS_PER_DISTRICT }, (_, i) => `${d}-${i + 1}`));
const PLOT_SET = new Set(PLOT_IDS);
// Reserved plots (owner 2026-10-10): the two Shiba plots either side of Tokyo Tower are its park. The ids stay (288 ids,
// nothing renumbered) but they cannot be claimed any more; a row that already claims one is left alone.
export const RESERVED_PLOTS = new Set(['shiba-2', 'shiba-5']);
export const RESERVED_PLOT_IDS = [...RESERVED_PLOTS];

export const LOOK = Object.freeze({
  skin: ['#f6d5b8', '#e8b48f', '#c98e66', '#a26a45', '#7a4a2e', '#4f3020'],
  hair: ['#1b1b1b', '#3b2a20', '#6b4428', '#a87443', '#d9b26f', '#b23a2e', '#e8e8e8', '#4a6cd4'],
  hairStyle: ['short', 'long', 'bun', 'buzz', 'curly'],
  outfit: ['hoodie', 'jacket', 'tee', 'suit'],
});
export const FREE_COLORS = ['top', 'bottom'];          // any #rrggbb
const HEX = /^#[0-9a-f]{6}$/;
export const NAME = { min: 2, max: 24 };
// look v2: up to 4 accessories (one shared colour) and an optional pet; traits drive the resident's public autonomy
export const ACCESSORIES = ['glasses', 'sunglasses', 'cap', 'beanie', 'headphones', 'backpack', 'scarf', 'mask', 'halo', 'crown',
  'cat_ears', 'antenna', 'wings', 'jetpack'];
export const MAX_ACCESSORIES = 4;
export const PETS = ['cat', 'dog', 'robot', 'duck', 'slime', 'dragon'];
export const PET_NAME = { min: 1, max: 12 };
export const TRAITS = ['neat', 'outgoing', 'active', 'playful', 'nice'];
export const DEFAULT_TRAITS = Object.freeze(Object.fromEntries(TRAITS.map((k) => [k, 0.5])));

// Unlock tiers, earned through the project pipeline. Each tier lists what it adds; a tier includes all lower ones.
export const TIERS = ['resident', 'builder', 'founder', 'launched'];
export const UNLOCKS = Object.freeze({
  tiers: TIERS,
  items: { resident: ['skateboard', 'plushPile', 'posterCustom', 'neonSign'], builder: ['consoleTv', 'arcadeCabinet', 'karaokeMic', 'discoBall'],
    founder: ['turntable', 'aquarium', 'trophyIdea', 'trophySite'], launched: ['neonTicker', 'trophyLaunch', 'fireworksBox', 'goldToilet'] },
  emotes: { resident: ['wave', 'sit', 'think', 'sleep', 'dance'], builder: ['facepalm', 'cook', 'selfie'], founder: ['karaoke', 'skate'],
    launched: ['celebrate', 'moonwalk'] },
  accessories: { resident: ['glasses', 'sunglasses', 'cap', 'beanie', 'headphones', 'backpack', 'scarf', 'mask'], builder: ['cat_ears', 'antenna'],
    founder: ['halo', 'wings'], launched: ['crown', 'jetpack'] },
  pets: { resident: ['cat', 'dog', 'duck'], builder: ['slime', 'robot'], founder: [], launched: ['dragon'] },
});

// Room schema v2: Kenney Furniture Kit pieces (CC0) by name, grouped for the editor's catalog drawer.
export const ROOM_CATALOG = Object.freeze({
  sleep: ['bedSingle', 'bedDouble', 'cabinetBed', 'cabinetBedDrawerTable', 'pillow', 'pillowBlue', 'bear'],
  work: ['desk', 'deskCorner', 'chairDesk', 'computerScreen', 'computerKeyboard', 'computerMouse', 'laptop'],
  sit: ['chair', 'chairCushion', 'loungeSofa', 'loungeChair', 'loungeDesignSofa'],
  storage: ['bookcaseOpen', 'bookcaseOpenLow', 'bookcaseClosedWide', 'books', 'sideTableDrawers', 'cabinetTelevision',
    'coatRackStanding', 'cardboardBoxClosed', 'cardboardBoxOpen'],
  kitchen: ['kitchenFridgeSmall', 'kitchenFridge', 'kitchenMicrowave', 'kitchenCoffeeMachine', 'washer', 'trashcan'],
  light: ['lampRoundFloor', 'lampSquareFloor', 'lampRoundTable', 'lampWall', 'ceilingFan'],
  plants: ['pottedPlant', 'plantSmall1', 'plantSmall2', 'plantSmall3'],
  decor: ['rugRectangle', 'rugRound', 'rugSquare', 'rugDoormat', 'tableCoffee', 'sideTable', 'televisionModern',
    'speaker', 'speakerSmall', 'radio'],
  structure: ['wallWindow', 'wallWindowSlide', 'doorway', 'doorwayFront'],
  special: Object.values(UNLOCKS.items).flat(),          // unlocked by tier (unlocksFor)
});
// v1 rooms stored these generic names; they are read (and still accepted on save) as their Kenney equivalents.
export const LEGACY_ITEMS = Object.freeze({ bed: 'bedSingle', desk: 'desk', chair: 'chairDesk', couch: 'loungeSofa',
  shelf: 'bookcaseOpen', lamp: 'lampRoundFloor', plant: 'pottedPlant', rug: 'rugRectangle', table: 'tableCoffee' });
export const ROOM = Object.freeze({
  floor: ['white_oak', 'honey_oak', 'walnut', 'smoked_oak', 'concrete', 'tatami',
    'birch', 'cherry', 'herringbone', 'black_ash', 'tatami_green', 'tile_white', 'tile_slate', 'tile_terracotta'],
  walls: ['chalk', 'sand', 'sage', 'navy', 'terracotta', 'concrete', 'cream', 'blush', 'sky', 'forest'],
  accent: ['navy', 'linen', 'rust', 'olive', 'charcoal', 'blush', 'denim', 'sakura', 'mustard', 'teal'],
  window: ['city_day', 'city_night', 'sakura', 'rain'],
  lighting: ['morning', 'midday', 'evening', 'night'],
  daylight: [0, 1],                                     // optional slider position through the four presets
  catalog: ROOM_CATALOG,
  items: Object.values(ROOM_CATALOG).flat(),
  wallItems: ['wallWindow', 'wallWindowSlide', 'doorway', 'doorwayFront', 'lampWall'],   // need wall: 'left' | 'back'
  wallSides: ['left', 'back'],
  rot: [0, 90, 180, 270],
  coord: [-3.5, 3.5],                                   // x and z, metres from the room centre
  y: [0, 2.5],                                          // optional lift, e.g. a monitor on a desk
  maxFurniture: 40,
});
const ITEM_SET = new Set(ROOM.items), WALL_ITEMS = new Set(ROOM.wallItems);
export const TEXT_ITEMS = ['posterCustom', 'neonTicker'];   // accept `text` (≤ 12 characters; neonTicker: one of your tickers)
export const ITEM_TEXT_MAX = 12;
// The SUB-01 studio: bed under the window on the left wall, desk + gaming chair in the corner, bookcase, small fridge
// and the front door on the back wall, rug in the middle.
export const DEFAULT_ROOM = Object.freeze({
  materials: { floor: 'honey_oak', walls: 'chalk', accent: 'denim' },
  lighting: 'morning',
  window: 'city_day',
  furniture: [
    { item: 'wallWindow', x: -3.5, z: 1.25, rot: 90, wall: 'left' },
    { item: 'doorway', x: 2.5, z: -3.5, rot: 0, wall: 'back' },
    { item: 'bedDouble', x: -2.41, z: 1.3, rot: 90 },
    { item: 'desk', x: -2.6, z: -3.06, rot: 0 },
    { item: 'computerScreen', x: -2.6, z: -3.25, rot: 0, y: 0.74 },
    { item: 'computerKeyboard', x: -2.6, z: -2.9, rot: 0, y: 0.74 },
    { item: 'lampRoundTable', x: -3.1, z: -3.2, rot: 0, y: 0.74 },
    { item: 'plantSmall2', x: -2.05, z: -3.2, rot: 0, y: 0.74 },
    { item: 'chairDesk', x: -2.6, z: -2.25, rot: 180 },
    { item: 'pottedPlant', x: -3.15, z: -1.55, rot: 0 },
    { item: 'trashcan', x: -1.6, z: -3.2, rot: 0 },
    { item: 'bookcaseOpen', x: -0.9, z: -3.24, rot: 0 },
    { item: 'books', x: -0.95, z: -3.24, rot: 0, y: 1.7 },
    { item: 'kitchenFridgeSmall', x: 0.15, z: -3.2, rot: 0 },
    { item: 'kitchenCoffeeMachine', x: 0.15, z: -3.2, rot: 0, y: 1.16 },
    { item: 'coatRackStanding', x: 1.25, z: -3.1, rot: 0 },
    { item: 'rugDoormat', x: 2.5, z: -2.9, rot: 0 },
    { item: 'rugRectangle', x: 0.25, z: 0.9, rot: 90 },
    { item: 'lampRoundFloor', x: 3.15, z: 1.2, rot: 0 },
    { item: 'cardboardBoxClosed', x: 3.1, z: -0.6, rot: 0 },
    { item: 'cardboardBoxOpen', x: 3.05, z: -0.6, rot: 90, y: 0.54 },
  ],
});

const round2 = (v) => Math.round(v * 100) / 100;
export function validateRoom(room) {
  const bad = (m) => new HttpError(400, 'bad_room', m);
  if (!room || typeof room !== 'object' || Array.isArray(room)) throw bad('room must be an object');
  const extra = Object.keys(room).filter((k) => !['materials', 'lighting', 'daylight', 'window', 'furniture'].includes(k));
  if (extra.length) throw bad(`unknown room field ${extra[0].slice(0, 20)}`);
  const m = room.materials;
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some((k) => !['floor', 'walls', 'accent'].includes(k))) throw bad('materials: {floor, walls, accent}');
  for (const k of ['floor', 'walls', 'accent']) if (!ROOM[k].includes(m[k])) throw bad(`materials.${k}: one of ${ROOM[k].join(', ')}`);
  if (!ROOM.lighting.includes(room.lighting)) throw bad(`lighting: one of ${ROOM.lighting.join(', ')}`);
  if (room.daylight !== undefined && (typeof room.daylight !== 'number' || !Number.isFinite(room.daylight) || room.daylight < 0 || room.daylight > 1)) throw bad('daylight: a number from 0 (morning) to 1 (night)');
  const view = room.window ?? ROOM.window[0];
  if (!ROOM.window.includes(view)) throw bad(`window: one of ${ROOM.window.join(', ')}`);
  if (!Array.isArray(room.furniture) || room.furniture.length > ROOM.maxFurniture) throw bad(`furniture: an array of at most ${ROOM.maxFurniture}`);
  const inRange = (v) => typeof v === 'number' && Number.isFinite(v) && v >= ROOM.coord[0] && v <= ROOM.coord[1];
  const furniture = room.furniture.map((f) => {
    if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some((k) => !['item', 'x', 'z', 'rot', 'y', 'wall', 'text'].includes(k))) throw bad('furniture entries: {item, x, z, rot, y?, wall?, text?}');
    const item = typeof f.item === 'string' && Object.hasOwn(LEGACY_ITEMS, f.item) ? LEGACY_ITEMS[f.item] : f.item;
    if (!ITEM_SET.has(item)) throw bad('furniture item: one of room.items (see /api/world/options)');
    if (!inRange(f.x) || !inRange(f.z)) throw bad(`furniture x and z: numbers from ${ROOM.coord[0]} to ${ROOM.coord[1]}`);
    if (!ROOM.rot.includes(f.rot)) throw bad('furniture rot: 0, 90, 180 or 270');
    const out = { item, x: round2(f.x), z: round2(f.z), rot: f.rot };
    if (f.y !== undefined) {
      if (typeof f.y !== 'number' || !Number.isFinite(f.y) || f.y < ROOM.y[0] || f.y > ROOM.y[1]) throw bad(`furniture y: a number from ${ROOM.y[0]} to ${ROOM.y[1]}`);
      if (round2(f.y) > 0) out.y = round2(f.y);
    }
    if (WALL_ITEMS.has(item)) {
      if (!ROOM.wallSides.includes(f.wall)) throw bad(`${item} hangs on a wall: wall 'left' or 'back'`);
      out.wall = f.wall;
    } else if (f.wall !== undefined) throw bad(`${item} cannot hang on a wall`);
    if (f.text !== undefined) {
      if (!TEXT_ITEMS.includes(item)) throw bad(`${item} has no text`);
      const t = typeof f.text === 'string' ? cleanText(f.text) : null;
      if (t == null || [...t].length > ITEM_TEXT_MAX) throw bad(`${item} text: at most ${ITEM_TEXT_MAX} characters`);
      if (t) out.text = item === 'neonTicker' ? t.toUpperCase() : t;
    }
    return out;
  });
  return { materials: { floor: m.floor, walls: m.walls, accent: m.accent }, lighting: room.lighting,
    ...(room.daylight !== undefined ? { daylight: round2(room.daylight) } : {}), window: view, furniture };
}

/** Stored rooms are read through this: v1 rooms (generic item names, no window) come back as v2. Anything that no
 * longer validates falls back to the default room rather than breaking the visit. */
export function upgradeRoom(stored) {
  if (!stored) return DEFAULT_ROOM;
  try { return validateRoom(stored); } catch { return DEFAULT_ROOM; }
}

export function saveRoom(db, wallet, room) {
  const v = validateRoom(room);
  if (!db.get('SELECT 1 FROM residents WHERE wallet = ?', wallet)) throw new HttpError(409, 'no_resident', 'create your resident first (POST /api/residents)');
  const u = unlocksFor(db, wallet);
  refuseLocked(v.furniture.map((f) => f.item).filter((i) => SPECIAL.has(i) && !u.items.includes(i)));
  const tickers = v.furniture.some((f) => f.item === 'neonTicker') ? publicTickers(db, wallet) : [];
  for (const f of v.furniture) {
    if (f.item !== 'neonTicker') continue;
    f.text ??= tickers[0];                          // the oldest launched project's ticker (launched tier: there is one)
    if (!tickers.includes(f.text)) throw new HttpError(400, 'bad_room', `neonTicker text: one of your public project tickers (${tickers.join(', ') || 'none'})`);
  }
  db.run('UPDATE residents SET room_json = ?, updated_at = ? WHERE wallet = ?', JSON.stringify(v), now(), wallet);
  return v;
}

const SPECIAL = new Set(ROOM_CATALOG.special);
const refuseLocked = (names) => {
  if (names.length) throw new HttpError(403, 'locked', `not unlocked yet: ${[...new Set(names)].join(', ')}`, { locked: [...new Set(names)] });
};
/** Tickers of the wallet's public projects, launched ones first (oldest first). */
const publicTickers = (db, wallet) => db.all(`SELECT p.ticker FROM projects p JOIN ideas i ON i.id = p.idea_id LEFT JOIN launches l ON l.project_id = p.id
  WHERE i.owner_wallet = ? AND i.visibility = 'public' ORDER BY l.verified_at IS NULL, l.verified_at, p.created_at`, wallet).map((x) => String(x.ticker).toUpperCase());

// pipeline stages at or after "selected" / "preview_ready" (states.js)
const BUILDER_STAGES = ['selected', 'generating', 'preview_ready', 'approved', 'launch_prepared', 'awaiting_signature', 'confirming', 'launched'];
const FOUNDER_STAGES = BUILDER_STAGES.slice(2);
const inList = (xs) => xs.map((x) => `'${x}'`).join(',');

/** Index into TIERS of the highest tier the wallet reached (-1: none). Reached once = kept: a later cancel does not
 * take it back (the status history in `events`, the built site and the launch stay on record). publicOnly counts public ideas only, for
 * views other people see (a private idea must not be linkable to a person). */
function tierIndex(db, wallet, { publicOnly = false } = {}) {
  const vis = publicOnly ? `AND i.visibility = 'public'` : '';
  const has = (sql) => Boolean(db.get(`SELECT 1 x FROM ideas i LEFT JOIN projects p ON p.idea_id = i.id WHERE i.owner_wallet = ? ${vis} AND (${sql}) LIMIT 1`, wallet));
  if (has(`i.status = 'launched' OR EXISTS (SELECT 1 FROM launches l WHERE l.project_id = p.id)`)) return 3;
  const reached = (stages) => `i.status IN (${inList(stages)}) OR EXISTS (SELECT 1 FROM events e WHERE e.idea_id = i.id AND e.kind = 'status'
    AND json_extract(e.data_json, '$.to') IN (${inList(stages)}))`;
  if (has(`${reached(FOUNDER_STAGES)} OR p.live_site_version IS NOT NULL`)) return 2;
  if (has(reached(BUILDER_STAGES))) return 1;
  return db.get('SELECT 1 x FROM residents WHERE wallet = ?', wallet) ? 0 : -1;
}

const unlocksAt = (idx) => {
  const upTo = TIERS.slice(0, idx + 1);
  const pick = (k) => upTo.flatMap((t) => UNLOCKS[k][t]);
  return { tier: TIERS[idx] ?? null, items: pick('items'), emotes: pick('emotes'), accessories: pick('accessories'), pets: pick('pets') };
};
/** What the wallet has unlocked: { tier: 'resident'|'builder'|'founder'|'launched'|null, items, emotes, accessories, pets }. */
export const unlocksFor = (db, wallet, opts) => unlocksAt(tierIndex(db, wallet, opts));

/** Public: the interior behind a plot. Apartments show their resident; a project plot shows its submitter's room
 * only once the idea is public (a private idea must not be linkable to a person). */
export function roomView(db, plotId) {
  validatePlotId(plotId);
  const pl = db.get('SELECT pl.*, i.visibility FROM plots pl LEFT JOIN ideas i ON i.id = pl.idea_id WHERE pl.plot_id = ?', plotId);
  if (!pl || (pl.kind === 'project' && pl.visibility !== 'public')) return null;
  const r = db.get('SELECT * FROM residents WHERE wallet = ?', pl.wallet);
  if (!r) return null;
  const room = upgradeRoom(parseJson(r.room_json));
  if (room.furniture.some((f) => f.item === 'neonTicker')) {      // a project made private since: its ticker is not shown
    const tickers = publicTickers(db, pl.wallet);
    room.furniture = room.furniture.filter((f) => f.item !== 'neonTicker' || tickers.includes(f.text));
  }
  const guestbook = db.all(`SELECT g.id, COALESCE(r.name, 'Visitor') name, g.text, g.created_at at FROM guestbook g LEFT JOIN residents r ON r.wallet = g.wallet
    WHERE g.plot_id = ? AND g.created_at >= ? ORDER BY g.id DESC LIMIT ?`, plotId, pl.claimed_at, GUESTBOOK.keep);
  const visits = db.get('SELECT COUNT(DISTINCT wallet) n FROM guestbook WHERE plot_id = ? AND created_at >= ?', plotId, pl.claimed_at).n;
  return { plotId, kind: pl.kind, owner: { name: r.name, look: readLook(r.look_json), traits: readTraits(r.traits_json) }, room,
    guestbook, visits, unlocks: unlocksFor(db, pl.wallet, { publicOnly: true }) };
}

// --- guestbook: visitors' notes in a room (never the visitor's wallet; entries from before the current claim are hidden) -
export const GUESTBOOK = { max: 80, keep: 50, perPlotMs: 60_000, perDay: 20 };

/** The plot whose room a visitor can see (roomView rules), with its owner wallet; 404 otherwise. */
function visitablePlot(db, plotId) {
  validatePlotId(plotId);
  const pl = db.get(`SELECT pl.plot_id, pl.wallet, pl.kind, pl.claimed_at, i.visibility FROM plots pl LEFT JOIN ideas i ON i.id = pl.idea_id
    JOIN residents r ON r.wallet = pl.wallet WHERE pl.plot_id = ?`, plotId);
  if (!pl || (pl.kind === 'project' && pl.visibility !== 'public')) throw new HttpError(404, 'not_found', 'nobody lives there (or it is private)');
  return pl;
}

export function postGuestbook(db, wallet, plotId, text) {
  const pl = visitablePlot(db, plotId);
  if (pl.wallet === wallet) throw new HttpError(403, 'own_room', 'you cannot sign your own guestbook');
  if (!db.get('SELECT 1 FROM residents WHERE wallet = ?', wallet)) throw new HttpError(409, 'no_resident', 'create your resident first (POST /api/residents)');
  const c = typeof text === 'string' ? cleanText(text) : '';
  if (!c || [...c].length > GUESTBOOK.max) throw new HttpError(400, 'bad_text', `1–${GUESTBOOK.max} characters`);
  const t = scrub(c);                                // an address-like string is shortened, as in the news
  const at = now(), day = utcDay(at);
  return db.tx(() => {
    const last = db.get('SELECT MAX(last_at) t FROM guestbook_quota WHERE wallet = ? AND plot_id = ?', wallet, plotId).t;
    if (last && at - last < GUESTBOOK.perPlotMs) throw new HttpError(429, 'rate_limited', 'one note per room per minute', { retryAfterS: Math.ceil((GUESTBOOK.perPlotMs - (at - last)) / 1000) });
    if (db.get('SELECT COALESCE(SUM(n), 0) n FROM guestbook_quota WHERE wallet = ? AND day = ?', wallet, day).n >= GUESTBOOK.perDay) {
      throw new HttpError(429, 'rate_limited', `at most ${GUESTBOOK.perDay} notes a day`, { retryAfterS: Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - at) / 1000) });
    }
    db.run(`INSERT INTO guestbook_quota (wallet, plot_id, day, n, last_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(wallet, day, plot_id) DO UPDATE SET n = n + 1, last_at = excluded.last_at`, wallet, plotId, day, at);
    db.run('DELETE FROM guestbook_quota WHERE day < ?', utcDay(at - 86_400_000));
    const id = Number(db.run('INSERT INTO guestbook (plot_id, wallet, text, created_at) VALUES (?, ?, ?, ?)', plotId, wallet, t, at).lastInsertRowid);
    db.run('DELETE FROM guestbook WHERE plot_id = ? AND id NOT IN (SELECT id FROM guestbook WHERE plot_id = ? ORDER BY id DESC LIMIT ?)', plotId, plotId, GUESTBOOK.keep);
    const name = db.get('SELECT name FROM residents WHERE wallet = ?', wallet).name;
    return { id, name, text: t, at };
  });
}

/** The room's owner or the note's author may remove a note. */
export function deleteGuestbook(db, wallet, plotId, id) {
  validatePlotId(plotId);
  const g = db.get('SELECT g.wallet, pl.wallet owner FROM guestbook g LEFT JOIN plots pl ON pl.plot_id = g.plot_id WHERE g.id = ? AND g.plot_id = ?', Number(id) || 0, plotId);
  if (!g) throw new HttpError(404, 'not_found');
  if (g.wallet !== wallet && g.owner !== wallet) throw new HttpError(403, 'forbidden', 'only the room\'s owner or the author can remove a note');
  db.run('DELETE FROM guestbook WHERE id = ?', Number(id));
}

export const PROGRESS = { submitted: 0.05, evaluating: 0.12, selected: 0.2, generating: 0.45, preview_ready: 0.65, approved: 0.75,
  launch_prepared: 0.82, awaiting_signature: 0.88, confirming: 0.94, launched: 1, failed: 0, declined: 0, cancelled: 0 };
// generate-job progress texts (pipeline.js) -> a finer position inside 'generating'
const GEN_STEPS = { 'writing the project identity': 0.5, 'building the website in the sandbox': 0.58 };

/** A known plot id. With `claim`, a reserved plot (the tower park) is refused too: it can be read but never claimed. */
export function validatePlotId(plotId, { claim = false } = {}) {
  if (typeof plotId !== 'string' || !PLOT_SET.has(plotId)) throw new HttpError(400, 'bad_plot', 'unknown plot (see /api/world/options)');
  if (claim && RESERVED_PLOTS.has(plotId)) throw new HttpError(400, 'plot_reserved', `${plotId} is part of the Tokyo Tower park (see /api/world/options.reservedPlotIds)`);
  return plotId;
}

export function validateLook(look) {
  const bad = (m) => new HttpError(400, 'bad_look', m);
  if (!look || typeof look !== 'object' || Array.isArray(look)) throw bad('look must be an object');
  const keys = [...Object.keys(LOOK), ...FREE_COLORS, 'accessories', 'accessoryColor', 'pet'];
  const extra = Object.keys(look).filter((k) => !keys.includes(k));
  if (extra.length) throw bad(`unknown look field ${extra[0].slice(0, 20)}`);
  const out = {};
  for (const [k, allowed] of Object.entries(LOOK)) {
    const v = typeof look[k] === 'string' ? look[k].toLowerCase() : look[k];
    if (!allowed.includes(v)) throw bad(`${k}: one of ${allowed.join(', ')}`);
    out[k] = v;
  }
  const hex = (v, k) => { const c = typeof v === 'string' ? v.toLowerCase() : ''; if (!HEX.test(c)) throw bad(`${k}: a #rrggbb colour`); return c; };
  for (const k of FREE_COLORS) out[k] = hex(look[k], k);
  const acc = look.accessories ?? [];
  if (!Array.isArray(acc) || acc.length > MAX_ACCESSORIES || acc.some((a) => !ACCESSORIES.includes(a)) || new Set(acc).size !== acc.length) {
    throw bad(`accessories: up to ${MAX_ACCESSORIES} different ones of ${ACCESSORIES.join(', ')}`);
  }
  out.accessories = [...acc];
  out.accessoryColor = look.accessoryColor == null ? null : hex(look.accessoryColor, 'accessoryColor');
  const pet = look.pet ?? null;
  if (pet !== null) {
    if (typeof pet !== 'object' || Array.isArray(pet) || Object.keys(pet).some((k) => !['kind', 'color', 'name'].includes(k))) throw bad('pet: null or {kind, color, name}');
    if (!PETS.includes(pet.kind)) throw bad(`pet.kind: one of ${PETS.join(', ')}`);
    out.pet = { kind: pet.kind, color: hex(pet.color, 'pet.color'), name: cleanName(pet.name, PET_NAME, 'bad_look', 'pet.name: ') };
  } else out.pet = null;
  return out;
}

/** Stored looks are read through this: looks saved before v2 get no accessories and no pet. */
export function readLook(json) {
  const l = parseJson(json) || {};
  return { ...l, accessories: l.accessories ?? [], accessoryColor: l.accessoryColor ?? null, pet: l.pet ?? null };
}

/** {neat, outgoing, active, playful, nice}: numbers 0..1, rounded to 0.01; a missing key is 0.5. */
export function validateTraits(traits) {
  const bad = (m) => new HttpError(400, 'bad_traits', m);
  if (!traits || typeof traits !== 'object' || Array.isArray(traits)) throw bad('traits must be an object');
  const extra = Object.keys(traits).filter((k) => !TRAITS.includes(k));
  if (extra.length) throw bad(`unknown trait ${extra[0].slice(0, 20)} (traits: ${TRAITS.join(', ')})`);
  return Object.fromEntries(TRAITS.map((k) => {
    const v = traits[k] ?? 0.5;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw bad(`${k}: a number from 0 to 1`);
    return [k, round2(v)];
  }));
}
export const readTraits = (json) => { try { return validateTraits(parseJson(json) || {}); } catch { return { ...DEFAULT_TRAITS }; } };

function cleanName(name, { min, max }, code, prefix = '') {
  const v = String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (v.length < min || v.length > max || !/^[\p{L}\p{N} ._'-]+$/u.test(v)) {
    throw new HttpError(400, code, `${prefix}${min}–${max} letters, digits, spaces or . _ ' -`);
  }
  return v;
}
/** SUB-01's own names: a resident cannot take them (the city chat shows resident names next to his). */
export const reservedName = (name) => { const k = String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  return k === 'sub1' || k.startsWith('sub01') || k.startsWith('subzerone'); };
export const validateName = (name) => {
  const v = cleanName(name, NAME, 'bad_name');
  if (reservedName(v)) throw new HttpError(400, 'bad_name', 'that name is reserved for SUB-01');
  return v;
};

/** Free text (guestbook notes, poster text): NFKC, no control or bidi characters, no < > `, whitespace collapsed.
 * Emoji stay. Length limits count code points. */
export const cleanText = (s) => String(s).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff<>`]/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Inside a transaction: claim a free plot or 409. The pre-check gives a clear error; the primary key is the guard. */
export function claimPlot(db, { plotId, kind, wallet, ideaId = null }) {
  validatePlotId(plotId, { claim: true });
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
  const traits = input.traits === undefined ? null : validateTraits(input.traits);
  const plotId = input.plotId == null ? null : validatePlotId(input.plotId);
  // a wallet creating its resident counts as a resident already
  const u = unlocksAt(Math.max(0, tierIndex(db, wallet)));
  refuseLocked([...look.accessories.filter((a) => !u.accessories.includes(a)), ...(look.pet && !u.pets.includes(look.pet.kind) ? [look.pet.kind] : [])]);
  const t = now();
  return db.tx(() => {
    const cur = db.get('SELECT * FROM residents WHERE wallet = ?', wallet);
    if (!cur && !plotId) throw new HttpError(400, 'bad_plot', 'choose an apartment plot');
    const target = plotId || cur.plot_id;
    const traitsJson = traits ? JSON.stringify(traits) : cur?.traits_json ?? JSON.stringify(DEFAULT_TRAITS);   // omitted = keep
    if (cur && target !== cur.plot_id) {
      claimPlot(db, { plotId: target, kind: 'apartment', wallet });
      db.run('UPDATE residents SET name = ?, look_json = ?, traits_json = ?, plot_id = ?, updated_at = ? WHERE wallet = ?', name, JSON.stringify(look), traitsJson, target, t, wallet);
      db.run(`DELETE FROM plots WHERE plot_id = ? AND kind = 'apartment' AND wallet = ?`, cur.plot_id, wallet);
      audit(db, { actor: `wallet:${wallet}`, kind: 'resident', isPublic: true, message: `${name} moved to ${target}`, data: { from: cur.plot_id, to: target } });
    } else if (cur) {
      db.run('UPDATE residents SET name = ?, look_json = ?, traits_json = ?, updated_at = ? WHERE wallet = ?', name, JSON.stringify(look), traitsJson, t, wallet);
    } else {
      claimPlot(db, { plotId: target, kind: 'apartment', wallet });
      db.run('INSERT INTO residents (wallet, name, look_json, traits_json, plot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', wallet, name, JSON.stringify(look), traitsJson, target, t, t);
      audit(db, { actor: `wallet:${wallet}`, kind: 'resident', isPublic: true, message: `${name} moved into ${target}`, data: { to: target } });
    }
    return residentOf(db, wallet);
  });
}

export function residentOf(db, wallet) {
  const r = db.get('SELECT * FROM residents WHERE wallet = ?', wallet);
  return r && { name: r.name, look: readLook(r.look_json), traits: readTraits(r.traits_json), plotId: r.plot_id, room: upgradeRoom(parseJson(r.room_json)),
    points: r.points ?? 0, createdAt: r.created_at, updatedAt: r.updated_at };
}

export const plotsOf = (db, wallet) => db.all('SELECT plot_id plotId, kind, idea_id ideaId, claimed_at claimedAt FROM plots WHERE wallet = ? ORDER BY claimed_at', wallet);

/** first4…last4: enough to recognise a wallet, not to copy it. */
export const shortWallet = (w) => (w && w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);
export const scrub = (text) => String(text).replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, shortWallet);

const JOB_VERBS = { evaluate: 'Thinking about', generate: 'Building', build_site: 'Rebuilding the site of', prepare_launch: 'Preparing the launch of',
  confirm_launch: 'Watching the launch of', reconcile_fees: 'Counting the fees of', publish_x_post: 'Posting for' };
const STAGE_WORD = { submitted: 'dropped', evaluating: 'reading', selected: 'selected', generating: 'building', preview_ready: 'preview',
  approved: 'approved', launch_prepared: 'launch ready', awaiting_signature: 'signature', confirming: 'confirming', launched: 'launched' };

/** The public city snapshot. Private ideas show as 'Private project' with stage only; no wallet ever appears. */
export function worldView(db, cfg, t = now()) {
  const genProgress = new Map(db.all(`SELECT idea_id, progress FROM jobs WHERE type = 'generate' AND status = 'running' AND idea_id IS NOT NULL`)
    .map((j) => [j.idea_id, j.progress]));
  const projectOf = (x) => {
    const stage = x.status;
    let progress = PROGRESS[stage] ?? 0;
    if (stage === 'generating' && GEN_STEPS[genProgress.get(x.idea_id)]) progress = GEN_STEPS[genProgress.get(x.idea_id)];
    const base = { stage, stageLabel: LABELS[stage] || stage, progress };
    // ideaId: the key the city uses for /api/predictions/:ideaId and /api/ema/:ideaId/cheer. Public ideas only; a private
    // project's id is never sent (the placeholder carries null).
    if (x.visibility !== 'public') return { ideaId: null, slug: null, name: 'Private project', ticker: null, ...base, launched: false, mint: null, logoUrl: null, bannerUrl: null };
    const launched = stage === 'launched' && Boolean(x.mint);
    // the same public, immutable /meta/<slug>/… files the token metadata links to (app.js serves them for public ideas only)
    const asset = (kind, v, ext) => (x.slug && v ? `/meta/${x.slug}/${kind}-v${v}.${ext}` : null);
    return { ideaId: x.idea_id, slug: x.slug || null, name: x.pname || x.title, ticker: x.ticker || x.ticker_suggestion || null, ...base, launched, mint: launched ? x.mint : null,
      logoUrl: asset('logo', x.logo_v, 'png'), bannerUrl: asset('banner', x.banner_v, 'svg') };
  };
  const rows = db.all(`SELECT pl.plot_id, pl.kind, pl.idea_id, r.name rname, r.look_json, r.traits_json, f.buff, i.status, i.visibility, v.title, v.ticker_suggestion,
      p.slug, p.name pname, p.ticker, l.mint,
      (SELECT MAX(version) FROM assets a WHERE a.project_id = p.id AND a.kind = 'logo') logo_v,
      (SELECT MAX(version) FROM assets a WHERE a.project_id = p.id AND a.kind = 'banner') banner_v
    FROM plots pl LEFT JOIN residents r ON r.plot_id = pl.plot_id LEFT JOIN ideas i ON i.id = pl.idea_id
    LEFT JOIN fortunes f ON f.wallet = r.wallet AND f.date = ? AND f.until > ? AND f.buff != 'none'
    LEFT JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
    LEFT JOIN projects p ON p.idea_id = i.id LEFT JOIN launches l ON l.project_id = p.id ORDER BY pl.claimed_at`, jstDate(t), t);
  const plots = rows.map((x) => ({ plotId: x.plot_id, kind: x.kind, ...(RESERVED_PLOTS.has(x.plot_id) ? { reserved: true } : {}),
    // buff: today's omikuji effect (cosmetic, kind only; rituals.js), null when none is active
    resident: x.kind === 'apartment' && x.rname ? { name: x.rname, look: readLook(x.look_json), traits: readTraits(x.traits_json), buff: x.buff || null } : null,
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
  return { now: now(), sub01, plots, reservedPlots: RESERVED_PLOT_IDS, news, events: cityEvents(db) };
}

// status changes the city celebrates (fireworks, street parties): the first time an idea reaches each of them
const EVENT_KINDS = { selected: 'accepted', preview_ready: 'site_live', launched: 'launched' };
/** Last 24 h, newest first, at most 30, public ideas only. */
export function cityEvents(db, since = now() - 86_400_000) {
  return db.all(`SELECT e.at, json_extract(e.data_json, '$.to') st, pl.plot_id, COALESCE(p.name, v.title) name, COALESCE(p.ticker, v.ticker_suggestion) ticker
    FROM events e JOIN ideas i ON i.id = e.idea_id JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
    LEFT JOIN projects p ON p.idea_id = i.id LEFT JOIN plots pl ON pl.idea_id = i.id
    WHERE e.kind = 'status' AND e.at > ? AND i.visibility = 'public' AND json_extract(e.data_json, '$.to') IN ('selected', 'preview_ready', 'launched')
      AND NOT EXISTS (SELECT 1 FROM events o WHERE o.idea_id = e.idea_id AND o.kind = 'status' AND o.id < e.id AND json_extract(o.data_json, '$.to') = json_extract(e.data_json, '$.to'))
    ORDER BY e.id DESC LIMIT 30`, since).map((e) => ({ kind: EVENT_KINDS[e.st], plotId: e.plot_id ?? null, name: e.name, ticker: e.ticker || null, at: e.at }));
}

const residentPlot = (msg) => msg.match(/ (?:into|to) ([a-z]+-[1-6])$/)?.[1] ?? null;

// --- the desk computer in a room: the owner's projects as tabs (site, X, launch page) ------------------------------
const DESK_HIDDEN = ['declined', 'cancelled'];
const progressOf = (db, ideaId, stage) => {
  if (stage === 'generating') {
    const j = db.get(`SELECT progress FROM jobs WHERE type = 'generate' AND status = 'running' AND idea_id = ?`, ideaId);
    if (GEN_STEPS[j?.progress]) return GEN_STEPS[j.progress];
  }
  return PROGRESS[stage] ?? 0;
};

/** The room owner's projects for the desk. Visitors see public projects only and nothing owner-only (preview links,
 * office, X drafts, ideas); never a wallet. helpers: { previewLink(projectRow) -> url|null, explorerTx(sig) -> url|null }. */
export function deskView(db, cfg, { wallet, owner, plotIdeaId = null, previewLink, explorerTx }) {
  const rows = db.all(`SELECT p.id, p.slug, p.name, p.ticker, p.live_site_version, i.id idea_id, i.status, i.visibility, v.title, v.ticker_suggestion,
      l.mint, l.tx_signature, xa.status xstatus, xa.planned_handle, xa.x_handle,
      (SELECT MAX(version) FROM assets a WHERE a.project_id = p.id AND a.kind = 'logo') logo_v,
      (SELECT MAX(version) FROM assets a WHERE a.project_id = p.id AND a.kind = 'banner') banner_v
    FROM projects p JOIN ideas i ON i.id = p.idea_id JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
    LEFT JOIN launches l ON l.project_id = p.id LEFT JOIN x_accounts xa ON xa.project_id = p.id
    WHERE i.owner_wallet = ? AND i.status NOT IN (${inList(DESK_HIDDEN)}) ${owner ? '' : `AND i.visibility = 'public'`}
    ORDER BY (i.id = ?) DESC, i.created_at DESC, p.id`, wallet, plotIdeaId ?? '');
  const projects = rows.map((x) => {
    const pub = x.visibility === 'public';
    const launched = x.status === 'launched' && Boolean(x.mint);
    const preview = owner && x.live_site_version ? previewLink(x) : null;
    const asset = (kind, v, ext) => (!v ? null : pub ? `/meta/${x.slug}/${kind}-v${v}.${ext}` : preview ? preview.replace(/index\.html$/, `${kind}.${ext}`) : null);
    const connected = x.xstatus === 'connected' && x.x_handle;
    const handle = connected ? x.x_handle : x.planned_handle || null;
    return {
      slug: x.slug, name: x.name || x.title, ticker: x.ticker || x.ticker_suggestion || null,
      stage: x.status, stageLabel: LABELS[x.status] || x.status, progress: progressOf(db, x.idea_id, x.status),
      launched, mint: launched ? x.mint : null, explorerTx: launched && x.tx_signature ? explorerTx(x.tx_signature) ?? null : null,
      siteUrl: pub && x.live_site_version ? `${cfg.projectsScheme}://${x.slug}.${cfg.projectsHost}/` : null,
      previewLink: preview,
      logoUrl: asset('logo', x.logo_v, 'png'), bannerUrl: asset('banner', x.banner_v, 'svg'),
      x: { handle, status: connected ? 'connected' : x.xstatus ? 'planned' : null, url: connected ? `https://x.com/${x.x_handle}` : null,
        posts: owner ? db.all('SELECT id, text, status FROM x_posts WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 3', x.id) : null },
      pagePath: `/projects/${x.slug}`, officePath: owner ? `/projects/${x.slug}/review` : null,
      kind: plotIdeaId && x.idea_id === plotIdeaId ? 'project' : 'apartment-owner-project',
    };
  });
  const ideas = owner ? db.all(`SELECT i.id, v.title, i.status FROM ideas i JOIN idea_versions v ON v.idea_id = i.id AND v.version = i.current_version
      WHERE i.owner_wallet = ? AND i.status NOT IN (${inList([...DESK_HIDDEN, 'launched'])}) AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.idea_id = i.id)
      ORDER BY i.created_at DESC`, wallet).map((i) => ({ ...i, stageLabel: LABELS[i.status] || i.status })) : null;
  return { viewer: owner ? 'owner' : 'visitor', projects, ideas };
}
