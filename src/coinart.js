// The coin art of new ideas (2026-10-12, the owner's style; docs/COIN-ART.md): a black-and-white geometric lettermark,
// the coin name's initial with ONE pictogram of the idea's subject built into it, and a 16:9 banner in the same style.
// Two candidates per coin; the author picks one (app.js /api/projects/:slug/art), option 1 is live until then.
//   1. owner-supplied art, art/<dir>/ in the repo, for the owner's own coins (premadeArt): candidate 1
//   2. Higgsfield (HF_API_KEY_ID/SECRET), else Recraft's own API (RECRAFT_API_KEY): the AI candidates
//   3. the local generator (coinart-render.js, no AI): whatever is still missing, and every candidate on any failure
// Nothing here may stop a build: the whole step has a deadline (ART_TIMEOUT_MS, 45 s) and ends in the local drawing.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pickSymbol } from './coinart-glyphs.js';
import { ArtError, BANNER_H, BANNER_W, LOGO_SIZE, bannerAroundLogo, localBannerSvg, localLogoSvg, localVariants, normalizeImage, renderPng } from './coinart-render.js';
import { parseJson } from './util.js';

export const ART_VERSION = 'bw/1';
const MAX_DOWNLOAD = 8_000_000;

const STYLE = 'Strictly two colours: pure white #FFFFFF on pure black #000000. Flat vector shapes, crisp edges, solid fills. ' +
  'No colour, no gradients, no shading, no texture, no 3D, no mascot characters, no photos, no frame, ' +
  'nothing that resembles an existing brand or logo.';

/** The initial of the coin name (a letter or digit), or of the ticker; 'x' when neither has one. */
export function initialOf(name, ticker) {
  for (const s of [name, ticker]) {
    const m = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[A-Za-z0-9]/);
    if (m) return m[0];
  }
  return 'x';
}

export function logoPrompt({ initial, symbol }) {
  const lower = initial.toLowerCase() === initial;
  return `Minimal black-and-white geometric lettermark logo. One thick, bold, geometric white ${/[0-9]/.test(initial) ? 'digit' : lower ? 'lowercase letter' : 'uppercase letter'} ` +
    `"${initial}" centred on a pure black background, large, with a generous margin. Built into the letter's counter (or set into its stroke): ` +
    `${symbol.say}, flat, simple and recognisable at a glance, the only symbol in the image. ${STYLE} No other letters, no words, no text.`;
}
export function bannerPrompt({ initial, symbol }) {
  return `Minimal black-and-white 16:9 banner. Pure black background. On the right side, large: one thick bold geometric white letter "${initial}" ` +
    `with ${symbol.say} built into its counter. Thin white horizontal rules and a faint white dot grid in one corner; a large empty black ` +
    `space on the left. ${STYLE} No other letters or words, no text.`;
}

// --- downloads -----------------------------------------------------------------------------------------------------
/** A provider's output file: https only, a public host name (no IP literals, no localhost), at most 8 MB; up to three
 *  redirects, each target checked the same way (a CDN may sign and redirect; it may not point us inside). */
export async function download(url, { fetchImpl = fetch, signal }, hops = 0) {
  let u;
  try { u = new URL(url); } catch { throw new ArtError('bad output url'); }
  if (u.protocol !== 'https:' || /^(localhost|.*\.localhost|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(u.hostname) || u.username || u.password) {
    throw new ArtError(`output url refused: ${u.protocol}//${u.hostname}`);
  }
  const res = await fetchImpl(u.href, { signal, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers?.get?.('location');
    if (!to || hops >= 3) throw new ArtError('output redirect refused');
    return download(new URL(to, u).href, { fetchImpl, signal }, hops + 1);
  }
  if (!res.ok) throw new ArtError(`output download ${res.status}`);
  if (Number(res.headers?.get?.('content-length') || 0) > MAX_DOWNLOAD) throw new ArtError('output too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new ArtError('output too large');
  return buf;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new ArtError('aborted'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new ArtError('aborted')); }, { once: true });
});

// --- Higgsfield ----------------------------------------------------------------------------------------------------
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
/** Poll intervals (ms): 2 s growing to 5 s, as the API's polling guide asks. Tests replace it. */
export const HF_POLL = { delays: [2000, 2000, 3000, 3000, 4000, 5000] };

/**
 * One image from Higgsfield: POST /<model> (Idempotency-Key: the same intent never pays twice), poll the request's
 * status URL until completed|failed|nsfw|canceled, download images[0].url. -> { bytes, requestId, model }
 */
export async function higgsfieldImage(art, { model, prompt, aspect, key }, { fetchImpl = fetch, signal }) {
  const base = new URL(art.hfBase);
  const auth = { authorization: `Key ${art.hfKeyId}:${art.hfKeySecret}` };
  const body = { prompt, resolution: '1k', aspect_ratio: aspect, output_format: 'png',
    colors: [{ rgb: [255, 255, 255] }, { rgb: [0, 0, 0] }], background_color: { rgb: [0, 0, 0] }, ...(parseJson(art.hfParams) || {}) };
  const res = await fetchImpl(new URL(`/${model.replace(/^\/+/, '')}`, base).href, {
    method: 'POST', signal, headers: { ...auth, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  const sub = await res.json().catch(() => ({}));
  if (!res.ok) throw new ArtError(`higgsfield ${res.status}${sub?.detail ? `: ${String(typeof sub.detail === 'string' ? sub.detail : JSON.stringify(sub.detail)).slice(0, 160)}` : ''}`);
  const requestId = String(sub.request_id || '');
  if (!/^[\w-]{1,80}$/.test(requestId)) throw new ArtError('higgsfield: no request id');
  // the status URL from the response, but only on the API's own origin: the key never goes to another host
  let statusUrl = new URL(`/requests/${requestId}/status`, base).href;
  try { if (sub.status_url && new URL(sub.status_url).origin === base.origin) statusUrl = new URL(sub.status_url).href; } catch { /* keep ours */ }
  let st = sub, n = 0;
  while (!TERMINAL.has(st.status)) {
    await sleep(HF_POLL.delays[Math.min(n++, HF_POLL.delays.length - 1)], signal);
    const r = await fetchImpl(statusUrl, { signal, headers: { ...auth, accept: 'application/json' } });
    if (r.status >= 500) continue;                                  // transient: poll again (the deadline bounds it)
    if (!r.ok) throw new ArtError(`higgsfield status ${r.status}`);
    st = await r.json();
  }
  if (st.status !== 'completed') throw new ArtError(`higgsfield request ${requestId} ended ${st.status}${st.error ? `: ${String(st.error).slice(0, 120)}` : ''}`);
  const url = st.images?.[0]?.url;
  if (!url) throw new ArtError(`higgsfield request ${requestId}: completed without an image`);
  return { bytes: await download(url, { fetchImpl, signal }), requestId, model };
}

// --- Recraft (its own API) -----------------------------------------------------------------------------------------
/** n images in one request (POST /v1/images/generations, model *_vector returns SVG). -> [{ bytes, requestId, model }] */
export async function recraftImages(art, { prompt, aspect, n }, { fetchImpl = fetch, signal }) {
  const res = await fetchImpl('https://external.api.recraft.ai/v1/images/generations', {
    method: 'POST', signal, headers: { authorization: `Bearer ${art.recraftKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, model: art.recraftModel, n, size: aspect, response_format: 'url',
      controls: { colors: [{ rgb: [255, 255, 255] }, { rgb: [0, 0, 0] }], background_color: { rgb: [0, 0, 0] } } }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ArtError(`recraft ${res.status}${out?.message ? `: ${String(out.message).slice(0, 160)}` : ''}`);
  const urls = (out.data || []).map((d) => d?.url).filter(Boolean);
  if (!urls.length) throw new ArtError('recraft: no image');
  return Promise.all(urls.slice(0, n).map(async (url, i) => ({ bytes: await download(url, { fetchImpl, signal }), requestId: out.created ? `${out.created}:${i}` : null, model: art.recraftModel })));
}

/** Which provider the keys select, or null. */
export const providerOf = (art) => (art?.hfKeyId && art?.hfKeySecret ? 'higgsfield' : art?.recraftKey ? 'recraft' : null);

// --- owner-supplied art --------------------------------------------------------------------------------------------
export const slugBase = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'project';

/**
 * art/<dir>/ for this coin: the directory named after the ticker or the slug (case does not matter), or one whose
 * match.json lists them ({tickers, slugs, wallets}). Only for the owner's own coins: the idea's wallet must be in
 * match.json "wallets" or, when that is absent, in ADMIN_WALLETS; anyone else naming a coin QPAD gets generated art.
 * -> { dir, logo: Buffer, logoFile, banner: Buffer|null, bannerFile } | null
 */
export function premadeArt(art, { ticker, slug, wallet, adminWallets = [] }) {
  if (!art?.dir || !existsSync(art.dir)) return null;
  const t = String(ticker || '').toLowerCase(), sl = String(slug || '').toLowerCase();
  for (const d of readdirSync(art.dir, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^[a-z0-9-]{1,40}$/i.test(d.name)) continue;
    const dir = join(art.dir, d.name);
    const m = existsSync(join(dir, 'match.json')) ? parseJson(readFileSync(join(dir, 'match.json'), 'utf8')) || {} : {};
    const tickers = [d.name, ...(m.tickers || [])].map((x) => String(x).toLowerCase());
    const slugs = [d.name, ...(m.slugs || [])].map((x) => String(x).toLowerCase());
    if (!(t && tickers.includes(t)) && !(sl && slugs.includes(sl))) continue;
    const allowed = Array.isArray(m.wallets) ? m.wallets : adminWallets;
    if (!wallet || !allowed.includes(wallet)) return null;
    const pick = (base) => ['svg', 'png'].map((x) => `${base}.${x}`).find((f) => existsSync(join(dir, f))) || null;
    const logoFile = pick('logo'), bannerFile = pick('banner');
    if (!logoFile) return null;
    return { dir: d.name, logoFile, logo: readFileSync(join(dir, logoFile)), bannerFile, banner: bannerFile ? readFileSync(join(dir, bannerFile)) : null };
  }
  return null;
}

// --- the step ------------------------------------------------------------------------------------------------------
const gen = (o) => JSON.stringify({ art: ART_VERSION, ...o });

/**
 * The two candidates of a new coin. Never throws for a provider problem: notes[] says what fell back and why.
 * -> { candidates: [{ logo: {body, mime, generator}, banner: {body, mime, generator} } x2], notes: string[], symbol, provider }
 */
export async function makeCoinArt({ cfg, idea, spec, slug, wallet, seed, credit = '', fetchImpl = fetch, signal, spend }) {
  const art = cfg.art || {};
  const symbol = pickSymbol({ name: spec.name, title: idea.title, concept: idea.concept }, seed);
  const initial = initialOf(spec.name, spec.ticker);
  const notes = [];
  const candidates = [];
  const sym = { id: symbol.id, keyword: symbol.keyword, abstract: symbol.abstract };
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(art.timeoutMs || 45_000)]);

  try {
    const own = premadeArt(art, { ticker: spec.ticker, slug: slug || slugBase(spec.name), wallet, adminWallets: cfg.adminWallets || [] });
    if (own) {
      const logo = normalizeImage(own.logo, LOGO_SIZE, LOGO_SIZE);
      const banner = own.banner ? normalizeImage(own.banner, BANNER_W, BANNER_H) : bannerAroundLogo(logo, { style: 'a', credit });
      const g = { provider: 'owner-supplied', source: `art/${own.dir}` };
      candidates.push({ logo: { body: logo, mime: 'image/png', generator: gen({ ...g, file: own.logoFile }) },
        banner: { body: banner, mime: 'image/png', generator: gen({ ...g, file: own.bannerFile || 'composed' }) } });
    }
  } catch (e) { notes.push(`owner-supplied art unusable (${e.message}); generated instead`); }

  const provider = providerOf(art);
  const want = 2 - candidates.length;
  if (provider && want > 0) {
    const lp = logoPrompt({ initial, symbol }), bp = bannerPrompt({ initial, symbol });
    // a stable key per intent: a retried job gets the same requests back instead of paying for new ones
    const key = (kind, i, prompt) => createHash('sha256').update(`${seed}:${kind}:${i}:${prompt}`).digest('hex').slice(0, 40);
    const hf = (kind, i) => higgsfieldImage(art, { model: kind === 'logo' ? art.hfLogoModel : art.hfBannerModel, prompt: kind === 'logo' ? lp : bp,
      aspect: kind === 'logo' ? '1:1' : '16:9', key: key(kind, i, kind === 'logo' ? lp : bp) }, { fetchImpl, signal: deadline });
    const build = (l, b, i) => {
      const logo = normalizeImage(l.bytes, LOGO_SIZE, LOGO_SIZE);
      const banner = b ? normalizeImage(b.bytes, BANNER_W, BANNER_H) : bannerAroundLogo(logo, { style: (candidates.length + i) % 2 ? 'b' : 'a', credit });
      const g = { provider, model: l.model, symbol: sym };
      return { logo: { body: logo, mime: 'image/png', generator: gen({ ...g, requestId: l.requestId, prompt: lp }) },
        banner: { body: banner, mime: 'image/png', generator: gen(b ? { ...g, model: b.model, requestId: b.requestId, prompt: bp } : { ...g, composed: 'around the logo' }) } };
    };
    const why = (e) => String(deadline.aborted && !signal?.aborted ? `no answer within ${Math.round((art.timeoutMs || 45_000) / 1000)} s` : e?.message || e).slice(0, 200);
    let paid = 0;
    if (provider === 'higgsfield') {
      // one request per image (the documented Recraft V4.1 schema has no image count); each candidate stands alone
      const settled = await Promise.allSettled(Array.from({ length: want }, async (_, i) => {
        const [l, b] = await Promise.all([hf('logo', i), art.providerBanners ? hf('banner', i) : null]);
        paid += b ? 2 : 1;
        return build(l, b, i);
      }));
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') candidates.push(r.value);
        else notes.push(`higgsfield failed for option ${2 - want + i + 1} (${why(r.reason)}); the local generator drew it`);
      });
    } else {
      try {
        const logos = await recraftImages(art, { prompt: lp, aspect: '1:1', n: want }, { fetchImpl, signal: deadline });
        const banners = art.providerBanners ? await recraftImages(art, { prompt: bp, aspect: '16:9', n: want }, { fetchImpl, signal: deadline }) : [];
        paid += logos.length + banners.length;
        candidates.push(...logos.map((l, i) => build(l, banners[i], i)));
      } catch (e) {
        notes.push(`recraft failed (${why(e)}); the local generator drew ${want === 2 ? 'both options' : 'option 2'}`);
      }
    }
    if (paid) spend?.(paid * (art.priceUsd || 0));
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');

  // the local generator fills whatever is missing
  const variants = localVariants(initial);
  for (let i = 0; candidates.length < 2; i++) {
    const v = variants[i % 2];
    const style = candidates.length % 2 ? 'b' : 'a';
    const g = { provider: 'local', glyph: v.ch, layout: v.layout, symbol: sym, prompt: logoPrompt({ initial: v.ch, symbol }) };
    candidates.push({
      logo: { body: renderPng(localLogoSvg({ ...v, symbol: symbol.id })), mime: 'image/png', generator: gen(g) },
      banner: { body: renderPng(localBannerSvg({ ...v, symbol: symbol.id, style, credit })), mime: 'image/png', generator: gen({ ...g, banner: style }) },
    });
  }
  return { candidates, notes, symbol: sym, provider: candidates.map((c) => JSON.parse(c.logo.generator).provider) };
}
