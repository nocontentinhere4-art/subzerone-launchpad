# Deployment

The launchpad is one Node process for the web and one or more worker processes, sharing a SQLite database on a
persistent volume. It fits the SUB-01 setup (Railway + a custom domain) and needs no other services.

## 1. The brain side (SUB-01 repo)

1. Merge `feature/launchpad-eval` in `nocontentinhere4-art/sub-01`. It adds `launchpad_eval.py`, one route and
   its tests. The route is off until a secret is set.
2. Set `LAUNCHPAD_BRAIN_SECRET` on the live server (Railway variable). Use the same value on the launchpad. Generate it
   with `openssl rand -hex 32`.
3. Check it: `POST https://subzerone.live/api/launchpad/evaluate` without a signature must answer `401`, and `503`
   while the secret is unset.

The endpoint never runs a language model. It clones the live brain, votes, and stores each answer per `request_id`
(`data/launchpad_evals.jsonl`), so retries never vote twice.

## 2. The launchpad service (Railway)

- **Source**: this repo. Start command `npm start`. Add a second service (same repo, same volume) with `npm run worker`.
- **Volume**: mounted at `/data`, with `DATA_DIR=/data`. It holds the database, uploads and backups.
- **Node**: ≥ 22.13 (`engines` in package.json). Install with `npm ci --ignore-scripts`. The pump SDK's optional native
  `bigint` binding falls back to pure JS.
- **Instances**: one web instance (rate limits are in-memory) and one or more workers (leases make that safe).
- **Environment** (see `.env.example`):

```
DEPLOY_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_ORIGIN=https://launchpad.subzerone.live
PROJECTS_HOST=projects.subzerone.live
PROJECTS_SCHEME=https
TRUST_PROXY=1
DATA_DIR=/data
APP_ENCRYPTION_KEY=<openssl rand -base64 32>
ADMIN_WALLETS=<your wallet>
SUB01_FEE_WALLET=<SUB-01's own wallet: receives 20% of every project's creator fees>
CITY_DIST=/app/city/dist        # optional: the city client's build, served at / (see below)
BRAIN_URL=https://subzerone.live
LAUNCHPAD_BRAIN_SECRET=<same as on SUB-01>
LAUNCH_PROVIDER=none            # until the devnet run and the ToS question are done; then pumpfun
SOLANA_NETWORK=devnet           # mainnet-beta only after STATUS.md "Still required" is cleared
SOLANA_RPC_URL=<provider URL>
LAUNCH_LOOKUP_TABLE=<from npm run lookup-table on that network>
```

Production refuses to start with the mock provider, without `APP_ENCRYPTION_KEY`, or without an https origin.
Without `SUB01_FEE_WALLET` the service starts, but every approval, launch preparation and signature request is refused
with `409 sub01_wallet_missing`: the 80/20 split is mandatory and is never replaced by 100% to anyone. Because every
split now has two recipients, every pump.fun launch uses the on-chain fee-sharing config, so `LAUNCH_LOOKUP_TABLE` is
required for any real launch.

### City client on the same origin (`CITY_DIST`)

The 3D city (separate Vite/three.js repo `sub01-launchpad`) can be served by this service, so it calls `/api/*`
same-origin with the session cookie and no CORS:

1. In the city repo: `npm ci && npm run build` (output `dist/`, with `index.html` and `assets/`). Vite's default
   `base: '/'` is what this expects.
2. Copy or mount that `dist/` next to the service and set `CITY_DIST` to its **absolute** path.
3. Effect: `GET /` serves `CITY_DIST/index.html` (`no-cache`); `GET /assets/*` serves files under `CITY_DIST/assets`
   only (path-normalised; `..`, encoded `..%2f` and NUL are refused with 404), with `cache-control: public,
   max-age=31536000, immutable` (Vite file names are content-hashed). MIME types include `.gltf model/gltf+json`,
   `.glb model/gltf-binary`, `.bin application/octet-stream`, `.png`, `.js`, `.css`. The launchpad's own home page
   moves to `/launchpad`; its header gets a "city" link back to `/`. Without `CITY_DIST` nothing changes.
4. CSP: for the desk computer (CITY-API.md, "Desk computer") the app CSP now frames project sites
   (`frame-src 'self' <room origin> <PROJECTS_SCHEME>://*.<PROJECTS_HOST>`) and allows same-origin framing
   (`frame-ancestors 'self'`); project sites allow `<PUBLIC_ORIGIN>` as frame ancestor. Set `PROJECTS_SCHEME=https` in
   production so `siteUrl` and `frame-src` are https. Otherwise no change was needed: the current build (checked 2026-10-09) loads one same-origin module script and
   stylesheet, fetches only `/api/*` and `/assets/*`, uses canvas/WebGL, and its only `data:`/`blob:` use is images
   (three.js feature probes, GLB textures), which `img-src 'self' data: blob:` already allows. It uses no workers,
   `eval`, external fonts or data-URI buffers. If a later build adds Draco/KTX2 decoders (blob workers) or
   data-URI glTF buffers, it will need `worker-src blob:` / `connect-src data:`: re-check before deploying.

## 3. Domains

- `launchpad.subzerone.live` → the web service.
- Wildcard `*.projects.subzerone.live` → the **same** web service. The app routes by `Host`, so each project gets its
  own origin and can never read launchpad cookies.
  - Railway supports wildcard custom domains: add `*.projects.subzerone.live` as a custom domain and create the CNAME
    record it shows.
  - Behind Cloudflare: proxied wildcard records work on all plans for DNS. Edge certificates for a second-level
    wildcard (`*.projects.…`) need Advanced Certificate Manager. Otherwise use DNS-only (grey cloud) and let Railway
    issue the certificate.
- Token metadata is served at `https://launchpad.subzerone.live/meta/...`. Keep this URL stable: it is written into
  every token at launch.

## 4. X developer app

Create an app in the X developer portal:

- OAuth 2.0;
- type "Web App" (confidential) or "Native" (public);
- callback `https://launchpad.subzerone.live/api/x/callback`;
- scopes `tweet.read tweet.write users.read offline.access`.

Set `X_CLIENT_ID` (+ `X_CLIENT_SECRET` for a confidential client) and `X_REDIRECT_URI`. Posting needs an X API tier
that allows `POST /2/tweets`.

## 5. Operations

- **Migrations**: applied automatically at start (`schema_migrations` table). Manually: `npm run migrate`.
- **Backups**: the worker writes `VACUUM INTO /data/backups/launchpad-<time>.db` every `BACKUP_EVERY_HOURS` and keeps
  `BACKUP_KEEP`. You can also back up from admin, or with `npm run backup`. Copy them off the volume regularly (Railway
  volume backups or a cron to object storage).
- **Restore**: stop both services, replace `/data/launchpad.db` with a backup (delete `-wal`/`-shm`), start.
- **Monitoring**:
  - `GET /healthz` for the uptime check.
  - Logs are JSON lines (`level`, `msg`, `reqId`), with secrets, tokens, signatures and cookies redacted by key.
  - Watch for `job not done` warnings and dead jobs in admin.
- **Emergency**: admin → pause `launch`, `generation`, `deployment`, `evaluation`, `submissions` or `x_publishing`.
  Pausing `launch` stops new transactions immediately. Transactions already signed keep being confirmed (they can't be
  recalled).
- **Budgets**: admin → global daily USD cap and per-project cap. They count only generation spend (the template
  generator costs $0). Network fees are paid by the submitter's wallet, never by the platform.

- **Support** (`src/support.js`, migration 022): the city's Help button and launch errors post reports to
  `POST /api/support` (signed in or anonymous; 5 an hour per IP and per wallet, 100 an hour in all). The owner reads and
  answers them on `/admin#support`. Optional variables:
  - `SUPPORT_OPERATOR_TOKEN` (24+ characters, `openssl rand -hex 32`): turns on the AI operator's API, with
    `Authorization: Bearer <token>` (no cookie, no Origin needed). Unset, these routes answer 404.
    - `GET /api/support/inbox?since=<unix ms | ISO>&status=open,in_progress&category=launch&limit=100` → `{tickets, counts,
      open, now}`; pass the previous `now` as the next `since` to get only what changed. Each ticket: `id, status,
      category, source, message, contact, wallet, projectSlug, redacted, createdAt, updatedAt, clientContext,
      serverContext (launch intents, dev-buy attempts, failing jobs from the database), replies[]`.
    - `GET /api/support/:id`, `POST /api/support/:id/reply {text, status?}` (default status `answered`),
      `POST /api/support/:id/status {status}` with `open | in_progress | answered | closed`.
    - Every staff reply reaches the author as "SUBZERONE support" on the city's "My reports".
  - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`: a short ping per new report (category, first 200 characters, a link to
    `/admin#support`). Fire and forget; the token is never logged.

## 6. Going to mainnet (checklist)

1. A devnet launch, recorded end to end (`LAUNCH_PROVIDER=pumpfun SOLANA_NETWORK=devnet npm run demo:flow`), including
   a two-recipient split with the lookup table.
2. pump.fun ToS §21(c): legal review or written confirmation.
3. A mainnet lookup table: `SOLANA_NETWORK=mainnet-beta SOLANA_RPC_URL=… npm run lookup-table -- --keypair <operator file>`.
4. The reviewer clearance flow staffed (`REQUIRE_ADMIN_CLEARANCE=1`).
5. Switch `SOLANA_NETWORK=mainnet-beta`, then re-read the banner, the token page and the fee methodology.
