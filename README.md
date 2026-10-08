# SUBZERONE launchpad

**You drop an idea. SUB-01 becomes your dev.**

A visitor submits an idea. SUB-01's brain simulation votes on whether to build it. If it says yes, the launchpad:

- writes the project identity;
- draws the art from SUB-01's brain record;
- builds and hosts a static website;
- drafts the X presence;
- prepares a token launch.

The submitter reviews all of it, approves a disclosed creator-fee split, and signs the launch with their own wallet. Launches and fees appear only once they are verified on-chain.

> **Status: planned feature, preview.** Ideas, the brain vote, building, hosting, approvals and the whole launch flow
> work end to end locally, with the clearly labelled MOCK launch provider. A real launch (devnet first) still needs the
> items in [docs/STATUS.md](docs/STATUS.md#still-required). Nothing here should be described as live until that list is
> done.

## Run it locally

You need Node ≥ 22.13 (built-in SQLite, no native modules). For the real brain vote you also need a checkout of the
SUB-01 repo with branch `feature/launchpad-eval`.

```bash
npm install --ignore-scripts
cp .env.example .env          # then set LAUNCHPAD_BRAIN_SECRET and APP_ENCRYPTION_KEY (see the file)
npm test                      # 48 tests, offline
npm run dev                   # web on http://localhost:8787 + one worker
```

The brain is optional. Without it, ideas wait in "evaluating" and say why.

```bash
SUB01_DIR=../sub01-main sh scripts/brain-demo.sh   # SUB-01 live server, demo mode, port 8769, same secret as .env
```

Watch the whole flow run against the running stack (test wallets, MOCK provider):

```bash
npm run demo:flow
```

Generated sites are served on `http://<slug>.projects.localhost:8787/`. `*.localhost` resolves to 127.0.0.1 in modern
browsers.

## How it fits together

```
browser (no build step)          web process (src/server.js)                worker (src/worker.js)
public/js/*  ── JSON API ──▶     src/app.js routes, auth, rate limits  ──▶  durable job queue (SQLite)
Wallet Standard:                 SQLite (node:sqlite, WAL)                   evaluate ─▶ generate ─▶ prepare_launch
signMessage / signTransaction                                                 confirm_launch ─▶ reconcile_fees
                                                                              publish_x_post
                 SUB-01 live server ◀── HMAC-signed POST /api/launchpad/evaluate (brain vote on a cloned live brain)
                 Solana RPC + @pump-fun/pump-sdk (official, on-chain only)   sandboxed site build (child process)
```

| Path | What |
|---|---|
| `src/app.js` | every HTTP route: public API, owner and admin actions, project sites by Host, token metadata |
| `src/auth.js` | wallet sign-in: single-use expiring nonce, ed25519 check, hashed session tokens |
| `src/ideas.js` | validation, versions (v1 kept as submitted), uploads (byte-sniffed images only), publish/private |
| `src/states.js` | the state machine: `submitted → evaluating → selected/declined → generating → preview_ready → approved → launch_prepared → awaiting_signature → confirming → launched`, plus `failed`, `cancelled` |
| `src/jobs.js` | durable queue: idempotency keys, leases, bounded backoff, dead letters, time limits |
| `src/pipeline.js` | the stage handlers |
| `src/brain.js`, `src/scorecard.js` | brain adapter; scorecard v1 (three rules + one simulation term) |
| `src/generator.js`, `src/art.js` | identity as validated data (template, or a language model if enabled); logo PNG and banner SVG drawn from the brain record |
| `src/site.js`, `src/site/render-child.js` | sandboxed static build, HTML safety validator, versions, rollback |
| `src/launch.js`, `src/launch/*.js` | fee allocation, launch intents, signing, broadcast, on-chain verification, fee ledger; providers `mock` and `pumpfun` |
| `src/x.js` | X OAuth 2.0 PKCE, drafts, approval-gated publishing |
| `src/market.js` | SUB-01 market data (DexScreener + Solana RPC) with source and timestamp |
| `migrations/` | schema (numbered SQL files, applied at start or with `npm run migrate`) |

## What SUB-01's simulation does, and what it doesn't

- **The simulation decides whether to build.** In the SUB-01 repo, `launchpad_eval.py` routes the idea's words to brain
  networks with the same hand-written lexicon as his chat. It then runs the ordinary brain vote (`brain_vote.vote`:
  cloned live brain, "build" vs "pass", softmax) and returns the full record: options, probabilities, responses, which
  network answered, and his sleep stage and mood.
  - Asleep (NREM/REM): the idea waits.
  - Brain unreachable: the idea waits, with a note saying that nothing has been decided.
  - No other system ever decides in its place.
- **Rules only gate.** Ideas are declined before the brain is asked if they:
  - promise returns, yield or holder rewards;
  - contain slurs or harmful content;
  - claim an endorsement;
  - are unreadable;
  - duplicate an earlier idea.
- **Words and art.** A fixed template (default, no AI) or a language model (`GENERATOR=anthropic`) writes names, copy and
  X drafts as JSON. The result is schema-checked and never contains markup. The art comes from a fixed program that
  reads the brain record. Every page says which writer was used.

## Security model (short)

- **Sign-in and sessions.**
  - Sign-in is a signed text message: no transaction, no funds.
  - Nonces are single-use and expire after 5 minutes; a nonce is burned on the first attempt.
  - Sessions are random tokens, stored hashed, in an HttpOnly SameSite cookie.
- **Requests.**
  - Every non-GET request must carry our own `Origin`.
  - Per-IP and per-wallet token-bucket rate limits.
  - Per-wallet daily submission cap.
- **Submissions.**
  - Links are stored as text and never fetched by the server, so there is no server-side URL fetching at all.
  - Uploads are accepted only if their bytes are PNG, JPEG, GIF or WebP; SVG is refused. They are served with
    `sandbox` CSP and `nosniff`.
- **Generated sites.**
  - Built from data by our own template.
  - The build runs in a child process with Node's permission model: no file writes or reads beyond its own script, no
    child processes, an empty environment, a 64 MB heap, a 5 s limit and an output cap.
  - The output is validated: no scripts, event handlers, forms, foreign URLs or CSS `url()`.
  - Each site is served on its own subdomain with `default-src 'none'`.
- **Launches and keys.**
  - The submitter's wallet signs launches.
  - The server never holds a key that can move funds. The per-launch mint key signs once and is discarded.
  - The signed transaction must hash to exactly the reviewed message, or it is refused.
  - A launch intent is persisted before signing. At most one live intent per project (unique index).
  - A project is "launched" only after finalized on-chain checks pass.
- **Secrets.**
  - Server-side only.
  - Logs are structured JSON with sensitive keys redacted.
  - X tokens are encrypted with AES-256-GCM.
- **Operations.**
  - Admin roles (`admin`, `reviewer`).
  - Emergency pauses for submissions, evaluation, generation, deployment, launch and X publishing.
  - Per-project and global daily spending caps.
  - Dead-letter queue with requeue.
  - Daily `VACUUM INTO` backups.

## Docs

- [docs/STATUS.md](docs/STATUS.md): feature status (working / tested with mocks / blocked) and the precise list of
  credentials and approvals still required
- [docs/PUMPFUN.md](docs/PUMPFUN.md): what was verified about pump.fun on 2026-10-09, with sources, and how the provider
  uses it
- [docs/DEPLOY.md](docs/DEPLOY.md): deployment (Railway + Cloudflare), environment, backups, operations
- [docs/TESTING.md](docs/TESTING.md): test results and the demonstrated end-to-end flow

SUB-01 is a model of brain activity built from public MRI data, not a mind. Tokens launched here are separate from
SUB-01's own token (`6WCtKQfkWurd77tCCAYWuL5TwyAvuovTzworfnfupump`), and using the launchpad gives SUB-01 holders
nothing. Nothing here is financial advice.
