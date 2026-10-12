// The idea app DSL (docs/APP-COMPOSER.md): what SUB-01 builds on a coin site from the idea itself, assembled from
// vetted blocks. An app spec is DATA, strictly validated here; the audited kit (kit/app/*.js) interprets it and
// app-api.js answers its /_api/app calls. Nothing in a spec is ever executed: no code, no markup, no URLs.
// Pure: no database, no network.
import { validateToolConfig, isToolError, lastJst } from './tools.js';

export const APP_VERSION = 1;
export const BLOCK_TYPES = ['submit', 'schedule', 'reveal', 'vote', 'collection', 'card', 'leaderboard', 'counter', 'map', 'timer', 'note', 'pq', 'launch'];
export const CARD_TEMPLATES = ['receipt', 'ticket', 'poster', 'postcard', 'badge'];
export const FIELD_KINDS = ['text', 'longtext', 'choice', 'number'];
export const PICKS = ['owner', 'votes', 'random'];
export const METRICS = ['submitted_today', 'submitted_total', 'published_total', 'votes_today', 'voters_today', 'days_running'];
export const METRIC_LABELS = { submitted_today: 'today', submitted_total: 'in total', published_total: 'published', votes_today: 'votes today', voters_today: 'voters today', days_running: 'days running' };
export const LIMITS = Object.freeze({ screens: 4, blocks: 14, fields: 4, lines: 6, choices: 8 });
// The launch block's creator-fee split for the coins launched from the site (child-launch.js), in bps. The author may
// change it within these limits (SUB-01 at least 20%, the creator at least 50%); the server re-validates it at every launch.
export const LAUNCH_SPLIT = Object.freeze({ creator: 7000, parent: 1000, sub01: 2000 });
export const LAUNCH_LIMITS = Object.freeze({ creator: [5000, 8000], parent: [0, 3000], sub01: [2000, 5000] });

/** What the room PC shows for each block: a name and one plain line. */
export const BLOCKS = Object.freeze({
  submit: { name: 'Form', line: 'Visitors send 1–4 typed fields (moderated, rate limited); you see them in the inbox.' },
  schedule: { name: 'Schedule', line: 'A recurring moment in JST (every day or every week) that drives the reveal.' },
  reveal: { name: 'Reveal', line: 'At the scheduled moment one submission is published: your pick, the holders\' votes, or a random draw seeded by a Solana blockhash.' },
  vote: { name: 'Vote', line: 'One signed vote per wallet (a message, never a transaction); holders only when you want.' },
  collection: { name: 'Archive', line: 'The public list of published items, with month and text filters; each item has a link.' },
  card: { name: 'Card', line: 'Each item rendered as a downloadable image: receipt, ticket, poster, postcard or badge.' },
  leaderboard: { name: 'Leaderboard', line: 'Items or wallets ranked by votes or submissions.' },
  counter: { name: 'Counter', line: 'Live counts: today, in total, votes, days running.' },
  map: { name: 'Map', line: 'The map tool: places and visitors\' pins (OpenStreetMap).' },
  timer: { name: 'Countdown', line: 'A countdown to a date or a daily moment, with a calendar file.' },
  note: { name: 'Note', line: 'A short plain-text box.' },
  pq: { name: 'Post-quantum registry', line: 'Everything the launchpad did for this coin, hashed and signed with ML-DSA-65 (FIPS 204), verified in the visitor\'s browser.' },
  launch: { name: 'Launch a coin', line: 'Visitors launch their own real coin from this site: SUB-01 votes on each one first, and its creator fees are split on-chain between the creator, you and SUB-01.' },
});

export class AppError extends Error {}
export const isAppError = (e) => e instanceof AppError;
const fail = (where, why) => { throw new AppError(`app ${where}: ${why}`); };

// --- primitives --------------------------------------------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEY = /^[a-z][a-z0-9]{0,15}$/;
const SCREEN_ID = /^[a-z][a-z0-9-]{0,15}$/;
function text(where, v, k, min, max, { req = false, def } = {}) {
  if (v == null || v === '') { if (req && def == null) fail(where, `${k} is required`); return def; }
  if (typeof v !== 'string' || /[\u0000-\u001f\u007f<>`]/.test(v)) fail(where, `${k}: plain text`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (/https?:|www\./i.test(s)) fail(where, `${k}: no links`);
  if ([...s].length < min || [...s].length > max) fail(where, `${k}: ${min}–${max} characters`);
  return s;
}
const bool = (where, v, k, def = false) => { if (v == null) return def; if (typeof v !== 'boolean') fail(where, `${k}: true or false`); return v; };
const int = (where, v, k, min, max, def) => { if (v == null) { if (def === undefined) fail(where, `${k} is required`); return def; }
  if (!Number.isInteger(v) || v < min || v > max) fail(where, `${k}: a whole number ${min}–${max}`); return v; };
const oneOf = (where, v, k, list, def) => { if (v == null) { if (def === undefined) fail(where, `${k}: one of ${list.join(', ')}`); return def; }
  if (!list.includes(v)) fail(where, `${k}: one of ${list.join(', ')}`); return v; };
const only = (where, o, allowed) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(where, 'an object');
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) fail(where, `unknown field ${String(extra[0]).slice(0, 20)}`);
};
const subset = (where, v, k, list, { min = 0, max = list.length, def } = {}) => {
  if (v == null) { if (def === undefined) fail(where, `${k} is required`); return def; }
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some((x) => !list.includes(x)) || new Set(v).size !== v.length) fail(where, `${k}: ${min}–${max} of ${list.join(', ')}`);
  return [...v];
};
const viaTool = (where, id, c) => { try { return validateToolConfig(id, c); } catch (e) { if (isToolError(e)) fail(where, e.message.replace(/^tool \w+: /, '')); throw e; } };

// --- blocks --------------------------------------------------------------------------------------------------------------
function field(where, f, i) {
  only(`${where} field ${i + 1}`, f, ['key', 'label', 'kind', 'max', 'min', 'choices', 'required', 'placeholder']);
  const w = `${where} field ${i + 1}`;
  const kind = oneOf(w, f.kind, 'kind', FIELD_KINDS, 'text');
  const out = { key: (() => { if (typeof f.key !== 'string' || !KEY.test(f.key)) fail(w, 'key: a-z0-9, starts with a letter, ≤16'); return f.key; })(),
    label: text(w, f.label, 'label', 1, 40, { req: true }), kind, required: bool(w, f.required, 'required', i === 0) };
  const ph = text(w, f.placeholder, 'placeholder', 1, 80);
  if (ph) out.placeholder = ph;
  if (kind === 'text') out.max = int(w, f.max, 'max', 1, 80, 60);
  if (kind === 'longtext') out.max = int(w, f.max, 'max', 40, 500, 280);
  if (kind === 'number') { out.min = int(w, f.min, 'min', -1_000_000, 1_000_000, 0); out.max = int(w, f.max, 'max', out.min, 1_000_000, 100); }
  if (kind === 'choice') {
    if (!Array.isArray(f.choices) || f.choices.length < 2 || f.choices.length > LIMITS.choices) fail(w, `choices: 2–${LIMITS.choices}`);
    out.choices = f.choices.map((c, j) => text(w, c, `choice ${j + 1}`, 1, 24, { req: true }));
    if (new Set(out.choices.map((c) => c.toLowerCase())).size !== out.choices.length) fail(w, 'choices must differ');
  } else if (f.choices != null) fail(w, 'choices only on a choice field');
  if (kind !== 'number' && f.min != null) fail(w, 'min only on a number field');
  return out;
}

const SCHEMAS = {
  submit(b, w) {
    only(w, b, ['type', 'title', 'prompt', 'button', 'fields', 'holdersOnly', 'anonymous', 'thanks']);
    if (!Array.isArray(b.fields) || b.fields.length < 1 || b.fields.length > LIMITS.fields) fail(w, `fields: 1–${LIMITS.fields}`);
    const fields = b.fields.map((f, i) => field(w, f, i));
    if (new Set(fields.map((f) => f.key)).size !== fields.length) fail(w, 'field keys must differ');
    if (!['text', 'longtext'].includes(fields[0].kind) || !fields[0].required) fail(w, 'the first field is the required text of the item');
    return { type: 'submit', title: text(w, b.title, 'title', 1, 60, { def: 'Send yours' }), prompt: text(w, b.prompt, 'prompt', 3, 160, { req: true }),
      button: text(w, b.button, 'button', 1, 24, { def: 'Send' }), fields, holdersOnly: bool(w, b.holdersOnly, 'holdersOnly'),
      anonymous: bool(w, b.anonymous, 'anonymous', true), thanks: text(w, b.thanks, 'thanks', 3, 160, { def: 'Received.' }) };
  },
  schedule(b, w) {
    only(w, b, ['type', 'every', 'at', 'weekday', 'label']);
    const every = oneOf(w, b.every, 'every', ['day', 'week'], 'day');
    if (typeof b.at !== 'string' || !HHMM.test(b.at)) fail(w, 'at: HH:MM (JST)');
    const out = { type: 'schedule', every, at: b.at, label: text(w, b.label, 'label', 3, 80, { def: every === 'day' ? `Every day at ${b.at} JST` : `Every week at ${b.at} JST` }) };
    if (every === 'week') out.weekday = int(w, b.weekday, 'weekday (0 = Sunday)', 0, 6);
    else if (b.weekday != null) fail(w, 'weekday only when every is week');
    return out;
  },
  reveal(b, w) {
    only(w, b, ['type', 'title', 'pick', 'empty']);
    return { type: 'reveal', title: text(w, b.title, 'title', 1, 60, { def: 'Tonight\'s pick' }), pick: subset(w, b.pick, 'pick', PICKS, { min: 1, def: ['owner', 'votes', 'random'] }),
      empty: text(w, b.empty, 'empty', 3, 120, { def: 'Nothing was sent in time for this one.' }) };
  },
  vote(b, w) {
    only(w, b, ['type', 'title', 'of', 'holdersOnly', 'button']);
    return { type: 'vote', title: text(w, b.title, 'title', 1, 60, { def: 'Vote' }), of: oneOf(w, b.of, 'of', ['candidates', 'published'], 'candidates'),
      holdersOnly: bool(w, b.holdersOnly, 'holdersOnly'), button: text(w, b.button, 'button', 1, 24, { def: 'Vote' }) };
  },
  collection(b, w) {
    only(w, b, ['type', 'title', 'show', 'layout', 'filters', 'empty']);
    return { type: 'collection', title: text(w, b.title, 'title', 1, 60, { def: 'Archive' }), show: oneOf(w, b.show, 'show', ['published', 'all'], 'published'),
      layout: oneOf(w, b.layout, 'layout', ['cards', 'list'], 'cards'), filters: subset(w, b.filters, 'filters', ['month', 'search'], { def: ['month', 'search'] }),
      empty: text(w, b.empty, 'empty', 3, 120, { def: 'Nothing here yet.' }) };
  },
  card(b, w) {
    only(w, b, ['type', 'title', 'template', 'heading', 'sub', 'lines', 'footer', 'input']);
    const lines = b.lines ?? [];
    if (!Array.isArray(lines) || lines.length > LIMITS.lines) fail(w, `lines: at most ${LIMITS.lines}`);
    return { type: 'card', title: text(w, b.title, 'title', 1, 60, { def: 'Make your card' }), template: oneOf(w, b.template, 'template', CARD_TEMPLATES, 'postcard'),
      heading: text(w, b.heading, 'heading', 1, 32, { req: true }), sub: text(w, b.sub, 'sub', 1, 48, { def: '' }),
      lines: lines.map((l, i) => text(w, l, `line ${i + 1}`, 1, 28, { req: true })), footer: text(w, b.footer, 'footer', 1, 60, { def: '' }),
      input: bool(w, b.input, 'input', true) };
  },
  leaderboard(b, w) {
    only(w, b, ['type', 'title', 'of', 'by', 'limit']);
    return { type: 'leaderboard', title: text(w, b.title, 'title', 1, 60, { def: 'Top' }), of: oneOf(w, b.of, 'of', ['items', 'wallets'], 'items'),
      by: oneOf(w, b.by, 'by', ['votes', 'submissions'], 'votes'), limit: int(w, b.limit, 'limit', 3, 20, 10) };
  },
  counter(b, w) {
    only(w, b, ['type', 'title', 'metrics']);
    return { type: 'counter', title: text(w, b.title, 'title', 1, 60, { def: '' }), metrics: subset(w, b.metrics, 'metrics', METRICS, { min: 1, max: 4, def: ['submitted_today', 'published_total'] }) };
  },
  map(b, w) { only(w, b, ['type', 'title', 'center', 'zoom', 'places', 'community']); const { type, ...c } = b; return { type: 'map', ...viaTool(w, 'map', c) }; },
  timer(b, w) { only(w, b, ['type', 'title', 'daily', 'at', 'link']); const { type, ...c } = b; return { type: 'timer', ...viaTool(w, 'event', c) }; },
  note(b, w) { only(w, b, ['type', 'title', 'body']); return { type: 'note', title: text(w, b.title, 'title', 1, 60, { req: true }), body: text(w, b.body, 'body', 3, 600, { req: true }) }; },
  pq(b, w) {
    only(w, b, ['type', 'title', 'registry', 'verify', 'honesty']);
    const out = { type: 'pq', title: text(w, b.title, 'title', 1, 60, { def: 'Post-quantum registry' }), registry: bool(w, b.registry, 'registry', true),
      verify: bool(w, b.verify, 'verify', true), honesty: bool(w, b.honesty, 'honesty', true) };
    if (!out.registry && !out.verify) fail(w, 'turn on the registry or the verifier');
    return out;
  },
  launch(b, w) {
    only(w, b, ['type', 'title', 'prompt', 'split', 'devBuy', 'list']);
    const s = b.split ?? LAUNCH_SPLIT, sw = `${w} split`;
    only(sw, s, ['creator', 'parent', 'sub01']);
    const split = Object.fromEntries(Object.entries(LAUNCH_LIMITS).map(([k, [min, max]]) => [k, int(sw, s[k], `${k} (bps)`, min, max)]));
    if (split.creator + split.parent + split.sub01 !== 10000) fail(sw, 'creator + parent + sub01 must total 10000 bps (100%)');
    return { type: 'launch', title: text(w, b.title, 'title', 1, 60, { def: 'Launch a coin here' }),
      prompt: text(w, b.prompt, 'prompt', 3, 200, { def: 'Launch your own coin from this site. SUB-01 reads it first; if he builds it, you sign the launch with your wallet.' }),
      split, devBuy: bool(w, b.devBuy, 'devBuy', true), list: bool(w, b.list, 'list', true) };
  },
};

/** The app spec, normalised (defaults filled, text trimmed), or an AppError with the first problem. Cross-block rules:
 * one submit, schedule, reveal, card, pq at most; a reveal needs a schedule and a submit; voting on candidates needs
 * a reveal; a wallet leaderboard needs signed (holders-only, not anonymous) submissions; the board flow publishes
 * submissions right away, the inbox flow keeps them private until revealed (or put up as candidates for a vote). */
export function validateApp(a) {
  only('spec', a, ['v', 'kind', 'title', 'lede', 'flow', 'noun', 'screens']);
  if (a.v !== APP_VERSION) fail('spec', `v: ${APP_VERSION}`);
  const noun = a.noun ?? { one: 'entry', many: 'entries' };
  only('noun', noun, ['one', 'many']);
  const out = { v: APP_VERSION, kind: text('spec', a.kind, 'kind', 2, 32, { def: 'custom' }), title: text('spec', a.title, 'title', 2, 60, { req: true }),
    lede: text('spec', a.lede, 'lede', 0, 240, { def: '' }), flow: oneOf('spec', a.flow, 'flow', ['inbox', 'board'], 'inbox'),
    noun: { one: text('noun', noun.one, 'one', 1, 24, { req: true }).toLowerCase(), many: text('noun', noun.many, 'many', 1, 24, { req: true }).toLowerCase() }, screens: [] };
  if (!Array.isArray(a.screens) || a.screens.length < 1 || a.screens.length > LIMITS.screens) fail('spec', `screens: 1–${LIMITS.screens}`);
  let total = 0;
  for (const [i, s] of a.screens.entries()) {
    const w = `screen ${i + 1}`;
    only(w, s, ['id', 'title', 'blocks']);
    if (typeof s.id !== 'string' || !SCREEN_ID.test(s.id)) fail(w, 'id: a-z0-9-, ≤16');
    if (!Array.isArray(s.blocks) || s.blocks.length < 1) fail(w, 'at least one block');
    total += s.blocks.length;
    if (total > LIMITS.blocks) fail('spec', `at most ${LIMITS.blocks} blocks`);
    out.screens.push({ id: s.id, title: text(w, s.title, 'title', 1, 30, { req: true }), blocks: s.blocks.map((b, j) => {
      const bw = `${w} block ${j + 1}`;
      if (!b || typeof b !== 'object' || !BLOCK_TYPES.includes(b.type)) fail(bw, `type: one of ${BLOCK_TYPES.join(', ')}`);
      return SCHEMAS[b.type](b, `${bw} (${b.type})`);
    }) });
  }
  if (new Set(out.screens.map((s) => s.id)).size !== out.screens.length) fail('spec', 'screen ids must differ');
  const all = out.screens.flatMap((s) => s.blocks), n = (t) => all.filter((b) => b.type === t).length;
  for (const t of ['submit', 'schedule', 'reveal', 'card', 'pq', 'map', 'launch']) if (n(t) > 1) fail('spec', `one ${t} block at most`);
  const submit = all.find((b) => b.type === 'submit');
  if (n('reveal') && !(n('schedule') && submit)) fail('spec', 'a reveal needs a schedule and a form');
  if (all.some((b) => b.type === 'vote' && b.of === 'candidates') && !n('reveal')) fail('spec', 'voting on candidates needs a reveal');
  if (all.some((b) => ['vote', 'collection', 'leaderboard', 'reveal'].includes(b.type)) && !submit) fail('spec', 'votes, archives, leaderboards and reveals need a form');
  if (all.some((b) => b.type === 'leaderboard' && b.of === 'wallets') && !(submit?.holdersOnly && !submit.anonymous)) fail('spec', 'a wallet leaderboard needs signed, non-anonymous submissions');
  if (out.flow === 'inbox' && all.some((b) => b.type === 'collection' && b.show === 'all')) fail('spec', 'an inbox app keeps submissions private: its archive shows published ones');
  if (out.flow === 'inbox' && submit && !n('reveal')) fail('spec', 'an inbox app needs a reveal (or use the board flow)');
  return out;
}

/** The blocks of a type, across screens. */
export const blocksOf = (app, type) => (app?.screens || []).flatMap((s) => s.blocks).filter((b) => b.type === type);
export const blockOf = (app, type) => blocksOf(app, type)[0] || null;
/** Who may see an item before it is published: 'board' (everyone, right away), 'candidates' (the current round is up for a
 * vote, so it is public, anonymous) or 'private' (only the owner). The form says which, in plain words. */
export function exposure(app) {
  if (app.flow === 'board') return 'board';
  return blocksOf(app, 'vote').some((b) => b.of === 'candidates') ? 'candidates' : 'private';
}

// --- the schedule (JST) ----------------------------------------------------------------------------------------------
const DAY = 86_400_000;
/** The latest scheduled instant <= t, or null without a schedule. */
export function lastSlot(sched, t) {
  if (!sched) return null;
  let at = lastJst(t, sched.at);
  if (sched.every === 'week') { while (new Date(at + 9 * 3_600_000).getUTCDay() !== sched.weekday) at -= DAY; }
  return at;
}
export const nextSlot = (sched, t) => (sched ? lastSlot(sched, t) + (sched.every === 'week' ? 7 * DAY : DAY) : null);
export const prevSlot = (sched, slotAt) => slotAt - (sched.every === 'week' ? 7 * DAY : DAY);

/** One-line description of an app for audits and the report: "Konbini receipt: form → vote → 23:00 reveal → receipt". */
export function describeApp(app) {
  const all = app.screens.flatMap((s) => s.blocks), has = (t) => all.some((b) => b.type === t);
  const sched = blockOf(app, 'schedule'), card = blockOf(app, 'card');
  return [has('submit') ? `${app.noun.many} form` : null, has('vote') ? 'signed votes' : null, sched ? `reveal ${sched.label.replace(/^Every /, 'every ').replace(/ JST$/, ' JST')}` : null,
    card ? `${card.template} card` : null, has('collection') ? 'archive' : null, has('leaderboard') ? 'leaderboard' : null, has('counter') ? 'counter' : null,
    has('map') ? 'map' : null, has('timer') ? 'countdown' : null, has('launch') ? 'coin launcher' : null, has('pq') ? 'ML-DSA-65 registry' : null].filter(Boolean).join(' · ');
}
