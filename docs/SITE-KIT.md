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
| Data | `migrations/012_site_tools.sql`, `migrations/015_holder_tools.sql` (chain copy of the holder tools) |
| Tests | `test/tools.test.js` (14 tests), `test/holder-tools.test.js` (14 tests, real mainnet fixtures in `test/fixtures/onchain/`) |
| Holder tools: chain layer, endpoints, backfill, mainnet check | `src/onchain.js`, `src/holder-tools.js`, `kit/src/tools/holder-tools.js`, `scripts/check-holder-tools.js` (section "Holder tools" below) |

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
  kit stylesheet `<link rel="stylesheet" href="/_kit/site-kit.v2.css">` (v2 since the 2026-10-12 redesign, docs/DESIGN.md; pages built before keep linking v1, still served) once in the head and the kit script
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
| `trades` *(holder)* | Live buy/sell feed of the bonding curve: time, side, SOL, tokens, wallet (Solscan), flags dev / top 10 / first buy; 24 h totals. | chain (`chain_trades`) | — |
| `holders` *(holder)* | Top 20 holders, % of supply, the curve and the PumpSwap pool labelled and left out, top-10 / top-1 %, holder count, a risk line in plain words. | chain | — |
| `devwatch` *(holder)* | The author wallet: dev buy vs balance now, every move in or out with time and size, a status line. | chain | — |
| `fees` *(holder)* | Creator-fee ledger: the locked split read from the sharing config, paid out (decoded payouts) + waiting (vault, curve, AMM) = accrued, per shareholder. | chain + `fee_observations` | — |
| `alerts` *(holder)* | "Tell me when MC > X / < Y or when the dev sells": localStorage only, polled while the page is open, toast + Notification. | `/_api/token`, `/_api/devwatch` | — |

At most 6 tools per site and at most one extra. Every config is validated strictly (`validateTools`: unknown fields,
duplicates, sizes, markup characters, the financial-promises filter of `validateSpec` over the whole spec).

### SUB-01's choice: only what serves the idea (2026-10-12)

The PadPad build shipped a meme maker and a map nobody asked for ("in the city" read as a place). Since 2026-10-12 a
tool beyond the app is on the site only when it serves the idea, and the site says why (`why` on each tool):

- always `token` (the coin's panel) and `wall` (the one default community tool), and the five holder tools;
- at most **3** more (`MAX_IDEA_TOOLS`), at most one extra, each with a reason. With a language model, `fidelity.js`
  asks it in the same call as the idea check (see APP-COMPOSER.md, "Does it match the idea?"): it picks from the catalog
  (read at call time) with a reason per tool; the map is dropped unless the idea is about real places people go
  (`PLACE_WORDS`), whatever the model says. Without a model, or on any model problem, `ruleToolPicks` in `tools.js`:
  - `drop` when people send / confess / submit / ask / wish / tell stories (`confess*`, `kokuhaku`, `himitsu`, `domand*`,
    `onegai`, `tegami`, `okuru`, `tokumei`…); the prompt names the noun ("Drop your confession");
  - `event` when the concept has a time or a ritual (`every night`, `ogni sera`, `maiban`, `23:00`, `11pm`, `alle 23`,
    `23ji`, `midnight`); the time found becomes the reveal / event time;
  - `poll` when the idea asks people to vote, choose or decide;
  - `memes` only for meme words in the idea or its name (`meme`, `cat`, `frog`, `lol`, `neko`…), never to make up a number;
  - one extra when its words win: map (real places only: `ramen`, `izakaya`, `cafe*`, `bar`, `spots`, `map`, `mappa`,
    `chizu`… — not `city`, `tokyo` or `neighbourhood` alone), synth (`music`, `beat*`, `lofi`, `ongaku`…), game
    (`game`, `arcade`, `gioco`, `geemu`…), chart (`chart*`, `price`, `trading`, `kabu`… — not `pump`).
- The brain's networks no longer choose wall or poll.
- Then the app replaces what it does better (`composer.js toolsBeside`: its form the drop box, its schedule the event, its
  map the map, its votes the poll, a board app the wall).

Konbini Confession gets token, wall, drop (reveal 23:00), event (daily 23:00), and the app takes over the drop and the
event. Ramen Radar gets token, wall, map (its places app carries the map). PadPad gets token and wall only. The copy says
why each tool is there ("It is here because …"). The room PC keeps SUB-01's reason on a tool the author keeps; a tool the
author adds has none.

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

## Holder tools (2026-10-12)

The trust layer on every coin site, on top of the six tools above (they do not count toward the limit of 6): **trades,
holders, devwatch, fees, alerts**. SUB-01 gives all five to every coin (`pickTools` appends `TRUST`); before the launch
they render in their own section "Check the chain" with what each one does and "Goes live at launch"; on a MOCK launch
they say there is no chain. The author can switch them off in the room PC like any tool (`kind: 'trust'` in the catalog,
`trust` in `GET /api/projects/:slug/tools`).

**Honest data.** Every number is read from the chain (decoded pump.fun events, account balances, the sharing config)
or it is `null` and the page shows "—" with the reason. Nothing is estimated: accrued fees are *paid out + waiting*, both
read on chain; holder counts are counted (Helius DAS) or shown as "—" / "≥ N"; the dev status says when the author
account's history is still loading; the 24 h trade totals appear only once the history read covers a full day.

**Where the data comes from** (`src/onchain.js`, read-only, no key ever signs):

| Tool | Source | Cadence (only while a page asks) |
|---|---|---|
| trades | `getSignaturesForAddress(bondingCurvePda(mint))` → `getTransaction` (json, `maxSupportedTransactionVersion: 1`) → `TradeEvent` decoded with `PUMP_SDK.decodeTradeEventBc`, from the self-CPI event instructions (never truncated) or the program's own `Program data:` lines, never both. Incremental: `chain_cursors` (newest / oldest signature), `chain_sigs` (queue, failed transactions never fetched), `chain_trades`. Newest first, then older history page by page. | one step per 15 s per coin, ≤ `ONCHAIN_TX_PER_POLL` (30) transactions |
| holders | Helius DAS `getTokenAccounts` (every account, ≤ 5 pages from the shared Helius page budget) → exact top 20 and count; else RPC `getTokenLargestAccounts` + `getMultipleAccounts` (owners): exact top 20, count from coin stats or "—". Excluded and labelled: `bondingCurvePda`, `canonicalPumpPoolPda`; labelled: the author, SUB-01, off-curve owners ("program account"). Supply from `getTokenSupply`. | 5 min per coin |
| devwatch | the author's Token-2022 ATA history (same walker): per transaction the author's token change from pre/post balances, classified `dev buy` (the launch transaction), `buy`/`sell` (a `TradeEvent` of the author), `sell (PumpSwap)`, `out`/`in` (a transfer, or a sale through another program); balance now = `getTokenAccountsByOwner(author, mint)`; the dev buy = `launch_intents.buy_tokens_base` (reviewed, exact-out) or the launch transaction's own change | 30 s |
| fees | the sharing config `feeSharingConfigPda(mint)` decoded (shareholders, `adminRevoked`), its history → `DistributeCreatorFeesEvent` (paid out), waiting = creator vault `creatorVaultPda(sharingConfig)` balance − rent + the curve's unswept `creator_fee` (+ the PumpSwap creator vault's WSOL after a migration). Cross-check: the sum of the curve trades' creator fees. The hourly `feeLedger` (reconcile job) rides along as `ledger`. | 60 s |
| alerts | the visitor's browser: `/_api/token` (stored DexScreener market cap) and `/_api/devwatch`, every minute while the page is open | — |

After a migration to PumpSwap the trades feed says so and links DexScreener (AMM trades are not decoded here).

**API** (project host, same rules as the other `/_api` reads: 300/min per IP, no cookies):
`GET /_api/trades` → `{state, migrated, note, history:{complete, listed, done, oldestAt}, last24h, trades:[{sig, at, side, sol, tokens, wallet, short, walletUrl, txUrl, flags}], source, syncing, error}`;
`GET /_api/holders` → `{holders:[{rank, owner, pct, amount, label, excluded, url}], top10Pct, top1Pct, count, countExact, countSource, risk:{level, line}, supply, source}`;
`GET /_api/devwatch` → `{author, devBuy, devBuySource, balance, heldPct, sold, status, level, moves:[{sig, at, kind, tokens, sol}], history}`;
`GET /_api/fees` → `{sharingConfig, adminRevoked, shareholders:[{address, label, pct, accrued, received, waiting}], accrued, distributed, waiting, waitingParts, distributions, fromTrades, ledger}`.
`state` is `pre-launch` / `mock` / `live`; amounts are SOL and whole tokens.

**RPC and cost.** `ONCHAIN_RPC_URL` if set, else Helius for mainnet coins (`HELIUS_API_KEY`), else `SOLANA_RPC_URL` when it
is the coin's network, else the public endpoint. Paced (public 450 ms, others 110 ms; `ONCHAIN_MIN_GAP_MS`), retried on
429, counted per UTC day against `ONCHAIN_DAILY_CALLS` (15,000; the tools say when it is used up). A new coin's whole
history is read once (one `getTransaction` per successful curve transaction), then only the new signatures. Measured
2026-10-12: the public mainnet RPC served ~13–30 `getTransaction` a minute from this machine, too slow for a busy coin's
backfill; Helius served ~150 a minute. **Production should run the holder tools on Helius (or a paid RPC).**

**Kit.** `kit/src/tools/holder-tools.js` is built as its own chunk, `/_kit/vendor/holder-tools.<hash>.js` (4.7 KB gzip),
loaded only on sites that carry the tools, on the core's helpers (text only, no HTML sinks; the test greps the chunk).
Polls pause while the tab is hidden. Styles: `kit/src/tools/holder-tools.css` (imported by `site-kit.css`).

**Existing coins.** `scripts/backfill-holder-tools.js` (boot, after `backfill-site-tools.js` and `backfill-app.js`, idempotent) runs `backfillHolderTools`: every launched
coin whose live site lacks any holder tool gets them appended as a new site version, set live, with the public audit
line "SUB-01 added holder tools to the site: …". Once per coin (the audit line is the marker): a coin whose author
later removes them, or switched every tool off (`tools: []`), is left alone.

**Mainnet check.** `node scripts/check-holder-tools.js <mint>…` reads a coin's whole history through the same code and
prints the decoded trades, holders, dev status and fee numbers (results below, "Verified on mainnet").

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
| `site-kit.v2.css` (docs/DESIGN.md) | 33.9 KB | 7.8 KB | every site built since 2026-10-12 |
| `fonts/inter-var.woff2` + `jetbrains-mono-400/700.woff2` (subset, kit/fonts/subset.sh) | 57.9 KB | — | every site |
| `site-kit.v1.css` + `fonts/archivo-*.woff2` (frozen, kit/legacy) | 22.0 + 43.6 KB | 5.4 KB | pages built before the redesign |
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

Since 2026-10-12 the looks are the black-and-white Swiss system in **docs/DESIGN.md** (tokens, grid, type, the page
template, the class contract). Motion (`motion/mini`, WAAPI): the hero lines rise and fade in, sections fade up on
scroll (`inView`), new feed rows slide in, the sparkline fades in; anime.js runs the number tickers and the poll bars.
`prefers-reduced-motion` turns all of it off (anime.js is not even loaded; CSS animations and transitions stop).
Every new version is checked by SUB-01's QA before it goes live (docs/SITE-QA.md).

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
| Inter (`@fontsource-variable/inter`) | 5.3.0 | SIL OFL 1.1 | all text (subset, opsz + wght 400–800) | https://rsms.me/inter · https://fontsource.org/fonts/inter |
| Archivo (`@fontsource/archivo`) | 5.3.0 | SIL OFL 1.1 | the frozen v1 stylesheet only | https://fontsource.org/fonts/archivo |
| JetBrains Mono (`@fontsource/jetbrains-mono`) | 5.3.0 | SIL OFL 1.1 | numbers, labels | https://fontsource.org/fonts/jetbrains-mono |
| esbuild | 0.28.2 | MIT | build only, not shipped | https://esbuild.github.io |
| OpenStreetMap tiles | — | data © OpenStreetMap contributors, ODbL; tile usage policy | map tiles (loaded from tile.openstreetmap.org, never copied) | https://www.openstreetmap.org/copyright |

Design references of the v1 look (visual patterns only; **no code copied**; v2 uses none of them, docs/DESIGN.md):

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

## Verified on mainnet: the holder tools (2026-10-12, read-only)

`scripts/check-holder-tools.js` over the whole history of two SUBZERONE coins (Helius RPC for the history read: the
public RPC served too few `getTransaction` a minute; nothing signed or sent). Both coins: author `HMPUiULX…6STQ`, no dev
buy, split locked 80% author / 20% SUB-01 (`4o16Xj4E…VjVAg`), admin revoked, not migrated.

| | Konbini Confession `8NmKmy…a8w7` | DIDDY `FPZCgk…6vX5` |
|---|---|---|
| curve signatures (failed) | 4,879 (2,428) | 1,799 (815) |
| trades decoded | 2,387: 1,335 buys, 1,052 sells, 611 wallets; 573.53 SOL in, 567.06 out | 176: 100 buys, 76 sells, 52 wallets; 42.42 SOL in, 40.22 out |
| holders (DAS, exact) | 24; curve 80.97%; top 10 hold 18.6% of the supply, 97.9% of circulation: high | 5; curve 92.67%; 4 wallets hold 7.3% of the supply, 100% of circulation: high |
| dev | no dev buy, holds 0 | no dev buy, holds 0 |
| fees accrued = paid + waiting | 3.421748 = 3.387247 (6 payouts) + 0.034500 SOL | 0.247906 = 0.212174 (1 payout) + 0.035732 SOL |
| cross-check: Σ creator fee of the trades | 3.421748 SOL (equal) | 0.247906 SOL (equal) |

The two ledgers agree to the lamport once the vault's rent is read on chain (`getMinimumBalanceForRentExemption(0)` =
650,240 lamports on 2026-10-12; a hard-coded 890,880 was off by exactly the difference). Screenshots of each tool on the
local Konbini site with this data: `util-*.png` in the session scratchpad.

