// Share postcards, 1200×630 (the og:image size): a public project (name, $TICKER, stage, its logo) or an apartment
// (the resident's name, district, a figure in their colours), the SUBZERONE lockup, a stamp and the Tokyo date.
// State only, never a price or any market number. Two renderings of the same card:
//  - SVG: real text in system fonts, the brand lockup inlined (it is path-lettered, so no font is needed), a kanji stamp;
//  - PNG: drawn pixel by pixel with a built-in 5×7 bitmap font (ASCII only; other characters print as '?') and the
//    PNG encoder of art.js, for the sites that do not accept SVG previews (X, Facebook, Discord, Telegram).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { ROOT } from './config.js';
import { png, rankedNetworks, NETWORK_COLORS } from './art.js';
import { escapeHtml } from './util.js';

export const W = 1200, H = 630;
const BG = '#08080b', FG = '#ececf2', MUTED = '#8f8fa3', STAMP = '#e0353b';
const SANS = 'ui-sans-serif,system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
const MONO = 'ui-monospace,Menlo,Consolas,monospace';
const MINCHO = "'Hiragino Mincho ProN','Yu Mincho','Noto Serif JP',serif";

// the brand lockup (public/brand/lockup.svg, viewBox 0 0 861 224), inner markup only
const LOCKUP = readFileSync(join(ROOT, 'public', 'brand', 'lockup.svg'), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '');

const STAMPS = { submitted: '待', evaluating: '待', selected: '建', generating: '建', preview_ready: '建', approved: '建', launch_prepared: '建',
  awaiting_signature: '建', confirming: '建', launched: '発', failed: '休', cancelled: '休', declined: '休' };
export const stampFor = (card) => (card.kind === 'room' ? '住' : STAMPS[card.stage] || '建');
const dotted = (date) => date.replaceAll('-', '.');
const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };
const accentOf = (card) => (card.kind === 'room' ? card.look?.top || '#ff6a00' : NETWORK_COLORS[rankedNetworks(card.networks)[0].group]);
const sublineOf = (card) => (card.kind === 'room' ? 'SUBZERONE city, Tokyo' : 'Built by SUB-01 · SUBZERONE city');
const titleOf = (card) => card.name;
const labelOf = (card) => (card.kind === 'room' ? `Lives in ${card.district}` : card.stageLabel);
// the text column runs from x 460; the stamp (top right) starts near x 940, the frame ends at 1176
const TEXT_X = 460, NAME_MAX_W = 450, LINE_MAX_W = 690;

/** Wave lines from the brain's networks (project) or from the plot id (room): deterministic. */
function waves(card) {
  const nets = card.kind === 'room' ? [{ group: 'visual', weight: 0.6 }, { group: 'reward', weight: 0.4 }] : rankedNetworks(card.networks).slice(0, 5);
  const seed = [...String(card.slug || card.plotId || 'x')].reduce((a, c) => (a * 31 + c.codePointAt(0)) >>> 0, 7);
  return nets.map((n, k) => ({ color: NETWORK_COLORS[n.group], weight: Math.max(0.1, Math.min(1, Number(n.weight) || 0.1)),
    base: 500 - k * 12, amp: 6 + 18 * Math.max(0.1, Number(n.weight) || 0.1), f: 0.004 + ((seed >> (k * 3)) % 7) * 0.0012, ph: ((seed >> k) % 628) / 100 }));
}
const waveY = (w, x) => w.base + w.amp * Math.sin(x * w.f + w.ph);
const WAVE_X0 = 440, WAVE_X1 = 1176;                     // right of the lockup, above the date

// --- SVG ----------------------------------------------------------------------------------------------------------------
function avatarSvg(look) {
  const l = look || {};
  return `<g transform="translate(0 -36)"><circle cx="240" cy="196" r="66" fill="${l.hair || '#1b1b1b'}"/><circle cx="240" cy="214" r="56" fill="${l.skin || '#e8b48f'}"/>` +
    `<circle cx="220" cy="212" r="6" fill="#141418"/><circle cx="260" cy="212" r="6" fill="#141418"/>` +
    `<rect x="168" y="276" width="144" height="128" rx="18" fill="${l.top || '#ff6a00'}"/>` +
    `<rect x="184" y="400" width="50" height="72" rx="8" fill="${l.bottom || '#222222'}"/><rect x="246" y="400" width="50" height="72" rx="8" fill="${l.bottom || '#222222'}"/></g>`;
}

export function postcardSvg(card) {
  const accent = accentOf(card);
  const name = clip(titleOf(card), 28);
  const size = Math.max(30, Math.min(76, Math.floor(NAME_MAX_W / ([...name].length * 0.6))));   // ~0.6 em per character in bold sans
  const lines = waves(card).map((w) => {
    const pts = [];
    for (let x = WAVE_X0; x <= WAVE_X1; x += 16) pts.push(`${x},${waveY(w, x).toFixed(1)}`);
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${w.color}" stroke-opacity="${(0.2 + 0.5 * w.weight).toFixed(2)}" stroke-width="${(1 + 2.5 * w.weight).toFixed(1)}"/>`;
  }).join('');
  const visual = card.kind === 'room' ? avatarSvg(card.look)
    : card.logo ? `<image href="data:image/png;base64,${card.logo.toString('base64')}" x="80" y="120" width="320" height="320"/>`
      : `<circle cx="240" cy="280" r="150" fill="none" stroke="${accent}" stroke-width="18"/>`;
  const ticker = card.kind === 'project' && card.ticker ? `$${clip(card.ticker, 12)}` : null;
  const tickerBox = ticker ? `<rect x="460" y="252" width="${48 + 22 * ticker.length}" height="54" fill="${accent}"/>` +
    `<text x="482" y="290" font-family="${MONO}" font-size="30" letter-spacing="3" fill="#0a0a0a">${escapeHtml(ticker)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<title>${escapeHtml(`${titleOf(card)} · SUBZERONE`)}</title>` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>${lines}` +
    `<rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="none" stroke="${FG}" stroke-opacity="0.18" stroke-width="2"/>` +
    visual +
    `<text x="460" y="218" font-family="${SANS}" font-size="${size}" font-weight="700" fill="${FG}">${escapeHtml(name)}</text>` + tickerBox +
    `<text x="460" y="${ticker ? 362 : 290}" font-family="${SANS}" font-size="30" fill="#c9c9d6">${escapeHtml(clip(labelOf(card), 44))}</text>` +
    `<text x="460" y="${ticker ? 404 : 332}" font-family="${SANS}" font-size="22" fill="${MUTED}">${escapeHtml(sublineOf(card))}</text>` +
    `<g transform="translate(1030 136) rotate(-8)"><rect x="-78" y="-78" width="156" height="156" rx="12" fill="none" stroke="${STAMP}" stroke-width="6"/>` +
    `<text x="0" y="36" text-anchor="middle" font-family="${MINCHO}" font-size="104" fill="${STAMP}">${stampFor(card)}</text></g>` +
    `<svg x="72" y="462" width="340" height="88" viewBox="0 0 861 224">${LOCKUP}</svg>` +
    `<text x="${W - 80}" y="${H - 64}" text-anchor="end" font-family="${MONO}" font-size="22" letter-spacing="2" fill="${MUTED}">${dotted(card.date)} · TOKYO</text>` +
    '</svg>';
}

// --- PNG ----------------------------------------------------------------------------------------------------------------
// 5×7 glyphs, rows top to bottom; lowercase prints as uppercase, accents are stripped, anything else is '?'.
const G = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100011000101010001000010000100', Z: '11111000010001000100010001000011111',
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
  3: '11111000100010000010000011000101110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010001001100',
  ' ': '00000000000000000000000000000000000', $: '00100011111010001110001011111000100', '-': '00000000000000011111000000000000000',
  '.': '00000000000000000000000000110001100', "'": '01100001000100000000000000000000000', _: '00000000000000000000000000000011111',
  ':': '00000011000110000000011000110000000', '/': '00000000010001000100010001000000000', '(': '00010001000100001000010000010000010',
  ')': '01000001000001000010000100010001000', '!': '00100001000010000100001000000000100', '?': '01110100010000100010001000000000100',
  '·': '00000000000000000100000000000000000', '&': '01100100101010001000101011001001101', '#': '01010010101111101010111110101001010',
  '+': '00000001000010011111001000010000000', '@': '01110100010000101101101011010101110', ',': '00000000000000000000011000010001000',
};
const glyph = (c) => G[c] || G['?'];
const asciiOf = (s) => [...String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase()]
  .map((c) => (c === '…' ? '.' : G[c] ? c : '?')).join('');
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function canvas() {
  const buf = Buffer.alloc(W * H * 4);
  const [br, bg, bb] = rgb(BG);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = br; buf[i * 4 + 1] = bg; buf[i * 4 + 2] = bb; buf[i * 4 + 3] = 255; }
  const put = (x, y, c, a = 1) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
    const o = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) buf[o + k] = Math.round(buf[o + k] + (c[k] - buf[o + k]) * Math.min(1, a));
  };
  const rect = (x, y, w, h, c, a = 1) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(i, j, c, a); };
  const circle = (cx, cy, r0, r1, c) => {             // filled when r0 = 0, a ring otherwise
    for (let j = Math.floor(cy - r1); j <= cy + r1; j++) for (let i = Math.floor(cx - r1); i <= cx + r1; i++) {
      const d = Math.hypot(i - cx, j - cy);
      if (d <= r1 && d >= r0) put(i, j, c, Math.min(1, r1 - d + 0.5, r0 ? d - r0 + 0.5 : 1));
    }
  };
  const textWidth = (s, scale) => asciiOf(s).length * 6 * scale - scale;
  const text = (s, x, y, scale, color) => {            // color: rgb or (px) => rgb (a gradient across x)
    [...asciiOf(s)].forEach((ch, n) => {
      const g = glyph(ch);
      for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) {
        if (g[r * 5 + col] !== '1') continue;
        const px = x + (n * 6 + col) * scale;
        rect(px, y + r * scale, scale, scale, typeof color === 'function' ? color(px) : color);
      }
    });
  };
  const image = (rgba, sw, sh, x, y, dw, dh) => {
    for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
      const o = ((Math.floor(j * sh / dh)) * sw + Math.floor(i * sw / dw)) * 4;
      put(x + i, y + j, [rgba[o], rgba[o + 1], rgba[o + 2]], rgba[o + 3] / 255);
    }
  };
  return { buf, put, rect, circle, text, textWidth, image };
}

/** Our own PNGs only (art.js logos: 8-bit RGBA, filter 0 on every row). Anything else -> null. */
export function decodeOwnPng(b) {
  try {
    if (!b || b.length < 33 || b.readUInt32BE(12) !== 0x49484452) return null;
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    if (b[24] !== 8 || b[25] !== 6 || w > 2048 || h > 2048) return null;
    const idat = [];
    for (let o = 8; o + 8 <= b.length;) {
      const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
      if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
      if (type === 'IEND') break;
      o += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    if (raw.length !== (w * 4 + 1) * h) return null;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      if (raw[y * (w * 4 + 1)] !== 0) return null;
      raw.copy(out, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
    }
    return { w, h, rgba: out };
  } catch { return null; }
}

export function postcardPng(card) {
  const c = canvas();
  const fg = rgb(FG), muted = rgb(MUTED), stamp = rgb(STAMP), accent = rgb(accentOf(card));
  for (const w of waves(card)) {
    const col = rgb(w.color), a = 0.2 + 0.5 * w.weight, t = Math.max(1, Math.round(1 + 2.5 * w.weight));
    for (let x = WAVE_X0; x < WAVE_X1; x++) c.rect(x, Math.round(waveY(w, x)), 1, t, col, a);
  }
  // frame
  c.rect(24, 24, W - 48, 2, fg, 0.18); c.rect(24, H - 26, W - 48, 2, fg, 0.18); c.rect(24, 24, 2, H - 48, fg, 0.18); c.rect(W - 26, 24, 2, H - 48, fg, 0.18);
  // visual
  if (card.kind === 'room') {
    const l = card.look || {}, dy = -36;                // the same figure as avatarSvg
    c.circle(240, 196 + dy, 0, 66, rgb(l.hair || '#1b1b1b')); c.circle(240, 214 + dy, 0, 56, rgb(l.skin || '#e8b48f'));
    c.circle(220, 212 + dy, 0, 6, [20, 20, 24]); c.circle(260, 212 + dy, 0, 6, [20, 20, 24]);
    c.rect(168, 276 + dy, 144, 128, rgb(l.top || '#ff6a00'));
    c.rect(184, 400 + dy, 50, 72, rgb(l.bottom || '#222222')); c.rect(246, 400 + dy, 50, 72, rgb(l.bottom || '#222222'));
  } else {
    const logo = decodeOwnPng(card.logo);
    if (logo) c.image(logo.rgba, logo.w, logo.h, 80, 120, 320, 320); else c.circle(240, 280, 141, 159, accent);
  }
  // name, ticker, stage, subline
  const name = clip(asciiOf(titleOf(card)), 28);
  const fit = (s, maxW, max) => Math.max(2, Math.min(max, Math.floor((maxW + 1) / Math.max(1, asciiOf(s).length * 6))));
  const scale = fit(name, NAME_MAX_W, 9);
  c.text(name, TEXT_X, 214 - 7 * scale, scale, fg);
  let y = 248;
  if (card.kind === 'project' && card.ticker) {
    const t = `$${clip(card.ticker, 12)}`;
    c.rect(460, y, c.textWidth(t, 5) + 40, 35 + 20, accent);
    c.text(t, 480, y + 10, 5, [10, 10, 10]);
    y += 55 + 30;
  }
  const label = clip(labelOf(card), 44);
  c.text(label, TEXT_X, y, fit(label, LINE_MAX_W, 4), rgb('#c9c9d6'));
  c.text(sublineOf(card), TEXT_X, y + 50, fit(sublineOf(card), LINE_MAX_W, 3), muted);
  // postmark: SUBZERONE / date / TOKYO in a red ring
  c.circle(1030, 136, 86, 94, stamp);
  const centered = (s, cy, sc) => c.text(s, 1030 - Math.round(c.textWidth(s, sc) / 2), cy, sc, stamp);
  centered('SUBZERONE', 96, 2); centered(dotted(card.date), 130, 2); centered('TOKYO', 156, 3);
  // lockup stand-in: the wordmark in the brand gradient
  const stops = [rgb('#FF4D6D'), rgb('#FB752B'), rgb('#FFC24B')];
  const word = 'SUBZERONE', x0 = 80, ww = c.textWidth(word, 6);
  const grad = (px) => {
    const t = Math.max(0, Math.min(1, (px - x0) / ww)) * 2, i = Math.min(1, Math.floor(t)), f = t - i;
    return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  };
  c.text(word, x0, 500, 6, grad);
  c.text('TOKYO LAUNCHPAD', x0, 552, 2, muted);
  return png(W, H, c.buf);
}
