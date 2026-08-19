# `deploy/app-subdomain/` — Cloudflare Pages config for app.boardsesh.com

`_redirects`, `_headers`, `_routes.json` and `functions/` are copied into (or
beside) the standalone Expo web export at deploy time and shipped to the
`boardsesh-app` Cloudflare Pages project. They are the only deployed files here;
the rest of the directory is this README plus the CI tests that guard them and
the deploy job that ships them (`__tests__/`, `tsconfig.json`, `vite.config.ts`).
They are **not** part of the export itself — the export recipe
(`scripts/build-expo-web-export.sh --subdomain`) emits a `baseUrl /` static SPA;
this directory adds the host-level SPA fallback and caching rules Pages needs.

The deploy pipeline that consumes them is the `deploy-app-web` job in
`.github/workflows/production-deploy.yml`.

## `_redirects` — SPA fallback

```
/*    /index.html    200
```

Expo Router is a single-page app. Any path that is not a real file (deep links
like `/climbs`, `/auth/callback?transferToken=…`) has to serve the exported
`index.html` shell with a `200`. Cloudflare Pages matches real files first, so
`_expo/*`, `assets/*`, `wasm/*`, and `index.html` serve directly; everything
else falls through to the shell.

## `_headers` — security + caching

- `X-Robots-Tag: noindex` — this is an authenticated utility surface, kept out of
  search indexes. Since W-24 (#4438) retired the `/app` static path this file is
  the only production source of that header for the browser app; the dev `/app`
  proxy gets its own from `packages/web/middleware.ts` (see "Retired: the /app
  static path" in `docs/expo-web-deployment.md`).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
  — standard hardening.
- `/_expo/*` and `/assets/*` → `Cache-Control: public, max-age=31536000, immutable`.
  These paths are **content-hashed** (the filename changes whenever the content
  does), so they're safe to cache forever.
- `index.html` and `wasm/*` get **no** cache override — they have fixed
  filenames, so they must revalidate. A cached `index.html` would mask a deploy;
  a cached WASM binary would pin an old renderer.

## `functions/_middleware.ts` + `_routes.json` — a missing asset must 404

The SPA fallback has a sharp edge. `/* /index.html 200` answers **any** path that
is not a real file, including asset URLs, so a request for a chunk that is not in
the deployment gets the HTML shell with a `200`. `_headers` then stamps
`Cache-Control: public, max-age=31536000, immutable` on it, because that rule
matches on `/_expo/*` — the path — and knows nothing about what was served.

That is worse than a 404 in both directions:

- The browser refuses to execute an HTML `<script>` (`nosniff`), so React never
  mounts and `#root` stays empty with no error naming the cause.
- The edge **and** the user's browser then cache that HTML under the chunk's URL
  for a year. A reload does not clear it.

Pages `_redirects` cannot express this — it supports 301/302/303/307/308 and
`200` rewrites, not 404 — so the check runs in code. `functions/_middleware.ts`
returns a real `404` with `Cache-Control: no-store` when an asset path resolves
to HTML, and passes every real asset straight through.

`_routes.json` keeps the blast radius small: the Function is invoked only for
`/_expo/*`, `/assets/*` and `/wasm/*`. The shell, the PWA manifest and every SPA
deep link stay pure static assets with no Worker in the path.

Two things to know about routing an asset prefix through a Function:

- `_headers` still applies, so the immutable caching on `/_expo/*` and
  `/assets/*` is unchanged (verified with `wrangler pages dev`). The middleware
  re-asserts it only if it ever goes missing, and the deploy's
  `entry chunk serves as immutable JavaScript` smoke is the alarm if both fail.
- **Range requests are not answered with `206` on these paths.** Static Pages
  assets are; a Worker-proxied response is not. Nothing we serve here is
  range-fetched in practice (scripts, fonts and the WASM binary are all whole-file
  loads), so this is a deliberate trade for the 404.

Wrangler discovers `functions/` relative to its cwd and rejects it inside the
static root, so the deploy copies it to `$RUNNER_TEMP/functions` — beside the
export, not in it — and publishes with `--cwd "$RUNNER_TEMP"`.
`__tests__/asset-404-deploy-wiring.test.ts` guards that wiring; delete the
`--cwd` and the Function silently stops shipping.

## The one hard rule: no CSP `script-src`

**Never add a `Content-Security-Policy` with a `script-src` to `_headers`.** The
`@boardsesh/board-renderer-wasm` glue instantiates the WASM module via
`new Function(...)`, so the renderer depends on `unsafe-eval` /
`wasm-unsafe-eval` being permitted. A strict `script-src` (without those
allowances) breaks board rendering outright.

`__tests__/headers.test.ts` enforces it. A policy that restricts script sources
fails CI unless it grants both `'unsafe-eval'` and `'wasm-unsafe-eval'`, and
that covers `default-src` too, since `script-src` falls back to it. If the
renderer ever stops needing `new Function(...)`, relax the test in the same PR
that relaxes this rule.

## Editing these files

Run `vp test run --project deploy-app-subdomain`. The suite parses both config
files and asserts what Cloudflare would send for concrete paths: the CSP rule
above, the `noindex` tag, forever-caching on content-hashed assets only, and the
`200` SPA rewrite for deep links. The `deploy-config` job in
`.github/workflows/ci.yml` runs it on every PR touching this directory, the
export script, `Dockerfile.web`, or the deploy workflow.

`__tests__/production-deploy-hold.test.ts` guards the deploy job rather than the
config files: it asserts the `APP_WEB_DEPLOY_HOLD` freeze on `deploy-app-web`,
the Discord ping that makes a held run visible, and that the export's
`EXPO_PUBLIC_*` stay at workflow level. It lives here because the `deploy-config`
job already runs this project unfiltered on any `production-deploy.yml` change —
the only gate that selects a test suite for a workflow-only diff, since Vitest's
`--changed` can never relate an fs read to a diff of the file being read. (Other
gates do fire on such a diff — `service-deploy-inputs.yml` lists the workflow in
its paths filter — they just run no tests over it.) See
`docs/expo-web-deployment.md`.

## Why `EXPO_PUBLIC_WEB_URL` is www, not app

The production export bakes `EXPO_PUBLIC_WEB_URL=https://www.boardsesh.com` — the
**auth origin**, deliberately www and not app.boardsesh.com. The SPA does
credentialed cross-origin auth against www; app.boardsesh.com is only where the
static shell is served. See `docs/expo-web-deployment.md`.
