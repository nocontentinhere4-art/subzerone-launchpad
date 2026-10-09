# City API (contract for the city client)

The 3D city (`sub01-launchpad`, Vite/three.js) talks to this service. Code: `src/world.js` (plots, residents, rooms,
world snapshot, look v2 and traits, unlocks, guestbooks, city events), `src/roles.js` (roles, takeovers), routes in
`src/app.js`. Tests: `test/city.test.js`, `test/custom.test.js`, `test/desk.test.js`.

## Conventions

- JSON in and out. Times are unix **milliseconds**.
- Writes (`POST`/`PUT`/`DELETE`) need the session cookie from wallet sign-in (`POST /api/auth/nonce` → sign → `POST
  /api/auth/verify`) and an `Origin` header equal to the service's `PUBLIC_ORIGIN`. Serve the city from the same origin
  (`CITY_DIST`, see DEPLOY.md) and the browser does both for you.
- Errors: `{ "error": "<code>", "message": "<human sentence>" }` with an HTTP status. Codes used here:
  `400 bad_plot | bad_name | bad_look | bad_traits | bad_room | bad_text | bad_wallet | bad_role | bad_reason | bad_request`,
  `401 sign_in`, `403 forbidden | locked | own_room | not_founder | founder_active`, `404 not_found | no_role`,
  `409 plot_taken | no_resident | not_launched | already_founder | takeover_open | not_open`, `429 rate_limited`.
- `403 locked` carries the names that are not unlocked yet: `{ "error": "locked", "message": "…", "locked": ["halo", "dragon"] }`.
- `429 rate_limited` carries `retryAfterS` (seconds).
- Rate limits: the same per-IP/per-wallet token buckets as every other route (reads 400/min, writes 60/min).
- **Wallets never appear in `/api/world` or `/api/rooms/*`** (the `desk` included). Role listings show wallets shortened to `first4…last4`.

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
    "colorPattern": "^#[0-9a-f]{6}$",
    "accessories": ["glasses", "sunglasses", "cap", "beanie", "headphones", "backpack", "scarf", "mask", "halo", "crown",
      "cat_ears", "antenna", "wings", "jetpack"],
    "maxAccessories": 4,
    "pets": ["cat", "dog", "robot", "duck", "slime", "dragon"],
    "petName": { "min": 1, "max": 12 }
  },
  "traits": { "keys": ["neat", "outgoing", "active", "playful", "nice"], "range": [0, 1],
    "default": { "neat": 0.5, "outgoing": 0.5, "active": 0.5, "playful": 0.5, "nice": 0.5 } },
  "name": { "min": 2, "max": 24 },
  "room": {
    "floor": ["white_oak", "honey_oak", "walnut", "smoked_oak", "concrete", "tatami", "birch", "cherry", "herringbone",
      "black_ash", "tatami_green", "tile_white", "tile_slate", "tile_terracotta"],
    "walls": ["chalk", "sand", "sage", "navy", "terracotta", "concrete", "cream", "blush", "sky", "forest"],
    "accent": ["navy", "linen", "rust", "olive", "charcoal", "blush", "denim", "sakura", "mustard", "teal"],
    "window": ["city_day", "city_night", "sakura", "rain"],
    "lighting": ["morning", "midday", "evening", "night"],
    "daylight": [0, 1],
    "catalog": { "sleep": ["bedSingle", "…"], "work": […], "sit": […], "storage": […], "kitchen": […], "light": […],
      "plants": […], "decor": […], "structure": ["wallWindow", "wallWindowSlide", "doorway", "doorwayFront"],
      "special": ["skateboard", "plushPile", "posterCustom", "neonSign", "consoleTv", "arcadeCabinet", "karaokeMic",
        "discoBall", "turntable", "aquarium", "trophyIdea", "trophySite", "neonTicker", "trophyLaunch", "fireworksBox",
        "goldToilet"] },
    "items": ["…all 73 catalog names (57 Kenney + 16 special), flat…"],
    "wallItems": ["wallWindow", "wallWindowSlide", "doorway", "doorwayFront", "lampWall"],
    "wallSides": ["left", "back"],
    "rot": [0, 90, 180, 270],
    "coord": [-3.5, 3.5],
    "y": [0, 2.5],
    "maxFurniture": 40,
    "textItems": ["posterCustom", "neonTicker"],
    "textMax": 12,
    "default": { "…": "DEFAULT_ROOM, see Rooms" }
  },
  "progress": { "submitted": 0.05, "evaluating": 0.12, "selected": 0.2, "generating": 0.45, "preview_ready": 0.65,
    "approved": 0.75, "launch_prepared": 0.82, "awaiting_signature": 0.88, "confirming": 0.94, "launched": 1,
    "failed": 0, "declined": 0, "cancelled": 0 },
  "unlocks": {
    "tiers": ["resident", "builder", "founder", "launched"],
    "items": { "resident": ["skateboard", "plushPile", "posterCustom", "neonSign"],
               "builder": ["consoleTv", "arcadeCabinet", "karaokeMic", "discoBall"],
               "founder": ["turntable", "aquarium", "trophyIdea", "trophySite"],
               "launched": ["neonTicker", "trophyLaunch", "fireworksBox", "goldToilet"] },
    "emotes": { "resident": ["wave", "sit", "think", "sleep", "dance"], "builder": ["facepalm", "cook", "selfie"],
                "founder": ["karaoke", "skate"], "launched": ["celebrate", "moonwalk"] },
    "accessories": { "resident": ["glasses", "sunglasses", "cap", "beanie", "headphones", "backpack", "scarf", "mask"],
                     "builder": ["cat_ears", "antenna"], "founder": ["halo", "wings"], "launched": ["crown", "jetpack"] },
    "pets": { "resident": ["cat", "dog", "duck"], "builder": ["slime", "robot"], "founder": [], "launched": ["dragon"] }
  },
  "guestbook": { "max": 80, "keep": 50, "perPlotSeconds": 60, "perDay": 20 }
}
```

`unlocks.*.<tier>` lists only what that tier **adds**; a tier includes everything from the tiers before it (see Unlocks).

## Look (character)

Look v2:

```json
{ "skin": "<one of look.skin>", "hair": "<one of look.hair>", "hairStyle": "short|long|bun|buzz|curly",
  "top": "#rrggbb", "bottom": "#rrggbb", "outfit": "hoodie|jacket|tee|suit",
  "accessories": ["glasses", "cap"], "accessoryColor": "#rrggbb" | null,
  "pet": { "kind": "cat|dog|robot|duck|slime|dragon", "color": "#rrggbb", "name": "Mochi" } | null }
```

- The six v1 fields are required. `accessories` (default `[]`): 0–4 **different** names from `look.accessories`.
  `accessoryColor` (default `null`): one colour for all accessories. `pet` (default `null`): exactly
  `{kind, color, name}`; `name` 1–12 characters, cleaned like a resident name.
- Unknown fields anywhere are refused (`400 bad_look`). Hex colours are stored lowercase.
- Accessories and pets must be unlocked (`403 locked`, see Unlocks).
- **Reads always return all nine fields**: a look saved before v2 comes back with `accessories: []`,
  `accessoryColor: null`, `pet: null`.

Name: 2–24 characters, letters (any script), digits, spaces and `. _ ' -`; whitespace is collapsed.

## Traits (personality)

```json
{ "neat": 0.5, "outgoing": 0.9, "active": 0.5, "playful": 0.33, "nice": 0.5 }
```

Each 0..1, rounded to 0.01. Only these five keys (`400 bad_traits` for any other, or for a value that is not a number in
range); a missing key is `0.5`. Traits are **public**: they drive the resident's autonomy that everyone sees, and appear
wherever the look does. Reads always return all five (`0.5` each for residents who never set them).

## POST /api/residents (auth)

Create or update the caller's own resident.

Request: `{ "name": "Kenji", "look": { …look v2 }, "traits": { …traits }, "plotId": "shiba-1" }`

- First call: `plotId` required (the apartment).
- Later calls: `plotId` optional; omitted or equal = keep the apartment; a different free plot = move (old one
  released). Name and look are replaced on every call.
- `traits` optional: omitted = keep the current ones (`0.5` each for a new resident); given = all five replaced
  (missing keys `0.5`).
- Validation order: `400` (name, look, traits, plot), then `403 locked` (accessories/pet not unlocked; a wallet
  creating its resident already counts as tier `resident`), then `409 plot_taken`. Nothing is saved on an error.

Response `200`:

```json
{
  "resident": { "name": "Kenji", "look": { "skin": "#c98e66", "hair": "#1b1b1b", "hairStyle": "bun", "top": "#ff6600",
    "bottom": "#222222", "outfit": "hoodie", "accessories": ["headphones"], "accessoryColor": null,
    "pet": { "kind": "duck", "color": "#ffee00", "name": "Ahiru" } },
    "traits": { "neat": 0.5, "outgoing": 0.9, "active": 0.5, "playful": 0.5, "nice": 0.5 },
    "plotId": "shiba-1", "room": { …room }, "createdAt": 1760000000000, "updatedAt": 1760000000000 },
  "plots": [ { "plotId": "shiba-1", "kind": "apartment", "ideaId": null, "claimedAt": 1760000000000 } ]
}
```

Moving in and moving out are public news items (`"Kenji moved into shiba-1"`, `"Kenji moved to ginza-2"`).

## GET /api/me — additions

Unchanged fields (`user`, `ideas`, `fees`) plus:

```json
{
  "resident": { "name": "…", "look": { …look v2 }, "traits": { …traits }, "plotId": "shiba-1", "room": { … },
                "createdAt": 0, "updatedAt": 0 } | null,
  "plots": [ { "plotId": "shiba-1", "kind": "apartment", "ideaId": null, "claimedAt": 0 },
             { "plotId": "ginza-3", "kind": "project", "ideaId": "idea_…", "claimedAt": 0 } ],
  "projectRoles": [ { "slug": "ramen-radar", "role": "founder" } ],
  "unlocks": { "tier": "builder",
               "items": ["skateboard", "plushPile", "posterCustom", "neonSign", "consoleTv", "arcadeCabinet", "karaokeMic", "discoBall"],
               "emotes": ["wave", "sit", "think", "sleep", "dance", "facepalm", "cook", "selfie"],
               "accessories": ["glasses", "sunglasses", "cap", "beanie", "headphones", "backpack", "scarf", "mask", "cat_ears", "antenna"],
               "pets": ["cat", "dog", "duck", "slime", "robot"] }
}
```

`unlocks` is cumulative (everything up to `tier`, in catalog order) and counts **all** the wallet's ideas, private
ones included (it is the wallet's own view). See Unlocks.

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
    { "plotId": "shiba-1", "kind": "apartment", "resident": { "name": "Kenji", "look": { …look v2 }, "traits": { …traits } },
      "project": null },
    { "plotId": "ginza-3", "kind": "project", "resident": null,
      "project": { "slug": "ramen-radar|null", "name": "Ramen Radar", "ticker": "RAMEN|null", "stage": "preview_ready",
                   "stageLabel": "Preview ready for your review", "progress": 0.65, "launched": false, "mint": null } }
  ],
  "news": [ { "at": 1760000000000, "text": "Ramen Radar: Launched — verified on devnet", "plotId": "ginza-3|null",
              "kind": "status|resident|role|takeover|approval|clearance|site|generation|edit|visibility|progress|x" } ],
  "events": [ { "kind": "accepted|site_live|launched", "plotId": "ginza-3|null", "name": "Ramen Radar", "ticker": "RAMEN|null",
                "at": 1760000000000 } ]
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
- `events`: what the city celebrates (fireworks, street parties on the building). From the status history: an idea
  reaching `selected` → `accepted`, `preview_ready` (the site is built) → `site_live`, `launched` → `launched`. Only the
  **first** time an idea reaches each (a regeneration does not repeat `site_live`), only in the **last 24 hours**,
  newest first, at most **30**, and only for ideas that are **public now** (a private idea never appears; one published
  later shows its events of the last 24 h). `name`/`ticker` follow the same rules as `project` (current project name
  or idea title; project ticker or the suggested one). `plotId` is null when the idea has no building.

## Rooms

Schema v2. Furniture is the [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) (CC0) by model name; the
city loads `/assets/room/<item>.glb` and scales the whole kit by one factor (a door is 1.95 m, a person 1.5 m).

```json
{
  "materials": { "floor": "<room.floor>", "walls": "<room.walls>", "accent": "<room.accent>" },
  "lighting": "morning|midday|evening|night",
  "daylight": 0.42,
  "window": "city_day|city_night|sakura|rain",
  "furniture": [ { "item": "<room.items>", "x": -3.5..3.5, "z": -3.5..3.5, "rot": 0|90|180|270, "y": 0..2.5, "wall": "left|back" } ]
}
```

- The room is a 7 × 7 m cutaway: the **left** wall is the plane x = −3.5, the **back** wall z = −3.5; x/z are metres
  from the room centre (rounded to 0.01), the piece's footprint centre. Kenney pieces face +z at `rot: 0`.
- `y` (optional): lift above the floor, e.g. a monitor on a desk (`y` = the desk's height). `0` is not stored.
- `wall` is **required** for `room.wallItems` (windows, doors, wall lamp) and **refused** for everything else.
- `accent` tints Kenney's upholstery (`carpet` materials: bedding, sofas, cushions, rugs, the gaming chair).
- `daylight` (optional, 0 = morning … 1 = night): the editor's slider through the four presets; `lighting` stays the
  nearest preset so older clients still read something sensible. `window` defaults to `city_day`.
- Strict: unknown fields anywhere are refused, at most 40 entries, `400 bad_room` with a message.
- `room.catalog.special` items are placed like any piece (`{item, x, z, rot, y?}`, never `wall`) but must be
  unlocked: saving a room with a locked one is `403 locked` with `locked: [names]` (see Unlocks).
- `text` (optional) only on `room.textItems`, refused elsewhere: at most 12 characters after cleaning (NFKC, control
  and bidi characters, `<`, `>` and backticks removed, whitespace collapsed; an empty result is not stored).
  - `posterCustom`: free text.
  - `neonTicker`: uppercased and must equal the ticker of one of **your own public** projects (`400 bad_room`, the
    message lists yours). Omitted = your first launched project's ticker. A private ticker is refused, so a room never
    shows one; if a project is made private later, `GET /api/rooms/:plotId` drops the neonTicker showing its ticker
    (your own `/api/me` still has it).

**Backward compatibility.** v1 rooms used generic names. They are still accepted on save and every stored room is
read through `upgradeRoom()`, so old rows come back as v2: `bed→bedSingle`, `desk→desk`, `chair→chairDesk`,
`couch→loungeSofa`, `shelf→bookcaseOpen`, `lamp→lampRoundFloor`, `plant→pottedPlant`, `rug→rugRectangle`,
`table→tableCoffee`, plus `window: "city_day"`. A stored row that no longer validates is served as `DEFAULT_ROOM`.
No migration: `room_json` keeps whatever was written; the upgrade happens on read.

`DEFAULT_ROOM` (a resident who never saved) is SUB-01's studio: bed under the window on the left wall, desk with
monitor, keyboard, desk lamp and gaming chair in the corner, bookcase, small fridge with a coffee machine, coat rack
and the door with a doormat on the back wall, a rug in the middle (see `src/world.js` for the exact entries).

### GET /api/rooms/:plotId

Public.

```json
{
  "plotId": "shiba-1", "kind": "apartment|project",
  "owner": { "name": "Kenji", "look": { …look v2 }, "traits": { …traits } },
  "room": { … },
  "guestbook": [ { "id": 12, "name": "Yui", "text": "nice room 🍜", "at": 1760000000000 } ],
  "visits": 1,
  "unlocks": { "tier": "founder", "items": […], "emotes": […], "accessories": […], "pets": […] },
  "desk": { "viewer": "owner|visitor", "projects": [ … ], "ideas": [ … ] | null }
}
```

- `guestbook`: newest first, at most 50; `name` is the visitor's resident name **now**, never a wallet. Notes written
  before the current owner claimed the plot are not shown (a new tenant starts with an empty guestbook).
- `visits`: the number of different residents among those notes.
- `unlocks`: the owner's, same shape as `/api/me.unlocks`, but counting the owner's **public** ideas only (a visitor
  must not learn that a private project exists), so it can be lower than what the owner sees.

- `desk`: the computer on the room's desk, see "Desk computer" below. It depends on who asks (the session cookie), so
  the response is `cache-control: no-store`.

For an apartment: its resident. For a project plot: the room of the idea submitter's resident, only once the idea is
**public** and only if the submitter has a resident. Otherwise `404` (free plot, private idea, no resident);
`400 bad_plot` for an unknown id.

### Desk computer (`desk` in GET /api/rooms/:plotId)

Every room's desk computer is a small desktop: one entry per project of the room's owner, each with three tabs (the
project's website, its X presence, its launch page on the launchpad). Code: `deskView()` in `src/world.js`.

```json
{
  "viewer": "owner",
  "projects": [
    {
      "slug": "ramen-radar", "name": "Ramen Radar", "ticker": "RAMEN|null",
      "stage": "preview_ready", "stageLabel": "Preview ready for your review", "progress": 0.65,
      "launched": false, "mint": "<mint>|null", "explorerTx": "https://solscan.io/tx/…|null",
      "siteUrl": "http://ramen-radar.projects.localhost:8787/|null",
      "previewLink": "/preview/ramen-radar/<capability>/index.html|null",
      "logoUrl": "/meta/ramen-radar/logo-v1.png|/preview/…/logo.png|null",
      "bannerUrl": "/meta/ramen-radar/banner-v1.svg|/preview/…/banner.svg|null",
      "x": { "handle": "ramenradar|null", "status": "connected|planned|null", "url": "https://x.com/ramenradar|null",
             "posts": [ { "id": "xpost_…", "text": "…", "status": "draft|approved|publishing|published|failed" } ] | null },
      "pagePath": "/projects/ramen-radar", "officePath": "/projects/ramen-radar/review|null",
      "kind": "project|apartment-owner-project"
    }
  ],
  "ideas": [ { "id": "idea_…", "title": "Soba Signal", "status": "submitted", "stageLabel": "…" } ] | null
}
```

Who sees what:

- `viewer: "owner"` when the session wallet is the plot's wallet, else `"visitor"` (signed out included).
- **Visitors**: only the owner's **public** projects; `previewLink`, `officePath` and `x.posts` are `null`, `ideas` is
  `null`. A private project is not there at all (not even as "Private project").
- **Owner**: all their projects, private ones included.
- Projects whose idea is `declined` or `cancelled` are left out. Order: the plot's own project first, then newest
  first. `ideas` (owner only): ideas without a project yet that are still in flight (not declined, cancelled or
  launched), newest first.
- No wallet appears anywhere in `desk`.

Fields:

- `name`/`ticker`: the project's (ticker falls back to the idea's suggested one). `stage`, `stageLabel`, `progress` as
  in `/api/world` (`progress` refined while `generating`).
- `launched` true only with a verified launch; `mint` and `explorerTx` only then (`explorerTx` is `null` for the mock
  provider).
- `siteUrl`: the public site `<PROJECTS_SCHEME>://<slug>.<PROJECTS_HOST>/`, only when the idea is public **and** a
  live site version exists; else `null`. This is the website tab: frame it.
- `previewLink` (owner only): the same-origin sandboxed preview of the live site version, exactly what
  `GET /api/projects/:slug/preview-link` returns. The capability in it expires after **1 hour**: refetch the room (or
  call `preview-link`) when a tab is reopened later. `null` without a live site version.
- `logoUrl` / `bannerUrl`: same-origin image URLs (`img-src 'self'` allows them; `access-control-allow-origin: *` on
  `/meta/*`, so three.js can use them as textures). Public project: `/meta/<slug>/logo-v<n>.png` and
  `/meta/<slug>/banner-v<n>.svg` (immutable). Private project, owner: the preview capability's `logo.png` /
  `banner.svg` (same 1-hour expiry). Otherwise `null`.
- `x`: `status: "connected"` with the handle **as X reported it** after OAuth and `url`; `"planned"` with SUB-01's
  suggested handle and `url: null` (the account may not exist yet; do not link it); `null` when there is no X plan.
  `posts` (owner only): the latest 3 posts of any status, newest first. Editing and approving stay on the office page
  (`PUT /api/x-posts/:id`, `POST /api/x-posts/:id/approve`).
- `pagePath`: the public launch page. `officePath` (owner only): the review/office page (site versions, fee split,
  X drafts, approval, launch).
- `kind`: `"project"` for the project whose building this plot is; `"apartment-owner-project"` for the owner's other
  projects (on an apartment, all of them).

#### Framing: what the city may put in an iframe

The city page is served by this app (`CITY_DIST`) under the app CSP, whose `frame-src` is:

```
frame-src 'self' <origin of BRAIN_PUBLIC_ROOM_URL> <PROJECTS_SCHEME>://*.<PROJECTS_HOST>
```

| setting | value |
|---|---|
| local (defaults) | `frame-src 'self' <room origin> http://*.projects.localhost:8787` |
| production (DEPLOY.md) | `frame-src 'self' <room origin> https://*.projects.subzerone.live` |

So the desk can frame:

1. `previewLink`: same origin (`'self'`). Served with the site CSP plus `sandbox` (opaque origin, no scripts, no
   popups: its links do nothing inside the frame).
2. `siteUrl`: the project's own origin. Its CSP has `frame-ancestors 'self' <PUBLIC_ORIGIN>` (only the launchpad/city
   origin may frame it) and `sandbox allow-popups allow-popups-to-escape-sandbox` (opaque origin, no scripts, links
   open in a new tab). No `X-Frame-Options` is sent.
3. `pagePath` / `officePath` and any other launchpad page: same origin. The app CSP now has `frame-ancestors 'self'`
   (was `'none'`): the city may frame the launchpad, other sites still cannot. The session cookie (`SameSite=Lax`)
   is sent in a same-origin frame, so the office works signed in.

X itself cannot be framed (x.com forbids it): the X tab shows `x.handle`, `x.posts` and opens `x.url` in a new tab.
Posting to X needs an X developer app and a **paid X API tier** (see STATUS.md); until then posts stay drafts.

### PUT /api/rooms/me (auth)

Request `{ "room": { … } }` → `200 { "room": { …as stored } }`. `409 no_resident` until `POST /api/residents`.
Order: `400 bad_room` (shape), `409 no_resident`, `403 locked`, `400 bad_room` (neonTicker text).

### POST /api/rooms/:plotId/guestbook (auth)

Request `{ "text": "nice room 🍜" }` → `200 { "entry": { "id": 12, "name": "Yui", "text": "nice room 🍜", "at": 0 } }`.

- The plot must be visitable (the `GET` above would answer): otherwise `404`; unknown id `400 bad_plot`.
- `403 own_room`: the plot's owner cannot sign their own guestbook. `409 no_resident`: the writer needs a resident.
- `text`: 1–80 characters (code points) after cleaning (as `text` above; emoji kept), else `400 bad_text`. Address-like
  strings are shortened to `first4…last4`.
- Limits (`429 rate_limited` + `retryAfterS`): one note per minute per room, 20 notes per **UTC day** per wallet.
  Counted separately from the notes, so deleting a note does not give the quota back.
- Only the latest 50 notes per plot are kept. Nothing is added to the public news.

### DELETE /api/rooms/:plotId/guestbook/:id (auth)

→ `200 { "ok": true }`. The plot's current owner or the note's author; anyone else `403 forbidden`; a note that is not
on that plot `404`.

## Unlocks

Tiers, in order, from the wallet's own ideas (`unlocksFor(db, wallet)` in `src/world.js`):

| tier | reached when |
|---|---|
| `resident` | the wallet has a resident |
| `builder` | any of its ideas reached `selected` or later |
| `founder` | any reached `preview_ready` or later, or has a built site |
| `launched` | any project launched (verified launch) |

- `tier` is the highest reached (`null` with empty lists: no resident and no progress). Progress counts even before
  the resident exists, so a new resident may start with builder items.
- **Reached once = kept**: the status history is on record, so a later `cancelled`/`failed` does not take an unlock
  back.
- Lists are cumulative: everything from `/api/world/options.unlocks` up to and including `tier`.
- Enforced on `POST /api/residents` (accessories, pet kind) and `PUT /api/rooms/me` (special items): `403 locked`.
  Emotes are not sent to the server; the client offers only `unlocks.emotes`.


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
