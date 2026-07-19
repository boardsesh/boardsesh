# Expo on web (Phase 0)

The Expo (React Native) app runs on the web behind `/app`, served through a Next.js rewrite to Metro's browser bundle. This is **Phase 0** — enough to render and authenticate the app in a browser — and it ships with the known limitations below. Auth/WebSocket specifics live in [`websocket-implementation.md`](./websocket-implementation.md#expo-web-token-path-app); this file is the Phase 0 caveat list.

## Known limitations

- **Board render runs on the main thread.** The `@boardsesh/board-renderer-wasm` glue decodes and rasterises on the UI thread, so a heavy board can jank the page. **Fixed in Phase 1** by the off-thread render worker in #3765 (same stack) — once that lands, rendering moves to a Web Worker and this note is obsolete.
- **The WASM glue needs `Function()` / `unsafe-eval`.** The generated glue instantiates the module via `new Function(...)`, so the `/app` surface depends on a CSP that permits `unsafe-eval` (or the absence of a strict `script-src`). A future tightened CSP must add `'wasm-unsafe-eval'`/`'unsafe-eval'` for `/app` or the board renderer breaks. Do not add a strict `script-src` to `/app` without accounting for this.
- **No disk cache for the WASM binary.** The renderer's WASM is fetched fresh per page load (no service-worker or persistent cache in Phase 0), so first paint re-downloads it each time. Acceptable for the authenticated utility surface; revisit if `/app` becomes a high-traffic entry point.

## Scope

`/app` is a locale-neutral **authenticated utility surface**, `noindex`. It is not a search/marketing surface — keep it out of the sitemap and locale routing (see the middleware carve-out and `next.config.mjs` header rules).
