# Feature status (2026-10-10)

**Legend**

- **Working**: runs locally against real components and is covered by tests.
- **Mock-tested**: the code path is complete, but it was exercised against a labelled stand-in (the mock provider or a
  fake API), not the real service.
- **Blocked**: needs a credential, an approval or more development, as noted.

| Area | Feature | Status | Evidence / what's missing |
|---|---|---|---|
| Pages | Home with the live room, explanation, submit button, ideas being built, empty states | Working | screenshots in this session; room iframe = subzerone.live |
| | Idea submission | Working | UI sign-in + submit verified in a browser with a dev test wallet |
| | Idea detail and timeline (brain vote, scorecard, versions, visibility) | Working | |
| | Project preview and approval (site preview, edit → new version, rollback, X drafts, fee split, approval) | Working | in this in-app browser pane the sandboxed preview iframe is blocked by the pane itself; it opens in a new tab and renders on the project subdomain |
| | Launched project page (verification checks, fee ledger, brain record) | Working (mock launch) | |
| | SUB-01 token page (official links, DexScreener and RPC data with source and time) | Working | live data read on 2026-10-09 |
| | Submitter dashboard | Working | |
| | Admin dashboard (pauses, budgets, SUB-01 fee share (read-only), clearance, failed ideas, dead letters, intents, roles, bans, backup, audit) | Working | |
| | Fee ledger and methodology | Working | shows "—" (unknown) rather than zero before the first observation |
| Auth | Wallet sign-in (SIWS-style message, single-use expiring nonce, replay protection, no funds) | Working | 7 tests |
| Review | Independent security/correctness review of launch, auth, privacy, XSS and jobs | Done | 9 findings fixed with regression tests; see TESTING.md |
| Submissions | Validation, versions (v1 kept), receiving wallet (validated, never replaced silently), image uploads (byte-sniffed), links stored, never fetched | Working | |
| | Private until published; what becomes public is explained on the form | Working | |
| Brain | Signed `/api/launchpad/evaluate` in the SUB-01 repo; real brain vote on a cloned live brain | Working (demo brain) | branch `feature/launchpad-eval` in `sub-01`, 5 tests; **not deployed** to subzerone.live |
| | Asleep → queued; offline → "nothing decided"; no substitute decider | Working | tests |
| Pipeline | Durable jobs: state, structured I/O, bounded retries, idempotency, cost and time limits, progress, audit | Working | 13 pipeline tests |
| Generation | Template generator (no AI) | Working | |
| | Language-model generator (`GENERATOR=anthropic`) | Mock-tested | needs `ANTHROPIC_API_KEY` and price env vars; tested with a fake API (failure, unsafe output) |
| | Logo PNG and banner SVG from the brain record | Working | |
| Site kit | Tools on coin sites: token panel, wall, signed poll, drop box with daily pick, event countdown + .ics, meme maker; one extra (map / sound toy / mini-game / chart) on vendored open-source libraries; SUB-01 picks them by keywords, the author switches them in the room PC (2026-10-12) | Working (mock launch) | `test/tools.test.js` (14); headless Chrome run with a test wallet; holder checks need `HELIUS_API_KEY` (else "any wallet", said on the page); see SITE-KIT.md |
| Sites | Sandboxed build, validator, versions, rollback, isolated subdomains with a no-script CSP | Working | locally on `*.projects.localhost` |
| | Public hosting on `<slug>.projects.subzerone.live` | Blocked | needs DNS wildcard + TLS (see DEPLOY.md) |
| X | Planned handle, bio, drafts; manual account creation step; OAuth 2.0 PKCE connect; approval-gated posting | Mock-tested | needs an X developer app (`X_CLIENT_ID`, redirect URI). Posting needs a paid X API tier. Bio/avatar must be set by hand |
| Launch | Launch intent → signature → broadcast → finalized → on-chain verification → launched | Mock-tested | full flow with the MOCK provider, in a browser and with `npm run demo:flow` |
| | Pump.fun provider (official SDK 4.0.0): devnet parameters read, transaction built, fee schedule read on-chain | Working up to the signature | transaction built against devnet (860 bytes, direct mode); simulation stops at `AccountNotFound` because the payer has 0 SOL. **No devnet transaction landed yet**: both devnet faucets were rate-limited |
| | Create + locked multi-recipient split in one transaction | Verified on devnet 2026-10-10 | lookup table `BLnaXFCoct6AtR7eUayZ43GTpD3csDWJUt4YhuTEGXPY` (devnet), mint `3HDJACAKb2S5ooG1jfJeVwM48pyF7Ezf5z9wKnU8dGPY`, tx `4FWjWvaz…xckqp`, 938 bytes, mode sharing_config, locked 80/20; transcript docs/demo/flow-pumpfun-2026-10-10T17-01-27.json |
| | Dev buy as step 2 (2026-10-12): every transaction handed to the wallet is Phantom-safe (event authorities static), where create + split + buy is 1231-1259 bytes, so the buy is its own transaction after the launch is verified (`launches.dev_buy_status`, `POST …/launch/devbuy/{transaction,refresh,signed,abandon,skip}`): ATA + `buy_v2` quoted on the live curve, cap quote + 5%, author the only signer, no lookup table; a sniper in between only makes it fail on its cap (retry or skip); "launched" never waits for it | Verified on devnet 2026-10-12 | mint `Dr1iFW8SaPS9yXWsoFDM2Z98aaepf7FTK1Zdzd94Ure2`, tx1 `22AfVCBa…JqdjA` **979 bytes** (both event authorities static), tx2 `4Q2dBVu3…HTGLNg` **1033 bytes** (no table), 10,493,886.257633 tokens received exactly as reviewed, 0.00997037 SOL taken (cap 0.0105); transcript `docs/demo/flow-pumpfun-2026-10-12T17-00-21.json`. Before: the 2026-10-10 single-transaction runs below |
| | Dev buy: the author buys up to 5 SOL of their own coin in the SAME creation transaction (`PUT /api/projects/:slug/launch/options`, `MAX_INITIAL_BUY_SOL`), quoted by the SDK, cost capped at quote + 5%, re-prepared config + hash, locked while a transaction exists, `Associated Token Account` green-listed in the review | Verified on devnet 2026-10-10 | mint `G3DzgJEFdKToithAPhH82tyXpkAWoPD3BKdr32W5NKmb`, tx `27YPg2LT…A9Vd`, **1202 bytes** with the lookup table extended to 22 accounts (`npm run lookup-table -- --extend`), 385,860 CU, 0.01 SOL bought 10,493,886.257633 tokens (exactly the quote), verification check `dev buy landed` (exact token amount); guards: 0.001 SOL minimum, balance and size checked before storing, no intent on a failed simulation (`409 simulation_failed` in plain words), curve-completing buys refused; transcripts `docs/demo/flow-pumpfun-2026-10-10T20-00-11.json`, `…T21-41-22.json`. **Mainnet: the owner's lookup table must be extended first** (same command with `--keypair`) |
| | Mainnet | Blocked | ToS §21(c) review / written OK from pump.fun, a funded devnet run, an RPC provider, the domain |
| Fees | Fixed rule: 80% submitter side / 20% SUB-01 (`SUB01_FEE_WALLET`), SUB-01 row mandatory; collaborators share the submitter's 80%; missing wallet → 409 `sub01_wallet_missing` | Working | flow tests; the old optional admin "platform share" and `/api/admin/platform-share` were removed. Every split is now on-chain `sharing_config` (pump.fun needs the lookup table) |
| | Ledger: verified undistributed (vault read), confirmed payouts (distribution events), per-recipient estimates, no double counting | Mock-tested | logic tested with a fake chain; real reads only after a real launch |
| City | Shared plots: 48 districts × 6 = 288 addresses, first come first served (race-safe), apartments + project plots, release on declined/cancelled | Working | `test/city.test.js`; contract in `docs/CITY-API.md` |
| | Residents (name, whitelisted look), rooms (whitelisted interior, default room), `/api/world` (public, 3 s cache, no wallets, private ideas masked), `/api/world/options` | Working | tests incl. private-idea leak check; SUB-01 asleep/offline is derived from the brain's last answer, not a live probe |
| | Project roles (founder / community lead / moderator) and community takeover (founder decides; admin only after 30 days of founder inactivity; fees never change) | Working | tests incl. 30-day rule |
| | Customization v2: look v2 (up to 4 accessories, accessory colour, pet), public personality traits, unlock tiers from the pipeline (resident / builder / founder / launched: items, emotes, accessories, pets), 16 special room items incl. `posterCustom` text and `neonTicker` (own public tickers only), `403 locked` | Working | `test/custom.test.js`; migration `003_custom.sql`; emotes are a client-side catalog (the server only lists them) |
| | Room guestbooks (residents only, not the owner, 1/min/room + 20/UTC day per wallet, latest 50, delete by owner or author, names never wallets), `visits`, owner's public unlocks on `/api/rooms/:plotId` | Working | tests incl. wallet-leak and quota-after-delete checks |
| | City events on `/api/world` (`accepted`, `site_live`, `launched`; last 24 h, max 30, public ideas only, first time each) | Working | tests incl. private-idea check; derived from the status history in `events` |
| | `/api/world` `plots[].project.ideaId`: a public project's idea id (the key for `/api/predictions/:ideaId` and `/api/ema/:ideaId/cheer`); `null` for a private project | Working | `test/city.test.js` (public shows the id, private is null, predictions accept it); contract in `docs/CITY-API.md` |
| | Desk computer in every room (`desk` on `GET /api/rooms/:plotId`): the owner's projects with framed site (`siteUrl` / owner `previewLink`), X tab (handle, status, owner's latest drafts), launch page and office links, logo/banner URLs, owner's ideas in flight; visitors see public projects only. App CSP `frame-src` adds `<PROJECTS_SCHEME>://*.<PROJECTS_HOST>`, app `frame-ancestors 'self'`; project sites `frame-ancestors 'self' <PUBLIC_ORIGIN>` + sandbox | Working (server) | `test/desk.test.js`; framing of a sandboxed cross-origin site checked in headless Chrome with the same headers. City client tabs not built yet. X cannot be framed (opens in a new tab); posting still needs the paid X API tier |
| | Single-origin hosting of the city client (`CITY_DIST`): city at `/`, assets immutable, launchpad at `/launchpad` | Working (local test dist) | not yet run against the real city build in a browser; CSP: see DEPLOY.md |
| | Live city chat: `GET /api/chat/stream` (SSE: `hello`, `msg`, `presence`, `sub01`, `del`, heartbeats; 2,000 streams, 20/IP, 10-min idle drop), `POST /api/chat` (1–140 chars, cleaned, no links, small slur denylist, no fake SUB-01 name tags, 1/3 s + 30/10 min + 200/day, 60 s dedupe, 7-day retention), presence by district (names only), reports, admin list/delete; resident names like SUB-01 now refused | Working (server) | `test/chat.test.js`; migration `006_chat.sql`; in memory, so one web process; the city client's bubbles are not built yet |
| | Talking to SUB-01: `POST /api/chat/sub01` over one shared WebSocket to his live server (`{type:'chat', text, nick}`), his `chat_reply` relayed as `kind:'sub01'` (no per-message tag; disclosure in `/api/disclosure` `chat_replies`), `sub01` state from his ticks (`sleep.stage`, `life.activity`) and `/api/mind` (`status.resting`) | Working (fake transport) / read-only live check | relay tests with a fake socket; on 2026-10-10 the relay connected to subzerone.live read-only and reported `awake`, `atDesk: false` (no message sent). His chat path ignores `nick`, and the city shares his 1-message-per-10-s client limit. **Not done**: no message sent to the live server yet; `waiting` counts city messages only |
| Trust | Vote ledger: every brain answer (build and pass, private ideas included) appended in the evaluation's transaction, append-only (DB triggers), sha256 hash chain over canonical JSON; `GET /api/votes` (no titles, labels or wallets for private/passed ideas; recomputable from the output alone), `/api/votes/head`, `/api/votes/verify` | Working | `test/trust.test.js` incl. tamper, re-hash forgery and deleted-row checks; migration `004_trust.sql`. **Not done**: publishing the head on-chain (memo), and anything that catches rows cut off the end before that exists |
| | `GET /api/disclosure` (fixed text, `SUB01_DATASETS`, `OPERATOR_NAME`) | Working | the dataset list and operator name are still to be filled in by you |
| | City calendar `GET /api/calendar`: ISO-week themes (8, JST), omikuji, launch parties, open-soon windows, monthly ranking date | Working | `test/calendar.test.js`; the monthly room ranking itself does not exist yet (`placeholder: true`); the city client does not read the calendar yet |
| | Anonymous telemetry `POST /api/telemetry` (strict, opt-out headers, 1/30 s per session, 500/day per IP, daily-salted hashes, 90-day retention) and `GET /api/admin/telemetry` daily aggregates | Working (server) | `test/telemetry.test.js`; the city client does not send reports yet; no admin UI panel yet (JSON only) |
| Rituals | Omikuji `POST /api/omikuji` (one deterministic slip per wallet per Tokyo day, secret salt, 7 fortunes, cosmetic buff until midnight JST shown as `buff` on `/api/world`) | Working (server) | `test/rituals.test.js`; migration `005_rituals.sql`; the city client does not show the shrine or buffs yet |
| | Build-or-pass predictions on public queued ideas (one per resident, settled in the ledger transaction, +10 points, names-only leaderboard) | Working (server) | tests incl. private-idea and own-idea refusals; points have no value by design (legal line in CITY-API.md) |
| | Ema: `pinnedHash`/`pinnedAt` at submission, `ledgerSeq` on idea and project JSON, `GET /api/ema`, one cosmetic cheer per resident | Working (server) | tests incl. "cheers never reach the brain"; ideas submitted before this migration have no hash; the hash is not anchored on-chain |
| | "While you were away" `GET /api/away` (visits, guestbook, project transitions since the last visit; `room_visits` written by room GETs) | Working (server) | tests; no push by design |
| | SUB-01's diary `GET /api/diary`, `/api/diary/latest` (templates only, exact ledger numbers, private/passed ideas by hash, finished days cached and re-checked) | Working (server) | tests incl. no private titles and cache invalidation on unpublish; the tower desk page in the city is not built yet |
| | Postcards `GET /api/postcard/:slug.(svg\|png)`, `/api/postcard/room/:plotId.(svg\|png)`, share pages `/p/:slug`, `/r/:plotId` with OG tags | Working (server) | tests (well-formed SVG, PNG 1200×630, no price); PNG uses a 5×7 bitmap font, so non-ASCII names print as `?` (SVG shows them); the city's "take a photo" button and `?focus=` handling are not built yet |
| Launch | Review before sign: programs touched, writable accounts, signers, fee payer, network, cost, locked split with bps, "what this does NOT do"; Sign disabled for a foreign payer or a non-launch program | Working (mock) / unit-tested (pump.fun) | `test/review-ui.test.js`, `test/pumpfun.test.js`, `test/flow.test.js`; not yet seen against a real devnet transaction in a browser |
| Ops | Rate limits, origin checks, redacted structured logs, migrations, daily backups, pauses, caps, dead letters, roles | Working | rate limits are per process: use one web instance (see DEPLOY.md) |

## Still required

Credentials and access:

1. **Devnet SOL for the test wallet** `12MXaessdp9pdJNriYXuiBfZXVNeEZyU1fwPsenWwx6n` (≈0.2 SOL from
   [faucet.solana.com](https://faucet.solana.com); the faucet needs a GitHub sign-in). This unlocks:
   - `npm run lookup-table`;
   - the first real devnet launch (`LAUNCH_PROVIDER=pumpfun npm run demo:flow`).
2. **`LAUNCHPAD_BRAIN_SECRET` on the live SUB-01 server**, plus merging/deploying `feature/launchpad-eval` in
   `nocontentinhere4-art/sub-01`. Until then the launchpad can only talk to a local demo brain.
3. **`APP_ENCRYPTION_KEY`**, generated by you for production.
4. **X developer app**: `X_CLIENT_ID` (and `X_CLIENT_SECRET` for a confidential client), redirect URI
   `https://<launchpad>/api/x/callback`. Posting through the API needs a paid X API tier.
5. **Solana RPC for mainnet**: a provider URL with enough quota (`SOLANA_RPC_URL`). The public endpoint rate-limits.
6. **`ANTHROPIC_API_KEY`**, optional, only if you want AI-written copy instead of the template.

Decisions and approvals:

7. **pump.fun terms §21(c)**: legal review or written confirmation that a launchpad preparing transactions which the
   submitter signs is allowed. Required before mainnet.
8. **Domain and hosting**: `launchpad.subzerone.live` (or similar) + wildcard `*.projects.subzerone.live` with TLS.
9. **`SUB01_FEE_WALLET`**: SUB-01's wallet for the fixed 20% creator-fee share of every project. Until it is set,
   nothing can be approved or launched.
10. **Admin wallets** (`ADMIN_WALLETS`) and reviewers.
11. **Licences**: the SUB-01 brain code has no licence yet. Settle the launchpad's licence too before publishing it.

Development still worth doing:

- Run the devnet launch end to end and record it in TESTING.md (needs item 1).
- Pinata or another IPFS pin for token metadata. Today metadata is served by the app, so the app must stay up for
  indexers.
- Shared rate-limit store (Redis) before running more than one web instance.
- Wallets that only implement `signAndSendTransaction` (not `signTransaction`) are not supported yet.
