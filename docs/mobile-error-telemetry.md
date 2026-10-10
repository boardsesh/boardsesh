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

## Privacy and release boundary

Product analytics, session replay and publishing install attribution require a current Allow
choice. Self-hosted Observe provides first-party performance/error diagnostics independently of
that choice, controlled by its existing dispatch and sampling flags. SDK installation/session
identifiers support update health; the app assigns no account identity to Observe. Anonymous launch health reports are described in `docs/mobile-ota-updates.md`.
Sentry crash, app-hang and ANR reporting continues with `sendDefaultPii: false`: JavaScript error
and transaction hooks remove `user` and persistent device IDs. The app-owned Expo plugin
`packages/mobile/plugins/with-sentry-native-privacy.js` initializes the native SDK through the
public React Native Sentry startup APIs, removing native event users and device IDs
without patching Sentry. Android has separate error and transaction callbacks; the Apple
`beforeSend` callback covers both. No account identity is assigned to Sentry.

The two platforms start differently on purpose. Android calls `RNSentrySDK.init`, which starts
from the callback alone when the app has no `sentry.options.json`. iOS builds its options in code
with `RNSentryStart` (`createOptions`, React defaults, our callbacks, React finals, `start`) and
must never call `RNSentrySDK.start(configureOptions:)`: that entry point takes the DSN from a
bundled `sentry.options.json`, we ship none, and without it the callback receives nil options.
The first write to them segfaulted every launch of TestFlight 2.6.0 (15), 100 ms in and before
any crash handler existed, so nothing reached Sentry. If the DSN fails to parse, the iOS block
logs and the app launches without native Sentry.

That block is compiled only into Release builds (`#if !DEBUG`). iOS CI builds a Release app, so
it proves the block compiles. Nothing launches a Release app before TestFlight: dev clients, the
simulator smokes and the screenshot captures are all Debug. After editing the block, launch a
Release simulator build.

JavaScript sets `autoInitializeNativeSdk: false` so it cannot replace those native callbacks.
Native startup uses the configured DSN and a fixed production environment, keeps crash/ANR/app-hang
handling, and lets Sentry detect release/dist. The preview environment remains a JS-only input so
preview OTAs share the store binary's fingerprint. The supported scope bridge supplies the current bundle's
`boardsesh_environment` tag so native events from a preview OTA retain the preview environment.
Pre-JavaScript events use the native build environment. Development builds and builds without a
DSN do not initialize Sentry natively.

This redaction applies to errors and transactions, not every envelope item. Native release-health
sessions keep the SDK's existing defaults and can contain an installation identifier. Already
serialized cached envelopes may bypass event callbacks; this change does not rewrite or delete
legacy caches. `sendDefaultPii: false` alone does not remove the native installation identifiers.
See Sentry's [native initialization guide](https://docs.sentry.io/platforms/react-native/manual-setup/native-init/)
and [app-start configuration guide](https://docs.sentry.io/platforms/react-native/manual-setup/app-start-error-capture/).

These native changes ship in the next store release from `main`. The current store binary cannot
receive this change as an OTA; there is no backport. Before release, compile both native targets
and inspect denied/granted/withdrawn traffic on devices, including queued replay uploads and a
cold-start crash upload. The 30-day legacy-client grace period starts when that release is available
in the stores. Disabling Sentry organization IP storage and enabling the legacy PostHog drop
transformation are later operational changes requiring explicit confirmation. Historical PostHog
person deletion is separate P2 work.

## What's automatic

`Sentry.init` installs the JS error integrations (**uncaught exceptions** and
**unhandled promise rejections**); the Expo-generated app startup installs the **native** crash handler. The global
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
  Drops cancellations (`AbortError` / TanStack `CancelledError`) and leaves
  breadcrumbs for offline/network failures. Board discovery `searchBoards`
  throttling also leaves one breadcrumb per error object, containing only the
  operation, retry delay, and source. Request variables and coordinates stay out
  of that breadcrumb. Other `RATE_LIMITED` operations remain warnings. Use it in
  catch blocks, GraphQL-WS handlers, and the React Query caches.
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
- **Android native symbols**: three different things, don't conflate them.
  - **Java/Kotlin frames** are obfuscated as of the R8 change, and deobfuscated from the
    R8 mapping. `android-apk-rn.yml` mints a UUID before `expo prebuild`,
    `plugins/with-android-sentry-proguard-uuid.js` bakes it into the manifest as
    `io.sentry.proguard-uuid`, and a decoupled `continue-on-error` step uploads
    `mapping.txt` under that same UUID with `sentry-cli upload-proguard --uuid`. The
    Sentry Android Gradle Plugin, which normally does both halves, is deliberately not
    applied — Sentry stays off the release critical path (see #4101).
    **An unfamiliar single-letter Android class name in a stack trace means that upload
    failed, not that the code is unknown.** The run logs a warning when it does.
  - **`.so` frames**: still nothing to upload, unchanged. Those libraries come from
    prebuilt React Native / Expo AARs that ship stripped. Native `.so` crashes are
    captured but not symbolicated.
  - **Google Play** deobfuscates on its own: AGP embeds the same mapping in the AAB
    under `BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map` and Play
    ingests it on upload. `vp run check:mobile-android-obfuscation --aab ...` asserts
    that embedded copy is byte-identical to the one Sentry receives, so the two systems
    can never be symbolicating different builds.
  - Not covered: `RNSentryModuleImpl.getProguardUuid()` reads the assets
    `sentry-debug-meta.properties`, which we do not write. It feeds only the profiling
    payload's `build_id`, and Android profiling is off, so the gap is inert.

## Verifying

`isSentryEnabled = !!dsn && !__DEV__`, so **local Metro dev sends nothing**. Verify on
a preview / TestFlight / production build — and note that adding the native SDK changed
the **fingerprint**, so this needs a fresh native build, not an OTA. Trigger the
failure (a JS error, or `Sentry.nativeCrash()` for the native path), relaunch, and look
for the event in the `boardsesh` Sentry project filtered by `source`.
