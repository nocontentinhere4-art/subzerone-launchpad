# City API (contract for the city client)

The 3D city (`sub01-launchpad`, Vite/three.js) talks to this service. Code: `src/world.js` (plots, residents, rooms,
world snapshot, look v2 and traits, unlocks, guestbooks, city events), `src/roles.js` (roles, takeovers),
`src/trust.js` (vote ledger, disclosure), `src/calendar.js`, `src/telemetry.js`, `src/rituals.js` (omikuji, predictions,
ema, "while you were away"), `src/diary.js` (SUB-01's diary), `src/postcard.js` (share cards), routes in `src/app.js`.
Tests: `test/city.test.js`, `test/custom.test.js`, `test/desk.test.js`, `test/trust.test.js`, `test/calendar.test.js`,
`test/telemetry.test.js`, `test/rituals.test.js`.

## Conventions

- JSON in and out. Times are unix **milliseconds**.
- Writes (`POST`/`PUT`/`DELETE`) need the session cookie from wallet sign-in (`POST /api/auth/nonce` → sign → `POST
  /api/auth/verify`) and an `Origin` header equal to the service's `PUBLIC_ORIGIN`. Serve the city from the same origin
  (`CITY_DIST`, see DEPLOY.md) and the browser does both for you.
- Errors: `{ "error": "<code>", "message": "<human sentence>" }` with an HTTP status. Codes used here:
  `400 bad_plot | bad_name | bad_look | bad_traits | bad_room | bad_text | bad_wallet | bad_role | bad_reason | bad_request`,
  `401 sign_in`, `403 forbidden | locked | own_room | not_founder | founder_active`, `404 not_found | no_role`,
  `409 plot_taken | no_resident | not_launched | already_founder | takeover_open | not_open`, `429 rate_limited`;
  trust routes: `400 bad_request | bad_telemetry`; rituals: `400 bad_request`, `403 own_idea`, `404 not_found`,
  `409 no_resident | closed | already_predicted | already_cheered`.
- `403 locked` carries the names that are not unlocked yet: `{ "error": "locked", "message": "…", "locked": ["halo", "dragon"] }`.
- `429 rate_limited` carries `retryAfterS` (seconds).
- Rate limits: the same per-IP/per-wallet token buckets as every other route (reads 400/min, writes 60/min).
- **Wallets never appear in `/api/world` or `/api/rooms/*`** (the `desk` included). Role listings show wallets shortened to `first4…last4`.

## Plots

288 plot ids: `` `${district}-${n}` `` with `n` 1..6 and district in this order (48 districts, a 7×7 grid around the
city's centre block):
`shiba, shinjuku, akihabara, shibuya, harajuku, nakameguro, ebisu, roppongi, ginza, asakusa, ueno, ikebukuro, nakano,
kanda, tsukiji, odaiba, yoyogi, meguro, shinagawa, sumida, daikanyama, nihonbashi, koenji, shimokitazawa`, then the third
ring `kiyosumi, ryogoku, oshiage, yanaka, sugamo, takadanobaba, ogikubo, kinshicho, kichijoji, ochanomizu, kagurazaka,
toyosu, omotesando, gotanda, jiyugaoka, tsukishima, sangenjaya, kitasenju, nippori, aoyama, shinbashi, akasaka, iidabashi,
mejiro`. The first 24 districts (144 ids) are unchanged from the 5×5 city, so saved plots and residents stay valid. The
city client keeps the same list in `src/city-state.js` (`districts`, positions included).

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
  "districts": ["shiba", "shinjuku", "…48 names"],
  "plotsPerDistrict": 6,
  "plotIds": ["shiba-1", "shiba-2", "…288 ids"],
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
                "points": 0, "createdAt": 0, "updatedAt": 0 } | null,
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

`resident.points`: prediction points (see Predictions). Every signed-in `GET /api/me` also marks the visit for
"While you were away" (a visit ends after 30 minutes without one).

Signed out: `{ "user": null }` as before.

## POST /api/ideas — addition

Optional `"plotId": "ginza-3"` in the existing submission body. Validated (`400 bad_plot`) and reserved atomically
with the idea (`409 plot_taken`, and then no idea is created). Omitted = the idea has no building yet.

Response: `{ "id": "idea_…", "pinnedHash": "<64 hex>", "pinnedAt": 1791601080098 }`: the idea's ema (see Ema).

## GET /api/world

Public, `cache-control: public, max-age=3`. The server rebuilds the snapshot at most every 3 s (and after any write it
receives). Poll every 3–5 s.

```json
{
  "now": 1760000000000,
  "sub01": { "state": "idle|working|asleep|offline", "ideaId": "idea_…|null", "plotId": "ginza-3|null",
             "stage": "generating|null", "text": "Building Ramen Radar (building)" },
  "plots": [
    { "plotId": "shiba-1", "kind": "apartment", "resident": { "name": "Kenji", "look": { …look v2 }, "traits": { …traits },
      "buff": "glow|confetti|petals|null" }, "project": null },
    { "plotId": "ginza-3", "kind": "project", "resident": null,
      "project": { "ideaId": "idea_…|null", "slug": "ramen-radar|null", "name": "Ramen Radar", "ticker": "RAMEN|null", "stage": "preview_ready",
                   "stageLabel": "Preview ready for your review", "progress": 0.65, "launched": false, "mint": null,
                   "logoUrl": "/meta/ramen-radar/logo-v1.png|null", "bannerUrl": "/meta/ramen-radar/banner-v1.svg|null" } }
  ],
  "news": [ { "at": 1760000000000, "text": "Ramen Radar: Launched — verified on devnet", "plotId": "ginza-3|null",
              "kind": "status|resident|role|takeover|approval|clearance|site|generation|edit|visibility|progress|x" } ],
  "events": [ { "kind": "accepted|site_live|launched", "plotId": "ginza-3|null", "name": "Ramen Radar", "ticker": "RAMEN|null",
                "at": 1760000000000 } ]
}
```

- `plots` lists **claimed** plots only, oldest claim first.
- `resident.buff`: today's omikuji effect (cosmetic, see Omikuji), the kind only; `null` when the resident has not
  drawn today, drew a slip without an effect, or the Tokyo day is over.
- `project` for an idea that is still **private**: `{ "ideaId": null, "slug": null, "name": "Private project", "ticker": null,
  "stage", "stageLabel", "progress", "launched": false, "mint": null, "logoUrl": null, "bannerUrl": null }`. Nothing else
  about it is exposed.
- Public idea: `name` is the project name (or the idea title before the project exists); `ticker` is the project's
  (or the suggested one); `slug` is null until SUB-01 has built it (`/projects/<slug>` on the launchpad).
- `ideaId` (`project` only): a **public** idea's id (`idea_…`), so the city can call `GET /api/predictions/:ideaId` and
  `POST /api/ema/:ideaId/cheer` without matching by title. A **private** project is `null`: its id is never sent. Public ids
  are the ones `GET /api/ema` and `GET /api/votes` already show. An idea that goes private again drops back to `null` on
  the next snapshot.
- `mint` is set only when `launched` is true.
- `logoUrl` / `bannerUrl`: the project's latest generated logo (PNG) and banner (SVG) as public same-origin paths
  `/meta/<slug>/logo-v<n>.png` and `/meta/<slug>/banner-v<n>.svg` (the files the token metadata links to; immutable,
  `access-control-allow-origin: *`, served only while the idea is public). `null` while the idea is private, before
  SUB-01 has built the project (no slug) or when no art is stored. The city's big screens and blimp show them.
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
- A signed-in visitor's `GET` (not the owner's) is noted once per visitor, plot and Tokyo day in `room_visits`, for
  the owner's "While you were away". Nothing about it is public.
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

## Vote ledger (trust.js)

Every answer of SUB-01's brain (build **and** pass, private ideas included) appends one row, in the same database
transaction that records the evaluation. Ideas declined by a rule before the brain is asked (duplicate, unclear,
policy) are not brain votes and add no row; a replayed evaluation adds nothing. The table is append-only (SQLite
triggers refuse `UPDATE`/`DELETE`) and hash-chained:

```
hash = sha256( prevHash + canonical({ seq, at, ideaHash, requestHash, decision, networks, vote, mood, stage, gain }) )
```

- `canonical`: JSON with object keys sorted at every level, no whitespace (`trust.js` `canonical`).
- genesis `prevHash` = 64 zeros; `seq` runs 1, 2, 3 … without gaps.
- `ideaHash` = sha256 of `JSON.stringify([title, concept, version])` (the idea version the brain was asked about).
- `requestHash` = sha256 of the request id `"<ideaId>.v<version>"` (the id itself is shown only for public ideas).
- `vote` is the brain's vote record **whitelisted**: option labels and `spiking.leaned_to` carry the idea's title, so
  they are never stored here. `demo: true` = the brain ran in demo mode.

Every field that goes into a hash is in the public output, so **anyone can recompute the whole chain from
`GET /api/votes` alone** (`test/trust.test.js` does). What a recomputation cannot catch: rows cut off the end of the
chain. That is what the head is for: an operator publishes `GET /api/votes/head` somewhere we can't rewrite (an
on-chain memo is the planned later step; **not built yet**).

### GET /api/votes?limit=50&before=<seq>

Public, newest first. `limit` 1–200 (default 50), `before` a seq (exclusive); anything else → `400 bad_request`.

```json
{ "votes": [
    { "seq": 2, "at": 1791601080098, "ideaHash": "55a2…", "requestHash": "48a0…", "decision": "pass",
      "networks": { "reward": 1, "attention": 0.5, "language": 0.8 },
      "vote": { "chosen": 1, "temperature": 0.4, "reason": "chose it: reward areas responded most",
        "options": [ { "action": "build", "p": 0.2, "value": 1, "response": 0.01, "chosen": false },
                     { "action": "pass", "p": 0.8, "value": 0.1, "response": 0.001, "chosen": true } ],
        "spiking": { "used": false, "net": "rate", "network": "rate model only", "pick": null }, "demo": true },
      "mood": { "boredom": 0.2, "pressure": 0.1, "tired": 0 }, "stage": "AWAKE", "gain": 1.1,
      "prevHash": "63a1…", "hash": "e265…", "idea": null },
    { "seq": 1, "decision": "build", "…": "…", "prevHash": "0000…0000", "hash": "63a1…",
      "idea": { "ideaId": "idea_…", "requestId": "idea_….v1", "title": "Ramen Radar", "slug": "ramen-radar" } } ],
  "next": 1,
  "head": { "seq": 2, "hash": "e265…", "at": 1791601080098 } }
```

- `idea` is `null` unless the idea is **public and not declined** (private ideas and passed ideas stay anonymous; a
  passed idea's page does not link its row either). `slug` is `null` until a project exists.
- `next`: pass it as `before` for the next page; `null` = no more rows.
- `mood`, `stage`, `gain` are `null` when the brain did not send them. Never a wallet, title or label otherwise.
- Linked from the idea: `GET /api/ideas/:id` → `evaluation.ledger: { seq, hash } | null`.

### GET /api/votes/head

`{ "seq": 2, "hash": "e265…", "at": 1791601080098 }`. Empty ledger: `{ "seq": 0, "hash": "0000…0000", "at": null }`.

### GET /api/votes/verify?from=&to=

Recomputes `[from, to]` on the server (each hash, each link to the row before, no missing seq). Defaults: `from=1`,
`to` = head (at most 5000 rows per call; more → `400`).

`{ "ok": true, "broken_at": null, "from": 1, "to": 2, "checked": 2 }` or, after tampering,
`{ "ok": false, "broken_at": 2, … }` (`broken_at` = first seq that is wrong or missing).

## GET /api/disclosure

Public, `Cache-Control: public, max-age=3600`. Fixed text from `trust.js`; two values come from the environment
(`SUB01_DATASETS`, comma list, max 20 × 80 characters; `OPERATOR_NAME`, max 80):

```json
{ "system": "SUB-01", "nature": "AI system driven by a brain-activity model derived from human MRI datasets",
  "not_conscious": true, "datasets": ["HCP Young Adult 1200"], "decision": "brain vote; reproducible from the ledger",
  "human_gate": "every publication and every transaction is approved/signed by a human", "operator": "Example",
  "x_automation_label": true, "ai_act": "Art. 50 disclosure", "updated_at": "2026-10-10" }
```

`datasets` is `[]` and `operator` `null` when unset. Show it wherever SUB-01 speaks or decides (city HUD, room,
X profile/bio). `updated_at` changes only when the text in `trust.js` changes.

## GET /api/calendar

Public, `Cache-Control: public, max-age=60` (one server snapshot for everyone, at most 60 s old). Tokyo time (JST,
UTC+9, no daylight saving); all times unix ms.

```json
{ "now": 1791601080112, "tokyoDate": "2026-10-10",
  "weekTheme": { "id": "matsuri", "title": "Matsuri", "kanji": "祭", "text": "Festival week: stalls, drums and paper lanterns in the districts.",
    "isoWeek": "2026-W41", "starts": 1791126000000, "ends": 1791730800000 },
  "today": { "starts": 1791558000000, "ends": 1791644400000, "events": [
    { "kind": "omikuji", "at": 1791558000000, "ends": 1791644400000, "title": "Omikuji: draw the day's fortune",
      "slug": null, "name": null, "ticker": null, "plotId": null, "time": "00:00 JST" } ] },
  "upcoming": [
    { "kind": "omikuji", "at": 1791644400000, "…": "…" },
    { "kind": "ranking", "at": 1793458740000, "ends": 1793458800000, "title": "Monthly room ranking closes", "slug": null,
      "name": null, "ticker": null, "plotId": null, "placeholder": true } ] }
```

- **Week theme**: 8 themes in a fixed order, `hanami, matsuri, neon, rain, obon, moon, snow, newyear`; index = (ISO
  weeks since Monday 1970-01-05) mod 8, weeks starting Monday 00:00 JST. `starts`/`ends` = that Monday and the next.
- **Events** (same shape for every kind: `kind, at, ends, title, slug, name, ticker, plotId`; public projects only,
  never a wallet):
  - `launch_party`: a public project launched today (JST); `at` = the verified launch time, `ends` = +3 h. Mock
    launches are hidden in production.
  - `open_soon` (in `upcoming`): a public project in `launch_prepared` or `awaiting_signature`; expected window
    `at` = now, `ends` = now + 24 h. It opens only when its submitter signs, so this is an expectation, not a date.
  - `ranking`: the monthly room ranking closes at 23:59 JST on the month's last day (`placeholder: true`: there is no
    ranking yet). In `today` on that day, otherwise in `upcoming`.
  - `omikuji`: daily ritual at 00:00 JST (`time: "00:00 JST"`); today's in `today`, tomorrow's in `upcoming`.
- `today.events` and `upcoming` are sorted by `at`; `upcoming` has at most 30 entries.

## POST /api/telemetry (anonymous)

No sign-in. The city sends one report per session at most every 30 s (`fetch(…, { method: 'POST', keepalive: true,
headers: { 'content-type': 'application/json' } })`; the usual `Origin` rule applies, so serve the city from the same
origin). Strict body: exactly these keys, nothing else (`400 bad_telemetry` otherwise):

```json
{ "session": "random client id, 16–32 of [A-Za-z0-9_-]", "device": "phone | desktop", "gpu_class": "weak | ok | null",
  "quality_level": 0, "fps_bucket": "<20 | 20-30 | 30-45 | 45+", "crash": false, "context_lost": false,
  "memory_mb": 512, "seconds": 90 }
```

`quality_level` 0–3, `memory_mb` 0–65536 or `null`, `seconds` 0–86400. → `{ "stored": true }`.

- **Opt-out**: a request with `DNT: 1`, `Sec-GPC: 1` or `X-Telemetry: off` is not read or stored →
  `{ "stored": false, "reason": "opted_out" }`. Offer a "send anonymous performance data" toggle that sets the header.
- Limits: `429 rate_limited` (with `retryAfterS`) at more than 1 report / 30 s per session or 500 reports per UTC day
  per IP.
- **Nothing identifying is stored**: no wallet, no cookie, no IP. The session id and the IP are kept only as sha256 with
  a per-UTC-day salt; the first report of a new day replaces the salt (yesterday's is gone, so its hashes can't be
  linked to anything), clears yesterday's IP hashes, and deletes rows older than 90 days. Make the session id a fresh
  random value per visit (not a stored identifier).

### GET /api/admin/telemetry?days=14 (admin)

Daily aggregates only, newest first (`days` 1–90). Rates are per session (a session counts as crashed / context-lost if
any of its reports says so; `phoneShare` = sessions on phones); `fps` and `quality` count reports. Rates are `null`
for a day without sessions.

```json
{ "days": [ { "day": "2026-10-10", "sessions": 1, "reports": 1, "phoneShare": 1, "crashRate": 0, "contextLossRate": 0,
    "fps": { "<20": 0, "20-30": 1, "30-45": 0, "45+": 0 }, "quality": { "0": 0, "1": 1, "2": 0, "3": 0 } } ],
  "since": "2026-10-09", "note": "anonymous: no wallet, cookie or IP; session ids and IPs hashed with a salt that is discarded daily" }
```

## Rituals (rituals.js, diary.js, postcard.js)

**Legal line.** Nothing awarded here has value or can be traded, transferred, sold or redeemed: fortunes and their
buffs are cosmetic and end at midnight JST, prediction points only order a leaderboard (no prize, no streak reward, no
market), cheers are cosmetic. That keeps every ritual outside prize-contest and gambling rules (DPR 430/2001, TULPS
art. 110; loot-box resale rules). Do not add anything that changes this without legal review. No wallet ever appears
in these outputs; people are shown by resident name.

### Omikuji: POST /api/omikuji (auth, resident) · GET /api/omikuji/today (auth)

One slip per wallet per Tokyo day. The draw is deterministic: `sha256("<wallet>|<Tokyo date>|<secret salt>")`; the
first 4 bytes pick one of 7 fortunes by weight (out of 12), byte 5 picks the line. The salt lives in `settings`
(`omikuji.salt`, created on first use, never returned). Drawing again the same day returns the same slip with
`fresh: false`; a new slip is available from 00:00 JST.

```json
{ "drawn": true, "fresh": true, "date": "2026-10-10",
  "fortune": { "id": "daikichi", "kanji": "大吉", "rank": 1 },
  "text": "Great blessing. Your balcony lantern stays lit until midnight.",
  "buff": { "kind": "glow", "until": 1791644400000 }, "drawnAt": 1791601080098,
  "note": "Cosmetic only: no value, nothing to trade, transfer or redeem." }
```

- Fortunes (rank, weight, buff): `daikichi` 大吉 (1, 1, glow), `kichi` 吉 (2, 3, petals), `chukichi` 中吉 (3, 2, confetti),
  `shokichi` 小吉 (4, 2, petals), `hankichi` 半吉 (5, 1, none), `suekichi` 末吉 (6, 2, none), `kyo` 凶 (7, 1, none: tie
  the slip to the shrine tree). Lines come from the fixed list in `rituals.js` `FORTUNES`.
- `buff.until` = the end of that Tokyo day. Others see `buff.kind` on `/api/world` (`plots[].resident.buff`).
- `GET /api/omikuji/today`: the same object with `fresh: false`, or `{ "drawn": false, "date": "2026-10-10", "note": "…" }`.
- `409 no_resident` without a resident; `401 sign_in` signed out.

### Predictions ("build or pass")

Residents guess SUB-01's vote on a **public** idea while it waits for the brain (`submitted` or `evaluating`, no vote
yet). Only public ideas can be predicted, so **the author decides**: an idea published before the vote is open to
guesses; a private one never is. One guess per resident per idea; not on your own idea.

`POST /api/predictions` (auth, resident) with exactly `{ "ideaId": "idea_…", "guess": "build" | "pass" }` →
the view below. Errors: `400 bad_request` (other keys, bad values), `404 not_found` (unknown or private), `403
own_idea`, `409 closed` (already voted, or the idea left the queue), `409 already_predicted`, `409 no_resident`.

`GET /api/predictions/:ideaId` (public; `mine`/`correct` with a session; private idea → `404`):

```json
{ "ideaId": "idea_…", "closed": true, "decision": "build", "total": 2, "build": 1, "pass": 1, "mine": "build", "correct": true }
```

- `closed`: the ledger has the brain's vote on the idea, or the idea is no longer in the queue. `decision` comes from
  that ledger row (`null` until it exists; also `null` for an idea declined by a rule or cancelled before the vote: no
  one scores).
- Settlement happens in the same database transaction that appends the vote to the ledger: each correct guess adds
  **10 points** to the resident (`/api/me.resident.points`). Guesses never reach the brain.

`GET /api/leaderboard?kind=predictions` (public; `kind` defaults to `predictions`, anything else → `400`):

```json
{ "kind": "predictions", "top": [ { "name": "Yui", "points": 10 } ],
  "note": "Points only order this list. They have no value and cannot be traded, transferred or redeemed." }
```

Top 20 residents with points > 0, highest first (ties: the older resident first). Names only.

### Ema (an idea pinned before the vote)

At submission the idea's version 1 is pinned: `pinnedHash = sha256(JSON.stringify([title, concept, 1, wallet]))`
(the submitted, cleaned text), `pinnedAt` = submission time. The author can later prove they had this exact text at
that time (their own copy of v1 is in the idea's versions). It is returned by `POST /api/ideas` and shown as
`pinnedHash`, `pinnedAt`, `ledgerSeq` on `GET /api/ideas/:id` and on the project JSON `GET /api/projects/:slug`.
`ledgerSeq` = the idea's vote-ledger row (`null` before the vote; on a passed idea only for its author or staff, like
`evaluation.ledger`; on the project JSON the build vote). Ideas submitted before this feature have `null` hashes.

`GET /api/ema?limit=30` (public, `limit` 1–50): the latest **public** pinned ideas, newest first; declined and
cancelled ideas leave the shrine.

```json
{ "ema": [ { "ideaId": "idea_…", "pinnedHash": "…", "pinnedAt": 1791601080098, "title": "Ramen Radar", "slug": "ramen-radar|null",
             "stage": "submitted", "stageLabel": "Dropped in his room", "cheers": 1 } ],
  "note": "Cheers are cosmetic. They do not reach SUB-01's brain and do not change the order or the outcome of any vote." }
```

`POST /api/ema/:ideaId/cheer` (auth, resident, once per idea, not your own) → `{ "cheers": 1 }`. Errors: `404
not_found` (not on the shrine), `403 own_idea`, `409 already_cheered`, `409 no_resident`.

**Cheers do not influence the brain.** The pipeline never reads them; the brain request carries the request id, the
idea's title and its concept only (tested). The evaluation queue order is unchanged.

### While you were away: GET /api/away (auth, resident)

Since the resident's last visit (a visit = `GET /api/me` calls less than 30 minutes apart; `since` is when the
previous visit ended, or the resident's creation on the first visit):

```json
{ "since": 1791590000000,
  "visits": [ { "name": "Yui", "at": 1791600000000 } ],
  "guestbook": [ { "name": "Yui", "text": "nice room 🍜", "at": 1791600000000 } ],
  "project": [ { "ideaId": "idea_…", "slug": "ramen-radar|null", "from": "generating", "to": "preview_ready", "at": 1791600100000 } ],
  "note": "What happened in your rooms and to your ideas since your last visit. Nothing here needs an action." }
```

- `visits`: people who opened or signed in the guestbook of any room the resident holds now (apartment and project
  plots), newest first, one entry per person (their latest time), never the resident; `Visitor` for someone without a
  resident. `guestbook`: new notes in those rooms. `project`: status changes of the resident's own ideas (private ones
  included: this is the owner's own view). At most 20 each, newest first.
- No push, no badge counts, no streaks. Show it as a quiet note in the room; the text stays neutral.

### SUB-01's diary: GET /api/diary?date=YYYY-MM-DD · GET /api/diary/latest

Public. One page per **Tokyo** day, written from the vote ledger and the build log with fixed templates (no language
model; `diary.js` `TEMPLATES`). `date` defaults to the last completed Tokyo day; today is allowed (a partial page);
a future day, a malformed date or another parameter → `400 bad_request`. `/latest` = the most recent completed day
that has entries (or the last completed day, empty).

```json
{ "date": "2026-10-10",
  "entries": [
    { "kind": "moved_in", "at": 1791601080000, "text": "Kenji moved into Ebisu.", "slug": null, "ticker": null, "ledgerSeq": null, "score": null },
    { "kind": "built", "at": 1791601080098, "text": "I built Ramen Radar ($RAMEN). The build network lit at 0.8.",
      "slug": "ramen-radar", "ticker": "RAMEN", "ledgerSeq": 1, "score": 0.8 },
    { "kind": "site_live", "at": 1791601080200, "text": "I finished the site of Ramen Radar ($RAMEN). Its author reviews it before anything goes out.",
      "slug": "ramen-radar", "ticker": "RAMEN", "ledgerSeq": 1, "score": 0.8 },
    { "kind": "passed", "at": 1791601090000, "text": "I passed on an idea (55a2c0de): build 0.2, keep going 0.8.",
      "slug": null, "ticker": null, "ledgerSeq": 2, "score": 0.2 } ],
  "counts": { "built": 1, "passed": 1, "launched": 0, "residents": 1 },
  "note": "SUB-01 is a model, not a conscious being. This page is generated from the vote ledger and the build log; numbers are copied exactly." }
```

- `built` / `passed`: every ledger row of the day. `score` = the build option's `p` from the ledger row, copied as
  stored; "keep going" = the pass option's `p`. A **private** idea, and **any passed idea** (even a public one), is
  named only by the first 8 characters of its ledger `ideaHash`: `I said build to a private idea (1a2b3c4d). …`.
- `site_live` / `launched`: the first time a **public** idea's site was built / it launched (mock launches hidden in
  production), with the build vote's `ledgerSeq` and `score`. `moved_in`: a new resident (not a move between plots),
  by resident name and district.
- Entries in time order. A finished day is cached (`diary_days`); every read re-checks that the ideas it names are
  still public and not declined, and regenerates the page otherwise.

### Postcards: GET /api/postcard/:slug.(svg|png) · GET /api/postcard/room/:plotId.(svg|png)

Public share cards, 1200×630. A **public** project (name, `$TICKER`, stage label, its logo, a stamp: 待 waiting,
建 building, 発 launched, 休 stopped) or an **apartment with a resident** (name, district, a figure in the resident's
colours, stamp 住); both with the SUBZERONE lockup and the Tokyo date. **Never a price** or any market number: the
card has no field for one. `cache-control: public, max-age=300`, `access-control-allow-origin: *`. Private or
unknown project, free or project plot, other extension → `404`.

- `.svg`: real text in system fonts, the lockup inlined (path lettering, no font needed), the logo as a data URI;
  served with `content-security-policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`.
- `.png`: the same card drawn with a built-in 5×7 bitmap font (ASCII; other characters print as `?`) and a postmark
  instead of the kanji stamp. Use the PNG for `og:image`: X, Facebook, Discord and Telegram do not take SVG.

### Share pages: GET /p/:slug · GET /r/:plotId

Tiny HTML pages with Open Graph and Twitter tags (`og:image` = the absolute URL of the PNG postcard, 1200×630,
`twitter:card = summary_large_image`) and an immediate redirect (`<meta http-equiv="refresh">`) into the city:
`/?focus=<plotId>` (a project without a building goes to `/projects/<slug>`). Same `404` rules as the postcards.
`cache-control: public, max-age=300`. The city should share these URLs (`/p/ramen-radar`, `/r/ebisu-1`) and read
`?focus=` on load.

## Hosting the city on the same origin

Set `CITY_DIST` to the absolute path of the city's `dist/`. Then `/` is the city, `/assets/*` its files (immutable
cache), and the launchpad's home page is `/launchpad` (all other launchpad pages keep their paths). Details and the CSP
check: DEPLOY.md, "City client on the same origin".
