# fastlane

Store-automation lanes for the React Native app (`packages/mobile`). Both
platforms have native tester-upload, screenshot, listing-text (metadata), and
build-number lanes; Android also has listing-image and release-lifecycle audit lanes. The dedicated iOS CPP lane can submit custom
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

## Native tester updates — `android upload_beta`, `ios testflight`

Pushes to `main` and `release/next` automatically build a replacement when the
native fingerprint changes. Android uploads the same AAB to **internal and open
testing (`beta`)** in one edit. Both releases use `completed`, making the build
available to 100% of eligible testers after Google permits publication. iOS
exports the signed archive and uploads to TestFlight using the workflow's
existing export options. Store review and processing still determine when a
tester can install either build.

JavaScript-only changes continue through the separate OTA workflows. A binary
can only receive OTA bundles matching its runtime fingerprint; choosing staging
cannot make an older native binary load an incompatible bundle. See the
[OTA runbook](../docs/mobile-ota-updates.md).

The native workflows call these lanes after building and checking the artifacts:

```bash
cd fastlane
bundle exec fastlane android upload_beta
bundle exec fastlane ios testflight
```

| Android input | Meaning |
| --- | --- |
| `ANDROID_AAB_PATH` | One built AAB path, or glob matching exactly one AAB |
| `ANDROID_VERSION_CODE` | Exact expected uploaded versionCode |
| `BOARDSESH_MOBILE_VERSION` | Semver release label from the build pipeline |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Existing Play service-account JSON |

Android options `aab:`, `version_code:`, and `version:` override those inputs.
`metadata_path:` defaults to committed `fastlane/metadata/android`; every
locale's `changelogs/default.txt` supplies the same notes to both tester tracks.
Notes must contain 1–500 characters. `output:` optionally saves a JSON commit
receipt. Relative AAB and metadata paths resolve from the repository root.
The lane checks Play's existing versionCodes before uploading, verifies the
uploaded versionCode, validates both track assignments, and commits once.
The release label is supplied by the build pipeline; the lane does not separately
extract the embedded AAB versionName.

The pinned Google API client commits with
`changes_not_sent_for_review: false` and
`changes_in_review_behavior: "ERROR_IF_IN_REVIEW"`. Existing review conflicts
fail the upload; the lane never cancels a review, retries with an unsubmitted
release, or changes production. A commit receipt is submission evidence, not
proof of publication or delivery. Google review and managed publishing can keep
open testing unchanged until they finish. Audit the exact build afterward.

| iOS input | Meaning |
| --- | --- |
| `ARCHIVE_PATH` | Existing signed `.xcarchive` directory |
| `EXPORT_OPTIONS_PLIST` | Existing workflow-generated export options |
| `EXPORT_PATH` | Destination for exported artifacts |
| `APP_STORE_CONNECT_API_KEY_ID` | Key ID matching `~/.private_keys/AuthKey_<id>.p8` |
| `APP_STORE_CONNECT_ISSUER_ID` | Existing App Store Connect issuer ID |

Relative iOS build paths resolve from the repository root. The lane preserves
`xcodebuild -exportArchive` and the existing export/signing configuration.

## Play catch-up and publication checks — `android beta`, `android audit`

Use an exact versionCode to inspect open testing without opening an edit:

```bash
cd fastlane
bundle exec fastlane android audit version_code:2001310 track:beta
bundle exec fastlane android beta version_code:2001310
```

`android beta` defaults to a read-only plan. It requires one exact **published**
internal release and refuses to overwrite a newer beta build. To submit that
existing build to open testing, run
`bundle exec fastlane android beta version_code:2001310 apply:true`.
Applying always inspects the edit's exact release status. A partially rolled out
or halted matching beta is set to `completed`; only a `PUBLISHED` release
whose edit status is also `completed` skips track writes. A completed release
that still needs review is submitted. The GET-only plan reports rollout status as unknown:
Google's `PUBLISHED` lifecycle includes partial and halted releases.
This is the catch-up path for a build already uploaded internally; routine new
native builds use `upload_beta` instead. Neither lane uploads production releases.

## Production release — `android production`

```bash
cd fastlane
bundle exec fastlane android production version_code:2001310
bundle exec fastlane android production version_code:2001310 rollout:100 apply:true
```

The same exact-build rules as `android beta`, written to the production track.
The default is a read-only plan. `rollout:` takes a whole percent from 1 to 100
(default 100). At 100 the build becomes the only production release, replacing
the live release and any draft. Below 100 it is written as `inProgress` beside
the current completed release. A build already completed on production cannot be
shrunk to a staged rollout. CI runs it through `mobile-store-android-production.yml`.

`android audit` accepts `track:internal`, `track:beta`, or `track:production`
and saves its lifecycle receipt to `output:` or a temporary file printed in the
log. A `PUBLISHED` lifecycle state includes partial and halted releases; it does
not verify a 100% rollout, an active testing track, or delivery to a tester.
The states `DRAFT`, `NOT_SENT_FOR_REVIEW`, `IN_REVIEW`, and
`APPROVED_NOT_PUBLISHED` do not confirm publication.
An empty receipt immediately after commit means publication is not yet verified.
Tester delivery also depends on account eligibility, device compatibility, and
Play Store propagation.

Mocked upload checks: `vp exec ruby fastlane/tests/android_release_test.rb`.
Lane invocation checks: `vp exec ruby fastlane/tests/native_upload_lanes_test.rb`.

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
`upload = true` and all 16 native shards successful for the complete App Store
locale/device set. Failed captures still retain diagnostics and run image gates,
but cannot prepare Apple credentials or upload. Capture-only defaults leave the
store unchanged. Qualifying
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
  ships with the AAB through `android upload_beta`, sourced from each locale's
  `changelogs/default.txt` — so the release
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
run from `main`; native tester builds also run from `release/next`.
Fingerprint gating prevents duplicate native builds.

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
bundle exec fastlane ios cpp target:all action:stage-assets
bundle exec fastlane ios cpp target:all action:upload
bundle exec fastlane ios cpp target:all action:submit
```

`target` accepts `kilter`, `tension`, `moonboard`, `spray`, or `all`; omitted
arguments mean `target:all action:plan`. Plan reads App Store Connect without
writing, even before native captures or fixture pins exist. It reports unresolved
local inputs and the approved keyword text, eligible opaque IDs, and existing
page assignments as structured `CPP_PLAN_JSON` log entries. Set
`ASC_CPP_PLAN_OUTPUT` to also write this report to a local JSON artifact.
Create makes missing named pages with one blank initial draft version and one
locale-only localization, without requiring captures or eligible organic keywords.
The first configured target localization selects the first App Store locale in
its manifest mapping. Every missing target's mapping is checked before any page
is created. Read-back verifies app ownership, exact name, App Store URL, version
state, and one matching version-owned localization with no promotional copy,
screenshots, previews, or keyword assignments. Repeated calls reuse
existing pages without changing their content or visibility, including approved
pages; ambiguous names, unexpected ownership, or existing pages without a current
version fail before any selected page is created. Replaced historical versions
do not qualify as current versions.
It never assigns keywords, uploads screenshots, or submits review. Drafts are
visible in App Store Connect; customers can use them after later content approval.
Set `ASC_CPP_CREATE_OUTPUT` to save verified identities as JSON.
The compound creation request links its initial version and locale-only localization with Apple's
[request-local `${...}` identifier syntax](https://developer.apple.com/videos/play/wwdc2020/10004/),
using the [documented inline localization relationship](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appcustomproductpages).
It never copies an App Store version template. A failed POST is never automatically retried.

For CI, dispatch `mobile-screenshots-ios.yml` from `main` with `cpp_target: all`
and `cpp_action: create`, keeping the default replay settings and no capture
overrides. This Production job joins the existing store writer mutex, checks its
source commit, skips native builds/captures, and retains the `cpp-create` artifact
with page IDs, URLs, app ownership, and version states. Subsequent upload and
submit still enforce the complete image and keyword gates below.

Stage-assets fills existing current editable drafts with screenshots and
localized promotional text so you can submit their content for review yourself.
Dispatch from `main` with `cpp_action: stage-assets`, replay fixtures, empty
locales, and default-listing upload/baseline flags off. It uses the full native
capture matrix, source-SHA check, export validation, Production credentials,
and the shared store writer mutex. Create the named drafts separately first;
staging never creates a page or version, edits visibility, or submits review.
Every selected draft is verified before the first write. Existing keyword
memberships must remain unchanged, and new localizations remain unassigned.
Missing approved terms or keyword ID mappings do not block this explicit action;
Apple allows assigning eligible keywords later. The full upload and submit actions
still enforce every keyword gate below.

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
