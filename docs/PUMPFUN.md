# pump.fun: what was verified, and how the provider uses it

Checked on **2026-10-09** against official sources only:

- `@pump-fun/pump-sdk` **4.0.0** (published 2026-10-08; source read from the package);
- the official docs repo [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) (commit of
  2026-10-08);
- [pump.fun/docs/fees](https://pump.fun/docs/fees) and [pump.fun/docs/terms-and-conditions](https://pump.fun/docs/terms-and-conditions)
  (both "last updated 08 Oct 2026");
- read-only RPC calls on mainnet and devnet.

Re-check before every SDK upgrade and before mainnet.

## Facts the code relies on

| Topic | Verified | Used in |
|---|---|---|
| Creation | `PumpSdk.createV2Instruction({mint, name, symbol, uri, creator, user, mayhemMode})`; signers are the mint keypair and `user` (payer); `create` (v1) is deprecated | `src/launch/pumpfun.js` `buildInstructions` |
| Limits | name ≤ 32, symbol ≤ 13, uri ≤ 200 characters | our limits: name 32, ticker 10, uri checked ≤ 200 |
| Token | `create_v2` → Token-2022 mint, 6 decimals; supply from `Global.tokenTotalSupply` (read on devnet: 1,000,000,000.000000) | `chainParams()` reads Global; verification checks Token-2022, decimals, no mint/freeze authority |
| Metadata | no documented official upload endpoint (`pump.fun/api/ipfs` is **unofficial**) | metadata JSON and image are served, frozen, by this app at `/meta/<slug>/<hash>.json` |
| Fee rates | dynamic: `FeeConfig` PDA (pump-fees) + `Global`, tiered by market cap; `computeFeesBps(...)` | read at preparation and shown with source; never hardcoded (devnet, fresh curve, 2026-10-09: protocol 95 bps, creator 30 bps) |
| Fee sharing | pump-fees program `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`. `createFeeSharingConfig` makes the per-mint `sharing-config` PDA the coin creator. `updateFeeSharesV2` sets ≤ 10 shareholders totalling 10,000 bps, **once**, and revokes the admin | `mode: 'sharing_config'`; we cap recipients at 8 (see size below) |
| Irreversibility | after `update_fee_shares_v2`, the split can't be changed by the creator. pump.fun's `admin_cto` (takeover authority) can still rewrite or terminate any coin's config | shown in the irreversible box before signing |
| After graduation | the pool's `coin_creator` also points to the sharing config, so the split keeps applying on PumpSwap | ledger reads the per-mint vault |
| Payouts | `distribute_creator_fees(_v2)` is permissionless; the event `DistributeCreatorFeesEvent` carries the shareholders and the amount | `readFees()` parses these events from finalized transactions of the sharing-config account |
| Devnet | pump, pump-fees and PumpSwap are deployed on devnet at the same program IDs (checked with `getAccountInfo`) | default network is devnet |
| API | no official REST API for creation; on-chain programs only | only the SDK and RPC are used |

## Transaction size

`create_v2 + createFeeSharingConfig + updateFeeSharesV2`, measured with the real SDK:

| | without a lookup table | with the launch lookup table (16 static accounts) |
|---|---|---|
| 2 shareholders | 1360 bytes (over the 1232 limit) | 960 bytes |
| 5 shareholders | over | 1063 bytes |
| 10 shareholders | over | 1233 bytes (1 byte over) |

So:

- **Single recipient = the signer**: `mode: 'direct'`. Creation only, ~860 bytes, no lookup table needed. The creator
  vault is the signer's own and covers all coins that wallet created; the ledger says so.
- **Anything else**: `mode: 'sharing_config'`. Needs `LAUNCH_LOOKUP_TABLE` (create it once with
  `npm run lookup-table`) and at most 8 recipients.
- **Not yet verified on-chain**: creation and fee sharing together in one transaction. It isn't documented. The SDK
  builds it and simulation is the next check. **Test it on devnet before relying on it** (see STATUS).

### Two-step launch (default since 2026-10-15, `LAUNCH_SPLIT_TX=1`)

Phantom showed "This dApp could be malicious" on the single creation transaction (create + fee-sharing config +
shares, a second signer). The launch is now two signatures; `LAUNCH_SPLIT_TX=0` restores the single transaction below
without a code change (read when the transaction is built; launches already split keep their step 2).

| | contents | signers | measured |
|---|---|---|---|
| tx1 | `create_v2` only | the author first, then the mint key (server, after the wallet) | 584 bytes (devnet and mainnet sim) |
| tx2 | `sweep_creator_fee`, `create_fee_sharing_config`, `update_fee_shares_v2` (+ ATA + `buy_v2` when the total stays <= 1232 - 150) | the author alone | 714 (80/20), 748 (gen 1), 783 (gen 2); with the buy 977 / 1011 / 1046 |

- Between the two, the curve's creator is the author's wallet: trades in that window put creator fees on the curve,
  and `update_fee_shares_v2` / `create_fee_sharing_config` fail with 6095 `CreatorFeesNotSwept` until they are swept
  (mainnet simulation 2026-10-15 on a live coin with 0.478 SOL on its curve: without the sweep 6095, with it ok). The
  permissionless `sweep_creator_fee` (creator = the author) therefore always comes first; it pays those fees into the
  author's own creator vault and is harmless when the bucket is empty.
- The project is `launched` after tx1 (the coin exists) but `launches.split_state = 'pending'`: the PC, the coin site,
  the city and the fee ledger say "Coin created · fee split not locked yet" and never call the split locked; the
  allocation row stays `approved`; a child coin is signed into its parent's registry only after the lock.
- tx2 (`/launch/split/transaction|refresh|signed|abandon`, coin sites `/_api/launch/:id/split/*`): built after tx1 is
  verified, fresh blockhash; the shares are re-derived server side (the allocation row, SUB-01 >= 20%, the family rule
  for a family coin) and checked again in the signed bytes (`checkSignedShares`, exactly the fee instructions + the
  buy, one signer). The buy's creator is the sharing-config PDA. A buy that does not fit becomes tx3 (the dev-buy step,
  allowed only once the split is locked); `separateBuy: true` locks the split alone.
- `split_recheck` (hourly, worker): a sharing config found on chain with exactly the approved shares and the admin
  revoked -> `locked` (idempotent); other shares or not revoked -> `mismatch`, an `ALERT` audit row, never retried by
  itself (`POST /api/admin/projects/:slug/reverify` reads it again); nothing on chain -> a reminder note every 6 hours.
- Fee reader: before the lock the author's own creator vault (scope: all its coins), after it the project vault.
- Devnet run 2026-10-15 (local instance, the test wallet signing programmatically): tx1 `iTtUgRvf…fCC2`, tx2
  `3UdaaQck…LErxPP` (split 80/20 + 0.01 SOL dev buy in one signature), sharing config `4KZwxhTb…rkCkW` holds exactly
  the shares, admin revoked; transcripts `docs/demo/flow-pumpfun-split-2026-10-15T15-06-09.json` and, with a sniper buying between tx1 and tx2, `…T15-06-58.json` (tx2 `yb6BJPTN…dGky`).

### With the dev buy: two Phantom-safe transactions

Phantom cannot simulate a pump.fun create whose program event authorities come from an address lookup table and
shows "This dApp could be malicious". Every transaction handed to the wallet is therefore in the **Phantom-safe
layout**: the pump and pump-fees event authorities are written into the message as static keys (`phantomSafeTables`,
+62 bytes). Phantom also appends its own instructions when it signs (Lighthouse balance assertions, a compute-budget
priority fee), which need room in the packet.

In that layout `create_v2 + fee split + ATA + buy_v2` measures 1231-1259 bytes, so the author's optional dev buy
(`initialBuyLamports`, 0.001-5 SOL) is its **own second transaction**:

| | contents | signers | layout | measured (devnet 2026-10-12) |
|---|---|---|---|---|
| tx1 (step 1) | `create_v2`, `create_fee_sharing_config`, `update_fee_shares_v2` | the author, then the mint key (server) | lookup table, both event authorities static | 973-979 bytes |
| tx2 (step 2) | the author's Token-2022 ATA (idempotent), `buy_v2` | the author alone | **no lookup table**: every account static | 1033 bytes |

The decision is made when the configuration is prepared (`launchConfig.devBuyMode`, `launch.js devBuyModeFor`): the
buy stays inside tx1 (`same_tx`) only if the Phantom-safe transaction would leave `WALLET_HEADROOM_BYTES` (150) for
the wallet's guards, which no real name fits today; otherwise `second_tx`. A buy is never compiled into the compact
layout any more (without a buy the compact layout remains the fallback for a split too large for the safe one).

Step by step (`src/launch.js`, `src/launch/pumpfun.js`):

1. **tx1** is reviewed, signed and verified exactly as a launch without a buy. Its estimate carries the buy that
   follows, quoted at a fresh curve (`estimate.devBuy`), and the balance check counts it. Once tx1 is finalized and
   verified the project is **launched** with `launches.dev_buy_status = 'pending'`: "launched" never waits for the buy.
2. `POST /api/projects/:slug/launch/devbuy/transaction` builds **tx2** fresh: `getBuyTokenAmountFromSolAmount` on the
   **live** curve (a sniper may have bought between the two), `amount` = those tokens, `max_sol_cost` = their real cost
   (`getBuySolAmountFromTokenAmount`, fees included) + 5%, `creator` = the curve's creator (the sharing-config PDA).
   The 0.001 SOL minimum, the balance check and a clean simulation are required; every simulation is logged
   (`dev buy simulation`). A dev buy that would complete the curve, a curve not visible yet or already complete are
   coded `409`s.
3. `…/devbuy/refresh` right before the wallet opens: the **same** tokens and cap with a fresh blockhash (the review stays
   true). If the price moved past the cap meanwhile the simulation fails, the attempt is cancelled and the author reads
   why.
4. `…/devbuy/signed`: the signed bytes must be the reviewed tx2, or the same with Phantom's Lighthouse / compute-budget
   instructions added (`sameLaunch`), paid and signed by the author **alone** (`numRequiredSignatures === 1`). Then
   broadcast; `confirm_dev_buy` follows it.
5. Verification (`verifyDevBuy`): finalized and successful, the author is the payer, the author's Token-2022 account
   for the mint **gained exactly the reviewed tokens** (meta pre/post token balances; `buy_v2` with `partial_fill` off
   is exact-out), and the SOL the buy took (balance change − network fee − what funded accounts the transaction
   created) is within the signed cap. On devnet the first trade also funds the project's creator vault (679,870
   lamports), which is why created accounts are excluded; the program itself enforces `max_sol_cost`.
6. If tx2 fails (on-chain, preflight, or "the price moved more than 5% first", pump error 6002 `TooMuchSolRequired`)
   nothing is bought but the network fee: `dev_buy_status = 'failed'` and the author may try again at the new price or
   skip. `…/devbuy/abandon` cancels a waiting one; `…/devbuy/skip` is final. Before a new tx2 is built, earlier
   cancelled/expired ones must be provably dead (`devBuyLandCheck`: blockhash window passed, and no successful
   transaction of the author put exactly that many tokens in their account); a landed one is verified instead.
   A tx2 that landed but failed verification blocks retries until an admin re-verifies it
   (`POST /api/admin/projects/:slug/reverify`).

Devnet run (2026-10-12, `scripts/demo-flow.js` with `DEMO_INITIAL_BUY_SOL=0.01`): mint
`Dr1iFW8SaPS9yXWsoFDM2Z98aaepf7FTK1Zdzd94Ure2`, tx1 979 bytes, tx2 1033 bytes (no lookup table), 10,493,886.257633
tokens received exactly as reviewed, the buy took 0.00997037 SOL (cap 0.0105).

Tables created before the dev buy existed still work: tx2 uses no table, and tx1 without the buy only needs the
creation and fee-sharing accounts. `MAX_INITIAL_BUY_SOL` caps the buy (default 5, never more).

## Terms of service: needs a decision before mainnet

pump.fun's terms (§21(c)) forbid executing transactions "on behalf of" other persons without pump.fun's written
agreement. They also allow automated tools only "as we expressly permit", and §4.6 forbids misrepresenting
creator-fee settings.

In this design the launchpad only prepares the transaction. The **submitter's own wallet** reviews it and signs it as
payer and creator. That may or may not count as "on behalf of". **Get legal review or
written confirmation from pump.fun before any mainnet launch.**

Restricted jurisdictions (including the UK and sanctioned regions) and the 18+ requirement also apply to users.

## Program IDs

- pump (bonding curve): `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- pump-fees: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
- PumpSwap AMM: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

## Review before sign

`POST /api/projects/:slug/launch/transaction` (owner only) returns, next to the transaction, what the wallet will
show, read from the compiled message itself (`reviewOfMessage` in `src/launch/pumpfun.js`; the same on a resumed
request; example values):

```json
{ "network": "devnet", "feePayer": "<your wallet>", "mint": "<new mint>",
  "programs": [ { "id": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "name": "pump.fun (bonding curve)", "direct": true },
                { "id": "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", "name": "pump.fun fee sharing", "direct": true } ],
  "accountsWritable": 9, "signers": 2, "launchProgramsOnly": true, "estimate": { "…": "…" } }
```

- `direct: true`: a program the transaction calls. `direct: false`: a known program passed to one of them as an
  account (it runs inside it). Program ids are always static keys in a v0 message; accounts loaded from the lookup
  table are counted in `accountsWritable`, not named.
- `launchProgramsOnly`: every directly called program is pump, pump-fees, Compute Budget or the Associated Token
  Account program (the dev buy's token account). Only then does the review
  box say what the transaction does NOT do (no approvals, no token transfers from the wallet, no buy in step 1; SOL
  only for the network fee and rent); otherwise it warns and the Sign button stays disabled, as it does when `feePayer` is
  not the signed-in wallet. Mock provider: `programs: [{ "id": "MockLaunch", "name": "MockLaunch", "direct": true }]`,
  `accountsWritable: 0`, `signers: 1`.
- The box (`public/js/review.js`) lists network, fee payer, new mint, programs, writable accounts, estimated cost and
  the locked fee split (recipients with bps) before the Sign button; `test/review-ui.test.js` renders it.

