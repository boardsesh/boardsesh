# Spray walls

A spray wall is a climber's own wall: photographed, its holds detected and
corrected by hand, then set and logged on like any other board. The epic is
[#5346](https://github.com/boardsesh/boardsesh/issues/5346); this file grows with
each child PR. Today it covers the identity mapping, which
[SW-03 (#5436)](https://github.com/boardsesh/boardsesh/issues/5436) shipped as
types with no rows and no UI behind them, the tables
[SW-04 (#5437)](https://github.com/boardsesh/boardsesh/issues/5437) added
underneath it, and the API
[SW-05 (#5438)](https://github.com/boardsesh/boardsesh/issues/5438) put on top —
which is where the first real rows come from. There is still no UI: the add-a-wall
flow is SW-09 (#5442).

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

The gates are strict enough — 0.6 of a radius — that the feasible graph is very
sparse: a hold has one candidate, occasionally two. So the matcher prunes before
it solves. Rows and columns with no feasible pair at all go straight to `removed`
and `added`, and what remains is split into connected components of the feasible
graph and solved one component at a time. That is exact rather than an
approximation — no feasible pair crosses a component boundary, so no optimal
assignment can either — and it is what makes a **full** reset cheap: every pair
fails the gates, and handing the whole 1,500 x 1,500 matrix of nothing to the
solver took 14.7 s on the dev box against 86 ms pruned.

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
model.** On `1.jpg`'s first tile, 280 of 300 query boxes differ by more than
0.01 in normalised units; on `2008-08-05-evan-daniel-climbing-at-vertical-edge.jpg`
the whole-photo detection count moves from 44 to 49. Dynamic
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
  `createSprayWall` ALWAYS writes `has_leds = false` and never accepts the flag
  from a client (SW-05), and SW-09 must not show the "has LEDs" toggle on the
  add-a-wall flow. Deriving the suppression from the capability instead of the
  row is a follow-up; it touches the mobile BLE path, which needs its own review.
- **No crowd grade.** `crowdGrade: false`. The setter's grade is required on
  publish instead.
- **No mirroring.** `boardSupportsMirroring('spray', …)` is false: a wall is a
  photograph of one physical wall with no mirror geometry to reflect holds
  through.
- **No multi-frame climbs**, and `explicitClimbRules: false` so a spray climb
  reads like a Kilter one — only the departures from the default are printed.

## The API

Everything a wall needs is in `packages/shared-schema/src/schema/spray-walls.ts`
(SDL) and `packages/backend/src/graphql/resolvers/board/spray-walls.ts`
(resolvers), with the client documents in
`packages/shared/graphql/src/operations/spray-walls.ts`.

| Operation | What it does |
| --- | --- |
| `sprayWall(uuid)` | One wall by its `user_boards` uuid. |
| `sprayWallByLayout(layoutId)` | The same wall, for a client holding only a board config. |
| `sprayWallRenderData(uuid, version)` | The whole render payload in one round trip: the photo, the homography and the holds alive at that version. Omit `version` for the published one. |
| `mySprayWalls` | Every wall the caller owns, drafts included. |
| `createSprayWall(input)` | The `user_boards` row plus the three catalogue rows, all unlisted. |
| `createSprayWallVersion(input)` | Adopts an uploaded photo as a new DRAFT version and solves its homography. |
| `upsertSprayWallHolds(input)` | Adds or corrects holds on a draft. A hold with no `id` gets a new catalogue id; one with an `id` has its geometry rewritten. |
| `removeSprayWallHolds(input)` | Takes holds off as of a draft. |
| `publishSprayWallVersion(input)` | Makes a draft the generation climbers set against. |
| `deleteSprayWall(uuid)` | Soft delete. Catalogue rows and climbs stay. |

### What `createSprayWall` writes, and the two fields it never takes

One `user_boards` row with `board_type = 'spray'`, `layout_id = size_id` from ONE
`spray_wall_catalog_id_seq` value, `set_ids = '1'`, the angle the create flow
chose, and a slug from `generateUniqueSlug` — the same slug rule as `createBoard`.
Then `createSprayWallCatalogueRows` for the layout, the size and the join row.

Two columns are written by the resolver and are **not in the input schema at all**,
so a client cannot set them:

- **`has_leds` is always `false`.** There is no firmware to encode for, and BLE
  suppression today is this per-row data rather than the board type —
  `scanFamilyForBoard('spray')` still answers `'aurora'`, because every
  non-MoonBoard board falls through to it. A wall created with `has_leds = true`
  would offer a climber a Bluetooth scan for a wall with no controller.
- **`is_angle_adjustable` is always `false`.** Stats are keyed by angle and a
  spray wall does not adjust.

And one default is inverted from every other board type: **a wall is private
unless the input says otherwise**. A wall is somebody's home.

### Versions, anchors and the homography

`createSprayWallVersion` takes the `photoId` the upload handler returned and
adopts that object as a draft version. The photo's pixel dimensions come off the
STORED object's metadata, never off the request — they define the canonical frame,
and a client that lied about them would put every hold on the wall at the wrong
place.

Version 1 defines the frame: with anchors it is the anchor quad's bounding
rectangle, without them it is the photo's own pixel box. Later versions **inherit**
the frame, because every existing hold's coordinates are in it. There are no
user-entered wall dimensions anywhere (owner decision 2026-09-14: we just render
the photo).

Writing that frame is also what fills in the wall's **catalogue edge box**.
`createSprayWall` cannot: the frame comes from the photo, and there is no photo
yet, so the `board_product_sizes` row starts with `edge_right` / `edge_top` NULL
and `createSprayWallVersion` sets them to the frame in the same transaction that
decides it (`edge_left` / `edge_bottom` stay 0). Skipping that write leaves the
box NULL for the wall's whole life, and three readers fail differently:
`populateDenormalizedColumns` step 3 matches no size row at all so
`compatible_size_ids` never derives — silently — the climb-search edge filter has
nothing to compare against, and SW-07's render path gets a NULL box where every
other board type has numbers.

The geometry all lives in **`@boardsesh/spray-wall-geometry`** (SW-06, #5466) —
`homographyFromAnchors`, `isSolvableAnchorQuad`, `invert`, `mapPoint`, `mapRing`,
`mapRadius`. The backend imports it and owns no copy.

One contract to know before adding a backend caller: **`invert` THROWS on a
singular matrix** rather than returning the identity. Nothing on the server inverts
today — the stored matrix is the forward photo→canonical one and the client inverts
at draw time — so there is no call site to guard yet. When one appears, let the
throw surface as a clear error rather than catching it into the identity: a corrupt
stored homography that silently becomes the identity renders every hold at the
wrong place, which is far harder to notice than a failed request.

The homography is a 4-point DLT in pure TS
(`packages/backend/src/lib/spray-wall-homography.ts`), nine row-major floats, and
the identity matrix when a version has no anchors. A degenerate quad — anchors
collinear or coincident — also falls back to the identity: a worse map than a
correct one, and a far better outcome than a matrix of NaN that would render every
hold at nowhere. No image is ever warped in v1; the client maps holds through the
INVERSE at draw time. SW-06 (#5439) moves the module into
`@boardsesh/spray-wall-geometry` unchanged.

### Adding and removing holds

Holds are only editable on a **draft** version. Published and superseded versions
are immutable, because a climb set against a published generation reads its holds
by id — rewriting that generation's geometry would silently move every climb on it.

Removal splits two ways, and the split is what keeps history honest:

- a hold the **same draft added** is deleted outright, catalogue rows included: it
  was never on the real wall, the owner drew it and changed their mind;
- a hold installed by an **earlier** version is stamped `removed_version_id` and
  never deleted, because a climb set on it has to stay findable and
  `missing_hold_count` has to stay countable.

`movedFromHoldId` is lineage rather than geometry, and it is scoped against every
hold **this** wall has ever had — not the alive set, because a move's whole point
is that the predecessor has just come off. A pointer at another wall's hold, or at
nothing, would make remix suggest a successor for a hold that was never there.

### One open draft per wall

A wall carries **at most one draft at a time**. `createSprayWallVersion` refuses a
second and names the open one; the ways out are `publishSprayWallVersion` and
`discardSprayWallVersion`.

The reason is `spray_wall_holds.removed_version_id`: it is a single column, so two
drafts each marking the same inherited hold removed means the second write wins —
and publishing the FIRST then no longer removes the hold, so a climb that lost it
reads intact. Making removal a range per draft would be a schema change for a
workflow nobody asked for: a wall has one owner and a reset is one sitting.

**A discarded draft is DELETED, not marked.** There is no status that works.
`superseded` is the obvious candidate and is exactly wrong — `aliveHolds` treats
any non-draft version as having LANDED, so a discarded draft's additions would come
back as alive and its removals would take effect, which is the abandoned-draft bug
made permanent. A new `discarded` enum value would mean a migration for a state
nothing reads. Deleting leaves nothing to reason about, and is safe precisely
because a draft has never been published: no climb can reference its work. The
discard un-marks what the draft removed, drops the holds it added (catalogue rows
included), then deletes the version row.

### The version state machine

| From | To | How |
| --- | --- | --- |
| *(none)* | `draft` | `createSprayWallVersion` — refused while another draft is open |
| `draft` | `published` | `publishSprayWallVersion` — refused unless the version number is GREATER than the published one |
| `draft` | *(deleted)* | `discardSprayWallVersion` |
| `published` | `superseded` | a later version publishing |

Everything else is rejected: a published or superseded version cannot be edited
(`loadDraftVersion`), re-published or discarded, and a version cannot go backwards
to `draft`. The backwards-publish guard is unreachable while the one-draft rule
holds, and stays because it is the invariant rather than a consequence of that rule
— every hold read is bounded by the published version NUMBER, so moving
`current_version_id` backwards would silently revert the wall.

Every hold read names the generation it means. `aliveHolds(wallId)` with no
version is "alive at the wall's `current_version_id`" — the climber's view, which
does not include what an unpublished draft has drawn — so the backend always passes
a version number instead:

| Read | Version it asks for |
| --- | --- |
| `sprayWallRenderData` | the published one, or the one the caller named |
| `upsertSprayWallHolds` / `removeSprayWallHolds` | the **draft's own** number, so an editing session can correct a hold it drew a moment ago |
| `publishSprayWallVersion`'s hold count | the version being published, so another draft's additions never land in the number climbers see |
| `saveClimb` / `updateClimb` | the **published** one (see below) |

### Authorization

Two rules, and they are deliberately different:

| | Who |
| --- | --- |
| **View** a wall | The owner, a member of the gym it is attached to, or anybody at all when `is_public` or `is_unlisted` is set. |
| **Edit** a wall | `requireBoardEditAccess`, **unchanged** — the owner, a gym owner/admin for an attached wall, a community admin/leader on a public one. |

A gym **owner or admin may edit** a wall attached to their gym; a gym **`editor`
may not** — they can edit the gym's page and not a wall's holds. That is what
`requireBoardEditAccess` already said, and reusing it rather than writing a
wall-specific rule is what keeps the two from drifting (owner decision 2026-09-14:
ownership grants editing; no gym-editor extension).

"Not visible" and "does not exist" are the same answer everywhere a wall is read.
Telling a stranger that a uuid IS a wall they may not see is itself a leak. The
same goes for a wall that has been soft-deleted: `sprayWall` returns null and a
climb write against it reports "not found", never "deleted".

### Reading a wall's CLIMBS is a third rule, applied in ~15 places

A spray climb is an ordinary `board_climbs` row with `is_listed = true` — that is
what makes queue, play, ticks, stats, playlists and search work on a wall
unchanged — so **every predicate written for the eight catalogue boards reads a
spray climb as public**. Combined with layout ids that come out of a sequence
(1, 2, 3, …), any read taking `boardType + layoutId` from a caller was an
enumeration of every wall in the database.

The fix is one predicate, in two shapes:

| Shape | Where | Used by |
| --- | --- | --- |
| `sprayClimbVisibilityCondition(cols, userId)` (`packages/db/src/queries/climbs/spray-visibility.ts`) | in the WHERE | queries that span board types: `userClimbs`, the ascents feeds, the setter lists, comment-entity validation |
| `sprayLayoutIsReadable(boardType, layoutId, userId)` (`packages/backend/src/graphql/resolvers/climbs/spray-read-access.ts`) | before the query | queries already narrowed to one board + layout: `searchClimbs`, `similarClimbs`, `setterStats`, `newClimbFeed` and its subscription, `recentBetaLinks`, `climb(uuid)`, and the three `syncClimbs*` offline pulls |

A third shape joined them in #5469, for the readers that hold a **reference** to
a climb and never join `board_climbs` at all:

| Shape | Where | Used by |
| --- | --- | --- |
| `sprayReferenceVisibilityCondition({ boardType, climbUuid }, userId)` | in the WHERE, over the referencing table | the smart-playlist ref queries, `browseProposals`, `globalCommentFeed`, `userProfileStats` |
| `sprayClimbUuidIsReadable(climbUuid, userId)` | before the query | `comments`, `climbProposals` — the uuid-keyed threads |

It is phrased "there is **no INVISIBLE** spray climb behind this reference"
rather than "there is a visible climb", so a reference whose climb row has gone
survives; and because it starts from the reference, it works in a query that
never mentions `board_climbs` — `userProfileStats` shares one condition list
across three aggregates, one of which selects distinct climb uuids straight off
`boardsesh_ticks`.

Pick by what the query HAS, not by taste:

- it already knows one board type and one layout → **layout form**, and return an
  empty page;
- it joins `board_climbs` → **column form**, in the WHERE;
- it has a climb uuid and no join → **reference form**.

#### LEFT JOIN: ON, or WHERE

Several readers LEFT JOIN `board_climbs` onto a tick, and where the predicate
goes changes what the caller sees:

- in the **WHERE**, the whole row disappears. That is right when the row IS the
  climb — a search result, a playlist page, a logbook entry;
- in the **JOIN ON**, the row survives with null climb columns and renders as
  "Unknown Climb". That is right when the row is counted somewhere else and
  dropping it would short a page that a separate COUNT already sized —
  `fetchTickHighlightsByUuid` and `fetchHardestSendsBatch` are the two.

Either way the predicate must be `IS DISTINCT FROM 'spray'`, never `<>`: on a
LEFT JOIN with no match, `NULL <> 'spray'` is NULL, the row is dropped, and
`sessionDetail` — which returns null when it finds no ticks — loses the whole
session. And a reader with its own COUNT has to apply the same condition list to
the COUNT as to the page, or the total stands while the page shrinks.

#### The wall ROW is a fourth rule

`board(boardUuid)` and `boardBySlug(slug)` resolve a `user_boards` row without
ever going through `sprayWall*`, and they deliberately let any signed-in climber
open a private board by a direct link. For a photograph of somebody's living
room that is the wrong rule, so `sprayBoardRowIsReadable(row, viewer, lookupKey)`
applies the wall's own: `'capability'` for the uuid (an unlisted wall opens, like
`sprayWall(uuid)`), `'enumerable'` for the slug — which is derived from the
wall's NAME, so it is a guess, not a capability.

All four express the same **by-layout** rule — owner, gym member, or a public
wall — the one `viewerCanSeeSprayWallByLayout` applies, with no unlisted
exemption. The board-ROW shape is the only one with a second mode, and its
`'capability'` half is where the unlisted exemption lives, because a uuid earns
it and nothing else does. The row-level condition is shaped
`board_type <> 'spray' OR EXISTS (…)` so it is a no-op on every other board and a
caller cannot forget the branch.

Three details that are load-bearing:

- an unreadable wall yields an **empty result, never an error**, and never a
  different shape — otherwise the response is an oracle for which layout ids are
  private walls;
- `searchClimbs` also drops `spray` from `isCacheableBoard`, because the Redis key
  is the board config with no viewer in it, so one owner's page of their own wall
  would be served to the next caller who asked for that layout. `similarClimbs` and
  `recentBetaLinks` are gated BEFORE their caches for the same reason;
- `board_type <> 'spray'` short-circuits before the subquery, so the cost on the
  hot Kilter path is one comparison.

None of this is kept in step by hand.
`packages/backend/src/__tests__/spray-visibility-sweep.test.ts` generates the
reader list from the SDL — every `Query` and `Subscription` field whose arguments
name a climb uuid, a session id, a playlist id, a gym uuid, a user id, a board id
or a board + layout pair — seeds ONE private wall with a climb, a tick, a
favourite, a public playlist, a proposal, a beta link and a comment, and runs the
lot for an anonymous caller, a stranger and the owner. A new resolver is swept the
day it lands, and its author has to either make it reach the wall or name it in
that file's `NOT_APPLICABLE` with a reason.

### The server validates shape, and never re-runs detection

`packages/backend/src/validation/schemas/spray-walls.ts` checks the ring contract
(`isValidOutlineRing` from `@boardsesh/board-art-geometry/ring` — the same
implementation the outline editor uses, so a client can never draw a silhouette
its own validator accepts and the backend refuses), the caps, and that a named
hold id is alive on the version being edited. It never asks whether a hold "looks
like" a hold. Owner decision 2026-09-14: it is the owner's wall, and trash in is
their call.

## The hold editor

SW-08 (#5441) is not a second editor. It is the catalogue outline editor
(`packages/mobile/src/components/outline-editor/`) pointed at a wall through a
target adapter, because the stroke → ring chain that editor owns IS the
`@boardsesh/board-art-geometry` ring contract, and a second polygon editor would
be a second contract. The full split is in `docs/board-art-geometry.md`, "The
editor that writes them"; what belongs here is what it means for a wall.

`SprayHoldEditorScreen` is the entry point, and its props are the contract:
`wallUuid`, `layoutId`, the draft's `versionId` AND its `versionNumber`,
`viewerCanEdit`, and an optional `candidates` list. There is no route yet — SW-09
and SW-11 wire the entry points.

Both version fields are needed, and the reason is the one bug this screen could
not survive. The mutations take the `id`; `sprayWallRenderData(uuid, version)`
takes the `number`, and asked WITHOUT one it answers the **published**
generation. An editor seeded that way would show none of the work a previous
session already saved to the draft, would map holds drawn on the draft's
photograph through a homography solved for the published one, and could never
open at all on a wall whose version 1 is still a draft — which is the manual,
zero-detection first pass.

So `useSprayWallDraft` asks for the version by number and puts THAT payload in
the registry under the wall's layout id, through the loader's own
`registerRenderData`. Registering rather than holding it privately is the point:
`InteractiveFilterBoard` draws the wall through `getBoardRenderData`, which reads
the registry synchronously and has no way to be handed a payload — so with the
draft registered, the board under the editor is the draft's photograph. Every
cache key folds in the version (`sprayCacheToken`) and a draft's number is one
past the published one, so nothing the draft writes can be served back for the
published wall; on unmount `refreshSprayWall` pulls the published generation back
for whatever outlives the screen (`invalidateSprayWallRenderData`, which drops the
cached payload and re-registers through `refreshSprayWall`).

The editor re-seeds itself only for a real reason — a different wall, a new
version, a new detector run, or a save of its own. Not "the registry
re-registered the wall", which happens whenever a presigned photo signature
expires: re-seeding on that would throw away the holds somebody is halfway
through drawing.

"A save of its own" is the subtle half, and `spray-hold-seed.ts` states it:
**`invalidateQueries` is not the refetch.** A save that re-seeded the moment the
mutation resolved would re-read the payload from BEFORE the write — the holds it
had just added would vanish, the ones it had just deleted would come back, and
the ids it carried forward would be the superseded ones, so every later save in
that session would be refused for the whole batch. So a save ARMS a latch, and
the re-seed fires on the arrival of a payload that is not the one already seeded,
which is the only evidence the refetch actually happened. The mutation's own
`onSuccess` also RETURNS the invalidation rather than firing it and forgetting,
so React Query awaits the refetch before the caller's `onSuccess` runs.

What the editor does with a wall is decided by this document rather than by taste:

- **It edits THE draft.** One draft per wall, so there is no version to choose:
  the `versionId` handed in is the open one, and publishing or discarding are the
  two ways out (see "One open draft per wall").
- **Review controls only ever reach candidates.** Keep and Drop act on the
  selected holds whose review state is `pending`, never on the selection as a
  whole — a review control that reached a persisted hold would take it off the
  wall.
- **Provenance survives a round trip.** The render payload carries each stored
  hold's `source` and `confidence`, the registry carries them into photo space,
  and the seed reads them back; without that, an accepted detector hold is
  re-submitted as MANUAL the first time it is nudged, overwriting what the wall
  records about where its holds came from.
- **A candidate is drawn and never written.** Detector output arrives as
  `source: AUTO` holds with a confidence, and Save skips every one nobody has
  ruled on. A confidence slider hides the ones below its cut-off and "Keep all"
  takes the rest; a rejected candidate is simply deleted, because it never became
  a hold. Accepting is what marks it for the upsert — so a candidate cannot
  become a hold on somebody's wall as a side effect of saving something else.
- **A save clears the dirty flags of the holds it actually wrote**
  (`MARK_SAVED` takes the ids), rather than waiting for the refetch. Until they
  are clear, a second press of Save re-sends holds the server has already applied
  — and a correction re-sent names an id the resolver has just superseded, which
  fails the whole batch. Named rather than "everything", because a plan can
  SUCCEED while leaving holds out of it: one the homography sends off the wall,
  one drawn while the request was in flight. The screen says so, and clearing
  those too would let the next re-seed delete the work it had just promised was
  still there — so they stay dirty and ride over the re-seed
  (`holdsToCarryOver`).
- **The removal half reports separately** (`MARK_REMOVED`), the moment
  `removeSprayWallHolds` comes back and before the upsert runs. It also strips those
  ids from every snapshot in the undo stack: the removal has LANDED, and undoing
  past a merge whose upsert then failed would otherwise restore the victim as a
  clean live hold, so the next save would name an id the server has already
  stamped off. History is rewritten rather than cleared — losing an hour of
  corrections because one hold came off would be its own bug. The two calls are
  the two halves of one Save and the second can fail on its own — a rate limit, a
  dropped connection — and without that hop the editor would still be holding ids
  the server had already stamped off, so every retry for the rest of the session
  would be refused with "Hold N is not on this wall".
- **Removals are sent BEFORE upserts.** A merge takes two holds off and puts one
  back; the other order would leave the wall carrying both the merged hold and
  the one it swallowed if the session died between the two calls. Holds missing
  is a visible, fixable failure; duplicates nobody can tell apart is not.

Editing follows ownership (epic decision 2026-09-15): the gate is
`SprayWall.viewerCanEdit`, which is `requireBoardEditAccess` unchanged — no
gym-editor extension, and nothing wall-specific to drift from it.

## The mobile render path

Every catalogue board's background is a `.webp` inside the IPA/APK and every hold
position comes from generated constants. A wall has neither, so SW-07 (#5440) put
a **runtime registry** in front of the same draw path rather than a second one
beside it.

`packages/mobile/src/lib/spray/`:

| Module | What it does |
| --- | --- |
| `spray-wall-loader.ts` | The two round trips: `sprayWallByLayout` for the uuid (cached hard; a wall's uuid never moves), then `sprayWallRenderData` for the payload (10-minute stale time, bounded by the photo signature, not by how often a wall changes). Injected into the registry with `setSprayWallLoader`, so the draw path can ASK for a wall without being able to reach the network itself. |
| `use-spray-wall.ts` | `useSprayWall(layoutId)` — the active board's wall, called once from `drawer-host-provider`, and the hook a surface reads `isUnrenderable` off. |
| `use-spray-wall-token.ts` | `useSprayWallToken(boardName, layoutId)` — the one line a SYNCHRONOUS surface needs above its early return, because a component that gates on `getBoardRenderData() === null` returns before it mounts anything that subscribes. Requests the wall and subscribes to it in one call. Every synchronous board surface calls it — the play drawer, both board rows, the kiosk, the board-look preview, the reaction menu, the accessory thumbnail — and `spray-render-surfaces-subscribe.test.ts` fails a new one that does not. |
| `spray-hold-geometry.ts` | Canonical pixels -> this version's photo pixels, through `invert()` of the stored matrix. Centres via `mapPoint`, radii via `mapRadius`, silhouettes point by point via `mapRing` and back into radius units of the MAPPED radius. |
| `spray-wall-registry.ts` | The map every downstream reader consults synchronously, plus `sprayCacheToken`. Registering also publishes the wall's silhouettes as runtime board-art geometry. |
| `spray-photo-cache.ts` | The photograph on disk at `{cache}/spray-walls/<layoutId>-<version>.jpg`. The presigned URL is never the cache key — it changes on every read. |
| `spray-photo-keys.ts` | The names, with no imports, so the render path and the sweeper can use them without pulling `expo-file-system` in. |

Four things are worth stating plainly.

**No Rust change.** `HoldData.outline` already accepts a per-hold polygon in
radius units, so the wall's real hold shapes reach the renderer through
`@boardsesh/board-art-geometry`'s new `registerRuntimeGeometry(key, geometry)`,
consulted BEFORE the shards in `loader.ts`. The key is
`spray/<layoutId>-<layoutId>` — a wall's size id is its layout id — which is
exactly what `boardArtGeometryKey` already produces, so
`use-native-climb-render.ts` and the backend's `board-geometry.ts` needed no
branch at all. Aura draws true silhouettes, classic draws rings, and a hold with
no `spray_wall_holds.outline` falls back to a ring like any untraced placement.

**The version is in every cache key.** A reset writes new versions and a new hold
generation under an UNCHANGED `(layout_id, size_id)`, and encoding it in `sizeId`
was rejected (it would leak into `compatible_size_ids`, the offline key,
`board_sessions.board_path` and share URLs). So `sprayCacheToken(boardName,
layoutId)` — empty for every catalogue board, `-sv<version>` for a wall — is
folded into all ten: the render-data memo, the create-climb hold memo,
`buildCacheKey`, `buildBoardKey`, the board `configKey`, `boardHoldIdsCache`, the
playlist render-board target cache, `overlayRetainIdentity`,
`createClimbDraftKey` and `createClimbScreenKey`. Each one has a test that
registers version 1, takes the key, registers version 2 and asserts it moved;
drop the token from any of them and that test fails.

**The photo is protected while it is in use.** The sweeper reaps
`{cache}/spray-walls` on age (a fortnight), minus every wall this session has
registered — an mtime-only rule would happily delete the photograph underneath a
climber who is looking at it. A half-written `.part` is protected too, whatever
its age: Clear sweeps with `maxAgeMs: 0`, and deleting one mid-transfer would
`ENOENT` the `moveSync` that was about to finish it.

**A presigned URL is never retried once it has lapsed.** The signature is good
for fifteen minutes; the photo it points at is named `<layoutId>-<version>.jpg`
and outlives it. So `ensureSprayPhotoCached` checks `photoExpiresAt` before it
fetches, and a lapsed one calls `refreshSprayWall` — which invalidates the render
query rather than re-requesting a dead URL — and answers "no photo yet". Minting
a fresh signature is something only `sprayWallRenderData` can do. Retrying the
expired URL instead would 403 on every pass for the rest of the session while the
board sat on a placeholder.

**Known gap, for SW-08.** A fresh signature alone does not restart the download.
The background pass re-runs on the render hook's board key, and `sprayCacheToken`
carries the version — so a refresh that re-registers the SAME version leaves
every dep byte-identical and the photo is not re-fetched until the wall resets or
the surface remounts. Same for a download that simply failed. The fix is a
registration epoch subscribed as a background-effect-only dependency; it must not
reach `buildCacheKey`, or every overlay PNG is orphaned on each ten-minute
revalidation. Costs nothing before SW-09 makes a wall reachable.

## Photo privacy

Wall photos go to the **`private`** R2 bucket and are read through **15-minute
presigned URLs** (`presignGetObject` in `packages/backend/src/storage/s3.ts`).
`media` is world-readable under guessable keys (`docs/user-media-storage.md`), so
one wall photo there is a picture of the inside of someone's home on the open
internet. There is no URL safe to persist, which is why `SprayWallPhoto` carries
`expiresAt` and why every read mints a fresh signature.

`POST /api/spray-wall-photos`
(`packages/backend/src/handlers/spray-wall-photos.ts`) is cloned from
`createGymImageUploadHandler` and then narrowed three ways, all for the same
reason:

1. **No local-dev disk fallback.** The gym handlers write to `./gym-photos` and
   serve it from `/static/...` when S3 is off. Doing that here would put a home
   photo on an unauthenticated route, so with no `private` bucket configured this
   endpoint answers **501 in every environment** — the `user-data-export`
   precedent for the same bucket. Local spray-wall work needs `PRIVATE_*` set.
2. **Every byte is re-encoded.** `sharp().rotate()` bakes in the EXIF orientation
   and the re-encode drops the metadata block wholesale, GPS tags included — on a
   home wall, that is the owner's street address. A test uploads a tagged fixture
   and asserts the marker is nowhere in the stored bytes.
3. **A narrower allowlist and a single stored format.** JPEG, PNG and WebP in
   (no GIF — an animated spray wall is not a thing), always JPEG out. That makes
   the object key a pure function of the photo id
   (`spray-walls/<wallUuid>/<photoId>.jpg`), so `createSprayWallVersion` resolves
   it without probing candidate extensions and a cleanup sweep can enumerate a
   wall's objects by prefix.

Every stored object carries **`Cache-Control: private, no-store`**.
`uploadToS3` defaults to `public, max-age=31536000, immutable`, which is right for
an avatar and catastrophic here: a shared cache would keep serving the photo long
past the 15-minute presign that is supposed to BE the access control, and past the
owner making the wall private. The public-promotion copy SW-14 (#5447) writes to
`media` is the only place a long lifetime may ever be set.

The cap is 10MB, `files: 1`, the magic bytes decide the format regardless of the
declared Content-Type, and the caller must **own** the wall — not merely be able
to edit it. Nobody uploads a photograph of a stranger's living room.

There is also a **per-user budget of 20 uploads per 10 minutes**, answering `429`
with a `Retry-After: 600` once it is spent. It is the `feedback-screenshots.ts`
pattern and it is here for the same reason: every POST mints a NEW object, so one
authenticated account could otherwise fill the private bucket with 10MB objects,
and `MAX_VERSIONS_PER_WALL` does not help because it caps the ROWS rather than the
uploads that never become one. A rejected upload is charged too — it still costs a
multipart parse and a sharp decode, which is exactly what a spammer would loop on
— and the check runs before both. The window is per process, so the real ceiling
is 20 × the instance count and it resets on deploy; that is accepted rather than
reaching for Redis, because the budget only has to make scripted abuse tedious.
`applyRateLimit`, the two-tier limiter the resolvers use, is not reachable from a
REST handler — it keys off the GraphQL connection context.

An uploaded photo sits in the bucket unreferenced until `createSprayWallVersion`
adopts it, so an abandoned upload is a stray object for the SW-17 (#5450) cleanup
job rather than a row anyone can see.

## Climb writes on a wall

SW-03's blanket `assertClimbWriteBoardIsNotSpray` gate is gone. What replaced it
is `packages/backend/src/graphql/resolvers/climbs/spray-authoring.ts`, and the
four rules there are what the gate was standing in for:

1. **The wall has to exist and the caller has to have a claim on it.** A
   `layoutId` alone is not authorization — layout ids come out of a sequence. The
   rule is `viewerCanWriteSprayClimbs`, and it is VIEW-shaped rather than
   EDIT-shaped: setting a climb on a gym's spray wall is what a gym member is
   there to do, and only the wall's *holds* are the owner's alone.

   | Caller | Private wall | Unlisted wall | Public wall |
   | --- | --- | --- | --- |
   | Owner, or a member of the wall's gym | ✅ | ✅ | ✅ |
   | Anyone else, with `sprayWallUuid` | ❌ | ✅ | ✅ |
   | Anyone else, without it | ❌ | ❌ | ✅ |

   **`SaveClimbInput.sprayWallUuid` (and the same field on `UpdateClimbInput`) is
   the share-link capability**, and it is the crew case the epic wants: somebody
   photographs their home wall, sends the link, and the crew set climbs on it. Two
   things make it safe to be a capability. It must be **this** wall's uuid, matched
   against the row the request's `layoutId` resolved to — without that pairing one
   leaked uuid would authorize writes to every wall in the sequence. And it only
   unlocks an **unlisted** wall: a private wall refuses everyone but its
   principals, because its owner has not handed a link to anybody. A mismatch comes
   back as the same "not found" an unknown wall gets, so it is not an oracle for
   which layout ids are unlisted walls.

   **SW-10's client must send `sprayWallUuid` on every spray climb write.** It is
   ignored when the caller is already a principal, so there is no branch to get
   wrong — send it unconditionally. An edit needs it too: `updateClimb` resolves
   the wall from the stored climb's `layoutId`, which is no more a secret than the
   one on the create.
2. **A setter grade is required to publish.** `getBoardCapabilities('spray')`
   answers `crowdGrade: false` — a home wall has a handful of climbers, so nothing
   converges on a consensus grade and a published climb with no grade would stay
   ungraded forever. `userGrade` is on `SaveClimbInput` for this, mirroring
   `SaveMoonBoardClimbInput`, and it seeds
   `board_climb_stats.display_difficulty`. A graded DRAFT gets the stats row too,
   because `updateClimb`'s publish-time seed has no grade source to reconstruct
   from — and `updateClimb` refuses to publish a spray draft whose stats row has
   no grade, so draft → publish is not a way around rule 2.
3. **Every hold has to be alive on the PUBLISHED version**, checked inside the
   write transaction so a reset committing mid-write cannot let a climb through on
   a hold that just came off. `updateClimb` runs the same check on every spray
   edit. Deliberately the published set rather than "every row whose
   `removed_version_id` is NULL": that would also count holds an unpublished draft
   has drawn, so an owner mid-reset could publish a climb on holds nobody has put
   on the wall yet. A wall with nothing published therefore takes no climbs at
   all — the honest outcome for a wall the owner has not finished setting up.
4. **One frame.** `multiFrameClimbs: false`, and nothing downstream enforces it:
   `frames_count` takes whatever it is given. The sharper reason is the duplicate
   gate, which only fires for a single frame — so a multi-frame spray climb would
   bypass the per-wall duplicate check entirely. Both the count and the frames
   string are checked, because a client can send `framesCount: 1` with two frames
   in the string and the string is what the renderer reads.
5. **The denormalised columns are authoritative at write time**:
   `compatible_size_ids = [layoutId]`, `required_set_ids = [1]`,
   `missing_hold_count = 0`, and `hold_fingerprint` written here because a wall
   has no Aurora sync to come back and fill it in.

Rule 4 has one subtlety worth knowing before you touch it.
`populateDenormalizedColumns` still runs for spray — its edge columns are worth
having, and search's size filter reads them — but its step 3 derives
`compatible_size_ids` by joining EVERY `board_product_sizes` row of the board type
whose edge box contains the climb's, **with no layout scoping**. On spray every
wall's size row IS an edge box, so left alone the column would come out naming
other walls' sizes as well as its own.

### Turning a wall private has to RETRACT, not just stop

Two things outlive a visibility change and both are handled in the same transaction
as the flip:

- **`feed_items`** is a materialised fan-out served with no second look at the wall,
  so rows written while it was public sit in each follower's feed. Without
  retracting them, "private" would mean "private to people who were not following
  you at the time". `updateSprayWall` purges them on the public → private
  transition and `deleteSprayWall` purges them outright — both event shapes, since
  `climb.created` files under `entity_type = 'climb'` and `ascent.logged` under
  `'tick'`. Becoming merely UNLISTED does **not** purge: an unlisted wall is still
  shared.
- **Persisted references** — a favourite, a playlist entry — keep resolving to the
  climb. Those readers carry the visibility predicate, on the COUNT as well as the
  page, or a count promises rows the page then withholds.

That is **defence in depth, not a live leak**: every consumer of
`compatible_size_ids` also filters `layout_id`, so no climb actually surfaces on
the wrong wall today. The column would simply be wrong, and the bug would be a
future reader that trusted it on its own. Both resolvers re-assert the two columns
immediately after the helper runs, and a test pins the value on a two-wall
database.

And the feed: **`climb.created` is published for PUBLIC walls only** (owner
decision 2026-09-14: private-wall ticks are the owner's logbook). A feed event
carries the climb's name and its wall's layout id to every follower, so firing one
for a private wall would announce the existence of somebody's home wall to people
who cannot open it.

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

   **Every per-wall catalogue row is seeded `is_listed = false`** on
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
