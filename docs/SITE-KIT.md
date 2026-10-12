# Site kit v1: real tools on the coin sites (2026-10-12)

Every coin site SUB-01 builds can carry working tools, not just text: a live token panel, a community wall, a signed
poll, a private drop box with a daily pick, an event countdown, a meme maker, and at most one idea-specific capability
built on a vendored open-source library (a map, a sound toy, a mini-game, a price chart). SUB-01 picks them without a
language model; the author switches them on and off in the room PC. Nothing here moves funds or asks for a
transaction: the tools read stored or public chain data and ask wallets for **signed messages** only.

| Piece | Where |
|---|---|
| Catalog, config schemas, SUB-01's keyword pick, the JST clock | `src/tools.js` |
| `/_api/*` on project hosts, signed messages, holder checks, moderation, backfill | `src/tool-api.js` |
| Spec validation (`tools`) and `chooseTools(idea, brain)` | `src/generator.js` |
| Static markup of each tool (`<section data-tool data-config>`) | `src/site/render-child.js` |
| Validator allowance, CSP, sandbox | `src/site.js` |
| Routing (`/_kit`, `/_api`), owner endpoints | `src/app.js` |
| The kit's source and build | `kit/src/*`, `kit/build.mjs` → `public/_kit/` (committed) |
| Data | `migrations/012_site_tools.sql` |
| Tests | `test/tools.test.js` (14 tests) |

## Architecture decision: origin and sandbox

**The public site keeps a real origin.** It is served on its own host (`<slug>.projects.subzerone.live`) with

```
default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:[ https://tile.openstreetmap.org];
style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' <launchpad>;
sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads
```

(the tile host only on a site whose map tool is on). Why `allow-same-origin`, i.e. why not an opaque origin:

1. **The wallet must see the real domain.** A wallet's sign-message prompt shows the page's origin; under an opaque
   origin it would say `null`, and the message the visitor signs names a domain the wallet could not confirm. The
   messages (below) name the coin's host, and the wallet shows the same host.
2. **Same-origin fetches and canvas.** With an opaque origin every `/_api` call is cross-origin (CORS for `null`), the
   meme maker's canvas is tainted by the logo (no PNG download), and the map/chart/QR need workarounds. With the real
   origin the API needs no CORS at all and answers none (an `OPTIONS` preflight gets 405).
3. **Nothing worth isolating lives on that origin.** No cookies or sessions are ever set on project hosts; the
   launchpad's session cookie is host-only on the launchpad origin; each coin is its own origin, so one coin's page
   cannot read another's storage. The classic "allow-scripts + allow-same-origin escapes the sandbox" applies to an
   iframe whose document is same-origin with its parent; here the sandbox comes from the document's own CSP header
   (a script cannot remove it) and the only framer, the city, is a different origin. Chrome still logs its generic
   warning about that flag pair; it does not apply.
4. **What the sandbox still does:** no forms, no top-level navigation (a framed site cannot navigate the city), no
   modal dialogs, no pointer lock, no presentation API. `form-action 'none'` and `base-uri 'none'` stay.

What makes it safe to run script at all:

- **Only our script runs.** The generated HTML is still script-free: `validateHtml` allows exactly two strings, the
  kit stylesheet `<link rel="stylesheet" href="/_kit/site-kit.v1.css">` once in the head and the kit script
  `<script src="/_kit/site-kit.v1.js" defer></script>` once, directly before `</body>`. Any other `<script>`, `<link>`,
  inline handler, `javascript:` URL, foreign `src`, a second copy of the kit, the kit with a body, or the kit anywhere
  else is refused, as before (tests: `validateHtml allows exactly the kit…`).
- **`script-src 'self'`, no `'unsafe-inline'`, no `'unsafe-eval'`.** The core and the vendor modules are files served
  by this app from `public/_kit/`; the project host serves nothing else that could run (`/_api` answers JSON with
  `nosniff`, assets keep their image types).
- **The kit writes text, never HTML.** The core has no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`,
  no `eval`/`new Function`, and no `signTransaction`/`sendTransaction` (the test greps the built bundle). Leaflet uses
  `innerHTML` internally for its own controls and our constant attribution string; popups get DOM nodes built with
  `textContent`.
- **Author-supplied URLs:** only the event link, `https:` on x.com, twitter.com, youtube.com, youtu.be, twitch.tv or
  pump.fun, validated in `tools.js` and added to the page's URL allowlist. Every other link is server-built from the
  verified launch (pump.fun, Solscan, DexScreener).

**The owner's preview keeps its isolation.** It is served on the launchpad origin with the old CSP (no `script-src`,
no `connect-src`) plus `style-src 'self'` / `font-src 'self'` for the kit stylesheet and fonts, and `sandbox` with no
flags. The tools show their static text there ("Interactive on the live site").

**The city frames the public site** with `sandbox="allow-scripts allow-same-origin allow-popups
allow-popups-to-escape-sandbox allow-downloads"` (city `src/desk.js` `SANDBOX.site`); the framed document is a
different origin from the city, so it gets its own origin, never the city's.

Residual risk, said plainly: a real wallet extension's injection into a CSP-sandboxed document with
`allow-same-origin` was not tested here (headless Chrome used an in-page Wallet Standard test wallet). Content scripts
match on the URL and the origin is normal, so Phantom/Solflare/Backpack should inject as on any page; check once with
Phantom before announcing. If one does not, removing the `sandbox …` token from `SITE_SANDBOX.public` in `site.js` is
the one-line fallback (CSP and the validator do the real work).

## The tools

| id | What it does | Data | Wallet |
|---|---|---|---|
| `token` | Price, market cap, 24 h volume and change, holders (number tickers), CA with copy and QR, pump.fun / Solscan / DexScreener links, sparkline from stored samples, "updated X min ago" and the source. "Pre-launch" before a mint exists; MOCK says MOCK; no number → "—". | `coin_stats` (coin-stats.js, never a live call here), `coin_samples` | — |
| `wall` | Anyone posts ≤ 280 characters, newest first, new notes slide in. Holders-only mode: a signed message. | `tool_entries` | holders-only |
| `poll` | Question + 2–4 answers, one vote per wallet (signed), results live with animated bars. Editing the question or answers starts a new count. | `poll_votes` | always |
| `drop` | A private submission box ("drop your confession; one is featured at 23:00 JST"). The author features one from the room PC; if they do not, the **daily rule** features one at the reveal time from the 24 h before it (picked by a hash of entry id and reveal instant: fair, repeatable, not guessable in advance). | `tool_entries` | — |
| `event` | Next event (one date, or every day at HH:MM JST), live countdown, `.ics` download (daily events carry `RRULE:FREQ=DAILY`). | spec only | — |
| `memes` | Logo + top/bottom text on a canvas, PNG download. Runs in the browser; nothing uploaded. | — | — |
| `map` *(extra)* | Leaflet map, OpenStreetMap tiles, the author's places, visitors pin a spot (moderated; the author can hide pins). | `tool_entries` | — |
| `synth` *(extra)* | An 8-step sequencer on a scale that fits the idea (pentatonic, minor, major, in-sen), Tone.js. | — | — |
| `game` *(extra)* | A 30-second "catch the coins, dodge the red ones" game with the coin logo, KAPLAY; best score per device. | — | — |
| `chart` *(extra)* | Price over 24 h / 7 d from the stored samples, uPlot. Fewer than two samples: a sentence, no line. | `coin_samples` | — |

At most 6 tools per site and at most one extra. Every config is validated strictly (`validateTools`: unknown fields,
duplicates, sizes, markup characters, the financial-promises filter of `validateSpec` over the whole spec).

### SUB-01's choice (no language model)

`chooseTools(idea, brain)` → `pickTools` in `tools.js`, from the concept's words (English, Italian, Japanese romaji;
a trailing `*` in the word lists matches any ending):

- always `token`;
- `drop` when people send / confess / submit / ask / wish / tell stories (`confess*`, `confessione`, `kokuhaku`,
  `himitsu`, `domand*`, `onegai`, `tegami`, `okuru`, `tokumei`…); the prompt names the noun ("Drop your confession");
- `wall` or `poll` by the brain's dominant network: language / default-mode → wall, reward / control → poll;
- `event` when the concept has a time or a ritual (`every night`, `ogni sera`, `maiban`, `23:00`, `11pm`, `alle 23`,
  `23ji`, `midnight`, `mezzanotte`); the time found becomes the reveal / event time;
- `memes` for meme-ish words (`meme`, `cat`, `frog`, `lol`, `gatto`, `neko`, `kawaii`…), or to reach three;
- one extra when its words win: map (`map`, `place*`, `ramen`, `tokyo`, `izakaya`, `mappa`, `chizu`, `basho`…),
  synth (`music`, `beat*`, `lofi`, `musica`, `ongaku`, `oto`…), game (`game`, `arcade`, `score*`, `gioco`, `geemu`…),
  chart (`chart*`, `price`, `trading`, `grafico`, `kabu`…).

Konbini Confession ("every night people drop an anonymous confession at the konbini; at 23:00 JST one gets printed on
the receipt") gets token, drop (reveal 23:00), wall or poll, event (daily 23:00). Ramen Radar gets token, poll/wall,
memes, map. The model generator (when configured) gets the same pick; the model never chooses tools.

## API

### Project host: `<slug>.<PROJECTS_HOST>/_api/*` (same origin as the page; no cookies, no CORS)

Writes need `Origin: <the site's own origin>` (else 403 `bad_origin`) and `content-type: application/json`, bodies
≤ 4 KB. Limits per IP: reads 300/min, writes 12/min, sign requests 12/min; per wallet 10 signed writes/min; per day
(JST) per salted IP hash: 20 wall notes, 5 drops, 10 map pins; per project per day 2000 / 1000 / 300. The IP itself is
never stored. Text goes through the city chat's filter (`chat.js moderateText`: no links, slur list, no fake SUB-01
tag, control characters stripped).

| Method | Path | Body → answer |
|---|---|---|
| GET | `/_api/token[?range=7d]` | stored stats: `state` (`pre-launch` / `mock` / `live`), `priceUsd`, `marketCapUsd`, `volume24hUsd`, `priceChange24hPct`, `liquidityUsd`, `holders {count, atLeast}`, `at`, `fresh`, `source`, `sourceLabel`, `samples [[at, price, mcap]]` (≤ 400 points) |
| GET | `/_api/wall` | `{title, holdersOnly, mode, note, max, entries:[{id, text, at, by}]}` (50 newest, hidden ones left out; `by` = short wallet when signed) |
| POST | `/_api/wall` | `{text}` or, holders-only, `{text, wallet, nonce, signature}` → `{entry}` |
| GET | `/_api/poll` | `{question, options, counts, total, pollKey, holdersOnly, mode, note}` |
| POST | `/_api/poll` | `{choice, wallet, nonce, signature}` → poll + `mine`; 409 `already_voted` (with the earlier `choice`, only after the signature checks) |
| GET | `/_api/drop` | `{title, prompt, revealJst, maxLength, autoPick, featured:{text, at, day, by}|null, nextRevealAt, lastRevealAt}`; submissions never appear here |
| POST | `/_api/drop` | `{text}` → `{ok, private: true, nextRevealAt}` |
| GET | `/_api/map` | `{title, center, zoom, places, community, pins:[{id, text, at, lat, lng}]}` |
| POST | `/_api/map` | `{name, lat, lng}` → `{pin}` (403 `closed` when the author keeps the map to their own places) |
| POST | `/_api/sign` | `{action: 'wall.post'|'poll.vote', wallet, …the write's fields}` → `{nonce, message, expiresAt}` |

**Signed messages.** `POST /_api/sign` normalises the write exactly as the write will (moderated text, poll key) and
stores a single-use nonce (5 minutes) bound to the project, the wallet, the action and a hash of that payload. The
wallet signs (`solana:signMessage`, Wallet Standard; legacy injected providers as a fallback) a plain text like:

```
konbini-confession.projects.subzerone.live asks you to sign a message with your Solana account:
<wallet>

Vote "Karaage-kun" in the poll "Best konbini snack at 23:00?" of Konbini Confession ($KONBINI).
This is a message, not a transaction: it moves no funds, costs nothing and gives no one access to your wallet.

URI: https://konbini-confession.projects.subzerone.live/
Action: poll.vote
Nonce: …
Issued At: …
Expiration Time: …
```

The write burns the nonce first (a replay fails even if that attempt fails), then checks expiry, wallet, action,
payload hash (`payload_changed`) and the Ed25519 signature with `verifyWalletSignature`.

**Holders only.** With a mainnet pump.fun launch and a chain reader (`HELIUS_URL` / `HELIUS_API_KEY`, the same one
coin-stats uses), a signed write also needs the wallet to hold the coin: `getTokenAccountsByOwner(wallet, {mint})`,
cached 10 min (2 min for "no"), 503 `holder_check_failed` if the RPC fails (never a silent yes). Without a reader,
before launch, on a mock launch or on devnet it degrades to "any wallet" and the page says which and why (`note`).

### Launchpad API (session, the room PC)

| Method | Path | |
|---|---|---|
| GET | `/api/projects/:slug/tools` | owner (or admin): `{editable, status, lockedNote, tools, catalog, extras, libs, holderChecks, liveSiteVersion, inbox:{drop, wall, map, poll}}`. The inbox holds the private drop submissions and the hidden entries, marked. |
| PUT | `/api/projects/:slug/tools` | owner: `{tools:[{id, config?}]}` (the enabled ones, in order). A tool without fields gets SUB-01's defaults; given fields win. Validated, built as a new site version and set live. Allowed while `preview_ready` (resets the approvals, like the site editor) and after `launched`; 409 between approval and launch (the reviewed site is frozen). Audit: public "Site tools set by the author: …". |
| POST | `/api/projects/:slug/tools/entries/:id` | owner (or admin): `{hidden: true|false}` and/or `{featured: true}` (drop only; it becomes public). Audited. |

Existing launched coins: `scripts/backfill-site-tools.js` (run by `tools/start.sh` after `refresh-site-credits.js`,
idempotent, never fatal) gives every launched coin whose live spec has no `tools` key SUB-01's pick as a new site
version, set live, with the public audit line "SUB-01 added tools to the site: …". A spec with `tools: []` (the author
switched everything off) is left alone.

## Bundle and sizes

Built by `npm run build:kit` (esbuild, pinned) into `public/_kit/`, which is committed; the container runs no bundler.
The project host serves `/_kit/*` from memory, gzipped when the browser accepts it (woff2 as is); vendor files and
fonts are versioned by name and cached a year (`immutable`), `site-kit.v1.*` a day. `/_kit/*` is public, audited static code: it carries `cross-origin-resource-policy: cross-origin` and
`access-control-allow-origin: *` so the owner's preview (a sandboxed, opaque-origin frame on the launchpad) can load the
stylesheet and fonts. Nothing private is ever served under `/_kit`. An incompatible kit change ships as
`site-kit.v2.*` with a validator allowance for it.

| File | Raw | gzip | Loaded when |
|---|---:|---:|---|
| `site-kit.v1.js` (core + Motion mini) | 33.2 KB | 13.7 KB | every site with tools |
| `site-kit.v1.css` | 10.7 KB | 3.2 KB | every site |
| `fonts/*.woff2` (Archivo 400/700/800, JetBrains Mono 400/700) | 86.7 KB | — | every site (browser fetches the weights used) |
| `vendor/anime-4.5.0.js` | 40.0 KB | 15.9 KB | number tickers and poll bars (skipped with reduced motion) |
| `vendor/qrcode-2.0.4.js` | 20.8 KB | 7.6 KB | on "QR" in the token panel |
| `vendor/leaflet-1.9.4.js` + css | 150.4 + 14.8 KB | 43.4 + 3.5 KB | map sites |
| `vendor/tone-15.1.22.js` | 348.7 KB | 82.6 KB | synth sites, on the first "Play" |
| `vendor/kaplay-3001.0.19.js` | 190.1 KB | 69.8 KB | game sites, on "Play" |
| `vendor/uplot-1.6.32.js` + css | 52.0 + 1.9 KB | 23.0 + 0.8 KB | chart sites |

Measured in headless Chrome against the local server (transfer sizes of `/_kit/*`, 2026-10-12): Konbini Confession
(token, drop, wall, poll, event, memes, QR opened) **129.9 KB**; Ramen Radar (+ map) **169.6 KB**; Lofi Neko (+ sound
toy, after Play) **204.9 KB**; Frog Arcade (+ game, after Play) **175.8 KB**. 88 KB of each is the fonts.

### CSP per site

| Site | CSP (before the shared tail `base-uri 'none'; form-action 'none'; frame-ancestors 'self' <launchpad>; sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads`) |
|---|---|
| any site with tools, no map | `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'` |
| map site | same, with `img-src 'self' data: blob: https://tile.openstreetmap.org` |
| owner preview (launchpad origin) | `default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' <launchpad>; sandbox` |

Notes: OSM tiles are requested with `referrerpolicy="strict-origin-when-cross-origin"` (the tile policy wants a
referrer; it carries only the coin's origin) and attributed on the map and under it. Tone.js creates its default audio
context at import and tries a `blob:` Worker clock; `script-src 'self'` blocks it (one console line) and the kit runs
Tone on a `clockSource: 'timeout'` context instead; `worker-src` stays closed on purpose.

## Motion and looks

- **Motion** (`motion/mini`, WAAPI): hero entrance (staggered), cards revealing on scroll (`inView`), new wall notes
  sliding in, sparkline fade. **anime.js**: number tickers in the token panel and the poll bars. CSS: the gradient
  title, the ticker strip marquee, the shimmer on buttons, hover / press micro-interactions. `prefers-reduced-motion`
  turns all of it off (anime.js is not even loaded; CSS animations and transitions stop).
- **Looks** written from scratch in plain CSS (`kit/src/site-kit.css`): gradient hero text, bento grid for the
  sections, glass cards, shimmer button, a ticker strip for the CA and the stats; dark, the city's orange `#fb752b`,
  the coin's own palette (`--ac`, `--ac2`) from SUB-01's brain record. React and Tailwind do not ship to coin sites:
  the same looks cost 3.2 KB of gzipped CSS instead of a framework. Fonts are vendored (no external font origin).

## CREDITS

All bundled code is pinned to an exact version (≥ 2 weeks old on 2026-10-12), installed as a devDependency (build input
only; the shipped artifact is `public/_kit/`), and its licence text is in `/_kit/LICENSES.txt` on every project host.

| Library | Version | Licence | Used for | Source |
|---|---|---|---|---|
| Motion (`motion`, `motion/mini`) | 13.4.4 | MIT | entrances, scroll reveal, slide-ins (in the core) | https://motion.dev · github.com/motiondivision/motion |
| anime.js (`animejs`) | 4.5.0 | MIT | number tickers, poll bars | https://github.com/juliangarnier/anime |
| Leaflet | 1.9.4 | BSD-2-Clause | map tool | https://leafletjs.com |
| Tone.js (`tone`) | 15.1.22 | MIT | sound toy | https://tonejs.github.io |
| KAPLAY (`kaplay`) | 3001.0.19 | MIT | mini-game | https://kaplayjs.com |
| uPlot (`uplot`) | 1.6.32 | MIT | price chart | https://github.com/leeoniya/uPlot |
| qrcode-generator | 2.0.4 | MIT (no LICENSE file in the package; the source header states MIT, © 2009 Kazuhiko Arase; LICENSES.txt quotes it with the MIT text) | CA QR code | https://github.com/kazuhikoarase/qrcode-generator |
| Archivo (`@fontsource/archivo`) | 5.3.0 | SIL OFL 1.1 | headings and text | https://fontsource.org/fonts/archivo |
| JetBrains Mono (`@fontsource/jetbrains-mono`) | 5.3.0 | SIL OFL 1.1 | numbers, labels | https://fontsource.org/fonts/jetbrains-mono |
| esbuild | 0.28.2 | MIT | build only, not shipped | https://esbuild.github.io |
| OpenStreetMap tiles | — | data © OpenStreetMap contributors, ODbL; tile usage policy | map tiles (loaded from tile.openstreetmap.org, never copied) | https://www.openstreetmap.org/copyright |

Design references (visual patterns only; **no code copied**, nothing from these ships):

| Source | Component | Author | Licence |
|---|---|---|---|
| Kokonut UI | Bento Grid · github.com/kokonut-labs/kokonutui/blob/main/components/kokonutui/bento-grid.tsx | kokonut-labs | MIT (verified: github.com/kokonut-labs/kokonutui/blob/main/LICENSE) |
| Kokonut UI | Liquid Glass Card · github.com/kokonut-labs/kokonutui/blob/main/components/kokonutui/liquid-glass-card.tsx | kokonut-labs | MIT |
| Kokonut UI | Shimmer Text · github.com/kokonut-labs/kokonutui/blob/main/components/kokonutui/shimmer-text.tsx | kokonut-labs | MIT |
| Kokonut UI | Gradient Button · github.com/kokonut-labs/kokonutui/blob/main/components/kokonutui/gradient-button.tsx | kokonut-labs | MIT |
| 21st.dev | none used | — | per component; nothing taken |

## What the owner must set

- **Holder checks**: `HELIUS_API_KEY` (or `HELIUS_URL`) on the server; it is already the coin-stats key. Without it,
  holders-only tools accept any signing wallet and say so on the page.
- Nothing else: no new secrets, no outside services besides OpenStreetMap tiles on map sites.

## Verified locally (2026-10-12)

Backend with the mock provider, a local fake brain and `PROJECTS_HOST=projects.localhost:8797`: four sites generated
from ideas (Konbini Confession, Ramen Radar, Lofi Neko, Frog Arcade), Konbini mock-launched. In headless Chrome with a
throwaway in-page Ed25519 Wallet Standard wallet: every tool hydrated; a wall note posted; a poll vote signed and
counted (the wallet signed exactly the message above); a drop submitted, then featured by the owner over the launchpad
API and shown as "Today's pick"; the token panel showed the mock numbers (marked MOCK), copy and QR; the meme maker
downloaded a 640×640 PNG; the event exported an `.ics`; the map loaded OSM tiles and took a pin; the synth played; the
game ran. Screenshots: `kit-*.png` in the session scratchpad.
