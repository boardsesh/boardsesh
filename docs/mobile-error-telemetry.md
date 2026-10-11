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

The Expo plugin starts native Sentry before React in release binaries; Debug
builds remain silent. `src/lib/sentry.ts` initializes the JS SDK (gated
`!!dsn && !__DEV__`) and skips duplicate native initialization only when the
running binary exposes the versioned `MobileDiagnostics` capability. Older
binaries keep their existing JS-driven native initialization. It owns the global
`ErrorUtils` handler and exposes `captureToSentry` and `wrapWithSentry`. `app/_layout.tsx` imports it first (init before any other
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

Native startup installs the crash handler before module loading; `Sentry.init`
installs the JS integrations (**uncaught exceptions** and **unhandled promise
rejections**). The global
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

Publication requires `SENTRY_AUTH_TOKEN`. Missing credentials, absent maps,
Debug ID mismatches, missing owned native DWARF, or rejected uploads fail the job
before store submission or OTA publication. RN SDK **8.28.0** and CLI **3.8.0** are
pinned; anchored release backports retain the separately audited SDK **7.11.0**
uploader contract.

- JS bundles/maps are checked as pairs and uploaded with CLI `--wait --strict`.
  Hermes bundles use their Debug ID references. The explicit gate compensates
  for upstream wrappers that can skip incomplete groups or exit before processing.
- iOS app and extension executable UUIDs must match their dSYMs, with DWARF
  present. Static pod symbols live in the app dSYM.
- Android owns `libboard_renderer_jni.so`, Rust
  `libboard_renderer_ffi.so`, and tester `libboardsesh_diagnostics.so`. Release builds retain private unstripped ELF files;
  packaged library build IDs must match files containing DWARF. Third-party
  stripped AAR libraries cannot be treated as owned source symbols.
- Native DIF uploads use `--wait` and local identity/DWARF validation. CLI 3.8
  does not offer `--strict` for that subcommand.

- Android R8 mappings retain the release branch's manifest UUID and upload
  under that same UUID. The Sentry Android Gradle plugin stays unapplied;
  explicit upload avoids its incompatible Gradle integration. AGP embeds the
  same mapping in the AAB for Google Play; the existing obfuscation check still
  asserts byte identity. This mapping covers Java/Kotlin, separately from ELF
  symbols. Android profiling remains off; its asset-based build ID is outside
  crash qualification.

## Operation and report correlation

`src/lib/mobile-diagnostics.ts` is the shared pure recorder. It tracks BLE, auth,
data, foreground rendering, and navigation operations using begin/step/finish,
parent operation IDs, durations, and explicit success/failure/cancellation/
supersession. Concurrent operations remain separate; late callbacks cannot
replace a newer result. Limits are **16 active operations**, **100 breadcrumbs**,
one latest completion per flow, and **32 KB UTF-8 context**. Overflow is counted
without evicting live operations. Attributes are scalar allowlisted fields;
credentials, query variables, renderer JSON, peripheral addresses, and packets
are excluded. BLE writes and sync record phase boundaries rather than every
chunk/progress callback. Background thumbnail work does not create JS render
operations. Recorder sink/identity failures cannot change app behavior or error
severity, and do not create duplicate captured exceptions.

Native diagnostics decorates the existing privacy initializer: one SDK start,
with the same release guard and redaction callbacks. JavaScript leaves native
initialization disabled so it cannot replace those callbacks. The diagnostic
identity reader supplies PostHog IDs only for explicit feedback while analytics
consent is granted. EAS installation identity is read only for explicit feedback
or consent-bound analytics; persistent launch context, Sentry snapshots and native
abort snapshots exclude all three identity fields.

Every JS runtime gets a `launchId`. Every new native process gets a
`nativeStartupId` before React starts; OTA reloads retain that process ID. The
previous runtime ID is stored privately. `previousLaunchCrashed` is populated
only from the SDK's confirmed result when the stored runtime belongs to the
exact preceding native process. A process crashing before JS cannot cause an
older saved runtime to be labeled crashed;
missing storage or a same-process OTA reload leaves it unknown. Current running
OTA fields are read from `expo-updates`, not stale analytics super properties.
PostHog events carry `launch_id`, `native_startup_id`, `eas_client_id`, and running
OTA metadata. Observe uses the same EAS client ID. Sentry retains native-synced
operation context under `mobile_diagnostics` and queryable `launch_id` tags.

Feedback takes a diagnostics snapshot and creates one `reportId` per submission
attempt. Retries preserve that snapshot and recon ID. Backend leaf validation is
best effort; malformed optional diagnostics cannot discard valid feedback.
Diagnostics are nullable typed JSONB, without a database migration. Private
admin feedback includes copyable IDs and a Sentry launch query. The public
GitHub mirror uses an explicit allowlist and excludes diagnostics.
**Deploy the backend SDL before mobile/admin clients request the new fields.**

## Verifying

Local Metro sends nothing. Native changes require a fresh release binary; OTA
alone cannot add the startup handler, native module, or symbols. In the tester
Sentry screen, **Native abort** invokes owned C/C++ `abort()`; the Java exception
and uncaught-JS tests are separate. Each test receives a run ID before crashing.
An unsupported/older binary reports the missing native capability instead of
pretending its Java exception tested native signal capture.

Qualification requires received events, not just successful upload commands:

1. On Android 12+ crash, relaunch, and check signal, crashing thread, tombstone,
   debug images, owned source frames, run ID, and prior launch/OTA context.
2. Repeat on Android below 12 to check the NDK fallback, and on iOS for dSYMs.
3. Crash offline, restore connectivity, and confirm the next launch uploads it.
4. Reload to a different OTA and confirm the old crash keeps its original IDs
   and metadata rather than inheriting the current runtime context.
5. Save private Sentry event JSON and run `vp run mobile:diagnostics-audit --
   <event.json> android --require-tombstone` for the Android 12+ tombstone case.

For attachment checks, the private audit JSON can contain `{ "event": ...,
"attachments": [...] }` from the event and its attachment metadata endpoint.
Bind qualification to recorded IDs with `--test-run-id`, `--launch-id`,
`--update-id`, and `--embedded true|false`. These checks catch a crash inheriting
the new runtime's metadata. Startup markers flush once before native SDK init;
observable persistence failures leave prior crash attribution unknown. They do
not guarantee attribution through total storage failure or OS power loss.

The audit is read-only. It cannot prove a release works without actual received
events. Keep the PR draft until device qualification and the required Astra/Fable
BLE review are complete. On this change, Linux can validate prebuild output,
TypeScript, tests, bundles, and pipeline contracts; iOS compilation and native
crash receipt remain device/release checks.

The owned abort requires `nativeAbortVersion >= 2`, independently of early
`nativeInitVersion`. The confirmation run ID and current diagnostic snapshot go
through one synchronous Expo call. Native code validates a 32 KB UTF-8 limit
before updating scope. Cocoa stamps tags and the dedicated
`contexts.mobile_diagnostics_native_abort` snapshot synchronously into SentryCrash.
Android executes direct runtime NativeScope JNI tags, the JSON snapshot in
`extra.mobile_diagnostics_native_abort`, and libc abort together on Sentry's single-thread
executor, after earlier scope observers. This avoids React Native's async
setters and Android's queued NDK observers. A pending job times out after five
seconds and cannot crash later; once the atomic action starts, the call cannot
report unavailable while that action still runs. Missing SDK/NDK support or
preparation failure removes partial test attribution and reports unavailable,
without a fallback crash. Older binaries
with only abort capability v1 cannot run this qualification test.
