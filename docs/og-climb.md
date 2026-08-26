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
`boardseshRenderQuerySchema` (`@boardsesh/board-render`). All four default
closed, so this endpoint (and web) stay classic-by-default until a later PR
flips it. Every option that affects the output is part of the byte-cache key,
so a boardsesh render can never be served under a classic key. The base cache
is keyed only by board config because overlay options do not change its board
photo backdrop.

| Param          | Default   | Meaning                                                                                                                                       |
| -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `render_mode`  | `classic` | `classic` (today's marker-only overlay) or `boardsesh` (veil + glow on traced silhouettes).                                                      |
| `glow_falloff` | `soft`    | `boardsesh` mode only: glow edge treatment, `soft` or `plateau`.                                                                                 |
| `glyphs`       | off       | `boardsesh` mode only: `0`\|`1`\|`true`\|`false` — role glyphs inside the glow.                                                                   |
| `field_color`  | unset     | `#rrggbb`; feeds the veil color. **No visible effect yet:** opacity is hardcoded to 0 for now — see the `TODO(#2202)` in the callers of `buildRenderConfig` — until `@boardsesh/board-art-geometry` supplies real wall-lightness data. |

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
| `BOARD_RENDER_CONCURRENCY` | `2`                   | Shared concurrency cap for OG and board-image misses, including boot warmups.                                                                                                      |
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
