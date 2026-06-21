# fastlane

Store-automation lanes for the React Native app (`packages/mobile`). Both
platforms have a screenshot upload lane, a listing-text (metadata) upload lane,
and a build-number resolver; Android also has a listing-image lane (Play
high-res icon / feature graphic). Nothing here uploads a binary, submits for
review, or does a staged rollout.

```bash
# screenshots (PNGs from app-stores/apple/screenshots/<locale>/<device>/ and app-stores/google/screenshots/<device>/)
cd fastlane && bundle exec fastlane ios screenshots
cd fastlane && bundle exec fastlane android screenshots

# listing text (from fastlane/metadata/)
cd fastlane && bundle exec fastlane ios metadata
cd fastlane && bundle exec fastlane android metadata

# Play listing images — high-res icon / feature graphic (from fastlane/metadata/android/en-US/images/)
cd fastlane && bundle exec fastlane android images

# next build number / versionCode (prints to stdout; used by the build workflows)
cd fastlane && bundle exec fastlane ios next_build_number
cd fastlane && bundle exec fastlane android next_version_code
```

## Screenshots — `ios screenshots`, `android screenshots`

The iOS lane uploads PNGs in
`app-stores/apple/screenshots/<app-store-locale>/<device>/` (captured by
`vp run mobile:screenshots -- --devices common --locales all`) as
**screenshots only** — no binary, no text metadata, no review submission.
deliver routes each image to its display slot by pixel dimensions; the `NN-`
filename prefixes set the display order inside each slot.

The upload expects the generated Apple locale folders `en-US`, `es-ES`, `es-MX`,
and `fr-FR`. The app has one Spanish locale (`es`), so the capture pipeline
writes the same Spanish screenshots to both App Store Connect Spanish locales.

The Android lane uploads PNGs in `app-stores/google/screenshots/pixel-2/` to the
Google Play phone screenshot slot as **screenshots only**, staged into
`supply`'s expected `en-US/images/phoneScreenshots/` structure.

In CI these run from the `Mobile Screenshots (Native)` workflow when dispatched
with `upload = true` (never on the nightly cron).

## Listing text — `ios metadata`, `android metadata`

Source of truth is the committed `fastlane/metadata/` tree (see
`app-stores/apple|google/*.md` for the pointers and the operational material
`deliver`/`supply` can't upload):

```
fastlane/metadata/
  en-US/                      # deliver (App Store Connect)
    name.txt  subtitle.txt  description.txt  keywords.txt
    release_notes.txt         # "What's New in This Version"
    support_url.txt  marketing_url.txt  privacy_url.txt
  android/en-US/              # supply (Google Play)
    title.txt  short_description.txt  full_description.txt
    changelogs/default.txt    # "What's new" (see note below)
```

- **`ios metadata`** updates the **editable** App Store version's text
  (`skip_binary_upload`, `skip_screenshots`, `submit_for_review: false`). It does
  not bump the version (`skip_app_version_update: true`), so an editable
  "Prepare for Submission" version must already exist in App Store Connect.
  `release_notes.txt` is the public "What's New" for that version.
- **`android metadata`** updates the Play **listing text** (title + short/full
  description) only. It deliberately skips changelogs: the Android "What's new"
  ships with the AAB at release time via `android-apk-rn.yml`'s
  `whatsNewDirectory`, sourced from `changelogs/default.txt` — so the release
  notes always travel with the release they describe.

Both push to the editable/draft listing, so a wrong value is reversible: edit
the `.txt` and re-run. In CI they run from the `Mobile Store Metadata` workflow
(manual dispatch, `platform: ios | android | all`).

## Listing images (Play only) — `android images`

Google Play's listing images are source-controlled under
`fastlane/metadata/android/en-US/images/`:

```
images/
  icon.png            # 512x512, 32-bit PNG, < 1MB (Play high-res listing icon)
  featureGraphic.png  # 1024x500, no transparency (Play feature graphic)
```

`android images` uploads whatever images are present there and leaves phone
screenshots and any image you didn't commit untouched (no `sync_image_upload`,
so a missing image never deletes the live one). Both are derived from the app
art with `sharp`: `icon.png` is `packages/mobile/assets/icon.png` resized to
512x512, and `featureGraphic.png` is `adaptive-icon.png` centered on a #0A0A0A
background. Regenerate them if the app art changes.

This is the only way to update the Play **store-listing** icon from code instead
of the Play Console UI. Note the launcher icon inside the app comes from the
build (`adaptive-icon.png`), and the **iOS App Store icon cannot be set via
fastlane at all** — App Store Connect reads it from the uploaded build's
1024x1024 marketing icon.

## Build numbers — `ios next_build_number`, `android next_version_code`

These resolve the next build identifier from the **live store** instead of a
hand-maintained offset, and print it as `value=<n>` (written to `$GITHUB_OUTPUT`
in CI, consumed as `steps.<id>.outputs.value`).

- **`ios next_build_number`** = `latest_testflight_build_number` for the current
  marketing version (from `packages/mobile/app.config.ts`) `+ 1`.
- **`android next_version_code`** = max `versionCode` across the Play release
  tracks `+ 1` (which keeps the result above the legacy Capacitor ceiling).

Both fall back to `offset + run_number` (the previous deterministic scheme) when
the store query fails or the credential is missing — set `BUILD_NUMBER_FALLBACK`
/ `VERSION_CODE_FALLBACK` in the environment. `ios-testflight-rn.yml` and
`android-apk-rn.yml` call these and pass the fallback; the `*_offset`
workflow_dispatch inputs still feed it.

## Auth

iOS auth is an App Store Connect API key (same key as the TestFlight workflows):

| Env var                        | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `APP_STORE_CONNECT_API_KEY_ID` | ASC API key id                        |
| `APP_STORE_CONNECT_ISSUER_ID`  | ASC API issuer id                     |
| `ASC_KEY_PATH`                 | path to the decoded `.p8` private key |

Android auth is the Play service account JSON:

| Env var                            | Purpose                                   |
| ---------------------------------- | ----------------------------------------- |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Play Developer API service account |

No new secrets beyond what the screenshot / TestFlight / Android workflows
already use.
