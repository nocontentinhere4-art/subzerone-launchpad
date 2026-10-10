# Security

Thank you for looking. This service prepares real, irreversible blockchain transactions for other people to sign, so
reports are taken seriously.

## How to report

Please do **not** open a public issue for a vulnerability.

- Preferred: a private report through GitHub, **Security → Report a vulnerability** on this repository (the owner
  needs to enable "Private vulnerability reporting" in the repository settings; until then, use the address below).
- Email: `security@subzerone.live` *(placeholder: the owner replaces this with the address they monitor)*.

Include what you found, how to reproduce it, and what you think the impact is. You will get an acknowledgement, and
the fix will be credited to you in the commit if you want.

No bug bounty is offered. There is no reward programme, and no payment is promised for any report.

## Scope

In scope (this repository):

- **Wallet authentication**: the sign-in message, nonce lifetime and single use, session cookies, origin checks, rate
  limits, admin and reviewer gating (`src/auth.js`, `src/app.js`).
- **Launch preparation and signing**: the transaction built for the author, the "review before sign" data, the check
  that the signed transaction equals the reviewed message, launch intents and their uniqueness, the locked fee split,
  the dev-buy cap, on-chain verification and the fee ledger (`src/launch.js`, `src/launch/pumpfun.js`).
- **X OAuth**: the PKCE flow, state handling, token encryption at rest, approval-gated posting (`src/x.js`).
- **Project sites**: the sandboxed build, the HTML validator and the per-project origins (`src/site.js`,
  `src/site/render-child.js`).
- **The brain call**: the HMAC-signed request to SUB-01's server and replay handling (`src/brain.js`).
- Anything that lets one wallet act as, or read private data of, another.

Out of scope:

- pump.fun, Solana, wallets, X, DexScreener, Helius and other third parties (report to them).
- The SUB-01 live server and the 3D city client: separate repositories.
- Denial of service by volume alone, and findings that need a compromised server or operator.
- Social engineering of the operator or of users.

## Testing rules

- Test only against your own local instance (`LAUNCH_PROVIDER=mock`, or `pumpfun` on **devnet**).
- Never test against `city.subzerone.live`, `subzerone.live` or a mainnet launch.
- Do not access, change or delete other people's data.
