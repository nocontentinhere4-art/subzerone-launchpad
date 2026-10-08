# Tests and demonstrations (2026-10-09)

## Automated

`npm test`: **58 passed, 0 failed**. Offline; no blockchain, no paid API. Plus the brain side, in the SUB-01 repo:
`python -m pytest tests/test_launchpad_eval.py` gives **5 passed**.

| Failure case asked for | Tests |
|---|---|
| Expired or replayed authentication | replayed nonce refused · expired nonce refused · failed attempt burns the nonce · signature over another message refused · invalid wallet refused |
| Brain service offline | stays `evaluating` with "nothing decided", no substitute decider, dead after the bounded retries · brain not configured · brain asleep: queued, decided after waking |
| Generation failure | bounded retries (3), then `failed` with the reason |
| Unsafe generated code | generator output with markup or financial promises is rejected · hostile text escaped · the validator rejects scripts, handlers, foreign links, `url()`, unquoted URLs, inline styles · the build process has no environment, can't read or write files or spawn processes · build killed at its time limit |
| Duplicate job delivery | same key = one job; re-running handlers changes nothing · crashed worker: expired lease requeued, finishes once |
| Launch tx rejected / expired / confirmed after a timeout | wallet rejects → back to `launch_prepared` · rejected on-chain → back with the reason · never landed → `expired` after the blockhash window · confirm job gave up → the sweep finds it and it becomes `launched` |
| Duplicate launch attempts | a second transaction request resumes the same transaction (still one intent); a second signed submit is refused; a launched project can't prepare another (unique live-intent index + state checks) |
| Incorrect fee recipients | wrong submitter wallet, totals ≠ 100%, undisclosed platform rows and duplicates refused · stale approval statement refused · on-chain recipients ≠ approved → not launched, no relaunch until resolved |
| Indexing delays and fee reconciliation | unknown (not zero) before the first read · payouts appear later · re-reading the same transactions never double counts · a direct-mode vault isn't attributed to one project |
| Also | complete MOCK flow over HTTP · cross-site writes refused · private ideas hidden · security headers · admin gated · pause blocks launches · budget cap · daily submission cap · X: account only "connected" when X reports it, posts need approval and publish once · pump.fun: signed tx must equal the reviewed one |

## Independent review (2026-10-09) and fixes

A separate review pass over the launch, auth, privacy, XSS and job code found 9 defects. All are fixed, and each one
has a regression test:

| # | Finding | Fix |
|---|---|---|
| 1 | any broadcast error (timeout, 429) was treated as "rejected", allowing a second mint while the first could still land | only a failed preflight simulation is a rejection; otherwise the intent stays `submitted` and the confirmation job decides |
| 2 | cancelling a signature request didn't stop a signed copy from landing later | a new transaction waits until every earlier one is provably dead (blockhash expired and no mint); a late-landed one is found by its mint and verified instead |
| 3 | RPC lag at verification turned a real launch into a permanent failure | a missing account or transaction means retry, not fail; admin "re-verify on-chain" action |
| 4 | reviewer clearance survived later edits; reviewers could clear their own project | every change resets both approvals; self-clearance refused |
| 5 | the live site version could change after approval | allowed only while previewing or after launch; `prepare_launch` re-checks both approvals |
| 6 | "expired" was declared on a lagging node's evidence | `finalized` height past the window **and** no mint account |
| 7 | an idea could go private mid-launch | locked public from `approved`; checked again when the transaction is built |
| 8 | draft preview versions and private logos were reachable | non-owners get the live version only; logos need a public idea |
| 9 | the validator rejected harmless words in attribute text; refusals returned 500 | attribute values are checked as URLs only; refusals return 400 |

Also from this pass: the generated site of a mock launch now says "MOCK launch: rehearsal only, no blockchain, no token
exists", and status chips say "MOCK launch · no blockchain" or "verified on <network>".

## Demonstrated end to end (local)

Two runs, both against the running stack: launchpad + worker + **the real SUB-01 live server in demo mode** with
`feature/launchpad-eval`.

1. `npm run demo:flow`, transcript in `docs/demo/flow-mock-2026-10-08T23-17-27.json`:
   - idea submitted privately;
   - **brain vote: build 98.5% vs pass 1.5%** ("reward and attention areas responded most", rate model, demo brain);
   - template identity, art, site v1, X drafts, 100% split;
   - published, approved, reviewer cleared;
   - launch configuration: supply 1B, 6 decimals, initial buy 0;
   - MOCK transaction signed by the test wallet;
   - mock confirmation, verification checks passed, `launched`;
   - ledger shows no invented fees.
   - After the review fixes, the same flow was re-run: `docs/demo/flow-mock-2026-10-08T23-34-24.json`, "Midnight Melon
     Bread Club". Build 98.6% ("reward areas responded most"), through to a MOCK launch.
2. A run where **he passed**: `docs/demo/flow-mock-2026-10-08T23-32-37.json`, "Rooftop Pigeon Census". Build got
   3.8% vs pass 96.2% ("it moved the threat area least"). The idea was declined, and nothing else was asked to decide.
   The same session also showed the duplicate rule, the per-wallet daily cap and the sign-in rate limit stopping repeat
   runs, as designed.
3. **In the browser**, with a throwaway dev wallet (`scripts/test-wallet-inject.js`, Wallet Standard, localhost only):
   - sign-in by signed message;
   - submit through the form;
   - brain vote build 99%;
   - review page: site editor, versions, X drafts with the manual-creation step, split edited to 80/20, which switches
     to "on-chain split, locked at launch";
   - publish, approve with the exact statement, admin clearance;
   - launch review panel with every required field and the irreversible-settings box.

What wasn't demonstrated, and why: a **devnet transaction**. Both devnet faucets (`api.devnet.solana.com` and Helius
devnet) answered 429 / internal error for the whole session. The provider did build the devnet transaction with the
official SDK and read live parameters from devnet:

- supply 1,000,000,000.000000;
- Token-2022;
- fee schedule at a fresh curve: protocol 95 bps, creator 30 bps.

Simulation stopped at `AccountNotFound` (unfunded payer). With ≈0.2 devnet SOL in the test wallet, run:

```bash
npm run lookup-table
LAUNCH_PROVIDER=pumpfun SOLANA_NETWORK=devnet LAUNCH_LOOKUP_TABLE=<printed> npm run dev   # in one terminal
LAUNCH_PROVIDER=pumpfun npm run demo:flow                                                   # in another
```
