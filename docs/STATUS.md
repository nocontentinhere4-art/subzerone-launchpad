# Feature status (2026-10-09)

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
| | Admin dashboard (pauses, budgets, disclosed platform share, clearance, failed ideas, dead letters, intents, roles, bans, backup, audit) | Working | |
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
| Sites | Sandboxed build, validator, versions, rollback, isolated subdomains with a no-script CSP | Working | locally on `*.projects.localhost` |
| | Public hosting on `<slug>.projects.subzerone.live` | Blocked | needs DNS wildcard + TLS (see DEPLOY.md) |
| X | Planned handle, bio, drafts; manual account creation step; OAuth 2.0 PKCE connect; approval-gated posting | Mock-tested | needs an X developer app (`X_CLIENT_ID`, redirect URI). Posting needs a paid X API tier. Bio/avatar must be set by hand |
| Launch | Launch intent → signature → broadcast → finalized → on-chain verification → launched | Mock-tested | full flow with the MOCK provider, in a browser and with `npm run demo:flow` |
| | Pump.fun provider (official SDK 4.0.0): devnet parameters read, transaction built, fee schedule read on-chain | Working up to the signature | transaction built against devnet (860 bytes, direct mode); simulation stops at `AccountNotFound` because the payer has 0 SOL. **No devnet transaction landed yet**: both devnet faucets were rate-limited |
| | Create + locked multi-recipient split in one transaction | Blocked | needs a lookup table (`npm run lookup-table`, needs devnet SOL) and one devnet run to verify |
| | Mainnet | Blocked | ToS §21(c) review / written OK from pump.fun, a funded devnet run, an RPC provider, the domain |
| Fees | Ledger: verified undistributed (vault read), confirmed payouts (distribution events), per-recipient estimates, no double counting | Mock-tested | logic tested with a fake chain; real reads only after a real launch |
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
9. **Platform share**: none by default. If SUBZERONE ever takes one, it must be set in admin, where it is disclosed on
   every page and in every split.
10. **Admin wallets** (`ADMIN_WALLETS`) and reviewers.
11. **Licences**: the SUB-01 brain code has no licence yet. Settle the launchpad's licence too before publishing it.

Development still worth doing:

- Run the devnet launch end to end and record it in TESTING.md (needs item 1).
- Pinata or another IPFS pin for token metadata. Today metadata is served by the app, so the app must stay up for
  indexers.
- Shared rate-limit store (Redis) before running more than one web instance.
- Wallets that only implement `signAndSendTransaction` (not `signTransaction`) are not supported yet.
