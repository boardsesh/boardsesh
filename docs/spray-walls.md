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
which is where the first real rows come from, and the add-a-wall flow
[SW-09 (#5442)](https://github.com/boardsesh/boardsesh/issues/5442) built on the
front of all of it — the route a climber actually walks (see "Adding a wall"
below). [SW-17 (#5450)](https://github.com/boardsesh/boardsesh/issues/5450) adds
the ops half: reporting a wall, hiding one, what happens to a deleted wall's
photographs, the telemetry, and the flag rollout.

**Sharing lands separately.**
[SW-14 (#5447)](https://github.com/boardsesh/boardsesh/issues/5447) is in flight
on the other stack and owns the visibility switch: private / unlisted with a link
/ public, the QR share sheet, the gym attachment, and — on the storage side —
copying a published photo out of the `private` bucket into world-readable `media`
under a random key when a wall goes public, deleting it again when it goes back.
Everything this file says about the hidden flag and the photo purge already
accounts for that copy: hiding outranks the share link, and the purge sweeps the
`media` prefix as well as the private one.

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

The colour term is optional, and **on a reset today it never runs**. The matcher
compares colours only when BOTH sides carry a descriptor of the same length, and
the holds already on the wall carry none: `spray_wall_holds` has nowhere to put
one. So `proposeSprayWallReset` accepts a `colour` on each detection and decides
on geometry alone regardless. The machinery is real — `@boardsesh/hold-detection`'s
`describeColour` produces the descriptor (mean Lab plus an eight-bin
saturation-weighted hue histogram), and when either side lacks one the term is
dropped and the remaining weights are renormalised so the gates and the ambiguity
ratio keep meaning the same thing — it is the stored half that is missing.
**SW-12b (#5485)** adds it.

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

## Adding a wall

`packages/mobile/app/boards/spray/new.tsx` → `SprayWallWizardScreen` (SW-09,
#5442). One route, seven steps, behind the mobile flag `spray-walls`:

| Step | What it does |
| --- | --- |
| `resuming` | Asks `mySprayWalls` for a wall of the caller's own with no published version and offers to pick it up or start over. |
| `meta` | Name, gym, visibility, location, and the angle — snapped to `SPRAY_ANGLES`, because the server validates against that list. |
| `photo` | Library pick; the camera button only on a binary at or past the version that shipped the usage description. Compressed to a 2048 px JPEG, which bakes the EXIF orientation into the pixels. |
| `anchors` | Optional, Skip by default. Four draggable handles; a quad that crosses itself is refused client-side, because the server's fallback for a degenerate quad is the identity matrix. |
| `upload` | `createSprayWall`, then the multipart POST, then `createSprayWallVersion`. |
| `detect` | The registered on-device detector, if this binary has one. No detector, or a failure, lands in the editor with nothing to review. |
| `review` → `publish` | `SprayHoldEditorScreen`, then `publishSprayWallVersion`, `invalidateSprayWallRenderData`, and the board bind. |

Three rules in that flow are not obvious from the API and are easy to undo:

- **A wall is created PRIVATE whatever the climber chose.** The row exists from
  the moment `createSprayWall` returns — the photo handler authorises against it —
  but it has no version, no photo and no holds, and `searchBoards` filters on
  `is_public` / `is_unlisted` alone. A wall created public is therefore listed as
  an unusable board for as long as the flow takes, and forever if it is abandoned.
  The chosen visibility is applied by `updateSprayWall` straight after the first
  publish.
- **An unfinished wall is resumed, never duplicated.** Because the row is real, an
  abandoned run counts against `MAX_SPRAY_WALLS_PER_USER`. The resume check has to
  read a list fetched AFTER the screen mounted: React Query serves the cached
  pre-creation list while it refetches, and deciding on that creates a second
  orphan beside the first.
- **Publishing and binding the board are latched apart.** They sit behind one
  button, and `publishSprayWallVersion` refuses a version that has already
  published — so a shared retry would turn a failed board bind into a dead end.

## Caps

| Cap | Value | Why |
| --- | --- | --- |
| `MAX_SPRAY_WALLS_PER_USER` | 10 | Each wall costs a private-bucket photo per version plus a catalogue layout row. Well past what a home climber or a gym needs, low enough that a scripted account cannot fill the bucket. |
| `MAX_HOLDS_PER_WALL` | 1500 | A dense commercial spray wall runs 400–800 holds. The cap bounds what a detector run, a hold-editor session and a reset match hold in memory at once. |
| `MAX_VERSIONS_PER_WALL` | 50 | A wall reset monthly for four years stays inside it. Every version keeps its own photo and its own hold generation. |

All three are reachable by ordinary use — ten walls is a gym with a lot of bays,
1,500 holds is a dense commercial spray wall, fifty resets is four years of
monthly changes — so each is **said out loud with its number** rather than met as
"Something went wrong":

| Cap | Where the climber reads it |
| --- | --- |
| Walls | A hint on the create step, BEFORE it bites (`sprayCaps.wallsHint`), and the refusal itself. Meeting the cap on the publish step with a photo already uploaded is the worst moment to learn it. |
| Holds | The hold editor's save refusal (`sprayEditor.errors.tooManyHolds`). |
| Versions | The reset flow's upload failure (`sprayCaps.versions`). |

The numbers come from `spray-config.ts` through
`packages/mobile/src/lib/spray/spray-cap-copy.ts`, never typed into a catalog
string: the server refuses on those same constants, and a copy string carrying a
stale number would be telling a climber the rule is something other than what
refused them. The refusals are matched on `extensions.code`, never on the
server's English sentence, which is not a contract and is not translated.

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
| `reportSprayWall(input)` | Report a wall. Any signed-in viewer who can see it, once per wall (SW-17, below). |
| `setSprayWallHidden(input)` | The admin switch. Community admins only. |
| `sprayWallReports(uuid)` | The pending report queue. Community admins only. |
| `purgeDeletedSprayWallPhotos(limit)` | Cron-authenticated. Deletes the photographs of walls deleted more than 30 days ago. |

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
| `proposeSprayWallReset` | the **published** one — a reset is a reset OF what climbers see, and matching a new photo against the draft's own holds would compare the detections with themselves |
| `commitSprayWallVersion` | the **draft's own** number for its re-validation, then the version being published for the hold count |
| `remixClimb` | the **published** one, which is what "the hold is no longer there" means to a climber |

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
`viewerCanEdit`, and an optional `candidates` list. SW-09 hosts it as the review
step of `/boards/spray/new`; SW-11 wires the owner's later entry points.

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

### Asking is not the same as subscribing (SW-11)

`useSprayWall` asks for exactly one wall: the active board's. Every other surface
only SUBSCRIBED to the registry, and a subscription on a wall nobody asked for is
a subscription nothing will ever wake — so a logbook row, a feed card, a shared
ascent or a playlist thumbnail showing a climb from a wall that is not the active
board drew a placeholder for the rest of the session.

The ask therefore lives in `use-native-climb-render.ts`, the one hook every
board-drawing surface already goes through: on `spray` it calls
`ensureSprayWallLoaded(layoutId)` in an effect keyed on the wall token, which
costs a `Map` lookup off spray and at most one request per wall. `Board Render
Failed` would never have reported this, because nothing failed — nothing was
asked.

That fixes every surface that mounts the board. The ones that **early-return on a
null `getBoardRenderData`**, before mounting anything that subscribes, need their
own line: `useSprayWallToken(boardName, layoutId)` ABOVE the early return, which
both asks and subscribes. `BoardManageRow`, `AccessoryClimbThumbnail`,
`BoardDiscoveryCard`, `BoardConfigPreview`, `PlayDrawer`, `WallKioskScreen`, the
hold filter and `ClimbReactionMenu` all do this. Adding a new synchronous board
surface means adding that call; forgetting it is a permanent placeholder, not a
crash.

## What a wall looks like in the app (SW-11)

Three rules the rest of the app reads off the board type, none of which needed a
new screen: **the Climbs tab is a wall's home** once the wall is the active board.

**The subtitle leads with the kind, not the place.** Every other board is
recognisable from its name — "Kilter 12×14" says what it is — but a wall is named
by its owner ("Garage", "Main wall"), and its layout and size have no catalogue
rows to name, so `boardConfigLabel` answers null for spray by design. A row
reading just "Bergen Klatresenter" under a name like "Main wall" therefore hid the
one fact that separates it from the Kilter on the row above. So
`boardRowSubtitle` inverts for spray only: `Spray wall`, or `Spray wall ·
<place>`. Within one gym's list the place is dropped as redundant and the KIND
survives, which is the opposite of every other board type and is the whole point.
The word itself comes from the caller (`BoardLabelOptions.sprayKindLabel`, fed by
mobile's `useSprayLabelOptions`): `formatBoardDisplayName` is deliberately English
because it spells brand names, and "Spray wall" is the one value it returns that
is not a brand. www passes nothing and keeps the English default.

**An empty wall is not an empty search.** `shouldShowUnsetWallEmptyState` puts
"No one's set on this wall yet" and the door to the first climb on the Climbs tab
— but only with no query and no filters on. A wall with forty climbs, filtered to
V8+, is empty for a reason that has nothing to do with the wall being new, and
saying so to its owner would be false.

**The config lock has two reasons and they need two sentences.**
`lockedConfigReason` tells them apart: `permission` (the server's `canEdit` said
no) and `spray` (a wall's configuration IS its photograph — the layout row was
created when it was shot, its size id is that same number, and every climb on the
wall points at that partition). Telling a wall's own owner they lacked permission
was false twice over. Permission is checked FIRST: on a wall the viewer may not
edit both hold, and only one is actionable, since "shoot the wall again" is advice
for the owner. The edit screen also drops the light-kit, serial and timer rows for
a wall — see the Bluetooth note below.

**No Bluetooth, and the flag it rests on.** Every "take the wall instead of
connecting" affordance keys on `user_boards.has_leds === false`, which
`createSprayWall` hard-codes and its input schema has no key for. So a wall
inherits the whole LED-less path from #4585 with no spray branch: the bulb means
"I'm on it", the device picker is never mounted, and `SPRAY_CAPABILITIES`
`nativeBoardControl: false` keeps the native BLE adapter out. That is why the edit
form must not render the Lights toggle on a wall — one tap would have put a
Bluetooth scan on a photograph. `updateBoard` still ACCEPTS `hasLeds` for a spray
board, which is the remaining hole (#5486).

### The owner rows, and the sheet that is not mounted

`sprayDetailRows(board)` is the gate behind the wall-maintenance rows ("Edit
holds", "New photo"): two rows on a spray wall whose `canEdit` is true, none
anywhere else. It reads `canEdit` rather than `isOwned` because that is the field
the spray API gates every version mutation on, so the affordance and the
permission cannot drift.

The rows are **not rendered** (`SPRAY_DETAIL_ROWS_ENABLED = false`), for two
reasons that both have to be fixed before the flag flips (#5491):

1. Neither route exists yet — `/boards/spray/holds` is SW-08 and
   `/boards/spray/reset` is SW-13 — and Expo Router sends a prefix-less miss to
   `+not-found`, which redirects to Home. A row that lands somewhere wrong is
   worse than no row.
2. **`BoardDetailSheet` is not mounted by anything.** The live board sheet is
   `board-presence/BoardSheet`, hosted by `drawer-host-provider`;
   `BoardDetailSheet` has no production importer at all. So these rows — and
   SW-14's `BoardShareSheet`, whose only mount is that same file — are
   unreachable regardless of the flag. Whatever wires them up has to put them on
   the sheet climbers actually open.

## Resets

A reset is what happens when someone takes holds off the wall and puts others on.
The climb database survives it: climbs that lost holds stay findable, get a
number, and can be remixed onto what is there now.

The flow is three calls, and only the middle one of the three writes anything:

1. `createSprayWallVersion` — the new photo, as a draft. **It must carry
   anchors** (see below).
2. `proposeSprayWallReset(wallUuid, versionId, detections)` — match the new photo's
   detections against the holds on the wall today and report what changed. Writes
   nothing at all, so a client may call it as often as the owner drags a hold.
3. `commitSprayWallVersion(wallUuid, versionId, decisions)` — apply the reviewed
   decisions and publish the draft, in ONE transaction under the wall lock.

### The canonical frame is version 1's photo, forever

Version 1 defines the frame and nothing ever re-defines it — every hold ever drawn
on the wall is already stored in it, so moving it would move all of them. Version 1
may legitimately have no anchors: with nothing to compare against, the frame IS
that photo, and the identity homography is true by definition rather than a
fallback.

**From version 2 on, anchors are mandatory**, and `proposeSprayWallReset` and
`commitSprayWallVersion` both refuse a draft without them
(`SPRAY_WALL_ANCHORS_REQUIRED`). Without anchors `resolveVersionGeometry` stores
the identity matrix again — which now asserts that the second photograph has the
same crop, framing and dimensions as the first. Nobody made that promise and no
phone honours it. The detections then arrive as raw photo pixels labelled
canonical, and the matcher, which is only comparing two coordinate sets, reports
the entire wall as removed and the entire photo as added. Committing that takes
every hold off the wall and breaks every climb on it, and the anchors are also the
only thing that could have told the two photographs apart afterwards.

The check is in both calls, not just the commit: the proposal is what a human
reads, and a client is free to skip it.

### What the proposal reports

`proposeSprayWallReset` runs `matchHolds` from `@boardsesh/spray-wall-geometry`
over two sets of circles in the wall's canonical frame: the holds alive at
`current_version_id`, and the detections the client sends (already mapped through
the draft's own homography — the server never warps an image and never re-runs
detection). It comes back with:

| Field | What it is |
| --- | --- |
| `kept` | hold id + which detection it matched + a 0..1 confidence |
| `removed` | hold ids with no detection inside the gates |
| `added` | indices into `detections` that matched nothing already there |
| `lowConfidence` | kept holds where a second detection was nearly as good a match |
| `climbsAffected` | climbs using at least one removed hold, counted from `board_climb_holds` |
| `movesSuggested` | each removed hold paired with the nearest added detection |
| `aspectMismatch` | the new photo is shaped more than a tenth differently from the frame |

`aspectMismatch` is a **warning and never a block** (epic decision 2026-09-14). The
anchors are what put two photographs in one frame and they have already been
applied by the time detections arrive, so a different aspect ratio usually means
the owner stood somewhere else. It is still worth saying, because the one case
where it IS wrong — anchors tapped on the wrong corners — shows up here first.

`climbsAffected` reads `board_climb_holds` rather than `missing_hold_count`,
because the whole point is to show the number BEFORE anything is written: the
column still says 0 for every one of those climbs.

### What the commit writes

All of it in one transaction, with `lockWallForWrite(tx, wallId)` as the first
statement, and every decision re-validated under that lock against the wall as it
is NOW. A proposal is a screenshot: the owner may have sat on it while another
editor published, and applying it then would remove holds that are already gone.

1. **Removed** holds are stamped `removed_version_id = <this version>`. Never
   deleted — the climbs set on them have to stay findable, and
   `missing_hold_count` has to stay countable.
2. **Added** detections get a fresh catalogue pair (one `board_holes` row and one
   `board_placements` row sharing an id from `spray_hold_catalog_id_seq`) and a
   `spray_wall_holds` row installed at this version. Where the review confirmed a
   move, `moved_from_hold_id` points back at the hold it replaced — which has to be
   in the same commit's `removed` list, because a move IS one removal and one
   addition in one sitting. A predecessor still on the wall would leave two holds
   claiming one position, and the day a later reset took that predecessor off,
   remix would offer this unrelated older hold as its successor with nothing left
   to notice the mistake; a predecessor an earlier reset already removed is
   history, whose successor was decided then or never.
3. **Kept** holds take a fresher **silhouette** from the new photo and nothing
   else. `cx` / `cy` / `r` stay exactly as published, deliberately: every climb on
   the wall renders from those numbers, and a kept hold matched its detection
   within six tenths of a radius — real, and enough to shift a climb's start hold
   under the climber if it were written through. Two photographs of a wall that did
   not change still disagree by a few pixels; the hold did not move, the camera
   did. An outline is a picture of the hold rather than a position, so a sharper
   one is free.
4. Then the ordinary publish, through the same `publishDraftUnderLock` helper
   `publishSprayWallVersion` uses: the previous generation is superseded, this one
   becomes `published`, `current_version_id` / `hold_count` / the catalogue image
   move, and `recomputeMissingHoldCounts(wallId)` re-materialises every climb's
   integrity number.

An alive hold the decisions never mention simply stays on the wall. That is the
safe direction for a client that forgot one; the alternative silently unsets every
climb through it.

Because the publish happens inside the same transaction, there is no instant at
which the holds have gone but the version has not landed — which matters, since a
removal is only real once its version has landed.

### The generation rule

A hold generation counts only once its installing (or removing) version has
**landed**: `status <> 'draft'`, or it is the version being asked about. Both
`aliveHolds` and `recomputeMissingHoldCounts` carry that bound on both ends.

Without it, an abandoned draft poisons the wall forever. Version numbers are dense
per wall and handed out when a photo is uploaded, so a draft nobody ever published
still owns a number: publish v1, start a reset as v2 and walk away, publish v3, and
v2's additions would come back as alive holds nobody ever screwed to the wall, while
its removals would badge every climb through them as broken with no way back.

`discardSprayWallVersion` therefore **deletes** a draft rather than marking it.
There is no status that would work: `superseded` is read as landed, so a discarded
draft's work would take effect, which is the abandoned-draft bug made permanent.

### Climb integrity

`board_climbs.missing_hold_count` is how many of a climb's holds now carry a landed
`removed_version_id`. Materialised on the climb row rather than joined through
`board_climb_holds`, because the offline mirror has no such table — a join would be
a filter the phone could never mirror.

It reaches three places:

- **`Climb.missingHoldCount`** in GraphQL. Null on every catalogue board, where
  holds do not come off.
- **`ClimbSearchInput.holdIntegrity: ANY | INTACT | BROKEN`**, implemented by
  `holdIntegrityCondition` in `packages/db/src/queries/climbs/create-climb-filters.ts`
  next to `hiddenClimbCondition`. Both branches `COALESCE(…, 0)`: NULL means
  "unknown", and the honest reading of unknown is INTACT — reversed, one
  un-backfilled row would badge every Kilter climb in the database as broken.
- **the offline mirror**, `packages/mobile/src/db/queries/search-climbs-local.ts`,
  which **declines** an INTACT/BROKEN search rather than answering it. The column is
  not synced to the device until SW-15 (#5448), and declining IS the faithful
  mirror: answering from a column the device does not have would report every climb
  on a wall that has just been reset as intact, which is the one answer this filter
  exists to contradict.

`recomputeMissingHoldCounts` writes only the climbs whose number actually moved
(`IS DISTINCT FROM`) and stamps `updated_at` on those, so the offline sync cursor
ships the change without re-shipping the whole partition after every reset.

### Why a moved hold is removed + added, and what remix is for

Climbs reference positions. A hold unbolted and re-bolted 40 cm left is not the
hold that climb used — every climb through it now asks the climber to reach
somewhere the wall has nothing. Calling it "the same hold, moved" would silently
rewrite those climbs into different problems and leave their grades and ticks
attached. So it is one removal and one addition, `moved_from_hold_id` records the
pairing, and **remix** is the way back.

`remixClimb(parentUuid)` returns a seed: the parent's frames with the lost holds
stripped, the ids it lost, the ids it kept, and the successors
`moved_from_hold_id` names for the lost ones. It writes nothing. The child is then
an ordinary `saveClimb` carrying `remixOfClimbUuid`, which writes the
`spray_climb_lineage` row alongside the climb — one transaction, so a remix never
lands without the link that says where it came from.

The **parent is shown even when it is no longer climbable** (epic decision
2026-09-14). A climb that lost three holds is exactly the one worth remixing, and
its ticks and grade history are still the best thing the child can point at. That
is also why `spray_climb_lineage.parent_uuid` carries no FK and the version FKs are
`RESTRICT`: losing the lineage row would erase the only link a climber has back to
the parent.

## The reset on the phone

`/boards/spray/reset?wallUuid=…` is one route with a stepper behind it
(`reset-wall-machine.ts`), a sibling of the add-a-wall machine rather than a
branch inside it. The two flows share three steps and disagree about everything
around them: there is no wall to name here, and **the anchors are mandatory**.
That gate is the reason the machines are separate — `ANCHORS_DONE` does nothing
without four corners that describe a usable quadrilateral, so a climber never
spends four minutes uploading a photograph the server is going to refuse.

The compare view is a component, not a second route, and the detections are why.
A wall photograph yields hundreds of circles and expo-router params are strings,
so handing them to `/boards/spray/compare` would mean a module-level stash keyed
by version id — a second source of truth for the one array whose INDICES the
proposal is expressed in. It still gets the whole screen when it is showing.

Three rules the client holds that the server cannot:

- **Detections are built once**, in both frames, by `buildResetDetections`. A
  candidate the homography cannot place is dropped BEFORE the array is indexed;
  dropping it later would shift every index past it, and the proposal would then
  describe holds the screen is not drawing.
- **No detections, no review.** The matcher compares two sets of circles, so an
  empty second set means "the whole wall has gone" — which, committed, takes
  every hold off and breaks every climb on it. A phone with no detector lands in
  the hold editor on the add-a-wall flow and is fine; there is no equivalent
  fallback for a reset, because the thing being reviewed IS what the detector
  found. The screen says so and offers nothing else.
- **A pairing is unrepresentable unless the server would take it.**
  `canPairMove` is the only way a `movedFromHoldId` enters the review, and
  putting a predecessor back on the wall drops every pairing naming it. So the
  "in this commit's `removed` list" rule cannot be violated by the client.

The "N climbs lose holds" number is the server's, computed for the removal set
the PROPOSAL named. Nothing on the phone can recompute it — the climbs' holds are
not there — so `climbsAffectedIsStale` hides it the moment the owner changes that
set, rather than showing a number about a different one.

After a commit lands, `invalidateSprayWallRenderData(queryClient, wallUuid,
layoutId)` runs immediately. The SW-07 registry keys every spray cache on the
wall's version token and this device is the one that moved it; until it
re-registers, every key still names the generation the owner was looking at when
they pressed Confirm.

### A climb that lost holds

`Climb.missingHoldCount` reaches three mobile surfaces, and the rule across all
three is that a broken climb stays findable and stays playable:

- the climb-row chip ("2 holds gone"), beside the Hidden chip and in the same
  neutral grey — colour in that row means grade and nothing else;
- the **Holds** filter in the climb filter sheet (All / Intact only / Lost
  holds), defaulting to All. One tap hides them; nothing hides them by default;
- the play drawer banner, which states the number and offers the one thing that
  fixes it. Remix goes through the same `useCreateClimbNavigation` handoff the
  climb-actions sheet uses, carrying the parent's frames — the create editor's
  own sanitiser drops the hold ids that are no longer on the wall, so it opens
  with exactly the holds that survived.

`Climb.lostHolds` carries the geometry of those holds as they were, for drawing
dashed ghost rings where they used to be. The field and its resolver ship here;
the layer that draws them does not. The play drawer renders through the board
render pipeline rather than `InteractiveCreateBoard`'s `overlay` slot, so the
ghosts need a seam in that pipeline, and the create editor would need the parent
climb's holds threaded through route params that are strings. Both are follow-up
work, and the banner already answers the question the missing holds raise.

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
adopts it, so an abandoned upload is a stray object rather than a row anyone can
see. The SW-17 purge below collects it with the rest of the wall's prefix once the
wall is deleted — which is also why the object key is a pure function of the photo
id: a whole wall's objects are enumerable by prefix.

## Moderation: reporting a wall, and hiding one

A wall photograph is a new class of content — user-supplied, of somebody's home,
and reachable by a link the owner sends. Two mechanisms cover it, and neither is
the `climb_proposals` vote machinery in `docs/climb-moderation.md`.

**Why not proposals.** A proposal is a change to a CLIMB — its holds, its name,
its grade — decided by a weighted approval threshold, because several climbers
who have been on the climb know better than any one of them. "Should we be
serving this photograph" is a different question: it has exactly one right
answer, the people who could vote are the ones who can already see the wall, and
the outcome is not a catalogue edit. So it is a queue an admin reads and one
switch.

| Piece | What it is |
| --- | --- |
| `reportSprayWall(input)` | Any signed-in climber who can SEE the wall — owner, gym member, or anybody on a public or unlisted one — once per wall. Delegates to `viewerCanSeeSprayWall` rather than restating the rule, because restating it is how the gym-member path got dropped the first time. Writes one `spray_wall_reports` row; a second report from the same climber answers `ALREADY_REPORTED` and writes nothing. |
| `spray_wall_reports` | `(wall_id, reporter_id)` unique, a closed-set `reason`, and `reviewed_at` / `reviewed_by`. No free-text field anywhere in the path. |
| `setSprayWallHidden(input)` | Community admins (`spray`-scoped or global). Stamps or clears `spray_walls.hidden_at` / `hidden_by` and marks every pending report on the wall reviewed. |
| `sprayWallReports(uuid)` | The pending queue, newest first, excluding walls the owner has since deleted — those are no longer work. Admins only. There is no admin ROUTE yet (#5501). |
| `SprayWall.hiddenAt` | Non-null only for the owner, because a hidden wall does not resolve for anybody else. The mobile banner renders off its presence. |

**What hidden means: exactly what private means, for everybody but the owner.**
The wall leaves gym lists and the boards picker, its uuid and its share link stop
resolving, and its climbs drop out of every read that carries the spray
visibility predicate. Hiding outranks both `is_public` and the unlisted
share-link capability — it has to take a wall off the internet, and a capability
that survived it would be a link that still worked.

The owner keeps everything: the wall, its photos, its holds and its climbs, plus
a notice saying what happened. A wall that quietly stopped being visible to their
crew with no explanation would read as data loss, and the climbs on it are their
work.

The rule lands in **four** implementations, which is the thing to keep in step —
they do not share a query builder:

1. `viewerCanSeeSprayWall` (by uuid) and 2. `viewerCanSeeSprayWallByLayout` in
   `packages/backend/src/graphql/resolvers/board/spray-walls.ts`, both
   short-circuiting on `hiddenAt` before the public/unlisted question;
3. `viewerCanWriteSprayClimbs`, which additionally refuses the presented-uuid
   capability on a hidden wall;
4. the three SQL predicates in
   `packages/db/src/queries/climbs/spray-visibility.ts`, each carrying
   `AND (sw.hidden_at IS NULL OR ub.owner_id = <viewer>)`. Those are what gate a
   spray climb's ~15 reads.

Hiding also purges the wall's `feed_items`, the same as deleting it does — feed
rows are served straight out of that table and would outlive the gate. Unhiding
does NOT put them back: a feed is a record of what happened when, and
re-announcing week-old climbs would be a lie. Everything else comes back.

Reporting is API-only today: there is no report button in the app and no admin
console route. Both are **SW-17b (#5501)**, split out because a report row belongs
in `BoardDetailSheet`, which SW-11's stack is rewriting — landing one there from
this stack would have been a guaranteed conflict for no gain, since the admin path
needs the mutation either way. Until then the mutation is what an admin or a
support reply drives.

## Retention: what happens to a deleted wall's photographs

Deleting a wall is a **soft** delete, and it always will be: the catalogue rows
and every climb ever set on the wall stay behind, because a deleted wall stops
being reachable and does not un-set anybody's climbs. The PHOTOGRAPHS are the
part that must not linger.

`SPRAY_WALL_PHOTO_RETENTION_DAYS` (30, in
`packages/shared/board-config/src/spray-config.ts`) is the undo window, not a
retention policy: long enough that an accidental delete can be walked back by
hand, short enough that a climber who deleted a wall to get the photo off our
disks is not waiting a quarter.

The scheduler job `purge-spray-wall-photos` (07:00 UTC daily,
`packages/scheduler/src/jobs/purge-spray-wall-photos.ts`, `docs/scheduler.md`)
calls the cron-authenticated `purgeDeletedSprayWallPhotos` mutation. The job
holds the SCHEDULE and nothing else — the scheduler has no database client and no
storage credentials, and giving it either would put the private photo bucket
behind a second service.

What the mutation does, per wall, in this order:

1. list `spray-walls/<wallUuid>/` in the `private` bucket and delete every
   object — the photos, their resize variants, and any upload that was never
   adopted as a version;
2. the same prefix in `media`, which is where SW-14's public promotion copies a
   published photo. That is the one copy that would survive a private-bucket
   delete and stay fetchable by anybody;
3. only then clear `photo_key` on the wall's versions.

**Objects first, row second.** A crash between the two leaves a version pointing
at an object that is gone, which reads as a wall with no photo — the same thing
the next run would have produced. The other order leaves a key nulled and the
object orphaned in the bucket forever, with nothing left that names it.

Nothing else is touched. No `spray_walls`, `spray_wall_versions`,
`spray_wall_holds` or `board_climbs` row is deleted, ever — other people's ticks
point at them.

Two rules keep the job honest, and both are the kind that fail silently if they
are got wrong:

- **"Still has a photo" is part of the candidate query, not a filter on its
  results.** A purged wall's row is never deleted, so it stays past the cutoff
  forever. Take the oldest 200 deletions and then drop the ones already done, and
  once 200 walls have been purged every run fills its batch with no-ops — nothing
  deleted afterwards is ever reached again, and the job reports `wallsPurged: 0`,
  which looks exactly like "nothing to do". Pinned by a test that puts a full
  batch of purged walls in front of one fresh deletion.
- **A run that deleted nothing must not clear `photo_key`.** The key is the only
  thing that names the object, so clearing it on a failed delete — or on a backend
  with no `private` bucket, which every dev machine is — would leave the
  photograph in the bucket, unnamed, and the wall would never be a candidate
  again. A storage failure is logged and the wall is skipped, so the next run
  takes it; "no bucket configured" throws rather than reporting zero.

The deletes inside one wall's prefix are serial on purpose: a wall is a handful of
objects, 200 of them is still only hundreds of round trips, and fanning them out
would trade a bounded run for R2 rate-limit retries. A run that does not finish
its batch loses nothing — tomorrow's run takes what it missed.

## Telemetry

Seven events, all in `SHARED_EVENTS` with typed builders in
`packages/shared/analytics/src/spray-wall-events.ts` (the `board-render-events.ts`
style: each builder returns `{ name, properties }` together, so a call site
cannot pair one event's props with another event's name). Mobile fires them
through `trackSprayEvent`; nothing calls `track` with a spray event name directly.

| Event | Properties | What it answers |
| --- | --- | --- |
| `Spray Wall Photo Picked` | `source` | Camera or library — the two feel different on a slow phone. |
| `Spray Wall Upload Finished` | `outcome`, `durationMs`, `determinate`, `attempt` | Whether the photo lands, and how long a climber waits for it. |
| `Spray Wall Detection Finished` | `outcome`, `candidateCount`, `durationMs` | `unavailable` is a SUCCESS — the flow lands in the editor in manual mode. Read it against `ok` for the fraction of the fleet placing every hold by hand. |
| `Spray Holds Reviewed` | `holdCount`, `hadCandidates` | What the review step actually saved. The number the detector is judged on. |
| `Board Created` (existing) | `boardType: 'spray'` | Closes the add funnel. The SAME event every other board type fires — a spray-only variant would hide walls from every board-creation number we already watch. |
| `Spray Wall Reset Previewed` | `keptCount`, `removedCount`, `addedCount`, `lowConfidenceCount`, `climbsAffected`, `aspectMismatch`, `detectionCount` | What the matcher found. |
| `Spray Wall Reset Applied` | `keptCount`, `removedCount`, `addedCount`, `climbsChanged`, `moveCount` | What landed. The server's counts, not the review's. |
| `Climb Remixed From Broken` | `lostHoldCount`, `source` | Whether a climb a reset broke is a dead end or a starting point. |

Two rules, both enforced by a test in
`packages/shared/analytics/src/__tests__/spray-wall-events.test.ts`:

- **Outcomes, not gestures.** PostHog is past the 1M-event tier, so every event
  fires once per wall per step. Nothing fires per tap, per frame, or per hold.
- **Nothing identifies the wall or what is on it.** No photo, no URI, no file
  name, no wall name, no gym, no hold coordinates, no free text. Every property
  is a number, a boolean, or a member of a closed string union, and the test
  reads the payloads back field by field rather than trusting the types.

## Rolling the flag out

The whole surface is behind the mobile flag `spray-walls`
(`docs/feature-flags.md` → "Mobile flags"). A POSITIVE rollout flag: unresolved
reads as off, so the tile never flickers in for the first frames of a cold open.

Three steps, each gated on a number rather than on a feeling:

| Step | Audience | Gate before moving on |
| --- | --- | --- |
| 1 | Testers only (the on-device override, More → Feature Flags) | At least one wall photographed, reset and set on, end to end, on a real wall. |
| 2 | 10 % | `SPRAY_ROLLOUT_GATES.detectionCorrectionRate` ≤ 0.15 over `Spray Holds Reviewed` where `hadCandidates` is true, and `Spray Wall Upload Finished` `outcome: 'ok'` ≥ 0.95. |
| 3 | Everyone | `SPRAY_ROLLOUT_GATES.resetCommitRate` ≥ 0.6 — applied ÷ previewed. An owner who previews a reset and never applies it has been shown something they do not believe. |

Both ratios are functions in `spray-wall-events.ts` rather than prose in a
dashboard description, so the number in this doc and the number in the code
cannot drift. The correction rate is a PROXY, not an F1: the detections are not
stored, so a correction and a delete-plus-add are indistinguishable. It moves in
the right direction, which is what a rollout gate needs.

Step back at any point by setting the flag false — nothing the flag gates writes
anything a rollback has to undo, and a wall already created stays created.

### The one public copy (SW-14)

A **public** wall is the single exception, and it is a copy rather than a move.
`updateSprayWall` promoting a wall to public copies the current published photo
from `private` into the world-readable `media` bucket under
`spray-walls/<wall uuid>/<128 random bits>.jpg`
(`sprayWallPublicPhotoKey`) and stores the key in `spray_walls.public_photo_key`;
`SprayWall.publicPhotoUrl` serves it and is null for every wall that is not
public. That copy exists because a public wall has to render on a web gym page a
logged-out climber and a crawler read, and neither can hold a 15-minute signature.

Three properties of the copy are load-bearing:

- **The key is random, not derived.** `media` is world-readable under guessable
  keys, so a key anybody could rebuild from the wall uuid would keep resolving in
  every cache and screenshot after the owner made the wall private again. 128 bits
  means the demotion is real, and a re-promotion is a URL nobody has seen.
- **Demotion deletes the object and nulls the key**, in the same transaction that
  flips the flag, alongside the feed retraction below. A delete that fails is
  logged and left to the SW-17 sweep — the row has already stopped handing the URL
  out, which is what "private" actually rests on.
- **A publish re-points it.** `publishSprayWallVersion` on a public wall copies the
  newly published photo and sweeps the old object, or the gym page would show last
  year's wall forever.

The copy is made BEFORE the transaction — object storage is a network round trip
and the wall's advisory lock must not be held across one — and is deleted again if
the transaction then fails. **Unlisted walls get no copy**: they are read by uuid,
through presigned URLs, like a private one.

### Who may flip the switch

Every other field on `updateSprayWall` follows `requireBoardEditAccess`, which a
gym owner/admin and a community leader also pass. Visibility does not: **both**
`isPublic` and `isUnlisted` are owner-only
(`SPRAY_WALL_VISIBILITY_OWNER_ONLY`). Putting a photograph of somebody's wall on
the open web, and starting to announce their climbs, is the photographer's call.

`isUnlisted` is in that guard for a reason that is easy to miss: on a wall it is
not the lesser flag, it IS the share link. `viewerCanSeeSprayWall` and
`viewerCanWriteSprayClimbs` both honour a presented uuid the moment it is set, so
a guard that watched only `isPublic` would let a gym admin flip a member's private
wall to unlisted and mint a capability over the photograph of their garage —
quieter than making it public, and exactly as far from private.

`updateBoard` refuses a CHANGE to either flag on a spray board outright
(`SPRAY_WALL_VISIBILITY_ELSEWHERE`) so there is exactly one door — the ordinary
board path would set the flag and copy nothing. It refuses `hasLeds` and
`isAngleAdjustable` there too (`SPRAY_WALL_HAS_NO_HARDWARE`, #5486): both are
pinned false at creation, `has_leds` is the whole of the "no Bluetooth on a wall"
contract, and a wall does not adjust. All four refuse a change rather than the
field's presence, so a client echoing the board back on a rename is not blocked.

### The two senses of "unlisted"

An ordinary board is unlisted when it is `is_public AND is_unlisted` — public
enough to open by link, withheld from search. A wall is unlisted when it is
`NOT is_public AND is_unlisted`: it is private to the world and reachable by the
uuid its owner sent. That is why the public photo copy is keyed to `is_public`
alone and survives a public wall ALSO being marked unlisted: the copy tracks
"world-readable", and unlisted does not take that away.

### A gym's walls

`gymSprayWalls(gymUuid)` lists a gym's walls for the mobile gym screen and the web
gym page. It gates on **`viewerCanSeeSprayWallByLayout`**, not
`viewerCanSeeSprayWall`: a listing is enumerable, so the unlisted exemption must
not apply — appearing in a public list is the one thing "unlisted" promises not to
do. Gym members see the gym's walls including the private ones; everybody else,
logged out included, sees only the public ones. An unknown gym is an empty list.

The web gym page lists walls in their own section and filters `boardType ===
'spray'` out of the boards section so the same wall is not listed twice — but
**only when the wall query actually answered**. `fetchGymSprayWalls` returns
`null`, not `[]`, when the ask failed, which is the deploy window where web is
ahead of backend and `gymSprayWalls` is not a field yet. On `null` the filter is
skipped and the walls keep their old row in the boards section, so neither deploy
order makes a gym's walls disappear from its page.

### An unpublished wall is listed to nobody but its owner

`is_public` and the first publish are two separate moments: the API lets a caller
create a wall public and photograph it afterwards, and in between the row is a
public board with no photo, no holds and no climbs. So every listing that can
return a spray wall carries one more rule — a wall whose
`spray_walls.current_version_id` is NULL is listed only to its owner.

`listableSprayWallCondition(viewerId)`
(`resolvers/board/spray-wall-listing.ts`) is that rule as SQL, and it is applied
in `searchBoards` (both the proximity and the text path), `gymBoards` and
`myBoards`; `gymSprayWalls` applies the row-level twin `sprayWallIsListable`,
having already joined the wall. SQL rather than a post-filter because
`searchBoards` and `myBoards` each run a COUNT beside the page: a filter that
dropped rows from the page alone would leave the count promising results the last
page does not have.

The app creates walls private and shares them after the first publish (SW-09), but
the API is public and a server rule must not rest on a client convention.

### Android deep links to a share URL

A share link is `https://www.boardsesh.com/b/<slug>/<angle>/list`, with
`?wall=<uuid>` on an unlisted wall. iOS takes it into the app through the
host-wide `applinks:` entitlement. **Android does not yet**: the intent filters in
`packages/mobile/app.config.ts` cover `/join`, `/preview` and
`/auth/reset-password` only, so a `/b/` link opens the website instead. Adding the
filter moves the native fingerprint, so it rides the next native train rather than
an OTA (SW-14b).

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

## Setting a climb on a wall (the editor)

The create-climb editor is board-agnostic once `create-board-holds.ts` knows the
holds and `getBoardCapabilities` allows authoring, and SW-07 made both true for a
wall — so `isAuthorableBoard`
(`packages/mobile/app/(tabs)/climbs/create.tsx`) already accepts `spray` through
the capability, the brush bar already offers all four roles (`STATE_TO_PRIMARY_CODE.spray`),
and start/finish still cap at two each. What is left is four rules a wall answers
differently, and they live as pure functions in
`packages/mobile/src/components/create-climb/spray-climb-rules.ts`:

1. **A setter grade is required to publish, optional on a draft.**
   `SetterGradeRow.tsx` puts the tick sheets' single-select grade rail in the
   create form, over the board's own scale (`useGrades`, which falls back to the
   bundled taxonomy offline — a wall copies the Tension scale, so the ids line up
   with what `resolveDifficultyId` matches server-side). The pick rides
   `SaveClimbInput.userGrade` / `UpdateClimbInput.userGrade` as the grade NAME
   (`"6c/V5"`), the same string `board_difficulty_grades.boulder_name` stores.
   `publishBlocked` names the missing grade under the Save button, so a disabled
   button is never mute. `use-last-used-grade.ts` seeds a FRESH climb's picker
   with what the setter last published on this board — a session on one wall
   clusters hard — and a draft, a fork and an edit all overwrite that seed with
   their own grade.
2. **Feet are open by default, and the toggle follows the paint.** A wall is a
   field of holds with no set-piece feet, so "any feet" starts on. It is not
   derived, though: the first FOOT hold turns it off and clearing the last one
   turns it back on, while a setter who overrides it by hand in between is left
   alone until the feet change again (`nextAnyFeetForFeetChange`). A campus climb
   never reopens its feet.
3. **The angle is the wall's.** `assertSprayAngleMatchesWall` rejects any other
   outright rather than coercing it, so sending the route param would turn a
   stale deep link into a publish the setter cannot fix. `authoringAngle` reads it
   off the registry, which carries `RegisteredSprayWall.angle` from the wall's
   `user_boards` row. There is no angle control in this editor to hide.
4. **`sprayWallUuid` rides every write**, from the same registry entry — see rule
   1 of "Climb writes on a wall" above for why it is sent unconditionally.

Everything else is unchanged and deliberately so: the duplicate gate surfaces
through the existing `isDuplicateClimbError` + `DuplicateBanner` (the server
computes `hold_fingerprint` per wall, so an identical hold set on ANOTHER wall is
not a duplicate), drafts keep their per-wall-version slot from SW-07, there is no
benchmark toggle, and Remix / Edit in `ClimbActionsSheet` were already gated on
`climbCreation`.

One screen-level difference: a wall reached cold — a share link, a fork of
somebody else's wall climb — has no registry entry yet, so `CreateClimbScreen`
holds a spinner on `useSprayWall`'s load state instead of settling on "can't set
climbs here" and never looking again.

## Where spray is excluded

Five exclusions matter, and all five are about a wall being someone's private
property rather than a catalogue:

1. **Board pickers.** `SUPPORTED_BOARDS` in
   `packages/shared/board-config/src/board-data.ts` — the display-filter list,
   not the schema's — drops `spray` outright. No generic picker, board builder or
   wall finder offers it; a wall is created through the add-a-wall flow
   (`/boards/spray/new`, below) and reached at its own `/b/{slug}`.
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

The config-tuple tree stays closed: `boardHasDeepConfigRoute` in
`packages/web/app/lib/board-route-paths.ts` 404s `/spray/...`, because a wall
has no layout, size or set NAMES to slug. What www does serve is the wall's
climbs at `/b/{slug}`, which is the next section.

## The wall on the web (SW-16)

A share link from the app opens on www, so a wall's CLIMBS get a
server-rendered page each — `/b/{slug}/{angle}/view/{climb}` — and nothing else
does. The wall itself has no front door on www: `/b/{slug}/{angle}/list` 404s
for spray, which is also what `/b/{slug}` redirects into. That is a page that
does not exist rather than a page that failed; without the guard the route
reaches `getBoardDetailsForBoard`, which has no catalogue size row for a wall
and throws a 500 on a URL the gym page links to.

### Three states, and what each one gets

| The wall is | The page | Indexed | OG card |
| --- | --- | --- | --- |
| public | server-rendered | yes, self-canonical | yes |
| unlisted | server-rendered for whoever followed the link | `noindex, follow` | no |
| private | `notFound()` | — | — |

**A private wall is a 404, never a 403, and 404 for its signed-in owner too.**
Telling a stranger that a URL IS a wall they may not see is itself the leak, and
the owner reads their own wall in the app. www could not serve one safely in any
case: `middleware.ts` puts a shared `s-maxage` on every climb-view URL with no
session split, so a private wall rendered for its owner would be cached for
everybody. The decision is made from the board row the slug resolved to and
nothing else, so a private wall costs no round trip and the backend is never
asked a question whose answer would confirm the wall exists
(`spray-view.tsx`, `resolveSprayWallVisibility`).

### Which photograph the page shows

A PUBLIC wall shows `SprayWall.publicPhotoUrl` — the copy SW-14 makes in the
world-readable bucket — because a crawler, an unfurler and a CDN can all hold a
stable URL and none of them can hold a fifteen-minute signature. An UNLISTED
wall has no such copy by design, so it shows the presigned URL from
`sprayWallRenderData`, which is right for a page read by whoever has the link
and never indexed. Never the other way round: a presigned URL in a public page's
HTML is a dead image fifteen minutes later.

### Drawing the climb

No board renderer. Every other board's art is a bundled photo plus a WASM
overlay addressed by the catalogue tuple, and a wall has neither. The page draws
the photograph as a plain `<img>` with an inline SVG over it, server-rendered
into the first HTML byte — that picture is the page's LCP, and a crawler runs no
JavaScript.

The mapping is `packages/web/app/lib/spray/spray-climb-view.ts`. Hold
coordinates are canonical-frame pixels and the stored matrix maps
photo -> canonical, so drawing means inverting it once and pushing every centre,
radius and silhouette point back into photo pixels through
`@boardsesh/spray-wall-geometry`. A hold with an `outline` draws its real
silhouette as a polygon; one without draws a ring at its mapped radius, the same
fallback an untraced catalogue placement gets. Two departures from the backend's
rule about `invert`: the SVG's coordinate system is the VERSION's photo box
rather than the canonical frame (they only agree on a wall whose owner tapped no
anchors), and a singular matrix degrades to the photograph with no marks on it
instead of throwing. On a server that is the wrong call; on a link somebody
shared, a picture of the wall beats a 500.

### The card and the sitemap

`GET /og/climb?board_name=spray` composes the card from the public copy and the
lit holds, for public walls only — see `docs/og-climb.md`. An unlisted wall's
page emits no `og:image` at all rather than pointing at a URL that answers 404.

Public walls' climbs are the only spray URLs in a sitemap, and the boards shard
stays catalogue-only because a wall has no `/list` page to submit. The rule, the
config source and the SQL belt behind it are in `docs/sitemap.md`.
