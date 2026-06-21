# Mobile error telemetry (Sentry)

The RN app (`packages/mobile`) reports errors and crashes to **Sentry** — the same
`boardsesh` project as web (`@sentry/nextjs`) and backend (`@sentry/node`). PostHog
stays in the app for **product analytics + session replay only**; it no longer
captures errors. Two reasons Sentry owns crashes:

- **Native crashes.** PostHog's RN SDK sees JS only. Sentry's native crash handler
  catches iOS/Android native faults — the board-renderer, live-activity, and BLE
  native modules, plus any Expo native module — persists them across the crash, and
  uploads on the next launch. That coverage gap is why Sentry is here.
- **Symbolicated JS.** The CI build uploads source maps (+ dSYMs on iOS), so JS stack
  traces resolve to real file/line instead of minified offsets.

`src/lib/sentry.ts` calls `Sentry.init()` (gated `!!dsn && !__DEV__`, so local Metro
dev never sends), owns the global `ErrorUtils` handler, and exposes `captureToSentry`
and `wrapWithSentry`. `app/_layout.tsx` imports it first (init before any other
module side-effect) and wraps the root with `wrapWithSentry`.

## What's automatic

`Sentry.init` installs the JS error integrations (**uncaught exceptions** and
**unhandled promise rejections**) and the **native** crash handler. The global
`ErrorUtils` wrapper (`global-error-capture.ts`) and the Expo Router `ErrorBoundary`
(`app/_layout.tsx`) both report through `reportError`. Crashes and render errors land
in Sentry with no extra work.

## What you must do: report _handled_ errors

The blind spot is errors the app **catches** and turns into a toast, inline
message, degraded state, or silent `console.warn`. Those never reach autocapture.
Rule of thumb: **every catch that handles a user-affecting failure reports it.**

Use the helpers in `src/lib/error-reporting.ts` (they route to `captureToSentry`):

- `reportHandledError(error, { tags: { source, ... }, extra })` — the default.
  Drops cancellations (`AbortError` / TanStack `CancelledError`) and downgrades
  offline/network failures to a `warning` tagged `network: true`, so error
  tracking stays signal-rich. Use it in catch blocks, GraphQL-WS handlers, and the
  React Query caches.
- `reportError(error, { level, tags, extra })` — raw passthrough. Use only when
  the caller already owns the severity (e.g. auth: a 401 is an `error`, a network
  blip is a `warning`).

`level` maps to the Sentry severity, `tags` become Sentry tags (string-coerced), and
`extra` becomes scope extras. Always pass a `tags.source` (and an `op` where it helps)
so events group in Sentry: `react-query`, `native-auth`, `queue-mutation`,
`queue-sync`, `auth-refresh`, `ble-send`, `ble-connect`, `playlist`, `wall-control`, etc.

### Where it's already wired

- **React Query** (`providers/query-provider.tsx`) — `QueryCache` / `MutationCache`
  `onError` report every query/mutation failure once `retry` is exhausted. This is
  the chokepoint for API / GraphQL-HTTP / REST failures; don't re-report at
  individual `useQuery`/`useMutation` call sites.
- Direct **GraphQL-WS** ops (`@boardsesh/queue-react`, `@boardsesh/playlists-react`)
  bypass React Query, so their catch sites report explicitly.

### What NOT to report (avoid noise)

- Cancellations and expected-empty paths (e.g. a parser returning `null` for a URL
  that isn't a deep link).
- Best-effort key/value store reads/writes whose failure is invisible and
  self-recovering — search filters, recents, image cache, preferences
  (`last-search-store`, `recent-filter-store`, `session-store`, …). Exception: a
  store write that loses a **pending user action** is reported — the deep-link /
  share-target stashes, where a dropped `AsyncStorage.setItem` silently loses a
  tapped invite link or a shared video after login.
- Rate-limit responses — that's expected user pacing, not a bug.
- `__DEV__`-only diagnostics (keep the `console.warn`; report only if the failure
  is user-affecting in production too).

## Source maps / symbolication (CI)

- **iOS** (`ios-testflight-rn.yml`): the `@sentry/react-native` Xcode build phases
  upload JS source maps + dSYMs when `SENTRY_AUTH_TOKEN` is present
  (`SENTRY_DISABLE_AUTO_UPLOAD` gates it; the build stays green without the token).
- **Android** (`android-apk-rn.yml`): JS source-map upload is **disabled**
  (`SENTRY_DISABLE_AUTO_UPLOAD=true`) — the Gradle upload task is incompatible with
  the Gradle version Expo prebuild generates. Native crashes are still captured;
  Android JS symbolication is a follow-up.

## Verifying

`isSentryEnabled = !!dsn && !__DEV__`, so **local Metro dev sends nothing**. Verify on
a preview / TestFlight / production build — and note that adding the native SDK changed
the **fingerprint**, so this needs a fresh native build, not an OTA. Trigger the
failure (a JS error, or `Sentry.nativeCrash()` for the native path), relaunch, and look
for the event in the `boardsesh` Sentry project filtered by `source`.
