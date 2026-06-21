# Mobile store release runbook

How a `packages/mobile` (React Native) release reaches the App Store and Google
Play. Three layers: **builds are automatic on merge**, **store assets are a
dispatch-when-changed workflow**, and **the final "go live" is a manual click in
each store** (we deliberately do not automate review submission or production
rollout).

Source of truth for everything uploaded:

- Listing text: `fastlane/metadata/en-US/` (iOS), `fastlane/metadata/android/en-US/` (Android)
- Play images: `fastlane/metadata/android/en-US/images/` (`icon.png` 512x512, `featureGraphic.png` 1024x500)
- Screenshots: captured fresh, not committed (see `packages/mobile/.maestro/`)
- Lane details: `fastlane/README.md`

## 1. Automatic on merge to `main`

Merging anything under `packages/mobile/` or the shared packages triggers:

- **iOS TestFlight Deploy** (`ios-testflight-rn.yml`) — builds the app, resolves
  the build number from App Store Connect (latest TestFlight build for the
  marketing version + 1), uploads to **TestFlight**.
- **Android APK Build** (`android-apk-rn.yml`) — builds the AAB, resolves
  versionCode from Google Play (max across tracks + 1), uploads to the Play
  **internal** track with the "What's new" from `changelogs/default.txt`, and
  publishes the sideload APK as a GitHub Release.

Both fall back to `offset + run_number` if the store query fails or a credential
is missing; the `build_number_offset` / `version_code_offset` dispatch inputs
feed that fallback. So the binary and the Android release notes ship with no
action from you.

## 2. Dispatch when the listing changed

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
The Android "What's new" is **not** — it already shipped with the AAB in step 1.

## 3. Manual "go live" in the stores

- **App Store Connect** — attach the TestFlight build to the version, confirm the
  metadata/screenshots, **Submit for Review**.
- **Play Console** — **promote** the internal release to the production track.

## End-to-end checklist

1. Bump `version` in `packages/mobile/app.config.ts`. Update
   `fastlane/metadata/en-US/release_notes.txt` (iOS) and
   `fastlane/metadata/android/en-US/changelogs/default.txt` (Android) if the
   release notes changed. Merge to `main`.
2. Merge auto-builds TestFlight + Play internal (Android changelog rides along).
3. **In App Store Connect, create the new version first** — the `ios metadata`
   lane only writes into an existing _editable_ version. Then, if copy / icon /
   screenshots changed this release, dispatch **Mobile Store Metadata** (`all`)
   and **Mobile Screenshots** (`upload: true`).
4. Submit for Review (iOS) and promote internal -> production (Play).

## Notes

- **No new secrets.** Everything reuses the App Store Connect API key and Google
  Play service-account secrets the build workflows already use.
- **Not automated, on purpose:** review submission, phased/staged rollout, and
  iOS App Store icon upload (the iOS store icon comes from the uploaded build's
  1024x1024 marketing icon, never from fastlane).
- The committed `featureGraphic.png` is a stopgap (the app logo on a dark
  background). Swap in a designed banner by replacing the PNG; the lane pushes
  whatever is there.
- Polishing the 2.0 release-notes copy is tracked in issue #2963.
- Android build / signing background: `docs/android-sideload-build.md`.
