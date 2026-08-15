# Expo on web (Phase 0)

The Expo (React Native) app runs on the web behind `/app`, served through a Next.js rewrite to Metro's browser bundle. This is **Phase 0** — enough to render and authenticate the app in a browser — and it ships with the known limitations below. Auth/WebSocket specifics live in [`websocket-implementation.md`](./websocket-implementation.md#expo-web-token-path-app); this file is the Phase 0 caveat list.

## Known limitations

- **Board render runs on the main thread.** The `@boardsesh/board-renderer-wasm` glue decodes and rasterises on the UI thread, so a heavy board can jank the page. **Fixed in Phase 1** by the off-thread render worker in #3765 (same stack) — once that lands, rendering moves to a Web Worker and this note is obsolete.
- **The WASM glue needs `Function()` / `unsafe-eval`.** The generated glue instantiates the module via `new Function(...)`, so the `/app` surface depends on a CSP that permits `unsafe-eval` (or the absence of a strict `script-src`). A future tightened CSP must add `'wasm-unsafe-eval'`/`'unsafe-eval'` for `/app` or the board renderer breaks. Do not add a strict `script-src` to `/app` without accounting for this.
- **No disk cache for the WASM binary.** The renderer's WASM is fetched fresh per page load (no service-worker or persistent cache in Phase 0), so first paint re-downloads it each time. Acceptable for the authenticated utility surface; revisit if `/app` becomes a high-traffic entry point.

## Scope

`/app` is a locale-neutral **authenticated utility surface**, `noindex`. It is not a search/marketing surface — keep it out of the sitemap and locale routing (see the middleware carve-out and `next.config.mjs` header rules).

## Appearance and large screens

A fresh browser session starts in dark mode. The static HTML shell uses the same black background and
dark `color-scheme`, preventing a white flash before React mounts. An existing Light, Dark, or System
Appearance preference in IndexedDB still wins when preferences hydrate.

Web screens with a physical short side of at least 600 CSS pixels opt into the same Material adaptive
shell as Android tablets. The physical-screen eligibility remains stable while the live browser window
controls the presentation: below 700px uses the phone tab bar, 700–815px uses the navigation rail,
816–1175px adds the persistent play pane, and 1176px+ can add the wall column when a board is bound and
resolved. Resizing only changes the shell chrome; the tab navigator remains mounted.

## Dev loops

Two ways to run the browser app locally — pick by what you're iterating on:

- **`vp run dev:mobile:web`** — Metro dev proxy at `/app` with fast refresh. Cold-bundles on every start (`--clear`), so first paint takes minutes and can outrun the orchestrator's readiness window on a loaded machine (`BOARDSESH_EXPO_WEB_READY_TIMEOUT_MS` extends it). Best for mobile-code iteration.
- **`vp run dev:mobile:web-static`** — bakes the static export (the exact artifact production serves) with the Tailscale origin inlined, then serves it at `/app` from the regular dev stack. No Metro race; open `https://<your-machine>.ts.net:3000/app` from any tailnet device. Mobile-code changes need a re-run; web code hot-reloads. Best for QA/device testing.

Baking gotcha (applies to any manual export): `expo export` reuses Metro's transform cache even when `EXPO_PUBLIC_*` values change, silently shipping the previous env. The static task wipes the cache for you; wipe `"$TMPDIR"/metro-cache` yourself if you invoke `build-expo-web-export.sh` directly with different env. The three origin vars that must be baked: `EXPO_PUBLIC_WEB_URL` (must equal the serving web origin or auth calls go cross-origin), `EXPO_PUBLIC_BACKEND_URL`, `EXPO_PUBLIC_WS_URL`.
