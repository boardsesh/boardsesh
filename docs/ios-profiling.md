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

## Controlled browsing memory scenarios

The existing command keeps its startup/navigation defaults. Select the new scenario explicitly:

```sh
EXPO_PUBLIC_BACKEND_URL=http://localhost:8198 \
EXPO_PUBLIC_SCREENSHOT_MODE=1 \
vp run mobile:profile:ios -- \
  --udid <owned-simulator-udid> \
  --source-ref <reviewed-app-with-identical-memory-instrumentation> \
  --scenario memory \
  --surface list \
  --workload replay \
  --memory-manifest .boardsesh/ios-memory-climbs.json \
  --run-dir .boardsesh/memory-list-replay
```

Memory scenarios require Release and automatically compile `EXPO_PUBLIC_PROFILE_MEMORY=1`. Local profiling disables Sentry source-map upload. The explicit surface is `list` or `carousel`; the workload is `replay`, `expanding`, or `idle`. There is no replacement list, mock climb array, altered cache limit, or separate playlist experience. The collector observes the ordinary Climbs FlashList, renderer, and play drawer. List controls call the production FlashList's animated `scrollToIndex`; carousel setup uses the normal climb activation handler, followed by nineteen physical Maestro swipes per cycle. Target indices are checked against actual fetched UUIDs. A missing page can request one ordinary next page per command; the command deadline rejects incomplete loading.

Freeze the first 400 real, compatible climbs in the **same order returned by the configured production search** from the explicitly selected local catalogue. The manifest is JSON with these fields:

```json
{
  "schemaVersion": 1,
  "board": { "name": "tension", "layoutId": 10, "sizeId": 6, "setIds": [12, 13], "angle": 40 },
  "accountId": "the-local-authenticated-user-id",
  "renderMode": "classic",
  "catalogueSha256": "64-lowercase-hex-characters",
  "climbs": [
    { "uuid": "real-catalogue-uuid", "name": "Visible climb name", "layoutId": 10, "framesSha256": "64-lowercase-hex-characters" }
  ]
}
```

The example shows one row for readability; validation requires exactly 400 unique rows. Record query ordering, source provenance, and compatibility verification alongside the manifest. The runner validates the manifest structure, hashes its complete bytes, and rejects a changed file. It cannot turn an arbitrary UUID or hash into proof of catalogue provenance. Select the manifest's board, account, angle, rendering mode, and search order through the normal app before capturing. Every measured checkpoint verifies the observed board/account/rendering against the manifest. An index whose fetched UUID differs is rejected.

Memory carousel Maestro flows have a whole-flow deadline of 60,000 ms by default. Set `--memory-flow-timeout-ms 90000` prospectively when a normal nineteen-swipe flow needs more time; accepted values are integers from 1,000 through 120,000 ms. The setting applies to memory carousel browsing, including prewarming and separate ownership runs. It does not change navigation, per-target waits, render drain, background clearing, UUID checks, or ownership-tool deadlines. The effective value is saved in `memory-run-options.json` before browsing and in completed measurement artifacts. Flow filenames include `prewarm`, `measurement`, or `ownership` so stages cannot overwrite each other. Each flow also saves `*-result.json` beside its log with status, signal, error code, timeout indication, and elapsed milliseconds; it contains no environment values. Exit status zero is insufficient: any memory Maestro flow spawn error, including `ETIMEDOUT` or `ENOBUFS`, invalidates the flow independently of its exit status or timeout flag. A timed-out capture remains invalid; use a fresh run directory for a retry. Paired idle runs must use the same value as their reference; older references without this field mean the original 60,000 ms default.

Each workload first warms its disk images through the selected normal surface in a separate process: twenty targets for replay and all 400 for expanding. The app then launches a new Release process, runs two warm-up cycles over the first twenty targets, and records twenty measured cycles. Replay always targets the first twenty; expanding targets the next twenty on each measured cycle, finishing at target 400. The process must remain identical by PID, process start time, and executable for the whole measured sequence.

Each cycle records four checkpoints: settled surface, after browsing, confirmed background, and settled Home. The collector must observe pending render work drained, the real background AppState transition, and fulfilled native image-cache clearing. Home must be confirmed by the observed route. Polling has a fixed deadline; missing exports, timeouts, overflow, malformed counters, runtime replacement, or missing targeted UUIDs invalidate the capture. Viewport overlap and incidental mounted/prefetched UUIDs remain separate observations; the target count never substitutes for the observed distinct count.

The app reads an atomic local `Documents/boardsesh-profile/memory-command.json` request and replaces `memory-latest.json`. Requests identify the host command, runtime, cycle, surface, phase, and optional UUID-checked scroll/open target. Runtime snapshots contain bounded identifiers and scalar measurements only. The host retains every acknowledged snapshot, all 88 footprint samples including warm-ups, phase distributions, and cache inventories. Filenames/render signatures are not retained-object counts. The app never uploads these diagnostics.

Phase distributions exclude the two warm-ups and use nearest-rank percentiles. The `median` field is nearest-rank p50: for twenty samples, it is the tenth ordered observation. Label it p50 in reports; it does not average the two central observations.

A new reference records its own normally warmed starting inventory without `--compare-cache`. Pass `--compare-cache <reference-run>/starting-cache.json` when intentionally requiring equivalence with an existing reference. Starting inventories are taken after the two warm-ups and include board thumbnails, SDWebImage disk images, and Expo asset image files. Canonical paths, byte counts, and SHA256 must match; a mismatch rejects the comparison without deleting app data. Listing order and modification-time-only changes do not reject a comparison: native cache hits deliberately touch modification times for LRU. Raw modification times remain in the inventories. Matching disk contents do not prove identical relative LRU order, decoded-image ownership, in-memory cache state, or allocator state. Record those limits in the report.

An interrupted startup or normal warming can add a cache variant. Preserve a rejected attempt rather than deleting the new file to satisfy its old inventory. If establishing a new baseline, use a fresh run directory and let the new reference record its starting inventory; its subsequent idle control must match that inventory exactly. Never change an inventory or remove a gate to resume an existing run under the same identity.

An idle control uses the same surface's completed browsing capture as its elapsed schedule:

```sh
# Use the same owned simulator, manifest, source, and configuration flags.
vp run mobile:profile:ios -- \
  --udid <owned-simulator-udid> \
  --scenario memory --surface list --workload idle \
  --memory-manifest .boardsesh/ios-memory-climbs.json \
  --idle-schedule .boardsesh/memory-list-replay/measurements.json \
  --run-dir .boardsesh/memory-list-idle
```

Idle warming uses the reference workload in a separate process. The measured process stays on Home apart from the matching background transitions. Both checkpoint requests and sample completions are matched against the reference schedule; a difference exceeding two seconds is rejected. The selected manifest and surface must match the reference, and the idle starting inventory must match the reference's recorded inventory even without an explicit `--compare-cache` flag. The reference must contain exactly one validated cycle-zero inventory; missing or malformed inventories are rejected before app launch. An explicit `--compare-cache` adds a separate required comparison.

Use `--inspection ownership` for supplemental ownership evidence **after** the ordinary Release samples. It launches another process and repeats two warm-ups plus twenty cycles. At settled Home after cycles zero and twenty it saves `leaks --outputGraph` survivor graphs, bounded `heap -s` graph summaries, `leaks --list --noContent` summaries, and `vmmap -summary`. The first checkpoint also probes a ten-second Instruments Allocations capture on the explicitly owned simulator with a thirty-second total completion deadline. A trace is usable only after a successful XML export containing allocation rows. Failed traces are retained. Only the recorder's owned process group is signalled; unconfirmed cleanup prevents further attachments. Supplemental failure is reported separately and never relabels completed ordinary samples as allocation evidence.

The exported `captureOwnershipCheckpoint` helper also supports equivalent manually selected checkpoints. Allocation stack logging, if necessary, belongs in another explicitly configured process; Hermes heap capture requires a separate capability check and is not assumed available in embedded Release. Compare surviving objects and their reference owners before calling any growth a leak. Allocator high-water memory, decoded-image caches, and a larger collection of intentionally retained scalar keys can increase footprint without an ownership defect. Keep physical-device conclusions pending.

### Ownership capture without repeating ordinary samples

An existing verified Release export can drive a separate ownership investigation directly:

```sh
vp exec tsx scripts/mobile-profile-capture.ts \
  --udid <owned-simulator-udid> \
  --app-id com.boardsesh.app \
  --app-path /path/to/verified/Boardsesh.app \
  --configuration Release --scenario memory \
  --surface list --workload replay \
  --memory-manifest /path/to/frozen-climbs.json \
  --inspection-only true --inspection graphs \
  --failed-allocation-probe /path/to/failed/allocations-recorder.json \
  --compare-cache /path/to/ordinary-run/starting-cache.json \
  --run-dir /path/to/fresh/ownership-run
```

Keep the existing simulator lease environment when invoking this command. `--inspection-only true` starts one fresh Release process and drives two warm-ups plus twenty measured browsing cycles, with all four diagnostic checkpoints per cycle. It preserves the inherited disk cache; it does not perform another all-400 disk-warming pass. Run the ordinary affected workload first and use `--compare-cache` to enforce matching material disk contents at Home after warm-up cycle zero. The investigation also records the cache inventory at Home after cycle twenty.

Use `--inspection ownership` to attempt a new bounded Allocations probe at Home zero. The explicit `graphs` fallback skips that probe only when `--failed-allocation-probe` contains a failed ten-second Allocations attachment to this same explicitly selected simulator, a positive attached app PID and recorder PID, and the retained trace output path. The host records that artifact's path and SHA256 and checks both the recorder PID and its process group with signal zero. Only `ESRCH` for both establishes absence; a live recorder, live group, or permission error rejects fallback attachment. This read-only check never sends a shutdown signal. The failed probe remains failed, even when subsequent graph captures succeed.

The output is `ownership-measurements.json`, with `scenario: "ownership"`, 88 diagnostic observations, and graph checkpoints zero and twenty. It contains no ordinary footprint samples and creates no ordinary `measurements.json` or `memory-samples.json`. Both checkpoints must have usable saved survivor graphs before the ownership verdict can be completed and valid. Partial evidence remains under `ownership/`, whose verdict distinguishes a completed browsing workload from an available graph comparison. App/runtime replacement, missing UUIDs, incomplete rendering or background clearing, changed configuration, cache mismatch, or unconfirmed recorder cleanup rejects the investigation. A valid pair of graphs still requires reference-owner inspection before it supports a leak finding.
