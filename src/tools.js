// The site kit's tool catalog (docs/SITE-KIT.md): what a coin site can carry besides its text, each tool's config
// schema, SUB-01's keyword picker (no language model) and the JST clock the tools run on. Pure: no database, no
// network. The spec stores `tools: [{id, config}]`; render-child.js draws each one as a <section data-tool>, the
// audited kit (/_kit/site-kit.v1.js) brings it to life, and tool-api.js answers its /_api calls.
import { rankedNetworks } from './art.js';

// Generic tools: any coin. Extras: one idea-specific capability at most, built on a vendored open-source library that
// only that site loads (lazily, from /_kit/vendor/).
export const GENERIC = ['token', 'wall', 'poll', 'drop', 'event', 'memes'];
export const EXTRAS = ['map', 'synth', 'game', 'chart'];
// Holder tools (holder-tools.js, onchain.js): the trust layer every coin gets, on top of the MAX_TOOLS above. Real chain
// data only; before the launch they show a "goes live at launch" state. alerts runs in the visitor's browser.
export const TRUST = ['trades', 'holders', 'devwatch', 'fees', 'alerts'];
export const TOOL_IDS = [...GENERIC, ...EXTRAS, ...TRUST];
export const MAX_TOOLS = 6;

// Libraries the extras (and the motion layer) load; the file names are what /_kit/vendor/ serves (kit/build.mjs).
export const LIBS = Object.freeze({
  anime: { name: 'anime.js', version: '4.5.0', licence: 'MIT', url: 'https://github.com/juliangarnier/anime', file: 'anime-4.5.0.js' },
  motion: { name: 'Motion (motion/mini)', version: '13.4.4', licence: 'MIT', url: 'https://motion.dev', file: null },   // bundled in the core kit
  leaflet: { name: 'Leaflet', version: '1.9.4', licence: 'BSD-2-Clause', url: 'https://leafletjs.com', file: 'leaflet-1.9.4.js', css: 'leaflet-1.9.4.css' },
  tone: { name: 'Tone.js', version: '15.1.22', licence: 'MIT', url: 'https://tonejs.github.io', file: 'tone-15.1.22.js' },
  kaplay: { name: 'KAPLAY', version: '3001.0.19', licence: 'MIT', url: 'https://kaplayjs.com', file: 'kaplay-3001.0.19.js' },
  uplot: { name: 'uPlot', version: '1.6.32', licence: 'MIT', url: 'https://github.com/leeoniya/uPlot', file: 'uplot-1.6.32.js', css: 'uplot-1.6.32.css' },
  qrcode: { name: 'qrcode-generator', version: '2.0.4', licence: 'MIT', url: 'https://github.com/kazuhikoarase/qrcode-generator', file: 'qrcode-2.0.4.js' },
  // the app's post-quantum block (app-blocks.js `pq`): ML-DSA-65 verification in the browser, loaded on first use
  pq: { name: '@noble/post-quantum', version: '0.7.1', licence: 'MIT', url: 'https://github.com/paulmillr/noble-post-quantum', file: 'noble-post-quantum-0.7.1.js' },
});

// The only outside host a site may ever load from: OpenStreetMap's tiles, and only on a site whose map tool is on.
export const OSM_TILES = 'https://tile.openstreetmap.org';

/** What the room PC lists: name, one line, the library behind it and the fields the author may edit. */
export const CATALOG = Object.freeze({
  token: { name: 'Token panel', line: 'Live price, market cap, volume and holders, the contract address with copy and QR, and the trading links.', kind: 'generic', lib: 'qrcode', fields: [] },
  wall: { name: 'Community wall', line: 'Anyone posts a short note (280 characters); holders-only mode asks for a wallet signature.', kind: 'generic',
    fields: [{ key: 'title', label: 'Title', type: 'text', max: 60 }, { key: 'holdersOnly', label: 'Holders only', type: 'bool' }] },
  poll: { name: 'Poll', line: 'One question, 2–4 answers, one signed vote per wallet, results live.', kind: 'generic',
    fields: [{ key: 'question', label: 'Question', type: 'text', max: 120 }, { key: 'options', label: 'Answers (2–4)', type: 'options', max: 40, min: 2, count: 4 },
      { key: 'holdersOnly', label: 'Holders only', type: 'bool' }] },
  drop: { name: 'Drop box', line: 'People drop a private submission; you (or the daily rule) feature one at the reveal time.', kind: 'generic',
    fields: [{ key: 'title', label: 'Title', type: 'text', max: 60 }, { key: 'prompt', label: 'Prompt', type: 'text', max: 160 },
      { key: 'revealJst', label: 'Reveal time (JST)', type: 'time' }, { key: 'autoPick', label: 'Pick one by itself if I do not', type: 'bool' }] },
  event: { name: 'Next event', line: 'A live countdown to your next event (one date or every day) and a calendar file to save.', kind: 'generic',
    fields: [{ key: 'title', label: 'Event', type: 'text', max: 80 }, { key: 'daily', label: 'Every day at (JST)', type: 'time' },
      { key: 'at', label: 'Or once on (JST)', type: 'datetime' }, { key: 'link', label: 'Link (X, YouTube, Twitch, pump.fun)', type: 'url', max: 200 }] },
  memes: { name: 'Meme maker', line: 'The coin logo with top and bottom text, downloaded as a PNG. Runs in the browser; nothing is uploaded.', kind: 'generic',
    fields: [{ key: 'top', label: 'Default top text', type: 'text', max: 40 }, { key: 'bottom', label: 'Default bottom text', type: 'text', max: 40 }] },
  map: { name: 'Map of places', line: 'A map of the places the idea is about; visitors can pin a spot (you can hide any). OpenStreetMap tiles.', kind: 'extra', lib: 'leaflet',
    fields: [{ key: 'title', label: 'Title', type: 'text', max: 60 }, { key: 'community', label: 'Visitors can pin places', type: 'bool' }] },
  synth: { name: 'Sound toy', line: 'An 8-step loop on a scale that fits the coin; tap the grid, press play. Runs in the browser.', kind: 'extra', lib: 'tone',
    fields: [{ key: 'title', label: 'Title', type: 'text', max: 60 }, { key: 'bpm', label: 'Tempo (BPM)', type: 'number', min: 60, max: 180 }] },
  game: { name: 'Mini-game', line: 'Catch the falling coins, dodge the red ones: a 30-second browser game with the coin logo.', kind: 'extra', lib: 'kaplay',
    fields: [{ key: 'title', label: 'Title', type: 'text', max: 60 }] },
  chart: { name: 'Price chart', line: 'The coin\'s price and market cap over the last day or week, from the stored samples.', kind: 'extra', lib: 'uplot',
    fields: [{ key: 'title', label: 'Title', type: 'text', max: 60 }, { key: 'range', label: 'Range', type: 'choice', choices: ['24h', '7d'] }] },
  trades: { name: 'Live trades', line: 'Every buy and sell on the bonding curve, decoded from the chain: time, side, SOL, tokens, wallet, and flags for the dev, top-10 holders and first buys.', kind: 'trust', fields: [] },
  holders: { name: 'Holders', line: 'The top 20 holders with their share of the supply, the bonding curve labelled and left out, concentration in plain words.', kind: 'trust', fields: [] },
  devwatch: { name: 'Dev watch', line: 'The author wallet: the dev buy at launch, what it holds now, every sale with time and size.', kind: 'trust', fields: [] },
  fees: { name: 'Fee ledger', line: 'Creator fees of the coin: the split locked on chain at launch (read from the sharing config), what was paid out and what is waiting.', kind: 'trust', fields: [] },
  alerts: { name: 'Alerts', line: 'Visitors set "tell me when the market cap passes X or the dev sells"; kept in their browser only.', kind: 'trust', fields: [] },
});

const SCALES = ['pentatonic', 'minor', 'major', 'insen'];
export const EVENT_LINK_HOSTS = ['x.com', 'twitter.com', 'youtube.com', 'www.youtube.com', 'youtu.be', 'twitch.tv', 'www.twitch.tv', 'pump.fun'];

// --- JST (UTC+9, no daylight saving) ------------------------------------------------------------------------------
const JST = 9 * 3_600_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
export const jstDay = (t) => new Date(t + JST).toISOString().slice(0, 10);
/** The latest instant <= t at which a JST clock shows hh:mm. */
export function lastJst(t, hhmm) {
  const [, h, m] = HHMM.exec(hhmm);
  const d = new Date(t + JST);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(h), Number(m)) - JST;
  if (at > t) at -= 86_400_000;
  return at;
}
export const nextJst = (t, hhmm) => lastJst(t, hhmm) + 86_400_000;
/** 'YYYY-MM-DDTHH:MM' read as JST -> epoch ms, or null. */
export function parseJstLocal(s) {
  const m = LOCAL.exec(String(s ?? ''));
  if (!m) return null;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - JST;
  return new Date(at + JST).toISOString().slice(0, 16) === s ? at : null;   // 2026-02-30 is not a date
}

// --- schemas -----------------------------------------------------------------------------------------------------
class ToolError extends Error {}
const fail = (id, why) => { throw new ToolError(`tool ${id}: ${why}`); };
const text = (id, v, k, min, max, req = false) => {
  if (v == null || v === '') { if (req) fail(id, `${k} is required`); return undefined; }
  if (typeof v !== 'string' || /[\u0000-\u001f\u007f<>`]/.test(v)) fail(id, `${k}: plain text`);
  const s = v.trim();
  if ([...s].length < min || [...s].length > max) fail(id, `${k}: ${min}–${max} characters`);
  return s;
};
const bool = (id, v, k) => { if (v == null) return false; if (typeof v !== 'boolean') fail(id, `${k}: true or false`); return v; };
const keys = (id, c, allowed) => {
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail(id, 'config must be an object');
  const extra = Object.keys(c).filter((k) => !allowed.includes(k));
  if (extra.length) fail(id, `unknown field ${String(extra[0]).slice(0, 20)}`);
};
const lat = (id, v) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < -85 || v > 85) fail(id, 'latitude: -85…85'); return Math.round(v * 1e5) / 1e5; };
const lng = (id, v) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < -180 || v > 180) fail(id, 'longitude: -180…180'); return Math.round(v * 1e5) / 1e5; };

/** An https link to one of EVENT_LINK_HOSTS, or a ToolError. Author-supplied links are a phishing path, so no other host. */
export function eventLink(v) {
  let u;
  try { u = new URL(v); } catch { fail('event', 'link: a full https:// address'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !EVENT_LINK_HOSTS.includes(u.hostname)) fail('event', `link: https on ${EVENT_LINK_HOSTS.join(', ')}`);
  if (u.href.length > 200) fail('event', 'link: at most 200 characters');
  return u.href;
}

const SCHEMAS = {
  token: (c) => { keys('token', c, []); return {}; },
  wall: (c) => { keys('wall', c, ['title', 'holdersOnly']); return { title: text('wall', c.title, 'title', 1, 60) || 'Wall', holdersOnly: bool('wall', c.holdersOnly, 'holdersOnly') }; },
  poll: (c) => {
    keys('poll', c, ['question', 'options', 'holdersOnly']);
    const question = text('poll', c.question, 'question', 3, 120, true);
    if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 4) fail('poll', 'options: 2–4 answers');
    const options = c.options.map((o, i) => text('poll', o, `answer ${i + 1}`, 1, 40, true));
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) fail('poll', 'answers must differ');
    return { question, options, holdersOnly: bool('poll', c.holdersOnly, 'holdersOnly') };
  },
  drop: (c) => {
    keys('drop', c, ['title', 'prompt', 'revealJst', 'maxLength', 'autoPick']);
    const revealJst = c.revealJst ?? '21:00';
    if (!HHMM.test(revealJst)) fail('drop', 'revealJst: HH:MM (JST)');
    const maxLength = c.maxLength ?? 280;
    if (!Number.isInteger(maxLength) || maxLength < 40 || maxLength > 500) fail('drop', 'maxLength: 40–500');
    return { title: text('drop', c.title, 'title', 1, 60) || 'Drop box', prompt: text('drop', c.prompt, 'prompt', 3, 160, true), revealJst, maxLength,
      autoPick: c.autoPick == null ? true : bool('drop', c.autoPick, 'autoPick') };
  },
  event: (c) => {
    keys('event', c, ['title', 'daily', 'at', 'link']);
    const out = { title: text('event', c.title, 'title', 2, 80, true) };
    const daily = c.daily || null, at = c.at || null;
    if (!!daily === !!at) fail('event', 'set either daily (HH:MM JST) or at (YYYY-MM-DDTHH:MM JST)');
    if (daily) { if (!HHMM.test(daily)) fail('event', 'daily: HH:MM (JST)'); out.daily = daily; }
    if (at) { if (parseJstLocal(at) == null) fail('event', 'at: YYYY-MM-DDTHH:MM (JST)'); out.at = at; }
    if (c.link) out.link = eventLink(c.link);
    return out;
  },
  memes: (c) => { keys('memes', c, ['top', 'bottom']); return { top: text('memes', c.top, 'top', 1, 40) || '', bottom: text('memes', c.bottom, 'bottom', 1, 40) || '' }; },
  map: (c) => {
    keys('map', c, ['title', 'center', 'zoom', 'places', 'community']);
    if (!Array.isArray(c.center) || c.center.length !== 2) fail('map', 'center: [lat, lng]');
    const zoom = c.zoom ?? 12;
    if (!Number.isInteger(zoom) || zoom < 2 || zoom > 18) fail('map', 'zoom: 2–18');
    const places = c.places ?? [];
    if (!Array.isArray(places) || places.length > 20) fail('map', 'places: at most 20');
    return { title: text('map', c.title, 'title', 1, 60) || 'Map', center: [lat('map', c.center[0]), lng('map', c.center[1])], zoom,
      places: places.map((p, i) => { keys('map', p, ['name', 'lat', 'lng']); return { name: text('map', p.name, `place ${i + 1} name`, 1, 40, true), lat: lat('map', p.lat), lng: lng('map', p.lng) }; }),
      community: c.community == null ? true : bool('map', c.community, 'community') };
  },
  synth: (c) => {
    keys('synth', c, ['title', 'scale', 'bpm']);
    const scale = c.scale ?? 'pentatonic', bpm = c.bpm ?? 96;
    if (!SCALES.includes(scale)) fail('synth', `scale: ${SCALES.join(', ')}`);
    if (!Number.isInteger(bpm) || bpm < 60 || bpm > 180) fail('synth', 'bpm: 60–180');
    return { title: text('synth', c.title, 'title', 1, 60) || 'Sound toy', scale, bpm };
  },
  game: (c) => { keys('game', c, ['title']); return { title: text('game', c.title, 'title', 1, 60) || 'Mini-game' }; },
  ...Object.fromEntries(TRUST.map((id) => [id, (c) => { keys(id, c, []); return {}; }])),
  chart: (c) => {
    keys('chart', c, ['title', 'range']);
    const range = c.range ?? '24h';
    if (!['24h', '7d'].includes(range)) fail('chart', 'range: 24h or 7d');
    return { title: text('chart', c.title, 'title', 1, 60) || 'Price chart', range };
  },
};

/** The spec's tools list, normalised (defaults filled, text trimmed), or a ToolError with the first problem.
 * Rules: an array of at most MAX_TOOLS {id, config}, each id once, at most one extra. */
export function validateTools(list) {
  if (!Array.isArray(list)) throw new ToolError('tools: an array');
  if (list.length > MAX_TOOLS + TRUST.length) throw new ToolError(`tools: at most ${MAX_TOOLS}`);
  const seen = new Set();
  const out = list.map((t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new ToolError('tools: each one is {id, config}');
    const extra = Object.keys(t).filter((k) => k !== 'id' && k !== 'config');
    if (extra.length) throw new ToolError(`tools: unknown field ${String(extra[0]).slice(0, 20)}`);
    if (!TOOL_IDS.includes(t.id)) throw new ToolError(`tools: unknown tool ${String(t.id).slice(0, 20)}`);
    if (seen.has(t.id)) throw new ToolError(`tools: ${t.id} twice`);
    seen.add(t.id);
    return { id: t.id, config: SCHEMAS[t.id](t.config ?? {}) };
  });
  if (out.filter((t) => !TRUST.includes(t.id)).length > MAX_TOOLS) throw new ToolError(`tools: at most ${MAX_TOOLS} (plus the holder tools)`);
  if (out.filter((t) => EXTRAS.includes(t.id)).length > 1) throw new ToolError('tools: at most one idea-specific tool');
  return out;
}
export const isToolError = (e) => e instanceof ToolError;
/** One tool's config, validated and normalised (the app composer reuses the map and event schemas for its blocks). */
export const validateToolConfig = (id, c) => { if (!SCHEMAS[id]) throw new ToolError(`unknown tool ${String(id).slice(0, 20)}`); return SCHEMAS[id](c ?? {}); };
export const toolOf = (spec, id) => (Array.isArray(spec?.tools) ? spec.tools.find((t) => t.id === id) : null) || null;
/** The site needs the OSM tile host in its CSP only when a map is on (the map tool, or a map block of the app). */
export const usesTiles = (spec) => !!toolOf(spec, 'map') || !!(spec?.app?.screens || []).some((s) => (s.blocks || []).some((b) => b.type === 'map'));

// --- SUB-01's choice (keywords, no language model) ----------------------------------------------------------------
const fold = (s) => ` ${String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9:.\s]/g, ' ').replace(/(?<!\d)[:.]|[:.](?!\d)/g, ' ').replace(/\s+/g, ' ')} `;
const hits = (t, words) => words.filter((w) => t.includes(` ${w} `) || (w.endsWith('*') && new RegExp(` ${w.slice(0, -1)}[a-z]*`).test(t))).length;
// en / it / ja (romaji). A trailing * matches any ending (confess* = confess, confession, confessions…).
const DROP_NOUNS = [
  ['confession', ['confess*', 'confessa*', 'confession*', 'confessione', 'confessioni', 'kokuhaku', 'zange', 'sange']],
  ['secret', ['secret*', 'segret*', 'himitsu']],
  ['question', ['question*', 'ask', 'asks', 'domand*', 'chiedi*', 'shitsumon', 'kiite']],
  ['wish', ['wish*', 'desideri*', 'negai', 'onegai', 'tanzaku']],
  ['story', ['story', 'stories', 'storia', 'storie', 'racconto', 'racconti', 'monogatari', 'hanashi']],
  ['letter', ['letter*', 'lettera', 'lettere', 'tegami']],
  ['idea', ['submit*', 'submission*', 'send', 'sends', 'drop your', 'anonymous*', 'anonim*', 'invia*', 'manda*', 'okuru', 'tokumei', 'toukou']],
];
const RITUAL = ['every night', 'every day', 'every morning', 'every evening', 'every week', 'nightly', 'daily', 'weekly', 'midnight', 'ritual*', 'tonight',
  'ogni sera', 'ogni notte', 'ogni giorno', 'ogni mattina', 'mezzanotte', 'rituale', 'stasera', 'maiban', 'mainichi', 'maiasa', 'maishuu', 'shinya', 'gishiki', 'konya'];
const MEME = ['meme*', 'lol', 'lmao', 'funny', 'joke*', 'shitpost*', 'cat', 'cats', 'dog', 'dogs', 'frog*', 'pepe', 'absurd*', 'cursed', 'based', 'degen*', 'troll*',
  'divertent*', 'scherz*', 'gatto', 'gatti', 'cane', 'cani', 'rana', 'ridere', 'neko', 'inu', 'kaeru', 'omoshiroi', 'warai', 'kawaii', 'baka'];
const EXTRA_WORDS = {
  map: ['map', 'maps', 'place*', 'spot', 'spots', 'street*', 'city', 'tokyo', 'osaka', 'kyoto', 'shibuya', 'shinjuku', 'ramen', 'cafe*', 'restaurant*', 'bar', 'bars', 'shop', 'shops',
    'neighbourhood', 'neighborhood', 'mappa', 'mappe', 'luogh*', 'posto', 'posti', 'quartiere', 'citta', 'chizu', 'basho', 'mise', 'machi', 'izakaya', 'onsen', 'sento'],
  synth: ['music', 'song*', 'beat*', 'sound*', 'synth*', 'dj', 'lofi', 'lo fi', 'melod*', 'rhythm', 'tune*', 'musica', 'canzon*', 'suono', 'suoni', 'ritmo', 'ongaku', 'uta', 'oto', 'kyoku', 'karaoke', 'city pop'],
  game: ['game', 'games', 'gaming', 'arcade', 'play', 'player*', 'score*', 'level*', 'pixel*', 'gioco', 'giochi', 'giocare', 'punteggio', 'geemu', 'asobi', 'pachinko', 'gacha'],
  chart: ['chart*', 'price', 'prices', 'trading', 'trader*', 'candle*', 'graph*', 'pump', 'grafico', 'prezzo', 'borsa', 'chaato', 'kabu', 'soba', 'kabuka'],
};
const LANGUAGE_NETS = new Set(['language', 'default']), REWARD_NETS = new Set(['reward', 'control']);

/** A time named in the concept (23:00, 11pm, alle 23, 23ji, midnight / mezzanotte) as 'HH:MM', or null. */
export function conceptTime(concept) {
  const t = fold(concept);
  if (/ (midnight|mezzanotte|reiji) /.test(t)) return '00:00';
  let m = / ([01]?\d|2[0-3])[:.h]([0-5]\d) /.exec(t);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = / (1[0-2]|[1-9]) ?(am|pm) /.exec(t);
  if (m) { let h = Number(m[1]) % 12; if (m[2] === 'pm') h += 12; return `${String(h).padStart(2, '0')}:00`; }
  m = / (?:alle|at) ([01]?\d|2[0-3]) /.exec(t) || / ([01]?\d|2[0-3]) ?ji /.exec(t);
  return m ? `${m[1].padStart(2, '0')}:00` : null;
}

/** Defaults SUB-01 writes for a tool (also when the author switches one on in the room PC without editing it). */
export function defaultConfig(id, { name = 'this coin', concept = '' } = {}) {
  const time = conceptTime(concept);
  switch (id) {
    case 'token': return {};
    case 'wall': return { title: `Notes for ${name}`.slice(0, 60), holdersOnly: false };
    case 'poll': return { question: `What should ${name} do next?`.slice(0, 120), options: ['More memes', 'A live event', 'More lore', 'Keep it weird'], holdersOnly: false };
    case 'drop': {
      const noun = DROP_NOUNS.find(([, words]) => hits(fold(concept), words))?.[0] || 'idea';
      const at = time || '21:00';
      return { title: `Drop your ${noun}`, prompt: `Drop your ${noun}. It stays private; one is featured here every day at ${at} JST.`, revealJst: at, maxLength: 280, autoPick: true };
    }
    case 'event': return { title: `${name}: the daily moment`.slice(0, 80), daily: time || '21:00' };
    case 'memes': return { top: name.toUpperCase().slice(0, 40), bottom: 'BUILT BY SUB-01' };
    case 'map': {
      const t = fold(concept);
      const city = [[' osaka ', [34.6937, 135.5023]], [' kyoto ', [35.0116, 135.7681]], [' milan', [45.4642, 9.19]], [' rome ', [41.9028, 12.4964]], [' roma ', [41.9028, 12.4964]],
        [' new york ', [40.7128, -74.006]], [' london ', [51.5072, -0.1276]], [' paris ', [48.8566, 2.3522]]].find(([k]) => t.includes(k));
      return { title: `${name}: the map`.slice(0, 60), center: city ? city[1] : [35.6812, 139.7671], zoom: 12, places: [], community: true };
    }
    case 'synth': return { title: `${name}: sound toy`.slice(0, 60), scale: / (japan|tokyo|kyoto|wa|nihon|giappon|insen) /.test(fold(concept)) ? 'insen' : 'pentatonic', bpm: 96 };
    case 'game': return { title: `Catch the ${name.slice(0, 40)}` };
    case 'chart': return { title: `${name}: price chart`.slice(0, 60), range: '24h' };
    case 'trades': case 'holders': case 'devwatch': case 'fees': case 'alerts': return {};
    default: throw new ToolError(`unknown tool ${id}`);
  }
}

/** -> {generic: [...], extra} the keyword reading of a concept, for chooseTools and the tests. */
export function readConcept(concept) {
  const t = fold(concept);
  const drop = DROP_NOUNS.some(([, words]) => hits(t, words) > 0);
  const event = hits(t, RITUAL) > 0 || conceptTime(concept) != null;
  const memes = hits(t, MEME) > 0;
  const scored = EXTRAS.map((id) => [id, hits(t, EXTRA_WORDS[id])]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return { drop, event, memes, extra: scored[0]?.[0] ?? null };
}

/** SUB-01's pick for a new site: 3–4 generic tools (always the token panel; wall or poll by the brain's dominant network;
 * drop, event, memes when the concept calls for them) plus at most one extra when the concept fits, then the holder
 * tools (TRUST) on every coin. */
export function pickTools({ name, concept, networks }) {
  const r = readConcept(concept);
  const top = rankedNetworks(networks).find((n) => LANGUAGE_NETS.has(n.group) || REWARD_NETS.has(n.group));
  const social = top && REWARD_NETS.has(top.group) ? 'poll' : 'wall';
  const ids = ['token'];
  if (r.drop) ids.push('drop');
  ids.push(social);
  if (r.event) ids.push('event');
  if (r.memes) ids.push('memes');
  const generic = ids.slice(0, 4);
  if (generic.length < 3) generic.push('memes');
  const list = [...(r.extra ? [...generic, r.extra] : generic), ...TRUST];
  return validateTools(list.map((id) => ({ id, config: defaultConfig(id, { name, concept }) })));
}
