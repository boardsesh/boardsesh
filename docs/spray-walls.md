# Spray walls

A spray wall is a climber's own wall: photographed, its holds detected and
corrected by hand, then set and logged on like any other board. The epic is
[#5346](https://github.com/boardsesh/boardsesh/issues/5346); this file grows with
each child PR. Today it covers the identity mapping, which
[SW-03 (#5436)](https://github.com/boardsesh/boardsesh/issues/5436) shipped as
types with no rows and no UI behind them, and the tables
[SW-04 (#5437)](https://github.com/boardsesh/boardsesh/issues/5437) added
underneath it.

## Identity mapping

Every partition in Boardsesh is `(board_type, layout_id)` — the search base
condition, the fingerprint index, playlists, the snapshot key, the offline key.
So a spray wall is not a new kind of thing: it is a **runtime-created catalogue
layout under a ninth board type**, and queue, play, ticks, stats, playlists,
feed, comments, search and the duplicate gate work on it unchanged.

| Piece | Value | Why |
| --- | --- | --- |
| `board_type` | the text `spray` | The ninth `BoardName`, in `SUPPORTED_BOARDS` (`packages/shared-schema/src/types/board-config.ts`). |
| Product | id `1`, one row for every wall | `board_products` groups sizes under a manufacturer's board model. Spray walls have no models. |
| Hold set | id `1`, named "Holds", one row for every wall | A wall's holds do not ship in sets a climber installs or removes, so there is nothing for set ids to partition. One synthetic set, the way Woods ships one. |
| Hold roles | `1` STARTING, `2` HAND, `3` FINISH, `4` FOOT | Tension-style codes. `HOLD_STATE_MAP.spray` / `STATE_TO_PRIMARY_CODE.spray` in `packages/board-constants/src/hold-states.ts`. Nothing goes on a wire — there are no LEDs — so these are display and frames codes only. |
| Layout | one `board_layouts` row **per wall**, created at runtime | The wall is the layout. |
| Size | one `board_product_sizes` row per wall, **with the same id as its layout** | A wall has exactly one size: itself. A second id space would hold the same number twice. `spraySizeIdForLayout` writes the equality once. |
| Holds | one `board_holes` row and one `board_placements` row per hold, **sharing an id** from a spray-only sequence | Climb frames reference placement ids (`p<id>r<code>`), and a wall hold has no separate hole to mount into, so the two ids are the same number. |
| Angle | fixed per wall, chosen at creation | Stats are keyed by angle and a spray wall does not adjust. `SPRAY_ANGLES` is the list the create flow offers once. |

The constants live in `packages/shared/board-config/src/spray-config.ts`
(`SPRAY_PRODUCT_ID`, `SPRAY_SET`, `SPRAY_ROLE`, `SPRAY_ANGLES`, the caps, and
`SPRAY_DISPLAY_NAME`). The rows themselves land in SW-04 (#5437).

### What the version is not

A reset writes new `spray_wall_versions` and `spray_wall_holds` rows. It never
writes a new layout or a new size. So every climb ever set on the wall keeps
pointing at the same `(board_type, layout_id)` partition and stays findable, and
the mobile render registry folds the version into its cache keys instead of into
`sizeId`.

## The tables

Four side tables in `packages/db/src/schema/app/spray-walls.ts`, plus one column
and two sequences.

| Table | Key | What it holds |
| --- | --- | --- |
| `spray_walls` | `id`, with `board_uuid` and `layout_id` both unique | One wall. Its canonical frame (`reference_width` / `reference_height`), its published version, its hold count, and a soft delete. Owner, name, angle and visibility stay on the `user_boards` row it points at. |
| `spray_wall_versions` | `id`, unique `(wall_id, version_number)` | One photograph: its key in the private bucket, its pixel size, its four anchors, the photo→canonical homography, and `draft` / `published` / `superseded`. |
| `spray_wall_holds` | `(wall_id, hold_id)` | One hold across its whole life: centre, radius and silhouette in the canonical frame, the version that installed it, the version that removed it (NULL = still on the wall), and where it moved from. |
| `spray_climb_lineage` | `child_uuid` | A remix and the climb it came from, plus the wall version it was rebuilt on. |

What a climber sees is the wall at `spray_walls.current_version_id`, not "every
hold whose `removed_version_id` is NULL": while a reset is still a draft, its
added holds already have rows and its removals are only removals AT the draft, so
the NULL test would leak an unpublished layout the moment the owner started
editing. `aliveHolds(wallId)` resolves the published version; `aliveHolds(wallId,
n)` reads the wall as it stood at version `n`, which is how a climb set two
resets ago renders on the photo it was set against.

`board_climbs.missing_hold_count` is the materialised integrity number: how many
of a climb's holds have come off the wall. NULL on every other board type.
`spray_wall_catalog_id_seq` hands out wall ids (one value is BOTH the layout id
and the size id) and `spray_hold_catalog_id_seq` hands out hold ids (one value is
BOTH the hole id and the placement id).

### Why a side table, not columns on `board_placements`

The catalogue rows are immutable identity. A climb's frames string
(`p<placementId>r<code>`) points at a placement id forever, and every climb ever
set on the wall keeps pointing at the same `(board_type, layout_id)` partition.
Wall state is the opposite — it changes on every reset:

- a hold's lifecycle (installed in version 2, taken off in version 5) is a
  **range**, and a placement row has exactly one present tense;
- each version carries its own anchors and homography, so the same hold sits at a
  different place in every version's photo;
- a silhouette is primary data versioned with the wall, not an admin override of
  a tracer — which is what `hold_outline_overrides` is, and why it is not reused.

Putting those on `board_placements` would make every other board carry nullable
spray columns, and would force a reset to rewrite catalogue rows that climb
frames depend on. Keying side tables by the same ids — the
`board_hold_features` / `hold_outline_overrides` precedent — keeps the catalogue
frozen and the wall's history append-only. A reset therefore stamps a removal and
appends rows; it never updates geometry in place and never deletes. **A moved
hold is removed + added** — the review can link `moved_from_hold_id` so remix
suggests the successor — rather than an update of the row that moved.

### Every per-wall catalogue row is `is_listed = false`

`createSprayWallCatalogueRows` (`packages/db/src/queries/spray-walls/`) writes the
`board_layouts`, `board_product_sizes` and `board_product_sizes_layouts_sets` rows
for a wall, and all three are unlisted. **That is the primary privacy defence,
not a cosmetic flag.** `getPopularConfigs` and the sitemap shards also drop
`spray` by name (#5453), but those are backstops: any other reader of the
catalogue tables has only `is_listed` to go on, so a wall seeded listed would put
a climber's home wall on the www homepage rail. A test on the helper asserts it.

## Canonical coordinates and matching

Two photographs of one wall have to agree on where a hold is, or a reset cannot
tell a hold that came off from a hold the climber simply stood further left to
photograph. That agreement is the **canonical frame**, and
[SW-06 (#5439)](https://github.com/boardsesh/boardsesh/issues/5439) is the pure
TypeScript that produces it: `@boardsesh/spray-wall-geometry` for the frame and
the matcher, `@boardsesh/hold-detection` for turning a model's tensors into
circles in the first place.

### The frame

The canonical frame is **version 1's anchor quad mapped onto a rectangle**. The
four anchors are the wall's corners as tapped in that photo, in TL/TR/BR/BL
order; `homographyFromAnchors` solves the 4-point DLT that takes them to
`(0, 0)-(width, height)`, and `boundingSize` derives that rectangle from the quad
itself. There are no wall dimensions anywhere: the owner decided on 2026-09-14
that the frame is the photo.

Three consequences worth stating plainly.

- **No image is ever warped.** The matrix is stored on the version; the renderer
  maps holds through `invert()` at draw time and paints them over the untouched
  photo. Warping would cost a re-encode per version and lose pixels at the edges
  for no gain.
- **A version without anchors stores the identity**, which is the honest answer
  for a wall whose photo *is* its frame. Anchors are optional at creation and
  required at the first reset, because that is the first moment two photographs
  have to be compared.
- **A degenerate quad is refused at the door**, not papered over.
  `isSolvableAnchorQuad` wants a bounding box at least 8 px on a side and an
  enclosed area of at least 2% of that box. Version 1's anchors define the frame
  *forever*, so four taps in a line would pin an unusable coordinate space on the
  wall for the rest of its life. Where a quad slips through anyway — a matrix
  that turns out singular — the solver returns the identity rather than a matrix
  of NaN, because a wrong map still renders and NaN renders nothing.

A hold's radius is mapped with `mapRadius`, which takes `sqrt(|det J|)` of the
local Jacobian: the scale that preserves the hold's **area**. A circle under a
projective map is an ellipse, so there is no single right radius; taking one axis
would make every hold on the compressed far side of an off-axis photo visibly
wrong in the other direction.

### The gates

`matchHolds(previousAlive, detections)` compares the last published version's
alive holds with what the new photo produced — both already in canonical
coordinates. A pair has to clear **both** gates before it is a candidate at all:

| Gate | Value | Why |
| --- | --- | --- |
| Centroid distance | `< 0.6 x` the pair's mean radius | Well inside the hold. Two neighbouring bolts on even a dense spray wall sit further apart than that, so a hold can never be matched to its neighbour. |
| Circle IoU | `> 0.3` | Catches the same-centre, wrong-size case the distance gate waves through: a detector that boxed a whole volume where a crimp used to be. |

What survives is scored `0.5 x (distance / mean r) + 0.3 x (1 - IoU) + 0.2 x
colour distance`, and a **Hungarian assignment** minimises the total. Not greedy
nearest-neighbour: on a row of identical holds with one missing, greedy pairs
each old hold with the nearest new one, cascades the error down the row and
reports the *last* hold as removed instead of the one that actually went.

The colour term is optional. `@boardsesh/hold-detection`'s `describeColour`
produces the descriptor — mean Lab plus an eight-bin saturation-weighted hue
histogram — and when either side lacks one the term is dropped and the remaining
weights are renormalised, so the gates and the ambiguity ratio keep meaning the
same thing on a wall captured without colour.

The result is four sets: `kept` (with a confidence), `removed`, `added`, and
`lowConfidence` — a kept hold that had a second detection inside its gates and
nearly as cheap, which is exactly what a reviewer should be shown.

### Why a moved hold is removed + added

Climbs reference **positions**. A hold unbolted and re-bolted 40 cm along is not
the hold those climbs used any more: every climb through it now asks the climber
to reach somewhere the wall has nothing. Calling it "the same hold, moved" would
silently rewrite each of those climbs into a different problem while keeping its
grade, its ticks and its comments attached to the new shape.

So the matcher reports one removal and one addition, the affected climbs get a
`missing_hold_count` and a badge, and `suggestMoves()` separately offers the
pairing — nearest added detection within 3 radii — as a `movedFromHoldId` hint
for the review UI, so a remix can start from the successor. The suggestion
changes nothing about what was matched.

### Detection post-processing, and why one full-frame pass

`@boardsesh/hold-detection` is the platform-free half of on-device detection:
tile planning, preprocessing into the model's input tensor, decoding RF-DETR's
two output tensors, merging what several tiles saw, and handing back circles. The
inference runtime and the image decoder are injected, so the same code runs in
the Expo app, in a browser worker and under Node.

The default is **one full-frame pass**, not the 2x2 tiling the SW-01 harness
config uses. SW-01 measured tiling making the small model 4.9 F1 points *worse*
on real wall photos (`ml/holds/README.md`): photos around 800 px on the long side
cut into ~330 px tiles that are then upscaled, so every hold gets bigger and the
surrounding wall — the thing that says "hold" rather than "smudge" — leaves the
frame. Tiling stays available for the case it was meant for, a very large photo
of a dense wall.

Two things the package deliberately does not do:

- **No outlines.** The model returns boxes, not masks, and the classical in-box
  segmentation in `ml/holds/eval.py` stops at a boolean mask — there is no
  contour tracer or simplifier on the Python side to port, and no corpus with
  mask ground truth to score an invented one against. So a candidate carries
  `{ cx, cy, r }` and the renderer falls back to a ring, exactly as it already
  does for a catalogue hold with no traced art. `HoldCandidate.outline` exists
  for the ring SW-08's editor writes when a climber re-traces a hold by hand.
- **No seam-distance preference in NMS.** The higher-scoring box wins, as in the
  Python. Preferring the detection further from a tile edge was floated in #5439,
  but nothing in the fixtures could tell a better rule from a worse one.

The post-processing is pinned against the Python by
`packages/shared/hold-detection/src/__tests__/parity.test.ts`, which replays the
model's recorded output tensors and compares with
`ml/holds/fixtures/expected-detections.json`. The model itself is not in the repo
— the int8 export is 28.7 MB against a 15 MB ceiling — so the oracle is those
recorded tensors, regenerated by
`packages/shared/hold-detection/scripts/capture-fixture-outputs.py`.

One thing that capture found, which SW-02 should expect on device:
**`onnxruntime-node` and the Python `onnxruntime` do not agree on this int8
model.** On one fixture tile, 280 of 300 boxes differ by more than 0.01 in
normalised units and the photo's detection count moves from 44 to 49. Dynamic
int8 quantisation puts a build-specific QGemm kernel in the hot path. The app's
runtime will not reproduce the harness's numbers hold for hold either, which is
one more reason the score threshold is a slider rather than a shipped constant.

## Caps

| Cap | Value | Why |
| --- | --- | --- |
| `MAX_SPRAY_WALLS_PER_USER` | 10 | Each wall costs a private-bucket photo per version plus a catalogue layout row. Well past what a home climber or a gym needs, low enough that a scripted account cannot fill the bucket. |
| `MAX_HOLDS_PER_WALL` | 1500 | A dense commercial spray wall runs 400–800 holds. The cap bounds what a detector run, a hold-editor session and a reset match hold in memory at once. |
| `MAX_VERSIONS_PER_WALL` | 50 | A wall reset monthly for four years stays inside it. Every version keeps its own photo and its own hold generation. |

## What spray deliberately does not do

`getBoardCapabilities('spray')` answers `climbCreation: true` and everything else
false — that is the whole board, and it is one row in
`packages/shared/board-config/src/board-capabilities.ts`.

- **No LEDs and no native control.** `nativeBoardControl: false`. There is no
  firmware to encode for and no packet to send; a wall is created with
  `has_leds = false` on its `user_boards` row, so the LED-less play path (#4585)
  is the one it takes. **BLE suppression today is that per-row `has_leds` data,
  not the board type** — `scanFamilyForBoard('spray')` would still answer
  `'aurora'`, because every non-MoonBoard board falls through to it. So
  `createSprayWall` (SW-05) must ALWAYS write `has_leds = false` and never accept
  the flag from a client, and SW-09 must not show the "has LEDs" toggle on the
  add-a-wall flow. Deriving the suppression from the capability instead of the
  row is a follow-up; it touches the mobile BLE path, which needs its own review.
- **No crowd grade.** `crowdGrade: false`. The setter's grade is required on
  publish instead.
- **No mirroring.** `boardSupportsMirroring('spray', …)` is false: a wall is a
  photograph of one physical wall with no mirror geometry to reflect holds
  through.
- **No multi-frame climbs**, and `explicitClimbRules: false` so a spray climb
  reads like a Kilter one — only the departures from the default are printed.

## Climb writes are closed until SW-05

`saveClimb` and `updateClimb` reject `boardType: "spray"`
(`assertClimbWriteBoardIsNotSpray`). `BoardNameSchema` accepts the value the
moment SW-03 lands, and nothing downstream stops it —
`populateDenormalizedColumns` matches zero `board_placements` rows for a spray
layout and returns rather than throwing — so without the gate any authenticated
caller could publish listed `board_climbs` rows into the spray partition at a
`layoutId` of their choosing, and SW-04's per-wall layout sequence would later
hand those ids to real walls. SW-05 (#5438) removes the gate together with wall
ownership, the setter grade and the per-wall duplicate check.

## Where spray is excluded

Five exclusions matter, and all five are about a wall being someone's private
property rather than a catalogue:

1. **Board pickers.** `SUPPORTED_BOARDS` in
   `packages/shared/board-config/src/board-data.ts` — the display-filter list,
   not the schema's — drops `spray` outright. No generic picker, board builder or
   wall finder offers it; a wall is created through the add-a-wall flow (SW-09)
   and reached at its own `/b/{slug}`.
2. **The popular-config rail.** `getPopularConfigs`
   (`packages/backend/src/graphql/resolvers/social/boards.ts`) feeds the www
   homepage board rail and the mobile Boards tab, and neither consults the
   display list — so the exclusion is at the source, twice: the SQL drops
   `board_type = 'spray'` before the expensive per-config LATERAL climb count is
   built, and `isPopularConfigRow` drops it again on the way out.

   **SW-04 must seed spray catalogue rows with `is_listed = false`** on
   `board_layouts`, `board_product_sizes` AND
   `board_product_sizes_layouts_sets`. That is the primary defence — the two
   filters above exist so one mis-seeded row cannot put a climber's wall on the
   homepage.
3. **Gym directory facets.** `CATALOGUE_BOARD_TYPES`
   (`packages/board-constants/src/board-type-labels.ts`) is every key of
   `BOARD_TYPE_LABELS` except `spray`, and it is what `FILTERABLE_BOARD_TYPES`
   and the gym card's `BOARD_TYPE_ORDER` derive from. Spray keeps its *label* —
   a wall still has to be named on its own screens — but is never a facet, a
   `?boardType=` value or a gym chip.
4. **Public snapshots.** `discoverLayoutPairs` in
   `packages/backend/src/scripts/export-board-snapshots.ts` skips `spray`. The
   nightly snapshots go to a public bucket under guessable keys; a spray
   partition is one climber's wall.
5. **Sitemaps.** `isIndexableBoardType` in
   `packages/web/app/lib/seo/sitemap/indexable-boards.ts` keeps `spray` out of
   both the boards and the climbs shards. Per-wall visibility governs who may
   open a wall in the app; it is not consent to be crawled. SW-16 (#5449) decides
   whether public walls get an indexing story of their own.

www has no spray surface at all today: `boardHasDeepConfigRoute` in
`packages/web/app/lib/board-route-paths.ts` 404s `/spray/...`, and
`resolveReadableBoardSegments` emits only numeric paths for spray, because a
wall has no layout, size or set NAMES to slug.
