// Server-side drawing for the coin art (2026-10-12): the local black-and-white lettermark (no AI), the banner layout,
// the SVG sanitiser for provider output and the rasteriser. Rendering is resvg (@resvg/resvg-js, MPL-2.0, a native
// addon with no network or script support); the letters are Outfit (SIL OFL 1.1, src/fonts/OFL.txt), bundled so the
// result never depends on the fonts of the machine. Every PNG leaves through art.js png(): 8-bit RGBA, filter 0, the
// format postcard.js decodeOwnPng reads.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { png } from './art.js';
import { escapeHtml } from './util.js';
import { pictogram } from './coinart-glyphs.js';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts');
const FONTS = [join(FONT_DIR, 'Outfit-Black.ttf'), join(FONT_DIR, 'Outfit-Regular.ttf')];
export const LOGO_SIZE = 512;
export const BANNER_W = 1500, BANNER_H = 844;

let resvg;
/** The renderer, loaded on first use; throws when the native addon is missing (the caller then keeps the old art). */
export function renderer() {
  if (!resvg) resvg = createRequire(import.meta.url)('@resvg/resvg-js').Resvg;
  return resvg;
}

export class ArtError extends Error {}

/** SVG -> {width, height, rgba}. Fonts: the bundled ones only; never system fonts, never files the SVG names. */
export function renderRgba(svg, { width } = {}) {
  const Resvg = renderer();
  const r = new Resvg(svg, {
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Outfit' },
    background: '#000000', imageRendering: 0, shapeRendering: 2, textRendering: 1,
  });
  const img = r.render();
  return { width: img.width, height: img.height, rgba: Buffer.from(img.pixels) };
}
export const renderPng = (svg, opts) => { const x = renderRgba(svg, opts); return png(x.width, x.height, x.rgba); };

// --- the glyph: measured once per letter from a canonical rendering ---------------------------------------------------
const C = 600, FS = 430, BASE = 450;                 // analysis canvas, font size, baseline
const letterSvg = (ch, fill = '#fff') => `<text x="${C / 2}" y="${BASE}" text-anchor="middle" font-family="Outfit" font-weight="900" font-size="${FS}" fill="${fill}">${escapeHtml(ch)}</text>`;
const glyphCache = new Map();

/** Chamfer distance transform (3-4) of the cells where on(i) is true; -> Float32Array in pixels. */
function distance(w, h, on) {
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < w * h; i++) d[i] = on(i) ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) { v = Math.min(v, d[i - w] + 3); if (x > 0) v = Math.min(v, d[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4); if (x > 0) v = Math.min(v, d[i + w - 1] + 4); }
    d[i] = v;
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/**
 * Bounding box, stroke thickness and the largest enclosed counter of one letter, in the analysis canvas.
 * -> { box: {x0,y0,x1,y1}, stroke, hole: {x, y, r} | null }
 */
export function measureGlyph(ch) {
  if (glyphCache.has(ch)) return glyphCache.get(ch);
  const { width: w, height: h, rgba } = renderRgba(`<svg xmlns="http://www.w3.org/2000/svg" width="${C}" height="${C}"><rect width="${C}" height="${C}" fill="#000"/>${letterSvg(ch)}</svg>`);
  const ink = new Uint8Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4] > 127) {
      ink[i] = 1;
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new ArtError(`the font has no glyph for ${ch}`);
  // the ground reachable from the border is outside; what is left of the ground is the letter's counters
  const outside = new Uint8Array(w * h);
  const stack = [0];
  outside[0] = 1;
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && !outside[j] && !ink[j]) { outside[j] = 1; stack.push(j); }
    }
  }
  const dHole = distance(w, h, (i) => !ink[i] && !outside[i]);
  const dInk = distance(w, h, (i) => ink[i] === 1);
  let best = 0, bi = -1, stroke = 0;
  for (let i = 0; i < w * h; i++) {
    if (dHole[i] > best) { best = dHole[i]; bi = i; }
    if (dInk[i] > stroke) stroke = dInk[i];
  }
  // the letter's right contour, row by row (-1: no ink): the disc docks against it
  const right = new Float32Array(h).fill(-1);
  for (let i = 0; i < w * h; i++) if (ink[i]) { const y = (i / w) | 0; right[y] = Math.max(right[y], i % w); }
  const g = { box: { x0, y0, x1: x1 + 1, y1: y1 + 1 }, right, stroke: stroke * 2, hole: bi >= 0 && best > 4 ? { x: bi % w, y: (bi / w) | 0, r: best } : null };
  glyphCache.set(ch, g);
  return g;
}

// Letters whose bowl can hold the symbol: the bowl is redrawn as a perfect ring around a larger counter, grown away from
// the stem (dx: -1 grows left, +1 right, 0 both ways). The other letters carry the symbol on a disc set into the letter.
const BOWLS = { a: -1, b: 1, d: -1, g: -1, o: 0, p: 1, q: -1, O: 0, Q: 0, P: 1, R: 1 };

/**
 * One lettermark as an SVG group in its own coordinates, with its bounding box.
 * layout: 'counter' (the symbol in the letter's bowl) | 'disc-low' | 'disc-high' (a disc set into the letter).
 */
export function lettermark(ch, symbol, layout) {
  const g = measureGlyph(ch);
  const H = g.box.y1 - g.box.y0;
  const parts = [letterSvg(ch)];
  let { x0, y0, x1, y1 } = g.box;
  if (layout === 'counter' && g.hole && BOWLS[ch] !== undefined) {
    const t = Math.max(g.stroke * 0.8, 18);
    const R = Math.max(g.hole.r, Math.min(0.34 * Math.max(H, 260), g.hole.r * 2.1));
    const dx = BOWLS[ch];
    const cx = g.hole.x + (dx ? dx * (R - g.hole.r) : 0), cy = g.hole.y;
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${(R + t).toFixed(1)}" fill="#fff"/>`);
    if (dx) {
      // the stem, flush with the ring on its side, from the ring's top (or the ascender) to its bottom (or the descender)
      // from the window's edge to the glyph's own outer stem edge, so the new stem and the font's meet without a step
      const sx0 = dx < 0 ? cx + R : Math.min(g.box.x0, cx - R - t), sx1 = dx < 0 ? Math.max(g.box.x1, cx + R + t) : cx - R;
      const top = Math.min(cy - R - t, g.box.y0), bottom = Math.max(cy + R + t, g.box.y1);
      parts.push(`<rect x="${sx0.toFixed(1)}" y="${top.toFixed(1)}" width="${(sx1 - sx0).toFixed(1)}" height="${(bottom - top).toFixed(1)}" fill="#fff"/>`);
      y0 = Math.min(y0, top); y1 = Math.max(y1, bottom);
    }
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${R.toFixed(1)}" fill="#000"/>`, pictogram(symbol, cx, cy, R, '#fff', '#000'));
    x0 = Math.min(x0, cx - R - t); x1 = Math.max(x1, cx + R + t); y0 = Math.min(y0, cy - R - t); y1 = Math.max(y1, cy + R + t);
  } else {
    const Rd = Math.max(0.36 * Math.max(H, 260), 92), gap = Math.max(g.stroke * 0.28, 10);
    // docked against the letter's right contour, low or high: the gap ring bites a little into the strokes it meets
    // and never through a leg or an arm (an n stays an n, an r keeps its arm)
    let cy = layout === 'disc-high' ? g.box.y0 + Rd * 0.8 : g.box.y1 - Rd * 0.8;
    const Rr = Rd + gap, bite = Rd * 0.3;
    let cx = g.box.x0 + Rr;
    for (let y = Math.max(0, Math.floor(cy - Rr)); y <= Math.min(g.right.length - 1, Math.ceil(cy + Rr)); y++) {
      if (g.right[y] < 0) continue;
      cx = Math.max(cx, g.right[y] + Math.sqrt(Math.max(0, Rr * Rr - (y - cy) ** 2)) - bite);
    }
    if (ch === 'i' || ch === 'j') {
      // the disc is the letter's dot: centred over the stem, the gap circle swallowing the original dot
      cx = (g.box.x0 + g.box.x1) / 2 + (ch === 'j' ? g.stroke * 0.35 : 0);
      cy = g.box.y0 + Rd * 0.45;
      parts.push(`<rect x="${g.box.x0 - 5}" y="${g.box.y0 - 5}" width="${g.box.x1 - g.box.x0 + 10}" height="${g.stroke * 1.25}" fill="#000"/>`);
    }
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(Rd + gap).toFixed(1)}" fill="#000"/>`, `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${Rd.toFixed(1)}" fill="#fff"/>`,
      pictogram(symbol, cx, cy, Rd, '#000', '#fff'));
    x0 = Math.min(x0, cx - Rd); x1 = Math.max(x1, cx + Rd); y0 = Math.min(y0, cy - Rd); y1 = Math.max(y1, cy + Rd);
  }
  return { body: parts.join(''), box: { x0, y0, x1, y1 } };
}

const place = (mark, cx, cy, size) => {
  const w = mark.box.x1 - mark.box.x0, h = mark.box.y1 - mark.box.y0;
  const s = size / Math.max(w, h);
  return `<g transform="translate(${(cx - (mark.box.x0 + w / 2) * s).toFixed(2)} ${(cy - (mark.box.y0 + h / 2) * s).toFixed(2)}) scale(${s.toFixed(5)})">${mark.body}</g>`;
};

/** The two local options for an initial: the first puts the symbol in the counter when the letter has a bowl. */
export function localVariants(initial) {
  const lo = initial.toLowerCase(), up = initial.toUpperCase();
  const first = BOWLS[lo] !== undefined ? { ch: lo, layout: 'counter' } : BOWLS[up] !== undefined ? { ch: up, layout: 'counter' } : { ch: lo, layout: 'disc-low' };
  const otherCase = first.ch === lo ? up : lo;
  const second = first.layout === 'counter'
    ? (BOWLS[otherCase] !== undefined && otherCase !== first.ch ? { ch: otherCase, layout: 'counter' } : { ch: otherCase, layout: 'disc-low' })
    : { ch: otherCase !== first.ch ? otherCase : lo, layout: 'disc-high' };
  return [first, second];
}

export function localLogoSvg({ ch, layout, symbol }) {
  const S = LOGO_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="#000"/>${place(lettermark(ch, symbol, layout), S / 2, S / 2, S * 0.7)}</svg>`;
}

/** The banner layout: a black 16:9 field, the mark large on the right, thin rules, a faint dot grid, the credit small. */
function bannerFrame(inner, { style = 'a', credit = '' } = {}) {
  const W = BANNER_W, H = BANNER_H;
  let deco = '';
  if (style === 'a') {
    deco += `<rect x="820" y="96" width="600" height="2" fill="#fff" fill-opacity="0.85"/><rect x="820" y="746" width="600" height="2" fill="#fff" fill-opacity="0.85"/>`;
    for (let j = 0; j < 9; j++) for (let i = 0; i < 14; i++) {
      const o = Math.max(0, 1 - (i + j) / 14);
      if (o > 0.04) deco += `<circle cx="${48 + i * 22}" cy="${48 + j * 22}" r="${(1.2 + 1.8 * o).toFixed(2)}" fill="#fff" fill-opacity="${(0.15 + 0.7 * o).toFixed(2)}"/>`;
    }
  } else {
    deco += `<rect x="80" y="84" width="${W - 160}" height="1.5" fill="#fff" fill-opacity="0.7"/><rect x="80" y="${H - 86}" width="${W - 160}" height="1.5" fill="#fff" fill-opacity="0.7"/>`;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) deco += `<circle cx="${96 + i * 18}" cy="${H - 150 + j * 18}" r="1.6" fill="#fff" fill-opacity="0.35"/>`;
  }
  const cr = credit ? `<text x="80" y="${H - 44}" font-family="Outfit" font-weight="400" font-size="17" letter-spacing="1.5" fill="#8a8a8a">${escapeHtml(credit)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#000"/>${deco}${inner}${cr}</svg>`;
}

export function localBannerSvg({ ch, layout, symbol, style, credit }) {
  return bannerFrame(place(lettermark(ch, symbol, layout), style === 'a' ? 1120 : 1150, BANNER_H / 2, style === 'a' ? 560 : 540), { style, credit });
}

/** A banner around an image we already hold (a provider's or the owner's logo PNG): the same frame, the logo on the right. */
export function bannerAroundLogo(logoPng, { style = 'a', credit = '' } = {}) {
  const size = style === 'a' ? 640 : 700;
  const img = `<image x="${(style === 'a' ? 1120 : 1150) - size / 2}" y="${(BANNER_H - size) / 2}" width="${size}" height="${size}" href="data:image/png;base64,${logoPng.toString('base64')}"/>`;
  return renderPng(bannerFrame(img, { style, credit }));
}

// --- provider output -----------------------------------------------------------------------------------------------
const MAX_SVG = 2_000_000, MAX_RASTER = 8_000_000;
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'clippath', 'mask', 'use',
  'lineargradient', 'radialgradient', 'stop', 'title', 'desc', 'symbol']);

/**
 * Provider SVG -> a clean SVG string, or ArtError. Metadata, comments and the XML prolog are dropped; anything able to
 * run, fetch or read (script, foreignObject, image, style sheets, event handlers, non-local href/url()) is refused,
 * not repaired: an SVG that carries any of it is rejected whole.
 */
export function sanitizeSvg(input) {
  let s = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  if (s.length > MAX_SVG) throw new ArtError('svg too large');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(s)) throw new ArtError('svg with a DOCTYPE, entity or CDATA');
  s = s.replace(/^﻿/, '').replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, '').trim();
  if (!/^<svg[\s>]/i.test(s)) throw new ArtError('not an svg document');
  if (/<\?/.test(s)) throw new ArtError('processing instruction in svg');
  for (const m of s.matchAll(/<\/?\s*([a-zA-Z][\w:.-]*)/g)) {
    if (!SVG_TAGS.has(m[1].toLowerCase())) throw new ArtError(`svg element <${m[1].slice(0, 30)}> not allowed`);
  }
  for (const tag of s.match(/<[a-zA-Z][^>]*>/g) || []) {
    for (const a of tag.matchAll(/\s([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = a[1].toLowerCase(), value = a[3] ?? a[4] ?? '';
      if (name.startsWith('on')) throw new ArtError(`event handler ${name} in svg`);
      if ((name === 'href' || name === 'xlink:href') && !/^#[\w.-]+$/.test(value.trim())) throw new ArtError('svg reference outside the document');
      if (name === 'style' && /url\s*\(|@import|expression|javascript:/i.test(value)) throw new ArtError('svg style attribute with a reference');
      if (/url\s*\(/i.test(value) && !/^\s*url\(\s*#[\w.-]+\s*\)\s*$/.test(value.replace(/["']/g, ''))) throw new ArtError('svg url() outside the document');
      if (/javascript:|data:/i.test(value) && name !== 'xmlns' && !name.startsWith('xmlns:')) throw new ArtError('svg attribute with a script or data URL');
    }
  }
  return s;
}

export function sniff(b) {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  const head = b.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

/**
 * Provider (or owner) image bytes -> our PNG at width x height: an SVG is sanitised first; either kind is drawn into
 * a black frame (centred, aspect kept), turned grey (no colour survives) and near-black is pulled to black so the
 * banner and site backgrounds meet it without a seam.
 */
export function normalizeImage(bytes, width, height) {
  const kind = sniff(bytes);
  if (!kind) throw new ArtError('unknown image format');
  if (kind !== 'svg' && bytes.length > MAX_RASTER) throw new ArtError('image too large');
  const data = kind === 'svg'
    ? `data:image/svg+xml;base64,${Buffer.from(sanitizeSvg(bytes)).toString('base64')}`
    : `data:image/${kind};base64,${bytes.toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<filter id="bw" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/>` +
    `<feComponentTransfer><feFuncR type="linear" slope="1.06" intercept="-0.04"/><feFuncG type="linear" slope="1.06" intercept="-0.04"/><feFuncB type="linear" slope="1.06" intercept="-0.04"/></feComponentTransfer></filter>` +
    `<rect width="${width}" height="${height}" fill="#000"/><image width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" filter="url(#bw)" href="${data}"/></svg>`;
  const out = renderRgba(svg);
  // a provider image that rendered to nothing (an unsupported feature, an empty document) is a failure, not a logo
  let lit = 0;
  for (let i = 0; i < out.rgba.length; i += 4 * 7) if (out.rgba[i] > 128) lit++;
  if (lit < 20) throw new ArtError('image rendered empty');
  return png(out.width, out.height, out.rgba);
}
