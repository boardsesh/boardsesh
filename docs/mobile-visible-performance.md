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
6. **Watch the phone's temperature.** A phone driven for hours on a charger gets hot, and a hot iPhone is a different phone: at a battery temperature of 47.7 C the iPhone 13 Pro ran its animations at 60 Hz instead of 120, the JS thread took 290 ms over what had taken 50, and the UI thread stalled for up to 587 ms. Nothing on screen says so. `scenario_play_swipe.py` records the temperature before and after each run and warns from 40 C; `ios.conditions()` reads it for any other script. Let the phone rest on its home screen between batches of runs, and throw away a run whose frames came at 16.7 ms.

## The probe build

`scripts/mobile-probe-kit/probe/apply_probes.py` edits a checkout so that the app records timing events. It adds one module, `packages/mobile/src/lib/perf-probe.ts`, and calls into it from the places below. Nothing here ships: the build script puts the tree back afterwards, and the module does nothing unless the bundle was built with `EXPO_PUBLIC_PERF_PROBE=1`.

Every edit is an exact-text replacement that asserts its anchor occurs once. When the code under a probe moves, the script fails and names the anchor. Re-fit it; the table says what the probe is for.

| Event | Recorded when | Fields that matter |
| --- | --- | --- |
| `overlay-shown` | A hold overlay image finishes loading into a row or the play board | `cacheType` (`memory` means it was already decoded), `gated` (the row was held back as a placeholder until now), `play` |
| `overlay-painted` | Legacy name: the first matching holds image **onLoad**, not full-board display | `waitMs` from the row getting that climb, `indexHit` at render-hook mount, `surface` |
| `overlay-missed` | A row moved on to another climb before its holds ever painted | `shownMs` |
| `overlay-render` | A native overlay render finished | `queueMs` waiting for the scheduler, `nativeMs` rendering, `surface` |
| `background-load` | A board photo layer loaded | `cacheType`, `width` |
| `search-page` | A page of the climb list arrived | `page`, `fetchMs` as the list experienced it |
| `offline-request` | A local-first request was answered | `lane` (`local` or `network`), `surface`, `ms` |
| `offline-gate` | The decision whether a request may be answered locally | `gateMs`, `canServe` |
| `climb-press`, `play-route-mounted`, `play-carousel-mounted`, `play-board-measured` | Stages of opening the play drawer | time since `climb-press` |
| `js-frame-gap` | The JS thread went 34 ms or more between two frame callbacks | `gapMs` |

`probe/apply_swipe_probes.py` adds the play drawer's swipe between climbs and its pull-down close. Both run on the UI thread, where the stall monitor sees nothing, so these come from worklets:

| Event | Recorded when | Fields that matter |
| --- | --- | --- |
| `swipe-begin`, `swipe-release` | The carousel's pan activated; the finger lifted | `uiWallMs`, `commit` (`next`, `previous` or `none`), `tookOver` (the last fling was still running) |
| `swipe-settled`, `swipe-taken-over` | The outgoing board is off screen; or the next swipe ended the fling early | `uiWallMs` |
| `swipe-reset-ui` | The carousel is at rest with the new climb in the middle | `uiWallMs` |
| `swipe-blocked` | Far or fast enough to change the climb, but no page was mounted that way | `jsBehind`: the JS thread had not rendered the last step yet, rather than the queue ending there |
| `swipe-commit-js`, `swipe-reset-js` | The JS thread started changing the climb; it rendered the new one | `direction`, `queue` |
| `swipe-js-caught-up` | The UI thread heard that the JS thread has rendered every step it took | `uiWallMs` |
| `carousel-render` | The carousel rendered | Which climbs it has boards for, as ids |
| `dismiss-begin`, `dismiss-release`, `dismiss-settled` | The pull-down close | `committed`, `translateY`, `velocityY` |
| `dismiss-complete-js`, `play-route-unmounted` | The JS thread heard the close; the route is gone | |
| `ui-frames` | A gesture's shared value came to rest | `intervals` between UI-thread frame callbacks, `values` of the offset at each |

`uiWallMs` is the UI thread's clock at the moment; `wallMs` on the same event is when the JS thread got round to recording it. Use `uiWallMs` for anything about a gesture. `overlay-painted`, `overlay-missed` and `overlay-render` also carry `frames`, a short id of the climb, so a paint can be matched to the swipe that brought it in.

`ui-frames` is the sampler: from the moment a gesture activates it records the gesture's offset at every UI-thread frame callback until the offset has rested at 0 for 24 frames. An interval of two frame durations is a frame the UI thread did not get to run. It samples only while a gesture is moving, so it does not hold the display at 120 Hz between gestures.

Two flags change behaviour, on purpose and only in this build:

- `--settle-consent` skips the consent prompt and leaves consent undecided, so analytics stay off. It reuses the path screenshot mode takes.
- `--keep-offline-boards` ignores the privacy stream. The server sends one event per subscribe, which is every launch, and each one drops every offline board's checkpoints (#6306). Without the flag the board re-downloads between runs and no two runs see the same data. Remove the flag when #6306 is fixed.

Events are written to `Documents/perf-probe/` on the phone as JSON chunks and pulled after the run. A Release build drops `console.log`, so the log is not a transport. The diagnostic folder is emptied at each launch: pull before you relaunch. This removes only previous probe chunks; it does not clear the user's database or downloaded boards. Opening comparisons do not create the `perf-probe-cold` marker.

`probe/apply_launch_markers.py` adds a `render` event to the components mounted at launch, the saved queue coming back, and which climb each detail read was for. Its first marker is in the root layout, and that is what starts the stall monitor early enough to see a launch.

### Switching one thing inside one build

The cleanest comparison is the same binary with one code path off. The probe module reads marker files from `Documents/` at launch and deletes them:

| Marker | Effect for that launch |
| --- | --- |
| `perf-probe-cold` | Empties the hold-overlay cache, so every thumbnail has to be rendered again |
| `perf-probe-queue-5` | Restores the saved queue cut down to five climbs, ending at the current one, and saves that launch's queue under a key of its own. The real queue is back on the next launch (needs `apply_swipe_probes.py`) |

`perf-probe-queue-5` is also the way to run anything that changes the queue without leaving it changed.

Add a marker for the path under test: read it once at module load, export a constant, and branch on it where the new code is chosen. #6313 was measured this way (the indexed reader off and on, in one build): 1.4 to 2.2 s a page against 2 to 36 ms. The alternative is two builds, which also changes everything else that differs between them.

### Do not move the phone's database forward

A change that adds an on-device migration will migrate the tester's real database when its build is installed, and an older bundle then refuses that file (`docs/offline-sync-plan.md`, the downgrade rule): the tester's store build shows "Offline storage is paused" until the change ships. To measure such a change, leave the migration out of the probe build and create what it adds another way. #6313's index was built under a probe-only name at startup, and the reader pointed at that name. The database stayed at its version.

The same applies to `main` once it holds a migration the tester's store build does not: every probe build of `main` would migrate the phone. Check before building, every time:

```sh
python3 scripts/mobile-probe-kit/schema_check.py    # phone's version, the checkout's version, exit 1 if they differ
```

When they differ, pass a hold script to the build as an extra patch. `probe/apply_schema_hold.py` holds a build at version 12 (it leaves out migration 13 and points the climb list at the probe-only index from the #6313 measurement). It asserts its anchors, so it fails once it is out of date; replace it then.

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
   | `scenario_film_swipe.py <name> [--back]` | Films six thumb-pace swipes between climbs as one contact sheet | Whether the incoming board has its holds in each frame |
   | `scenario_play_swipe.py <name> [--cold] [--queue5]` | Opens the drawer from the queue bar, then swipes between climbs slowly, hard, at thumb pace (3.5 a second) and faster (6 a second), forward and back; then pulls the drawer down three ways. Needs a build with `apply_swipe_probes.py` | Boards on screen before their holds; swipes lost; time to rest; UI frames missed |

4. **Compare.** `analyze.py <run>` for a list run, `analyze_swipe.py <run>` for a swipe run, `launch_timeline.py --summary <run> <run> ...` for launches.

**Swipes faster than one a second.** The runner spends about a second around each call, so separate calls cannot swipe at the pace of a thumb. `ios.strokes([...], gap_ms)` sends several strokes in ONE call, and the runner plays them back at the spacing asked for: ten strokes of 80 ms with 200 ms between them land 290 ms apart, and with 60 ms and 90 ms, 158 ms apart. The probes say how far apart each one really landed; read that rather than trusting the request.

## What the numbers mean

**A thumbnail shown before its holds.** `overlay-shown` with `gated: false` and a `cacheType` other than `memory`: the board was on screen and the holds had to be decoded after it. This is the flash. Count it over all thumbnails shown, and separately over rows that were new to the session.

**A thumbnail held back.** `overlay-shown` with `gated: true`: the row waited as a grey block until its holds were ready. This is the price of removing the flash. Report it next to the flash count. A change that turns every flash into a long grey block has not helped.

**Wait for a page.** `search-page.fetchMs` is what the list waited. `offline-request.ms` on lane `local` is the on-device query alone. The difference is the gate, the queue for the database connection, and the JS thread being busy.

**Drawer open, legacy runs.** Milliseconds from `climb-press` to the play board's `overlay-painted` measure the JS delivery of holds **onLoad**. They do not prove the background layers were displayed, the board had its final geometry, or gestures were ready. `indexHit` describes the cache at render-hook mount; a render started after the tap can finish before that mount. It cannot classify cache availability at the tap.

### Opening a climb after deep scrolling

Run `python3 scripts/mobile-probe-kit/probe/apply_opening_probes.py <isolated-checkout>` after `apply_probes.py`, on **both** builds. The opening injector supports baseline `8b842c4950` and the `PlayCore` candidate, asserts every anchor, and stages all replacements before writing. Keep the source revision and probe-script hashes with the build. Apply only to isolated checkouts; restore only the paths the injector reports. The ordinary script now accepts both legacy background-load callbacks and current board-art callbacks, preserving their behavior.

| Event | Meaning |
| --- | --- |
| `climb-press` | Unique `tapId`, hashed climb/frames, and candidate snapshot quality/key/URI/generation captured before prewarming or navigation. No raw climb names, UUIDs, holds, or paths are logged. |
| `climb-open-rejected` | A placeholder-results or activation-authority guard refused the tap. Candidate authority rejections include the correlated tap and loaded count. The press is recorded before these guards, so rejected opens remain incomplete samples. |
| `overlay-index-write`, `overlay-index-drop`, `overlay-index-clear` | An ordered journal of render-cache identity changes. Reconstruct the selected full entry's presence at the tap without scanning the cache during the tap. |
| `play-opening-target` | Associates the tap with the serving route's nonce and route-owner identity during render, before child effects run. A departing route cannot claim a new target. Correlation only; it does not prove a commit. Opens without a matching climb-list tap remain outside the cohort. |
| `play-overlay-selected` | The actual full renderer key, URI, generation, and requested width. An index hit here is still a mount-time fact. |
| `play-full-art-displayed` | Matching full artwork has received all required native background and overlay `onDisplay` events. Candidate publication comes through the current board's `onReadyArtDisplayed` callback and carries the target nonce. Baseline observation adds no reveal or mounting gate. If baseline opacity concealed the artwork, publication also waits one guarded animation frame after the reveal commit, matching the candidate thumbnail bridge's visibility accounting. Already visible cached artwork needs no extra frame. |
| `play-full-art-displayed-native` | Candidate's matching full renderer key/URI/generation, including the visibility handoff when a thumbnail bridge covered the replacement. Join by `tapId`, frames, nonce, route owner, and URI. |
| `play-gesture-geometry-committed-ui` | A UI worklet ran after the positive contained geometry and enabled gesture props committed, while the route's swipe translation was zero. Uses `uiWallMs`; `recognizerConfirmed` is explicitly false. |

For the **cached-at-tap** cohort, reconstruct the journal up to each `climb-press`, then match the full display event's actual key, URI and generation against that state. A later full prewarm render, a thumbnail-only snapshot, or a full entry regenerated after the tap is not a qualifying cached entry. Keep rendered-cache hits separate from decoded-memory hits; legacy `overlay-painted.cacheType` helps describe decoding but does not prove it was decoded at the tap. Missing journal coverage, ambiguous target association, missing full-display events, or failed gestures make an opening incomplete, not a fast sample.

The target is **p95 at most 100 ms from tap to both full-size artwork and gesture readiness**. Record the later of full-art display and positive-geometry UI commit, using the tap's wall clock and `uiWallMs` for the latter. Measure immediate row feedback separately; any preparation delay before presenting the drawer still counts toward this interval. This is a readiness proxy: image `onDisplay` reaches JS after native delivery, and a UI worklet does not prove the recognizer accepts a finger. Require real swipe/pinch/dismiss checks and inspect the opening recording; neither native presentation animation completion nor a thumbnail appearance counts as the full-board endpoint. Instrumentation adds overhead and is identical on both builds; these are diagnostic timings, not native CPU/FPS evidence.

The starting marker runs in JavaScript's `onPress` handler. It excludes any delay
before that handler receives the touch, so these timings do not measure complete
finger-to-display latency. Profile rapid dismiss/reopen separately for correctness:
an unchanged image on a retained route may not emit a new native display event.
Keep that opening incomplete rather than inventing a fresh display acknowledgement.

Use at least 30 warm opens per build in alternating baseline/candidate batches, including 60 downward scrolls, repeated row opens and hard flicks back through recycled rows. Poll until an actual row is settled and visible before tapping. Keep render/decode misses separate. Record queue length, loaded result count, offline/network lane and thermal conditions before each batch. Reject a run that becomes thermally incomparable; capture native hitches separately after these timings, and do not erase account data, downloads or render caches to manufacture a cold run.

For a cannot-open reproduction, keep the production privacy stream enabled.
`--keep-offline-boards` suppresses that stream in the measurement build; a run
with that flag cannot validate opening across real withdrawal/revalidation.

Run `vp exec python3 scripts/mobile-probe-kit/analyze_opening.py <run-directory>`
to inspect the evidence. Add `--gestures-verified` only after physical
swipe/pinch/dismiss checks succeed. Capture the launch timestamp before
relaunching, then pull only that launch's probe chunks, starting at
`chunk-00000.json`, into `probe/`. The analyzer compares chunk contents and
ordering with `probe-events.json` and requires coverage through `run-end`.
Include `build-manifest.json` with commit, Release mode, device ID, probe variant,
`openingProbeVersion: 2` for current route-owner probes,
and native thermal state before/after. Completed `scroll20`, `scroll40`,
`scroll60`, and hard up/down recycled-row marks must precede their cached opens.
Pilot timings remain available when these requirements are incomplete; they
cannot pass the full gate.

**Stalls.** `js-frame-gap` is the JS thread missing frame callbacks. It is not dropped UI frames: scrolling runs on the UI thread and can stay smooth through a JS stall, while a tap waits for it. Divide total gap time by thumbnails painted when two builds scroll different distances.

**A board on screen before its holds, in a swipe.** The incoming board became visible when the swipe began. If no mounted board held that climb with its holds painted at that moment, the climber saw something else slide in first: another climb's holds, or a bare wall. `analyze_swipe.py` counts those swipes and how long each lasted, and how many were still missing their holds at finger-up and when the swipe settled. The paint is stamped when the JS thread hears of it, so the duration is an upper bound.

**A swipe that was lost.** Far or fast enough to change the climb, and nothing happened. Count them per phase; `quick` is the pace of a thumb and `burst` is past it.

**At rest.** Finger-up until the carousel has the new climb in the middle and its offset back at 0.

**UI frames missed.** From `ui-frames`: intervals between UI-thread frame callbacks longer than one and a half frame durations, counted in frames. The interval the callbacks ran at says whether the animation was at 120 Hz (8.3 ms) at all. This is the UI thread's own schedule. It does not see a frame the render server dropped after the UI thread handed it over; Instruments' Animation Hitches does.

**A stand-still in the close.** Consecutive frames after finger-up in which the surface did not move, before it had arrived. A pause between the drag and the release animation shows up as this.

**Launch.** Time 0 is the first probe event. With the launch markers that is the first render of the root layout, about 1.2 s after the process starts. Without them the first event comes later and the early stalls are not recorded at all, so an absent stall in such a run proves nothing.

## Rules for a comparison

1. **Same script, same phone, same data path and cache cohort.** Compare cached-at-tap opens separately from render/decode misses. A warm cache hides render-queue costs; a cold-cache run cannot establish the warm opening target.
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

### Swiping between climbs, and closing the drawer

iPhone 13 Pro, iOS 26.6.1, Kilter Original 12x12 at 40 degrees, downloaded for offline, queue of 52, battery at 32 to 35 C, `scenario_play_swipe.py`, 11 October 2026. `main` is seven runs over three sittings, 410 swipes that changed the climb. The three-board carousel is two runs alternated with `main` in the last sitting, 136 swipes.

| Measure | `main` | With the three-board carousel |
| --- | --- | --- |
| Swipes forward that began with no board holding the incoming climb | 202 of 207. The one spare board held the other neighbour | 0 of 68 |
| How long until the right holds were up on those | 6 to 37 ms, then a 150 ms fade when they were not decoded yet | |
| Swipes back that began the same way | 0 of 203 | 0 of 68 |
| Swipes that changed the climb at 3.5 a second | 140 of 140 | 40 of 40 |
| Swipes that changed the climb at 6 a second | 74 of 140 | 40 of 40, 36 of them taking over the fling before |
| Finger-up to the carousel at rest | 141 to 248 ms, median 177, touches ignored throughout | 99 to 171 ms, median 117, a swipe can start at any point |
| Finger-up to the JS thread having rendered the new climb | The same 141 to 248 ms | 83 to 158 ms, median 113 |
| Whole-drawer renders per swipe | 4 to 8 | 2 |
| UI frames missed while a board was moving | 0 of 18,812 | 4 of 4,993, each at the instant of finger-up in the 3.5-a-second phase. Cause not found |
| UI frames missed with the picture still | 41 of 18,812, 17 of them in one run with a 90 ms stall | 15 of 4,993 |

The carousel as it merged (#6348) was run twice more that evening at 30 to 33 C, each time alternated with the build before it. Against the build in the table, two runs each: 136 of 136 swipes changed the climb on both, 40 of 40 at 6 a second, and it missed 0 of 5,001 frames while a board was moving where the build in the table missed 2 of 5,002 (12 and 8 with the picture still). Against the follow-up in #6374, one run each before the UI driver stopped: 68 of 68 on both, no frame missed while a board was moving, 4 and 9 with the picture still. So the frames missed at finger-up come and go between sittings: 6 of 20,001 over the three.

A cold overlay cache changed none of this on either build: the drawer warms three climbs ahead and kept up at 3.5 swipes a second. Nor did a queue of 5 in place of 52.

The pull-down close did not change and did not need to. Thirty closes on each build: a slow drag to 80% open with a still release was off screen 150 ms after finger-up, a hard flick 125 ms after, and a pull let go early was back in place in 183 ms, with no stand-still and at most two UI frames missed after finger-up in any group of ten. The drawer's holds painted 65 ms after its route mounted on both (median of 21 opens).

Instruments' Animation Hitches over the same thumb-pace swipes, 22 s traces of one drawer open and ten swipes, two traces a side (`hitches.py`): `main` had no hitch in 20 swipes, the three-board carousel one in 20 (16.7 ms, as the first swipe of a run began). Away from the swipes both had two to four a trace, 29 to 67 ms in all, at rest or while the drawer opened.

A swipe onto a playlist's suggestion past the end of a one-climb queue, and fifteen swipes through a queue of 308 made from a playlist, behaved like the rest on the three-board carousel: no board before its holds, none lost. `main` was not run on that path. Opening the first climb of that 308-climb playlist took about 8 s before the drawer appeared, on either carousel's code path alike since the drawer is not mounted yet; it was seen once and not looked into.

An earlier build of the three-board carousel was run on a hot phone before the heat was noticed (battery at 47.7 C): frames every 16.7 ms, the JS thread up to 318 ms behind a swipe where it had been 38 to 66, and 4 swipes of 24 lost. A slow phone behaves like that all the time. `main` was not run hot, so this is a warning about slow phones, not a comparison.

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
| Every driver call fails with `RemoteDisconnected`, and `/status` returns nothing | The runner has hung with its process still alive. Seen twice, each after an hour or more of runs | Stop your own `xcodebuild test-without-building` and start it again. Runs after the hang are lost; the ones before it are complete. If the restart ends in the row below, it needs a person |
| `Timed out while enabling automation mode` | The runner cannot start UI automation: the phone is locked, or is asking for its passcode to allow UI automation. `devicectl` reports the phone as unlocked either way | Someone has to look at the phone and type the passcode. `scenario_launch.py` still works without the driver |
| A swipe ends 3 ms after it began, with nothing moved | Something re-inserted the view under the finger. In Fabric a `zIndex` that changes does that: it is not a paint-order tweak, the native view is removed and put back among its siblings, and iOS cancels the touch that began on it | Never animate `zIndex` on, or reorder, a view a gesture can start on. Read `swipe-begin` and `swipe-release` 3 ms apart as this |
| Frames arrive every 16.7 ms and everything takes several times longer | The phone is hot (battery at 45 C or more) and iOS has capped the display and the CPU | Stop driving it, put it on its home screen, wait for under 35 C. Check `conditions.json` in the run |
| Of ten strokes sent in one driver call, only the last does anything | The gesture reads the handler's `success` flag. Strokes sent back to back end unsuccessfully for react-native-gesture-handler, all but the last | Nothing in the app reads that flag for the carousel; do not add it without re-running the `quick` phase |
| `vp run typecheck:mobile` passes after an edit that cannot compile | The task cache replayed an earlier result | `vp exec tsc --noEmit` from `packages/mobile` |
| The tree loses an edit when a probe build finishes | `build_ios.sh` puts `packages/mobile` and `packages/shared` back with `git checkout`. An uncommitted edit to a tracked file there goes with the probes | Commit before building; do not edit those folders while a build runs |
| `xctrace export` crashes on the `time-profile` table | Seen on Xcode 26.6 with a device trace | The `time-sample` table exports (per-thread CPU, no symbols). Open the trace in Instruments for stacks |
| `xctrace export` dies with SIGSEGV on a table that exported a minute ago | It does so about every other call on Xcode 26.6, on the table of contents as well | Call it again. `hitches.py` tries eight times |
| A driver call takes four times as long as usual | Instruments is recording. One call of ten strokes took 12 s to return; the strokes landed at their usual spacing | Give the scenario more time, and keep to one phase per 22 s trace |
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

- It measures UI-thread frame callbacks only while a probed gesture is moving (the swipe between climbs, the pull-down close). It does not see a frame the render server dropped, or anything about scrolling. Instruments' Animation Hitches does; `hitches.py` places a trace's hitches against a swipe run, and `docs/mobile-performance-profiling.md` has the rest.
- It does not attribute JS time to functions. The stall monitor says when the JS thread was busy, not with what.
- Its gestures are slower and more regular than a hand. A climber can still flick faster than the script.
- The UI driver is attached while a scenario runs, and nobody has measured what that costs the app. Compare builds under the same driver; treat absolute times from driven runs as upper bounds.
- It runs against the tester's real account and data, so two people's numbers differ. Compare builds on one phone, not phones.

The kit duplicates a small WebDriverAgent client that `scripts/lib/mobile-profile-wda.ts` also has. Folding the probes and scenarios into `vp run mobile:profile` as a suite would remove that and give them its fixture backend and identity checks.
