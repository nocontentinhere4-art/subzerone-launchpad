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
- `launchProgramsOnly`: every directly called program is pump, pump-fees or Compute Budget. Only then does the review
  box say what the transaction does NOT do (no approvals, no token transfers from the wallet, no initial buy; SOL only
  for the network fee and rent); otherwise it warns and the Sign button stays disabled, as it does when `feePayer` is
  not the signed-in wallet. Mock provider: `programs: [{ "id": "MockLaunch", "name": "MockLaunch", "direct": true }]`,
  `accountsWritable: 0`, `signers: 1`.
- The box (`public/js/review.js`) lists network, fee payer, new mint, programs, writable accounts, estimated cost and
  the locked fee split (recipients with bps) before the Sign button; `test/review-ui.test.js` renders it.

