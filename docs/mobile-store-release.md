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
text and What's New land on that version (§3). The Android lane promotes the
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
5. Re-capture screenshots if they changed; listing text pushes itself.
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
