# Web board image rendering

The Next.js website displays board images from the backend WASM renderer. It does
not initialize browser WASM, create rendering workers or replace images with a
canvas after hydration. The backend runs the shared Rust renderer and sharp once
for a cache miss; Cloudflare and the browser reuse the resulting images.

## Rendering flow

1. `BoardImageLayers` builds versioned image URLs using the existing board configuration,
   flattened climb frames, render mode and thumbnail size.
2. The browser requests the image from `https://ws.boardsesh.com/render/board`.
   Local development uses the same-origin compatibility rewrite.
3. Cloudflare serves a cached response or forwards a miss to the backend.
4. The backend's bounded in-memory cache and in-flight deduplication avoid repeated
   WASM/sharp work for concurrent misses.
5. React keeps the same image elements after hydration. A climb change updates the
   image URL; no renderer binary or JavaScript glue is downloaded by Next.js pages.

## Image composition

Ordinary catalog boards use one backend-rendered composite image with board art
and the climb's holds. Boards with light/dark art use static photo layers and one
transparent backend overlay, so changing theme does not render every climb twice.
Mirroring is a CSS transform and does not create another render-cache variant.

Thumbnails retain their dimensions, lazy loading and fetch-priority hints. Kiosk
live presence updates change the same contain-fit raster image URL used by the
server seed. The bare-board URL also uses the backend, so clearing a wall preserves
the renderer’s background treatment. The
browser's native image cache reuses a render when a previously shown climb returns.

## Cache contract

Every URL includes the generated `BOARD_RENDER_VERSION`. Successful versioned
responses are public and immutable for one year; unversioned responses use the
existing daily tier. The Cloudflare cache rule explicitly includes `/render/board`
and honors the origin's cache headers. The full query remains in the cache key:
board configuration, frames, thumbnail size, render mode and version identify
separate images. Errors and renderer saturation must not enter the shared cache.

A renderer, board-geometry or board-art change regenerates the version rather than
purging immutable URLs. See [Cloudflare](cloudflare.md) for the edge rule and
verification, and [Open Graph climb rendering](og-climb.md) for the shared backend.

## Other clients and compatibility assets

The Expo browser app has its own renderer worker and is outside this Next.js
change. Mobile/native rendering is unchanged. The legacy files under
`packages/web/public/wasm/` remain for existing browser tabs and the current
mobile-web artifact-parity checks, but no Next.js browser module imports them.
They are not published through the image CDN catalog.

## Key files

| File | Purpose |
| --- | --- |
| `packages/web/app/components/board-renderer/board-image-layers.tsx` | Stable images for SSR and hydrated pages |
| `packages/web/app/components/board-renderer/util.ts` | Versioned image URLs and composition rules |
| `packages/web/app/components/kiosk/board-slot/board-slot.tsx` | Live kiosk image updates |
| `packages/backend/src/handlers/board-render.ts` | Public HTTP validation, cache headers and CORS |
| `packages/backend/src/services/board-render.ts` | Shared WASM/sharp pipeline, caches and load shedding |
