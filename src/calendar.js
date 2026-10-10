// The city's calendar, on Tokyo time (JST, UTC+9, no daylight saving). Deterministic: the week theme comes from the
// ISO week alone, the rituals from the date; the rest is derived from data (launches, projects about to open). Public
// projects only, never a wallet. calendarView(db, cfg, t) is pure for a given database and time.
import { now } from './util.js';

const JST = 9 * 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;
const EPOCH_MONDAY = Date.UTC(1970, 0, 5);                // the first Monday after the unix epoch
export const PARTY_MS = 3 * 3_600_000;                    // a launch street party lasts 3 hours
export const OPEN_SOON_MS = DAY;                          // launch_prepared / awaiting_signature: expected within 24 h

// rotating in this order, one per ISO week: index = (weeks since 1970-01-05) mod 8
export const THEMES = Object.freeze([
  { id: 'hanami', title: 'Hanami', kanji: '花見', text: 'Cherry blossoms on every street; picnic mats under the trees.' },
  { id: 'matsuri', title: 'Matsuri', kanji: '祭', text: 'Festival week: stalls, drums and paper lanterns in the districts.' },
  { id: 'neon', title: 'Neon nights', kanji: 'ネオン', text: 'The signs stay on all night; the city glows pink and cyan.' },
  { id: 'rain', title: 'Tsuyu', kanji: '梅雨', text: 'Rainy season: umbrellas, puddle reflections and hydrangeas.' },
  { id: 'obon', title: 'Obon', kanji: 'お盆', text: 'Lantern week: lights float down the river for the ancestors.' },
  { id: 'moon', title: 'Tsukimi', kanji: '月見', text: 'Moon viewing: a big full moon, rice dumplings on the rooftops.' },
  { id: 'snow', title: 'Yuki', kanji: '雪', text: 'Snow week: quiet white streets and steam from the ramen stands.' },
  { id: 'newyear', title: 'Shōgatsu', kanji: '正月', text: 'New Year: shrine visits, kadomatsu at the doors, a fresh start.' },
]);

const jstDate = (t) => new Date(t + JST).toISOString().slice(0, 10);
const dayStart = (t) => Math.floor((t + JST) / DAY) * DAY - JST;

/** ISO 8601 week of the JST date containing t: {label: 'YYYY-Www', index (weeks since 1970-01-05), starts, ends}. */
export function isoWeek(t) {
  const index = Math.floor((t + JST - EPOCH_MONDAY) / WEEK);
  const starts = EPOCH_MONDAY + index * WEEK - JST;          // Monday 00:00 JST
  const thursday = new Date(starts + JST + 3 * DAY);         // the ISO year is the Thursday's year
  const y = thursday.getUTCFullYear();
  const jan4 = Date.UTC(y, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const n = Math.round((thursday.getTime() - 3 * DAY - week1) / WEEK) + 1;
  return { label: `${y}-W${String(n).padStart(2, '0')}`, index, starts, ends: starts + WEEK };
}

const event = (kind, at, ends, title, p = {}) => ({ kind, at, ends, title, slug: p.slug ?? null, name: p.name ?? null,
  ticker: p.ticker ?? null, plotId: p.plot_id ?? null });

export function calendarView(db, cfg, t = now()) {
  const w = isoWeek(t);
  const theme = THEMES[((w.index % THEMES.length) + THEMES.length) % THEMES.length];
  const today0 = dayStart(t), today1 = today0 + DAY;
  const hideMock = cfg.production ? `AND l.provider != 'mock'` : '';
  const parties = db.all(`SELECT l.verified_at, p.slug, p.name, p.ticker, pl.plot_id FROM launches l JOIN projects p ON p.id = l.project_id
      JOIN ideas i ON i.id = p.idea_id LEFT JOIN plots pl ON pl.idea_id = i.id
      WHERE i.visibility = 'public' AND l.verified_at >= ? AND l.verified_at < ? ${hideMock} ORDER BY l.verified_at`, today0, today1)
    .map((p) => event('launch_party', p.verified_at, p.verified_at + PARTY_MS, `Street party: $${p.ticker} launched`, p));
  const soon = db.all(`SELECT p.slug, p.name, p.ticker, pl.plot_id FROM projects p JOIN ideas i ON i.id = p.idea_id LEFT JOIN plots pl ON pl.idea_id = i.id
      WHERE i.visibility = 'public' AND i.status IN ('launch_prepared', 'awaiting_signature') ORDER BY i.updated_at, p.id`)
    .map((p) => event('open_soon', t, t + OPEN_SOON_MS, `Opening soon: $${p.ticker}`, p));
  // placeholder: the monthly room ranking closes at the end of the last day of the month (23:59 JST)
  const d = new Date(t + JST);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - JST;
  const ranking = { ...event('ranking', monthEnd - 60_000, monthEnd, 'Monthly room ranking closes'), placeholder: true };
  const omikuji = (at) => ({ ...event('omikuji', at, at + DAY, 'Omikuji: draw the day\'s fortune'), time: '00:00 JST' });
  const isToday = (e) => e.at >= today0 && e.at < today1;
  const byAt = (a, b) => a.at - b.at || a.kind.localeCompare(b.kind);
  return {
    now: t, tokyoDate: jstDate(t),
    weekTheme: { id: theme.id, title: theme.title, kanji: theme.kanji, text: theme.text, isoWeek: w.label, starts: w.starts, ends: w.ends },
    today: { starts: today0, ends: today1, events: [omikuji(today0), ...parties, ...(isToday(ranking) ? [ranking] : [])].sort(byAt) },
    upcoming: [omikuji(today1), ...soon, ...(isToday(ranking) ? [] : [ranking])].sort(byAt).slice(0, 30),
  };
}
