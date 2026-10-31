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
vp run qa:boards -- sessions
vp run qa:boards -- all
```

`--config FILE` selects another local configuration. `--output DIR` selects a private evidence directory. Default output is `.boardsesh/board-qa-runs/<run-id>/`.

Driver source is `https://github.com/devicelab-dev/maestro-runner` at commit `ee71b5903bbaba4f33c150e5e7c5b059f15f6f14`. Use a fresh staging directory; source/receipt mismatches are rejected. The returned helper installs only its own runner, preserving the Boardsesh app and its storage.

For a physical Android build, use `vp run mobile:android-apk -- --require-fresh --abi arm64-v8a`. On macOS, configure `JAVA_HOME` to an installed JDK 21 first; the automatic JDK download targets Linux. The existing emulator default remains `x86_64`; APK validation and local caches keep the two ABIs separate. Install updates in place with the matching development signature, never by uninstalling or clearing the Play app. If Android rejects the separate debuggable development app because its local version code is lower, `adb -s ANDROID_SERIAL install -r -d PATH_TO_DEV_APK` permits that development update while retaining its data.

`doctor` checks physical devices, tooling, account access, pinned static climbs, WDA attachment and read-only fixture status. It does not take a BLE connection, acquire the firmware QA lease, or create a session. A missing prerequisite exits with code 2.

`solo` and `sessions` each run all three board families with each platform taking a turn as holder. They require normal English UI for native End/Leave labels. Each board has a real 65-second membership dwell before durable-history assertions. Foreground delivery has a 30-second completion deadline; supported background delivery has 60 seconds. These deadlines are completion bounds, not latency targets.

The first product or infrastructure failure stops dependent scenarios so leftover state cannot produce misleading passes. Unrun scenarios are not passes. The report distinguishes `failed`, `blocked`, and `infrastructure`; known bugs are not silently skipped. Exit code 1 indicates a test or infrastructure failure. A driver endpoint disappearing does not establish an app crash.

## What counts as a send

For each send the runner requires a newer ESP32 completed-command sequence, an exact decoded position/color pattern, the expected connection generation, matching live holder attribution, a matching subscription event, and durable history on the same saved wall UUID. A title change, bulb icon, first ATT chunk, LED count alone, or queued mutation is insufficient. The other two boards must receive no writes.

Public climb links open private previews. The driving check queues a pinned successor through Play next, reopens the committed climb from its mini-player, and uses the real Next control. Entering Drive can reassert that same climb within the server's ten-second history deduplication window; this setup is recorded separately as `physical-drive-setup`. The following Next still requires fresh physical delivery, subscription and history evidence.

MoonBoard multi-chunk tests require more than one received write. Diagnostic colors are firmware-decoded colors: Aurora v3 red/green peak at 252 after quantization, not 255. Timing artifacts measure host-request-to-observation, including UI-driver and polling overhead; they are not radio durations or latency percentiles.

The passive observer only queries/subscribes. It never joins the crew, claims a wall, writes presence, or logs a tick. Histories are checked relative to their starting sequences; existing records are retained. No climbing activity is invented through direct backend mutations.

The observer uses the app's five-second protocol keepalive and answers native WebSocket pings. It records socket lifecycle, close codes and reasons. A closed connection or missing heartbeat fails the run as infrastructure; it does not reconnect across a gap in the evidence.

Native versions and launched Expo runtime/update identifiers are recorded separately. Metro builds identify their development mode; the checkout SHA in `run.json` is not independent proof of which JavaScript a remote Metro client loaded. Keep development-source and installed-release verdicts distinct.

## Recovery and limits

The firmware lease lasts 30 seconds and is renewed by the owner. Ending a run or lease expiry restores the normal concurrent fixture policy. Per-board live takeover mode invalidates the old writer and disconnects only that board's old connection. It models exclusive control; it does not establish stock-controller takeover behavior, especially when all three radio slots are occupied.

The runner leases phones and the USB port locally. If it reports a stale lock, inspect the recorded PID before removing the lock. Never kill a process by a common runner name or steal another QA session's hardware.

On failure, inspect `report.json`, `events.jsonl`, the phone hierarchy/screenshots and `recovery.json`. A retained session is identified explicitly: end it normally on its creator phone. Session ending and BLE disconnect do not delete saved history. If a phone is locked or its driver dies, recover that prerequisite before continuing; do not reset app data or the fixture to hide the failure.

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
