# The idea app composer (2026-10-12)

SUB-01 turns each coin's idea into a small working app on the coin's site, assembled from vetted blocks. The app is
**data** (an app spec, `spec.app` in the site spec), strictly validated; the audited kit interprets it. No model output and
no author input is ever executed, and nothing asks for a transaction: wallets only sign plain messages.

| Piece | Where |
|---|---|
| The DSL: blocks, schemas, cross-block rules, JST slots | `src/app-blocks.js` |
| The composer: rules (en / it / ja romaji) + optional Claude, fallback to rules | `src/composer.js` |
| `/_api/app*`, the reveal engine and its beacon, the owner's routes, the backfill | `src/app-api.js` |
| The post-quantum registry (ML-DSA-65) | `src/pq.js` |
| The static markup (`<section data-app data-config>`) | `src/site/render-child.js` (`appHtml`) |
| The interpreter, loaded by the core only on sites with an app | `kit/app/index.js`, `cards.js`, `pq.js`, `app.css` → `public/_kit/site-app.v1.js` |
| Data | `migrations/014_app_items.sql` (013 is left to another branch) |
| Boot backfill | `scripts/backfill-app.js` (run by `tools/start.sh`) |
| Tests | `test/app.test.js` |

## The DSL (v1)

`{v: 1, kind, title, lede, flow: 'inbox'|'board', noun: {one, many}, screens: [1–4 {id, title, blocks}]}`, at most 14 blocks.

| Block | What it does |
|---|---|
| `submit` | A form with 1–4 typed fields (`text`, `longtext`, `choice`, `number`); the first is the item's text. Moderated with the chat filter, 6 a day per connection (salted IP hash), 1000 a day per project, plus the per-minute write limit. `holdersOnly`: a signed message (and the chain check on mainnet). |
| `schedule` | A recurring moment in JST: every day at HH:MM, or every week on a weekday. Drives the reveal; shows a countdown and an `.ics`. |
| `reveal` | At each scheduled instant one item of that round is published. Order (`pick`): the author's pick → the holders' votes (top count; a tie goes to the draw) → a random draw. Recorded with its proof in `app_reveals`. |
| `vote` | One signed vote per wallet: per round for `candidates`, per item for `published`. Holders only when set. |
| `collection` | The public list: published items (inbox apps) or every visible item (board apps); month and text filters, pagination, a link per item (`/#item-<id>`). |
| `card` | The item as a downloadable PNG drawn on a canvas: `receipt`, `ticket`, `poster`, `postcard`, `badge`, with the logo, the JST date, a keepsake number clearly marked as not real, and a QR to the item. `input`: visitors can make their own (nothing uploaded). |
| `leaderboard` | Items or wallets by votes or submissions. |
| `counter` | Today, in total, published, votes today, voters today, days running. |
| `map`, `timer` | The existing map tool and the event countdown, reused. |
| `note` | A short plain-text box. |
| `pq` | The post-quantum registry, a verifier, an honesty box (below). |

**Flows.** `inbox`: a submission is private (owner only) until published, except that an app with a `vote` on
`candidates` shows the open round's submissions publicly and anonymously so holders can vote; the form says which, in
plain words. `board`: submissions are public at once; the author can hide anything.

**The draw.** The seed is the blockhash of the first finalized Solana block whose time is at or after the reveal instant
(found by binary search over `getBlocksWithLimit` / `getBlockTime` on the coin-stats RPC, ~30 calls once per reveal).
Each candidate scores `sha256(blockhash + ':' + id)`; the lowest wins. The proof (slot, blockhash, candidate ids, votes)
is on the item, and the page's "Check the draw" recomputes it with `crypto.subtle`. Without an RPC (`HELIUS_URL` /
`HELIUS_API_KEY`) the seed is the reveal instant and the proof says so; if the RPC fails, the reveal waits and retries
for 2 hours before falling back (said in the proof), so the server never picks a seed by choice.

**When reveals run.** Lazily, on the first request after the instant (`/_api/app`, the archive, the room PC), catching
up to 7 missed slots, once per slot (primary key + an in-process guard). `APP_DEV_TRIGGER=1` (refused in production)
enables `POST /api/projects/:slug/app/reveal-now` for local tests; such a reveal is marked "dev trigger" on the page.

## The composer

`composeApp(idea, brain, {name, ticker, cfg, fetchImpl})` → `{app, source, honest, summary, fallback?}`.

- **Rules** (always): quantum words (`quantum`, `post-quantum`, `pqc`, `lattice`, `dilithium`, `kyber`, `ml-dsa`…) → the
  `pq` app; a ritual (`every night`, `midnight`, `ogni sera`, `maiban`, a time) with something sent or chosen → the ritual
  app (form → candidates → signed votes → reveal → card → archive; the card template from `receipt`/`ticket`/`train`/
  `postcard`/`badge`/`poster`; the goods on the receipt from the idea); venues (`bar`, `ramen`, `shop`, `place`…) → a
  community guide with votes, a map and a member card; a party → a guest list with tickets; an artist → a request board
  with posters (nothing generates art); a destroyer (`destroy`, `kaiju`, `t-rex`, `godzilla`…) → a target list; a
  building or home → a visitor book with a pass; otherwise a small suggestion board. `honest` says in one line what was
  built and why, including when the idea has no clear product.
- **Claude** (only with `ANTHROPIC_API_KEY`): `claude-sonnet-5-5`, `max_tokens` 2000, thinking off (`between_tools`),
  server-side refusal fallback on, the idea passed as untrusted data, the rules' draft included. The answer must be one
  JSON object that `validateApp` accepts (and keep the `pq` block for a quantum idea); anything else falls back to the
  rules with the reason in `fallback`.

New sites get the app from `templateGenerate` / `anthropicGenerate`; the tools the app does better are dropped
(`toolsBeside`: the drop box when there is a form, the event at the schedule's time, the poll when there is a vote, the
map tool when the app has a map, the wall on a board app).

## The post-quantum block

Per project, an ML-DSA-65 key (FIPS 204, `@noble/post-quantum` 0.7.1, MIT): the 32-byte seed is stored encrypted with
`APP_ENCRYPTION_KEY` (AES-256-GCM, like the X tokens); without that key the block answers 503 `pq_off`. The registry
(`pq_entries`) is append-only and hash-chained: the key itself, each approved fee split, the launch configuration
(its config hash), the verified mint, every built site version (HTML sha256), every app reveal and the owner's notes
(`POST /api/projects/:slug/app/announce`). Each entry signs a fixed text (`SUBZERONE post-quantum registry v1`, project,
seq, kind, ref, ISO time, `payload-sha256`, `prev`). The page loads the vendored verifier (9 KB gzip) and checks every
signature, payload hash and link in the browser; a "verify anything" box checks any message/signature/key; the honesty
box says plainly that Solana accounts and the coin use Ed25519, which a large quantum computer could break, that the coin
is not quantum-proof, and links the open-source Solana Winternitz vault
(https://github.com/blueshift-gg/solana-winternitz-vault) as read-only further reading.

## API

Project host (same origin, no cookies, writes need the site's `Origin`, JSON ≤ 4 KB):

| Method | Path | |
|---|---|---|
| GET | `/_api/app` | state: schedule + next/last instant, the open round, the latest published item with its reveal proof, the round's candidates with their votes (candidates apps), counts, holder notes |
| GET | `/_api/app/items?show=published\|all&month=YYYY-MM&q=&before=&limit=` | the archive (`all` only on board apps) |
| GET | `/_api/app/items/:id` | one public item with its proof |
| GET | `/_api/app/leaderboard?i=` | the i-th leaderboard block |
| GET | `/_api/app/pq?before=` | the registry, newest first, 20 a page |
| POST | `/_api/app/submit` | `{fields}` (+ `wallet, nonce, signature` when holders only) |
| POST | `/_api/app/vote` | `{itemId, wallet, nonce, signature}`; 409 `already_voted` |
| POST | `/_api/sign` | actions `app.submit`, `app.vote` (same rules as the site kit's signed writes) |

Launchpad (session; owner, admin read/moderate):

| Method | Path | |
|---|---|---|
| GET | `/api/projects/:slug/app` | the app, its summary, the block catalog, the inbox (all items, private ones too), the open round, the pick, the last reveals, the registry's status |
| PUT | `/api/projects/:slug/app` | `{app}` (validated) or `{app: null}` (off); a new site version, live; preview approvals reset like the tools |
| POST | `/api/projects/:slug/app/compose` | SUB-01's composition again (not saved) |
| POST | `/api/projects/:slug/app/items/:id` | `{hidden}` and/or `{publish: true}` |
| POST | `/api/projects/:slug/app/pick` | `{itemId}` for the next reveal, `null` to clear |
| POST | `/api/projects/:slug/app/announce` | a signed note in the registry (pq apps) |
| POST | `/api/projects/:slug/app/reveal-now` | dev only (`APP_DEV_TRIGGER=1`, never in production) |

## Backfill

`scripts/backfill-app.js` (boot, after `backfill-site-tools.js`, idempotent, never fatal): every launched coin whose
live spec has no `app` key gets the composed app as a new site version, set live, with the superseded tools off, and
the public line "SUB-01 built the app: … (site vN; replaces drop, …)". `app: null` (the author's "off") is left alone.
