# The coin sites' visual system (2026-10-12)

The owner's brief: "i siti funzionali devono essere fatti bene da SUB-01". Every coin site SUB-01 builds looks like a
product site, not a template: pure black, white, Swiss / International typographic style, a bold geometric lettermark
and a minimal B/W banner (references: Q-wave `$QWAVE`, the D-Wave wordmark, the "Quantum Pad" app card, minimal dark
tech sites). This file is the contract for anyone who writes markup the kit styles (render-child.js, the kit's JS
modules, the launch block, the coin art): the tokens, the grid, the class names that must stay stable.

| Piece | Where |
|---|---|
| The page template | `src/site/render-child.js` (sandboxed build, script-free HTML) |
| The stylesheet | `kit/src/site-kit.css` + `kit/app/app.css` + `kit/src/tools/holder-tools.css` → `public/_kit/site-kit.v2.css` |
| The fonts | `kit/fonts/*.woff2`, cut by `kit/fonts/subset.sh`, copied to `public/_kit/fonts/` |
| The frozen v1 look | `kit/legacy/` (pages built before v2 link `site-kit.v1.css`, still served) |
| Motion, the CA copy button, the phone action bar | `kit/src/core.js` (`motionIn`, `chrome`) |
| The QA that checks every page | `src/site-qa.js`, docs/SITE-QA.md |

## Principles

- **Black and white.** `#000` ground, `#fff` type, three greys for secondary text, two hairline weights. No gradients,
  no glass, no glow, no emoji in the chrome. The coin's palette from the brain record is no longer used on the page.
- **One accent, for state only.** Green `--up` (#38d47a) for up / verified / buy, red `--down` (#ff5c5c) for down /
  failed / sell. Nothing decorative is coloured.
- **The art carries the identity.** B/W coin art (coinart.js) fills the hero; the name is set large in its empty part.
- **The product first.** The app is the first section; the hero's one action goes to it.
- **Numbers are data.** Every figure in JetBrains Mono with tabular digits, on hairline rows.

## Tokens (`:root` in site-kit.css)

| Token | Value | Use |
|---|---|---|
| `--bg` / `--fg` | `#000` / `#fff` | ground / primary text, rules that open a section, the primary button |
| `--fg-2` | `#c7c7c7` (≈ 12:1 on black) | body copy, ledes |
| `--fg-3` | `#8e8e8e` (≈ 6.3:1, AA) | labels, eyebrows, notes |
| `--line` / `--line-2` | white at 16% / 34% | hairlines between rows / control borders |
| `--up` `--down` (`--ok` `--err`) | `#38d47a` `#ff5c5c` | state only |
| `--brand` `--ac` `--ac2` | `#fff` | legacy names some JS still reads (map pins, chart, cards); all white |
| `--sans` | Inter (variable, opsz 14–32 so large sizes use Inter Display, wght 400–800) | everything |
| `--mono` | JetBrains Mono 400/700 | numbers, labels, the CA, code |
| type scale | `--t-xs 12` `--t-sm 14` `--t-md 16` `--t-lg 18–21` `--t-xl 22–28` `--t-2xl 30–56` `--t-3xl 40–84` px | fluid with `clamp()` |
| spacing | `--s1 … --s10` = 4 8 12 16 24 32 48 64 96 128 px | margins, paddings, gaps |
| grid | `--maxw 1320px`, `--gut` 16 / 24 / 40 px, `--gap` 16 / 24 / 32 px (at 0 / 600 / 1024 px) | `.wrap`, 12 columns |
| radius | `--r 0`, `--r-ctl 2px` | square panels, barely rounded controls |
| art safe zone | `--art-safe-l 20.5vw`, `--art-safe-w 34vw` | where the hero text sits over B/W art (desktop) |

Headlines: weight 700–800, tracking −0.035 to −0.05 em, line-height 0.86–1.0. Labels: mono 11–12 px, uppercase,
tracking 0.12 em, `--fg-3`.

## The page (render-child.js)

```
a.skip                      → #main
header.top (sticky)         .brand (logo 28 px, name, $TICKER) · nav.top-nav (#app #tools #chain #about) · .top-cta
section.hero#top            img.hero-art (B/W art)  |  img.hero-mark (classic art: the old logo in grey)
  .hero-in                  p.hero-k (.tk ticker box + .state) · h1.hero-name(.len-*) · p.hero-pitch · .hero-cta · .ca-chip[data-ca-copy] · .hero-parent
div.figures                 dl: price · market cap · 24 h change · holders (data-k hooks), after a launch only
main#main
  section.app#app[data-app]   01 / The app: .sect-h, .app-body > .app-screen > .app-block.app-<type>
  section.sect#tools          On this site: the generic tools (wall, poll, drop, event, memes, extras)
  section.sect#chain          Check the chain: the token panel + trades, holders, dev watch, fees, alerts
  section.sect#about          Why SUB-01 built it: spec.sections as articles + ul.notes (status, what this is, the copy, the tools, built by, idea by)
footer.foot                 .foot-mark · ul.foot-links · p.foot-word (the name, display size) · .foot-credit
nav.dock                    phones (< 720 px): the primary action + Buy, fixed at the bottom
```

- **The hero's action** (`ctaOf`): `Launch a coin` when the app has a `launch` block; else the submit block's title
  ("Drop your confession", "Add a spot"), else Vote / Check the registry / Open the app; without an app, the first
  generic tool's verb. Secondary: `Buy on pump.fun` only for a mainnet pump.fun launch (link from the verified launch).
- **The pitch** (`pitchOf`): the tagline, unless it is the template's generic "An idea SUB-01 decided to build…"; then
  the idea's first sentence without the leading "Name:", at most 140 characters.
- **The name size** (`nameSize`): `len-m … len-xxl` from the longest word (a word never breaks) and the total length
  (at most three lines). Desktop sizes fit the 34vw art safe zone.
- **Section numbers** follow what the page has (01 The app, 02 On this site…).
- In-page links are `#app #tools #chain #about #main #top`; validateHtml allows `#section` hrefs (and nothing that only
  looks like one).

## Art modes

`context.art` (site.js `siteContext`, from the latest banner asset's type) sets the body class:

- **`art-bw`** (coinart.js PNG banners, 16:9, drawing on the right, left part empty): desktop (≥ 900 px) the picture
  fills the hero (`object-fit: cover`, anchored right) and the text block starts at 20.5vw and is at most 34vw wide;
  tablets show it at 16:10 above the text, phones at 5:4 anchored right. The QA samples the banner under every hero
  text box and fails a page whose words sit on the drawing (docs/SITE-QA.md, `text-over-art`).
- **`art-classic`** (the older SVG banners with the name drawn in): the banner is not repeated; desktop shows the logo
  in grey (`filter: grayscale(1)`) as the mark on the right; phones show no picture. Classic logos are greyed in the
  top bar and the footer too.

The art agent's first B/W hero (inline `BW_CSS` in render-child.js, classes `.banner .head .logo .grad`) is superseded
by this template; the `art-bw` hook and the `./banner.svg` asset URL are unchanged.

## Class contract (keep these stable)

Markup other code relies on, and what each is for:

| Hook | Who uses it |
|---|---|
| `section.tool.card.reveal#tool-<id>[data-tool][data-config]`, `[data-slot]`, `[data-static]` | core.js hydrate; tests |
| `section.app.card.reveal#app[data-app][data-config]`, `[data-app-body]`, `.app-screen[data-screen]`, `.app-block[data-type][data-i]` | kit/app/index.js; tests |
| `.tk` (the ticker, text `$TICKER`), the one `h1` (the name) | core.js memes, kit/app/index.js cards |
| `[data-k=price|mcap|vol|chg|holders|updated]`, `[data-ca]`, `[data-spark]`, `[data-count]`, `[data-map]`, `[data-chart]` | core.js token, event, map, chart |
| `[data-ca-copy]` (hero CA chip) | core.js `chrome()` adds the Copy button |
| `.hero-cta`, `.dock`, `.dock.is-away` | core.js hides the phone bar while the hero action or the app is on screen; site-qa.js CTA check |
| `.hero-art`, `.hero-in` | site-qa.js text-over-art check |
| `h2.sec` "Check the chain" | tests |
| `body.art-bw` / `body.art-classic`, `body.has-dock` | the art modes; the dock padding |
| `.btn` `.btn-primary` `.btn-line` `.btn-ghost` `.btn-sm` `.btn-lg`, `.row`, `.fine`, `.eyebrow`, `.chip(.ok)`, `.msg(.ok/.err)`, `.feed`, `.featured`, `.count`, `.stats/.stat/.stat-k/.stat-v`, `.picker` | every kit module |
| `.ln-*` (launch block) | kit/launch/index.js; styled in app.css in this system |

New markup should use these classes rather than inline styles (the validator refuses `style=` attributes anyway).

## Components

- **Buttons**: 44 px minimum (48 in the dock, 52 `btn-lg`); primary = white with an arrow; secondary = hairline
  outline (`↗` when it leaves the site); hover inverts. Focus ring: 2 px white, 3 px offset, on every control.
- **Panels** (tools, app blocks): no box, a 1 px rule on top (white for tools, `--line-2` for app blocks), the title in
  `--t-xl`, the kind as a mono label.
- **Tables** (trades, holders, dev moves, fees, leaderboard, registry): hairline rows, mono numbers right-aligned,
  `BUY`/`SELL` in state colours, flags as outlined mono tags.
- **Forms**: black fields, 1 px `--line-2` border, 16 px text (no zoom on iOS), counters in mono.
- **Cards the app draws** (receipt, ticket, postcard, poster, badge): paper cards print in black ink, dark ones white.

## Motion (core.js `motionIn`, Motion mini; anime.js for the number tickers)

Hero lines rise 22 px and fade in, 0.8 s, 70 ms stagger, ease `cubic-bezier(.2,.7,.1,1)`; the art fades in over 1.2 s;
sections fade up 16 px when they enter the viewport; new feed rows slide in. `prefers-reduced-motion: reduce` turns all
of it off (CSS animations and transitions too, anime.js is not loaded), and the QA renders with reduced motion.

## Mobile and accessibility

- 360–430 px: one column, 16 px gutters, no horizontal scroll (the QA fails a page that scrolls sideways), the CA chip
  ellipsises instead of wrapping, the sticky bottom action bar (`nav.dock`) carries the main action and Buy.
- Semantic landmarks (`header`, `nav`, `main`, `section`s with labels, `footer`), one `h1`, a skip link, `lang`,
  `aria-label`s on the CA copy button and the nav, `role=status` on every message line the kit writes, `aria-live` on the
  trade feed. Text contrast: everything ≥ 4.5:1 (the QA reports anything under AA).

## Sizes

`site-kit.v2.css` 33.9 KB (7.8 KB gzip, was 5.0 KB for v1); fonts 57.9 KB (Inter 41.3 KB + JetBrains Mono 2 × 8.3 KB;
v1 shipped 87 KB of Archivo + JetBrains Mono). A page's first load: ~66 KB of CSS + fonts, ~22 KB less than before.

## Coordination notes (2026-10-12)

- The child launch block's styles (`.ln-*`) were rewritten here in the system (no gradients, no rounded pills); the
  block's markup is unchanged.
- render-child.js keeps `context.parent` ("Launched at …" under the hero) and the launch block's footer sentence.
- The art agent owns the pictures (coinart.js); the hero owns their placement. Art for new coins should keep its
  drawing right of 54.5% of the width and leave the band between 20% and 54% of the width empty.
