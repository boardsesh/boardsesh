# Mobile E2E gate

`.github/workflows/mobile-e2e-gate.yml` answers one question for one commit:
is this commit's mobile JS fit to become today's stable OTA candidate?

The daily release job will call it and refuse to cut a canary unless it passes.
**Today it gates nothing.** It runs nightly on `main` (19:17 UTC) and on
dispatch, and reports. Every job is advisory until it has been green five
nights running.

## What each job proves

| Job | What it runs | What a pass proves |
| --- | --- | --- |
| `resolve` | Turns the ref into a full SHA | Every other job tests that one commit, even if the branch moves mid-run |
| `boot-real-bytes` | Nothing yet (reserved slot) | Nothing. The verdict reports it as "not run" |
| `expo-web` | The Expo-web Playwright smoke (`e2e-tests.yml`) at the SHA | The browser app boots against a real local backend and passes its smoke suite |
| `android-smoke` | The `smoke` Maestro flow on a KVM emulator: dev-client APK + Metro at the SHA, recorded backend | On Android the app boots, signs in, and puts real content on home, profile, climbs and the play drawer |
| `ios-smoke` | The same flow on one iPhone 16 Pro Max simulator | The same, on iOS |
| `verdict` | `scripts/mobile-e2e-gate-verdict.ts` | Nothing by itself: it reads the others and writes one line, one table and the `passed` output |
| `notify` | A Discord post | Nightly only, and only when something is red |

### The navigation smoke

Both platforms walk the same four screens, in this order:

1. Home, the signed-in feed.
2. Profile, the progress tab.
3. Climbs, the list for the active board.
4. The first climb's play drawer, with the board and its lit holds.

The play drawer is last because it overlays the app once it opens.

Each screen is judged twice over:

- **Android asserts testIDs** (`home-screen`, `session-feed-card`,
  `progress-tab-loaded`, `profile-board-overview`, `climbs-screen`, `climb-row`,
  `play-drawer-board-overlay`). Never text, so neither the locale nor the
  recorded data can move an assertion.
- **Both platforms read the app's own pings.** iOS Maestro on this build cannot
  match the app's elements, so in screenshot mode each smoke-visited screen
  mounts a `ScreenshotSmokeMarker` inside its content and that marker tells the
  orchestrator "this route rendered, with N rows" (N recorded ascents for profile, N lit holds for the board).
  The root crash screen sends an error ping. On iOS this is the assertion; on
  Android it is a second signal.

The orchestrator (`vp run mobile:screenshots -- --flow smoke`) fails the run
when:

- an expected route's ping has not arrived 60 s after the flow ended;
- a route's best count is 0;
- any error ping arrived;
- the app's process died natively at any point (logcat for the app's pid on
  Android, SpringBoard's exit line on iOS);
- the replay backend logged a miss, or a batched operation got no recorded
  coverage;
- the board never logged its render line, or the app ran on the wrong clock;
- the device log reader died, so later crashes cannot be ruled out.

The gate rereads device crash and render evidence after waiting for content
pings. A crash during that wait fails the same attempt.

It takes no screenshots and writes nothing under `app-stores/`.

## What it does NOT prove

The smokes run **dev-mode JS, in screenshot mode, against recorded data**. That
buys determinism and costs coverage. A green gate says nothing about:

- **Sign-in and token refresh.** Screenshot mode signs in automatically against
  the replay backend's synthetic session. No login screen ever mounts.
- **Onboarding.** Screenshot mode suppresses the tour.
- **Network errors.** The recorded backend always answers, instantly.
- **Offline sync.** Nothing goes offline, and the outbox never drains.
- **Writes.** No tick is logged, no climb is saved, nothing is queued.
- **BLE.** A simulator has no Bluetooth.
- **Pagination.** Each list loads its first page and stops.
- **Hermes bytecode and the OTA launch path.** The app is a Debug dev-client
  loading an unminified bundle from Metro. It never downloads, verifies or
  launches a published update, and it never runs the bytes the fleet will get.
  That is the job reserved for `boot-real-bytes`.
- **The queue sheet.** The only recorded flow that opens it does so inside a
  joined party session, by text-matched taps, on Android only.
- **Anything behind a tap.** Every step is a deep link.
- **Pixels on iOS.** A ping proves the screen's content tree mounted with data.
  It does not prove the rows are visible.

Because the smoke replays the pinned fixture set, it can only visit screens
that set already covers. Adding a screen to the smoke means recording it first
(`docs/mobile-screenshot-fixtures.md`).

One more limit: the jobs check out the commit under test and run its copy of the
flows, the orchestrator and the composite actions. The gate can only judge a
commit that already contains the gate.

## Reading a red run

Start at the run's summary page. The `verdict` job writes the table: one row per
job with pass, fail, cancelled or not run, how long it took, and a note.

For a red smoke, the note is the failure class:

| Class | Meaning | Where to look |
| --- | --- | --- |
| native crash at launch | The process died before the app signalled home, with no replay miss | See the section below |
| native crash | The process died later, or beside a replay miss | The backtrace in the job log; `logcat.txt` or `ios-device.log` in the debug artifact |
| JS error (crash screen) | The root error boundary's crash screen mounted | The error message is in the job summary |
| replay miss | The app asked for something the fixture set does not hold | `screenshot-backend.log`; then `docs/mobile-screenshot-fixtures.md` |
| never reached home | Auto sign-in or the bundle load never finished | The Metro log tail in the job log |
| flow assertion failed | Android only: a testID did not appear in time | Maestro's output and `maestro-tests/` in the artifact |
| screen rendered no content | A ping is missing or its count is 0 | The summary names the route |
| capture log check failed | No board render line, or the wrong clock | The job log |
| setup failed | The run never launched the app | The first `FAILED` line in the job log |

The smoke's own section of the job summary lists each attempt, its class, its
problems and the ping counts it saw. Debug artifacts: `android-smoke-debug`, and
`capture-debug-ios-smoke-en-US-iphone-16-pro-max`.

## Dispatching it at a commit

```sh
gh workflow run mobile-e2e-gate.yml --ref main -f ref=<sha, branch or tag>
```

`--ref` picks the copy of the workflow file. `-f ref=` picks the commit to
test; leave it out to test the head of `--ref`.

Calling it from another workflow:

```yaml
jobs:
  gate:
    uses: ./.github/workflows/mobile-e2e-gate.yml
    with:
      ref: ${{ needs.candidate.outputs.sha }}
  release:
    needs: gate
    if: needs.gate.outputs.passed == 'true'
```

Compare against the literal `'true'`. An empty string (the verdict job died) is
not a pass. A call with an empty `ref` fails in `resolve` instead of testing
whatever the default ref happens to be.

A second run for the same commit does not cancel the first, and runs for
different commits do not wait on each other: the workflow has no concurrency
group. It holds none of the OTA publish locks either.

## The advisory to blocking switch

One place decides which jobs can fail the gate: the `GATE_JOBS` map at the top
of the workflow.

```yaml
GATE_JOBS: >-
  {
    "boot-real-bytes": "advisory",
    "expo-web": "advisory",
    "android-smoke": "advisory",
    "ios-smoke": "advisory"
  }
```

- **advisory**: the job is reported in the table and changes nothing.
- **blocking**: a failure fails the `verdict` job, and the job failing, being
  cancelled or not running makes `passed` false.

An advisory job that fails still fails: its row is red, and GitHub shows the
whole run as failed. Only the `verdict` job and the `passed` output ignore it.
Read those two, not the run's colour.

`passed` is true only when every blocking job passed. With nothing blocking it
is vacuously true, and the verdict line says so ("nothing is blocking yet").

Flip `expo-web`, `android-smoke` and `ios-smoke` to `blocking` once each has
been green five nights running. Flip `boot-real-bytes` in the PR that
implements it. `scripts/__tests__/mobile-e2e-gate-workflow.test.ts` pins the
current map, so the flip is a two-line change: the map and that test.

## The native-crash class

The Android dev-client sometimes dies a few seconds into a cold start:

```
Fatal signal 11 (SIGSEGV) … in tid … (mqt_v_js), pid … (ardsesh.app.dev)
#00 pc …  [anon:scudo:primary]
#01 pc …  libreactnative.so (facebook::react::MountingCoordinator::pullTransaction(bool) const+713)
```

What the failing capture runs showed (37283222059, 37301021293, 37303260892;
nine crashes in 37 launches):

- It is always the JS thread, on the app surface's first Fabric commit, 1.7 to
  3.5 s after the bundle starts running and before any screen is up.
- Zero replay misses every time. Same emulator image, same options and same JS
  as passing runs. It happened on two different prerelease APKs.
- The likeliest cause is a use-after-free in `react-native-screens` on Android:
  `ScreensModule.initialize()` and `onHostResume()` race to register the same
  mounting-override delegate. Upstream fixed it in 4.28.0
  (software-mansion/react-native-screens#4413). This repo pins 4.26.2, which
  still has the unguarded code, and our patch for that version touches iOS only.
- Sentry has no issue naming `pullTransaction` or `MountingCoordinator` in the
  last 90 days. One SIGSEGV from a real device is on record and cannot be
  matched or excluded: BOARDSESH-MK (1 event, 2026-09-21, Galaxy S23, release
  2.5.0), whose stack is five unknown frames. Native stacks arrive
  unsymbolicated, so the absence is weak evidence that real devices are spared.
  The race is in the release binary too.

This is the likeliest cause, not a proven one:

- Nobody disassembled the APK, so the attribution rests on the matching
  signature and on the source, not on a `react-native-screens` symbol in the
  backtrace. Every frame is `libreactnative.so`, Hermes or ART.
- Two capture runs in the same period had no crash in 22 launches (37298803005,
  37311007551), against 9 in 37 for the failing three. A flat 24% rate makes
  that unlikely. Fault addresses repeat within one emulator boot, which hints
  that the odds move with the boot. That is a guess.
- Reanimated registers a mounting-override delegate too and has an upstream
  report with the same top frames (on a newer version than ours), so it is not
  ruled out.

If it is what it looks like, it is a product bug with a known upstream fix, not
a test flake. The fix is the `react-native-screens` bump or a backport of that
PR, which is a native change and belongs on `release/next`. Until it ships, the
gate treats the crash like this:

- A native crash before the app signals home, with zero replay misses, is the
  class **native crash at launch**.
- It is the only class that earns a retry: once, after a cold reboot of the
  emulator (or a simulator shutdown on iOS). Every other failure is final on the
  first attempt.
- It is always counted. A run the retry recovered still shows
  "native crash at launch x1, recovered by the fresh-boot retry" in the verdict
  table, and a second crash in a row fails the job.

The smoke flow never relaunches the app, so each attempt draws that risk once.
The store flow relaunches up to seven times per attempt, which is why it saw the
crash so much more often.

## Where the Discord webhook can be read

`DISCORD_DEPLOY_WEBHOOK` is an **environment** secret. It exists in the
`Production` and `Native Release` environments and is not a repository secret.
A job without `environment:` reads it as an empty string.

That is why the post lives in its own `notify` job with
`environment: Production`. Production's branch policy admits `main` and
`release/next`; the nightly always runs on `main`. No test job carries the
environment, so none of them ever holds its other secrets.

`e2e-tests.yml` posts its own red nightly the same way, from a `notify-nightly`
job. That post used to be a step of the smoke job, which has no environment, so
it read an empty webhook and never fired.

## Files

- `.github/workflows/mobile-e2e-gate.yml`: the workflow.
- `.github/actions/android-emulator-capture`: emulator, APK and Maestro setup,
  shared with `mobile-screenshots-android.yml`.
- `.github/actions/ios-screenshot-shard`: the iOS shard, shared with
  `mobile-screenshots-ios.yml`.
- `packages/mobile/.maestro/smoke-android.yaml`, `smoke.yaml`: the flows.
- `packages/mobile/src/components/ScreenshotSmokeMarker.tsx`,
  `packages/mobile/src/lib/screenshot-smoke.ts`: the app's pings.
- `scripts/lib/mobile-smoke.ts`: ping assertions, crash detection, failure
  classes.
- `scripts/mobile-e2e-gate-verdict.ts`: the verdict.
