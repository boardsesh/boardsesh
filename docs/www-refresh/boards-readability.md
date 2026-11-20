# Supported-board image gallery

`/boards` shows the eight supported catalog brands through their 17 real layout images, plus the existing spray-wall photo. Kilter and Tension sit beside one another on desktop, MoonBoard gets a full-width rail, and the remaining brands and spray wall use three columns. On phones each multi-layout rail fills the page width with about one and a half cards visible; single-layout cards use two columns.

The owner-approved heading is “Your board, on Boardsesh”, translated in all six shipping locales. Captions retain the details that distinguish a layout: Original, Homewall, Board 2 Mirror, Board 2 Spray, Masters 2017 and Mini 2025. Tension shows Board 2 Mirror and Spray before Original. MoonBoard runs newest first: 2025, 2024, 2020, 2019, 2017, 2016 and 2010. The section names its brand once.

The page keeps server-rendered headings, its descriptive lead, localized crawlable gym and spray-wall links, canonical/social/language metadata, app-store buttons and one global logbook-guide link. Route metadata reuses the existing translated “Supported boards” label, so browser and share titles name Boardsesh once while the visible heading retains the owner-approved wording. Image alternatives pair the compact caption with one brand name. Repeated lighting, controller and import paragraphs are removed. The homepage hero and About page are outside this change. The private board-request form remains a separate stacked change.

## Native artwork and physical sizes

The generator calls the existing `composeBoardBaseBuffer` pipeline against the same catalog/background layers used by native board rendering. It adds no climb overlay and creates no synthetic artwork. Woods uses its existing dark artwork; other brands keep their original layers. Each output is a 480px-wide WebP with its complete aspect ratio, displayed with `object-fit: contain` and declared intrinsic dimensions. The spray image is the existing 1752 × 2047 photo.

Each layout selects the largest physical catalog area: `(edgeRight - edgeLeft) × (edgeTop - edgeBottom)`. Equal areas prefer more supported hold sets, then stable catalog order. Default sizes and height-biased size ranks are deliberately not used. Independently checked selected size IDs are Kilter Original 28 and Homewall 25; Tension Original 1 and both Board 2 layouts 10; all seven MoonBoard layouts 1; Decoy 1; Touchstone 1; Grasshopper 4; So iLL 2; Woods 2. Homewall Full Ride 25 wins its equal-area tie with four hold sets versus three.

The manifest records layout and size names, physical extents, hold-set IDs, output dimensions/bytes/SHA-256 and each native source layer's path/SHA-256. Its 17 images total 1,578,542 bytes. The immutable static-asset catalog includes every new image so production CDN resolution uses its content hash too.

Regenerate artwork and production lookup entries with:

```sh
vp exec tsx packages/web/scripts/generate-board-gallery.ts
vp run generate:static-assets
vp run check:static-assets
```

Format the generated manifest and changed catalog JSON with `vp check --fix` before committing. Preserve obsolete generated artifacts in scratch while checking a new set; only manifest-referenced images ship in the gallery directory.

## Rails and useful actions

Overflowing rails expose 44 × 44px previous/next controls. The settled first and last positions disable their matching control. Native horizontal swipes and Arrow Left, Arrow Right, Home and End work without intercepting keys from nested links. After measurement, a list that fits has no extra tab stop or custom key handling. Before hydration its native-focusable markup preserves keyboard scrolling for overflow without JavaScript. Rails and markerless lists preserve explicit list semantics, visible keyboard focus and reduced-motion behavior. A 4px snap gutter keeps the first card and its focus ring inside the scroller.

## Gallery review gate

The gallery requires two independent Astra reviews of the published revision. The current rubric gives zero to two points each for image-led recognition/visual appeal, caption clarity, layout discovery, keyboard/touch use, and useful actions. The target is at least eight of ten, with a mandatory two of two for image-led recognition on both phone and desktop. Earlier text-only assessments do not score this gallery. No gallery design score is claimed here before those reviews.

## Verification

The matched comparison uses the rejected published text-row page from `4b4b34f191a1ebea1bf1f64868e0e6bc810ebd16` and the final gallery application source `4885d55177be3a1bbc6da9a46cf80c1e4338a30d`, on the same current-main chrome, local seeded database and 390 × 900 / 1440 × 900 Chromium viewports. The historical page and only its used website translation keys were temporarily overlaid after committing the candidate; all seven files were restored byte for byte in `finally`. React's development client manifest was warmed before the historical capture. Both phases hide only `nextjs-portal` and the development-only `[data-translation-editor]` controls. Ordinary captures blur the exercised rail; explicit focus captures remain separate.

| English main content | Rejected text rows | Image gallery |
| --- | ---: | ---: |
| Visible words | 147 | 116 |
| Height at 390px | 2,134px | 2,866px |
| Height at 1440px | 1,460px | 2,142px |
| Native catalog layout images | 0 | 17 |

The gallery gives more vertical space to recognizable boards. The earlier text-only design score does not measure this change.

All twelve gallery visits (six shipping locales at both widths) returned HTTP 200 without JavaScript page errors or document overflow. Each visit decoded all 17 catalog images and the spray photo, matched intrinsic and natural dimensions, verified `object-fit: contain`, and checked the localized compact alternatives. Actual browser, Open Graph and Twitter titles equal the locale's existing Supported boards label plus one Boardsesh suffix. All main actions and rail buttons meet the 44px target. Button, Arrow/Home/End, disabled-end, visible-focus, reduced-motion and CDP-driven native-touch checks passed; desktop Kilter leaves native key defaults intact when both cards fit. The existing first-visit Chinese translation dialog was acknowledged through its real Continue button and recorded in both Chinese receipts. Physical Safari and screen readers remain unverified.

The production lookup guard was red with missing immutable-catalog entries, then passed after canonical catalog generation. Deliberately regressing physical size/order caused 12 failures; a missing asset caused one; missing intrinsic image dimensions caused one; broken rail controls caused two. Independent review regressions for fitting-rail keyboard behavior, duplicated metadata brand and repeated image-alternative brand produced exactly three failures before the fixes. The restored gallery/catalog/terminology suite passes all 320 tests; normal commit hooks and the static-asset catalog checker pass.

- Phone: [rejected text rows](boards-gallery/before-en-US-phone.png), [gallery](boards-gallery/after-en-US-phone.png), [first screen](boards-gallery/after-phone-viewport.png), [keyboard focus](boards-gallery/after-phone-focus.png).
- Desktop: [rejected text rows](boards-gallery/before-en-US-desktop.png), [gallery](boards-gallery/after-en-US-desktop.png), [first screen](boards-gallery/after-desktop-viewport.png), [keyboard focus](boards-gallery/after-desktop-focus.png).
- All-six-locale gallery screenshots, [before receipts](boards-gallery/before-receipts.json), [after receipts](boards-gallery/after-receipts.json), and [application/artifact identity](boards-gallery/source-identity.json) are retained in the evidence directory. Earlier screenshots in `boards-readability/` remain historical.

