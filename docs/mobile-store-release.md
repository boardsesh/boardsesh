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

## 3. Update listing material when needed

Run these from the Actions tab only when the corresponding material changed:

- **Mobile Store Metadata** (`mobile-store-metadata.yml`, `platform: all`) pushes
  listing text plus the Play icon and feature graphic.
- **Mobile Screenshots** (`mobile-screenshots-ios.yml` and
  `mobile-screenshots-android.yml`, `upload: true`) captures and uploads each
  platform independently.

The iOS `release_notes.txt` is pushed by Mobile Store Metadata. Android release
notes ship with the AAB from each
`fastlane/metadata/android/<locale>/changelogs/default.txt`; Play caps each file
at 500 characters.

## 4. Prepare and submit the exact store builds

`mobile-store-draft.yml` is best-effort and disabled unless
`ENABLE_STORE_DRAFT_SUBMISSION` is `true`. It pins the current `main` SHA,
selects the exact highest iOS and Android build tags for that version, and checks
that both tagged binaries match `main`'s platform fingerprints. Immediately
before changing either store draft it rechecks that `main` and both selected tags
have not moved. A mismatch waits for a later run instead of drafting the wrong
build.

Review submission and rollout remain manual:

- **App Store Connect:** attach the verified TestFlight build, confirm metadata
  and screenshots, then submit it for review.
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
4. Update metadata or screenshots only when they changed.
5. Verify the store drafts select the tagged builds, then submit both manually.
6. After approval, confirm both immutable release anchors were created.

## Notes

- Store build, draft, and anchor workflows use `Production`; there is no separate
  release branch or native-release environment.
- Do not delete or move build, fingerprint, or release-anchor tags.
- Review submission, phased/staged rollout, and the iOS App Store icon upload are
  intentionally manual. The iOS icon comes from the uploaded binary.
- Android build and signing background: `docs/android-sideload-build.md`.
