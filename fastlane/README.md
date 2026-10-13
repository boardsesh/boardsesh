# fastlane

Store-automation lanes for the React Native app (`packages/mobile`). Both
platforms have a screenshot upload lane, a listing-text (metadata) upload lane,
and a build-number resolver; Android also has a listing-image lane (Play
high-res icon / feature graphic). The dedicated iOS CPP lane can submit custom
product pages for review. The listing lanes do not submit for review or upload binaries.

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
filename prefixes set the display order inside each slot. The common iOS matrix
includes iPhone 16 Pro Max and iPhone 16 Pro portrait captures plus 13-inch and
11-inch iPad landscape captures.

The upload expects the generated Apple locale folders `en-US`, `es-ES`, `es-MX`,
`fr-FR`, and `de-DE`. The app has one Spanish locale (`es`), so the capture
pipeline writes the same Spanish screenshots to both App Store Connect Spanish
locales; German and French each map to one.

The Android lane uploads PNGs in `app-stores/google/screenshots/pixel-2/` to the
Google Play phone screenshot slot as **screenshots only**, staged into
`supply`'s expected `en-US/images/phoneScreenshots/` structure.

The default iOS replay campaign produces nine composed iPhone images from
18 real captures and retains the six-image iPad story. It uses the dedicated
Apple campaign fixture described in the [creative asset runbook](../docs/app-store-creative-assets.md).
Android and navigation smoke keep their existing fixture pin. Review every
locale/device set in the canonical upload tree before publication. Explicit
record/live captures are diagnostic; the iOS workflow requires replay for store
upload and baseline publication.

The `Mobile Screenshots (iOS)` manual workflow dispatch uploads only with
`upload = true`; capture-only defaults leave the store unchanged. Qualifying
automatic release-train runs can also upload a complete verified set. The Android
workflow is separate. See [mobile store release](../docs/mobile-store-release.md)
for the trigger and review sequence.

### Apple Header and Search Results

`vp run store:creatives` renders `header.png`, `search-results.png` and a
`creative-assets.json` source/output manifest outside the screenshot upload tree.
These are organic App Store creative assets, not screenshot slots. The fastlane
lanes above do not upload or publish them. Use the manual Asset Library review
and placement steps in the [creative asset runbook](../docs/app-store-creative-assets.md).
Keep native captures and their locale/device identity together when generating
localized assets.

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
in CI, consumed as `steps.<id>.outputs.value`). Automatic store builds and production OTA delivery
run from `main`; fingerprint gating prevents duplicate native builds.

- **`ios next_build_number`** = `latest_testflight_build_number` for the current
  marketing version (from `packages/mobile/app.config.ts`) `+ 1`.
- **`android next_version_code`** = max `versionCode` across the Play release
  tracks `+ 1` (which keeps the result above the legacy Capacitor ceiling).

Both fall back to `offset + run_number` (the previous deterministic scheme) when
the store query fails or the credential is missing — set `BUILD_NUMBER_FALLBACK`
/ `VERSION_CODE_FALLBACK` in the environment. `ios-testflight-rn.yml` and
`android-apk-rn.yml` call these and pass the fallback; the `*_offset`
workflow_dispatch inputs still feed it.

## Custom product pages — `ios cpp`

The CPP manifest is `app-stores/apple/custom-product-pages.json`. Create empty
App Store Connect drafts first, then capture and frame the complete image sets
before upload or submission:

```bash
cd fastlane
bundle exec fastlane ios cpp target:all action:create
cd ..
vp run mobile:screenshots -- --cpp all --platform ios --fixtures replay --theme dark --devices common --locales all
cd fastlane
bundle exec fastlane ios cpp target:all action:plan
bundle exec fastlane ios cpp target:all action:upload
bundle exec fastlane ios cpp target:all action:submit
```

`target` accepts `kilter`, `tension`, `moonboard`, `spray`, or `all`; omitted
arguments mean `target:all action:plan`. Plan reads App Store Connect without
writing, even before native captures or fixture pins exist. It reports unresolved
local inputs and the approved keyword text, eligible opaque IDs, and existing
page assignments as structured `CPP_PLAN_JSON` log entries. Set
`ASC_CPP_PLAN_OUTPUT` to also write this report to a local JSON artifact.
Create makes missing named pages with one empty initial draft version, without
requiring captures or eligible organic keywords. It verifies the returned app
ownership, exact name, App Store URL and version state. Repeated calls reuse
existing pages without changing their content or visibility, including approved
pages; ambiguous names or unexpected ownership fail before further creation.
It never assigns keywords, uploads screenshots, or submits review. Drafts are
visible in App Store Connect; customers can use them after later content approval.
Set `ASC_CPP_CREATE_OUTPUT` to save verified identities as JSON.

For CI, dispatch `mobile-screenshots-ios.yml` from `main` with `cpp_target: all`
and `cpp_action: create`, keeping the default replay settings and no capture
overrides. This Production job joins the existing store writer mutex, checks its
source commit, skips native builds/captures, and retains the `cpp-create` artifact
with page IDs, URLs, app ownership, and version states. Subsequent upload and
submit still enforce the complete image and keyword gates below.

Upload reconciles separate CPP drafts and uploads screenshots and
localized promotional copy. Submit also creates or resumes a CPP-only review
submission, checks its exact membership, enables page links, and submits it.
Default-listing metadata and `deliver` screenshot lanes are unchanged.

Preflight requires all nine images for every selected locale/device, compatible
pixel dimensions, and target-specific capture provenance. It checks the latest
approved iOS app version's keyword field and keyword-resource eligibility, plus
assignments on existing pages. Missing keywords must be added to a future app
version and approved before using them for a CPP. Keyword assignment does not
guarantee search placement. See [Apple's keyword rules](https://developer.apple.com/help/app-store-connect/create-custom-product-pages/configure-multiple-product-page-versions/).

Apple's `appKeywords` API resources expose only opaque IDs. Supply a verified
mapping using `ASC_CPP_KEYWORD_IDS_JSON`, keyed by App Store locale and the exact
keyword in the CPP manifest, for example `{ "en-US": { "Kilter": "<Apple resource ID>" } }`.
The plan logs eligible IDs where mappings are missing; it never infers IDs from
keyword spelling or list order. Upload and submit fail before any writes when
a mapping is missing, ineligible, or assigned to a different page. These IDs
are account resource identifiers, not authentication credentials.

Identical uploads and review submissions are skipped. Interrupted uploads
resume matching reservations. Approved pages receive a fresh version when
content changes; under-review changes fail. The lane never deletes a page,
localization, keyword assignment, or screenshot. Conflicting existing draft
assets (including assets inherited by Apple into a new version) require the
owner to resolve the draft in App Store Connect before retrying. Requests have
bounded retries and processing waits; ambiguous POST failures require a rerun
so existing resources can be reconciled first. Workflow summaries show page
URLs and review states. [Apple's submission process](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-a-custom-product-page/)

Mocked automation tests run with `vp exec ruby fastlane/tests/custom_product_pages_test.rb`.
Ruby and Bundler are supplied by the existing macOS/CI Fastlane toolchain.

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
