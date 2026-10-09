# City API (contract for the city client)

The 3D city (`sub01-launchpad`, Vite/three.js) talks to this service. Code: `src/world.js` (plots, residents, rooms,
world snapshot), `src/roles.js` (roles, takeovers), routes in `src/app.js`. Tests: `test/city.test.js`.

## Conventions

- JSON in and out. Times are unix **milliseconds**.
- Writes (`POST`/`PUT`) need the session cookie from wallet sign-in (`POST /api/auth/nonce` → sign → `POST
  /api/auth/verify`) and an `Origin` header equal to the service's `PUBLIC_ORIGIN`. Serve the city from the same origin
  (`CITY_DIST`, see DEPLOY.md) and the browser does both for you.
- Errors: `{ "error": "<code>", "message": "<human sentence>" }` with an HTTP status. Codes used here:
  `400 bad_plot | bad_name | bad_look | bad_room | bad_wallet | bad_role | bad_reason | bad_request`,
  `401 sign_in`, `403 forbidden | not_founder | founder_active`, `404 not_found | no_role`,
  `409 plot_taken | no_resident | not_launched | already_founder | takeover_open | not_open`, `429 rate_limited`.
- Rate limits: the same per-IP/per-wallet token buckets as every other route (reads 400/min, writes 60/min).
- **Wallets never appear in `/api/world` or `/api/rooms/*`.** Role listings show wallets shortened to `first4…last4`.

## Plots

144 plot ids: `` `${district}-${n}` `` with `n` 1..6 and district in this order:
`shiba, shinjuku, akihabara, shibuya, harajuku, nakameguro, ebisu, roppongi, ginza, asakusa, ueno, ikebukuro, nakano,
kanda, tsukiji, odaiba, yoyogi, meguro, shinagawa, sumida, daikanyama, nihonbashi, koenji, shimokitazawa`.

A plot is claimed once, first come first served, as either:

- `apartment`: a resident's home. One per wallet. Moving releases the old one.
- `project`: reserved when an idea is submitted with `plotId` (one plot per idea, in the same transaction as the idea:
  if the plot is taken, no idea is created). Released automatically when the idea ends `declined` or `cancelled`
  (not on `failed`, which an admin can retry).

Concurrent claims of the same plot: exactly one succeeds, the others get `409 plot_taken` (database primary key inside
a transaction). A plot not listed in `/api/world` is free.

## GET /api/world/options

Public, `cache-control: public, max-age=3600`.

```json
{
  "districts": ["shiba", "shinjuku", "…24 names"],
  "plotsPerDistrict": 6,
  "plotIds": ["shiba-1", "shiba-2", "…144 ids"],
  "look": {
    "skin": ["#f6d5b8", "#e8b48f", "#c98e66", "#a26a45", "#7a4a2e", "#4f3020"],
    "hair": ["#1b1b1b", "#3b2a20", "#6b4428", "#a87443", "#d9b26f", "#b23a2e", "#e8e8e8", "#4a6cd4"],
    "hairStyle": ["short", "long", "bun", "buzz", "curly"],
    "outfit": ["hoodie", "jacket", "tee", "suit"],
    "freeColors": ["top", "bottom"],
    "colorPattern": "^#[0-9a-f]{6}$"
  },
  "name": { "min": 2, "max": 24 },
  "room": {
    "floor": ["white_oak", "honey_oak", "walnut", "smoked_oak", "concrete", "tatami"],
    "walls": ["chalk", "sand", "sage", "navy", "terracotta", "concrete"],
    "accent": ["navy", "linen", "rust", "olive", "charcoal", "blush"],
    "lighting": ["morning", "midday", "evening", "night"],
    "items": ["bed", "desk", "chair", "couch", "shelf", "lamp", "plant", "rug", "table"],
    "rot": [0, 90, 180, 270],
    "coord": [-3.5, 3.5],
    "maxFurniture": 24,
    "default": { "…": "DEFAULT_ROOM, see Rooms" }
  },
  "progress": { "submitted": 0.05, "evaluating": 0.12, "selected": 0.2, "generating": 0.45, "preview_ready": 0.65,
    "approved": 0.75, "launch_prepared": 0.82, "awaiting_signature": 0.88, "confirming": 0.94, "launched": 1,
    "failed": 0, "declined": 0, "cancelled": 0 }
}
```

## Look (character)

```json
{ "skin": "<one of look.skin>", "hair": "<one of look.hair>", "hairStyle": "short|long|bun|buzz|curly",
  "top": "#rrggbb", "bottom": "#rrggbb", "outfit": "hoodie|jacket|tee|suit" }
```

All six fields are required; unknown fields are refused (`400 bad_look`). Hex colours are stored lowercase.
Name: 2–24 characters, letters (any script), digits, spaces and `. _ ' -`; whitespace is collapsed.

## POST /api/residents (auth)

Create or update the caller's own resident.

Request: `{ "name": "Kenji", "look": { …look }, "plotId": "shiba-1" }`

- First call: `plotId` required (the apartment).
- Later calls: `plotId` optional; omitted or equal = keep the apartment; a different free plot = move (old one
  released). Name and look are replaced on every call.

Response `200`:

```json
{
  "resident": { "name": "Kenji", "look": { "skin": "#c98e66", "hair": "#1b1b1b", "hairStyle": "bun", "top": "#ff6600",
    "bottom": "#222222", "outfit": "hoodie" }, "plotId": "shiba-1", "room": { …room }, "createdAt": 1760000000000,
    "updatedAt": 1760000000000 },
  "plots": [ { "plotId": "shiba-1", "kind": "apartment", "ideaId": null, "claimedAt": 1760000000000 } ]
}
```

Moving in and moving out are public news items (`"Kenji moved into shiba-1"`, `"Kenji moved to ginza-2"`).

## GET /api/me — additions

Unchanged fields (`user`, `ideas`, `fees`) plus:

```json
{
  "resident": { "name": "…", "look": { … }, "plotId": "shiba-1", "room": { … }, "createdAt": 0, "updatedAt": 0 } | null,
  "plots": [ { "plotId": "shiba-1", "kind": "apartment", "ideaId": null, "claimedAt": 0 },
             { "plotId": "ginza-3", "kind": "project", "ideaId": "idea_…", "claimedAt": 0 } ],
  "projectRoles": [ { "slug": "ramen-radar", "role": "founder" } ]
}
```

Signed out: `{ "user": null }` as before.

## POST /api/ideas — addition

Optional `"plotId": "ginza-3"` in the existing submission body. Validated (`400 bad_plot`) and reserved atomically
with the idea (`409 plot_taken`, and then no idea is created). Omitted = the idea has no building yet.

## GET /api/world

Public, `cache-control: public, max-age=3`. The server rebuilds the snapshot at most every 3 s (and after any write it
receives). Poll every 3–5 s.

```json
{
  "now": 1760000000000,
  "sub01": { "state": "idle|working|asleep|offline", "ideaId": "idea_…|null", "plotId": "ginza-3|null",
             "stage": "generating|null", "text": "Building Ramen Radar (building)" },
  "plots": [
    { "plotId": "shiba-1", "kind": "apartment", "resident": { "name": "Kenji", "look": { … } }, "project": null },
    { "plotId": "ginza-3", "kind": "project", "resident": null,
      "project": { "slug": "ramen-radar|null", "name": "Ramen Radar", "ticker": "RAMEN|null", "stage": "preview_ready",
                   "stageLabel": "Preview ready for your review", "progress": 0.65, "launched": false, "mint": null } }
  ],
  "news": [ { "at": 1760000000000, "text": "Ramen Radar: Launched — verified on devnet", "plotId": "ginza-3|null",
              "kind": "status|resident|role|takeover|approval|clearance|site|generation|edit|visibility|progress|x" } ]
}
```

- `plots` lists **claimed** plots only, oldest claim first.
- `project` for an idea that is still **private**: `{ "slug": null, "name": "Private project", "ticker": null,
  "stage", "stageLabel", "progress", "launched": false, "mint": null }`. Nothing else about it is exposed.
- Public idea: `name` is the project name (or the idea title before the project exists); `ticker` is the project's
  (or the suggested one); `slug` is null until SUB-01 has built it (`/projects/<slug>` on the launchpad).
- `mint` is set only when `launched` is true.
- `progress` follows `/api/world/options.progress`; while `generating`, the job's step refines it
  (0.5 writing the identity, 0.58 building the site).
- `sub01.state`: `working` = a pipeline job is running right now (then `ideaId` is null if that idea is private, and
  the text says "a private project"); else `asleep` / `offline` from the brain's last answer in the past 30 minutes
  (no live probe), `offline` also when the brain is not configured; else `idle`. `text` is a short sentence for a
  speech bubble: `Thinking about X`, `Building X`, `Preparing the launch of X`, `Watching the launch of X`, …
  followed by a stage word in brackets.
- `news`: the last 20 **public** events, never from a private idea. Any address-like string in a text is shortened to
  `first4…last4`.

## Rooms

```json
{
  "materials": { "floor": "<room.floor>", "walls": "<room.walls>", "accent": "<room.accent>" },
  "lighting": "morning|midday|evening|night",
  "furniture": [ { "item": "<room.items>", "x": -3.5..3.5, "z": -3.5..3.5, "rot": 0|90|180|270 } ]
}
```

Strict: unknown fields anywhere are refused, at most 24 furniture entries, `x`/`z` are numbers (metres from the room
centre, rounded to 0.01). A resident without a saved room gets `DEFAULT_ROOM`:

```json
{ "materials": { "floor": "honey_oak", "walls": "chalk", "accent": "navy" }, "lighting": "evening",
  "furniture": [ { "item": "bed", "x": -2.5, "z": -2.5, "rot": 0 }, { "item": "desk", "x": 2.5, "z": -3, "rot": 0 },
    { "item": "chair", "x": 2.5, "z": -2, "rot": 180 }, { "item": "couch", "x": -2.5, "z": 2.5, "rot": 90 },
    { "item": "shelf", "x": 3.2, "z": 1, "rot": 270 }, { "item": "lamp", "x": 3, "z": 3, "rot": 0 },
    { "item": "plant", "x": -3.2, "z": 0, "rot": 0 }, { "item": "rug", "x": 0, "z": 0, "rot": 0 } ] }
```

### GET /api/rooms/:plotId

Public. `200 { "plotId": "shiba-1", "kind": "apartment|project", "owner": { "name": "Kenji", "look": { … } },
"room": { … } }`.
For an apartment: its resident. For a project plot: the room of the idea submitter's resident, only once the idea is
**public** and only if the submitter has a resident. Otherwise `404` (free plot, private idea, no resident);
`400 bad_plot` for an unknown id.

### PUT /api/rooms/me (auth)

Request `{ "room": { … } }` → `200 { "room": { …as stored } }`. `409 no_resident` until `POST /api/residents`.

## Creator fees (what the city should say)

Every project: **80%** of creator fees to the idea submitter's receiving wallet (the submitter may share part of it
with collaborators), **20%** to SUB-01 (`SUB01_FEE_WALLET`). Fixed and mandatory, approved by the submitter, written
on-chain and locked when the token is created. `GET /api/config` has
`sub01Share: { label: "SUB-01", bps: 2000, wallet, configured }`.

## Roles and community takeover

Roles per project: `founder` (exactly one; the submitter when SUB-01 builds the project), `community_lead`,
`moderator`. Roles are about running the community. **They never change fee recipients.**

### GET /api/projects/:slug/roles

Public for public projects (`404` for private ones).

```json
{
  "roles": [ { "wallet": "AbCd…WxYz", "role": "founder", "grantedAt": 0 } ],
  "you": "founder|community_lead|moderator|null",
  "openTakeover": { "id": "tko_…", "requester": "EfGh…1234", "reason": "…", "createdAt": 0 } | null,
  "feeRecipients": [ { "label": "Idea submitter", "role": "submitter", "wallet": "<full>", "bps": 8000 },
                     { "label": "SUB-01", "role": "sub01", "wallet": "<full>", "bps": 2000 } ],
  "feeNote": "A takeover never changes fee recipients: they were locked on-chain when the token was created. Creator fees keep going to: …"
}
```

`feeRecipients` are the recipients locked at launch (empty before launch). Full addresses there are deliberate: they
are public on-chain and on the project page.

### POST /api/projects/:slug/roles (auth, founder only)

`{ "wallet": "<address>", "role": "community_lead|moderator" }` grants or changes a role; `"role": null` revokes it.
The founder cannot give themselves another role and cannot grant `founder`. Response: the same body as the GET.
Each change is a public news item.

### POST /api/projects/:slug/takeover (auth)

`{ "reason": "1–500 characters" }`. Only for **launched** projects (`409 not_launched`), not by the founder
(`409 already_founder`), at most one open request per project (`409 takeover_open`).
Response: `{ "id": "tko_…", "status": "open", "feeRecipients": [ … ], "feeNote": "…" }`.

### POST /api/takeover/:id/decide (auth)

`{ "approve": true|false }`.

- The current **founder** can decide.
- An **admin** can decide only when the founder has had **no audited activity for 30 days** (no event authored by the
  founder's wallet, sign-ins included, and the founder role itself granted more than 30 days ago);
  otherwise `403 founder_active`.
- Anyone else: `403`.

Approving moves the founder role to the requester; the old founder keeps no role (any role the requester had is
replaced by `founder`). The decision is a public event that restates that fee recipients are unchanged.
Response: `{ "id", "status": "approved|rejected", "founder": "AbCd…WxYz", "feeRecipients": [ … ], "feeNote": "…" }`.

### POST /api/takeover/:id/withdraw (auth, requester only)

→ `{ "id", "status": "withdrawn", "feeRecipients", "feeNote" }`.

**A takeover never changes who receives creator fees.** The recipients were written on-chain and locked when the token
was created; nobody (the founder, the new founder, SUBZERONE) can change them. Every takeover response carries the
current `feeRecipients` and this sentence in `feeNote`.

## Hosting the city on the same origin

Set `CITY_DIST` to the absolute path of the city's `dist/`. Then `/` is the city, `/assets/*` its files (immutable
cache), and the launchpad's home page is `/launchpad` (all other launchpad pages keep their paths). Details and the CSP
check: DEPLOY.md, "City client on the same origin".
