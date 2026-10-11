# Testing what the climber sees and waits for

How to find out, on a real phone, how often the app shows something wrong for a moment (a board with no holds, a drawer that fills in late) and how long the climber waits (for a page of climbs, for the drawer, for the first screen), and how to prove a change made those numbers better.

This is the method behind #6301 (thumbnails arrive with their holds), #6313 (pages of climbs off an index) and #6300 (the blank Safari tab at launch). It was run on a wired iPhone 13 Pro on 10 and 11 October 2026. The Android half has not been run; what it needs is in [Android](#android).

Two other docs measure different things, and this one does not replace either:

| Doc | Answers | Build |
| --- | --- | --- |
| `docs/mobile-performance-profiling.md` | Did process CPU go down? Paired A/B on physical phones, acceptance evidence. | Isolated profiling clone, replayed backend |
| `docs/ios-profiling.md` | Startup phases, memory, React attribution on a simulator. | Dedicated simulator checkout |
| This doc | How many times did the climber see a defect, and how long did they wait? What caused it? | The real app with probes added, the real account and downloads |

A probe build is a diagnostic build in the other docs' terms. Its numbers find causes and compare two builds made the same way. They are never CPU acceptance evidence.

## The loop

1. **Reproduce by remote control.** Drive the phone from the laptop with a fixed script, so the same gestures run on every build.
2. **Count what the eye saw.** Add probes that record the moment something became visible and whether it was complete. A recording shows that a flash happened; a probe says how many, on which rows, and why.
3. **Measure the baseline first.** Run the script on `main` before changing anything, and keep the run.
4. **Change one thing, rerun the same script.** Compare counts, not impressions.
5. **Look at the screen.** Film the hard case and read the frames. A probe can be wrong about what was on screen.

## Before you start

1. **Check whether the board is downloaded for offline.** A downloaded board reads from the phone's database; anything else reads from the network. They are different code paths with different numbers. Write down which one a run used. The page probes say so (`offline-request`, lane `local` or `network`).
2. **Never answer the analytics consent prompt during a test.** The answer is recorded against the signed-in account. Build with `--settle-consent` instead (below).
3. **Do not delete app data or uninstall.** The downloaded boards, the queue and the account are the test data. A cold start means a new process, not a clean install.
4. **Use an account with a real history** when the change touches the logbook or the queue. The slow paths scale with it.
5. **Note the conditions**: phone model, OS, battery and charging, Low Power Mode, what else the laptop is doing. A laptop under load makes its own numbers useless; the phone's are unaffected.

## The probe build

`scripts/mobile-probe-kit/probe/apply_probes.py` edits a checkout so that the app records timing events. It adds one module, `packages/mobile/src/lib/perf-probe.ts`, and calls into it from the places below. Nothing here ships: the build script puts the tree back afterwards, and the module does nothing unless the bundle was built with `EXPO_PUBLIC_PERF_PROBE=1`.

Every edit is an exact-text replacement that asserts its anchor occurs once. When the code under a probe moves, the script fails and names the anchor. Re-fit it; the table says what the probe is for.

| Event | Recorded when | Fields that matter |
| --- | --- | --- |
| `overlay-shown` | A hold overlay image finishes loading into a row or the play board | `cacheType` (`memory` means it was already decoded), `gated` (the row was held back as a placeholder until now), `play` |
| `overlay-painted` | First paint of the holds for the climb a surface is showing | `waitMs` from the row getting that climb, `indexHit` (the render already existed), `surface` |
| `overlay-missed` | A row moved on to another climb before its holds ever painted | `shownMs` |
| `overlay-render` | A native overlay render finished | `queueMs` waiting for the scheduler, `nativeMs` rendering, `surface` |
| `background-load` | A board photo layer loaded | `cacheType`, `width` |
| `search-page` | A page of the climb list arrived | `page`, `fetchMs` as the list experienced it |
| `offline-request` | A local-first request was answered | `lane` (`local` or `network`), `surface`, `ms` |
| `offline-gate` | The decision whether a request may be answered locally | `gateMs`, `canServe` |
| `climb-press`, `play-route-mounted`, `play-carousel-mounted`, `play-board-measured` | Stages of opening the play drawer | time since `climb-press` |
| `js-frame-gap` | The JS thread went 34 ms or more between two frame callbacks | `gapMs` |

Two flags change behaviour, on purpose and only in this build:

- `--settle-consent` skips the consent prompt and leaves consent undecided, so analytics stay off. It reuses the path screenshot mode takes.
- `--keep-offline-boards` ignores the privacy stream. The server sends one event per subscribe, which is every launch, and each one drops every offline board's checkpoints (#6306). Without the flag the board re-downloads between runs and no two runs see the same data. Remove the flag when #6306 is fixed.

Events are written to `Documents/perf-probe/` on the phone as JSON chunks and pulled after the run. A Release build drops `console.log`, so the log is not a transport. The folder is emptied at each launch: pull before you relaunch.

`probe/apply_launch_markers.py` adds a `render` event to the components mounted at launch, the saved queue coming back, and which climb each detail read was for. Its first marker is in the root layout, and that is what starts the stall monitor early enough to see a launch.

### Switching one thing inside one build

The cleanest comparison is the same binary with one code path off. The probe module reads marker files from `Documents/` at launch and deletes them:

| Marker | Effect for that launch |
| --- | --- |
| `perf-probe-cold` | Empties the hold-overlay cache, so every thumbnail has to be rendered again |

Add a marker for the path under test: read it once at module load, export a constant, and branch on it where the new code is chosen. #6313 was measured this way (the indexed reader off and on, in one build): 1.4 to 2.2 s a page against 2 to 36 ms. The alternative is two builds, which also changes everything else that differs between them.

### Do not move the phone's database forward

A change that adds an on-device migration will migrate the tester's real database when its build is installed, and an older bundle then refuses that file (`docs/offline-sync-plan.md`, the downgrade rule): the tester's store build shows "Offline storage is paused" until the change ships. To measure such a change, leave the migration out of the probe build and create what it adds another way. #6313's index was built under a probe-only name at startup, and the reader pointed at that name. The database stayed at its version.

## Running it on an iPhone

Everything below runs from the repo root on a Mac with the phone wired and unlocked.

1. **The UI driver.** Gestures go through a WebDriverAgent runner on the phone. Stage and build your own with `scripts/mobile-profile-ios-driver.ts`, as `docs/mobile-performance-profiling.md` describes, and start it with a port of your own:

   ```sh
   xcodebuild test-without-building -xctestrun <your.xctestrun> -destination id=<udid>
   uvx pymobiledevice3 usbmux forward 8231 8231 --serial <udid>   # the driver
   uvx pymobiledevice3 usbmux forward 8232 8232 --serial <udid>   # its screen stream
   ```

   Set `USE_PORT` and `MJPEG_SERVER_PORT` in the xctestrun's `EnvironmentVariables`. The runner listens on the phone's loopback, which is why the ports are forwarded. It is ready about 30 s after launch.

2. **Build and install the probe build.**

   ```sh
   export BOARDSESH_PROBE_UDID=<udid>
   scripts/mobile-probe-kit/build_ios.sh /tmp/probe-build.log --settle-consent --keep-offline-boards \
     scripts/mobile-probe-kit/probe/apply_launch_markers.py
   ```

   It builds the commit you are on, installs over the installed app and keeps its data. The first build is about 12 minutes, a JS-only rebuild about 3. It takes the shared Xcode cache lock; if another checkout is building, it stops and says so. Wait, do not remove the lock.

3. **Run a scenario.** Each one starts the app in a fresh process, drives it, pulls the probes and prints a summary. Runs land in `.boardsesh/probe-runs/<name>/`.

   | Script | What it does | What to read |
   | --- | --- | --- |
   | `scenario_list_and_drawer.py <name> --cold` | 34 slow flicks down, three drawer opens, ten hard flicks up, ten down, one more open | Thumbnails shown before their holds; rows held back; drawer stages |
   | `scenario_search_pages.py <name> <flicks>` | Steady flicks down the list | Wait per page, and which lane answered |
   | `scenario_launch.py <name>` | Launches and waits. Needs no UI driver | Time to the first page; stalls; reads at launch |
   | `scenario_film.py <name>` | Films seven hard flicks and lays 24 frames out per sheet | The frames themselves |

4. **Compare.** `analyze.py <run>` for a list run, `launch_timeline.py --summary <run> <run> ...` for launches.

## What the numbers mean

**A thumbnail shown before its holds.** `overlay-shown` with `gated: false` and a `cacheType` other than `memory`: the board was on screen and the holds had to be decoded after it. This is the flash. Count it over all thumbnails shown, and separately over rows that were new to the session.

**A thumbnail held back.** `overlay-shown` with `gated: true`: the row waited as a grey block until its holds were ready. This is the price of removing the flash. Report it next to the flash count. A change that turns every flash into a long grey block has not helped.

**Wait for a page.** `search-page.fetchMs` is what the list waited. `offline-request.ms` on lane `local` is the on-device query alone. The difference is the gate, the queue for the database connection, and the JS thread being busy.

**Drawer open.** Milliseconds from `climb-press` to each stage, ending at the play board's `overlay-painted`. A cold open is one whose overlay had never been rendered (`indexHit: false`).

**Stalls.** `js-frame-gap` is the JS thread missing frame callbacks. It is not dropped UI frames: scrolling runs on the UI thread and can stay smooth through a JS stall, while a tap waits for it. Divide total gap time by thumbnails painted when two builds scroll different distances.

**Launch.** Time 0 is the first probe event. With the launch markers that is the first render of the root layout, about 1.2 s after the process starts. Without them the first event comes later and the early stalls are not recorded at all, so an absent stall in such a run proves nothing.

## Rules for a comparison

1. **Same script, same phone, same data path, cold cache on both sides.** A warm overlay cache hides the render queue, which is where the flash comes from.
2. **Probes on both sides.** Never compare a probe build with a build that has none.
3. **At least three launches a side, alternating A, B, A, B**, for anything about launch, and say how many. The phone's own state moves launch time more than most changes do (see the reference numbers). Keep the first launch after an install apart; its file cache is cold.
4. **Say what you did not measure.** Filter variants, other phones, the other platform, the network path.
5. **A number from the laptop is a laptop number.** Database queries are 2 to 3 times slower on the iPhone 13 Pro than on an M-series laptop. Use the laptop to explore and the phone to claim.
6. **Check the tester's data did not change underneath you.** The queue length drives launch work; a run that added twenty climbs to the queue is not comparable with the one before it.

## Reference numbers

iPhone 13 Pro, Kilter Original 12x12 at 40 degrees, downloaded for offline, cold overlay cache, `scenario_list_and_drawer.py`. Use them to tell whether a later release moved.

| Measure | `main` on 10 Oct 2026 | With #6301 |
| --- | --- | --- |
| Rows reached by the script | 108 | 528 |
| New rows shown before their holds | 108 of 108 | 0 of 528 |
| All thumbnails shown before their holds | 226 of 447 (51%) | 23 of 1,466 (1.6%) |
| Thumbnails held back as a grey block | 0 | 137 (9%), 111 of them on the hard flicks up |
| Drawer, cold open, tap to holds | 182 to 222 ms, then a 150 ms fade | 130 to 162 ms, with the board |
| JS stall time per thumbnail painted | 7.6 ms | 11 ms (5.2 ms on the slow walk, more on hard flicks) |

Same build, #6313's reader switched off and on with a marker file, 11 Oct 2026:

| Measure | Reader off | Reader on |
| --- | --- | --- |
| A page of 30 while scrolling (pages 0 to 14) | 1.4 to 2.2 s, median 1.7 s | 2 to 36 ms, median 6 ms |
| Launch, first render to first page of climbs (three launches each, alternating) | 1.75, 2.06 and 4.23 s | 0.39, 0.39 and 0.43 s |

Not changed by either PR, on `main` the same day: the app reads each queued climb two to three times at launch (104 and 147 detail reads for a queue of 52).

**Launch numbers moved by a factor of six within an hour on one build.** At 11:28 the build above took 2.4 to 2.6 s to its first page, with 2.2 s of JS stalls and 0.6 s spent opening the database. At 11:47, untouched, it took 0.34 to 0.62 s, with 0.4 s of stalls and 7 ms to open the database. `main` measured in the slow hour took 3.2 s. The cause was not found. The UI driver had been attached for 14 hours and had failed to restart minutes before the slow runs, and every run in the slow hour came soon after an install. So: alternate A and B launch by launch, in one sitting, and never set a launch number beside one taken an hour earlier.

## Traps

| Symptom | Cause | What to do |
| --- | --- | --- |
| A blank Safari tab on every cold start | A probe build before #6300 handed its own root link to the system | Use a build that includes #6300 |
| The app sits on a privacy prompt | Fresh install, consent undecided | Build with `--settle-consent`. Do not tap the prompt |
| The offline board is "downloading" again on every run | The privacy stream reset it (#6306) | Build with `--keep-offline-boards` |
| An offline download takes many minutes | The build has no `EXPO_PUBLIC_SNAPSHOT_BASE_URL`, so it crawls page by page | Use `build_ios.sh`, which sets what a store build sets |
| Launches are several times slower than an hour ago, on the same build | Not established. Seen once, with a long-attached UI driver and fresh installs | Compare A and B alternately in one sitting; rerun later before believing an absolute launch number |
| A flick does not scroll | It started on the header or the bottom bar | Start between 28% and 74% of the screen height |
| Flicks land about once a second | The runner adds about 0.75 s around each gesture | Count on it. A truly fast flick needs a finger |
| A screen's `render` marker fires once while its children render 25 times | The marker is on a thin wrapper (`ClimbList`) and the work is in the component it returns (`ClimbListInner`) | Mark the inner component. A plain call at the top of a component does run on every render, with React Compiler too |
| No probe events | The build was made without `EXPO_PUBLIC_PERF_PROBE=1`, or the app relaunched and emptied the folder | Rebuild with the script; pull before relaunching |
| The driver stops answering after a relaunch | Its session ended with the app | The kit asks for a new session; with your own client, check the remembered id first |
| `Timed out while enabling automation mode` | The runner cannot start UI automation: the phone is locked, showing a system prompt, or has a stale automation session | Unlock it and look at the screen. `scenario_launch.py` still works without the driver |
| `xctrace export` crashes on the `time-profile` table | Seen on Xcode 26.6 with a device trace | The `time-sample` table exports (per-thread CPU, no symbols). Open the trace in Instruments for stacks |
| A command hangs and then times out | `rm` and `cp` ask for confirmation in an interactive shell profile | `command rm -f`, `command cp -f` |

## Android

Not run yet. This is what carries over, what has to be built, and what Android can measure that the iPhone setup cannot.

**Carries over unchanged:** the probe module's events and the patch script (they edit shared React Native code), the scenarios' structure, the analysis scripts, the comparison rules.

**The driver** is `adb` instead of the WebDriverAgent runner, with no runner to build:

| Need | iPhone | Android |
| --- | --- | --- |
| Launch in a fresh process | `xcrun devicectl device process launch --terminate-existing` | `adb shell am force-stop <package>` then `adb shell am start -W -n <package>/.MainActivity` (`-W` also prints the launch time the system measured) |
| Tap, swipe | Runner `/wda/tap`, W3C pointer actions | `adb shell input tap x y`, `adb shell input swipe x1 y1 x2 y2 <ms>` |
| Screenshot | Runner `/screenshot` | `adb exec-out screencap -p` |
| Screen film | Runner MJPEG stream | `adb shell screenrecord`, or `scrcpy --record` |
| Which app is in front | Runner `/wda/activeAppInfo` | `adb shell dumpsys activity activities` |
| Screen size for gesture geometry | Runner `/window/size` (points) | `adb shell wm size` (pixels) |

Write `android.py` beside `ios.py` with the same functions and the scenarios need one import changed. Maestro, which the CPU profiling suite already uses on Android, is the alternative when a flow should assert on visible content.

**Three things to solve first:**

1. **Getting the events off the phone.** The probe writes to the app's private files. A Release APK is not debuggable, so `adb run-as` cannot read them, and a debuggable build is not a valid thing to time. Two candidates, neither tried: send each event through `global.nativeLoggingHook` and read `adb logcat -s ReactNativeJS`, or send them over the control WebSocket that `vp run mobile:profile` already forwards with `adb reverse`.
2. **Marker files.** The same private-storage problem in the other direction. Pass the switch in the launch intent (`am start ... --es probe <name>`) or over the same control channel.
3. **The build.** `build_ios.sh` has no Android twin. `vp run mobile:android-apk` builds the app; check which variant it produces and that the three `EXPO_PUBLIC_*` values reach the bundle.

**What Android adds.** Real frame timing, which this method does not get on an iPhone from the command line:

```sh
adb shell dumpsys gfxinfo <package> reset        # before a phase
adb shell dumpsys gfxinfo <package> framestats   # after it: per-frame timestamps, janky-frame percentage
```

Reset before each phase of a scenario and read after it. That turns "the JS thread stalled" into "this many frames missed their deadline", which is the number the climber feels while scrolling. Perfetto's FrameTimeline gives the same per frame with the thread that caused it.

Check on a mid-range phone as well as a flagship. The iPhone 13 Pro numbers above say nothing about a four-year-old Android.

## When you are done

1. Stop the runner and the port forwards you started. Leave anyone else's alone.
2. Confirm `git status` is clean: no probe file, no patched source.
3. Tell whoever owns the phone what is installed on it (a probe build, with which flags), and that the queue and the current climb were changed by the script.
4. Put the baseline and candidate numbers in the PR, with the phone, the data path and the number of runs.

## What this does not do

- It does not measure UI-thread frame drops on an iPhone. Use Instruments' Animation Hitches for that, as `docs/mobile-performance-profiling.md` describes.
- It does not attribute JS time to functions. The stall monitor says when the JS thread was busy, not with what.
- Its gestures are slower and more regular than a hand. A climber can still flick faster than the script.
- The UI driver is attached while a scenario runs, and nobody has measured what that costs the app. Compare builds under the same driver; treat absolute times from driven runs as upper bounds.
- It runs against the tester's real account and data, so two people's numbers differ. Compare builds on one phone, not phones.

The kit duplicates a small WebDriverAgent client that `scripts/lib/mobile-profile-wda.ts` also has. Folding the probes and scenarios into `vp run mobile:profile` as a suite would remove that and give them its fixture backend and identity checks.
