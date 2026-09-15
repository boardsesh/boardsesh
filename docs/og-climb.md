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
```

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
