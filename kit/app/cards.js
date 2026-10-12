// The app's card renderer (docs/APP-COMPOSER.md, block `card`): an item drawn on a <canvas> from one of five fixed
// templates (receipt, ticket, poster, postcard, badge) with the coin logo (same origin, so the canvas stays clean and
// exports), the date in JST, the item's text, a clearly labelled keepsake number and a QR code to the item's page.
// Text goes through fillText only. Nothing is uploaded: the PNG is made in the visitor's browser.
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace', SANS = 'Inter, ui-sans-serif, system-ui, sans-serif';
const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const pad = (n) => String(n).padStart(2, '0');
/** JST parts of an instant. */
export function jst(t) {
  const d = new Date(t + 9 * 3_600_000);
  return { y: d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), wd: WD[d.getUTCDay()], hh: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()) };
}
/** The keepsake number printed on a card: RCPT-20261012-0012 (never a real receipt or ticket number; the card says so). */
export function cardNumber(template, item) {
  const j = jst(item.publishedAt || item.at || Date.now());
  const pre = { receipt: 'RCPT', ticket: 'TKT', poster: 'NO', postcard: 'PC', badge: 'ID' }[template] || 'NO';
  return `${pre}-${j.y}${j.m}${j.d}-${String(item.number ?? 0).padStart(4, '0')}`;
}
function wrap(g, text, maxW) {
  const out = [];
  for (const para of String(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (g.measureText(tryLine).width <= maxW) { line = tryLine; continue; }
      if (line) out.push(line);
      if (g.measureText(word).width <= maxW) { line = word; continue; }
      let chunk = '';                                     // a word wider than the line: break it
      for (const ch of word) { if (g.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch; } else chunk += ch; }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}
const how = (item) => ({ owner: "CHOSEN BY THE AUTHOR", votes: "CHOSEN BY THE HOLDERS' VOTES", random: 'CHOSEN BY A VERIFIABLE DRAW' }[item.how] || (item.publishedAt ? 'PUBLISHED' : 'YOUR COPY'));
const extra = (item, card) => Object.entries(item.fields || {}).filter(([k]) => k !== 'text' && k !== Object.keys(item.fields || {})[0]).map(([, v]) => String(v));

function dashed(g, x0, x1, y, color) { g.save(); g.strokeStyle = color; g.setLineDash([8, 6]); g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.restore(); }
function zigzag(g, w, y, up, color) { g.save(); g.fillStyle = color; g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= w; x += 16) g.lineTo(x, y + ((x / 16) % 2 ? (up ? -8 : 8) : 0)); g.lineTo(w, up ? y - 30 : y + 30); g.lineTo(0, up ? y - 30 : y + 30); g.closePath(); g.fill(); g.restore(); }
function gray(img, size) {
  const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
  x.drawImage(img, 0, 0, size, size);
  try { const d = x.getImageData(0, 0, size, size); for (let i = 0; i < d.data.length; i += 4) { const v = 0.3 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2]; const k = v > 150 ? 247 : v > 90 ? 120 : 20; d.data[i] = d.data[i + 1] = d.data[i + 2] = k; } x.putImageData(d, 0, 0); } catch { /* tainted: keep colour */ }
  return c;
}

// --- templates: each returns a canvas --------------------------------------------------------------------------------
function receipt(card, item, ctx) {
  const W = 576, P = 36, ink = '#1b1b1b', paper = '#f6f3ea';
  const m = document.createElement('canvas').getContext('2d');
  m.font = `400 24px ${MONO}`;
  const body = wrap(m, item.text, W - 2 * P);
  const bought = extra(item, card).map((v) => `${v.toUpperCase()} ×1`);
  const lines = (bought.length ? bought : card.lines).slice(0, 6);           // what this visitor bought, else the shop's default lines
  const H = 300 + 70 + lines.length * 34 + 90 + body.length * 34 + 360;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = paper; g.fillRect(0, 0, W, H);
  let y = 40;
  if (ctx.logo) { g.drawImage(gray(ctx.logo, 96), (W - 96) / 2, y, 96, 96); y += 112; }
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'top';
  g.font = `800 38px ${SANS}`; for (const l of wrap(g, card.heading, W - 2 * P)) { g.fillText(l, W / 2, y); y += 44; }
  g.font = `400 20px ${MONO}`; if (card.sub) { g.fillText(card.sub, W / 2, y); y += 30; }
  const j = jst(item.publishedAt || item.at || Date.now());
  g.fillText(`${j.y}/${j.m}/${j.d} (${j.wd}) ${j.hh}:${j.mm} JST  REG 01`, W / 2, y); y += 40;
  dashed(g, P, W - P, y, ink); y += 22;
  g.textAlign = 'left'; g.font = `400 24px ${MONO}`;
  for (const l of lines) { g.fillText(l, P, y); g.textAlign = 'right'; g.fillText('¥0', W - P, y); g.textAlign = 'left'; y += 34; }
  dashed(g, P, W - P, y + 4, ink); y += 26;
  g.font = `700 22px ${MONO}`; g.fillText(`${(ctx.noun || 'ITEM').toUpperCase()} #${item.number ?? '—'}`, P, y); y += 38;
  g.font = `400 24px ${MONO}`; for (const l of body) { g.fillText(l, P, y); y += 34; }
  y += 10; dashed(g, P, W - P, y, ink); y += 22;
  g.font = `400 18px ${MONO}`; g.textAlign = 'center';
  g.fillText(`RECEIPT No. ${cardNumber('receipt', item)}`, W / 2, y); y += 26;
  g.fillText('NOT A REAL RECEIPT · A KEEPSAKE', W / 2, y); y += 26;
  g.fillText(how(item), W / 2, y); y += 34;
  if (ctx.qr) { g.drawImage(ctx.qr, (W - 168) / 2, y, 168, 168); y += 176; }
  g.font = `700 20px ${MONO}`; g.fillText(`$${ctx.ticker}`, W / 2, y); y += 28;
  g.font = `400 16px ${MONO}`; g.fillText(ctx.host, W / 2, y); y += 24;
  if (card.footer) g.fillText(card.footer.slice(0, 48), W / 2, y);
  zigzag(g, W, H - 2, true, '#07070a');
  return c;
}

function ticket(card, item, ctx) {
  const W = 1100, H = 440, stub = 300, ac = '#111';   // paper cards print in black ink (docs/DESIGN.md)
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#efe7d6'; g.fillRect(0, 0, W, H);
  g.fillStyle = ac; g.fillRect(0, 0, W, 64);
  g.fillStyle = '#111'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.font = `800 32px ${SANS}`; g.fillText(card.heading, 28, 34);
  g.textAlign = 'right'; g.font = `700 20px ${MONO}`; g.fillText(card.sub || '', W - stub - 28, 34);
  g.save(); g.setLineDash([10, 8]); g.strokeStyle = '#555'; g.lineWidth = 2; g.beginPath(); g.moveTo(W - stub, 0); g.lineTo(W - stub, H); g.stroke(); g.restore();
  g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = '#111';
  let y = 88;
  g.font = `400 20px ${MONO}`; for (const l of card.lines.slice(0, 3)) { g.fillText(l, 28, y); y += 28; }
  y += 8; g.font = `700 30px ${SANS}`;
  for (const l of wrap(g, item.text, W - stub - 56).slice(0, 5)) { g.fillText(l, 28, y); y += 38; }
  const ex = extra(item, card); if (ex.length) { g.font = `400 20px ${MONO}`; g.fillText(ex.join(' · ').slice(0, 60), 28, Math.min(y + 4, H - 80)); }
  const j = jst(item.publishedAt || item.at || Date.now());
  g.font = `400 18px ${MONO}`; g.fillText(`${j.y}-${j.m}-${j.d} ${j.hh}:${j.mm} JST · ${how(item)}`, 28, H - 70);
  g.fillText(`No. ${cardNumber('ticket', item)} · NOT A REAL TICKET · $${ctx.ticker}`, 28, H - 42);
  if (ctx.qr) g.drawImage(ctx.qr, W - stub + (stub - 180) / 2, 96, 180, 180);
  g.textAlign = 'center'; g.font = `700 22px ${MONO}`; g.fillText(`#${item.number ?? '—'}`, W - stub / 2, 296);
  g.font = `400 14px ${MONO}`; g.fillText(ctx.host.slice(0, 32), W - stub / 2, 332);
  if (ctx.logo) g.drawImage(ctx.logo, W - stub / 2 - 28, H - 76, 56, 56);
  return c;
}

function poster(card, item, ctx) {
  const W = 1080, H = 1350, ac = ctx.accent || '#fff';
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.fillStyle = ac; g.fillRect(0, 0, W, 18); g.fillRect(0, H - 18, W, 18);
  g.textBaseline = 'top'; g.textAlign = 'left'; g.fillStyle = ac; g.font = `800 64px ${SANS}`; g.fillText(card.heading, 72, 80);
  g.fillStyle = '#f1efe8'; g.font = `700 28px ${MONO}`; g.fillText(card.sub || '', 72, 164);
  let size = 92; g.font = `800 ${size}px ${SANS}`; let lines = wrap(g, item.text, W - 144);
  while (lines.length > 7 && size > 40) { size -= 8; g.font = `800 ${size}px ${SANS}`; lines = wrap(g, item.text, W - 144); }
  let y = 300; for (const l of lines.slice(0, 9)) { g.fillText(l, 72, y); y += size * 1.12; }
  const j = jst(item.publishedAt || item.at || Date.now());
  g.font = `400 24px ${MONO}`; g.fillStyle = '#9a98a6'; g.fillText(`#${item.number ?? '—'} · ${j.y}-${j.m}-${j.d} · ${how(item)}`, 72, H - 210);
  g.fillText(`$${ctx.ticker} · ${ctx.host}`, 72, H - 172); if (card.footer) g.fillText(card.footer.slice(0, 50), 72, H - 134);
  if (ctx.qr) g.drawImage(ctx.qr, W - 72 - 180, H - 260, 180, 180);
  if (ctx.logo) g.drawImage(ctx.logo, W - 72 - 120, 70, 120, 120);
  return c;
}

function postcard(card, item, ctx) {
  const W = 1200, H = 800, ac = '#111';
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#f4efe3'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#c9c1ad'; g.lineWidth = 2; g.beginPath(); g.moveTo(W / 2 + 40, 120); g.lineTo(W / 2 + 40, H - 80); g.stroke();
  g.textBaseline = 'top'; g.fillStyle = '#1b1b1b'; g.textAlign = 'left';
  g.font = `800 40px ${SANS}`; g.fillText(card.heading, 60, 56);
  g.font = `400 28px ${SANS}`; let y = 150; for (const l of wrap(g, item.text, W / 2 - 60).slice(0, 14)) { g.fillText(l, 60, y); y += 38; }
  g.strokeStyle = ac; g.lineWidth = 4; g.strokeRect(W - 220, 50, 160, 190); if (ctx.logo) g.drawImage(ctx.logo, W - 205, 65, 130, 130);
  g.font = `700 16px ${MONO}`; g.fillStyle = ac; g.fillText(`$${ctx.ticker}`, W - 205, 206);
  const j = jst(item.publishedAt || item.at || Date.now());
  g.save(); g.translate(W - 360, 150); g.rotate(-0.2); g.strokeStyle = '#555'; g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 70, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#555'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `700 18px ${MONO}`; g.fillText(card.sub ? card.sub.slice(0, 14) : 'TOKYO', 0, -14); g.fillText(`${j.y}.${j.m}.${j.d}`, 0, 14); g.restore();
  g.fillStyle = '#1b1b1b'; g.textAlign = 'left'; g.textBaseline = 'top'; g.font = `400 24px ${MONO}`;
  const lines = [...card.lines, ...extra(item, card)].slice(0, 4); let ay = 330; for (const l of lines.length ? lines : ['TO: WHOEVER FINDS THIS']) { g.fillText(l, W / 2 + 80, ay); g.fillRect(W / 2 + 80, ay + 34, W / 2 - 140, 2); ay += 64; }
  g.font = `400 16px ${MONO}`; g.fillText(`No. ${cardNumber('postcard', item)} · ${how(item)}`, W / 2 + 80, H - 120); g.fillText(ctx.host, W / 2 + 80, H - 94);
  if (ctx.qr) g.drawImage(ctx.qr, W - 180, H - 180, 130, 130);
  return c;
}

function badge(card, item, ctx) {
  const S = 800, ac = ctx.accent || '#fff';
  const c = document.createElement('canvas'); c.width = S; c.height = S; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.fillStyle = ac; g.beginPath(); g.arc(S / 2, S / 2, 360, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#000'; g.beginPath(); g.arc(S / 2, S / 2, 330, 0, Math.PI * 2); g.fill();
  if (ctx.logo) { g.save(); g.beginPath(); g.arc(S / 2, 250, 100, 0, Math.PI * 2); g.clip(); g.drawImage(ctx.logo, S / 2 - 100, 150, 200, 200); g.restore(); }
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = ac; g.font = `800 34px ${SANS}`; g.fillText(card.heading, S / 2, 392);
  g.fillStyle = '#f1efe8'; let size = 60; g.font = `800 ${size}px ${SANS}`;
  let lines = wrap(g, item.text, 520); while (lines.length > 2 && size > 30) { size -= 6; g.font = `800 ${size}px ${SANS}`; lines = wrap(g, item.text, 520); }
  let y = 470; for (const l of lines.slice(0, 3)) { g.fillText(l, S / 2, y); y += size * 1.1; }
  g.font = `700 22px ${MONO}`; g.fillStyle = '#9a98a6'; g.fillText(`${card.sub || 'MEMBER'} · #${item.number ?? '—'} · $${ctx.ticker}`, S / 2, 640);
  if (ctx.qr) g.drawImage(ctx.qr, S / 2 - 40, 668, 80, 80);
  return c;
}

const TEMPLATES = { receipt, ticket, poster, postcard, badge };

/** ctx: {name, ticker, host, accent, noun, logo: HTMLImageElement|null, qr: HTMLImageElement|null} */
export function renderCard(card, item, ctx) {
  return (TEMPLATES[card.template] || postcard)(card, item, ctx);
}
