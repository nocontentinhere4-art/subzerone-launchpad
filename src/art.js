// Project art drawn from SUB-01's brain record: which networks the idea drove and how strongly they responded.
// Deterministic (same record -> same pixels), no external image service, no fetched inputs.
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { escapeHtml } from './util.js';

export const NETWORK_COLORS = {
  reward: '#ff6a00', attention: '#ffd23c', visual: '#3cc8ff', memory: '#b98cff', language: '#ececf2',
  fear: '#ff3c5a', default: '#7cf2c4', limbic: '#ff7ab8', control: '#8fa3ff', somatomotor: '#9cff57',
  salience: '#ffb03c', relay: '#55ddff',
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function rng(seed) {
  let s = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** [{group, weight}] strongest first, from the brain record's "networks"; at least one entry. */
export function rankedNetworks(networks) {
  const list = Object.entries(networks || {}).filter(([g]) => NETWORK_COLORS[g]).map(([group, weight]) => ({ group, weight: Number(weight) || 0 }));
  list.sort((a, b) => b.weight - a.weight || a.group.localeCompare(b.group));
  return list.length ? list : [{ group: 'language', weight: 1 }];
}

export function palette(networks) {
  const r = rankedNetworks(networks);
  return { bg: '#08080b', fg: '#ececf2', accent: NETWORK_COLORS[r[0].group], second: NETWORK_COLORS[(r[1] || r[0]).group] };
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Logo: 512x512 PNG. Concentric rings, one per network the idea drove (thickness = weight), with a slight wobble
 * whose phase comes from the seed; the core glows in the strongest network's colour, scaled by the build option's
 * vote probability.
 */
export function logoPng({ networks, seed, strength = 0.5, size = 512 }) {
  const r = rankedNetworks(networks).slice(0, 6);
  const rand = rng(seed);
  const phases = r.map(() => rand() * Math.PI * 2);
  const lobes = r.map(() => 2 + Math.floor(rand() * 5));
  const buf = Buffer.alloc(size * size * 4);
  const bg = [8, 8, 11];
  const c = size / 2;
  const core = hex(NETWORK_COLORS[r[0].group]);
  const s = Math.max(0.15, Math.min(1, Number(strength) || 0.5));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = Math.hypot(dx, dy) / c;              // 0 centre .. 1 edge
      const a = Math.atan2(dy, dx);
      let col = [...bg];
      // core glow
      const g = Math.exp(-((d / (0.18 + 0.12 * s)) ** 2));
      col = col.map((v, i) => v + (core[i] - v) * g);
      // rings
      r.forEach((n, k) => {
        const radius = 0.32 + k * 0.1 + 0.025 * Math.sin(lobes[k] * a + phases[k]);
        const width = 0.012 + 0.03 * Math.max(0.1, n.weight);
        const t = Math.max(0, 1 - Math.abs(d - radius) / width);
        if (t > 0) {
          const rc = hex(NETWORK_COLORS[n.group]);
          col = col.map((v, i) => v + (rc[i] - v) * t * 0.9);
        }
      });
      if (d > 0.97) col = [...bg];
      const o = (y * size + x) * 4;
      buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; buf[o + 3] = d > 1 ? 0 : 255;
    }
  }
  return png(size, size, buf);
}

/** Banner: 1500x500 SVG, our own markup; every text value is escaped. */
export function bannerSvg({ name, ticker, tagline, networks, seed }) {
  const r = rankedNetworks(networks).slice(0, 6);
  const rand = rng(`${seed}:banner`);
  const lines = r.map((n, k) => {
    const pts = [];
    const amp = 30 + 70 * Math.max(0.1, n.weight);
    const ph = rand() * Math.PI * 2, f = 0.004 + rand() * 0.006;
    for (let x = 0; x <= 1500; x += 25) pts.push(`${x},${(250 + (k - r.length / 2) * 26 + amp * Math.sin(x * f + ph)).toFixed(1)}`);
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${NETWORK_COLORS[n.group]}" stroke-opacity="${(0.25 + 0.6 * n.weight).toFixed(2)}" stroke-width="${(1 + 3 * n.weight).toFixed(1)}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 500" width="1500" height="500">` +
    `<rect width="1500" height="500" fill="#08080b"/>${lines}` +
    `<rect x="60" y="300" width="${40 + 22 * String(ticker).length}" height="46" fill="${NETWORK_COLORS[r[0].group]}"/>` +
    `<text x="76" y="333" font-family="ui-monospace,Menlo,monospace" font-size="26" letter-spacing="3" fill="#0a0a0a">$${escapeHtml(ticker)}</text>` +
    `<text x="60" y="270" font-family="ui-monospace,Menlo,monospace" font-size="64" font-weight="700" fill="#ececf2">${escapeHtml(name)}</text>` +
    `<text x="60" y="390" font-family="ui-monospace,Menlo,monospace" font-size="22" fill="#8f8fa3">${escapeHtml(tagline)}</text>` +
    `<text x="1440" y="470" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="16" fill="#5c5c72">built by SUB-01 · subzerone.live</text></svg>`;
}
