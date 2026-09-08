# Mobile store release runbook

How a `packages/mobile` (React Native) release reaches TestFlight and Google
Play from `main`. A native fingerprint change temporarily prevents the current
store fleet from receiving new production OTAs, so prepare the release identity
before the final native change and move the replacement binaries through review
quickly.

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

## 1. Prepare the release on `main`

- All mobile changes target `main`, including native fingerprint changes.
- Before the final native change lands, bump `version` in
  `packages/mobile/app.config.ts` and update the localized iOS and Android
  release notes for `en-US`, `es-ES`, `es-MX`, `fr-FR`, and `de-DE`.
- Keep mixed backend/native changes backward-compatible with the currently
  shipped app until the replacement store release has been adopted.

A fingerprint change on `main` makes older binaries OTA-ineligible for later
bundles from `main`. This is expected. Keep the native change set focused and
start store QA and review as soon as the automatic builds finish. An urgent
JS-only fix for an older accepted binary can still use the OTA backport workflow
and its immutable release anchor.

## 2. Automatic native builds from `main`

A `main` push that resolves to a new native fingerprint triggers:

- **iOS TestFlight Deploy** (`ios-testflight-rn.yml`) — resolves the next build
  number from App Store Connect, builds, validates the archive, and uploads the
  exact binary to TestFlight.
- **Android Play Internal Deploy** (`android-apk-rn.yml`) — resolves the next
  versionCode from Google Play, builds and validates the APK/AAB, and uploads the
  AAB to Play internal. After Play accepts it, the exact signed arm64 APK is
  published as the newest **Boardsesh Android Beta** prerelease.

Both workflows use the `Production` environment and serialize non-cancelling
builds. A successful upload records the exact commit, store build number, and
fingerprint in an immutable
`build-<platform>-v<version>-<number>-<shortfp>` tag. The matching
`fingerprint-<platform>-<hash>` tag prevents duplicate native builds when a later
`main` push is JS-only.

## 3. Listing material

Listing text is automatic. **Mobile Store Metadata** (`mobile-store-metadata.yml`)
runs on every `main` push that touches `fastlane/metadata/**`, the Fastfile, or
the committed Play screenshots, and pushes listing text plus the Play icon and
feature graphic. The iOS half can only write onto an *editable* App Store
version, so when the copy lands before a version exists (the normal order, §1)
that run skips iOS; `mobile-store-draft.yml` dispatches it again with
`platform: ios` right after it creates the version (§4), so the text and What's
New land without anyone running it by hand. Dispatch it manually only to re-push
unchanged copy.

Screenshots stay on demand: **Mobile Screenshots** (`mobile-screenshots-ios.yml`
and `mobile-screenshots-android.yml`, `upload: true`) captures and uploads each
platform independently.

### The iOS probe gate

The iOS capture is a 12-shard macOS fan-out (4 app locales × 3 devices) and a
public repo gets 5 concurrent macOS runners, so the run sizes itself. With
`gate: probe` it shoots ONE shard first — en-US × iPhone 16 Pro Max — pulls the
matching shard out of the stored baseline and compares them pixel by pixel
(`vp run screenshot:compare`, `scripts/compare-screenshots.ts`). Unchanged and
the run stops there in roughly 15 minutes; changed, or no baseline yet, and it
fans out to the remaining 11 shards. `gate: full`, the default, always captures
everything, and a narrowed `locales` list, the `onboarding` flow or
`upload: true` force it back to `full` — none of those has a full-set baseline to
compare against.

Two thresholds decide "changed": a per-channel tolerance of 8 (simulator text
and shadow rasterization wobbles by a step or two between runs) and a max
differing-pixel ratio of 0.001. Both can be overridden per run through
`SCREENSHOT_CHANNEL_TOLERANCE` / `SCREENSHOT_MAX_DIFF_RATIO`; the header comment
in `scripts/compare-screenshots.ts` carries the recalibration procedure. The
probe uploads an `ios-probe-compare` artifact with the summary JSON and a
red-mask diff PNG per changed shot, so you can see what moved before trusting
the fan-out.

The baseline lives on a rolling GitHub prerelease tagged `screenshots-baseline`:
one `ios-<store-locale>-<device>.zip` per shard plus an `ios-manifest.json`
recording the commit, the run id and a sha256 per file. Captured PNGs are
deliberately not committed (issue #2905), and the prerelease keeps them out of
git history while staying writable by the plain `GITHUB_TOKEN` — the tag ruleset
covers only `build-*`, `fingerprint-*` and `release/*`. `vp run
screenshot:baseline` packs, publishes and fetches it, and refuses to publish a
tree that is short a locale or a device.

The automatic trigger refreshes the baseline after every complete capture; a
manual dispatch has to ask with `publish_baseline: true`, so a run that
deliberately retargets `render_mode` or `boards` cannot silently redefine
"unchanged" for everyone else. `upload: true` is unchanged and still pushes the
freshly captured set to App Store Connect.

The iOS `release_notes.txt` is pushed by Mobile Store Metadata. Android release
notes ship with the AAB from each
`fastlane/metadata/android/<locale>/changelogs/default.txt`; Play caps each file
at 500 characters.

## 4. Prepare and submit the exact store builds

`mobile-store-draft.yml` is best-effort and always on; there is no enable flag.
It runs whenever **iOS TestFlight Deploy** or **Android Play Internal Deploy**
completes on `main`, and on demand; there is no schedule. It pins the current `main` SHA, selects the exact highest
iOS and Android build tags for that version, and checks that both tagged
binaries match `main`'s platform fingerprints. Immediately before changing
either store draft it rechecks that `main` and both selected tags have not
moved. A mismatch, or only one platform's build existing yet, waits for a later
run (the other platform's completion re-triggers it) instead of drafting the
wrong build.

The iOS lane waits up to 45 minutes for App Store Connect to finish processing
the tagged build, then attaches it to the editable version (creating the version
first if needed) and dispatches Mobile Store Metadata for iOS so the listing
text and What's New land on that version (§3). Screenshots have the same
ordering problem one step further out — the capture workflow finishes long
before ASC has processed the build, so its own upload finds no editable version
and skips — so the lane then pulls the published `screenshots-baseline` set
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
`release/<platform>-v<version>-<shortfp>` at its immutable build commit. These
anchors preserve the existing JS-only OTA backport path after `main` moves to a
future fingerprint.

## End-to-end checklist

1. Set the release version and translate both stores' release notes on `main`.
2. Land the focused native change; wait for TestFlight and Play internal builds.
3. Complete native QA against the exact uploaded candidates.
4. Re-capture screenshots when the UI moved (`gate: probe` decides for you); listing text pushes itself.
5. Verify the store drafts select the tagged builds, then submit both manually.
6. After approval, confirm both immutable release anchors were created.

## Notes

- Store build, draft, and anchor workflows use `Production`; there is no separate
  release branch or native-release environment.
- Do not delete or move build, fingerprint, or release-anchor tags.
- Review submission, phased/staged rollout, and the iOS App Store icon upload are
  intentionally manual. The iOS icon comes from the uploaded binary.
- Android build and signing background: `docs/android-sideload-build.md`.
