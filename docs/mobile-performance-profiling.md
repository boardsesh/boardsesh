# Mobile CPU profiling on physical phones

Use the current HIG implementation as baseline A and a pinned optimization
commit as candidate B. Historical pre-HIG results provide context; they do not
identify the component responsible for a regression.

`vp run mobile:profile` prepares isolated source worktrees and collects segmented
CPU measurements from physical Release builds. Native templates live under
`scripts/fixtures/mobile-profile` and are injected into profiling worktrees.
The shipping mobile app does not import them.

If a startup correctness failure prevents loaded-content validation, preserve
the original startup attempts as a separate reliability cohort. Apply the
same reviewed correctness fix to both comparison sources, record the derived
baseline and candidate commits, and verify identical fix bytes. The resulting
comparison measures the UI changes with that shared correction. Report this
change to the baseline explicitly; retain every failed launch.

## Prepare the builds

Select an explicit physical iPhone UDID or Android serial. Keep the original app
installed. The profiling clone uses `com.boardsesh.app.perf` and
`boardsesh-perf://`, with separate app groups, keychain groups and notifications.
OTA and dotenv loading are disabled. The profiling worktree excludes
`expo-observe` and `expo-app-metrics` from native autolinking and replaces their
JavaScript bootstrap/root integration with inert shims. The root shim preserves
the original host layout. Both A and B must use the same isolation patch.
Do not rely on blank API keys, sampling rates or a removed endpoint to disable
native telemetry: SDK defaults can still collect or dispatch it.

```sh
vp run mobile:profile -- prepare --suite hig-cpu \
  --source-ref <commit> --platform android --device <serial> \
  --fixtures <fixture-directory> --run-dir <new-evidence-directory> \
  --backend-url http://127.0.0.1:8198 --control-url ws://127.0.0.1:8199
```

Preparation emits `prepare.json`, a private `build-env.json`, the instrumentation
patch, and a native-build handoff. Use the exact environment for the Release
build. After dependency installation and before prebuild, verify Expo's actual
module resolver on both platforms:

```sh
vp exec node --import tsx scripts/mobile-profile-validate-autolinking.ts \
  <prepared-evidence-directory>
```

iOS builds must use the Boardsesh shared-cache lock; Android builds must
include the phone's architecture. Preserve the exported artifact and symbols.
Both variants need the same instrumentation, fixtures and signing identity.
Disable CI cache reuse for local iOS bundling (`CI=0`): Expo ignores the native
script's `--reset-cache` under `CI=1`, which can retain environment constants
from another worktree. Verify the expected profiling identifiers in the export
and require a matching native handshake before accepting measurements.
If a template changes, prepare and rebuild both variants.

If Expo selects a wildcard profile without the clone's app-group/keychain
capabilities, build the generated iOS workspace under the same cache lock with
`xcodebuild build -configuration Release -destination id=<udid>
-allowProvisioningUpdates -allowProvisioningDeviceRegistration
DEVELOPMENT_TEAM=<team> CODE_SIGN_STYLE=Automatic`. Record the exact command
and expanded signed entitlements. Preserve the canonical exported directory
name `BoardseshPerf.app`; separate variants with parent evidence directories.
Before installation, run the embedded-identity gate:

```sh
vp exec node --import tsx scripts/mobile-profile-validate-artifact.ts \
  <prepared-evidence-directory> <exported-Release.app-or-apk>
```

This preflight checks embedded literals and artifact hashes. The subsequent
native handshake must still prove the installed physical runtime and PID.
Require native module absence in both the autolinking output and runtime
handshake, and inspect fresh clone-only startup logs before measurement. The
correct `extra.eas.observe` endpoint must point to the private replay origin
as a fallback, never a production default. Retire artifacts that fail any
isolation gate and preserve their captures as diagnostic evidence only.

The fixture manifest must explicitly include the initial `PrivacyChanged: true`
subscription snapshot and valid `SyncDeletions` pages. Preserve recorded sync
work and terminal cursors. Do not substitute a quiet subscription or suppress
privacy invalidation. The replay backend keeps subscription streams open.
Document synthetic scenario responses separately from recorded upstream data.

## Connect and capture

Android can use `adb reverse` for both ports with a loopback-only backend:

```sh
vp run mobile:screenshot-backend -- --mode replay --host 127.0.0.1 \
  --port 8198 --fixtures <fixture-directory>
adb -s <serial> reverse tcp:8198 tcp:8198
adb -s <serial> reverse tcp:8199 tcp:8199
```

An iPhone needs a reachable local endpoint. Confirm permission to expose the
fixture server on that network before binding it there. Remove only forwarding
rules and processes owned by the capture. Never uninstall or clear app data.

Use Maestro on Android and an owned XCTest/WebDriverAgent runner on physical
iPhone. Official Maestro does not support physical iPhones. The bounded iPhone
adapter reads the same YAML format, supports explicit touch endpoints, and
attaches to the running clone without relaunching it. Stage the pinned driver
with `scripts/mobile-profile-ios-driver.ts`, build its own runner bundle ID,
and forward its port over USB to loopback. Do not reuse another task's runner.
The adapter rejects existing sessions and checks the selected device and PID.

Write a flow targeting `com.boardsesh.app.perf`. Assert actual loaded
climbs, logbook entries and playlist content, using the same logical identities
on both variants. A persistent current-climb banner cannot establish a list
row's identity. Scope names to the touched row and verify its restored position.
Native iOS container visibility may differ from its visible content: require
loaded visible children rather than container presence alone. Revealed rows
translate their touch rectangles, so calibrate closing gestures against the
actual visible row and cap partial gestures below the full-commit threshold.
Include explicit paired boundaries:

```yaml
- runScript:
    file: /absolute/repo/scripts/fixtures/mobile-profile/mark.js
    env:
      SEGMENT: climbs-scroll
      BOUNDARY: start
# Fixed gestures and loaded-content assertions go here.
- runScript:
    file: /absolute/repo/scripts/fixtures/mobile-profile/mark.js
    env:
      SEGMENT: climbs-scroll
      BOUNDARY: end
```

Start the collector before launching the installed clone. It waits 45 seconds
for a matching native identity and does not install, launch or reset the app:

```sh
vp run mobile:profile -- capture --suite hig-cpu \
  --source-ref <commit> --platform android --device <serial> \
  --fixtures <fixture-directory> --run-dir <prepared-evidence-directory> \
  --backend-url http://127.0.0.1:8198 --control-url ws://127.0.0.1:8199 \
  --control-bind 127.0.0.1 --app-path <exported-Release.apk> \
  --flow <segmented-flow.yaml> --warmups 2 --cycles 10
```

For iPhone captures, also pass `--ui-driver wda --wda-url http://127.0.0.1:8211`
and use the iPhone's LAN backend/control origins. The UI runner remains on USB.

For alternating A/B pairs, use one measured cycle per invocation and keep
separate capture output directories as required by the collector. Install the
verified variant without clearing storage, then launch it after control
readiness. Keep warmup and fresh-install sync results separate from settled
browsing results. Use the same discarded conditioning tour after every variant
swap, and compare idle CPU before accepting a settled browsing measurement.
A warmup in one app process does not condition a newly launched process.

## Acceptance evidence

CPU is cumulative own-process time: iOS `getrusage` user plus system time, and
Android `Process.getElapsedCpuTime`. Segment duration uses the native monotonic
clock. CPU percentages can exceed 100% when multiple cores work concurrently.

Every boundary requires a native acknowledgment. Stale build IDs, bundle hashes,
PIDs, backward counters, disconnects, timeouts, incomplete flows, changed loaded
fixture identity and new fixture misses invalidate the capture. The backend's
manifest hash identifies its loaded manifest bytes; preserve fixture payload
hashes and replay-source provenance separately.

Run two warmups, five A/A noise pairs, ten alternating A/B pairs, then an
independent final batch. Record battery, charging, thermal state, power mode,
display settings, OS and app versions. Compare medians and paired differences
against measured noise. A/A pairs must repeat the same install, launch and
conditioning schedule as A/B pairs. Consecutive cycles in one process provide
only an additional noise-floor estimate.

Keep broad navigation/QA segments separate from narrow gesture windows. Resolve
logical identity and touch geometry before the narrow start acknowledgment;
place explicit assertions and screenshots after its end acknowledgment. Include
a fixed bounded settling interval after touch completion to capture animations.
Report the remaining driver overhead explicitly: these measurements are gesture
and settling CPU, not isolated rendering CPU. Retain changes that improve CPU
or frames without regressing behavior or memory.

Collect native attribution separately: Instruments Time Profiler and frame/hitch
evidence on iPhone, Perfetto scheduling and FrameTimeline evidence on Android.
Trace overhead must not be mixed with acceptance CPU measurements. Device logs
or host process CPU are not substitutes for native frame evidence.

If Instruments command-line export fails, retain the trace and crash report.
Inspect a copy in Instruments and preserve the actual visible tables, process
filter and selected time range. Opening a trace alone does not establish readable
stack or frame evidence. Gesture injection may itself invoke accessibility work;
use native stacks to assess that residual driver cost without subtracting an
estimated overhead from acceptance CPU.

For hidden startup errors, use a separate local diagnostic build with bounded,
sanitized reporting, distinct build identity and recorded patch provenance.
Mark it `diagnosticOnly: true` and `acceptanceEligible: false`. The collector
rejects diagnostic metadata, environment flags and embedded diagnostic markers;
these builds cannot supply A/A, A/B or holdout samples.

Check first swipe reveal, full-swipe commit, vertical scrolling, row recycling,
repeated taps, localization, Bold Text, Reduce Motion and screen-reader actions.
Both physical platforms must pass before claiming the optimization is accepted.
Widget interactions are excluded when the profiling clone's widget credential
configuration cannot be provisioned equivalently.
