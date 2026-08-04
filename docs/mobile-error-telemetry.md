# Mobile error telemetry (Sentry)

The RN app (`packages/mobile`) reports errors and crashes to **Sentry** — the same
`boardsesh` project as web (`@sentry/nextjs`) and backend (`@sentry/node`). PostHog
stays in the app for **product analytics + session replay only**; it no longer
captures errors. Two reasons Sentry owns crashes:

- **Native crashes.** PostHog's RN SDK sees JS only. Sentry's native crash handler
  catches iOS/Android native faults — the board-renderer, live-activity, and BLE
  native modules, plus any Expo native module — persists them across the crash, and
  uploads on the next launch. That coverage gap is why Sentry is here.
- **Symbolicated stacks.** The CI build uploads JS source maps and, on iOS, the
  archive's dSYMs, so both JS and native frames resolve to real file/line instead of
  minified offsets and bare symbol names.

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

**App hangs / ANRs.** `enableAppHangTracking` (iOS) reports a main-thread freeze
longer than `appHangTimeoutInterval` (2s) as an App Hang; Android ANR detection (5s
main-thread block) is on by default in the native `sentry-android` layer. Both attach
a JS stack pinned to the blocked frame — that's how the in-the-wild device freezes
(e.g. Galaxy S24 / Pixel 10) surface with the exact culprit, rather than via emulator
repro.

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
  individual `useQuery`/`useMutation` call sites. A query that keeps failing re-fires
  `onError` on every refetch (focus / reconnect / remount), but Sentry groups those
  into one issue by stack fingerprint — the event count climbs without spawning
  duplicates, so no extra `queryHash` dedup is needed (unlike the old PostHog setup).
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

Both are gated on `SENTRY_AUTH_TOKEN`; without it the builds stay green and upload
nothing.

- **iOS JS source maps** (`ios-testflight-rn.yml`): the `@sentry/react-native` Xcode
  build phases upload them during `xcodebuild archive`
  (`SENTRY_DISABLE_AUTO_UPLOAD=false`).
- **iOS dSYMs** (`ios-testflight-rn.yml`, `Upload iOS dSYMs to Sentry`): a separate
  step after the archive, running `vp run mobile:upload-dsyms` over
  `<archive>/dSYMs`. It has to be separate: the Sentry build phase runs inside the
  app target's build, ~2s before `GenerateDSYMFile` writes `Boardsesh.app.dSYM`, so
  it only ever finds the stripped executables. Those carry a symbol table (function
  names) but no DWARF, which is why every native frame read `(<unknown>)` for file
  and line until #4202. The DWARF for statically linked pods — `libRNScreens.a` and
  friends — exists _only_ inside the app's dSYM.
  `scripts/mobile-upload-dsyms.ts` fails the job if that dSYM is missing from the
  archive, so the regression can't come back quietly.
- **Android JS source maps**: uploaded on the **OTA** path, not the Gradle one —
  `mobile-ota-production.yml` runs `mobile:upload-sourcemaps` for Android on every
  published update. The in-build Gradle task stays off
  (`SENTRY_DISABLE_AUTO_UPLOAD=true` in `android-apk-rn.yml`) because it calls an API
  the Gradle version Expo prebuild generates doesn't have. The gap that leaves is the
  bundle baked into the APK, i.e. JS stacks from a device that hasn't taken its first
  OTA yet.
- **Android native symbols**: nothing to upload. The `.so` files come from prebuilt
  React Native / Expo AARs that ship stripped, and we build no NDK code of our own, so
  there is no Android equivalent of the iOS dSYM fix. Native Android crashes are still
  captured, just not symbolicated.

## Verifying

`isSentryEnabled = !!dsn && !__DEV__`, so **local Metro dev sends nothing**. Verify on
a preview / TestFlight / production build — and note that adding the native SDK changed
the **fingerprint**, so this needs a fresh native build, not an OTA. Trigger the
failure (a JS error, or `Sentry.nativeCrash()` for the native path), relaunch, and look
for the event in the `boardsesh` Sentry project filtered by `source`.
