# Expo web deployment: dev /app proxy vs prod subdomain (app.boardsesh.com)

The Expo app's browser target ships in two serving shapes, both gated on
`BOARDSESH_WEB=1`:

- **Development** — Next proxies `/app` to the live Metro dev server.
- **Production (target)** — a standalone static export served at the **root of
  `app.boardsesh.com`** (its own subdomain / static host / CDN).

The export's base URL is the only difference between the two production shapes,
and it is driven by `BOARDSESH_WEB_BASE_URL` (read by `resolveWebPlatforms` in
`packages/mobile/app.config.ts`, default `/app`). That env var is only read when
`BOARDSESH_WEB=1`, so native builds (flag unset) resolve a byte-identical config
and keep their OTA fingerprint.

> The older **`/app` prod-static** path (Next serving the export out of
> `packages/web/public/app`) still works and is documented below, but the
> subdomain root is the deployment target. New work should build the subdomain
> export; the `/app` path is kept for the dev proxy and as a fallback.

## Development: proxy to Metro

`vp run dev:mobile:web` starts Metro alongside Next and sets
`BOARDSESH_EXPO_WEB_ORIGIN` to Metro's origin. `next.config.mjs` then installs
`beforeFiles` rewrites that forward `/app`, `/app/wasm/*`, `/app/:path*`,
`/packages/mobile/*`, and `/assets*` to Metro. `beforeFiles` (not the default
phase) so a stale local export sitting in `packages/web/public/app` can never
shadow the live dev server. The dev export keeps `baseUrl` `/app`.

## Production (target): standalone subdomain at app.boardsesh.com

The browser app is exported with `BOARDSESH_WEB_BASE_URL=/` so every asset and
route is rooted at the origin, then served as a plain static directory at the
root of `app.boardsesh.com` by a static host / CDN / Vercel project. Next is not
in this path — the subdomain is its own deployment.

### Building the artifact

```
bash scripts/build-expo-web-export.sh --subdomain
# → packages/web/public/app-standalone (gitignored), baseUrl /
```

`--subdomain` sets `BOARDSESH_WEB_BASE_URL=/` and defaults the output to
`packages/web/public/app-standalone`; pass an explicit output dir as a trailing
arg to point it elsewhere (a CI artifact dir, a deploy staging path). The recipe
is otherwise identical to the `/app` build: it installs the isolated
`packages/mobile/web-runtime` deps (react-native-web stays out of the native
fingerprint graph), runs `BOARDSESH_WEB=1 BOARDSESH_WEB_BASE_URL=/
EXPO_NO_WEB_SETUP=1 bunx expo export --platform web`, and asserts the shell +
board-renderer WASM assets landed.

The export always passes `--clear` to wipe Metro's transform cache first.
`expo export` reuses that cache across `EXPO_PUBLIC_*` env changes — it does
not key on env — so a rebuild with a different backend/WS URL can silently
ship a bundle with the _previous_ build's values baked in. Every caller of
this script builds the artifact once (Docker builder stage, CI deploy, the
bundle check), so the cache buys nothing and the staleness risk is real.
Deploy pipelines should also set `BOARDSESH_EXPORT_EXPECT_URLS` (space-
separated substrings, e.g. `"https://ws.boardsesh.com https://www.boardsesh.com"`)
so the script greps the emitted JS bundles for each expected origin and fails
loudly if one is missing — the direct detector for a stale-env artifact
reaching production.

### What the host must do

- **Serve the export directory at the origin root.** `index.html`, `_expo/*`,
  `assets/*`, and `wasm/*` are all referenced from `/` (not `/app`).
- **SPA fallback: any path that is not a real file → `/index.html`.** Expo
  Router is a single-page app; deep links like
  `https://app.boardsesh.com/auth/callback?transferToken=…` (the sibling CTA
  redirect) must serve the exported shell, not 404. On Vercel this is a
  `cleanUrls`/rewrite-to-`/index.html` catch-all; on nginx it's
  `try_files $uri /index.html;`; on S3+CloudFront it's the 404 → `/index.html`
  error-document mapping.
- **Immutable caching for content-hashed assets.** `_expo/*` and `assets/*` are
  content-hashed and can be cached forever (`Cache-Control: immutable`);
  `index.html` and `wasm/*` (fixed names) should not.

### Cross-origin backend

Because the app runs on `app.boardsesh.com` and the backend on
`ws.boardsesh.com` (`EXPO_PUBLIC_BACKEND_URL`), the browser session exchange
(`POST /auth/native/exchange`), GraphQL, and token refresh are all cross-origin.
The backend CORS allow-list (`packages/backend/src/handlers/cors.ts`) includes
`https://app.boardsesh.com` (configurable via `APP_ORIGIN`, prod default) plus
its numbered preview form `https://{N}.app.boardsesh.com`. No auth token is ever
persisted in the browser's AsyncStorage.

### Infra follow-ups (not provisioned here)

These are DNS / hosting operations outside this repo's build:

1. **DNS** — point `app.boardsesh.com` at the static host / CDN / Vercel
   project.
2. **Static host** — a project (Vercel static / S3+CloudFront / nginx) that
   serves the `--subdomain` export at root with the SPA fallback above.
3. **Deploy wiring** — produce the `--subdomain` export in whatever pipeline
   publishes the subdomain and upload it (the artifact is `baseUrl /`, distinct
   from the `/app` export the web Docker image bakes).
4. **Backend env** — set `APP_ORIGIN` if the app is ever served from a non-prod
   origin (defaults to `https://app.boardsesh.com`).

## Legacy production: static export served by Next at /app

Superseded by the subdomain target above, still functional. With
`BOARDSESH_WEB=1` and **no** `BOARDSESH_EXPO_WEB_ORIGIN`, `next.config.mjs`
switches to static mode:

- The export artifact lives in `packages/web/public/app` (gitignored), so
  Next — including the standalone `server.js` used by `Dockerfile.web` — serves
  the real files directly: `/app/_expo/*` bundles, `/app/assets/*`,
  `/app/wasm/*`, `/app/index.html`. Content-hashed paths (`_expo`, `assets`)
  get `Cache-Control: immutable`.
- Two afterFiles rewrites (`/app`, `/app/:path*` → `/app/index.html`) give the
  Expo Router SPA its deep-link fallback: any `/app/...` path that is not a
  real file serves the exported shell.

### Artifact flow (/app)

`scripts/build-expo-web-export.sh [output-dir]` (no `--subdomain`) is the `/app`
export recipe (default output: `packages/web/public/app`, baseUrl `/app`).
Consumers:

- **`Dockerfile.web` (builder stage)** — the deployed `/app` path. The generated
  web Docker context includes `packages/mobile` + its workspace deps and this
  script (`scripts/create-service-docker-context.mjs`). The builder runs the
  export into `packages/web/public/app` before `next build`, and the runner
  stage's existing `public/` COPY ships it. `BASE_URL` is forwarded as
  `EXPO_PUBLIC_WEB_URL` (Expo Router head origin); backend/WS URLs use the
  production fallbacks in `packages/mobile/src/lib/env.ts`.
- **`vp run build:expo-web`** — local verification: run it, then
  `BOARDSESH_WEB=1 vp run build:web`, copy `public/` + `.next/static` into the
  standalone output, and `/app` serves exactly like production.
- **`vp run check:mobile-web-bundle`** — CI bundle check; exports to a temp dir
  via the same script (default `/app` base URL).

The Vercel production web deploy (`production-deploy.yml`) does not run the
export step; `/app` there simply 404s (see rollback below) until it is wired up
or web serving moves to the Docker image / the subdomain host.

### Rollback

Ship a web image without the export: `--build-arg BOARDSESH_WEB=0` on the
`Dockerfile.web` build (or simply don't produce/copy the export in whatever
pipeline builds web). Without the flag the Next build bakes no `/app` rewrites;
without the artifact the SPA fallback rewrite finds no `/app/index.html` and
`/app` 404s. Either way the failure is contained to `/app`: the middleware's
`/app` branch only sets headers and never routes, so the rest of the site is
unaffected. Native apps are untouched — this surface is browser-only and none
of it enters the OTA fingerprint graph. The subdomain deployment is independent:
taking `app.boardsesh.com` offline is a DNS/host operation and never touches the
main site or native apps.
