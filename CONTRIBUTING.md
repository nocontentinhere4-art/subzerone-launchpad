# Contributing

## Run the tests

```bash
npm ci --ignore-scripts
npm test
```

Node ≥ 22.13. The suite (`test/*.test.js`, Node's built-in runner) is offline: no blockchain, no paid API, no secrets.
Tests inject their own `fetch`, a fake brain and the **mock launch provider**, and use a temporary SQLite database
per test. If a change needs the network or a credential to be tested, mock it the same way (`test/helpers.js`,
`test/fixtures/`). CI runs the same command on every push and pull request.

## The mock provider

`LAUNCH_PROVIDER=mock` is the default in `.env.example`. It runs the complete flow (idea, brain vote, build, site,
approvals, review before sign, signature, confirmation, ledger) without touching a chain. Every page and every
generated site says "MOCK launch" when it is used, and production refuses to start with it.

Real launches are tested on **devnet** only (`LAUNCH_PROVIDER=pumpfun SOLANA_NETWORK=devnet`), with a throwaway
wallet from `npm run devnet-wallet`. Never point a development checkout at mainnet.

## Never commit

- `.env` or any file with real values (`.env.example` holds placeholders only).
- `data/` (the database, uploads, backups, the devnet test wallet).
- `city-dist/` (the city client's build) and `node_modules/`.

All of these are in `.gitignore`. Before pushing, look at `git status` and `git diff --cached` once more.

## Style

- Plain Node, no framework, no build step for the backend. ES modules.
- Every behaviour change comes with a test. Security-relevant changes (auth, launch, sites, X) come with a regression
  test for the thing that could go wrong.
- Keep `docs/STATUS.md` honest: "working", "mock-tested" or "blocked", with the evidence.
