# Climb OG share cards (`GET /og/climb`)

The backend renders the Open Graph card crawlers fetch when someone shares a
climb link. It moved here from the Vercel-hosted web route because Vercel
lambdas paid a cold-start + render cost (~1s TTFB, worse when idle) on every
CDN miss, and platforms like Facebook drop embeds that respond slowly.

## Endpoint

```
GET https://ws.boardsesh.com/og/climb
  ?board_name=kilter          # enum: kilter|tension|moonboard|decoy|touchstone|grasshopper|soill
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

## How a render works

Implementation: `packages/backend/src/services/board-render.ts` +
`src/handlers/og-climb.ts`, on top of the shared `@boardsesh/board-render`
package (`packages/shared/board-render` — also used by the web
`/api/internal/board-render` route, which keeps serving in-app images).

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

| Var                     | Default               | Meaning                                                                                                                                                                            |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOARD_IMAGES_ROOT`     | `<cwd>/../web/public` | Directory containing `images/` (board photos). The backend Docker context ships `packages/web/public/images` via `extraSourceDirs` in `scripts/create-service-docker-context.mjs`. |
| `OG_BYTE_CACHE_MB`      | `32`                  | Byte budget for the final-image LRU.                                                                                                                                               |
| `OG_BASE_CACHE_ENTRIES` | `24`                  | Entry budget for the per-board-config base LRU (~3MB raw RGBA each).                                                                                                               |

## Cache prewarming (why the endpoint sees browser-initiated hits)

Crawlers scrape seconds after a share, so clients prime the caches ahead of
them: climb view SSR fire-and-forgets one og render per page view (via
`scheduleOverlayWarming`), and the Share button on web and mobile fetches both
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

## Cloudflare in front of ws.boardsesh.com (edge-caching the og image)

`ws.boardsesh.com` is a single-region Railway origin; distant clients (and the
iOS share sheet, which fetches previews from the sender's phone) pay full RTT
per image. Fronting it with Cloudflare edge-caches the immutable og responses
globally.

The zone config is managed from the repo — not dashboard clicks — by
`scripts/cloudflare-apply.ts` (registered as `vp run cf:apply`). The desired
state is declared in `infra/cloudflare/config.ts`; the script diffs it against
the live zone and, with `--apply`, converges only the delta (idempotent, so a
second run is a no-op).

What it manages (and nothing else on the zone):

- **DNS** — the `ws` record's proxied flag → orange cloud. The record's
  target/type/content are not managed; the record must already exist.
- **Cache** — one rule in the `http_request_cache_settings` phase, expression
  `(http.host eq "ws.boardsesh.com" and starts_with(http.request.uri.path, "/og/"))`
  → eligible for cache, edge TTL "use cache-control if present, bypass if not"
  so error responses (400/429/503 — sent without Cache-Control) are never
  edge-cached, and browser TTL "respect origin" (successful responses are `immutable`,
  1y). Every other rule already in that phase is preserved verbatim (the tool
  finds its own rule by a stable description marker and touches only that one),
  so `/graphql`, REST, and WebSocket upgrades keep bypassing cache.
- **SSL** — asserts the zone SSL/TLS mode is `strict` (Full (strict); Flexible
  causes redirect loops with Railway). If the zone-wide mode is weaker the tool
  **reports it but does not change it** — the setting affects every hostname on
  `boardsesh.com`. Pass `--allow-zone-ssl` to opt into setting it.

Code prerequisite (shipped): the og rate limiter prefers `CF-Connecting-IP`, so
per-client buckets survive the proxy hop.

### One-time: create the API token

Create a token at <https://dash.cloudflare.com/profile/api-tokens> scoped to the
`boardsesh.com` zone with:

- **Zone.Zone Read** — resolve the zone id by name + read the zone list
- **Zone.DNS Edit** — patch the `ws` record proxied flag
- **Zone.Cache Rules Edit** — create/update the `/og/` cache rule
- **Zone.Zone Settings Read** — read the SSL/TLS mode
- **Zone.Zone Settings Edit** — only if you'll run `--allow-zone-ssl`

### Flip runbook

```bash
# 1. Dry-run (default) — prints the diff, exits non-zero if there's drift. Never mutates.
CLOUDFLARE_API_TOKEN=... vp run cf:apply

# 2. Apply — performs only the needed mutations.
CLOUDFLARE_API_TOKEN=... vp run cf:apply -- --apply

# (optional) also set the zone-wide SSL mode when it's weaker than strict:
CLOUDFLARE_API_TOKEN=... vp run cf:apply -- --apply --allow-zone-ssl
```

`CLOUDFLARE_ZONE_ID` is optional — when unset, the zone id is resolved by name.

Confirm WebSockets are enabled for the zone (Network tab; on by default on
current plans). WebSocket caveat: the cache rule scopes to `/og/` only, so
`wss://ws.boardsesh.com/graphql` upgrades and every other path continue to pass
straight through to Railway.

### Verify

`wss://ws.boardsesh.com/graphql` still connects (web party mode + mobile app);
`curl -sI 'https://ws.boardsesh.com/og/climb?...'` twice — the second response
shows `cf-cache-status: HIT`.

### Rollback

Set `proxied: false` on the `ws` record in `infra/cloudflare/config.ts` and
`vp run cf:apply -- --apply`, or grey-cloud the record in the dashboard.

- Web points `og:image` here via `buildOgBoardRenderUrl`
  (`packages/web/app/components/board-renderer/util.ts`), which derives the
  backend origin from `NEXT_PUBLIC_WS_URL`.
