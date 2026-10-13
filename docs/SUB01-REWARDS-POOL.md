# SUB-01 funded claim pool

Status: implemented and locally tested; **not deployed or funded**. No mainnet transaction has been sent. Complete finalized holder snapshots and verified fee attribution are required before funding. The API refuses claims without the reviewed program, a published allocation and a fully funded escrow.

## Adopted policy

- Existing SUB-01 mint only: `6WCtKQfkWurd77tCCAYWuL5TwyAvuovTzworfnfupump`.
- Effective October 14, 2026 in Europe/Rome; cutoff is `2026-10-13T22:00:00Z`.
- Funding/publishing wallet: `HMPUiULXumamWDhuoKap6ty2hQ7V7GQwi8PZ7pGx6STQ`.
- Daily periods are fixed 24-hour intervals anchored at the cutoff. They do not change length at daylight-saving transitions; the UI displays dates in Europe/Rome.
- Eligible holders receive 20% proportionally to eligible token balances at one fixed finalized snapshot. Liquidity pools and project wallets are excluded. The funding wallet is always excluded; all other exclusions must be declared in each public manifest.
- 30% is a buyback-and-burn SOL budget; 50% funds the project. Buying or burning is a separate owner treasury action, not performed by this contract or API.
- The owner approved a **one-SOL initial budget**, overriding the earlier proposed 0.2972-SOL seed. It provides 0.2 SOL to the bootstrap holder escrow, earmarks 0.3 SOL for buyback/burn, and leaves 0.5 SOL for the project. The rest of the wallet is outside that allocation. The seed is a discretionary initial contribution, not a claim that one SOL of new creator rewards was generated today.
- A separate bootstrap epoch, ID `100000`, permits an initial allocation before the first daily close. Its snapshot is a complete current holder snapshot taken after the cutoff; funding must be exactly the holder portion of the approved one-SOL initial budget. Daily epoch 0 is the first full 24-hour period.

## On-chain enforcement

The native Solana program is in `programs/sub01-rewards/`. A publish instruction requires the specified funding wallet's signature, locks one Merkle root for the epoch, and transfers exactly 20% of the supplied funding basis into an epoch PDA. A daily root cannot be published before that period closes. Bootstrap publication takes an explicit snapshot end at or after the cutoff and no later than the chain clock.

A claim requires the recipient's signature and a domain-separated SHA-256 Merkle proof binding program ID, mint, epoch, wallet and amount. SOL is paid only to that wallet. A permanent per-wallet bitmap blocks repeat claims. The initial distribution shares the first bitmap page with the first 255 daily periods, so it does not require a second claim-record deposit. Prefunding a PDA with unsolicited SOL cannot prevent its initialization.

The program has no root replacement, escrow withdrawal or claim-record close instruction. Rent reserves are preserved. Claimants pay network fees and, when a bitmap page is first created, its rent deposit. This deposit is not refundable in this version; the dashboard reviews gross reward, fee, deposit and net effect before signing. Some small rewards may cost more to claim than they pay.

An upgrade authority can change program code, including these guarantees. The public pool reports that authority. The backend pins the deployed bytecode hash and length and checks them before claims; this is an identity check, not an independent security audit. Removing an upgrade authority is irreversible and is not done by this change.

## What the public proof does and does not establish

On-chain state establishes the funded amount, immutable root under the current code, and claimed status. Public manifests allow anyone to reproduce the allocation, rounding and Merkle tree. The contract does **not** independently verify snapshot completeness or fee attribution. Those come from the publisher’s independently auditable snapshot and fee evidence.

Before funding, obtain a complete finalized holder snapshot, aggregate every token account by owner, and verify liquidity/project exclusions. A largest-holder list is insufficient. Supply `snapshotSlot` (positive safe integer), `snapshotAt` (integer milliseconds at or after the period close, no later than publication), and the complete snapshot/fee evidence SHA-256 digest. Entries’ `weight` values are raw token balance units (unsigned 64-bit), not holding time. Make evidence independently available: a digest alone does not prove completeness. Freeze each allocation; transfers after the snapshot do not alter rewards or permit repeat claims. Published allocations remain claimable on later days. Daily accounting, snapshot collection, publication and funding are still operator steps, not an active scheduler.

Only new creator rewards attributable to this mint are eligible in daily periods. Do not count old unclaimed fees as new income when collected, or count seed funding again as daily income. A shared creator vault may include several mints, so vault balance alone does not prove SUB-01 revenue.

## Backend API

- `GET /api/rewards/pool`: public policy, funding wallet balance, upgrade authority and last 30 verified funded epochs. Errors clear live totals.
- `GET /api/rewards/me`: authenticated wallet's gross published allocation, claimed amount, available amount and individual proofs. Unpublished/current-period accrual is not presented as claimable.
- `GET /api/rewards/epochs/:epoch`: immutable canonical manifest and SHA-256 digest. It intentionally publishes allocation wallet addresses, separate from the city world snapshot's privacy rules.
- `POST /api/rewards/epochs`: funding wallet's authenticated session registers the indexer's input only after the on-chain epoch matches and is funded. Different content cannot overwrite an existing manifest.
- `POST /api/rewards/claims/prepare`: builds one exact claim, verifies funding/history, checks available fee/deposit balance and simulates it.
- `POST /api/rewards/claims/submit`: verifies the signed message exactly matches the reviewed intent and session wallet before broadcasting. Retry is idempotent; it never signs on the server.
- `GET /api/rewards/claims/:intent`: private submission/finalization status. Finalized bitmap state is the source of paid/available amounts, including direct claims made outside this UI.

Authentication and same-origin rules reuse the existing wallet nonce/signature flow. Rate limits are separate for reads, publication and claims. The server never stores the funding wallet's or claimant's private key.

## Configuration and activation

Development defaults to devnet with the feature disabled. Never point a development checkout at mainnet. Production requires explicit settings:

```text
SUB01_REWARDS_PROGRAM_ID=<deployed program>
SUB01_REWARDS_NETWORK=<devnet or mainnet-beta>
SUB01_REWARDS_RPC_URL=<dedicated HTTPS RPC endpoint>
SUB01_REWARDS_PROGRAM_SHA256=<reviewed SBF binary SHA-256>
SUB01_REWARDS_PROGRAM_BYTES=<exact binary byte length>
```

1. Build the reviewed binary with Solana's SBF tools; test it on the local bank and then devnet. Retain the program account keypair privately; it is not a treasury wallet.
2. Deploy through an owner-authorized signing flow, verify program ID and bytecode hash, and decide the upgrade-authority policy. Reserve deployment rent and network costs separately from holder/buyback funds; temporary deployment buffers may require additional peak liquidity.
3. Connect the complete finalized holder snapshot source and verify exclusions. Produce the bootstrap input with `snapshotSlot`, `snapshotAt` at or after its end, `snapshotEnd` in integer milliseconds, `creatorRewardsLamports: "1000000000"`, and `epochId: 100000`. This field is the funding basis for bootstrap, not new fee income.
4. `node scripts/rewards-prepare.js --input verified-weights.json --output funding-plan.json` prepares the manifest and instruction offline. Optional `--rpc <devnet HTTPS endpoint>` adds an unsigned, simulated funding transaction. This helper checks arithmetic, not the truth of the indexer history. Nothing is signed or sent.
5. Review the exact escrow, root, period, funding basis and 0.2-SOL deposit; sign funding with the specified wallet. Wait for finalization, then register the same input using its authenticated session.
6. Configure the production API, deploy the client/backend together, and verify a small eligible claim. New daily allocations require complete finalized evidence and fresh funding; there is no scheduler/indexer falsely claiming to do this automatically.
7. Execute the separate 0.3-SOL buyback-and-burn budget only through a reviewed quote and owner signature. Store actual acquisition and burn transaction evidence before displaying a completed burn.

No mainnet deploy, funding, buyback, burn, fee collection or authority change is part of the completed local checks.

## Validation

- Backend regression suite and reward tests cover auth isolation, funded-state verification, exact allocation, immutable manifests, proof binding, cutoff/bootstrap bounds, bitmap identity and signed-message tampering.
- Native bank tests exercise publication, funding, claims, unauthorized recipients, root replacement and replay; bootstrap shares the original bitmap without another rent deposit.
- `cargo test ... deployed_binary_claim_smoke -- --ignored` with `BPF_OUT_DIR` checks the compiled SBF bytecode's payout and double-claim rejection in Solana's local bank.
- Client tests independently verify proofs and actual unsigned transaction bytes, rejecting hidden transfers, altered amounts and unsafe explorer links. Browser checks exercise the review screen with isolated fixtures; fixture funds are never production data.

## Offline snapshot review

`node scripts/rewards-snapshot.js --input finalized-rpc-export.json --exclusions exclusion-reasons.json --output snapshot-review.json` validates token account mint/program/state, aggregates balances by owner and records the evidence digest and finalized slot/block time. Input contains `mint`, `tokenProgram`, `commitment: "finalized"`, `snapshotAt` from the snapshot slot’s block time, and the full `getProgramAccounts` RPC `response` with context. Exclusions contain public `{wallet, reason}` objects. Unknown program-derived owners are reported as unresolved instead of silently being allocated or excluded. Do not fund until these custody accounts and project-wallet exclusions are resolved. This offline helper never signs or sends transactions. A provider response must still be complete; the local parser cannot prove completeness from account data alone.
