# Mobile store release runbook

Native and JavaScript work both target `main`. A native fingerprint change rebuilds
main's open marketing version with new store build numbers and starts iOS TestFlight and
Android tester builds. The version stays open until a store accepts it; the first native
change after that opens the next unused patch. JavaScript-only changes keep the marketing
version and use the existing OTA deployment pipeline. Several native merges waiting for
the coordinator share one current snapshot.

Public store submission is manual. Merging a PR, completing a native build, creating
an automatic store draft, or merging the retired release branch never submits the live
app for review. TestFlight beta review is a separate, automatic tester-distribution step.

After a native fingerprint change, older binaries keep their last compatible OTA.
Ordinary main publishes cannot deliver new JavaScript to those older runtimes until
users install a compatible binary. Accepted release anchors and the explicit OTA
backport workflow remain available for urgent older-fleet fixes. Keep the backend
compatible with installed apps.

## One-time GitHub setup

Keep native signing, App Store Connect, Google Play, Maps, share-extension,
Sentry, and Discord credentials in the `Production` environment. Native builds,
store-draft verification, release anchoring, and production OTA workflows all
use that environment.

Keep `OTA_PUSH_APP_PRIVATE_KEY` repository-scoped because trusted OTA and
maintenance workflows also use it. The repository App identified by
`OTA_PUSH_APP_ID` needs Contents write access so workflows can create protected
build, fingerprint, and release-anchor tags. Retain the active tag ruleset for
`build-*`, `fingerprint-*`, and `release/*`; allow only that App to create,
update, or delete those tags.

## 1. Main opens native versions

**Main Native Release** (`mobile-native-release.yml`) runs after main pushes, native
workflow completions, hourly, and on demand. It compares both canonical platform
fingerprints with the latest validated native release stamp. A changed pair adopts
main's marketing version while that version is open, and rebuilds it: iOS takes the
next TestFlight build number for that version and Android the next versionCode. A
version is open when all three hold:

1. It is at or above the previous native stamp's version.
2. No `release/<platform>-v<version>-*` anchor exists for it on either platform.
3. No other build or release tag reserves a higher version. Tester builds of an
   explicitly superseded stamp do not count.

That covers a version merged deliberately above the previous one (importing native
work at 2.7.0 from a 2.6.0 baseline adopts 2.7.0) and the version the previous stamp
already opened (2.7.0 builds 9, 10 and 11 while 2.7.0 waits for submission). When the
version is not open, the coordinator opens the next unused patch. Public release
anchors and higher reserved versions still protect against reusing an unavailable
version.

The release anchor is what closes a version. **Mobile Release Anchor** cuts it when App
Store Connect or Play reports the version accepted, so submitting for review does not
close it: App Store Connect still takes new builds of a version that is waiting for or
in review, and later native merges keep producing tester builds of it. The next native
change after acceptance opens the next patch. The anchor job runs every 6 hours. If
Apple approves a version and a native merge lands before its anchor exists, the adopted
iOS upload is refused as a closed train, and the coordinator stops on that upload
instead of guessing. Dispatch Mobile Release Anchor (`mobile-auto-version-bump.yml`)
right after an approval to close that window. If it happens anyway, raise the version
on main deliberately; the next native change adopts it.

The bot records the parent source SHA, version, and both full fingerprints. A bump
stamp changes only the marketing version. An adoption stamp (`chore(mobile): adopt
native v<version>`) preserves the parent tree exactly and immediately dispatches both
exact-source tester builds, since an empty commit does not match their push path
filters. Whether the version was still open is decided when the stamp is planned;
validating an old stamp reads only git history, so a later store approval never
invalidates it. The original unversioned merge waits for this validated stamp.
Version-only changes remain outside the fingerprint.

The coordinator refetches and recomputes if main moves. Repeating a run never bumps an
unchanged native pair. It does not hold its lock while native builds run. Failed or
deferred newest builds can be recovered from the same stamp without another version.
An upload that may have reached a store but lacks its immutable tag requires readback
before a rebuild; the coordinator does not guess that it failed.

All coordinator requests queue, including manual baseline and recovery dispatches,
so automatic workflow completions cannot replace a pending operator request. Each
run reads the newest main snapshot; queued events do not open duplicate versions.

**One-time baseline.** Before importing native development, initialize the protected
annotated `release/native-baseline` tag from the exact pre-cutover main SHA. Its full
fingerprints are resolved using the same Production environment as the binaries. The
coordinator refuses to invent a baseline when no validated stamp or baseline exists.

```sh
gh workflow run mobile-native-release.yml --ref main \
  -f action=baseline -f source_sha=<pre-cutover-main-sha> -f apply=true
```

Use `action=plan` to inspect without writing. The repository App needs Contents write
and bypass permission for the protected tags and main; a GITHUB_TOKEN push would not
start the downstream native workflows. Major or minor version choices can still be
committed deliberately; the next changed native snapshot adopts that already-raised
unreleased version, and later native changes keep it until a store accepts it.

### Restore a mistaken extra version bump

`restore-version` is an explicit manual recovery for a coordinator bump that should
have kept the open version, such as the bumps made before the coordinator kept open
versions. Plan with the exact target version and mistaken stamp, inspect the returned
source/fingerprints, then repeat with `apply=true`:

```sh
gh workflow run mobile-native-release.yml --ref main \
  -f action=restore-version -f target_version=<original-version> \
  -f expected_stamp_sha=<exact-latest-bump-sha> -f apply=false
```

The target must equal the mistaken stamp's parent version and still be open by the
rule above, counting the mistaken stamp's own tester builds as retired: at or above
the previous native version, with no release anchor at or above it and no other
higher reservation. The expected stamp must still be latest, the current marketing
version must match it, and both canonical native fingerprints must be unchanged. A
newer native stamp on main (including an adoption of the bumped version) makes the
restoration refuse, so dispatch it before the next native merge. Apply makes one
normal fast-forward bot commit changing only that version line and naming the exact
superseded stamp.
A changed main during the push requires a fresh plan. Repeating a confirmed recovery
recognizes the existing restoration instead of creating another commit.

Restoration preserves baseline, tag, and upload history. Only tester build tags whose
source is the explicitly superseded stamp stop reserving future patch versions;
public release anchors and all other higher versions keep their existing protection.
Supersession carries through later stamps, and explicitly superseded sources cannot
start new native builds. Store-side expiry is a separate operator action. Public
store submission remains manual.

## 2. Automatic tester builds

- **iOS TestFlight Deploy** builds the stamped main commit and uploads its exact IPA.
- **Android Play Internal Deploy** builds that same commit, uploads the exact AAB to
  internal and open testing, and publishes its signed APK as Boardsesh Android Beta.
- Both retain platform-wide queued signing/upload locks, exact version/source/
  fingerprint tags, and force-native manual hotfix builds from main.
- A manual recovery can set `source_sha` to a validated stamp in main history with
  `force_native=false`. Workflow tooling SHA and binary source SHA are recorded
  separately. Automatic drafts and screenshots consume the exact upload receipt,
  rather than assuming the workflow head produced the binary.
- Play's review queue remains package-wide. Pending reviews defer tester uploads;
  the coordinator retries the newest stamped version. Tester availability requires
  the live backend to serve the source schema. Main OTAs still follow backend
  deployment and promotion checks.

### Automatic TestFlight access for Discord testers

After a successful iOS native build, **Distribute iOS TestFlight to Discord Users**
(`ios-testflight-distribute.yml`) submits that exact version and build to the
existing external **Discord Users** group. Group names match without regard to
capitalization; missing groups, ambiguous matches, and internal groups stop the
submission and report available group names. It waits up to 45 minutes for Apple
processing, submits beta review when needed, and enables tester notifications.
Pending beta review means submitted, not yet installable. This separate workflow
never holds the native build lock or blocks store drafts and screenshots.

The native build starts it. After the upload and its receipt succeed, the build
job dispatches the distribution with its own run ID. The distribution waits up
to 30 minutes for that run to finish, because it only trusts completed runs.
It does not listen for `workflow_run`. GitHub sends no `workflow_run` event for
a run that `GITHUB_TOKEN` started, and Main Native Release starts its recovery
builds that way. Under the old trigger, 2.7.0 builds 11 and 12 never reached
testers. A failed dispatch does not fail the build. The hourly check also
delivers the newest uploaded build when no distribution has tried it yet. It
finds the build's run by the title `ios:<source sha>`, then checks the receipt
before trusting it.

Receipt and native-test-note GitHub reads retry rate limits within one 65-minute
preparation deadline shared across the workflow. They honor GitHub's retry/reset
headers; secondary limits without a reset retry after 60, 120, then 240 seconds.
Permission errors fail immediately. The job allows 120 minutes overall, preserving
Apple's processing window after preparation.

The native build freezes its previous uploaded iOS ancestor before uploading and
saves that baseline with the exact source commit and build number. The follow-up
reads only that run's receipt, so a newer main push or retry cannot change which
changes its notes cover. Build-number resets at a marketing-version bump are
supported; an earlier build of the same commit produces no new test steps.

TestFlight's **What to Test** contains up to five native test scenarios, ordered
by PR risk. Only merged PRs entering this binary since the frozen baseline and
confirmed native on **iOS** by the OTA compatibility check are eligible. JS-only
and Android-only changes are excluded. If a `native-fingerprint` PR has no
readable iOS verdict for its final head, its plan stays in the notes and the run
logs a warning. This happens, for example, when main was merged into the branch
after the last OTA comment. Notes never block delivery. That exact case held
back 2.7.0 build 10. Plans come from **Test plan**, even when
**Release Notes** is `none`. Complete steps retain prerequisites and expected
results; CI-only steps are omitted. Full plans and the submitted notes remain in
the distribution workflow's artifacts for 90 days.

After a tooling fix, dispatch the corrected workflow from `main` with the newest
uploaded build's **source_run_id**; rerunning an old workflow uses its old tooling.
For transient failures, rerun failed jobs in the distribution workflow, or dispatch it from
`main` with the original native build's **source_run_id**. It never rebuilds or
uploads an IPA. Missing groups, unreadable history, or missing receipts fail
this follow-up with the affected reference. Correct the
reported metadata and rerun. Builds predating receipt capture cannot be selected;
a first-ever build without a predecessor needs an explicit baseline before notes
can be generated. App Store Connect must already have the beta-review details
and an API key allowed to manage external testing.

Open-beta testers can receive these native updates through Play with automatic
updates enabled. This includes native builds from `main`, so the new version
is visible to open-beta testers too. The workflow keeps its existing **Android
Play Internal Deploy (React Native)** name because other workflows consume it.
It assigns releases only to tester tracks; production drafting and submission
use separate workflows. The Play review queue is package-wide, however, so these
workflows do not provide review isolation.

The upload submits both tester tracks in one Play edit. A validation or commit
failure for open beta also blocks the internal update and candidate tags. A
successful workflow means Play accepted the edit, not that every tester can
install it yet: Google review, managed publishing, Play propagation, and device
automatic-update scheduling can delay availability. Check Play Console's
Publishing overview for review or publishing actions before diagnosing a missing
update as a failed build. `completed` describes the release rollout status; it
does not bypass review or managed publishing.

Fastlane owns tester-track assignment, release notes from
`fastlane/metadata/android/*/changelogs/default.txt`, and the review policy.
The upload commits both tracks in one edit and fails if another package-wide
review is already pending. It never cancels that review or retries the commit
with relaxed flags. Let the existing review finish, then rerun the failed job.
Production is a separate draft and release flow (§4: submitted by explicit manual dispatch, or
by hand with Android Production Release).

**Catch up open testing without rebuilding:** dispatch **Android Open Beta
Promotion** (`mobile-store-android-beta.yml`) on `main` with the exact published
internal versionCode. Its default is a GET-only plan; select `apply` to submit
that same binary to open testing at 100%. It shares the native upload lock and
refuses a missing source, downgrade, or pending package review. The equivalent
Fastlane lane is `android beta version_code:<code>` (plan), with `apply:true`
for submission. The independent lifecycle readback can still show review or
publishing delays after a successful commit.

Changing a workflow or lane does not change the native fingerprint. Such a
merge may skip the native build; use promotion to catch up an existing internal
build rather than assuming the configuration change delivered it.

Manual dispatch runs from main. Forced hotfix builds remain available; recovery
of an existing stamped version uses `source_sha` and `force_native=false`. Recognized
Apple processing/review delays receive hourly retries of the same uploaded binary.
A newest upload that no distribution has attempted is delivered by the same
hourly check. Other failures require explicit `source_run_id` recovery after
their cause is fixed.
Newer actual uploads supersede old deferred deliveries; a version bump alone does not.

## 3. Listing material

### Screenshot captions and frames

The `app-store` capture flow keeps native captures under
`app-stores/{apple,google}/raw-screenshots/` and creates upload-ready framed PNGs
under the existing `screenshots/` paths. CI retains the native captures in
separate `raw-ios-*` / `raw-android-screenshots` review artifacts for seven days.
The complete upright screen fits below
a headline and a short explanation, using the dark Velvet palette. PNG sizes
and filenames are unchanged. Onboarding and custom flows remain unframed.

**Portrait and landscape are laid out differently, and the split is derived from
the capture, not the device.** A portrait capture (iPhone, Android) keeps the copy
in a band across the top. A landscape capture (iPad, shot `LANDSCAPE_LEFT`) puts it
in a left column beside the screens, because a 4:3 canvas has no room for a copy
band above a 4:3 screen. The cost is that a single iPad screen renders at about 80%
of the width it would otherwise get; the gain is that the quarter of the canvas that
used to be empty side gutters is now doing work. Panels are never bled off the
canvas edge.

The iPad set is its own campaign rather than the phone set in landscape — six
frames leading with the wall kiosk, then the trailing wall column lifted out of
the browse screen and enlarged beside it. It runs on the six captures the sidebar
flow already takes, so it needs no board switching and no extra fixtures. The
frame table lives in `app-stores/apple/app-store-metadata.md`. The wall-column crop
is derived, not hardcoded: the shell's column is `WALL_COLUMN_WIDTH` (300pt,
`packages/mobile/src/theme/size-class.ts`) and every iPad capture is @2x, so the
crop is 600px / capture width — 21.8% on the 13" slot, 24.8% on the 11". One
expression covers both, unlike the Android rail crop, which is pinned to 1080x1920.

Edit copy in `app-stores/presentation/{en-US,es,fr,de}.json`. Apple uses the app
locale; `es-ES` and `es-MX` share Spanish captions. Google Play stays English.
The renderer uses the pinned, licensed Roboto fonts in that directory and
escapes caption markup. Text overflow fails the capture instead of clipping.
Caption, font, or renderer changes force the full iOS capture matrix.

To reframe a saved native capture without booting a simulator:

```sh
vp run screenshot:frame -- --platform android \
  --input app-stores/google/raw-screenshots \
  --output app-stores/google/screenshots
```

For one Apple shard, pass `--platform ios --device iphone-16-pro-max --locale en-US`
and distinct input/output device directories. Each output includes
`contact-sheet.jpg` for review and `presentation.json` containing hashes and raw
capture byte sizes. Store uploaders select only PNGs. Already framed inputs,
unknown filenames, incomplete sets, bad dimensions, and blank raw captures fail.

Duplicate-screen and renderer-readiness checks run before framing. Content gates
use the original PNG byte counts, verified against the framed PNG hashes, so
headlines cannot hide a blank or mid-load capture. Android commit-back includes
the sidecar. The Apple baseline manifest carries the presentation version and
raw capture metadata, and reconstructs the sidecars when fetched. Older raw-only
baselines are rejected; the next probe therefore captures the full set before
publishing a new baseline. The store-draft workflow attaches these same framed
images when it creates an editable version.

Listing text is automatic. **Mobile Store Metadata** (`mobile-store-metadata.yml`)
runs on every `main` push that touches `fastlane/metadata/**`, the Fastfile, or
the committed Play screenshots, and pushes listing text plus the Play icon and
feature graphic. The iOS half can only write onto an _editable_ App Store
version, so when the copy lands before a version exists (the normal order, §1)
that run skips iOS; `mobile-store-draft.yml` dispatches it again with
`platform: ios` right after it creates the version (§4), so the text and What's
New land without anyone running it by hand. Dispatch it manually only to re-push
unchanged copy.

An iOS listing text push keeps the version's phased release and rating reset
request as they are on App Store Connect (#7225). Every iOS push runs the same
`ios metadata` lane: Mobile Store Metadata, the listing push in Mobile Store
Draft Submission, and the combined Mobile Store Submission's "Push listing text
and What's New" step. deliver's `phased_release` and `reset_ratings` options
default to false, and false deletes a phased release or rating reset request
the version already has, so the lane reads both first and passes those answers
to deliver. If App Store Connect can't say whether one exists, the push fails
instead of guessing; rerun it. The run summary says which way it went
("Phased release: on for 2.7.0" or "Phased release: none on 2.7.0", and the
same for "Rating reset"). The lane reads them before the upload, which takes
minutes, so don't turn either on while a listing push is running, and check
phased release is still on after the last push before release. The App Store
screenshot upload and the draft lane's version-creation call
(`ios draft_submission`) skip deliver's metadata step, so they never touch
either setting.

Screenshots are automatic too. **Mobile Screenshots** (`mobile-screenshots-ios.yml`
and `mobile-screenshots-android.yml`) runs after each native deploy on
`main` **that actually shipped a binary**, one workflow per
platform. Hand-dispatched main uploads use the same receipt-based follow-ups. The pixels come from the exact commit that produced the binary. There is no cron; a manual `workflow_dispatch`, runnable from any
branch, is the only other way to start a capture.

The gate is the exact successful upload receipt and immutable build tag. A green
native workflow that skipped its build produces no upload receipt and starts no
capture. The receipt separates binary source SHA from workflow tooling SHA, so a
recovery with newer tooling captures the original source. Version-only builds and
an unchanged sibling-platform fingerprint still receive screenshots for their new
marketing version. Each capture pins that source throughout its jobs.

The upload lane needs the `Production` environment, whose deployment-branch
policy must list `main` (see Notes) — without it a main-triggered
automatic upload fails with a branch-policy rejection.

A forced rebuild of an already-shipped fingerprint keeps the existing tag (it
still points at the first commit that shipped it), so that run reads as
not-shipped. Dispatch by hand when you want those pixels.

An automatic iOS run always uses the probe gate below, and only a run that
captured the complete set uploads to App Store Connect and refreshes the
baseline. An automatic Android run captures, posts the Discord preview and
uploads the artifact; committing the set back to `main` stays opt-in on a
dispatch (`commit_to_main`) — that is deliberately still `main`, because
`mobile-store-metadata.yml` reads the committed PNGs from there.

### iPhone campaign capture

The default iOS `app-store` replay uses the nine-frame multiboard campaign.
It retains ten existing native sources and adds MoonBoard, Woods, Decoy,
Grasshopper, spray wall, crew queue, wall status, and expanded Dynamic Island.
Raw and framed outputs go under `app-stores/apple/`. iPads keep their six-source
kiosk campaign. Android and navigation smoke keep their existing fixture pin.
Explicit record/live captures retain the legacy diagnostic recipe; store upload
and baseline publication require replay.

The campaign uses `app-stores/apple/campaign-fixtures.json`, a dedicated sanitized replay fixture with a crew session
and seven selectors in this order: Kilter, Tension, MoonBoard, Woods, Decoy,
Grasshopper, spray wall. Preflight checks the types against recorded `GetMyBoards`
responses, not selector spelling or board count. The old fixture is rejected with
an actionable error because it lacks Decoy and spray-wall sources. The spray image
must be an actual permitted wall photograph included in that fixture's static files.

Use an entitled simulator client for the Dynamic Island. The flow uses the existing
screenshot BLE adapter and verifies the native Next control before capturing;
an empty island or disconnected widget fails. Inspect the sources on both phones
and all four locales before publishing an updated baseline or uploading to the
store. Missing campaign sources never select a legacy layout.

### The iPhone Duo set

App Store Connect has one iPhone Duo screenshot set (`APP_IPHONE_DUO`, up to 10
images) that takes both displays: the outer one at 1398 × 2034 and the inner one
at 2007 × 2853, either orientation. It is optional until April 2027. fastlane
deliver learned the slot in 2.241.1; older versions stop the whole upload on an
unknown size, so `fastlane/Gemfile.lock` pins 2.241.2.

The `iphone-duo` shard captures eight images in one simulator: three closed on
the outer display (`05-profile`, `06-session-detail`, `07-workout-generator`,
from `app-store-duo.yaml`), then five open on the inner display in landscape
(`00-board-view`, `01-board-view-2`, `02-climbs`, `03-home`,
`04-playlist-detail`, from `app-store-duo-inner.yaml`). The filenames put the
open layout first in the set. Every open shot has a lit climb in the board
pane: the first shot opens the first climb's player, and the split keeps it in
the left pane while the right pane moves to Home, the playlist and Climbs. Each
shot waits on an id only its own screen has (the playlist's add-to-queue row carries
`playlist-add-to-queue` for this) and on the "Open in 'Boardsesh'?" dialog being
gone. The dimension gate pins each slot to its display: `00`-`04` must be
2853 × 2007 and `05`-`07` must be 1398 × 2034 (`ACCEPTED_SIZES_BY_FILENAME`).

Two simulator facts shape it:

- Xcode 27 changes the Duo's pose only from Device Hub's buttons. A headless
  runner cannot click them, so `scripts/lib/ios-duo-hinge.ts` compiles
  `scripts/ios-duo-hinge/duo-hinge.m`, loads it into the simulator's SpringBoard
  (through the simulator's `launchctl setenv DYLD_INSERT_LIBRARIES` and a
  SpringBoard restart), and asks SpringBoard's display-swap test service for
  the same hinge sweep Device Hub drives. The service refuses outside callers
  without a private entitlement, which is why it runs inside SpringBoard. The
  helper checks the result by which display is lit, and fails the shard if the
  pose does not change.
- Maestro only sees the outer display and reports the open Duo with portrait
  geometry, so the inner flow uses deep links and id waits only, and the
  orchestrator splits it at each `takeScreenshot`, runs each piece as its own
  Maestro flow, and captures the inner display itself with
  `simctl io screenshot --display=primary-1`. A piece marked `# duo: relaunch`
  starts from a relaunched app, where the phone flow would tap a close button.

The shard needs Xcode 27 and the iOS 27.1 runtime; the shard action selects
the newest installed Xcode 27 for it. Custom product pages have no Duo set, so
the CPP matrix, `custom-product-pages.json` and CPP review counts leave it out,
while the app version's audit and review counts require it.

### The iOS probe gate

Store capture now includes both iPhone 16 Pro Max (1320 × 2868) and iPhone 16 Pro
(1206 × 2622), the existing 13-inch and 11-inch landscape iPads, and the iPhone
Duo. The medium Dynamic Island set is captured natively rather than resized from
Pro Max. The
navigation smoke still defaults to one Pro Max in English. Inventory changes
force the first complete baseline even if the Pro Max probe pixels match.

The iOS capture is a 20-shard macOS fan-out (4 app locales × 5 devices) and a
public repo gets 5 concurrent macOS runners, so the run sizes itself. With
`gate: probe` it shoots ONE shard first — en-US × iPhone 16 Pro Max — pulls the
matching shard out of the stored baseline and compares them pixel by pixel
(`vp run screenshot:compare`, `scripts/compare-screenshots.ts`). Unchanged and
the run stops there in roughly 15 minutes; changed, or no baseline yet, and it
fans out to the remaining 19 shards. Automatic runs always probe. On a dispatch
`gate: full` is the default, and a narrowed `locales` list, the `onboarding` flow
or `upload: true` force it back to `full` — none of those has a full-set baseline
to compare against.

Two thresholds decide "changed": a per-channel tolerance of 8 (simulator text
and shadow rasterization wobbles by a step or two between runs) and a max
differing-pixel ratio of 0.001 (0.001 = 0.1% of the pixels). Both can be
overridden per run through
`SCREENSHOT_CHANNEL_TOLERANCE` / `SCREENSHOT_MAX_DIFF_RATIO`; the header comment
in `scripts/compare-screenshots.ts` carries the recalibration procedure. The
probe uploads an `ios-probe-compare` artifact with the summary JSON and a
red-mask diff PNG per changed shot, so you can see what moved before trusting
the fan-out.

The single probe shard is blind to a change confined to a scope it never
shoots: a non-en-US locale string, or an iPad-only layout, would always compare
as "unchanged" and never trigger the fan-out that would have caught it.
`scripts/screenshot-probe-scope.ts` (`vp run screenshot:probe-scope`) closes
that gap with changed-file knowledge instead of pixels: the probe job diffs
`git diff --name-only <baseline_commit> <source_sha>` (fetching the baseline
commit explicitly, since it may sit outside a shallow clone's default reach)
and sets `force_full=true` when any changed path matches a documented scope —
`packages/shared/i18n/locales/**` except `en-US/**`, `packages/mobile/locales/**`,
an `ipad`/`tablet`-matching path under `packages/mobile/`, a
`duo`/`hinge`/`split-pane`-matching path under `packages/mobile/` (the iPhone
Duo's open layout),
`packages/mobile/app.config.ts`, `app-stores/apple/**`, screenshot presentation files,
the capture-device inventory or dimension gate, the iOS capture workflow/action,
or an App Store Maestro flow — or when the baseline
commit itself can't be fetched or diffed at all (no baseline yet, or one that
fell out of history). `ios-capture` and `ios-finalize` then treat `force_full`
exactly like a pixel-wise `changed`, fanning out even though the one shard the
probe actually captured matched byte for byte.

**Known remaining blind spot.** A shared component under
`packages/mobile/src/components/**` whose change only renders differently on
iPad (a `Platform.isPad` branch, a width-based layout switch) is caught by
neither the pixel probe (en-US iPhone only) nor the path rules above — its
file path says nothing about iPad. There is no changed-path signal to force a
fan-out here without also forcing a full 20-shard capture on every ordinary
component edit, which would defeat probing in the first place. Dispatch with
`gate: full` (or `upload: true`) by hand when a change is iPad-specific by
intent.

The baseline lives on a rolling GitHub prerelease tagged `screenshots-baseline`:
`pack` writes 20 `ios-<store-locale>-<device>.zip` files — 5 store locales × 4
devices, since the captured `es` app locale fans out into both `es-ES` and
`es-MX` — plus an `ios-manifest.json` recording the commit, the run id and a
sha256 per file. Captured PNGs are deliberately not committed (issue #2905),
and the prerelease keeps them out of git history while staying writable by the
plain `GITHUB_TOKEN` — the tag ruleset covers only `build-*`, `fingerprint-*`
and `release/*`. `vp run screenshot:baseline` packs, publishes and fetches it,
and refuses to publish a tree that is short a locale or a device.

A `fetch` only ever reports `found=true` when the manifest itself is present
**and** verified complete: for `--all` every shard asset the manifest lists
must actually have downloaded, and for either `--all` or a single `--asset`
every file the manifest names for that shard must be present with a matching
sha256, with no extra files beyond what the manifest lists. A missing manifest,
a missing shard zip, a hash mismatch or an untracked extra file inside a zip
all fail the same way — `found=false` with a `::warning::` naming what was
wrong — so a caller (the probe, or the store-draft attach step) that gets
`found=false` always falls back to a full capture instead of trusting or
shipping a corrupted baseline.

An automatic run refreshes the baseline itself after a green full capture. A
dispatch has to ask, with `publish_baseline: true` (`gate: full`, or
`gate: probe` when no baseline exists yet), so a run that deliberately retargets
`render_mode` or `boards` cannot silently redefine "unchanged" for everyone
else. `upload: true` is unchanged and still pushes the freshly captured set to
App Store Connect. Two publishes racing — an automatic refresh overlapping a
manual dispatch, or two dispatches at once — can interleave the release-notes
edit with the asset uploads and briefly desync which commit the notes name
from which shards actually landed (last writer wins); acceptable given how
rarely two full captures for the same platform land at the same time.

The iOS `release_notes.txt` is pushed by Mobile Store Metadata. Android release
notes ship with the AAB from each
`fastlane/metadata/android/<locale>/changelogs/default.txt`; Play caps each file
at 500 characters.

## 4. Prepare and submit exact store builds

**Mobile Store Draft Submission** follows real successful main uploads and remains
best-effort. It pins the uploaded source, verifies both platform build tags and native
fingerprints, and checks source ancestry in main. New unrelated main commits do not
invalidate that pin. Drafts prepare metadata and screenshots; they do not submit review
or start a public rollout. Another open App Store version can prevent drafting.

### Manual build-pair submission

Dispatch **Mobile Store Submission** (`mobile-store-submit.yml`) from main with all
four exact inputs: `release_sha`, `version`, `ios_build_number`, and
`android_version_code`. Its default `action=plan` reads stores and validates the pair.
There is no push trigger, schedule, merge-back discovery, or automatic public retry.

```sh
gh workflow run mobile-store-submit.yml --ref main \
  -f action=plan -f release_sha=<full-main-source-sha> -f version=<version> \
  -f ios_build_number=<build> -f android_version_code=<version-code>
```

Inspect that plan, then dispatch the same explicit inputs with `action=submit`.
`STORE_AUTO_SUBMIT=off` is a repository-scoped emergency stop: even a submit dispatch
becomes read-only while it is set. Clear it only when intentionally enabling manual
public submissions. The selected source must be in main, each immutable tester build
must be contained in that source, and both platform fingerprints must match. A newer
build is never silently substituted for a requested build.

The iOS path prepares the exact build, reads readiness, sets AFTER_APPROVAL, reads that
back, plans a review snapshot, and submits that exact snapshot. Android releases the
exact selected internal versionCode to production at 100%, preserving Play review and
managed-publishing requirements. If a newer tester upload replaced the selected
internal build, choose the current candidate or use Play Console; the workflow stops.
A busy store is reported as deferred; retry requires another explicit dispatch.

All public writes keep their existing queued store locks and identity checks. Rejected
versions, custom product pages, staged rollouts, and release-control changes remain
explicit operations. Merges never authorize them. A phased release doesn't use this
workflow: see Phased release: hold at 5% (below).

### Submitting by hand

The manual tools remain for anything the combined manual workflow does not cover:

- **App Store Connect:** confirm the attached TestFlight build, metadata and
  screenshots, then submit it for review (or use App Store Review Submission,
  below).
- **Google Play:** dispatch **Android Production Release**
  (`mobile-store-android-production.yml`) on `main` with the exact published
  internal versionCode. Its default is a GET-only plan; select `apply` to
  submit that build to production. `rollout_percent` (default `100`) sets the
  share of production users: `100` completes the release and replaces both the
  live release and the store-draft workflow's draft; anything lower writes an
  `inProgress` release beside the current completed one. Dispatch again with a
  higher percent to widen it. The workflow shares the native upload lock and
  refuses a missing source, a downgrade, an ambiguous production track, shrinking
  a completed release, or a pending package review. The equivalent Fastlane lane
  is `android production version_code:<code> rollout:<percent>` (plan), with
  `apply:true` for submission. Play review and managed publishing can still hold
  the build after a successful commit: confirm it with **Mobile Store Android
  Audit** on the `production` track.

Use the versionCode the store-draft workflow drafted: it is the current internal
build. Play keeps only the newest completed internal release, so once a newer native
build uploads, an older draft can no longer be released this way; release the newer
build instead. After a build is released, the store-draft workflow's Android job
reads the production track first (GET-only) and leaves it alone once that build is in
review, rolling out or live, or when production carries a newer build (a newer draft
included). A release-branch checkout that predates the guard skips the Play draft too:
use current main tooling with the exact selected source. That job and Android Production
Release share the `play-production-track` job lock, so the guard's read and the draft
write never interleave with a release. Before the lock, a draft run read 2.6.0 as a
draft four seconds before a release committed it, then wrote a second draft on top.

The daily stable OTA controller starts only when both candidate platform runtimes
match the newest live public store builds. An Android draft, approval awaiting
publication, or tester-track release does not qualify. Release both store builds
after QA of the main-built candidates so daily production soaks can resume.
Main's validated unreleased native line receives per-merge OTAs after backend and schema readiness,
without waiting for public store releases. This immediate route excludes public and historical
store runtimes; older installed binaries retain their last compatible update.

Before submission, dispatch **Mobile Store Audit** (`mobile-store-audit.yml`) on
`main` with the exact marketing version and iOS build number. It reads App Store
Connect independently of uploader receipts and retains the `store-audit-ios` JSON
artifact for 14 days. The report
includes the attached build, release state/type, localized listing text and exact
SHA-256 hashes, and each default/CPP screenshot's order, filename, source checksum,
processing state and image URL. Compare those source checksums with the captured
PNGs and inspect the returned images before calling the assets delivered.

The audit fails when the expected release/build does not match. Missing locales,
CPPs, device sets, checksums and unfinished screenshot processing appear as
`readinessIssues`; a successful identity check does not certify those assets.
Apple requests are GET-only. The audit changes no listings, assets, review
submissions or rollout. For Google Play, dispatch **Mobile Store Android Audit**
(`mobile-store-android-audit.yml`) with the exact versionCode. Its GET-only
release summary checks the selected `internal`, `beta` (open testing), or
`production` track without opening an edit. Its `require_published` option
defaults to true: an exact matching draft is insufficient. `PUBLISHED` also
includes partial and halted releases, so this lifecycle check does not prove a
100% rollout, track activation, or tester delivery. The apply-mode catch-up lane
checks edit status and completes partial or halted releases; its GET-only plan
cannot verify rollout completion. Turn the publication requirement off when
inspecting a pending review. The equivalent Fastlane lane is
`android audit version_code:<code> track:beta`. Google may return HTTP 204 for
an empty track or a quota error; neither verifies publication. It cannot verify localized release notes, screenshot contents, or managed
publishing. Do not create an edit merely to audit: a new edit can invalidate an
existing edit from the same service account.
Review contact details, credentials and signed upload operations are excluded
from the artifacts. A concurrent upload can change the observed assets; repeat
the audit after all upload jobs finish.

### Phased release: hold at 5%

A native release reaches climbers in phases, and it stops at 5% until connecting
to a board on it looks no worse than on the store version.

The combined Mobile Store Submission (above) can't start a phased release: it
releases Android at 100%, and Android Production Release can't shrink a completed
release afterwards. Listing text pushes keep an App Store phased release the
version already has (#7226) but never create one. So a phased release goes
through the two single-store workflows, Android first:

1. **Release Android at 5%.** Dispatch Android Production Release (above) with
   the exact versionCode, `rollout_percent=5` and `apply`, before anything else
   writes Android production. If the combined submission runs for the same build
   pair later, it reports Android `done` (production already carries the build)
   and leaves Android alone.
2. **Submit iOS with phased release on.** Turn on phased release for automatic
   updates on the version in App Store Connect, then submit with App Store Review
   Submission (below). Later listing text pushes keep it on (#7226); each run's
   step summary says "Phased release: on for <version>". Don't switch it while a
   listing push is running, because the push reads it once at the start, and
   check it is still on right before you submit. Apple's percentage covers
   automatic updates only; anyone can still update by hand.
3. **Turn the connect alerts on.** They sit on the PostHog dashboard
   [Boardsesh 2.7 connect release watch](https://us.posthog.com/project/412845/dashboard/2293063)
   and were created switched off, so nobody gets paged outside a release.
4. **Hold at 5%.** On the App Store that is day 3 of the phased release: pause
   it there. On Play, leave `rollout_percent` at 5.
5. **Go on once the connect alerts have been quiet for 48 hours.** Resume the
   App Store phased release, and dispatch Android Production Release again with
   a higher `rollout_percent`. If an alert fires, keep holding and find the
   cause on the dashboard's charts first.
6. **Turn the alerts off** once both stores reach 100%.

The four alerts read the dashboard's "Connect alerts source" table. It compares
the release (2.7.0 and up) with the store version (2.6.x) on each OS over the
trailing 7 days, native production only, internal accounts left out. iPadOS
counts as iOS, so the table has two rows: iOS and Android. Each alert checks
once a day. Because the window is the trailing 7 days, an alert that fired stays
red for up to a week after the bad events, even once a fix lands. Read the
daily charts to see whether a fix worked; the alert clears once the bad days
leave the window.

| Alert           | Fires when, on any OS                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty picker    | The release's share of picker sessions with an empty list is more than 10 points above the store version's.                                                      |
| Connect success | The release's connect success rate, cancels left out, is more than 5 points below the store version's.                                                           |
| First light     | The release's share of connecting sessions that light a climb is more than 3 points below the store version's.                                                   |
| Dropped link    | More than 30% of the release's drives end with `link_dropped`. The store version sends no `Drive Mode Ended`, so this one has no baseline: 30% is a first guess. |

For scale, 2.6.0 from 19 October to 2 November 2026 read, in 48-hour windows: an
empty list in 7–15% of picker sessions on iOS and 6–20% on Android, and connect
success of 97–99% on iOS and 85–95% on Android. Over the whole two weeks, 99.8%
of iOS and 98.2% of Android connecting sessions lit a climb.

Quiet needs volume. Each column reads 0 until the release has 20 events (picker
sessions, connect attempts, connecting sessions or drives) from 10 climbers on
that OS, so one climber retrying can't fire an alert and a thin day can't clear
one. Before calling the alerts quiet, check that the `release_*_climbers`
columns read 10 or more for iOS and Android. If they don't after 48 hours, keep
holding; Apple lets a phased release pause for up to 30 days in total.

The three comparisons also read 0 while the store version has fewer than 20
events of its own on that OS (the `store_*` columns). Once nearly everyone has
updated past the store version, those alerts can't fire and their quiet means
nothing; by then the release should be at 100% and the alerts off.

Before the next phased release, move the version floors: `2.7.0` and `2.6.0` in
the alert source's SQL, and the `2.6.0` floor on the dashboard's charts. What
each chart and prop means: `docs/growth-metrics.md`, "Connect release watch
(2.7)".

### Submit reviewed Apple content

The combined manual submission (above) runs these same helpers: the release control
helper in its after-approval mode (`STORE_RELEASE_TYPE=AFTER_APPROVAL`), then the
review helper with `release_type:AFTER_APPROVAL`. Everything below describes the
hand-run flow, which still holds the release for a manual release (`MANUAL`).

If the independent audit reports `AFTER_APPROVAL`, dispatch **Apple Manual Release
Control** (`mobile-store-release-control.yml`) on `main` with the exact version and
attached build before submission. It changes only `releaseType` to `MANUAL`, after
fresh app/version/build and editable-state checks, and retains a verified readback
in the `store-release-control` artifact. An existing `MANUAL` setting is a checked
no-op. Scheduled releases and noneditable versions stop for inspection. Ambiguous
writes are not retried; run the GET-only audit before deciding whether to rerun.
This workflow never submits or publishes the app. Its automatic push job runs
credential-free tests only.

After screenshot upload, independent image review and metadata readback, dispatch
**App Store Review Submission** (`mobile-store-review-submission.yml`) on `main`
with `action=plan`, the exact version/build, and the selected comma-separated
surfaces (`default,kilter,tension,moonboard,spray`). Download the `store-review`
artifact and check its snapshot against the reviewed source images and copy.
The default page requires 150 images; each CPP requires 180, across five locales
and four device slots. Every image must have a source checksum and be fully
processed. A valid snapshot does not substitute for visual review or comparison
with the expected source checksums.

Submit with the same selection and the artifact's `snapshotSha256`. The helper
rechecks exact metadata, image order/checksums, attached build, current CPP versions,
keyword membership and review membership before submitting. Submissions containing
the app version require that exact version as their review context. Standalone CPP
submissions use the latest approved app version's review information, as described
in [Apple's review information rules](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/).
Every CPP-only plan and submission requires `cpp_review_context_version_id`, the exact approved
app-version ID observed in Apple's review context. Inspect the resolved context
identity in the plan artifact, then use the same input and snapshot hash to submit.
The helper still binds the intended release version/build and all selected CPP
content; the approved review context is separately verified and included in the
snapshot. A changed, missing, or unapproved context stops submission. Omit this
input when the selected surfaces include `default`.
An approved context's build may have expired for TestFlight testing; its identity
and version must still match. The intended release build must remain valid and
unexpired.
The helper requires manual app release (MANUAL) unless it is given
`release_type:AFTER_APPROVAL`, which only the combined manual submission passes, and
changes no CPP visibility or keywords. Stage CPP assets
without assigning search terms that Apple has not approved.

Afterward, read the receipt and repeat the independent audit to confirm actual
review states and exact build identity. An ambiguous write is never blindly
retried: plan again and inspect the existing submission. An exact submitted group
returns a checked no-op; an existing nonempty compatible review draft can resume.
Mixed groups, empty unowned drafts, and historical removed membership of a selected
version stop for inspection. Rejection recovery is intentionally unsupported:
resolve rejected items through their existing submission in App Store Connect.
The helper submits only initial `PREPARE_FOR_SUBMISSION` or resumable
`READY_FOR_REVIEW` drafts and never cancels another review.

The GET-only audit also retains every iOS review submission and its item states
and resource identities, including completed and removed history. It omits actor
identities and review contact information. Immediately before a separate CPP
submission, inspect this inventory: Apple permits one app-version review and one
items-only review at a time. Classify reviews by their actual items;
`appStoreVersionForReview` is context and also exists on CPP-only reviews. Wait
while another items-only review is active. Empty, mixed, unknown, or unresolved
membership needs inspection, not an assumption that a review slot is free. The
audit marks ambiguous bindings and fails on malformed or duplicate identities;
it does not cancel reviews or reserve a slot against simultaneous Console edits.
Apple requires explicit expansion to return review-item linkage. The audit uses
the app-version and CPP expansion already used by submission tooling; expanding
every documented resource type is rejected by the live API. Other item kinds may
remain unresolved: their IDs and states are retained with ambiguous membership,
including historical items. Inspect unresolved active reviews in App Store
Connect before concluding that an items-only review slot is available.

Android review. The combined manual submission sends the production release for review
itself; keep managed publishing off in Play Console, or the approved release waits
there. The metadata and draft lanes do not upload Android changelogs. **Android
Production Release** (and the combined manual submission, which runs its code) takes
the release name and notes from the build's production draft when it has them (so
notes edited by hand in Play Console survive), otherwise from its internal release,
and lists the note languages in its receipt.

Every Play writer commits with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, so
none can cancel a review in progress: the API default cancels it and resubmits.
That covers the tester upload, beta and production promotion, the production draft
(`scripts/mobile-store-android-draft.ts`), and the listing text, images and
screenshots (`fastlane/lib/play_listing.rb`; these used fastlane supply, whose
commit used the default). While a review is pending, a listing push therefore
fails instead; rerun Mobile Store Metadata after the review ends. The production
writers (Android Production Release, the combined manual submission, the store draft's
Android job and the Play listing push) also share the queued `play-production-track`
job lock, so they never interleave.

The scheduled **Mobile Release Anchor** workflow queries each store for the exact
accepted build and creates
`release/<platform>-v<version>-<shortfp>` at its immutable build commit. The
anchor is commit-addressed through the `build-*` tags, so it is correct wherever
the build ran. These anchors preserve the existing JS-only OTA backport path
after the shipped fingerprint moves on.

## End-to-end checklist

1. Merge native work into main and wait for its stamp and tester builds of the open version.
2. Check Discord Users assignment, beta-review state, and Android tester availability.
3. QA the exact uploaded candidates and inspect their drafts, listing, and screenshots.
4. Plan the explicit build pair, then submit it in phases: Android at 5% through
   Android Production Release first, then iOS with phased release on through App
   Store Review Submission (Phased release: hold at 5%, above). The combined manual
   workflow releases Android at 100%.
5. Confirm public availability and immutable accepted-build anchors after store approval.
   The anchor closes the version; the next native merge opens the next patch.
6. Hold the phased release at 5% until the connect alerts stay quiet for 48 hours
   (Phased release: hold at 5%, above).

## Notes

Production signing and store credentials remain in the `Production` environment.
Only main requires release workflow access; there is no separate native-release branch
or environment. Keep `build-*`, `fingerprint-*`, and `release/*` tags protected.
Historical release-branch PRs remain part of changelog discovery because their base
branch does not change when their commits enter main. Do not squash away that ancestry.

### Stage the exact reviewed CPP replay

`mobile-cpp-retained-replay.yml` reuses the original native replay artifacts. It
never builds, captures, frames, publishes fixtures, edits keywords, or submits
review. Use one target per run. The producer must be a successful manual,
capture-only run of `mobile-screenshots-ios.yml` in this repository, with
all 16 locale/device replay jobs successful. By default, its source must be an ancestor of
main with the same capture contract, including capture libraries, Maestro flows,
presentation/caption/font assets, mobile app/runtime source, and shared renderer
dependencies. Native build scripts/configuration, task commands and dependency
lockfiles and the CPP manifest are bound too. Capture/build configuration changes
require fresh replay; adding importer tooling alone does not invalidate prior
captures. UI changes also require fresh replay unless the exact limited runtime
delta is approved as described below. Current fixture
scene readiness, grade-count proofs, and every required detail response are also
checked again. Recording runs, partial matrices, unverified retry histories,
expired or ambiguous artifacts, and changed capture code fail closed.

A failed-job retry must still end with all 16 native replay jobs successful.
GitHub assigns new job IDs to carried-forward successes without rerunning them.
The verifier reconciles up to ten attempts to the original successful
execution using its exact job and step timestamps and results. Each image artifact
must belong to that execution. A failed attempt's partial artifact is excluded
only when its origin is unambiguous; unknown, duplicate successful, or overlapping
artifact bindings stop verification. Retry receipts retain the original execution
attempts and IDs, latest job identities, and excluded failed artifacts. A changed
history invalidates the receipt. Existing first-attempt receipts keep their format.

1. Publish the sanitized immutable fixture and complete the normal full replay.
   Dispatch **Stage Reviewed CPP Replay** from `main` with `mode: verify`, its
   `replay_run_id`, target, and the same `fixture_snapshot` reference URL (or the
   matching committed pin). This read-only mode has a separate concurrency group.
2. Download `cpp-retained-replay-<target>` and inspect all five locales/four devices.
   Retain `cpp-retained-replay-receipt`, including its SHA256 file. The receipt
   binds the original run, commit, jobs, artifact IDs/digests, fixture, CPP manifest,
   native sources, and all 180 ordered recipe images. Failed verification preserves
   the prior fixture pin. Structural validity alone
   is not proof of a successful native replay or visual approval.
3. Refresh the existing screenshot writer queue. **Do not dispatch staging while
   another writer is pending:** GitHub keeps only one pending run in
   `mobile-screenshots-ios`, even with cancellation disabled. When the pending
   slot is empty, dispatch `mode: stage-assets` with the same inputs and the
   visually reviewed `expected_receipt_sha256`. It redownloads the original
   artifacts, rechecks every binding and byte, then calls the existing Fastlane
   `stage-assets` action with unchanged keyword safeguards.
4. Run the independent Apple audit and compare ordered source MD5, file sizes,
   dimensions and COMPLETE states with the retained images. A staging receipt
   proves its input bytes; it does not replace store readback or review-state proof.

For retry, preserve the same producer, fixture and reviewed receipt. After a
failed staging attempt, audit Apple first. The existing lane can resume compatible
partial assets or return unchanged for identical complete assets; conflicting
assets fail without deletion. Do not rerun native captures to repair an upload.
Retry only failed native jobs, after inspecting their diagnostics and allowing
the current attempt to finish. Successful cells remain tied to their original
executions. A different capture or changed fixture,
CPP manifest, or capture contract needs a new verification and visual review.
Expired producer artifacts also require a fresh complete capture. This path stages
screenshots and promotional text only; approved keyword assignment and review
submission remain separate operations.

#### Verify an explicitly accepted older capture contract

When the release owner accepts genuine older captures, set `capture_contract_ref`
to the full lowercase 40-character commit SHA of their verified source contract.
The workflow still runs from `main` with the current helper and current Apple
action. The pin must be a commit ancestor of that workflow's main commit, and the
producer must be its ancestor. The existing complete capture path, workflow and
byte comparison runs from producer to pin; the pin does not waive that check.
If `approved_runtime_drift_sha256` is also supplied, its existing limited delta
is evaluated from producer to this pin, with every other capture byte unchanged.

The current verifier additionally requires the entire selected target object,
every manifest global field, and every used caption object in all four catalogs
to match the verified source. This includes promotional text, fixture reference,
ordered recipes, slots, layouts, source images and board labels. Other targets
and unused captions may evolve. A changed required Live Activity recipe is a
target change and fails. Every current fixture, native-image and framed-image
guard still runs before local installation or upload. Original sidecars and
pixels remain unchanged and retain the original manifest hash.

Explicit pins produce a v2 receipt containing the original manifest and caption
bytes, pin, current verifier commit, semantic compatibility hashes and the usual
complete artifact and image inventory. Fastlane independently reads the Git
source, ancestry, current target/captions and every inventoried byte against the
reviewed receipt before staging. No caller-supplied manifest hash can authorize
older assets. Pass the same pin to verification and staging. If main advances
between them, run read-only verification again and review its new receipt; the
current verifier commit is part of the expected digest. This accepts the older
capture's source explicitly and does not claim its runtime matches current main.

Leaving the input empty preserves the existing v1 receipt and strict comparison
against current main. Neither path builds or recaptures successful native jobs.

#### Retain captures after an explicitly accepted minor runtime change

The default still requires identical capture source. If the release owner accepts
the older screenshots, `approved_runtime_drift_sha256` can bind an independently
reviewed exception for the queue-attribution and changelog files, plus the
Following-query change from #6450. The exact modified paths are listed in
`REVIEWABLE_RUNTIME_PATHS` and `FOLLOWING_RUNTIME_PATHS` in
`scripts/prepare-retained-cpp-replay.ts`. The only
permitted addition is `packages/mobile/src/lib/graphql/author-query-invalidation.ts`;
its absence in the producer must be recorded explicitly. Every other addition,
deletion or unknown changed path fails. Screenshot readiness helpers, native
configuration, shared renderers, workflow jobs, presentation assets and the CPP
manifest remain identical.

The six showcase-video changes from #6461 are outside the CPP execution path.
The verifier accepts only their independently reviewed path and original/current
SHA256 pairs in `REVIEWED_SHOWCASE_PAIRS`, still included in the explicit approval
token. This is not a general
exception for video or Maestro files: any further byte change fails, even with a
new token. The original producer's complete capture contract remains retained.

The two offline-drainer changes from #6452 are separately frozen in
`REVIEWED_OFFLINE_DRAIN_PAIRS`. This code is reachable during screenshots and
changes query-refresh timing when queued writes drain. Explicitly accepting the
older capture does not claim identical current pixels: its original source and
image bytes stay bound. Only the exact reviewed path/old/new hashes qualify;
future changes, additions or deletions of shared code still fail.

The seven publication changes from #6355 have a separate exact-byte exception
for Kilter, Tension and MoonBoard only in
`REVIEWED_MANUFACTURER_PUBLICATION_PAIRS`. Their capture flows do not open the
changed climb editor or notification list. Spray does open the editor, so this
exception rejects Spray even with a matching approval token. It preserves older
manufacturer images explicitly accepted for the submitted build; it does not
claim that the changed live backend returns identical searches or grades.
Current recordings still require genuine successful responses and native gates.

Review the actual producer-to-current diff and confirm that the retained images
still describe the submitted app. Build a record with `version: 1`, the full
`producerSha`, and `files` sorted by repository path. Each changed file contains
`path`, `producerSha256` and `currentSha256`, hashing its original and current
bytes. The #6450, #6461, #6452 or #6355 exceptions use `version: 2`; every file also records
`producerPresent` and `currentPresent`. The allowed addition has
`producerPresent: false`, `producerSha256: null`, `currentPresent: true` and its
actual `currentSha256`. Modified files have both presence fields set to `true`
and both byte hashes. Hash `canonicalJson(record) + '\n'` with SHA256 (the helper is in
`scripts/lib/screenshot-fixtures.ts`). The digest approves those exact changes;
a producer SHA alone cannot approve subsequent edits.

Pass that same digest to both verification and staging. The verified receipt
retains the complete delta and approval digest alongside the original producer's
capture-contract hash. A new edit changes the digest and receipt, stopping
staging before Apple credentials. A token with no actual runtime delta also
fails. Ancestry, all 16 successful native executions with verified attempt history, immutable fixture and
artifact checks, all 180 image bytes, independent visual review, and Apple
readback remain required. No image is recaptured, reframed or rewritten here.

### Android open-testing delivery incident, 16 October 2026

The live release audit found internal 2.6.0 (2001310) published, open testing
2.6.0 (2001247) still a draft, and production 2.5.0 (2001108) published.
The newer production 2.6.0 was also a draft. The configuration change to upload
to both tester tracks had passed its native-fingerprint gate without building;
it did not promote the already uploaded internal binary.

The 2001108 binary uses runtime `154bc941c504727afc914057aed2edff2c096576`.
Its last staging update was 7 October. The current Android runtime
`8733a10cad03453551ff474a116ef4858611f75b` had early/staging publications on
15 October; stable was ramping at 50%. OTA activity on the new runtime cannot
update the old binary. Play tester enrollment and the in-app OTA branch are
separate choices; switching OTA branches does not install a new native runtime.

The exact published internal build 2001310 was subsequently submitted to open
testing with `completed` (100%) and the strict review guard. Google accepted
the commit. Its independent summary returned HTTP 204 and then quota exceeded,
so publication and delivery to individual testers were not verified. Check
Publishing overview and the open-testing track before promising availability.
