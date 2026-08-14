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
`ws.boardsesh.com` (`EXPO_PUBLIC_BACKEND_URL`), GraphQL and authenticated API
requests are cross-origin.
The backend CORS allow-list (`packages/backend/src/handlers/cors.ts`) includes
`https://app.boardsesh.com` (configurable via `APP_ORIGIN`, prod default) plus
its numbered preview form `https://{N}.app.boardsesh.com`. No auth token is ever
persisted in the browser's AsyncStorage.

### Browser authentication

Expo web shares the NextAuth session cookie issued by `www.boardsesh.com`; it
does not use the native transfer-token or refresh-token flow. Credentials calls
the narrowly CORS-enabled NextAuth endpoints on www, then
`packages/mobile/src/lib/auth-store.web.ts` reads the HttpOnly session through
`/api/auth/session` and keeps the backend JWE from `/api/internal/ws-auth` in
memory only.

Google and Apple buttons use the same browser NextAuth providers as the classic
web app. They navigate to `/auth/native-start` on www, which performs the
CSRF-backed provider POST, and pass the initiating Expo export as the callback:
`/app` for the same-origin build or `/` for `app.boardsesh.com`. The NextAuth
redirect allow-list accepts only the configured app origin and numbered app
previews, and the shared `.boardsesh.com` session cookie is available when the
Expo export reloads.

### Signed-out read-only routes (the `?next=` return)

The Next front door on `www` links every climb page into `app.boardsesh.com` at
the same path. The browser export serves those paths to visitors who have never
signed in, so the climb survives the login round trip.

Relaxed shapes (`packages/mobile/src/lib/routing/read-only-routes.ts`), matched
on shape only — never against the board catalogue, so a URL whose board is gone
reaches that route's own not-found rather than a login wall:

- `/b/{slug}`, `/b/{slug}/{angle}/list`, `/b/{slug}/{angle}/{view|play}/{climb}`
- `/{board}/{layout}/{size}/{sets}/{angle}/list` and `…/{angle}/{view|play}/{climb}`
- every one of the above under an `/es`, `/fr` or `/de` prefix — web keeps the
  locale in the path, those URLs match no Expo route, so the matcher runs
  `stripLocalePrefix` first

**Native is untouched.** The relaxation lives in `anonymous-auth-gate.web.ts`;
the native fork `anonymous-auth-gate.ts` is a constant module (`false`,
`() => false`, `() => '/auth/login'`, `() => null`), so the gate in
`auth-provider.tsx` behaves exactly as it does on the store fleet today. Every
merge to `main` touching `packages/mobile/**` auto-publishes a production OTA
onto every installed binary, which is why this is a fork rather than a
`Platform.OS` check — and why both the module's inertness and the rendered gate
are asserted by test.

A relaxed route mounts, discovers it needs an account, and hands off to
`/auth/login?next=<path>` rather than resolving anything anonymously: the
config-tuple form mints a `UserBoard` through `createBoard`, which is
`requireAuthenticated`. `auth-required` is therefore the terminal status for
every relaxed route today, and the visitor lands on the climb after signing in.

`next` passes two independent gates before it is followed: `isSafeReturnPath`
(app-relative, length-capped, no scheme, no `//`, no backslash, no control
characters) and `isReadOnlyAnonymousPath`, which pins the destination to a shape
the gate itself could have produced. Values are read from
`window.location.pathname` with `EXPO_BASE_URL` stripped (`/app` on the
www-mounted export, `/` on the subdomain) and written back base-relative, since
Expo Router re-applies the base. The browser-OAuth path carries `next` on the
NextAuth `callbackUrl` (`src/lib/auth.web.ts`) — the document navigates away, so
the address bar does not survive the round trip on its own.

`Board Route Handoff` fires once per board-route open on **both** platforms with
`{ kind, status, source }`; it is the only signal for whether deep links resolve
on the native fleet as well as on `app.boardsesh.com`. Two things about the
wiring are load-bearing for reading the funnel:

- `status: 'resolved'` is fired **imperatively** from inside the hand-off, not
  derived from a rendered status. The hand-off effect calls
  `router.replace` / `router.back` in the same body, React batches that with any
  state update queued in the same flush, and the navigator drops the redirector
  in the very render that would have carried the new status — so a
  status-derived success leg never commits and the funnel reads as ~100%
  failure. `join/[sessionId]` fires `Session Joined` the same way.
- `status: 'not_found'` is **held back** for a parsed URL while the device is
  offline. That state is the transient one `useAdoptedBoard`'s reconnect watcher
  heals, so reporting it would file a failure for every offline cold open that
  later lands, and count the same open twice. A URL that did not parse reports
  either way.

### Telemetry (baked at build time)

`deploy-app-web` builds the export with `EXPO_PUBLIC_SENTRY_DSN`,
`EXPO_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_SENTRY_ENVIRONMENT=production-web`
set in `production-deploy.yml`'s **workflow-level** `env:` block.

These are not optional and they are not runtime config. `EXPO_PUBLIC_*` values
are inlined into the JS bundle by `expo export`, and both SDKs decide whether
they are enabled at module load from the baked value — `isSentryEnabled`
(`packages/mobile/src/lib/sentry.ts`) and `isAnalyticsEnabled`
(`packages/mobile/src/lib/posthog-client.ts`). Drop either key and the deploy
still succeeds; it just publishes a production browser app with crash reporting
or analytics silently off.

Two constraints on where they live:

- **Workflow level, not job level.** `scripts/mobile-ci-env-parity.test.ts`
  extracts workflow-level `env:` at 2-space indent; a job-level block is
  invisible to it, and the test guarding these three keys would pass over a
  workflow that had quietly dropped them.
- **`production-web`, not `production`.** `environment` is init-only in both
  SDKs, so this build-time value is the only thing separating browser-app events
  from the native fleet in Sentry and PostHog.

The deploy greps the emitted bundles for both keys and the environment tag and
fails if any is missing — `expo export` reuses Metro's transform cache across
env changes, so "the workflow set it" and "the bundle contains it" are separate
claims.

Neither SDK has a `.web.ts` fork or a `WEB_SHIM_MODULES` entry, so the
react-native builds run as-is under react-native-web. If either turns out not to
initialise there, the fork target is `@sentry/browser` + `posthog-js-lite` — the
pair the classic web app already uses.

### Freezing the subdomain deploy

`deploy-web` and `deploy-production-backend` honour `check-rollback`, which
detects a pinned Vercel Instant Rollback and stages instead of promoting.
Cloudflare Pages has no equivalent signal, so `deploy-app-web` gates on a repo
variable instead:

- Set **`APP_WEB_DEPLOY_HOLD`** to any non-empty value to hold
  `app.boardsesh.com` at its current deployment. Without it, a Pages dashboard
  rollback is clobbered by the next merge touching `packages/mobile`,
  `packages/shared`, `packages/shared-schema`,
  `scripts/build-expo-web-export.sh`, or `deploy/app-subdomain`.
- Clear the variable to resume. Nothing queues while held — the next qualifying
  merge deploys.
- A held run posts to the Discord deploy channel, because a skipped job is only
  grey in the run summary and a forgotten hold would otherwise strand the
  browser app on an old bundle.
- `notify-failure` fires on `failure`/`cancelled` only, so a held (skipped) job
  raises no false alarm.

#### Holding and releasing

Anyone with **admin** or **maintain** on the repo can set it: GitHub →
Settings → Secrets and variables → Actions → **Variables** → _Repository
variables_, or from the CLI:

```
gh variable set APP_WEB_DEPLOY_HOLD --body "2026-08-12 incident: Pages pinned to <deployment>"
gh variable list                       # confirm it is set
gh variable delete APP_WEB_DEPLOY_HOLD # release
```

Three things to get right:

- **Repository variable, not an environment variable.** The gate is the
  job-level `if:` on `deploy-app-web`, which GitHub evaluates before the job's
  `environment: Production` is resolved — a variable scoped to that environment
  is not reliably visible there, and a hold that silently does nothing is worse
  than no hold at all.
- **Not a secret, but never empty.** The gate reads
  `vars.APP_WEB_DEPLOY_HOLD == ''`, so what holds the deploy is a **non-empty
  value**, not the variable merely existing — set it with an empty body (the
  `gh variable set` prompt accepts one) and you get a hold that does nothing at
  all. Always pass `--body`, and spend it on the incident reference: it is what
  the next person sees in Settings. The value is only ever compared against the
  empty string, never used as a credential, so it needs no secret handling.
- **Clear it before the next intended deploy.** The hold is not time-boxed and
  nothing queues behind it. Every qualifying merge while it is set skips the
  subdomain and pings Discord, and those commits stay unshipped until it is
  cleared.

Releasing does not redeploy by itself. After `gh variable delete`, in order of
blast radius:

1. **Re-run the held run** — Actions → the run that was held → _Re-run all jobs_.
   This is what the held-run Discord ping tells you to do. `detect-changes` and
   every job `if:` re-evaluate on a re-run, so it ships exactly what that push
   qualified for: after a mobile-only merge, the subdomain and nothing else.
2. **Wait for the next qualifying merge**, if nothing is urgent.
3. **`gh workflow run production-deploy.yml`** to ship current `main` now. Mind
   the blast radius: a manual dispatch marks web, backend _and_ app as changed
   (see `detect-changes`), so it redeploys Vercel and Railway as well, not just
   the subdomain.

The hold covers `app.boardsesh.com` only. `deploy-web` (Vercel) and
`deploy-production-backend` (Railway) still deploy while it is set; their own
guard is `check-rollback`.

`notify-success` reports a held subdomain as `held (APP_WEB_DEPLOY_HOLD set)`
instead of `unchanged`. It derives that from `deploy-app-web` skipping, not by
re-reading the variable: that job declares `environment: Production`, where a
step-level `vars.` lookup would also resolve environment-scoped variables the
job-level gate cannot see, and print "held" for a deploy that actually shipped.

`deploy/app-subdomain/__tests__/production-deploy-hold.test.ts` asserts the gate,
its Discord counterpart, that held line, and that the export's `EXPO_PUBLIC_*`
stay at workflow level. The `deploy-config` job in `.github/workflows/ci.yml`
runs it on every PR touching `production-deploy.yml`.

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
