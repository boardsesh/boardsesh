# Native offline write recovery checks

Issue [#7985](https://github.com/boardsesh/boardsesh/issues/7985) qualifies the next
native release from main before automatic board downloads can become the default.
The first step is a failing reproduction or an evidence-backed disposition. This
harness does not change retries, SQLite patches, download defaults or rollout policy.

## What the harness establishes

The development-only `/dev/integration/offline-writes` route runs the production
local tick, favorite and follow writers against a dedicated SQLite database. It
mounts no normal application providers, signs into no account, and does not drain
its synthetic outbox to a server. Screenshot stories and recorded-backend smoke
flows are not substitutes: the check needs real Expo SQLite connections.

The host driver asks for three phases on one dedicated simulator or emulator:

1. `contention` checks writes during snapshot import and partial-import recovery,
   verifies durable local rows and outbox entries, and exercises a prolonged lock
   followed by a successful write after release.
2. `prepare-reload` commits a baseline tick/outbox pair, then opens a transaction
   containing an interrupted pair. It emits `holding` only after the write lock is
   acquired; the transaction has no timer that could release the lock for the test.
3. The driver requests a real Metro JavaScript reload. `verify-reload` must find
   the committed pair, reject the interrupted pair, and persist a new write. A
   changed JavaScript runtime identity and unchanged native process identity are
   required. A process restart cannot masquerade as runtime recovery.

The default fixture contains 369,000 synthetic Kilter climbs and 369,000 stats
rows at one angle. It uses narrow generated rows, not a downloaded production
catalogue. Fresh and partial imports each start tick, favorite and follow writes
when reconciliation acquires the writer, and again after the first committed
import batch. Reopening must retain all six exact local/outbox pairs. The partial
fixture begins with half the catalogue (184,500 climbs by default) and an obsolete
climb/stat pair to reconcile. The `rows` route parameter and host `--rows` option
accept 1,000–500,000 for shorter checks; record non-default sizes in the evidence.
This checks writer contention, not realistic download bytes, full catalogue
payload costs, cellular behavior or server delivery.

Before reloading, the host backgrounds and resumes the app with the writer held.
This checks that combined lifecycle sequence; it does not independently qualify
every foreground/background path or an app-initiated production OTA reload.

Dedicated test files remain available for inspection. Never replace the database
name with `boardsesh.db`, clear a climber's app storage, or delete queued user saves
to prepare a test. The driver installs the dev client in place; it does not
uninstall the app or clear its data.

## Run on a dedicated test device

Use a fresh worktree on the intended receiving source. Install pinned dependencies
with `vp install --frozen-lockfile`. Put substantial temporary output in a task
scratch folder and retain review evidence in `.boardsesh/offline-write-qa/`.
Use a matching dev-client native tree; an old cached SDK57 APK cannot verify SDK58.

The CI wrapper writes QA notes before starting Metro, confirms the notes marker,
and starts Metro on port 8095 with `EXPO_PUBLIC_OFFLINE_WRITE_QA=1`. That flag makes
the development root idle in isolation before the first phase deep link. It keeps
normal auth, sync and telemetry providers out of the experiment. Production builds
cannot activate the development root.

Android requires a booted, dedicated emulator and a fresh-checked dev APK:

```sh
vp run mobile:android-apk -- --require-fresh
bash scripts/ci-offline-write-qa.sh android emulator-5554 /absolute/path/boardsesh-dev-android.apk
```

On macOS, use an explicit dedicated simulator UDID and matching simulator app:

```sh
vp run mobile:build-sim-app -- --app-out packages/mobile/.app-cache
bash scripts/ci-offline-write-qa.sh ios SIMULATOR-UDID packages/mobile/.app-cache/Boardsesh.app
```

The driver acquires the repository's iOS simulator lease. It refuses ambiguous
Metro clients before broadcasting reload. Both platforms report bounded failures;
review the saved receipts and logs when the command exits nonzero. Fix the
experiment setup separately from a confirmed database failure.

For the outstanding physical iPhone gate, install the matching development
client on a dedicated test phone. Run these deep links with one unique `runId`
and omit `receiptPort`; receipts remain visible on screen and in the Xcode console.

1. Open `com.boardsesh.app://dev/integration/offline-writes?runId=iphone-7985&phase=contention` and retain its receipt.
2. Open the same URL with `phase=prepare-reload`; wait for `holding` and record the native PID.
3. Reload JavaScript through the development menu without terminating the app; retain `reloaded` and the unchanged native PID.
4. Open the same URL with `phase=verify-reload`; retain its receipt, changed runtime ID, and matching native build identity.

Use a new `runId` for every repeat. This development-menu reload is distinct from
the app-initiated OTA update path, which requires its own receiving-build evidence.

When Metro is already running in the isolated mode with QA notes, invoke the
driver directly:

```sh
vp exec tsx scripts/mobile-offline-write-qa.ts --platform android --device emulator-5554 --app-path /absolute/path/boardsesh-dev-android.apk --output-dir .boardsesh/offline-write-qa/android
```

## CI evidence and remaining gates

[Offline native write recovery](../.github/workflows/mobile-offline-write-qa.yml)
runs on relevant pull requests and manual dispatch. Android uses a KVM emulator;
iOS uses one dedicated simulator on the `xcode-27` runner. Simulator apps use the
existing native-input and Xcode cache identity checks. Android APK selection
requires a proven matching native tree or a local rebuild. The workflow has a
read-only repository token, no production credentials and no deployment step.
Receipts and Metro logs are uploaded on failure as well as success for 30 days.

Attach source SHA, native artifact identity, native version/build, runtime
fingerprint, OTA ID, embedded status, operating system, and simulator/device status
to a release disposition. Development clients can have null OTA metadata; label it
unknown and use the host's build/source evidence. A development native tree match
is not the release fingerprint or an assertion that the same OTA was tested.

The 21 November 2026 audited health window was UTC `[24 October, 21 November)`.
It recorded 72 local retry events: 59 exhausted and 13 recovered, across 34 observed
people. These count retry ladders, including a tick's outbox fallback; they do not
count unique lost ticks. Every observed tick-local failure was online. Server
acceptance and reconciliation remain separate evidence under #7986/#7988.

The initial investigation did not establish a current SDK58 cause. Historical
Android session-long locks remain owned by #6689; SDK58 Android lifecycle
verification remains shared with #6707. The old cached-list alias defect is fixed
upstream in expo-sqlite 58.0.18; do not reapply its SDK57 patch.

The [runtime attribution snapshot](evidence/offline-write-runtime-triage-2026-11-21.json)
retains exact queries, filters and aggregate results. All 59 exhausted events in
that window belong to older native runtimes. The observed SDK58 cohorts have
zero retry events but only nine download starts in the complete seven-day
window; this is limited coverage, not proof of reliability.

Keep #7985 open until matching iPhone evidence and measured receiving-release
outcomes are recorded. Simulator success, no observed analytics events, or a small
receiving cohort is insufficient to remove the automatic-download blocker in
#7989. Record unknowns explicitly. If this harness fails on SDK58, capture the
holding operation and native cleanup before choosing a focused behavioral fix.

Local Linux startup attempts with emulator 36.6.11 crashed before the development
client could run, including an API 35 ATD image after API 36 attempts. These are
host/emulator failures, not SQLite reproduction outcomes. The native CI receipts
must establish whether the tested SDK58 runtime passes or fails.
