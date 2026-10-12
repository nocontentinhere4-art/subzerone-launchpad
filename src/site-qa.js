// SUB-01's QA gate for the coin sites (docs/SITE-QA.md). A new site version goes live only after it passes:
//   static  always, in-process, on the built HTML (a few ms): one h1, alt on every image, the CTA, in-page links that
//           resolve, unique ids, heading order, the viewport and the language.
//   browser where a Chromium is available (the Docker image ships Debian's; SITE_QA_BROWSER): the candidate version is
//           rendered on its own project host at 1440×900 and 390×844, through a single-use ticket header the server
//           honours read-only for that one version. Every tool and the app must hydrate within 8 s, no console errors,
//           no horizontal overflow, headings and buttons inside the viewport and not overlapping, images loaded, the
//           CTA above the fold on a phone, no image without alt, no near-zero-contrast text. Screenshots go to the
//           volume (DATA_DIR/qa/<slug>/).
// A version that fails keeps the previous live version (the owner sees why in the room PC and can override); the first
// version of a site goes live anyway (there is nothing earlier to keep) with its report. No browser: the static checks
// decide and the report says "browser: skipped (no browser)".
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { audit } from './db.js';
import { setLiveVersion } from './site.js';
import { id, now, sha256, parseJson, HttpError } from './util.js';
import { log } from './log.js';

const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true }];
const HYDRATE_MS = 8000;          // every tool and the app must be live, and nothing may say "Loading…", this long after load
const HEAVY_MS = 20000;           // …unless it shows progress (aria-busy with changing text: e.g. "Verifying 4 of 9 entries"):
                                  // heavy client work (the post-quantum verifier on a slow CPU) gets this long in total

// ---- static checks (on the HTML string) ----------------------------------------------------------------------------
/** -> {issues: [{check, detail}], warnings: [...] , passed: [check names]} */
export function staticQa(html, spec = {}) {
  const issues = [], warnings = [], passed = new Set();
  const fail = (check, detail) => issues.push({ check, detail }), warn = (check, detail) => warnings.push({ check, detail });
  const ok = (check) => passed.add(check);
  const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
  const h1 = tags('h1').length;
  if (h1 !== 1) fail('one-h1', `the page has ${h1} h1 headings (one, the coin's name)`); else ok('one-h1');
  const noAlt = tags('img').filter((t) => !/\salt="/.test(t));
  if (noAlt.length) fail('img-alt', `${noAlt.length} image(s) without an alt attribute`); else ok('img-alt');
  if (!/<html lang="[a-z-]+"/i.test(html)) fail('lang', 'no lang on <html>'); else ok('lang');
  if (!/<meta name="viewport" content="width=device-width/i.test(html)) fail('viewport', 'no responsive viewport meta'); else ok('viewport');
  if (!/<title>[^<]{2,}<\/title>/.test(html)) fail('title', 'empty <title>'); else ok('title');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  if (dup.length) fail('unique-ids', `duplicate ids: ${dup.join(', ')}`); else ok('unique-ids');
  const anchors = [...html.matchAll(/\shref="#([^"]+)"/g)].map((m) => m[1]);
  const dead = [...new Set(anchors.filter((a) => !ids.includes(a)))];
  if (dead.length) fail('anchors', `links to missing sections: ${dead.map((x) => `#${x}`).join(', ')}`); else ok('anchors');
  const hasApp = Boolean(spec?.app && Array.isArray(spec.app.screens));
  if (hasApp && !/class="btn btn-primary btn-lg" href="#app"/.test(html)) fail('cta', 'the hero has no action to the app'); else ok('cta');
  if (hasApp && !/<section class="app card reveal" id="app" data-app /.test(html)) fail('app-section', 'the app section is missing'); else ok('app-section');
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  const jumps = levels.filter((l, i) => i && l > levels[i - 1] + 1).length;
  if (jumps) warn('heading-order', `${jumps} heading level jump(s) (e.g. h2 → h4)`); else ok('heading-order');
  const emptyTools = [...html.matchAll(/data-tool="([a-z]+)"[\s\S]*?<div class="tool-body" data-slot><\/div>/g)].map((m) => m[1]);
  if (emptyTools.length) warn('static-bodies', `tools with no static text: ${emptyTools.join(', ')}`); else ok('static-bodies');
  return { issues, warnings, passed: [...passed] };
}

// ---- the browser ------------------------------------------------------------------------------------------------------
const CANDIDATES = ['/usr/lib/chromium/chromium-headless-shell', '/usr/bin/chromium-headless-shell', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
/** The Chromium to drive, or null with the reason. cfg.siteQa.browser: 'off', 'auto' or a path. */
export async function findBrowser(cfg) {
  const want = cfg.siteQa?.browser || 'off';
  if (want === 'off') return { path: null, why: 'browser QA off (SITE_QA_BROWSER)' };
  let pw;
  try { pw = await import('playwright-core'); } catch { return { path: null, why: 'no browser driver (playwright-core not installed)' }; }
  if (want !== 'auto') return existsSync(want) ? { path: want, pw } : { path: null, why: `no browser at ${want}` };
  const found = CANDIDATES.find((p) => existsSync(p));
  return found ? { path: found, pw } : { path: null, why: 'no browser' };
}

// one browser QA at a time per process (Chromium is the expensive part)
let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

/** Render one site version in Chromium and check it. -> {viewports: {desktop, mobile}, issues, warnings, shots, ms} */
async function browserQa({ cfg, project, version, ticket, browser, dir }) {
  const t0 = Date.now();
  // the page is fetched from this server on loopback as <slug>.qa.localhost:<port>: Chromium resolves *.localhost to
  // 127.0.0.1 itself and treats it as a secure context, as visitors' https is (crypto.subtle, the clipboard). Plain http
  // on the public name mapped to loopback was not one: the post-quantum verifier failed only in the QA (2026-10-12),
  // and the headless shell ignores --unsafely-treat-insecure-origin-as-secure.
  const host = `${project.slug}.qa.localhost:${cfg.port}`;
  const url = `http://${host}/`;
  const args = ['--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-gpu'];
  const b = await browser.pw.chromium.launch({ executablePath: browser.path, args, chromiumSandbox: !(process.getuid?.() === 0), timeout: 20_000 });
  const issues = [], warnings = [], shots = [], viewports = {};
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: Boolean(vp.isMobile), hasTouch: Boolean(vp.hasTouch),
        reducedMotion: 'reduce', serviceWorkers: 'block', javaScriptEnabled: true });
      const page = await ctx.newPage();
      if ((cfg.siteQa?.cpuThrottle || 1) > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.siteQa.cpuThrottle }); }
      // the ticket rides only on requests to the coin's own host (never to the map tiles' host)
      await page.route((u) => u.host === host, (route) => route.continue({ headers: { ...route.request().headers(), 'x-sub01-qa': ticket } }));
      const consoleErrors = [], thirdParty = [];
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const at = m.location()?.url || '', text = m.text().slice(0, 240);
        let own = true; try { own = !at || new URL(at).host === host; } catch { /* keep as own */ }
        (own ? consoleErrors : thirdParty).push(text);
      });
      page.on('pageerror', (e) => consoleErrors.push(`uncaught: ${String(e?.message || e).slice(0, 240)}`));
      page.on('requestfailed', (r) => { try { if (new URL(r.url()).host !== host) thirdParty.push(`${r.failure()?.errorText || 'failed'}: ${new URL(r.url()).host}`); } catch { /* ignore */ } });
      const v = { width: vp.width, height: vp.height, checks: {} };
      const fail = (check, detail) => issues.push({ viewport: vp.name, check, detail }), warn = (check, detail) => warnings.push({ viewport: vp.name, check, detail });
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
        // hydration: every tool and the app become .live, or say why not, within 8 s
        const hyd = await page.evaluate(async (ms) => {
          const all = () => [...document.querySelectorAll('section[data-tool],section[data-app]')];
          const done = (s) => s.classList.contains('live') || /Could not load|could not load|switched off/.test(s.querySelector('[data-static]')?.textContent || '');
          const t = Date.now(); while (Date.now() - t < ms && !all().every(done)) await new Promise((r) => setTimeout(r, 150));
          return { total: all().length, ms: Date.now() - t, notLive: all().filter((s) => !s.classList.contains('live')).map((s) => ({ id: s.id || s.dataset.tool, note: (s.querySelector('[data-static]')?.textContent || '').trim().slice(0, 160) })) };
        }, HYDRATE_MS);
        v.checks.hydrated = { sections: hyd.total, ms: hyd.ms, notLive: hyd.notLive.length };
        for (const s of hyd.notLive) fail('hydration', `${s.id} did not load${s.note ? `: ${s.note}` : ' within 8 s'}`);
        // lazy images load now (a visitor scrolling would load them); then give every image up to 3 s
        await page.evaluate(async () => {
          for (const i of document.images) if (i.loading === 'lazy') i.loading = 'eager';
          await Promise.race([Promise.all([...document.images].filter((i) => i.getAttribute('src') && !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
            new Promise((r) => setTimeout(r, 3000))]);
        });
        // nothing may still say "Loading…" or be aria-busy: wait for it, 8 s from load; work that shows progress gets 20 s
        const busy = await page.evaluate(async ({ quiet, heavy }) => {
          const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !el.closest('[hidden]'); };
          const name = (el) => `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`;
          const now = () => [...new Set([...document.querySelectorAll('main [aria-busy="true"]'), ...[...document.querySelectorAll('main *')].filter((el) => el.childElementCount === 0 && /^Loading/.test((el.textContent || '').trim()))])].filter(vis);
          let last = '', moved = Date.now();
          for (;;) {
            const list = now(), sig = list.map((el) => el.textContent).join('|'), t = Math.round(performance.now());   // since the navigation started
            if (!list.length) return { left: [], ms: t };
            if (sig !== last) { last = sig; moved = Date.now(); }
            const progressing = list.every((el) => el.getAttribute('aria-busy') === 'true') && Date.now() - moved < 3000;
            if (t > (progressing ? heavy : quiet)) return { left: list.slice(0, 3).map(name), ms: t };
            await new Promise((r) => setTimeout(r, 200));
          }
        }, { quiet: HYDRATE_MS, heavy: HEAVY_MS });
        v.checks.settledMs = busy.ms;
        for (const x of busy.left) fail('loading', `still loading ${Math.round(busy.ms / 1000)} s after load: ${x}`);
        await page.waitForTimeout(250);
        const r = await page.evaluate(() => {
          const W = innerWidth, H = innerHeight, out = {};
          const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !el.closest('[hidden]'); };
          const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a); if (/(hidden|auto|scroll|clip)/.test(o.overflowX)) return a; } return null; };
          const fixed = (el) => { for (let a = el; a; a = a.parentElement) if (getComputedStyle(a).position === 'fixed') return true; return false; };
          const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
          // horizontal overflow
          out.scrollWidth = document.documentElement.scrollWidth;
          out.overflow = out.scrollWidth > W + 1 ? [...document.body.querySelectorAll('*')].filter((el) => { const b = el.getBoundingClientRect(); return b.right > W + 1 && b.width > 0 && !clipped(el); }).slice(0, 5).map(name) : [];
          // headings and buttons: inside the viewport horizontally, not overlapping each other
          const els = [...document.querySelectorAll('h1,h2,h3,h4,a.btn,button,.btn')].filter((el) => vis(el) && !clipped(el));
          out.outside = els.filter((el) => { const b = el.getBoundingClientRect(); return b.left < -1 || b.right > W + 1; }).slice(0, 5).map(name);
          const boxes = els.filter((el) => !fixed(el)).map((el) => { const b = el.getBoundingClientRect(); return { el, x: b.left, y: b.top + scrollY, w: b.width, h: b.height }; });
          out.overlaps = [];
          for (let i = 0; i < boxes.length && out.overlaps.length < 5; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], c = boxes[j]; if (a.el.contains(c.el) || c.el.contains(a.el)) continue;
            const ix = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x), iy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
            if (ix > 2 && iy > 2) { out.overlaps.push(`${name(a.el)} × ${name(c.el)}`); if (out.overlaps.length >= 5) break; }
          }
          // the hero's words must sit on the art's empty part: sample the banner under each text box (object-fit: cover,
          // anchored right, as the stylesheet draws it); more than 2% light pixels under a box is text over the drawing
          out.overArt = [];
          const art = document.querySelector('.hero-art');
          if (art && art.complete && art.naturalWidth && getComputedStyle(art).position === 'absolute') {
            try {
              const A = art.getBoundingClientRect(), iw = art.naturalWidth, ih = art.naturalHeight, sc = Math.max(A.width / iw, A.height / ih);
              const ox = A.width - iw * sc, oy = (A.height - ih * sc) / 2;
              const cv = document.createElement('canvas'); cv.width = Math.round(A.width); cv.height = Math.round(A.height);
              const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(art, ox, oy, iw * sc, ih * sc);
              for (const el of document.querySelectorAll('.hero-in h1, .hero-pitch, .hero-cta .btn, .ca-chip, .hero-k')) {
                if (!vis(el)) continue;
                const r = el.getBoundingClientRect(), x = Math.max(0, Math.round(r.left - A.left)), y = Math.max(0, Math.round(r.top - A.top));
                const w = Math.min(cv.width - x, Math.round(r.width)), hh = Math.min(cv.height - y, Math.round(r.height)); if (w < 2 || hh < 2) continue;
                const d = g.getImageData(x, y, w, hh).data; let lit = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 3 * 110) lit++;
                if (lit / (d.length / 4) > 0.02) out.overArt.push(`${name(el)} (${Math.round(100 * lit / (d.length / 4))}% of it over the drawing)`);
              }
            } catch (e) { out.overArt.push(`could not read the banner (${e.message})`); }
          }
          // images (map tiles are the map library's business)
          const imgs = [...document.images].filter((i) => !i.closest('.leaflet-container'));
          out.images = imgs.length;
          // an <img> kept hidden until it has something to show (a file preview) is not broken
          out.broken = imgs.filter((i) => (i.getAttribute('src') || vis(i)) && (!i.complete || i.naturalWidth === 0)).map((i) => i.getAttribute('src') || '(no src)').slice(0, 5);
          out.noAlt = imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.getAttribute('src') || '(no src)').slice(0, 5);
          // the one action: the hero's CTA above the fold, else the phone action bar
          const cta = document.querySelector('.hero-cta .btn-primary'), dock = document.querySelector('.dock .btn-primary');
          const inFold = (el) => el && vis(el) && el.getBoundingClientRect().bottom <= H && el.getBoundingClientRect().top >= 0;
          out.cta = !cta && !dock ? 'none' : inFold(cta) ? 'hero' : dock && inFold(dock) && !dock.closest('.dock').classList.contains('is-away') ? 'dock' : 'below the fold';
          // text contrast (WCAG): near zero is an issue, under AA a warning
          const rgb = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const bgOf = (el) => { for (let a = el; a; a = a.parentElement) { const c = rgb(getComputedStyle(a).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 0, g: 0, b: 0, a: 1 }; };
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
          const seen = new Set(); let low = 0; const zero = [], lowEx = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement; if (!el || seen.has(el) || !vis(el) || el.closest('canvas,svg,.leaflet-container,[aria-hidden="true"]')) continue; seen.add(el);
            const cs = getComputedStyle(el), fg = rgb(cs.color); if (!fg || fg.a === 0) continue;
            const bg = bgOf(el), mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
            const L1 = lum(mix), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
            const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.6 && Number(cs.fontWeight) >= 700);
            if (ratio < 1.5) zero.push(`${name(el)} ${ratio.toFixed(2)}:1`);
            else if (ratio < (large ? 3 : 4.5)) { low++; if (lowEx.length < 3) lowEx.push(`${name(el)} ${ratio.toFixed(2)}:1`); }
          }
          out.contrast = { zero: zero.slice(0, 5), low, lowEx };
          // a block that gave up and says so on the page ("Could not verify here: …", "The registry could not load (…)")
          out.gaveUp = [...document.querySelectorAll('main *')].filter((el) => el.childElementCount === 0 && vis(el) && /^(Could not|The [a-z ]+ could not)/.test((el.textContent || '').trim())).slice(0, 3).map(name);
          return out;
        });
        v.checks = { ...v.checks, scrollWidth: r.scrollWidth, images: r.images, cta: r.cta, contrastLow: r.contrast.low };
        if (r.scrollWidth > vp.width + 1) fail('overflow', `the page is ${r.scrollWidth}px wide at ${vp.width}px${r.overflow.length ? `: ${r.overflow.join('; ')}` : ''}`);
        for (const x of r.outside) fail('in-viewport', `${x} sticks out of the screen`);
        for (const x of r.overlaps) fail('overlap', `${x} overlap`);
        for (const x of r.overArt) fail('text-over-art', `${x}`);
        for (const x of r.broken) fail('images', `image did not load: ${x}`);
        for (const x of r.noAlt) fail('alt', `image without alt: ${x}`);
        if (vp.isMobile && r.cta === 'below the fold') fail('cta-fold', 'the main action is below the fold on a phone');
        for (const x of r.contrast.zero) fail('contrast', `near-invisible text: ${x}`);
        for (const x of r.gaveUp) fail('gave-up', `the page says it failed: ${x}`);
        if (r.contrast.low) warn('contrast-aa', `${r.contrast.low} text element(s) under WCAG AA (e.g. ${r.contrast.lowEx.join('; ')})`);
        for (const x of [...new Set(consoleErrors)].slice(0, 5)) fail('console', x);
        if (thirdParty.length) warn('third-party', `${thirdParty.length} request(s) to other hosts failed (e.g. ${[...new Set(thirdParty)].slice(0, 2).join('; ')})`);
        // screenshots: the fold and the whole page, JPEG, on the volume
        for (const [kind, full] of [['fold', false], ['full', true]]) {
          const file = `v${version}-${vp.name}-${kind}.jpg`;
          await page.screenshot({ path: join(dir, file), type: 'jpeg', quality: kind === 'fold' ? 72 : 55, fullPage: full, timeout: 15_000 });
          shots.push({ file, viewport: vp.name, kind, width: vp.width });
        }
      } catch (e) {
        fail('render', `could not render: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
      } finally {
        viewports[vp.name] = v;
        await ctx.close().catch(() => {});
      }
    }
  } finally {
    await b.close().catch(() => {});
  }
  return { viewports, issues, warnings, shots, ms: Date.now() - t0 };
}

// ---- the gate ------------------------------------------------------------------------------------------------------
const shotDir = (cfg, project) => join(cfg.dataDir, 'qa', project.slug);
function pruneShots(cfg, db, project) {
  const keep = cfg.siteQa?.keep ?? 3;
  const rows = db.all(`SELECT version FROM site_qa WHERE project_id = ? AND shots_json IS NOT NULL ORDER BY created_at DESC`, project.id);
  const live = new Set([...rows.slice(0, keep).map((r) => r.version), project.live_site_version]);
  const dir = shotDir(cfg, project);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) { const m = /^v(\d+)-/.exec(f); if (m && !live.has(Number(m[1]))) rmSync(join(dir, f), { force: true }); }
  db.run(`UPDATE site_qa SET shots_json = NULL WHERE project_id = ? AND shots_json IS NOT NULL AND version NOT IN (${[...live].filter(Number.isFinite).join(',') || 0})`, project.id);
}

/**
 * Check a built site version and set it live when it passes (or when nothing earlier is live). Callers that used to call
 * setLiveVersion right after buildSiteVersion call this instead. opts.browser false: static checks only (boot backfills).
 * -> {live: boolean, qa: report view}
 */
export async function publishSite(db, cfg, project, version, actor, { browser = true, mustPublish = false } = {}) {
  const row = db.get(`SELECT html, spec_json FROM site_versions WHERE project_id = ? AND version = ? AND build_status = 'ok'`, project.id, version);
  if (!row) throw new HttpError(404, 'no_such_version', 'that version did not build');
  const t0 = Date.now(), qaId = id('qa');
  const st = staticQa(row.html, parseJson(row.spec_json, {}));
  const ticket = randomBytes(24).toString('base64url');
  const timeout = cfg.siteQa?.timeoutMs ?? 60_000;
  db.run(`INSERT INTO site_qa (id, project_id, version, status, browser, issues, warnings, ticket_hash, ticket_until, created_by, created_at)
          VALUES (?, ?, ?, 'running', 'pending', 0, 0, ?, ?, ?, ?)`, qaId, project.id, version, sha256(ticket), now() + timeout, actor, now());
  let br = { issues: [], warnings: [], shots: [], viewports: {}, ms: 0 }, browserState = 'skipped', browserNote = 'not asked (static checks only)';
  if (browser) {
    const found = await findBrowser(cfg);
    if (!found.path) browserNote = found.why;
    else {
      const dir = shotDir(cfg, project); mkdirSync(dir, { recursive: true });
      try {
        let timer;
        try {
          br = await serial(() => Promise.race([browserQa({ cfg, project, version, ticket, browser: found, dir }),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`browser QA took longer than ${Math.round(timeout / 1000)} s`)), timeout); timer.unref?.(); })]));
        } finally { clearTimeout(timer); }
        browserState = 'ran'; browserNote = `Chromium (${found.path.split('/').pop()}), ${VIEWPORTS.map((v) => `${v.width}×${v.height}`).join(' and ')}`;
      } catch (e) {
        // a broken browser is not the site's fault: the static checks decide, the report says what happened
        browserState = 'error'; browserNote = `browser QA could not run: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`;
        log.warn('site-qa browser', { slug: project.slug, version, error: browserNote });
      }
    }
  }
  const issues = [...st.issues.map((x) => ({ viewport: 'html', ...x })), ...br.issues];
  const warnings = [...st.warnings.map((x) => ({ viewport: 'html', ...x })), ...br.warnings];
  const prev = db.get('SELECT live_site_version v FROM projects WHERE id = ?', project.id)?.v ?? null;
  const gate = cfg.siteQa?.gate !== false;
  // mustPublish: a rebuild that only brings the site up to date with the chain (the coin was launched): an older version
  // saying "not launched" is worse than any QA issue, so it goes live and the issues stay in the report
  const hold = gate && !mustPublish && issues.length > 0 && prev != null && prev !== version;
  if (issues.length) log.warn('site-qa issues', { slug: project.slug, version, held: hold, issues: issues.slice(0, 5).map((x) => `${x.viewport || ''}: ${String(x.text || x.message || '').slice(0, 160)}`) });
  const report = { static: { passed: st.passed }, browser: { state: browserState, note: browserNote, viewports: br.viewports, ms: br.ms }, issues, warnings };
  db.run(`UPDATE site_qa SET status = ?, browser = ?, browser_note = ?, issues = ?, warnings = ?, report_json = ?, shots_json = ?, held = ?, ticket_hash = NULL,
            ticket_until = NULL, runtime_ms = ?, finished_at = ? WHERE id = ?`,
  issues.length ? 'failed' : 'passed', browserState, browserNote, issues.length, warnings.length, JSON.stringify(report), br.shots.length ? JSON.stringify(br.shots) : null,
  hold ? 1 : 0, Date.now() - t0, now(), qaId);
  const summary = qaLine(db.get('SELECT * FROM site_qa WHERE id = ?', qaId));
  if (hold) {
    audit(db, { actor: 'system', kind: 'site', projectId: project.id, ideaId: project.idea_id, isPublic: true,
      message: `Website version ${version} held back by SUB-01's QA (${summary}); version ${prev} stays live`, data: issues.slice(0, 10) });
  } else if (prev !== version) {                        // a recheck of the live version leaves it where it is
    setLiveVersion(db, project, version, actor);
    if (issues.length) audit(db, { actor: 'system', kind: 'site', projectId: project.id, ideaId: project.idea_id,
      message: `Website version ${version} is live with QA issues (${summary}): ${prev == null ? 'the first version' : mustPublish ? 'it brings the site up to date with the launch' : 'the gate is off'}`, data: issues.slice(0, 10) });
  }
  try { pruneShots(cfg, db, { ...project, live_site_version: hold ? prev : version }); } catch (e) { log.warn('site-qa prune', { error: e.message }); }
  return { live: !hold, qa: qaView(db.get('SELECT * FROM site_qa WHERE id = ?', qaId)) };
}

/** "passed" / "2 issues" / "passed (static only: no browser)". */
export function qaLine(r) {
  if (!r) return 'not checked';
  if (r.status === 'running') return 'checking…';
  const head = r.status === 'overridden' ? `published anyway by the author (${r.issues} issue${r.issues === 1 ? '' : 's'})`
    : r.issues ? `${r.issues} issue${r.issues === 1 ? '' : 's'}` : 'passed';
  return r.browser === 'ran' ? head : `${head} (static checks only: ${r.browser_note || 'no browser'})`;
}

export function qaView(r) {
  if (!r) return null;
  const report = parseJson(r.report_json, {}) || {};
  return { id: r.id, version: r.version, status: r.status, line: qaLine(r), held: Boolean(r.held), browser: r.browser, browserNote: r.browser_note,
    issues: report.issues || [], warnings: report.warnings || [], viewports: report.browser?.viewports || {}, runtimeMs: r.runtime_ms,
    shots: (parseJson(r.shots_json, []) || []).map((s) => ({ ...s, file: undefined, name: s.file })), createdAt: r.created_at, finishedAt: r.finished_at,
    overriddenBy: r.overridden_by || null };
}

/** The latest reports of a project (newest first) for the room PC. */
export function qaReports(db, project, limit = 5) {
  return db.all('SELECT * FROM site_qa WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', project.id, limit).map(qaView);
}

/** The project host's side of the ticket: the version a QA browser may render, or null. Read-only, single version. */
export function qaTicket(db, project, token) {
  if (!token || token.length > 64) return null;
  const r = db.get(`SELECT version FROM site_qa WHERE project_id = ? AND ticket_hash = ? AND status = 'running' AND ticket_until > ?`, project.id, sha256(String(token)), now());
  return r ? { version: r.version } : null;
}

/** The author publishes a held version anyway. */
export function overrideQa(db, project, version, actor) {
  const r = db.get(`SELECT * FROM site_qa WHERE project_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1`, project.id, version);
  if (!r) throw new HttpError(404, 'no_report', 'that version has no QA report');
  if (r.status !== 'failed') throw new HttpError(409, 'not_failed', 'only a version that failed the QA can be published anyway');
  setLiveVersion(db, project, version, actor);
  db.run(`UPDATE site_qa SET status = 'overridden', overridden_by = ?, overridden_at = ? WHERE id = ?`, actor, now(), r.id);
  audit(db, { actor, kind: 'site', projectId: project.id, ideaId: project.idea_id, isPublic: true,
    message: `The author published website version ${version} despite SUB-01's QA (${r.issues} issue${r.issues === 1 ? '' : 's'})` });
  return qaView(db.get('SELECT * FROM site_qa WHERE id = ?', r.id));
}

/** A QA screenshot's path on the volume, or null (names come from the stored report only). */
export function qaShotPath(cfg, db, project, version, name) {
  if (!/^v\d+-(desktop|mobile)-(fold|full)\.jpg$/.test(name)) return null;
  const r = db.get(`SELECT shots_json FROM site_qa WHERE project_id = ? AND version = ? AND shots_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`, project.id, version);
  if (!r || !(parseJson(r.shots_json, []) || []).some((s) => s.file === name)) return null;
  const file = join(shotDir(cfg, project), name);
  return existsSync(file) ? file : null;
}

// tests: write a fake shot
export const _test = { shotDir, writeShot: (cfg, project, name, body) => { mkdirSync(shotDir(cfg, project), { recursive: true }); writeFileSync(join(shotDir(cfg, project), name), body); } };

/**
 * The 2026-10-12 redesign (docs/DESIGN.md) for coins built before it: a live version still on the v1 stylesheet is
 * rebuilt from its own spec as a new version (same content, new template), checked by the static QA, set live, and a
 * browser QA job is queued for the worker. Only while the site may change (preview open, or launched); a site frozen
 * between the author's approval and the launch keeps its look until then. Once per coin (created_by is the marker).
 */
export async function refreshSiteDesign(db, cfg) {
  const { buildSiteVersion } = await import('./site.js');
  const { enqueue } = await import('./jobs.js');
  const out = { rebuilt: [], skipped: 0, failed: [] };
  const rows = db.all(`SELECT p.* FROM projects p JOIN ideas i ON i.id = p.idea_id
    WHERE p.live_site_version IS NOT NULL AND i.status IN ('preview_ready', 'launched') ORDER BY p.created_at`);
  for (const p of rows) {
    const live = db.get(`SELECT html, spec_json FROM site_versions WHERE project_id = ? AND version = ? AND build_status = 'ok'`, p.id, p.live_site_version);
    const done = db.get(`SELECT 1 FROM site_versions WHERE project_id = ? AND created_by = 'system:sub01-design'`, p.id);
    if (!live || done || !live.html.includes('/_kit/site-kit.v1.css')) { out.skipped++; continue; }
    try {
      const site = await buildSiteVersion(db, cfg, p, parseJson(live.spec_json), 'system:sub01-design');
      const pub = await publishSite(db, cfg, p, site.version, 'system', { browser: false });
      audit(db, { actor: 'system', kind: 'site', projectId: p.id, ideaId: p.idea_id, isPublic: true,
        message: `SUB-01 rebuilt the site in the new design, same content (site v${site.version}${pub.live ? '' : ', held back by the QA'})` });
      if (pub.live) enqueue(db, { type: 'site_qa', key: `site_qa:${p.id}:${site.version}`, projectId: p.id });
      out.rebuilt.push({ slug: p.slug, version: site.version, live: pub.live, qa: pub.qa.line });
    } catch (e) {
      out.failed.push({ slug: p.slug, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}
