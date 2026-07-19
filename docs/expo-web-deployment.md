# Expo web at /app: dev proxy vs production static serving

The Expo app's browser target is served by the Next.js site under `/app`. There
are two serving modes, both gated on `BOARDSESH_WEB=1` and both keeping the
noindex + security headers that `packages/web/middleware.ts` and
`packages/web/next.config.mjs` attach to every `/app` path.

## Development: proxy to Metro

`vp run dev:mobile:web` starts Metro alongside Next and sets
`BOARDSESH_EXPO_WEB_ORIGIN` to Metro's origin. `next.config.mjs` then installs
`beforeFiles` rewrites that forward `/app`, `/app/wasm/*`, `/app/:path*`,
`/packages/mobile/*`, and `/assets*` to Metro. `beforeFiles` (not the default
phase) so a stale local export sitting in `packages/web/public/app` can never
shadow the live dev server.

## Production: static export served by Next

With `BOARDSESH_WEB=1` and **no** `BOARDSESH_EXPO_WEB_ORIGIN`, `next.config.mjs`
switches to static mode:

- The export artifact lives in `packages/web/public/app` (gitignored), so
  Next — including the standalone `server.js` used by `Dockerfile.web` — serves
  the real files directly: `/app/_expo/*` bundles, `/app/assets/*`,
  `/app/wasm/*`, `/app/index.html`. Content-hashed paths (`_expo`, `assets`)
  get `Cache-Control: immutable`.
- Two afterFiles rewrites (`/app`, `/app/:path*` → `/app/index.html`) give the
  Expo Router SPA its deep-link fallback: any `/app/...` path that is not a
  real file serves the exported shell.

### Artifact flow

`scripts/build-expo-web-export.sh [output-dir]` is the single export recipe
(default output: `packages/web/public/app`). It installs the isolated
`packages/mobile/web-runtime` dependencies when missing (react-native-web and
friends stay out of the native fingerprint graph) and runs
`BOARDSESH_WEB=1 EXPO_NO_WEB_SETUP=1 bunx expo export --platform web`, then
asserts the shell and board-renderer WASM assets landed. Consumers:

- **`Dockerfile.web` (builder stage)** — the deployed path. The generated web
  Docker context includes `packages/mobile` + its workspace deps and this
  script (`scripts/create-service-docker-context.mjs`). The builder runs the
  export into `packages/web/public/app` before `next build`, and the runner
  stage's existing `public/` COPY ships it. `BASE_URL` is forwarded as
  `EXPO_PUBLIC_WEB_URL` (Expo Router head origin); backend/WS URLs use the
  production fallbacks in `packages/mobile/src/lib/env.ts`.
- **`vp run build:expo-web`** — local verification: run it, then
  `BOARDSESH_WEB=1 vp run build:web`, copy `public/` + `.next/static` into the
  standalone output, and `/app` serves exactly like production.
- **`vp run check:mobile-web-bundle`** — CI bundle check; exports to a temp dir
  via the same script.

The Vercel production web deploy (`production-deploy.yml`) does not run the
export step yet; `/app` there simply 404s (see rollback below) until it is
wired up or web serving moves to the Docker image.

### Rollback

Ship a web image without the export: `--build-arg BOARDSESH_WEB=0` on the
`Dockerfile.web` build (or simply don't produce/copy the export in whatever
pipeline builds web). Without the flag the Next build bakes no `/app` rewrites;
without the artifact the SPA fallback rewrite finds no `/app/index.html` and
`/app` 404s. Either way the failure is contained to `/app`: the middleware's
`/app` branch only sets headers and never routes, so the rest of the site is
unaffected. Native apps are untouched — this surface is browser-only and none
of it enters the OTA fingerprint graph.
