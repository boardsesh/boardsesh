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

The first four screenshots show Kilter/Tension/MoonBoard together, the shared
crew queue, a spray wall, and Woods/Decoy/Grasshopper. The fourth image also names
compatibility with Touchstone and So iLL. Wall status, the multiboard logbook,
workouts, Dynamic Island and climb search complete the story. See the
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

Use the original PNG directory for the matching device and locale:

```bash
vp run store:creatives -- --input <rawdevice> --output .boardsesh/app-store-creatives/en-US --device iphone-16-pro --locale en-US
```

For an English campaign capture, `<rawdevice>` is
`app-stores/apple/raw-screenshots/en-US/iphone-16-pro`.
The generator also accepts `--device iphone-16-pro-max` when the source captures
are from that device. It requires these unframed source images:

- `00-board-view.png`: Kilter.
- `01-board-view-2.png`: Tension.
- `10-moonboard-board-view.png`: MoonBoard.
- `14-spray-board-view.png`: the permitted Home Spray Wall, showing Black Pearl.

The output contains `header.png` at 3840 × 1646, `search-results.png` at
3840 × 2560, and `creative-assets.json`. Both PNGs are opaque. The manifest
records locale, capture device, source hashes and byte counts, plus output
dimensions and hashes. Retain it with the review artifacts; it is not an image
to upload to Apple. These dimensions follow Apple's
[creative asset specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications).

Header and Search Results give all four board captures equal, unobscured panels
with localized labels. The spray source is required; missing it fails export.
These compositions are independent of the three-board portrait opening. The output
directory must be separate from the inputs and outside
`app-stores/apple/screenshots/`, so the screenshot uploader cannot confuse a
creative placement with a device screenshot.

## Localization and visual review

| Native app / caption locale | Apple locale     | Creative output directory              |
| --------------------------- | ---------------- | -------------------------------------- |
| `en-US`                     | `en-US`          | `.boardsesh/app-store-creatives/en-US` |
| `es`                        | `es-ES`, `es-MX` | `.boardsesh/app-store-creatives/es`    |
| `fr`                        | `fr-FR`          | `.boardsesh/app-store-creatives/fr`    |
| `de`                        | `de-DE`          | `.boardsesh/app-store-creatives/de`    |

Repeat the render command with the matching `--locale`, source directory and
output directory. Translated captions must sit over UI captured in that language;
the CLI's locale selects copy and does not translate the source pixels. Follow
the [Spanish](i18n-spanish-glossary.md), [French](i18n-french-glossary.md) and
[German](i18n-german-glossary.md) glossaries. Keep manufacturer names unchanged
and describe compatibility without implying endorsement.

1. Inspect contact sheets at phone size: readable headlines, distinct benefits and clear board labels.
2. Check full-resolution captures: loaded holds, the intended board, genuine queue and wall state.
3. Check translated UI and line breaks; verify that no text or focal board is clipped.
4. Inspect Header and Search Results in App Store Connect Preview for each locale and device.
5. Retain raw captures, source commit, build/fixture identity and manifests with the approved exports.

Use the target release's UI and preserve the spray photograph's consent record.
The Home Spray Wall and Black Pearl hold arrangement match the website video
references `marketing/showcase-video/reference/ios/spray.jpg` and
`marketing/showcase-video/reference/ios/boards-spray.jpg`; the fresh native
`14-spray-board-view.png` supplies both the portrait spray shot and these placements.
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
