# Supported-board image gallery

`/boards` shows the eight supported catalog brands through their 17 real layout images, plus the existing spray-wall photo. Kilter and Tension sit beside one another on desktop, MoonBoard gets a full-width rail, and the remaining brands and spray wall use three columns. On phones each multi-layout rail fills the page width with about one and a half cards visible; single-layout cards use two columns.

The owner-approved heading is “Your board, on Boardsesh”, translated in all six shipping locales. Captions retain the details that distinguish a layout: Original, Homewall, Board 2 Mirror, Board 2 Spray, Masters 2017 and Mini 2025. Tension shows Board 2 Mirror and Spray before Original. MoonBoard runs newest first: 2025, 2024, 2020, 2019, 2017, 2016 and 2010. The section names its brand once.

The page keeps server-rendered headings, its descriptive lead, localized crawlable gym and spray-wall links, canonical/social/language metadata, app-store buttons and one global logbook-guide link. Repeated lighting, controller and import paragraphs are removed. The homepage hero and About page are outside this change. The private board-request form remains a separate stacked change.

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

Overflowing rails expose 44 × 44px previous/next controls. The settled first and last positions disable their matching control. Native horizontal swipes and Arrow Left, Arrow Right, Home and End work without intercepting keys from nested links. Rails and markerless lists preserve explicit list semantics, visible keyboard focus and reduced-motion behavior. A 4px snap gutter keeps the first card and its focus ring inside the scroller.

## Gallery review gate

The gallery requires two independent Astra reviews of the published revision. The current rubric gives zero to two points each for image-led recognition/visual appeal, caption clarity, layout discovery, keyboard/touch use, and useful actions. The target is at least eight of ten, with a mandatory two of two for image-led recognition on both phone and desktop. Earlier text-only assessments do not score this gallery. No gallery design score is claimed here before those reviews.

## Verification

Final browser receipts and exact source identities are added after the matched capture run. The earlier text-only screenshots remain historical evidence and do not establish gallery quality or behavior.
