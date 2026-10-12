# Coin art (since 2026-10-12)

Every NEW coin gets two logo+banner options in the owner's black-and-white style: one thick white letter (the coin
name's initial) on pure black, with ONE pictogram of the idea's subject built into its counter or set into its
stroke; the banner is 16:9 black with the same mark large on the right, thin rules, a faint dot grid and empty
space for the title. Coins made before keep their art (`art/1`, SVG banner).

Code: `src/coinart.js` (providers, prompts, owner art, the step), `src/coinart-render.js` (local generator,
SVG sanitiser, rasteriser; resvg + the bundled Outfit font, OFL), `src/coinart-glyphs.js` (keyword table en/it/ja
romaji -> pictogram; extend `KEYWORDS`), `src/art-choice.js` (the author's pick), migration `017_art_candidates.sql`.

## Order

1. **Owner-supplied art**: `art/<dir>/logo.(svg|png)` (+ `banner.*`, else composed around the logo) for a coin
   whose ticker or slug matches the directory name or its `match.json`, and only when the idea's wallet is in
   `match.json` `wallets` or, without that list, in `ADMIN_WALLETS`. It becomes option 1. `art/qwave/` = Q-wave.
2. **Higgsfield** when `HF_API_KEY_ID` + `HF_API_KEY_SECRET` are set; else **Recraft** when `RECRAFT_API_KEY` is.
3. **Local generator** (no AI) for anything missing, and for every option on any provider error or after
   `ART_TIMEOUT_MS` (45 s). The public audit line of the build says who drew each option and what fell back.

Stored: logo PNG 512x512, banner PNG 1500x844 (`assets.mime` = `image/png`), `assets.generator` = JSON with
provider, model, request id, prompt and symbol. Paths are unchanged (`/meta/<slug>/logo-vN.png`,
`/meta/<slug>/banner-vN.svg`, `./banner.svg` on the coin site): the body is served with its stored type.

## What the owner sets

| Variable | Default | Notes |
| - | - | - |
| `HF_API_KEY_ID`, `HF_API_KEY_SECRET` | – | from console.higgsfield.ai (API keys) |
| `HF_LOGO_MODEL`, `HF_BANNER_MODEL` | `recraft/v4.1/text-to-image` | the endpoint path after `https://api.higgsfield.ai/` |
| `HF_PARAMS` | – | JSON merged into the body, for an endpoint that takes extra fields |
| `RECRAFT_API_KEY`, `RECRAFT_MODEL` | – , `recraftv4_1_vector` | Recraft's own API (SVG output, $0.08/image) |
| `ART_PROVIDER_BANNERS` | `0` | `1`: ask the provider for banners too; `0`: compose them around the logo (always a matching pair, half the cost) |
| `ART_PRICE_USD_PER_IMAGE` | `0` | budget accounting (`spend.kind = 'art'`) |
| `ART_TIMEOUT_MS` | `45000` | the whole art step; then the local generator |

### Higgsfield: what was checked (2026-10-12)

- REST API: `POST https://api.higgsfield.ai/<endpoint>`, `Authorization: Key <id>:<secret>`, `Idempotency-Key`,
  returns `request_id` + `status_url`; poll until `completed|failed|nsfw|canceled`; result `images[].url`
  (kept at least 7 days; we copy the bytes). Failed and NSFW requests are not charged.
- Recraft V4.1 is documented on the REST API as four **raster** endpoints: `recraft/v4.1/text-to-image` (1k),
  `recraft/v4.1/pro/text-to-image` (2k), `recraft/v4.1/utility/text-to-image`, `recraft/v4.1/utility/pro/text-to-image`.
  Body: `prompt`, `resolution`, `aspect_ratio` (`1:1`, `16:9`, …), `output_format` (`jpg|png|webp`), `colors`
  and `background_color` as `{"rgb":[r,g,b]}`; `additionalProperties: false`, no image count, **no `model_type`**.
- The **vector** variant that drew the reference q (`model_type: "vector"` in Higgsfield's MCP) is **not** in the REST
  docs, and the console's playground has no `recraft/v4.1/vector/…` page (404). So the default is the raster
  endpoint with a PNG output and the B/W palette; the server rasterises and greys whatever comes back.
- To check in the console with the key: whether the catalog lists a Recraft V4.1 **vector** endpoint. If it does,
  set `HF_LOGO_MODEL` to its path (and `HF_PARAMS` if it wants `{"model_type":"vector"}`); an SVG result is
  sanitised (no script, foreignObject, image, external href/url(), handlers, entities: rejected whole) before use.
- One request per image (the schema has no count), two requests per coin, each with its own stable idempotency key:
  a retried build job gets the same requests back instead of paying again.
