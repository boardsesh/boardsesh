# App Store creative assets

The iPhone campaign carries the homepage showcase video's typography and board
imagery into nine screenshots, plus separate Header and Search Results stills.
Every app view comes from a real native capture. Compositing may frame, scale or
enlarge those captures; it must not invent controls, change a board's identity,
or use AI-generated screenshots. The Dynamic Island composition extracts the
actual native black silhouette, retaining its captured controls, text and thumbnail
while removing the surrounding SpringBoard wallpaper and decorative capture
border; it centers that silhouette on an opaque canvas.

## Capture prerequisite and campaign order

The first screenshot shows Kilter, the permitted spray wall in the center
foreground, and MoonBoard. The second gives the spray wall its own light
marketing background. The third, “More boards. Same app.” in English, shows
Woods/Decoy/Grasshopper and names compatibility with Touchstone and So iLL.
The shared crew queue is fourth. Wall status, the multiboard logbook, workouts,
Dynamic Island and climb search complete the story. See the
[exact output filenames](../app-stores/apple/app-store-metadata.md#screenshots).
Keep iPad's six-image kiosk-first story.

The default iOS `app-store` replay capture uses the nine-image campaign and the
separate `app-stores/apple/campaign-fixtures.json` reference. Android and the
navigation smoke keep `app-stores/screenshot-fixtures.json`. The campaign fixture
contains a shared crew session and seven selectors in this order: Kilter,
Tension, MoonBoard, Woods, Decoy, Grasshopper, spray. Preflight checks recorded
board types and refuses a missing or substituted board. The permitted spray
photo is bundled for offline replay; signed production URLs are never published.
See the [fixture workflow](mobile-screenshot-fixtures.md) for recording and
sanitizing a replacement.

```bash
vp run mobile:screenshots -- --platform ios --fixtures replay --theme dark --devices common --locales all
```

The common matrix contains iPhone 16 Pro Max, iPhone 16 Pro, and both existing
landscape iPads, across four app locales. That is 16 capture shards and
20 storefront sets because Spanish supplies two Apple locales. The campaign
captures 18 native sources per iPhone and frames nine output images. Sources
remain under `app-stores/apple/raw-screenshots/`; composed sets are under
`app-stores/apple/screenshots/`, with presentation manifests and contact sheets.
The explicit `--flow app-store-campaign` alias selects the same iOS campaign.

Explicit `--fixtures record` and `--fixtures off` retain the legacy diagnostic
flow. The iOS workflow refuses store upload or baseline publication from these
modes. Review complete replay captures before uploading them.

## Generate Header and Search Results stills

Record fresh native captures for every app locale (`en-US`, `es`, `fr`, `de`).
Use the original PNG directory for the matching variant, device and locale:

```bash
vp run store:creatives -- --input <rawdevice> --output .boardsesh/app-store-creatives --device iphone-16-pro --locale en-US --variant default
vp run store:creatives -- --input app-stores/apple/cpp/kilter/raw-screenshots/en-US/iphone-16-pro --output .boardsesh/app-store-creatives --device iphone-16-pro --locale en-US --variant kilter
```

`--variant` accepts `default`, `kilter`, `tension`, `moonboard`, and `spray`;
omitting it selects `default`. The output is always
`<output>/<variant>/<app-locale>/`. Both iPhone 16 Pro and iPhone 16 Pro Max
native sources are supported. The default needs unframed `00-board-view.png`
(Kilter), `14-spray-board-view.png` (the permitted Home Spray Wall), and
`10-moonboard-board-view.png` (MoonBoard). Each CPP needs its own
`hero-1.png`, `hero-2.png`, and `hero-3.png`; the generator reads the existing
CPP opening recipe rather than substituting the default campaign trio.

The output contains opaque `header.png` at 3840 × 1646,
`search-results.png` at 3840 × 2560, and `creative-assets.json`. The manifest
records variant, locale, capture device, source hashes and byte counts, CPP
manifest hash, composition geometry, and output dimensions and hashes.
Retain it with review artifacts; it is not an image to upload to Apple.
These dimensions follow Apple's
[creative asset specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications).

Header has no added text or wordmark. Its native hero is 640 px wide, centered
at x=1920 with top y=40. Rear phones are 560 px wide, centered at x=1320 and
x=2520 with top y=100. The background is `#110A20`, with a `#7C3AED` glow at
50% / 45%; native panels retain the violet border and shadow. Kilter shows
Homewall 7x10, Original 12x12 in front, and Homewall 10x10. Tension and MoonBoard
use their own CPP hero trio. Spray keeps its own three native walls, places Liz's
Wall in front, and overlaps a framed `lizfinal.JPG` photograph dimmed with a 30%
black overlay. Only the spray CPP receives this extra photograph. Its original
hash, byte count, and consent reminder stay in the export manifest; preserve the
user-supplied campaign consent record with the reviewed assets.

The central core is x=1280–2560; the intended square crop is x=1097–2743.
The top y=0–250 and lower y=1150–1646 overlay regions are assumptions pending
App Store Connect Preview. Inspect every variant there before approval;
source dimensions and correct geometry alone do not establish overlay safety.
Search Results retains localized copy and the matching variant's original
three-board recipe. Both placements keep native app pixels unchanged.
The output directory must be separate from the inputs and outside default or
CPP screenshot upload trees.

## Localization and visual review

| Native app / caption locale | Apple locale     | Creative output directory              |
| --------------------------- | ---------------- | -------------------------------------- |
| `en-US`                     | `en-US`          | `.boardsesh/app-store-creatives/<variant>/en-US` |
| `es`                        | `es-ES`, `es-MX` | `.boardsesh/app-store-creatives/<variant>/es`    |
| `fr`                        | `fr-FR`          | `.boardsesh/app-store-creatives/<variant>/fr`    |
| `de`                        | `de-DE`          | `.boardsesh/app-store-creatives/<variant>/de`    |

Repeat capture and render for every variant with the matching `--locale` and
source directory. Translated Search Results captions must sit over UI captured in that language;
the CLI's locale selects copy and does not translate the source pixels. Follow
the [Spanish](i18n-spanish-glossary.md), [French](i18n-french-glossary.md) and
[German](i18n-german-glossary.md) glossaries. Keep manufacturer names unchanged
and describe compatibility without implying endorsement.

1. Inspect contact sheets at phone size: readable headlines, distinct benefits and unobscured native board views.
2. Check full-resolution captures: loaded holds, the intended board, genuine queue and wall state.
3. Check translated UI and line breaks; verify that no text or focal board is clipped.
4. Inspect Header and Search Results in App Store Connect Preview for each locale and device.
5. Retain raw captures, source commit, build/fixture identity and manifests with the approved exports.

Use the target release's UI and preserve the spray photograph's consent record.
The Home Spray Wall and Black Pearl hold arrangement match the website video
references `marketing/showcase-video/reference/ios/spray.jpg` and
`marketing/showcase-video/reference/ios/boards-spray.jpg`; the fresh native
`14-spray-board-view.png` supplies the first portrait’s center panel, the second portrait’s spray shot
and the default variant’s placements. CPP placements use their separately recorded hero sources.
Existing showcase footage or website images are visual references, not proof
that a fresh release capture has passed review. Keep URLs, other marketplace
branding and donation messages out of the Apple compositions. Apple's
[asset guidance](https://developer.apple.com/app-store/asset-best-practices/)
explains the distinct screenshot and creative-placement requirements.

## Manual store review and release

Header and Search Results are organic App Store placements available on
iOS/iPadOS 27 and later. They are separate from screenshot slots; this export
does not establish eligibility for any paid placement.

1. Verify the target App Store version's current status; prior build or draft runs do not prove editability.
2. Upload the reviewed screenshot set with the existing screenshot lane, and listing text with the metadata lane.
3. Upload the two creative PNGs per locale to Asset Library and submit them for asset review.
4. Assign approved assets under the version's Header and Search Results tab; inspect Preview again.
5. Release the intended version, or explicitly publish approved creative replacements on the live version.

Asset Library accepts standalone asset submissions, and approved creative
replacements can update a live version without a new binary. Follow Apple's
[asset-management instructions](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-your-app-store-assets)
for the current submission and publishing controls. Neither `store:creatives`
nor the screenshot/metadata fastlane lanes publishes these placements.


## Localized search videos and Asset Library automation

Issue #6438 uses fresh iOS footage for every app locale (`en-US`, `es`, `fr`,
`de`) and every page variant (`default`, `kilter`, `tension`, `moonboard`,
`spray`). Spanish footage serves both `es-ES` and `es-MX`; no English footage is
substituted beneath translated captions. The search export is 1920 × 1280,
30 fps, H.264 High at level 5.0 or higher, with no audio. Default runs about
20 seconds; CPP cuts run about 15 seconds. Frame zero carries the first caption
fully set. Other scenes reuse the hero's word reveals and upright 2D spring
motion: phones enter before the scene boundary, then move out at its end.
Captions are readable by frame 10, and board piles arrive with a short stagger.
The background stays dark. The final 15 frames use the hero's phone rise and
word reveal to land exactly on the opening frame.
Each crew beat fits the complete phone inside the stage's vertical safe area,
so the real peer-added queue row and avatar remain visible. Its source interval
still starts before the row arrives, after the phone has settled. Review that motion in the composed video;
valid native anchors alone do not establish that the composition shows them.

```sh
vp run video:record -- --kind kilter --locales all --app-path <Boardsesh.app>
vp run video:render -- --target store-search --variant kilter --locale all
```

Repeat for every variant. See [recording prerequisites](showcase-video.md).
Keep each native locale's frames, marks and anchors together. Archive only these
three directories for Linux rendering; exclude raw logs, Metro caches, private
credential files and simulator app copies. Native source/frame hashes and the
source commit are retained by `search-results.manifest.json`.

Apple's 2026-10-07 OpenAPI lists `APP_STORE_SEARCH_RESULTS_ASSET`; the upload lane
still requires the live `GET /v1/appAssetLibraryRefData` response to advertise it
before any write. It also checks the selected placement group and spec IDs.

```sh
ASC_CREATIVES_OUTPUT=/tmp/creative-refdata.json vp exec bundle exec fastlane ios creatives action:refdata
vp exec ruby fastlane/prepare_creative_manifest.rb --refdata /tmp/creative-refdata.json
```

Run fastlane from `fastlane/`; the manifest command runs from the repository root.
If Apple advertises multiple groups, select the exact IDs from the report with
`--header-group` and `--search-group`. The finalizer requires all four locale
exports for each selected variant; it hashes the real files and their provenance
reports. Empty asset arrays in `app-stores/apple/creative-assets.json` mean capture
and review are pending, never a successfully published placement.

Retain the files in the GitHub release `app-store-creatives`. Asset names are
`<variant>-<placement>-<app-locale>-<sha12>.png|mp4`; the committed manifest carries
the complete SHA256 and the original export path. Retain each provenance report as
`<variant>-<placement>-<app-locale>-<provenanceSha12>.json` in the same release;
CI downloads and verifies these reports alongside the media. `fastlane/download_creative_assets.rb`
retrieves and verifies those files before CI runs the lane.

The **App Store Creative Assets** workflow is dispatch-only, runs from `main`,
and uses the Production environment. Its actions are `refdata`, `plan`, `upload`
and `place`, with `variant:all` or one page name. `upload` reserves, transfers and
commits assets without submitting review or requiring a version, CPP, or destination
localization. `place` attaches processed assets to an existing version or CPP
localization. Apple must move every selected asset beyond `UPLOAD_COMPLETE` and
`COMPLETE` to `PREPARE_FOR_SUBMISSION` or a later review state first. Until then,
the lane reports the pending state and makes no placement writes. Neither action creates a CPP, edits
screenshot slots, submits asset review, or publishes a version.

Planning or placing on live versions requires `allow_live:true`; standalone
uploads do not. When no editable iOS version exists, the lane selects the latest
published version by Apple's `createdDate`, refusing missing dates or ties.
An identical placement is reused.
Changing an owned placement requires explicit approval for its deletion and
recreation (`allow_replace:true`); foreign placements are refused. This guard
preserves the repository's no-deletion-without-approval rule.

Manual fallback: Asset Library → upload → the version's or CPP's **Header and
Search Results** tab → assign → Preview → submit for asset review. Inspect each
locale on iPhone portrait and iPad portrait and landscape before publishing.
The downloadable Apple Photoshop header template contains no numeric guides;
the proposed overlay zones remain assumptions until ASC Preview confirms them.

Roll out Kilter, spray, Tension, MoonBoard, then default, about 14 days apart.
Compare tap-through per ad group and conversion with untreated groups; roll back
a page if tap-through drops at least 10%. Confirm Apple Ads displays the intended
CPP creative before using paid tap-through as the metric; otherwise use organic
App Analytics per CPP. See [growth metrics](growth-metrics.md).
