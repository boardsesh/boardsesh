# Mobile store release runbook

How a `packages/mobile` (React Native) release reaches TestFlight and Google
Play from the release train, `release/next`. Regular work lands on `main`; every
change that moves the native fingerprint targets `release/next`, and merging it
there is what starts a store build. A native fingerprint change temporarily
prevents the current store fleet from receiving new production OTAs, so prepare
the release identity before the final native change and move the replacement
binaries through review quickly.

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

## 1. Open the train and prepare the release

The train is `release/next`. It is cut from `main`, carries the release, and is
merged back when the stores have accepted it.

1. **Cut it** (start of a release, or to reset it after a merge-back):

   ```sh
   git push --force-with-lease origin main:release/next
   ```

2. **Land the release identity on the train, before the final native change.**
   Bump `version` in `packages/mobile/app.config.ts` and update the localized iOS
   and Android release notes for `en-US`, `es-ES`, `es-MX`, `fr-FR`, and `de-DE`.
   Those PRs target `release/next`.
3. **Land the native changes.** Every PR that moves the native fingerprint
   targets `release/next`. The OTA compatibility check fails a fingerprint-moving
   PR into `main` and tells you to retarget it; the `allow-native-on-main` label
   is the owner's override, and it means main will build no replacement binary
   for that change.
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

## 2. Automatic native builds from `release/next`

A `release/next` push that resolves to a new native fingerprint triggers:

- **iOS TestFlight Deploy** (`ios-testflight-rn.yml`) — resolves the next build
  number from App Store Connect, builds, validates the archive, and uploads the
  exact binary to TestFlight.
- **Android Play Internal Deploy** (`android-apk-rn.yml`) — resolves the next
  versionCode from Google Play, builds and validates the APK/AAB, and uploads the
  AAB to Play internal. After Play accepts it, the exact signed arm64 APK is
  published as the newest **Boardsesh Android Beta** prerelease.

`workflow_dispatch` still works from `main` as well as `release/next` — that is
the hotfix rebuild after a merge-back, when main's fingerprint already equals the
train's. Automatic builds come only from the train. A dispatched build from
`main` does **not** auto-draft, because `mobile-store-draft.yml` subscribes to
completed runs whose head branch is `release/next`; dispatch
`mobile-store-draft.yml` by hand after that build lands.

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

The iPad set is its own campaign rather than the phone set in landscape — seven
frames leading with the wall kiosk, the boards, and the trailing wall column
lifted out of the browse screen and enlarged beside it. The
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
feature graphic. The iOS half can only write onto an *editable* App Store
version, so when the copy lands before a version exists (the normal order, §1)
that run skips iOS; `mobile-store-draft.yml` dispatches it again with
`platform: ios` right after it creates the version (§4), so the text and What's
New land without anyone running it by hand. Dispatch it manually only to re-push
unchanged copy.

Screenshots are automatic too. **Mobile Screenshots** (`mobile-screenshots-ios.yml`
and `mobile-screenshots-android.yml`) runs after each native deploy on
`release/next` **that actually shipped a binary**, one workflow per platform —
the train is where store candidates are built (§1), so that is where the pixels
come from. There is no cron; a manual `workflow_dispatch`, runnable from any
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

### The iOS probe gate

The iOS capture is a 12-shard macOS fan-out (4 app locales × 3 devices) and a
public repo gets 5 concurrent macOS runners, so the run sizes itself. With
`gate: probe` it shoots ONE shard first — en-US × iPhone 16 Pro Max — pulls the
matching shard out of the stored baseline and compares them pixel by pixel
(`vp run screenshot:compare`, `scripts/compare-screenshots.ts`). Unchanged and
the run stops there in roughly 15 minutes; changed, or no baseline yet, and it
fans out to the remaining 11 shards. Automatic runs always probe. On a dispatch
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
`packages/mobile/app.config.ts`, or `app-stores/apple/**` — or when the baseline
commit itself can't be fetched or diffed at all (no baseline yet, or one that
fell out of history). `ios-capture` and `ios-finalize` then treat `force_full`
exactly like a pixel-wise `changed`, fanning out even though the one shard the
probe actually captured matched byte for byte.

**Known remaining blind spot.** A shared component under
`packages/mobile/src/components/**` whose change only renders differently on
iPad (a `Platform.isPad` branch, a width-based layout switch) is caught by
neither the pixel probe (en-US iPhone only) nor the path rules above — its
file path says nothing about iPad. There is no changed-path signal to force a
fan-out here without also forcing a full 12-shard capture on every ordinary
component edit, which would defeat probing in the first place. Dispatch with
`gate: full` (or `upload: true`) by hand when a change is iPad-specific by
intent.

The baseline lives on a rolling GitHub prerelease tagged `screenshots-baseline`:
`pack` writes 15 `ios-<store-locale>-<device>.zip` files — 5 store locales × 3
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
completes on `release/next`, and on demand; there is no schedule. It pins the
current `release/next` SHA, selects the exact highest iOS and Android build tags
for that version, and checks that both tagged binaries match the train's platform
fingerprints. Immediately before changing either store draft it rechecks that
`release/next` and both selected tags have not moved. A mismatch, or only one platform's build existing yet, waits for a later
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

Review submission and rollout remain manual:

- **App Store Connect:** confirm the attached TestFlight build, metadata and
  screenshots, then submit it for review.
- **Play Console:** promote the verified internal release to production.

The scheduled **Mobile Release Anchor** workflow queries each store for the exact
accepted build and creates
`release/<platform>-v<version>-<shortfp>` at its immutable build commit. The
anchor is commit-addressed through the `build-*` tags, so it is correct wherever
the build ran. These anchors preserve the existing JS-only OTA backport path
after the shipped fingerprint moves on.

## End-to-end checklist

1. Cut the train: `git push --force-with-lease origin main:release/next`.
2. Set the release version and translate both stores' release notes — on
   `release/next`.
3. Land the focused native changes on `release/next`; wait for TestFlight and
   Play internal builds.
4. Complete native QA against the exact uploaded candidates.
5. Screenshots re-capture themselves after the native build (the probe decides
   whether to fan out); listing text pushes itself.
6. Verify the store drafts select the tagged builds, then submit both manually.
7. After approval, confirm both immutable release anchors were created, then
   merge `release/next` into `main` as a **merge commit** and reset the train.

## Notes

- Store build, draft, and anchor workflows use `Production`; its deployment-branch
  policy must list `release/next` alongside `main` (Settings → Environments →
  Production), or every train build fails with a branch-policy rejection. There is
  no separate native-release environment.
- Do not delete or move build, fingerprint, or release-anchor tags.
- Review submission, phased/staged rollout, and the iOS App Store icon upload are
  intentionally manual. The iOS icon comes from the uploaded binary.
- Android build and signing background: `docs/android-sideload-build.md`.
