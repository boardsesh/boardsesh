# Local board hardware QA

This suite coordinates one physical iPhone, one physical Android phone, the existing unlisted [Boardsesh QA gym](https://www.boardsesh.com/gym/boardsesh-qa), and the USB-connected Waveshare ESP32-S3 AMOLED fixture. It exercises normal app controls and real Bluetooth. It never runs in CI or uses screenshot-mode fake Bluetooth.

The scenarios come from [release QA #7010](https://github.com/boardsesh/boardsesh/issues/7010). Existing product defects remain failing tests linked to their issues; running a test does not imply that defect is fixed.

## Prepare once

1. Connect and unlock both phones over USB. Enable development/trust access, grant Bluetooth/Nearby devices access and Android board notifications, and sign in normally as the two QA accounts. The runner refuses an unexpected account and never signs it out, clears storage, or guesses a PIN. Use app builds containing the new test identifiers; older store builds fail the selector checks.
2. Stage the pinned physical-iPhone driver with `vp run qa:boards:ios-driver -- stage SOURCE STAGE IPHONE_UDID TEAM_ID`. Run the exact build command it prints, then `vp run qa:boards:ios-driver -- prepare-launch STAGE`. Run both returned launch and USB-forward commands in separate terminals. The standard-library USB helper needs no `iproxy` installation. The runner validates its device process and refuses an existing WDA session. Standard Maestro cannot control physical iPhones; Android uses the installed Maestro CLI.
3. Back up the ESP32 flash before changing firmware. Build and upload `waveshare-amoled-gym` using the pioarduino Core version supported by its platform; retain its partition layout, gym key, WiFi settings and asset cache. Do not erase flash. USB diagnostics must report QA schema 1 and the three production QA board UUIDs.
4. Run `vp run qa:boards -- init`, then inspect `.boardsesh/board-qa.json`. Replace the device/serial placeholders and check app IDs, adb path and WDA URL. The example defaults to the separate Android development app; the Play app stays installed.
5. Create the configured private credentials JSON mapping each QA email to its password, with owner-only permissions (`chmod 600`). Keep it under `.boardsesh/`; neither passwords nor tokens belong in source, commands, screenshots, or issue attachments.

## Run

```sh
vp run qa:boards -- doctor
vp run qa:boards -- solo
vp run qa:boards -- mixed
vp run qa:boards -- sessions
vp run qa:boards -- all
```

`--config FILE` selects another local configuration. `--output DIR` selects a private evidence directory. Default output is `.boardsesh/board-qa-runs/<run-id>/`.

Driver source is `https://github.com/devicelab-dev/maestro-runner` at commit `ee71b5903bbaba4f33c150e5e7c5b059f15f6f14`. Use a fresh staging directory; source/receipt mismatches are rejected. The returned helper installs only its own runner, preserving the Boardsesh app and its storage.

For a physical Android build, use `vp run mobile:android-apk -- --require-fresh --abi arm64-v8a`. On macOS, configure `JAVA_HOME` to an installed JDK 21 first; the automatic JDK download targets Linux. The existing emulator default remains `x86_64`; APK validation and local caches keep the two ABIs separate. Install updates in place with the matching development signature, never by uninstalling or clearing the Play app. If Android rejects the separate debuggable development app because its local version code is lower, `adb -s ANDROID_SERIAL install -r -d PATH_TO_DEV_APK` permits that development update while retaining its data.

`doctor` checks physical devices, tooling, account access, pinned static climbs, WDA attachment and read-only fixture status. It does not take a BLE connection, acquire the firmware QA lease, or create a session. A missing prerequisite exits with code 2.

`solo` runs six single-board cases followed by six cross-board cases. `mixed` runs only those six cross-board cases, making an affected-scope retry explicit. `sessions` runs six shared-session cases. Each scope covers all three board families with each platform taking a turn as holder; `all` retains all eighteen cases. They require normal English UI for native End/Leave labels. Each board has a real 65-second membership dwell before durable-history assertions. Foreground delivery has a 30-second completion deadline; supported background delivery has 60 seconds. These deadlines are completion bounds, not latency targets.

Before each independent cross-board or shared-session case, the runner requires zero fixture links and a visibly inactive Record screen, then restarts the relevant app and verifies the same account/runtime. It rechecks zero links immediately before termination. This bounds accumulated native navigation without restarting within source → target → Previous continuity or an active session.

The first product or infrastructure failure stops dependent scenarios so leftover state cannot produce misleading passes. Unrun scenarios are not passes. The report distinguishes `failed`, `blocked`, and `infrastructure`; known bugs are not silently skipped. Exit code 1 indicates a test or infrastructure failure. A driver endpoint disappearing does not establish an app crash.

## Fallback: physical iPhone with an Android emulator peer

Use this separate local profile when the second physical phone is unavailable. The iPhone is the only Bluetooth holder; the native Android emulator joins as another signed-in climber and relays requests through that iPhone. The existing `qa:boards all` matrix remains unchanged. Do not describe a successful fallback run as a complete physical-device matrix.

1. Prepare an isolated Android emulator with the normal development app installed and the second QA account signed in. Keep the iPhone signed into the first account. Use an exact `emulator-PORT` serial; the runner checks Android's virtual-machine property and never targets the unavailable physical phone. Sign in normally before running; this profile records no password entry and preserves app data.
2. Launch dedicated production-connected Metro from this checkout with `EXPO_PUBLIC_SCREENSHOT_MODE=0`, `EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=0`, and `EXPO_PUBLIC_BACKEND_URL=https://ws.boardsesh.com`. Retain its actual listening PID and loopback URL. Normal app source and native runtime must match; do not load screenshot-mode or fake-Bluetooth JavaScript.
3. Run the two commands below, replacing the example serial, PID and port. The physical fixture must have no existing links or owner. `doctor` checks prerequisites without acquiring Bluetooth or creating a crew session; `run` performs the selected scenarios.

```sh
vp run qa:boards:simulator-peer -- doctor --peer emulator-5588 --metro-pid PID --metro-url http://127.0.0.1:8179
vp run qa:boards:simulator-peer -- run --peer emulator-5588 --metro-pid PID --metro-url http://127.0.0.1:8179
```

`--config FILE` uses the existing private physical configuration for the iPhone, accounts, fixture and catalog. The emulator serial replaces its Android device ID in memory only. `--peer-app-id APP_ID` optionally selects the installed emulator package; `--output DIR` selects the private evidence directory. The profile retains the configured Android account and scheme. It never uninstalls, clears data or enters credentials.

Preflight checks the actual Metro listener and normal-mode flags without saving its process environment. On the exact emulator, it verifies or creates the matching `adb reverse` port mapping and refuses a conflicting destination. It then restarts only that emulator app and launches its selected package using the configured scheme and `http://127.0.0.1:PORT` development-client URL. A bounded wait for existing native app content precedes the account link; native activity launch alone is insufficient. The signed-in account and `app-runtime-metro-...` marker must then match. There is no startup retry or fixed delay. Native versions, actual runtime markers, Metro metadata and participant capabilities are recorded separately. A Metro checkout marker identifies the server; the explicit launch plus native account/runtime checks bind the peer process. The physical iPhone keeps its independently recorded installed update/runtime.

For all three families, this profile tests iPhone connect, Drive and real Next, stop, private preview, deliberate Put, peer preview/history and Disconnect. It also tests iPhone-only board switching. Foreground crew cases cover invite/join, both identities and rosters, peer preview isolation, remote Put, physical clear and peer re-light, history, observed Leave to one member, rejoin and End. Every claimed send still requires a fresh exact USB-decoded pattern, the expected physical connection generation, iPhone holder attribution, subscription event and durable history. Clear requires a fresh empty physical packet on that same connection, a clear event, retained holder, the holder’s dark state, and the peer’s current climb moving into its exact fresh history row. The peer then re-lights that same climb; this still requires a fresh physical delivery and the complete backend evidence chain. Clear does not invent a climb-history entry. Other boards must remain untouched. Each board retains the real 65-second history dwell.

Before each case, the runner verifies zero physical links and a real Record screen with no retained session, then safely restarts the iPhone and rechecks the same account/runtime to bound stacked preview routes. It never restarts a live holder. Private `fallback-FAMILY-driving.png` and `fallback-FAMILY-preview-plain.png` captures support visual review of driving frost and the plain preview state. Normal Disconnect, or a targeted drop while this run still owns the firmware lease, precedes fixture release during cleanup.

`coverage.json` identifies the physical iOS holder and emulator peer, their capabilities and the final selected-scope outcome. Physical Android holder behavior, physical handoff/takeover, Android background/notification delivery, and suspended-iOS wake/recovery remain explicitly **unrun**. Simulator UI and remote relay coverage do not establish those capabilities. `allMatrixPassed` is always false for this profile, including when every selected scenario passes.

When no native peer can launch, explicitly select the narrower physical-iPhone-only mode:

```sh
vp run qa:boards:simulator-peer -- doctor --holder-only
vp run qa:boards:simulator-peer -- run --holder-only
```

This mode runs exactly six cases: three iPhone solo cases and three iPhone board-switch isolation cases. It keeps all physical payload, generation, backend subscription/history, safe case-boundary and cleanup requirements, plus the six driving/plain-preview screenshots. Only the iPhone visits each board for the real history dwell. The existing private configuration is retained, but the runner neither leases nor accesses its Android device, constructs a peer driver, reads a peer password, signs in a peer, checks Metro, or invokes any peer UI. No `--peer` or Metro arguments are required. Coverage records only the physical holder, `verifiedPeer: false`, all peer observations and all crew/roster/relay/clear/re-light scenarios as **unrun**. This mode is opt-in; the default simulator-peer profile and original physical `all` matrix retain their prerequisites.

## What counts as a send

For each send the runner requires a newer ESP32 completed-command sequence, an exact decoded position/color pattern, the expected connection generation, matching live holder attribution, a matching subscription event, and durable history on the same saved wall UUID. A title change, bulb icon, first ATT chunk, LED count alone, or queued mutation is insufficient. The other two boards must receive no writes.

Public climb links open private previews. The driving check queues a pinned successor through Play next, reopens the committed climb from its mini-player, and uses the real Next control. Entering Drive can reassert that same climb within the server's ten-second history deduplication window; this setup is recorded separately as `physical-drive-setup`. The following Next still requires fresh physical delivery, subscription and history evidence.

MoonBoard multi-chunk tests require more than one received write. Diagnostic colors are firmware-decoded colors: Aurora v3 red/green peak at 252 after quantization, not 255. Timing artifacts measure host-request-to-observation, including UI-driver and polling overhead; they are not radio durations or latency percentiles.

Shared-session UI gates use the visible climbing-count Text, whose identifier binds the actual session UUID and deduplicated participant count. Native avatar identifiers and backend roster/profile checks independently verify identities. The older root session marker is retained as metadata; a hierarchy entry alone is not proof that presence is visible. Use a compatible PR preview containing these identifiers before running shared-session cases.

The passive observer only queries/subscribes. It never joins the crew, claims a wall, writes presence, or logs a tick. Histories are checked relative to their starting sequences; existing records are retained. No climbing activity is invented through direct backend mutations.

The observer uses the app's five-second protocol keepalive, requires the matching pong within 20 seconds, and answers native WebSocket pings. It records send completion, matching sequence/round-trip time, bounded socket counters and buffering, deadline lag, close codes/reasons and whether shutdown was locally requested. Diagnostics omit socket addresses and authentication headers. A closed connection or missing heartbeat latches the first infrastructure failure, immediately cancels this runner's pending UI commands and blocks subsequent mutations. An OS action already dispatched may finish; without the full evidence chain its output is unconfirmed. Read-only failure artifacts remain available, and cleanup releases owned resources. The observer never reconnects across a gap in the evidence.

Native versions and launched Expo runtime/update identifiers are recorded separately. Metro builds identify their development mode; the checkout SHA in `run.json` is not independent proof of which JavaScript a remote Metro client loaded. Keep development-source and installed-release verdicts distinct.

## Recovery and limits

The firmware lease lasts 30 seconds and is renewed by the owner. Ending a run or lease expiry restores the normal concurrent fixture policy. Per-board live takeover mode invalidates the old writer and disconnects only that board's old connection. It models exclusive control; it does not establish stock-controller takeover behavior, especially when all three radio slots are occupied.

The runner leases phones and the USB port locally. If it reports a stale lock, inspect the recorded PID before removing the lock. Never kill a process by a common runner name or steal another QA session's hardware.

On failure, inspect `report.json`, `events.jsonl`, the phone hierarchy/screenshots and `recovery.json`. A retained session is identified explicitly: end it normally on its creator phone. Session ending and BLE disconnect do not delete saved history. If a phone is locked or its driver dies, recover that prerequisite before continuing; do not reset app data or the fixture to hide the failure.

For USB diagnosis, set `BOARDSESH_QA_USB_TRACE` to a fresh local JSONL path. Capture is off by default, creates an owner-only file, refuses existing files and symlinks, and records exact bytes before parsing. The 16 MiB limit or an I/O failure marks the capture incomplete without changing parser results. These raw traces stay private; do not attach them to issues or commit them.

The known suspended-iOS cross-device wake gap is tracked in #2174 and documented in `docs/live-activity-push-testing.md`. Keep that limitation separate from supported Android background delivery and iOS foreground recovery. Fixture results do not prove serial-less controller support, stock MoonBoard clear behavior, or actual wall LED placement. General release QA, workouts and tick logging remain separate work.

## Pinned catalog fixtures

The example pins UUIDs so duplicate names cannot change the hardware pattern. Read-only production lookup on 2026-10-31 confirmed these static climbs. Moon Landing selected KilterStudio's 13-hold climb (7,608 ascents at 40°); two lower-ascent namesakes have 10 and 15 holds. Every other listed name had one exact normalized-name match. Future fixture replacements require reviewing the UUID, geometry and decoded pattern; an ambiguous name-only configuration fails.

| Board | Climb | UUID | Holds |
| --- | --- | --- | --- |
| kilter | Moon Landing | `2657B92D24E541098E27963FFE5B5B0C` | 13 |
| kilter | Angel Eyes | `9CD48F5E74D04A22AFF6371135790345` | 9 |
| kilter | Half Mast | `EBF35B35CF384C53840F4B39EC6D3FBE` | 14 |
| tension | Putty | `BA608169C0114B8ABB0AD7E7BA0D27C1` | 15 |
| tension | Propagation | `823A103296DA449C90C4B865B5031629` | 13 |
| tension | Compliments To The Climber | `D6B81C3306C74A308E795CFCBADB78DB` | 17 |
| moonboard | FUNNY THING | `483c1234-b9c4-5570-b871-7ddc37ed534d` | 10 |
| moonboard | DUNES | `fcda5dce-4493-5b9a-8d88-43fe0ba86a86` | 8 |
| moonboard | MOON GIRL | `62f43f16-9ac8-59d7-8803-794268fec151` | 10 |
