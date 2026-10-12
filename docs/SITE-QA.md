# SUB-01's QA gate for the coin sites (2026-10-12)

Before a new version of a coin site goes live, SUB-01 checks it the way a visitor would see it. A version that fails
keeps the previous live version; the owner sees why in the room PC (Site tab: "SUB-01's QA: passed" / "3 issues") and
can publish it anyway.

| Piece | Where |
|---|---|
| Checks, the gate, the ticket, reports, the boot refresh | `src/site-qa.js` |
| Data | `migrations/019_site_qa.sql` (`site_qa`; 016–018 are other branches') |
| The project host honours the ticket | `src/app.js` `projectSite`, `src/tool-api.js` (spec of the version under test) |
| Owner routes | `src/app.js` (below) |
| The browser in the image | `Dockerfile` (`chromium-headless-shell`, `ARG QA_BROWSER`) |
| Room PC | city `src/desk.js` `qaPane`, `src/desk-flows.js` `qaModel` |
| Tests | `test/site-qa.test.js` (9), city `tests/desk.test.js` (`qaModel`) |

## What is checked

**Static** (always, on the built HTML, a few ms): exactly one `h1`; `alt` on every image; `lang`; the responsive
viewport; a non-empty title; unique ids; every in-page link points at a section that exists; with an app, the hero's
action to `#app` and the app section. Warnings: heading-level jumps, tools with no static text.

**Browser** (where a Chromium exists), at **1440×900** and **390×844** (mobile emulation, touch), reduced motion:

| Check | Fails when |
|---|---|
| hydration | a `section[data-tool]` or `section[data-app]` is not `.live` 8 s after load (its "could not load" note is quoted) |
| console | a console error or an uncaught exception from the coin's own host (other hosts, e.g. map tiles: a warning) |
| overflow | `scrollWidth` > the viewport (the offending elements are named) |
| in-viewport / overlap | a heading (h1–h4) or button sticks out of the screen, or two of them overlap (fixed bars and scrollers excluded) |
| text-over-art | more than 2% light pixels of the B/W banner sit under a hero text box (desktop; the banner is sampled on a canvas exactly as `object-fit: cover` draws it) |
| images | a visible image (lazy ones are loaded first) did not load; any image without `alt` |
| cta-fold | on the phone, neither the hero's action nor the action bar is on the first screen |
| contrast | text at under 1.5:1 against its background (near-invisible); under WCAG AA is a warning with examples |
| loading | something still says "Loading…" or is `aria-busy` 8 s after load; work that shows progress (an `aria-busy` element whose text keeps changing, e.g. "Verifying 4 of 9 entries…") gets 20 s (`HEAVY_MS`) |
| gave-up | a block says on the page that it failed ("Could not …", "The registry could not load …") |

Screenshots: the first screen and the whole page at both sizes, JPEG, on the volume at `DATA_DIR/qa/<slug>/v<N>-<desktop|mobile>-<fold|full>.jpg`;
the last 3 checked versions and the live one are kept (`SITE_QA_KEEP`).

## The gate

- `publishSite(db, cfg, project, version, actor)` replaces the old "build, then `setLiveVersion`" in every path: the
  pipeline's first build and `build_site`, the child launch build, the owner's site editor, Tools and App saves, the
  boot backfills (static only), the design refresh.
- Issues → **held**: the previous live version stays, a public audit line says "Website version N held back by SUB-01's
  QA (…); version M stays live". The first version of a site is never held (nothing earlier to keep). `SITE_QA_GATE=0`
  publishes with issues (recorded).
- The owner: `POST /api/projects/:slug/site/qa/:version/override` publishes a held version (status `overridden`,
  public audit line); `POST …/site/qa/recheck` checks the live version again (it stays live).
- A held version's edits are not carried into the next edit: edits start from what is live.
- `SITE_QA_CPU_THROTTLE` (default 1) slows the rendered page's CPU (DevTools throttling), to rehearse a slow phone
  or a slow host.
- No browser (`SITE_QA_BROWSER=off`, no Chromium found, or the browser crashed): the static checks decide and the report
  says so, e.g. "passed (static checks only: no browser)". Default: `auto` when `NODE_ENV=production` (the image),
  `off` elsewhere (tests, local runs unless set).

**How the browser sees a version that is not live.** A random 24-byte ticket is stored hashed on the `site_qa` row for
the run (≤ `SITE_QA_TIMEOUT_MS`). Chromium sends it as `x-sub01-qa` (only to the coin's own host, never to map tiles);
the project host then serves that version's HTML and its `/_api` reads from that version's spec, refuses every write
(403 `qa_read_only`), sends `no-store`, and also serves a private idea's page (the ticket is the capability). The
ticket is cleared when the run ends. Chromium loads the page from this server on loopback as
`http://<slug>.qa.localhost:<PORT>/`: Chromium resolves `*.localhost` itself and treats it as a **secure context**, as
visitors' https is (Web Crypto, the clipboard). The server answers that host only with a valid ticket for that coin.

**Incident 2026-10-12 (first production run, Q-wave):** "still loading after 8 s: Loading the verifier
(@noble/post-quantum)…". The QA then fetched the page as plain `http://<slug>.projects.subzerone.live` mapped to
loopback, which is not a secure context, so `crypto.subtle` was undefined, the registry's first SHA-256 threw, and the
summary line was never replaced (and the old check sampled once right after hydration while saying "8 s"). Visitors
on https were not affected. Fixed: the `*.qa.localhost` origin (Debian's headless shell ignores
`--unsafely-treat-insecure-origin-as-secure`; checked: `isSecureContext` false there, true in Chrome), the loading
check that really waits (above), the verifier says why it cannot run instead of staying on "Loading…", verifies one
entry at a time with "Verifying n of m" (aria-busy), and the QA fails a page that says it gave up. Reproduced and
verified locally with the production host layout (no port in `PROJECTS_HOST`) and Chromium headless shell, at
`SITE_QA_CPU_THROTTLE` 1 / 6 / 20 / 50: settled after 0.3 / 0.9 / 4.7 / 17.7 s, all passed (50×: the progress
allowance; the run took 56 s, so give such a slow host a larger `SITE_QA_TIMEOUT_MS`).

## Owner API (session; owner, or staff for reads)

| Method | Path | |
|---|---|---|
| GET | `/api/projects/:slug/site/qa` | `{liveSiteVersion, reports:[{id, version, status: running/passed/failed/overridden, line, held, browser, browserNote, issues:[{viewport, check, detail}], warnings, viewports, runtimeMs, shots:[{name, viewport, kind, width}]}]}` newest first, 5 |
| GET | `/api/projects/:slug/site/qa/:version/:name` | a screenshot listed in that version's report (`image/jpeg`) |
| POST | `/api/projects/:slug/site/qa/:version/override` | publish a failed version anyway (preview open or launched) |
| POST | `/api/projects/:slug/site/qa/recheck` | check the live version again → `{live, qa}` |

`PUT /api/projects/:slug/site`, `…/tools`, `…/app` now answer `{…, live, qa}`.

## Coins built before the redesign

`scripts/refresh-site-design.js` (tools/start.sh, after the backfills): a live version still on `site-kit.v1.css`, while
the site may change (preview open, or launched), is rebuilt from its own spec as a new version, statically checked, set
live, and a `site_qa` job re-checks it in the browser from the worker. Once per coin. A site frozen between approval
and launch keeps its look until then.

## Cost (measured 2026-10-12)

**Runtime**, both viewports with the four screenshots, on the local backend (MacBook, arm64):

| Browser | Per version | Runs |
|---|---:|---|
| Chromium headless shell (the image's kind) | 1.6–2.0 s | Q-wave, Ramen Radar, Frog Arcade, 2 runs each |
| Google Chrome | 2.2–3.4 s | the same four sites |

Peak memory of the headless shell during a run: ≈ 375 MiB RSS summed over its processes (the runner process itself
≈ 270 MiB, mostly the app). One run at a time per process (serialised); a run is bounded by `SITE_QA_TIMEOUT_MS`
(60 s). In the room PC a save waits for its QA (~2 s more).

**Image size** (no container runtime was available here, so measured from the Debian bookworm package indexes against
the `node:22-slim` image's own package list, pulled from Docker Hub: 79.8 MB compressed today):

| Option | Packages added | Installed | Compressed (≈ layer size) |
|---|---:|---:|---:|
| `chromium-headless-shell` (chosen; no X/GTK UI) | 106 | +524 MiB | +152 MiB |
| `chromium` (full browser) | 175 | +699 MiB | +197 MiB |
| `playwright-core` 1.63.0 (npm) | — | +13.5 MB | — |

The largest pieces are the Chromium binary (211 MiB) and Mesa's LLVM (112 MiB, pulled in by libgbm). `QA_BROWSER=0`
builds the image without it: the QA then runs its static checks only and says so in every report. Debian's
headless shell is 154.0.8037.92; playwright-core 1.63 was verified here with headless shell r1228 and Chrome.

## Verified locally (2026-10-12)

Backend with the mock provider and `SITE_QA_BROWSER` pointing at Chrome: four sites (Q-wave with the owner's B/W brand
files and the launch block, Ramen Radar, Frog Arcade, Konbini Confession with coinart's B/W art) built and checked:
all passed. Caught for real during the work: a hidden file-preview `<img>` with no `src` (now ignored: an image kept
hidden until it has something to show is not broken) and, against the first stylesheet, Konbini Confession's name and
pitch running into its lettermark (15% / 13% over the drawing; the safe zone went from 42vw to 34vw). A version with a
template bug (the hero image without `alt`) was held with 3 issues; the room PC showed the reasons and screenshots and
"Publish v4 anyway" published it.
