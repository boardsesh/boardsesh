# Mobile store release runbook

Both `main` and `release/next` automatically build TestFlight and Play tester-track
candidates when the native fingerprint changes. Use either branch for a release;
the screenshot and store-draft follow-ups use the branch that produced the binary.
JS-only pushes skip native builds. Manual dispatch can force a rebuild on either
branch. The marketing version and build numbers do not affect the fingerprint,
so a version-only release needs a manual build.

Native changes temporarily stop older binaries receiving new compatible OTAs.
Prepare the release identity before the final native change, keep the backend
compatible with installed builds, and move the replacement binaries through QA
and review promptly. `main` still owns the store fleet's OTA delivery; the train's
OTA guard prevents a train bundle taking over a runtime that main also uses.

Source of truth for uploaded material:

- Listing text: `fastlane/metadata/en-US/` (iOS), `fastlane/metadata/android/en-US/` (Android)
- Play images: `fastlane/metadata/android/en-US/images/`
- Screenshots: captured fresh, not committed (see `packages/mobile/.maestro/`)
- Lane details: `fastlane/README.md`

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

## 1. Prepare the release on either branch

Land the release on `main` directly, or use the optional `release/next` train
below. Native PRs into either branch are accepted without `allow-native-on-main`.
When using a train, cut it from `main` and merge it back after store acceptance.

1. **Cut it** (start of a release, or to reset it after a merge-back):

   ```sh
   git push --force-with-lease origin main:release/next
   ```

2. **Land the release identity on the train, before the final native change.**
   Bump `version` in `packages/mobile/app.config.ts` and update the localized iOS
   and Android release notes for `en-US`, `es-ES`, `es-MX`, `fr-FR`, and `de-DE`.
   Those PRs target `release/next`. Keep this order so the automatic builds carry
   the intended version and copy. The version no longer moves the fingerprint, so
   landing it first does not cost the store fleet its OTAs; it just means the
   version rides on the native change that does start the build.
3. **Land the native changes on the chosen branch.** Both `main` and
   `release/next` start fingerprint-gated store builds. The OTA compatibility
   check reports the native change without blocking or requiring a waiver.
4. **Sync `main` into the train whenever the release needs main's JS.** A merge
   commit, never a squash — a squash would rewrite the shared history and make
   the merge-back conflict with itself:

   ```sh
   git switch release/next && git pull
   git merge origin/main          # merge commit
   git push origin release/next
   ```

5. Keep mixed backend/native changes backward-compatible with the currently
   shipped app until the replacement store release has been adopted.

A fingerprint change on the train makes older binaries OTA-ineligible for the
train's bundles. This is expected. Keep the native change set focused and start
store QA and review as soon as the automatic builds finish. An urgent JS-only fix
for an older accepted binary can still use the OTA backport workflow and its
immutable release anchor.

**Closing the train.** Once both stores have accepted the release and the release
anchors exist (§4), open a merge-back PR from `release/next` into `main` and
merge it **as a merge commit, never a squash**. After it lands, `main`'s
fingerprint equals the train's, so `main`'s OTA publisher serves the new fleet
again. Then reset the train with the force-push in step 1.

There is no branch protection on `release/next` and no automated sync: syncs and
merge-backs are ordinary merge commits that maintainers push.

## 2. Automatic native builds from `main` and `release/next`

A push to either release branch that resolves to a new native fingerprint triggers:

- **iOS TestFlight Deploy** (`ios-testflight-rn.yml`) — resolves the next build
  number from App Store Connect, builds, validates the archive, and uploads the
  exact binary to TestFlight through `fastlane ios testflight`.
- **Android Play Internal Deploy** (`android-apk-rn.yml`) — resolves the next
  versionCode from Google Play, builds and validates the APK/AAB, and uploads the
  same AAB through `fastlane android upload_beta` to Play internal and open
  testing (`beta`) at 100% (`status: completed`), with
  `changesNotSentForReview: false` and `changesInReviewBehavior: ERROR_IF_IN_REVIEW`. After Play accepts the edit, the exact signed arm64 APK is
  published as the newest **Boardsesh Android Beta** prerelease.

Open-beta testers can receive these native updates through Play with automatic
updates enabled. This includes native builds from `release/next`, so the train
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
Production is a separate draft and release flow (see "Review submission and rollout are started by hand" below).

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

`workflow_dispatch` works from either branch and forces a build (Android has
`force_native`, enabled by default). Automatic screenshot and store-draft runs
follow successful builds from both branches. Store drafting resolves and rechecks
the triggering build's source branch; manual drafting uses its selected ref and
refuses branches other than `main` and `release/next` before checking out code.

Build numbers and upload concurrency are global per platform, so builds from the
two branches cannot race store numbering. Existing fingerprint tags deduplicate
identical native states across branches. Draft selection remains conservative:
it selects the highest uploaded tags for the marketing version and verifies them
against the chosen branch. If the branches carry different native states under
the same marketing version, drafting can wait for matching candidates rather
than attach an incompatible binary.

Both workflows use the `Production` environment and serialize non-cancelling
builds. A successful upload records the exact commit, store build number, and
fingerprint in an immutable
`build-<platform>-v<version>-<number>-<shortfp>` tag. The matching
`fingerprint-<platform>-<hash>` tag prevents duplicate native builds when a later
push to the train is JS-only.

**OTAs during the train.** `release/next` publishes production OTAs too, so the
testers on the train's binary get JS as fast as main's fleet does — including
after a `main` → `release/next` sync. The guard is fingerprint identity: while the
train's fingerprint still equals main's, the train's publish is skipped for that
platform, because xprem serves the newest update per runtimeVersion and the train's
JS would otherwise be handed to the whole store fleet. The train starts publishing
once a native change has moved its fingerprint off main's.

### Version-only releases

When the release is a new version number with no native change, the fingerprint
does not move, the `fingerprint-<platform>-<hash>` tag already exists, and both
native workflows skip the build on push. Ship the binary by hand:

1. On `release/next`, bump `version` in `packages/mobile/app.config.ts` and land
   the localized release notes.
2. Dispatch `ios-testflight-rn.yml` on `release/next`.
3. Dispatch `android-apk-rn.yml` on `release/next` with `force_native` on.

`mobile-store-draft.yml` then runs from the two completions. Two caveats:

- The train does not republish an OTA after the build. Its guard skips the publish
  while the train's fingerprint equals main's, so the new binary runs its embedded
  bundle until main's next production publish.
- Screenshots do not run on their own, because that needs a fingerprint tag at the
  triggering commit. Dispatch the screenshot workflows by hand. The in-app
  changelog also gets no "App update" marker for the release.

Details and the other consequences (backports reach every version sharing the
fingerprint): `docs/mobile-ota-updates.md`, "Version-only releases".

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

Screenshots are automatic too. **Mobile Screenshots** (`mobile-screenshots-ios.yml`
and `mobile-screenshots-android.yml`) runs after each native deploy on
`main` or `release/next` **that actually shipped a binary**, one workflow per
platform. The pixels come from the exact commit that produced the binary. There is no cron; a manual `workflow_dispatch`, runnable from any
branch, is the only other way to start a capture.

"Shipped" is not the same as "the deploy run went green". A JS-only push finishes
the deploy workflow with its build job skipped, and that run still concludes
`success`. What proves a binary shipped is the `fingerprint-<platform>-<hash>`
tag the deploy forces onto its own commit right after a successful store upload
(§2), so each screenshot run looks for that tag on the triggering commit before
spending a runner, and writes "no binary shipped … nothing to capture" to its
step summary when it finds none. Every checkout in both workflows pins that same
commit (`workflow_run.head_sha`), so the pixels belong to the binary rather than
to whatever the train moved on to meanwhile. Both workflows name the train once
as a `RELEASE_BRANCH` env, the way `mobile-store-draft.yml` does; the contract
test reads the deploy workflows' own `push.branches` and fails if either
workflow's `workflow_run` filter or `RELEASE_BRANCH` drifts off it. Automatic
runs share one concurrency group per platform and never cancel each other; each
dispatch gets its own, so a hand-run capture is never cancelled by a deploy
landing mid-run.

The upload lane needs the `Production` environment, whose deployment-branch
policy must list `release/next` (see Notes) — without it a train-triggered
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

### The iOS probe gate

Store capture now includes both iPhone 16 Pro Max (1320 × 2868) and iPhone 16 Pro
(1206 × 2622), plus the existing 13-inch and 11-inch landscape iPads. The medium
Dynamic Island set is captured natively rather than resized from Pro Max. The
navigation smoke still defaults to one Pro Max in English. Inventory changes
force the first complete baseline even if the Pro Max probe pixels match.

The iOS capture is a 16-shard macOS fan-out (4 app locales × 4 devices) and a
public repo gets 5 concurrent macOS runners, so the run sizes itself. With
`gate: probe` it shoots ONE shard first — en-US × iPhone 16 Pro Max — pulls the
matching shard out of the stored baseline and compares them pixel by pixel
(`vp run screenshot:compare`, `scripts/compare-screenshots.ts`). Unchanged and
the run stops there in roughly 15 minutes; changed, or no baseline yet, and it
fans out to the remaining 15 shards. Automatic runs always probe. On a dispatch
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
an `ipad`/`tablet`-matching path under `packages/mobile/`,
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
fan-out here without also forcing a full 16-shard capture on every ordinary
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

## 4. Prepare and submit the exact store builds

`mobile-store-draft.yml` is best-effort and always on; there is no enable flag.
It runs whenever **iOS TestFlight Deploy** or **Android Play Internal Deploy**
completes on `main` or `release/next`, and on demand; there is no schedule. It pins
the current source branch SHA, selects the exact highest iOS and Android build tags
for that version, and checks that both tagged binaries match the source branch's
platform fingerprints. Immediately before changing either store draft it rechecks that
the source branch and both selected tags have not moved. A mismatch, or only one platform's build existing yet, waits for a later
run (the other platform's completion re-triggers it) instead of drafting the
wrong build.

The iOS lane waits up to 45 minutes for App Store Connect to finish processing
the tagged build, then attaches it to the editable version (creating the version
first if needed) and dispatches Mobile Store Metadata for iOS so the listing
text and What's New land on that version (§3). Screenshots have the same
ordering problem one step further out — the capture workflow starts as soon as
the deploy finishes and gets there long before ASC has processed the build, so
its own upload finds no editable version and skips — so the lane then pulls the
published `screenshots-baseline` set
(§3) and attaches it to the version it just created. That step is best-effort:
a failure warns rather than reds the job, and deliver's `sync_screenshots`
makes a repeat run replace rather than append. The Android lane promotes the
internal-track release carrying the tagged versionCode to a production release
in draft status.

Review submission and rollout are started by hand:

- **App Store Connect:** confirm the attached TestFlight build, metadata and
  screenshots, then submit it for review.
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
merge `main` into the train, or draft from `main`.

Until Android reaches production, the daily stable OTA controller has no Android
devices to judge on that native runtime. Release Android promptly after its store
draft appears (see `docs/mobile-ota-updates.md`, "Daily stable runbook").

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

### Submit reviewed Apple content

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
The helper preserves manual app release and changes no CPP visibility or keywords. Stage CPP assets
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

Android review remains a separate operation. Before sending a production release
for review, verify managed publishing in Play Console and establish whether approval
should publish immediately or wait. The metadata and draft lanes do not upload
Android changelogs. **Android Production Release** takes the release name and notes
from the build's production draft when it has them (so notes edited by hand in Play
Console survive), otherwise from its internal release, and lists the note languages
in its receipt. A release edit must coordinate
with every Play writer and commit with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`
so it cannot cancel an existing review by default.

The scheduled **Mobile Release Anchor** workflow queries each store for the exact
accepted build and creates
`release/<platform>-v<version>-<shortfp>` at its immutable build commit. The
anchor is commit-addressed through the `build-*` tags, so it is correct wherever
the build ran. These anchors preserve the existing JS-only OTA backport path
after the shipped fingerprint moves on.

## End-to-end checklist

1. Choose `main`, or cut an optional `release/next` train.
2. Set the release version and translate both stores' release notes — on
   the chosen branch. A version-only release also needs both native workflows
   dispatched by hand (§2, "Version-only releases").
3. Land the native changes on the chosen branch; wait for TestFlight and
   Play tester-track builds.
4. Complete native QA against the exact uploaded candidates.
5. Screenshots re-capture themselves after the native build (the probe decides
   whether to fan out); listing text pushes itself.
6. Verify the store drafts select the tagged builds. Submit the App Store version
   for review by hand; release Android with **Android Production Release** (plan,
   then `apply`).
7. After approval, confirm both immutable release anchors were created, then
   if using a train, merge it into `main` as a **merge commit** and reset it.
8. Re-record the homepage showcase video's app footage so the site shows the
   shipped app: `vp run video` ([showcase-video.md](showcase-video.md)).

## Notes

- Store build, draft, and anchor workflows use `Production`; its deployment-branch
  policy must list `release/next` alongside `main` (Settings → Environments →
  Production), or every train build fails with a branch-policy rejection. There is
  no separate native-release environment.
- Do not delete or move build, fingerprint, or release-anchor tags.
- Review submission, phased/staged rollout, and the iOS App Store icon upload are
  intentionally manual. The iOS icon comes from the uploaded binary.
- Android build and signing background: `docs/android-sideload-build.md`.

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
