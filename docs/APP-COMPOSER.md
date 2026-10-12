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
| `launch` | Visitors launch REAL coins from the site (below). `split: {creator, parent, sub01}` in bps, the author's within limits: creator 50–80%, SUB-01 20–50%, parent 0–30%, total 100%. Only a launchpad idea gets it; a child never has it. |

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

- **Rules** (always): launchpad words (`a launchpad`, `launch pad where/for…`, `token factory`, `create coins`, `launch coins`, it:
  `piattaforma di lancio`, `crea monete`, `creare token`, ja romaji: `raunchipaddo`, `koin wo tsukuru`, `tokun hakkou`…; a bare
  "this launchpad" is SUBZERONE itself and does not count) → the launchpad app (the `launch` block, plus the `pq` registry on
  a second screen when the idea is also quantum-themed); quantum words (`quantum`, `post-quantum`, `pqc`, `lattice`, `dilithium`, `kyber`, `ml-dsa`…) → the
  `pq` app; a ritual (`every night`, `midnight`, `ogni sera`, `maiban`, a time) with something sent or chosen → the ritual
  app (form → candidates → signed votes → reveal → card → archive; the card template from `receipt`/`ticket`/`train`/
  `postcard`/`badge`/`poster`; the goods on the receipt from the idea); venues (`bar`, `ramen`, `shop`, `place`…) → a
  community guide with votes, a map and a member card; a party → a guest list with tickets; an artist → a request board
  with posters (nothing generates art); a destroyer (`destroy`, `kaiju`, `t-rex`, `godzilla`…) → a target list; a
  building or home → a visitor book with a pass; otherwise a small suggestion board. `honest` says in one line what was
  built and why, including when the idea has no clear product.
- **Claude** (only with `ANTHROPIC_API_KEY`): `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `max_tokens` 2000, thinking off (`between_tools`, Sonnet 5.5 only),
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

## The launch block: coins launched from a coin's site (2026-10-12)

The owner: "it's not a launchpad: people who enter can't create quantum-proof coins there". A launchpad idea now gets a
site where visitors create real coins. Nothing new launches them: each child coin is an ordinary SUBZERONE idea +
project (its own building, its own site, SUB-01's vote first) with `projects.parent_project_id`, and goes through the
same machinery (`launch.js` createIntent / refreshIntent / submitSigned / confirmIntent, the Phantom-safe pump.fun
layout, the two-step dev buy, the simulation checks, the on-chain verification).

| Piece | Where |
|---|---|
| `/_api/launch*`, the child build, the parent's numbers, the after-launch hook | `src/child-launch.js` |
| The split rule for children (`CHILD_SPLIT_POLICY`: SUB-01 ≥ 20%, creator ≥ 50%, roles submitter / parent / sub01) | `src/launch.js` validateRecipients |
| The page (form → review → one signed message → SUB-01 → reviewed transaction → launched; the list of coins launched here) | `kit/launch/index.js` → `public/_kit/site-launch.v1.js` |
| Data | `migrations/016_child_launch.sql` (015 is left to another branch) |
| Tests | `test/childlaunch.test.js` |

**Flow.** The visitor fills name, ticker, description (≥ 20 characters: SUB-01 reads it), an image (PNG/JPEG/GIF/WebP ≤ 1.5 MB,
checked by its bytes like idea uploads) and an optional dev buy. `POST /_api/launch/quote` returns the exact split and a
single-use message stating the coin, the image's sha256, the dev buy and every fee recipient with its share and wallet;
the wallet signs it (a message, not a transaction). `POST /_api/launch/start` checks the signature against the image
actually sent, creates the idea (public, owner = the visitor, a free plot near the parent), and kicks SUB-01's vote
(seconds). The page holds a launch key (only its sha256 is stored) for the transaction steps. On **build** the job
`child_build` makes the project from what was signed (the template, no language model; the logo is the uploaded image;
the allocation is the signed split, approved by that signature), builds the site and prepares the launch configuration
(a reviewer first only when `REQUIRE_ADMIN_CLEARANCE=1`). On **pass** nothing is built and the page shows his feedback.
The visitor then reviews the configuration (network, token, the locked split, the irreversible lines, the config hash),
asks for the transaction (programs, bytes, fee, rent, simulation shown), signs it in the wallet
(Wallet Standard `solana:signTransaction`; the server checks it is the reviewed one, Phantom guards tolerated, and
broadcasts it), and signs the dev buy as step 2. Launches open only once the parent itself is launched.

**Fee split.** `creator` (the visitor) / `parent` (the parent idea's receiving wallet) / `sub01`, from the parent's live
launch block, default 70/10/20, written on-chain by the existing fee-sharing config and locked. Same wallet twice merges
(the author launching on their own site keeps both shares). Re-validated when the configuration is prepared.

**Post-quantum (positioning, the owner 2026-10-12): the launchpad with a post-quantum registry of every launch.** The
composed copy leads with it and keeps the Ed25519 note; it never claims quantum-safe fees. Every child launch (configuration sha256, the locked split, mint, transaction signature) is appended to
the parent's ML-DSA-65 registry as `child.launch` (at launch, and on every read) and verified in the browser. The coins
themselves are Solana tokens (Ed25519): the page says no coin can be quantum-proof. The Winternitz vault
(github.com/blueshift-gg/solana-winternitz-vault, program id `wntrRTssxbf1rz9RPJ4xNBbpXxfsidQJT177NN3MXhB`) is not deployed
on mainnet, devnet or testnet (getAccountInfo null, no signatures, 2026-10-12) and has no audit, so fee shares are never
routed to it; on a launchpad the honesty box says only that a quantum-resistant vault for creator fees is not available on
Solana mainnet today (no link).

**City and parent.** `/api/world` gives a child `parent: {slug, name}` and a launchpad `childrenLaunched`; the child's site
says "Launched at …" and links back; the parent's block shows coins launched here, in progress, 24 h volume and market
cap (stored coin stats), and the list with logos served on the parent's origin.

| Method | Path (project host) | |
|---|---|---|
| GET | `/_api/launch` | split, limits, network, counts, the coins launched here (`before=` pages) |
| POST | `/_api/launch/quote` | `{wallet, name, ticker, description, imageSha256, devBuySol}` → `{nonce, message, recipients, statement}` |
| POST | `/_api/launch/start` | the same + `{nonce, signature, image}` (base64, ≤ 2.2 MB body) → `{id, key}` |
| GET | `/_api/launch/:id`, `/_api/launch/:id/image`, `/_api/launch/logo/:slug` | status, verdict, configuration, launch, dev buy, registry entry; images inert (nosniff, sandbox CSP) |
| POST | `/_api/launch/:id/{tx,refresh,signed,abandon}`, `/devbuy/{tx,refresh,signed,abandon,skip}` | `{key, signed?}`: launch.js on the child project, signer = the visitor |

## Launchpad families (2026-10-12, `src/family.js`; the PadPad idea)

"A launchpad for launchpads": the launch block's `children` option says what a coin launched from the site is:
`coins` (the default, as before), `launchpads` (every one gets its own site with a working launch block and the family
tree, inheriting the parent's options), or `choice` (the launcher ticks "Make it a launchpad"; the tick is in the signed
payload). Down to `MAX_DEPTH` = 5: a coin at generation 5 is a coin, and the sites say so.

| Generation of the new coin | Creator fees, split on-chain and locked at launch |
|---|---|
| 1 (launched from a root launchpad) | creator 70 / parent's author 10 / SUB-01 20 (the block's split) |
| 2 and deeper | creator 60 / parent's author 10 / grandparent's author 10 / SUB-01 20; it stops at the grandparent |

The grandparent's share comes out of the creator's (who keeps at least 50%); same-wallet rows merge as before. The
shareholders are the ancestors' recorded author wallets (the creator row of the split their own coin was launched
with). Computed on the server from the database, signed by the visitor in the start message, stored with the parent's
block split (`child_launches.split_json`, migration 020), and recomputed at `prepare_launch` and at the signed step
(`409 split_mismatch`). The pump.fun provider also decodes `update_fee_shares_v2` in the bytes the wallet signed and
checks every share against the approved configuration. pump.fun allows at most 10 shareholders, each > 0 bps, 10,000 in
total, no duplicates, set once (`@pump-fun/pump-sdk` 4.0.0 `MAX_SHAREHOLDERS = 10`, `updateFeeSharesV2`; pump-fees
errors 6010-6017, 6024); a family split has 2 to 4. Devnet simulation of a 4-shareholder launch:
`docs/demo/sim-padpad-family-2026-10-12.json` (1046 bytes, Phantom-safe, simulation ok). The fees go to the creators of
launchpads up the tree, never to buyers or holders, and every site says so.

The `tree` block (only with a launch block) reads `GET /_api/tree` on the project host, the same as the public
`GET /api/projects/:slug/tree` (15 s cache): `{root, focus, maxDepth, rule, note, totals: {coins, launchpads,
launched24h, deepest, inProgress}, fastest: [...], mostDescendants: [...], nodes: [{slug, name, ticker, depth, parent,
launchpad, launched, launchedAt, mock, network, mint, siteUrl, children, descendants, launches24h, branch24h,
inProgress, marketCapUsd, volume24hUsd}], truncated}`. Launched coins only (in-progress ones are counted), public ideas
only, at most 400 nodes. "Fastest-growing" = most launches in the branch in the last 24 h; market numbers only when
coin-stats.js already stored them (nothing is fetched).

The composer: an idea about launching launchpads (a launchpad for/of launchpads, launch a launchpad, launchpads that
launch, a family tree / descendants / grandparent of launchpads; en / it / ja romaji) gets exactly
`launch{children: 'launchpads'}` + `tree` (+ `pq` when quantum), kind `launchpad-family`, by the rules and through the
model (which may not drop the tree, change `children`, or add a form, votes, a map …). Its site keeps the coin's own
tools and the wall; no meme maker, map, poll, drop box, event, synth or game.

## The copy (2026-10-12)

The owner's brief after "Q-wave: a meme coin for the permissionless launchpad idea … Just a meme, no promises": the sites
have real functions, so the words present the real product. `generator.js` now composes the app **first** and writes the
copy **for that app**:

1. `composeApp` (rules, or Claude validated against the rules) with the author's name and ticker.
2. The copy: `writeCopy` sends `COPY_SYSTEM` (a top product studio's brief: name, a tagline that says what it does, a
   description, 1–4 sections on the app's actual features, an X bio with no links, 2–3 launch posts; confident, concrete,
   premium, no hype words) and `copyBrief` (the idea as untrusted data with the author's name, the app's kind, title,
   lede and one plain sentence per block from `appFeatures`, the site's standard tools from `tools.js` `CATALOG`, the
   chain panels, the vote in a clause, the composer's `honest` line, the quantum note). JSON-only output
   (`output_config.format` with `COPY_SCHEMA`), `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `max_tokens` 4000.
3. `checkCopy`: lengths; no markup or emoji; no returns, yield, holder benefits (`RETURNS` and the spec's promise words);
   no "just a meme", "no promises", NFA or other disclaimer filler (the site prints its legal note in "What this is" and
   the footer); no hype words; no endorsements; never "conscious"; no quantum-proof / quantum-safe claim about coins, keys,
   wallets or fees unless negated (the registry only); no links in the bio or the posts; the brain at most twice. A fixed
   name and ticker win; the vote and the author's credit are added in a short sentence when the model forgot them; handle
   ideas that do not fit X are replaced by SUB-01's. A broken rule gets one more try with the reason.
4. Any model problem (HTTP, network, refusal, truncation, invalid JSON, a rule broken twice) falls back to `templateCopy`
   and logs `generator: the language model failed …` with `status` and the API's message (never the key); the audit
   line says "the language model failed". The build no longer dies on a model error.

`templateCopy` (no AI) writes from the same app: a tagline per app kind ("The launchpad with a post-quantum registry of
every launch."), the app's lede as the description, "How it works" from `appFeatures`, "Also on the site" from the tools,
"Where it comes from" (the author, the vote in one clause, the idea in its author's words). The author's name suggestion
is kept as typed ("Q-wave", not "Q-Wave").

## Does it match the idea? (2026-10-12, `src/fidelity.js`)

The owner's case: "PadPad: a launchpad for launchpads; fees flow up the family tree; the site shows the live family
tree; in the city each launchpad is a building with its children as a neighbourhood" was shipped as a plain launchpad
with a wall, a meme maker and a map, its copy described only the plain launchpad, and nobody was told. Now, after the app
is composed and before a word is written, SUB-01 checks it:

1. **Core features.** The 2–5 things without which it is not this idea, each mapped to the app's blocks and the site's
   tools: `built`, `partial` or `missing`, with a one-line reason and a reusable kebab-case `capability`. With a model:
   one call (`FIT_SYSTEM`, JSON schema `FIT_SCHEMA`, the same `ANTHROPIC_MODEL`) that sees the idea (untrusted), the kit
   (every block of `app-blocks.js BLOCKS` and every tool of `tools.js CATALOG`, read at call time, so a new block counts
   by itself), what the app has and the optional tools. Its answer is normalised: `builtBy` must name parts present,
   "built" with nothing behind it becomes missing, and the rules can only make it stricter (a capability they know,
   e.g. a fee tree, is not "built" without a part whose catalog line does it; titles and ledes are never evidence).
   Without a model, or on any model problem: `rulesCore`, conservative keyword heuristics (`CAPABILITIES`: recursive
   launchpads, fee tree, family tree view, city neighbourhood, AI generation, live chat, multiplayer, a custom game,
   marketplace, NFTs, holder rewards, physical goods, phone app, bots, betting, on-chain governance, live video) plus the
   app's own product by its kind. `PLATFORM` lists what the platform itself provides (a building in the city, X drafts).
2. **Tools** (same call): see SITE-KIT.md, "SUB-01's choice".
3. **The result** (`validateFidelity`, `fidelity/1`): `{v, source: model|rules, model, verdict: match|partial|missing,
   core: [{feature, capability, status, builtBy, reason, terms}], tools: [{id, why}], built, message, fallback}`.
   `message` is SUB-01's own words, written from the list, never by the model ("I can't build launchpads that launch
   launchpads yet. The launch block launches plain coins … What I built instead: …").

**Consequences.** The build timeline has a step "Does it match the idea?" between the app and the words, flagged
(`flag: missing|partial`) with the list in its note. The check is stored (migration `021_idea_fidelity.sql`:
`idea_fidelity`, one row per build run, and `fidelity_gaps`, one row per feature not fully built) and shown in
`GET /api/ideas/:id` and `GET /api/projects/:slug` (`fidelity`, author and staff only), on the room PC's Site tab
("Missing from your idea") and in the verdict card. A build with a missing feature tells the author in SUB-01's words
(a public `fidelity` event) and its preview note says "preview ready, but it is not all of your idea"; the author can
still publish. The admin page lists the **most requested missing capabilities** (each idea once, from its newest check).

**Honest words.** The copy brief lists what is not built ("never present them as real") and what is built only in
part; `checkCopy` refuses a sentence that uses a missing feature's terms without saying it is not there (a model draft
gets one more try with the reason, then the template). The template never quotes the author's words when something is
missing; "Where it comes from" says "The idea asks for more than this first version does. Not built yet: …". The app's
own title, lede and notes get the same check (`honestApp`: the rules' words replace a lying title or lede). "Ask SUB-01
to rewrite" reads the latest check too.

**Ask SUB-01 to rewrite** (`rewrite.js`, room PC Site tab): `POST /api/projects/:slug/rewrite` (owner; preview_ready /
approved / launch_prepared; before any launch transaction; 3 a day per project, counted on the jobs table; one at a time)
queues `rewrite_copy`: `rewriteSpec` writes the copy again for the app and tools the live spec has now (name and ticker
kept), a new site version goes through SUB-01's QA, and when it is live the X drafts follow (`x.js replanDrafts`: only
drafts change), the project description too, and a prepared launch configuration is prepared again (its metadata carries
the description), like the logo choice. `GET` the same path → `{allowed, lockedWhy, perDay, left, last:{state, progress,
version, live, qa, generator, fallback, error}}`. 429 `rewrite_limit`, 409 `locked`.

