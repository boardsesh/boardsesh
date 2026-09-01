# Mobile store release runbook

How a `packages/mobile` (React Native) release reaches the App Store and Google
Play without moving `main` off the fingerprint used by the currently shipped
binary. Native candidates live on the temporary `release/next` branch;
production OTA updates continue from `main` until both stores approve the exact
candidate and the release PR merges.

Source of truth for everything uploaded:

- Listing text: `fastlane/metadata/en-US/` (iOS), `fastlane/metadata/android/en-US/` (Android)
- Play images: `fastlane/metadata/android/en-US/images/` (`icon.png` 512x512, `featureGraphic.png` 1024x500)
- Screenshots: captured fresh, not committed (see `packages/mobile/.maestro/`)
- Lane details: `fastlane/README.md`

## One-time GitHub setup

Create a `Native Release` environment with a custom deployment-branch policy
that allows exactly `main` and `release/next`. Copy the native signing, App Store
Connect, Google Play, Maps, share-extension, Sentry and Discord secrets used by
the workflows in this runbook into that environment. The four values that exist
only in `Production` today (`DISCORD_DEPLOY_WEBHOOK`, `GOOGLE_MAPS_API_KEY`,
`IOS_SHARE_EXTENSION_PROVISIONING_PROFILE_BASE64`, and `SENTRY_AUTH_TOKEN`) must
be transferred from their secure source; GitHub never returns secret values.

After both `Production` and `Native Release` hold independent copies, remove the
repository-level duplicates of the iOS/Android signing and store credentials.
Otherwise a workflow that loses its environment binding silently falls back to
the repository secret and the environment is not a credential boundary. Keep
`OTA_PUSH_APP_PRIVATE_KEY` repository-scoped because trusted OTA and maintenance
workflows also use it.

The repository App used by `OTA_PUSH_APP_ID` needs Contents, Workflows and Pull
requests write access. Workflows is required to sync commits that touch
`.github/workflows`; Pull requests is required for the acceptance monitor to
merge with the App token so the resulting `main` push triggers production OTA.
Keep `CLAUDE_CODE_OAUTH_TOKEN` as a repository secret for conflict resolution.
Claude receives only the read-only workflow token; the repository App token is
minted after Claude exits and the result passes deterministic checks.

Protect `release/next` with the same pull-request approval rules as `main`, but
give only that repository App a ruleset bypass so it can perform the
lease-protected sync push. Allow branch deletion: the train is ephemeral and is
removed after its release PR merges.

Add an active tag ruleset for `build-*`, `fingerprint-*`, and `release/*` that
blocks creation, updates and deletion except through the same repository App.
The acceptance monitor trusts these tags to map an immutable store build number
to its commit and native fingerprint; allowing ordinary write tokens to replace
them would make automatic merge unsafe.

## 1. Route work to the right branch

- JS-only mobile changes target `main` and ship through the production OTA.
- Changes that move the Expo native fingerprint target `release/next`.
- Split mixed backend/native work: land a backward-compatible backend or schema
  foundation on `main`, then target the native mobile part at `release/next`.
  Keep the server compatible with the current store app until the replacement
  release has been adopted.

`release/next` is synchronized automatically after every `main` push. A linear
train is rebased. Once the release-only range contains a merge commit, the
workflow preserves that history by merging the exact `main` tip instead. If a
linear rebase conflicts, it also falls back to one merge so conflict resolution
stays bounded to a single set of files.

Merge conflicts are handed to a restricted Claude Opus agent. It can edit only
the recorded conflict paths and cannot stage, commit or push. Trusted workflow
steps reject extra paths, stage and commit the resolution, then run `vp check`,
the full typecheck and the full test suite. Only after those pass does the
workflow recheck the exact `main` and `release/next` tips and push atomically
with explicit leases on both refs. A failed agent, failed verification, or
concurrent branch update leaves the remote branch untouched and posts details
to `#deployments` for manual resolution.

## 2. Automatic candidate builds from `release/next`

A push that resolves to a new native fingerprint triggers:

- **iOS TestFlight Deploy** (`ios-testflight-rn.yml`) — builds the app, resolves
  the build number from App Store Connect (latest TestFlight build for the
  marketing version + 1), uploads to **TestFlight**.
- **Android Play Internal Deploy** (`android-apk-rn.yml`) — builds the AAB, resolves
  versionCode from Google Play (max across tracks + 1), uploads to the Play
  **internal** track with the "What's new" from `changelogs/default.txt`.
  It also publishes the exact signed arm64 APK as the newest **Boardsesh Next for
  Android** prerelease on the repository Releases page. The AAB remains an
  Actions artifact.

Both workflows record the exact store build number, commit and fingerprint in a
`build-<platform>-v<version>-<number>-<shortfp>` tag. A JS-only sync keeps the
fingerprint and skips a duplicate store build; its JavaScript ships by OTA after
the accepted release merges.

## 3. Dispatch when the listing changed

Run these from the Actions tab only when the relevant asset changed this release.
Both write to the **editable App Store version / Play draft listing**, so a wrong
value is fixed by editing the file and re-running.

- **Mobile Store Metadata** (`mobile-store-metadata.yml`, input `platform: all`)
  — pushes listing **text** (iOS + Android) and the **Play icon + feature
  graphic**. This is the workflow that updates the Play store-listing logo.
- **Mobile Screenshots** (`mobile-screenshots-ios.yml` and
  `mobile-screenshots-android.yml`, input `upload: true`) — capture and upload
  screenshots. iOS and Android are separate workflows so either platform can be
  rerun without waiting on the other.

The iOS "What's New" (`release_notes.txt`) is pushed by Mobile Store Metadata.
The Android "What's new" is **not** — it already shipped with the AAB in step 1,
one `whatsnew-<locale>` per `fastlane/metadata/android/<locale>/changelogs/`
folder.

## 4. Submit for review manually

- **App Store Connect** — attach the TestFlight build to the version, confirm the
  metadata/screenshots, **Submit for Review**.
- **Play Console** — **promote** the internal release to the production track.

Review submission and rollout remain manual. The release monitor treats an
approved-but-held build as accepted; public availability is not required.

## 5. Automatic merge after both approvals

The release monitor checks the exact attached Apple build and exact Google Play
production `versionCode`. The build recorded for `release/next` must have the
same marketing version and native fingerprint as the branch head. It then merges
the PR only when it is ready, approved, green, current and conflict-free.
Unresolved review threads are not a release gate.

The merge triggers the normal `main` production OTA under the accepted native
fingerprint. GitHub deletes `release/next`; recreate it from current `main` when
the next native train starts.

## End-to-end checklist

1. Bump `version` in `packages/mobile/app.config.ts`. Update
   `fastlane/metadata/en-US/release_notes.txt` (iOS) and
   `fastlane/metadata/android/en-US/changelogs/default.txt` (Android) if the
   release notes changed — **and translate them into `es-ES`, `es-MX`, `fr-FR`
   and `de-DE`**, which both stores upload verbatim. Nothing generates these:
   `scripts/generate-changelog.ts` writes only `CHANGELOG.md` and
   `changelog.generated.json`, so every locale here is hand-written and a locale
   you skip silently ships the previous release's notes. Play caps each
   changelog at 500 characters and German runs long — check before pushing.
   Commit these changes to `release/next`.
2. Wait for the automatic TestFlight + Play internal builds (Android changelog
   rides along) and complete native QA from the release PR.
3. **In App Store Connect, create the new version first** — the `ios metadata`
   lane only writes into an existing _editable_ version. Then, if copy / icon /
   screenshots changed this release, dispatch **Mobile Store Metadata** (`all`)
   and **Mobile Screenshots** (`upload: true`).
4. Mark the release PR ready and obtain approval, then submit iOS and Android
   for review. The release monitor merges when both exact builds are approved.

## Notes

- Native builds, the release monitor, and store-draft fingerprint verification
  use the restricted `Native Release` GitHub environment. Verification maps only
  the Maps key into release-tree code, resolves each checkout from its own frozen
  lockfile with lifecycle scripts disabled, and checks the immutable build-tag
  fingerprint. Do not grant `release/next` access to the broader `Production`
  environment.
- **Not automated, on purpose:** review submission, phased/staged rollout, and
  iOS App Store icon upload (the iOS store icon comes from the uploaded build's
  1024x1024 marketing icon, never from fastlane).
- The committed `featureGraphic.png` is a stopgap (the app logo on a dark
  background). Swap in a designed banner by replacing the PNG; the lane pushes
  whatever is there.
- Polishing the 2.0 release-notes copy is tracked in issue #2963.
- Android build / signing background: `docs/android-sideload-build.md`.
