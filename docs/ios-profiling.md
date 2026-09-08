# Repeatable local iOS profiling

`vp run mobile:profile:ios` builds in a fresh dedicated checkout, reserves an explicit simulator, checks the installed executable identity, and retains local evidence under `.boardsesh/`. It never resets app data or the simulator keychain. Use the local fixture account and backend; the runner rejects a non-local backend URL. Seed fixtures first; `--fixtures <manifest>` defaults to `.boardsesh/ios-performance-fixtures.json` and must describe at least 200 owned and 200 community playlists with real climbs. The manifest hash and non-secret fixture settings are recorded with each run.

```sh
EXPO_PUBLIC_BACKEND_URL=http://localhost:8198 \
EXPO_PUBLIC_SCREENSHOT_MODE=1 \
BOARDSESH_METRO_USE_WATCHMAN=1 \
vp run mobile:profile:ios -- \
  --udid <simulator-udid> \
  --source-ref <commit-with-instrumentation> \
  --configuration Release \
  --run-dir .boardsesh/profile-baseline-release
```

Maestro must be installed and able to find a local JDK before any build starts. If Java is not on PATH, set `JAVA_HOME` to its installed location (for Homebrew JDK 21 on Apple Silicon, `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`). The runner checks `maestro --version` and does not download Java.

Create a dedicated simulator in Xcode first and use its UDID throughout the comparison. `--checkout <path>` accepts an already prepared dedicated worktree, but refuses one containing a generated `packages/mobile/ios` project. Dependencies can be installed beforehand with `vp install`. The default creates a detached git worktree at the requested source ref and installs its dependencies. Checkouts and evidence remain available after failure.

Use `--configuration Debug --port <free-port>` for React attribution and tracing capability checks. The runner excludes Expo's development launcher and menu using the dedicated checkout's `expo.autolinking.ios.exclude` configuration. It sets the generated React Native bundle provider to the chosen localhost port and verifies the native dependencies no longer contain the launcher/menu. These changes are local to the generated profiling build. Ordinary Release captures use an embedded bundle.

The build helper can also be used independently without launching:

```sh
BOARDSESH_PROFILE_BUILD=1 \
BOARDSESH_PROFILE_SOURCE_DIR=/path/to/fresh/profiling-checkout \
BOARDSESH_IOS_BUILD_CACHE_DIR=/path/to/run/native-cache/build \
vp run mobile:build-sim-app -- --configuration Release --app-out /path/to/run/app
```

The caller is responsible for preserving identical fixture, authentication, rendering, and instrumentation settings across baseline and candidate. Never compare an instrumented candidate with an uninstrumented baseline. Include at least 200 owned and 200 community playlists with real climbs for shelf population measurements.

## Captures and validity

The run manifest records the source commit, tracked patch, untracked source hashes, native fingerprint, build configuration, final generated input hashes, executable UUID and SHA256, embedded bundle SHA256, simulator UDID, Metro port, and owned process IDs. The installed application is checked both before and after capture. Foreign installation, an incomplete capture, or missing required samples marks the run invalid and preserves its artifacts.

Debug navigation runs two warm-up four-tab loops followed by five measured loops. JavaScript callback gaps and React render durations are attribution evidence, not native UI FPS. The capture checks `Tracing.start` in a fresh process and records whether a trace completes. React renderer profiles and native `sample` remain explicit fallbacks; unavailable tracing is recorded, never called a completed trace.

Debug capture selects an exact app identifier from Metro's registered runtimes and refuses ambiguous targets or debugger URLs outside the selected localhost port. A transport timeout or an unfinished trace aborts the run: tracing overhead must not silently remain active during the measured loops. A Watchman binary can be installed while its operating-system watcher still fails; retain that startup as invalid, preserve unrelated watchers, and verify the source identity again after recovery.

Release captures include ten process-cold, warm-cache launches and twenty browsing/background cycles in one process. Startup artifacts are written to the app's local Documents directory by `EXPO_PUBLIC_PROFILE_STARTUP=1`. Each launch must produce a new runtime ID. The host measures when the deferred artifact export becomes observable, which includes polling and export delay; it is not time to first displayed frame. The JS timestamps and native runtime markers retain separate clock labels.

The selected source ref must include the mobile startup collector, introduced separately from the tooling in [the feedback/startup PR](https://github.com/boardsesh/boardsesh/pull/5328). The runner checks this prerequisite before a native build. The collector is opt-in, keeps one mark per phase, and replaces a fixed local export file rather than appending telemetry.

Memory sampling uses physical footprint at settled Home after each browsing/background cycle. A missing footprint or changed process invalidates the memory sequence. Run retained-object/allocation inspection separately and record distinct climb/render keys before changing any cache limit or claiming a leak. A simulator result does not establish a phone performance budget.

## Ownership and cleanup

Build commands acquire the shared cache lock before prebuild, cache changes, or CocoaPods work. A failed Xcode build fails even if an old `.app` exists. A new app export is staged and validated before the previous successful export is replaced.

Simulator build/launch, screenshot, navigation, log, and shutdown commands share leases in `~/Library/Caches/boardsesh/simulator-leases`. A live foreign lease is refused. A stopped or incomplete lease is also refused: inspect the recorded owner and remove only that stale lease metadata before retrying. A long run's ownership is never stolen based only on its age. Child commands inherit the selected UDID and ownership token.

For existing ad-hoc commands, select the same device explicitly:

```sh
BOARDSESH_IOS_SIMULATOR_UDID=<simulator-udid> vp run check:mobile-simulator
BOARDSESH_IOS_SIMULATOR_UDID=<simulator-udid> vp run mobile:screenshot
```

Multi-device store screenshot runs must not inherit a lease for a different model; otherwise the tool refuses to label one simulator's images as another model. Screenshot installation preserves app data and keychain. If a capture needs a clean account, create a dedicated simulator or sign out through the app.

Metro started by a profiling run is stopped only through its recorded owned process group. Ad-hoc shutdown no longer kills arbitrary listeners found by port. Stop an ad-hoc Metro through the terminal that started it. The selected simulator stays booted for inspection.

`--host localhost`, `--host=localhost`, and `--localhost` now advertise localhost even when Tailscale is configured. `BOARDSESH_METRO_USE_WATCHMAN=1` explicitly checks Watchman availability; leaving it unset preserves Expo's default.

## Local fixture seed

The additive fixture script requires an explicit loopback database URL and the existing `test@boardsesh.com` account:

```sh
BOARDSESH_PROFILE_DATABASE_URL=postgresql://postgres:password@localhost:5432/main \
vp exec tsx packages/db/scripts/seed-ios-performance.ts
```

It creates 200 owned and 200 public community playlists, each referencing twelve real Tension climbs. Repeating it preserves the same fixture identifiers. The local `.boardsesh/ios-performance-fixtures.json` records those identifiers, climb references, and their SHA256. Existing user data is preserved.

Use `EXPO_PUBLIC_SCREENSHOT_USER_EMAIL=test@boardsesh.com` and `EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD=test` with the local screenshot mode if automatic fixture login is needed. The local backend must have its development authentication secret configured. Select the same board, angle, language, and rendering mode in both runs.

The `performance.now()` values exported by this RN version can be monotonic uptime values. Derive durations by subtracting marks within the same launch; do not interpret a raw mark as milliseconds since process creation or compare raw marks across launches. A visible Home commit is also distinct from the native screen displaying its pixels.

The runner records completed overlay filenames from the app's existing `board-thumbnails` cache. Unique trailing hashes distinguish frame/color signatures, while full filenames include board configuration, style, and resolution. These are render-cache observations, not counts of retained objects or exact climb UUIDs. Keep allocation inspection separate from the launch and navigation measurements.

The supported Debug exclusion follows [Expo's autolinking configuration](https://docs.expo.dev/modules/autolinking/). Interpret [React Native DevTools profiles](https://reactnative.dev/docs/react-native-devtools) alongside native tools; JavaScript timings do not replace displayed-frame measurements.

For post-profiling smoke validation, reuse the verified export without another build or Expo's implicit Metro selection:

```sh
BOARDSESH_IOS_SIMULATOR_UDID=<simulator-udid> \
BOARDSESH_IOS_SMOKE_APP_PATH=/path/to/run/app/Boardsesh.app \
vp run check:mobile-simulator
```

This opt-in mode validates the existing executable and bundle identity, installs in place, and launches the plist's bundle identifier on the leased device before the normal log smoke check. Leave `BOARDSESH_IOS_SMOKE_APP_PATH` unset for the usual build-and-launch flow. A Debug export still requires its selected Metro server to be running.
