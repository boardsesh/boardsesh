# Climb OG share cards (`GET /og/climb`)

The backend renders the Open Graph card crawlers fetch when someone shares a
climb link. It moved here from the Vercel-hosted web route because Vercel
lambdas paid a cold-start + render cost (~1s TTFB, worse when idle) on every
CDN miss, and platforms like Facebook drop embeds that respond slowly.

## Endpoint

```
GET https://ws.boardsesh.com/og/climb
  ?board_name=kilter          # enum: kilter|tension|moonboard|decoy|touchstone|grasshopper|soill|woods
  &layout_id=1
  &size_id=10
  &set_ids=1,20               # canonicalised (sorted + deduped) by the zod schema
  &frames=p1080r15p1202r12    # fully determines the image — no DB involved
  &format=jpeg                # optional; jpeg (default) | png | webp
  &n=BING+BANG+BOSH           # optional; climb name, <=64 code points after normalising
  &g=7a/V6                    # optional; grade label, [A-Za-z0-9+/. -]{1,16}
  &s=Patrick+Gosling          # optional; setter, <=32 code points after normalising
  &angle=40                   # optional; 0-90
```

### The climb-identity column

The card is 1200x630: the board art right-aligned in a 720x602 box on the left,
and the climb's identity in a 392px column on the right. Both halves matter for
different consumers — a social unfurl shows the whole card, while a search engine
crops it to a square from the centre and keeps only `x` in [285, 915]. Right-
aligning the board is what puts a portrait board fully inside that crop;
`og-geometry.test.ts` walks the catalogue and fails if a board ever renders
smaller than the old full-width layout or spills into the column.

`n`, `g`, `s` and `angle` are all **optional**, so a URL built by an
already-shipped mobile binary still renders — it just gets the board on its own.
The board line under the name (`Kilter · Original · 12 x 12 Square`) is derived
from `board_name`/`layout_id`/`size_id`, not taken as a param: those already
determine the board that gets drawn, so a caller-supplied label would be a
second, forgeable source for the same fact.

Ascents and quality are deliberately **not** on the card. They tick constantly,
and the response is immutable for a year, so every tick would mint a fresh cache
entry and leave the old one at the edge.

**Two things to know before touching the text path.**

1. **Every string must be escaped for Pango markup.** libvips calls
   `pango_parse_markup` unconditionally — there is no plain-text mode — so an
   unescaped `&` throws `text: invalid markup in text` rather than rendering
   literally. A climb called "Rock & Roll" would be a 500. `escapePangoMarkup`
   in `validation.ts` is the only safe way in.
2. **The image needs fonts installed.** `Dockerfile.backend` is `node:22-alpine`,
   which ships none, and Pango does not degrade gracefully without them: a 40pt
   request renders 12px tall, Cyrillic comes back blank, and CJK throws. The
   image installs `fontconfig font-noto font-noto-emoji font-noto-hebrew
   font-wqy-zenhei` — sized against what real climb names contain, which includes
   Japanese katakana, Chinese and emoji. `font-wqy-zenhei` covers CJK for 27 MB
   where `font-noto-cjk` costs 90 MB for a visually identical result.

`n` and `s` are the only caller-supplied free text on the endpoint, which is
unauthenticated. They are NFC-normalised, stripped of control characters and of
the invisible/bidi-override set, whitespace-collapsed, and truncated by code
point. `OG_CARD_TEXT_DISABLED=1` drops both without a deploy; the board, grade
and angle keep rendering.

Responses are immutable (`Cache-Control: … immutable`, 1 year): the query
fully determines the bytes. Invalid params are rejected with 400 before any
render CPU runs; per-IP rate limit is 120/min (fails open to the in-memory
limiter when Redis is down). `Server-Timing` breaks down wasm/base/encode ms
and reports the cache outcome (`hit` | `base-hit` | `miss`).

### Render-mode params (issue #2202)

Optional, shared with the web `/api/internal/board-render` route via
`boardseshRenderQuerySchema` (`@boardsesh/board-render`). `render_mode` defaults
to `aura`, the drawing the app has shipped since 2.4; the rest default closed.
Every option that affects the output is part of the byte-cache key, so an aura
render can never be served under a classic key. The base cache is keyed only by
board config because overlay options do not change its board photo backdrop.

**Every Boardsesh caller sends `render_mode` and `field_color` explicitly**, even
though the endpoint would default to them. The query string is the Cloudflare
cache key and a card is cached `immutable` for a year, so a response already at
the edge under a bare URL cannot be re-drawn in place — changing the drawing has
to change the URL. The default is for the callers we do not control: a store
binary from before the change that prewarms a bare URL, and any third party
embedding the endpoint.

An `aura` render here draws exactly what the app draws. The look's tuning —
glow reach, the seam crossfade, the veil buckets, the fill alpha — lives in
`@boardsesh/board-look` and is applied by `buildAuraRenderFields`, which the
mobile native path and this pipeline both call with the board name. Woods receives
a 1.2 reach multiplier, composed with the saved setting, in both paths. The per-hold half (traced
silhouettes, LED plates, silhouette lightness) is read per board config from
`@boardsesh/board-art-geometry`; a config the tracer skipped still renders, with
every hold glowing a ring at its placement radius.

| Param          | Default   | Meaning                                                                                                                                       |
| -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `render_mode`  | `aura`    | `aura` (veil + glow on traced silhouettes — the app's own drawing) or `classic` (the marker-only overlay).                                  |
| `glow_falloff` | `soft`    | `aura` mode only: glow edge treatment, `soft` or `plateau`.                                                                                 |
| `glyphs`       | off       | `aura` mode only: `0`\|`1`\|`true`\|`false` — role glyphs inside the glow.                                                                   |
| `field_color`  | unset     | `#rrggbb`: the play field the veil washes the unlit wall toward. Unset means the light field, on which every board's wall is darker than the field, so `veilOpacityFor` turns the veil off. www and the share cards send `#181225`, the dark field the app's play view composites over. |

## How a render works

Implementation: `packages/backend/src/services/board-render.ts` +
`src/handlers/og-climb.ts`, on top of the shared `@boardsesh/board-render`
package (`packages/shared/board-render`). The same backend service also serves
in-app images at `/render/board` and the compatibility alias
`/api/internal/board-render`.

1. WASM (`@boardsesh/board-renderer-wasm`) renders the hold overlay — eagerly
   initialised at server boot, so requests never pay init. If boot init failed
   (transient I/O), requests re-attempt init at most every 30s; until it
   succeeds the endpoint returns 503.
2. The 1200×630 backdrop + board photos are composited once per board config
   and cached as raw RGBA (**base cache**, LRU, 24 entries by default). The
   fallback preview config for every supported board is pre-warmed after boot.
   Warmups share the render cap but use a low-priority queue, so queued request
   work takes the next available slot between board warmups.
3. Overlay is composited onto the base and encoded — JPEG by default
   (mozjpeg, quality 85, 4:4:4 chroma), ~50–80KB.
4. Final bytes land in the **byte cache** (LRU, 32MB by default), so repeat
   fetches (FB, Twitter, WhatsApp, Slack each fetch independently) are served
   from memory.

Steady-state timings: ~250ms for a new climb on a warm board config, ~0ms for
repeats, ~700ms worst-case first render of a never-seen board config.

## Env vars

| Var                        | Default               | Meaning                                                                                                                                                                            |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOARD_IMAGES_ROOT`        | `<cwd>/../web/public` | Directory containing `images/` (board photos). The backend Docker context ships `packages/web/public/images` via `extraSourceDirs` in `scripts/create-service-docker-context.mjs`. |
| `BOARD_RENDER_CONCURRENCY` | `2`                   | Shared concurrency cap for OG and board-image misses, including low-priority boot warmups.                                                                                         |
| `BOARD_RENDER_MAX_QUEUE`   | `40`                  | Maximum unique render misses waiting behind the shared semaphore before a `503` with `Retry-After: 5`.                                                                             |

## Cache prewarming (why the endpoint sees browser-initiated hits)

Crawlers scrape seconds after a share, so clients prime the caches ahead of
them: climb view SSR fire-and-forgets one OG render per page view (via
`scheduleOgImageWarming`), and the Share button on web and mobile fetches both
the share page URL and the og image URL before opening the share sheet. All
best-effort — failures are swallowed and never delay sharing.

## Operational notes

- Winston logs one line per render: `[OGClimb] served` with
  `{ boardName, layoutId, sizeId, cache, totalMs, wasmMs, encodeMs, bytes, format }`;
  renders over 1s log at `warn`.
- A missing images directory logs an error at boot and cards render
  backdrop-only (no board photo) rather than failing.
- Quick prod check:
  `curl -o /dev/null -s -w 'code=%{http_code} ttfb=%{time_starttransfer}s\n' 'https://ws.boardsesh.com/og/climb?board_name=kilter&layout_id=1&size_id=10&set_ids=1,20&frames=p1080r15p1202r12'`

## Cloudflare edge layer

`ws.boardsesh.com` is fronted by the Cloudflare proxy so og images edge-cache
globally (distant clients and the iOS share sheet fetch from a nearby colo
instead of the single-region Railway origin). The zone config, the apply
tooling (`vp run cf:apply`), token setup, CI auto-apply, and the rollback
runbook all live in **`docs/cloudflare.md`**.

- Web points `og:image` here via `buildOgBoardRenderUrl`
  (`packages/web/app/components/board-renderer/util.ts`), which derives the
  backend origin from `NEXT_PUBLIC_WS_URL`.

## Spray walls (`board_name=spray`)

A spray-wall card is the one response on this endpoint the query string does not
determine. Every catalogue board's backdrop ships in the repo and its hold
positions come from generated constants; a wall has neither. Its background is a
photograph in object storage and its holds live in `spray_wall_holds`, so
`GET /og/climb?board_name=spray&layout_id=…&frames=…` is answered from the
database — `packages/backend/src/services/spray-og-card.ts`, reached from a
branch in `handlers/og-climb.ts` that runs before the WASM availability check
(no WASM is involved, so a renderer that failed to boot must not 503 it).

**Public walls only.** A wall that is private, unlisted, soft-deleted, has never
published a version, or has no `public_photo_key` gets a 404, and every one of
those answers is the same 404 with the same body. The gates all run before a
single photo byte is read. Unlisted is not an exception: an unlisted wall is
reachable by uuid inside the app because the uuid is a capability the reader
holds, and a crawler fetching an OG image holds nothing — "hard to guess" would
be the whole access control.

**404, never 403.** Layout ids are sequential and this URL is guessable, so any
answer other than "there is nothing here" — a 403, a generic board card, a
different error shape — tells a stranger which ids are somebody's home wall.
A private wall and a nonexistent one are indistinguishable from outside.

**The 404 is never cached** (`Cache-Control: no-store`). A wall its owner makes
public tomorrow must not stay a 404 at the edge, and a cached negative on a
shareable URL is exactly the failure this document and the sitemap doctrine both
warn about.

**The 200 is daily, not `immutable`.** Every other card here carries a year of
`immutable` because its bytes follow from the query. A wall's do not: a reset
re-points the photograph and rewrites the holds under an unchanged `layout_id` +
`frames`, so an immutable header would pin last year's wall at the edge with no
URL left to change. `createOgImageHeaders({ version: null, unversionedTier:
'daily' })` gives it a day of freshness and a week of stale-while-revalidate.
The in-process byte cache is keyed on the wall's published version AND its photo
key, because a reset moves the version while the key may not and a
demote-then-re-promote mints a new random key while the version does not.

**The photo is the public copy, never a presigned URL.** Wall photos live in the
`private` bucket behind 15-minute signatures (`docs/spray-walls.md`, "Photo
privacy"). An unfurler cannot hold a signature and this card is cached for a day,
so the only thing this path will fetch is the world-readable `media` copy SW-14
writes when a wall is promoted to public.

**It shares the render cap.** `BOARD_RENDER_CONCURRENCY` is the cap for "OG and
board-image misses", and a wall's card is another miss: sharp decoding and
compositing a phone photograph is the same kind of work as the WASM overlay, so
it queues in the same semaphore (`runOnRenderSemaphore`) rather than a second
one that would double the real concurrency. A saturated queue answers the same
`503` + `Retry-After: 5` the catalogue path does. The guard wraps only the
expensive half — the visibility gates and the byte-cache lookup run outside it,
so a private wall is refused without spending a slot and a hot card never queues
behind a cold render.

**A missing object is a 404, not a 500.** A promoted wall can lose its public
copy: `deletePublicWallPhoto` is best-effort, a demote-then-re-promote mints a
new key, and `refreshPublicWallPhoto` has a catch path that leaves the row
pointing at an object that is gone. A non-2xx from the bucket, a fetch that
misses the 8s deadline, an object over the 12MB ceiling, and bytes sharp cannot
decode all become the ordinary `not-found` (`SprayPhotoUnavailableError`) — a
500 on a link somebody already posted is the worse answer, and a distinct "the
wall is real but its photo is missing" status would confirm the wall exists. A
genuine server fault — a database error, a bug — is not that error and still
answers 500.

**The drawing is sharp + SVG, not the WASM overlay.** The shared pipeline's image
resolver is synchronous and reads the local filesystem, which a photograph
fetched over HTTP can never satisfy, and its overlay draws a catalogue board's
fixed geometry. So this path resizes the photo `fit: 'inside'` into the 1200×630
field (`#181225`, the same play field), centres it, and composites one SVG mark
per lit hold: the hold's traced silhouette as a polygon when
`spray_wall_holds.outline` has one, a circle at its mapped radius when it does
not — the same ring fallback the rest of the render path uses. Canonical
coordinates reach photo pixels through `invert()` of the version's stored
homography; a matrix that turns out singular logs at `warn` and renders the photo
with no overlay, because a card with no holds is a worse card and a 500 on a link
somebody already posted is a broken one.
