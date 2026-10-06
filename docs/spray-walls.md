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

A hold edit writes new `spray_wall_versions` and `spray_wall_holds` rows. It
never writes a new layout or a new size. (A reset is a different thing: it clones
the wall, so the clone gets a layout of its own. See
[Archive and reset](#archive-and-reset).) So every climb ever set on the wall keeps
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
| `spray_climb_lineage` | `child_uuid` | A remix and the climb it came from, plus the wall version it was rebuilt on. Kept, no longer written: remix was retired. |

What a climber sees is the wall at `spray_walls.current_version_id`, not "every
hold whose `removed_version_id` is NULL": while a hold edit is still a draft, its
added holds already have rows and its removals are only removals AT the draft, so
the NULL test would leak an unpublished layout the moment the owner started
editing. `aliveHolds(wallId)` resolves the published version; `aliveHolds(wallId,
n)` reads the wall as it stood at version `n`, which is how a climb set two
versions ago renders on the photo it was set against.

`board_climbs.missing_hold_count` is the materialised integrity number: how many
of a climb's holds have come off the wall. NULL on every other board type.
`spray_wall_catalog_id_seq` hands out wall ids (one value is BOTH the layout id
and the size id) and `spray_hold_catalog_id_seq` hands out hold ids (one value is
BOTH the hole id and the placement id).

### Why a side table, not columns on `board_placements`

The catalogue rows are immutable identity. A climb's frames string
(`p<placementId>r<code>`) points at a placement id forever, and every climb ever
set on the wall keeps pointing at the same `(board_type, layout_id)` partition.
Wall state is the opposite — it changes on every hold edit:

- a hold's lifecycle (installed in version 2, taken off in version 5) is a
  **range**, and a placement row has exactly one present tense;
- each version carries its own anchors and homography, so the same hold sits at a
  different place in every version's photo;
- a silhouette is primary data versioned with the wall, not an admin override of
  a tracer — which is what `hold_outline_overrides` is, and why it is not reused.

Putting those on `board_placements` would make every other board carry nullable
spray columns, and would force a hold edit to rewrite catalogue rows that climb
frames depend on. Keying side tables by the same ids — the
`board_hold_features` / `hold_outline_overrides` precedent — keeps the catalogue
frozen and the wall's history append-only. A hold edit therefore stamps a removal
and appends rows; it never updates published geometry in place and never deletes.
A correction to an inherited hold is a removal plus an addition, and
`moved_from_hold_id` links the two.

### Every per-wall catalogue row is `is_listed = false`

`createSprayWallCatalogueRows` (`packages/db/src/queries/spray-walls/`) writes the
`board_layouts`, `board_product_sizes` and `board_product_sizes_layouts_sets` rows
for a wall, and all three are unlisted. **That is the primary privacy defence,
not a cosmetic flag.** `getPopularConfigs` and the sitemap shards also drop
`spray` by name (#5453), but those are backstops: any other reader of the
catalogue tables has only `is_listed` to go on, so a wall seeded listed would put
a climber's home wall on the www homepage rail. A test on the helper asserts it.

## Canonical coordinates

A hold's position has to mean the same thing in every version of a wall, or a
hold edit would move holds under climbs. That agreement is the **canonical
frame**, and [SW-06 (#5439)](https://github.com/boardsesh/boardsesh/issues/5439)
is the pure TypeScript that produces it: `@boardsesh/spray-wall-geometry` for the
frame, `@boardsesh/hold-detection` for turning a model's tensors into circles in
the first place. The hold matcher that compared two photos of one wall shipped
with SW-06 too; it went with the in-place reset (see [Resets](#resets)).

### The frame

The canonical frame is **version 1's anchor quad mapped onto a rectangle**. The
four anchors are the wall's corners as tapped in that photo, in TL/TR/BR/BL
order; `homographyFromAnchors` solves the 4-point DLT that takes them to
`(0, 0)-(width, height)`, and `boundingSize` derives that rectangle from the quad
itself. There are no wall dimensions anywhere: the owner decided on 2026-09-14
that the frame is the photo.

Three consequences worth stating plainly.

- **The stored photo is never warped.** The matrix is stored on the version;
  the renderer maps holds through `invert()` at draw time and paints them over
  the untouched photo. The one warped copy is DERIVED art the owner can choose to
  show instead (see "Generated wall looks"): made once per version from the
  photo, never replacing it, and always regenerable.
- **A version without anchors stores the identity**, which is the honest answer
  for a wall whose photo *is* its frame. Anchors are optional. Version 1 is the
  only photo a wall takes: later versions are hold edits that reuse its photo,
  anchors and homography exactly.
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

### Recognition service and shared post-processing

The current rollout uses a dedicated homelab Node worker consuming pg-boss
jobs from the writable primary. Mobile requests and resumes jobs over GraphQL;
the physical standby is not a queue endpoint. See
[deployment and exposure gates](spray-recognition-rollout.md) for the pinned
segmentation model, tiling, outlines, retries and native-runtime cleanup.

The box-model measurements below are historical evidence, not the current
segmentation service's inference configuration.

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
#5442). One route, seven steps, behind the mobile flag `spray-walls`.

Two front doors open it: the board picker's Spray wall tile, and "Add my spray
wall" under My own board in the "Where do you climb?" block that Climbs' Find my
board opens for a climber with no boards (#5654, `First Board Path Chosen
{path: 'spray_wall'}`). The launch gate's first-board showing of that block does
not offer it, because the wizard binds without the onboarding `source` and so
would leave first-run open.

| Step | What it does |
| --- | --- |
| `resuming` | Asks `mySprayWalls` for a wall of the caller's own with no published version and offers to pick it up or start over. |
| `meta` | Name, gym, visibility, location, and the angle — snapped to `SPRAY_ANGLES`, because the server validates against that list. |
| `photo` | Library pick; the camera button only on a binary at or past the version that shipped the usage description. Compressed to a 2048 px JPEG, which bakes the EXIF orientation into the pixels. |
| `anchors` | Optional, Skip by default. Four draggable handles with the marked area outlined between them; a quad that crosses itself is refused client-side, because the server's fallback for a degenerate quad is the identity matrix. The photo is fitted on both axes to the space between the header and the footer (`corner-photo-fit.ts`), so all four handles are on screen and the step does not scroll; the footer is the same height before and after the first drag. When that space would fall under about 200 points the photo stops shrinking and the step scrolls instead — reachable on a 375x667 phone with the reset flow's longer copy, not only at large text sizes — and the page is held still while a ring is being dragged, so a drag never becomes a scroll. The hint and the refusal that replaces it share one slot, so a refused quad does not re-fit the photo. The reset flow's corner step is the same component. |
| `upload` | `createSprayWall`, then the multipart POST, then `createSprayWallVersion`. |
| `detect` | Request or resume a server-owned recognition job. New walls can enter manual editing while queued; published reset versions remain unchanged until review and confirmation. |
| `review` → `publish` | `SprayHoldEditorScreen`, then `publishSprayWallVersion`, `invalidateSprayWallRenderData`, and the board bind. |

Three rules in that flow are not obvious from the API and are easy to undo:

- **A wall is created PRIVATE whatever the climber chose, and the choice waits on
  the server.** The row exists from the moment `createSprayWall` returns — the
  photo handler authorises against it — but it has no version, no photo and no
  holds. A wall created public would be a public board with nothing on it for as
  long as the flow takes, and forever if it is abandoned. So the resolver writes
  `user_boards.is_public` / `is_unlisted` false and parks the requested pair on
  `spray_walls.pending_is_public` / `pending_is_unlisted`; the first publish copies
  it onto the board row (and the photo into the public bucket, when public) and
  nulls it. An explicit `updateSprayWall` visibility change before then nulls it
  too — the later choice wins. It used to live only in the wizard's React state,
  applied by an `updateSprayWall` after the publish, so a climber who closed the
  app and resumed the wall published it private whatever they had picked (#5513).
  The wizard still makes that post-publish write, which re-states the choice on a
  backend that predates the pending columns.
- **An unfinished wall is resumed, never duplicated.** Because the row is real, an
  abandoned run counts against `MAX_SPRAY_WALLS_PER_USER`. The resume check has to
  read a list fetched AFTER the screen mounted: React Query serves the cached
  pre-creation list while it refetches, and deciding on that creates a second
  orphan beside the first.
- **Publishing and binding the board are latched apart.** They sit behind one
  button, and `publishSprayWallVersion` refuses a version that has already
  published — so a shared retry would turn a failed board bind into a dead end.

The wizard and reset share `useSprayLeaveGuard`: `usePreventRemove` registers
native dismissal prevention before a gesture can remove the screen, and carries
that protection up to the containing Boards modal. Cancelling keeps the flow
mounted; confirming redispatches the original navigation action. Footer exits
use the same guard, so they ask once. Both routes disable the native back-button
history menu, which does not support removal prevention.

## Caps

| Cap | Value | Why |
| --- | --- | --- |
| `MAX_SPRAY_WALLS_PER_USER` | 10 | Each wall costs a private-bucket photo per version plus a catalogue layout row. Well past what a home climber or a gym needs, low enough that a scripted account cannot fill the bucket. |
| `MAX_HOLDS_PER_WALL` | 1500 | A dense commercial spray wall runs 400–800 holds. The cap bounds what a detector run and a hold-editor session hold in memory at once. |
| `MAX_VERSIONS_PER_WALL` | 50 | Version 1 is the photo; every later version is a published hold edit, and those stop at the first published climb. Each keeps its own hold generation. |
| `MAX_ARCHIVED_SPRAY_WALLS_PER_USER` | 50 | A reset archives the old wall, and an archived wall keeps its photos and catalogue rows. Archived walls do not count toward the 10 live walls, so they need their own bound. Fifty is a monthly reset for four years. See [Archive and reset](#archive-and-reset). |

The first two are reachable by ordinary use — ten walls is a gym with a lot of
bays, 1,500 holds is a dense commercial spray wall — and the version cap can be,
so each is **said out loud with its number** rather than met as "Something went
wrong":

| Cap | Where the climber reads it |
| --- | --- |
| Walls | A hint on the create step, BEFORE it bites (`sprayCaps.wallsHint`), and the refusal itself. Meeting the cap on the publish step with a photo already uploaded is the worst moment to learn it. |
| Holds | The hold editor's save refusal (`sprayEditor.errors.tooManyHolds`). |
| Versions | `sprayCaps.versions`, on `SPRAY_WALL_VERSION_LIMIT_REACHED`. |

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
| `createSprayWallVersion(input)` | A new DRAFT: version 1 from an uploaded photo (solving its homography), or a hold edit on the published photo (`sourceVersionId`). A new photo on a published wall is refused. |
| `upsertSprayWallHolds(input)` | Adds or corrects holds on a draft. A hold with no `id` gets a new catalogue id; one with an `id` has its geometry rewritten. Refused once the wall has a published climb. |
| `removeSprayWallHolds(input)` | Takes holds off as of a draft. Refused once the wall has a published climb. |
| `publishSprayWallVersion(input)` | Makes a draft the generation climbers set against. |
| `resetSprayWall(input)` | Clones the wall for a reset. See [Archive and reset](#archive-and-reset). |
| `setSprayWallRenderSettings(input)` | Stores the wall's default look on `spray_walls.render_settings`, or clears it with `null`. The plain edit gate (below). |
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
unless the input says otherwise**. A wall is somebody's home. Even when the input
does say otherwise, the board row starts private: `isPublic` / `isUnlisted` land on
`spray_walls.pending_is_public` / `pending_is_unlisted` and the first publish
applies them (#5513). A client that sends neither — every binary from before that
fix sends both false — gets a private wall and nothing pending, as before.

### The wall's default look

`spray_walls.render_settings` is a nullable `jsonb` holding
`{ mode: 'classic' | 'aura', boardsesh: BoardseshRenderSettings }` — the look the
creator picked in the add-wall wizard. `SprayWall.renderSettings` returns it on
every wall read. NULL means "no wall default", which is every wall created before
the column existed, and the mobile resolver falls back to the global default for
it. A viewer's own explicit render-mode choice always wins over the wall's.

- **Validated against `@boardsesh/board-look`'s slider bounds**
  (`SetSprayWallRenderSettingsInputSchema`), strict, every knob required.
  `mode: 'default'` is refused: a wall default of "use the default" points at itself.
- **Option knobs take any well-formed name** (`markStyle`, `veil`, …), not only
  the ones this backend's `@boardsesh/board-look` lists. The app ships on its own
  train and can offer an option first: its default spray look,
  `markStyle: 'outline'`, reaches the native train before `main` knows it. Only
  the app reads the value, and it sanitises a name it does not know to that
  knob's default.
- **Read in its own query** (`GET_SPRAY_WALL_LOOK`), never in the shared
  `SPRAY_WALL_FIELDS`. A field a deployed backend does not have yet fails
  validation for the whole operation it sits in; in the shared fragment that
  took down creating, loading and drawing every wall.
- **On `spray_walls`, not `spray_wall_versions`.** A reset does not need a new look,
  so it is current-state config like `reference_width/height`.
- **No wall lock.** No hold, version or publish path reads or writes the column, so
  there is no concurrent writer to order against; the last call wins.

### Generated wall looks

A wall's owner picks what the wall is drawn on, as
`render_settings.background`:

| Value | In the app | What it is |
| --- | --- | --- |
| `photo` (or missing) | Photo | The stored photo, holds mapped through `invert()`. Every wall before this shipped. |
| `wall-crop` | Wall only | The photo flattened into the canonical frame through the version's corner-pin homography. The room falls outside the pinned quad, so there is nothing to mask. The recommended look once the photo passes the quality gate. |
| `hold-cutouts` | Holds only | Only the hold pixels, on a transparent background. Clients draw the Aura field colour behind it (`BOARD_FIELD_COLORS`: `#FFFFFF` light, `#181225` dark), so it reads like an LED board. Volumes are not detected as holds, so they drop out; an owner with volumes uses Wall only. |

Both generated looks are drawn in the CANONICAL frame, the frame hold
coordinates already live in, so a renderer draws holds on them with no
homography: frame = the art's own size, holds scaled by `art.width /
boardWidth`. The pixel maths is `@boardsesh/spray-wall-geometry`
(`clean-art.ts`, `photo-quality.ts`), dependency-free, so the backend job and
the app agree on the frame, the mask and the gate.

**The quality gate.** A photo taken from a sharp angle has to stretch its far
side much more than its near side, and the far side comes out smeared.
`photoQuality` puts one number on that: sample the canonical -> photo map on a
15 x 15 grid over the middle 90% of the frame, take `|det J|` at each sample,
and `stretch = sqrt(max / min)`.

| Verdict | Rule | What the client does |
| --- | --- | --- |
| `good` | stretch <= 1.7 | Offers both generated looks. |
| `soft` | 1.7 < stretch <= 2.2 | Offers them, and nudges "retake front-on". |
| `fail` | stretch > 2.2, no corner pins, or a frame whose short edge is under 1000 px | Offers only the photo. The server refuses a generated background too, so an old or hand-rolled client cannot store one (`SPRAY_WALL_ART_NOT_AVAILABLE`, with the reason). |

The numbers come from a spike over real climbers' wall photos in October 2026:
a near front-on wall (bottom corners pinned 7-8% in from the sides) scored 1.25 and flattened
cleanly; a strongly keystoned one (bottom edge pinned at half the width of the
top) scored 2.87 and its far side was visibly smeared. Both are pinned in
`photo-quality.test.ts`. Pins tapped on the photo's own corners solve to the
identity, so the gate reads the version's PINS, not its matrix: a stored
identity with no pins is "no pins", the same identity from pins is a front-on
photo.

**Where the art lives.** `spray_wall_versions.art` (jsonb, nullable) holds
`{ recipe, status, width, height, cropKey, cutoutKey, quality, error }`, with
status `pending` / `ready` / `failed` / `refused`. The images are in the PRIVATE
bucket beside the photo, under the same `private, no-store` cache rule:

```
spray-walls/<wall uuid>/art/<versionId>-r<recipe>-crop.jpg       (+ @280.jpg thumbnail)
spray-walls/<wall uuid>/art/<versionId>-r<recipe>-cutout.webp    (+ @280.webp thumbnail, alpha kept)
```

Under the wall's own prefix, so the retention purge and account deletion, which
delete the whole `spray-walls/<wall uuid>/` prefix, take the art with the photo.

**The recipe lever.** `ART_RECIPE` (now 1) is in every key and on every row.
Bump it whenever a rendering number changes (dilate 4% of each hold's radius,
feather sigma 6% of the median radius, 32-point circle for an untraced hold,
2048 px long edge). A row whose recipe is not the running one reads as `NONE`
(clients draw the photo). Nothing sweeps every wall on a bump: the job is
re-queued the next time `sprayWallArt` is read for the PUBLISHED version of a
wall whose chosen background is generated, or when the owner chooses one again.
Walls on the photo are left alone. Old objects are never overwritten.

The recipe is also the only way to WITHDRAW art. A READY row of the running
recipe is served whatever the live quality gate says, so tightening
`ART_STRETCH_GOOD_MAX`, `ART_STRETCH_SOFT_MAX` or `ART_MIN_FRAME_SHORT_EDGE`
later only stops new art from being made (and stops owners choosing a
generated look). Art already READY stays on show until `ART_RECIPE` is bumped,
after which the old rows read as `NONE` and a photo that now fails the gate
reads as `REFUSED`.

**The job.** `spray-wall-art` on the `maintenance-delivery` role
(`docs/background-workers.md`), keyed `art:<versionId>:<recipe>`. It re-checks the
gate with the shared function (writing `refused` if it fails), decodes the photo
with sharp, warps it with `warpBilinear`, draws the hold mask as an SVG (each
outline filled and stroked round by twice its grow, which dilates it), blurs it,
joins it as the cutout's alpha, uploads thumbnails before their base images, and
writes `ready`. A failure writes `failed` with a bounded code before it rethrows,
so a retry, or the owner picking the look again, can heal it. A crash, an
expired lease or the run deadline writes nothing, so every `pending` row carries
`requestedAt`; one older than the job's 1 h deadline reads as `FAILED`.

Who queues it:

- **`publishDraftUnderLock`**, inside the publish transaction (a savepoint, so a
  queue failure never fails the publish), for every new generation whatever the
  background, so the owner's picker has art to offer straight away. A photo
  that fails the gate gets `refused` and no job.
- **`setSprayWallRenderSettings`**, when a generated background is chosen and
  the PUBLISHED version has no current art (a wall published before this
  shipped, or a failed run). Before the first publish the choice is checked
  against the newest draft and the publish queues the art. A write that omits
  `background` (every older client sends `{ mode, boardsesh }` only) keeps the
  stored one rather than resetting it to the photo, and is not re-gated.
- **`sprayWallArt` reads**, for the PUBLISHED version of a wall whose chosen
  background is generated, when its art is missing, from an older recipe, or
  `failed` / `pending` past the 1 h deadline (a `failed` row is retried at most
  hourly, not on every read). Queue only, never rendered inline, deduplicated by
  the singleton key, and never for a photo the gate refuses.

Nothing is queued while `spray-wall-art` is in `BATCH_FAMILIES_DISABLED` (every
dev machine): the row stays NULL and the wall draws its photo.

**Reading it.** `sprayWallArt(uuid, version)`, its own query and never a field
on the shared fragments, for the reason the look has its own query. Same gate
as `sprayWallRenderData`: the wall's view rule, then a draft only for an editor.
It returns the live quality verdict (so a client can grey out the choice before
any job has run), the status, the size, and presigned `crop` / `cutout`
`SprayWallPhoto`s when ready.

**Fallback, everywhere.** A client draws the photo whenever the art is not
`READY` for the version it is drawing: no art yet, an older recipe, a failed or
refused run, a backend without `sprayWallArt`, or art for a different version
than the render payload's. The photo is always a correct picture of the wall.

**Public walls have no public copy of the art.** The web page links the art
through the same redirect route the unlisted photo uses
(`/api/v1/spray-walls/{uuid}/photo?look=wall-crop|hold-cutouts`, a fresh
signature per fetch), for public walls too. A world-readable copy would need its
own random key, demotion delete and hide rule, the way the photo's has (SW-14);
that is deferred until a crawler or an unfurler needs the art. OG cards keep
drawing the photo.

### Versions, anchors and the homography

`createSprayWallVersion` takes the `photoId` the upload handler returned and
adopts that object as a draft version. The photo's pixel dimensions come off the
STORED object's metadata, never off the request — they define the canonical frame,
and a client that lied about them would put every hold on the wall at the wrong
place.

For hold edits on the existing photo, supply `sourceVersionId` instead of
`photoId`. Exactly one is required. The source must be this wall's current
published version, checked under the same wall lock that enforces one open draft.
Its photo key, pixel dimensions, anchors and homography are copied exactly;
anchors must be omitted from the request, including when the source has none.
This path makes no upload or storage-metadata request and leaves the canonical
frame unchanged. A missing source photo is refused. Holds are inherited through
the normal version read, keeping their existing ids until an edit supersedes or
removes one. An uploaded `photoId` is for version 1 only: on a published wall it
is the retired in-place reset and is refused (`SPRAY_WALL_RESET_RETIRED`).

Version 1 defines the frame: with anchors it is the anchor quad's bounding
rectangle, without them it is the photo's own pixel box. Later versions are hold
edits and **inherit** the frame, because every existing hold's coordinates are
in it. There are no
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
singular matrix** rather than returning the identity. The one server call site is
the `spray-wall-art` job, which turns the throw into a non-retryable
`SPRAY_ART_SINGULAR_HOMOGRAPHY` failure (the gate refuses most such matrices
first). Any new caller should do the same — surface it as a clear error rather
than catching it into the identity: a corrupt
stored homography that silently becomes the identity renders every hold at the
wrong place, which is far harder to notice than a failed request.

The homography is a 4-point DLT in pure TS
(`packages/backend/src/lib/spray-wall-homography.ts`), nine row-major floats, and
the identity matrix when a version has no anchors. A degenerate quad — anchors
collinear or coincident — also falls back to the identity: a worse map than a
correct one, and a far better outcome than a matrix of NaN that would render every
hold at nowhere. The stored photo is never warped; the client maps holds through
the INVERSE at draw time. Generated art (below) is a separate derived image. SW-06 (#5439) moves the module into
`@boardsesh/spray-wall-geometry` unchanged.

### Adding and removing holds

Holds are only editable on a **draft** version, before and after the wall's
first publish (see [Editing the holds of a live wall](#editing-the-holds-of-a-live-wall)).
Published and superseded versions are immutable, because a climb set against a
published generation reads its holds by id — rewriting that generation's geometry
would silently move every climb on it.

Removal splits two ways, and the split is what keeps history honest:

- a hold the **same draft added** is deleted outright, catalogue rows included: it
  was never on the real wall, the owner drew it and changed their mind;
- a hold installed by an **earlier** version is stamped `removed_version_id` and
  never deleted, because a climb set on it has to stay findable and
  `missing_hold_count` has to stay countable.

`movedFromHoldId` is lineage rather than geometry, and it is scoped against every
hold **this** wall has ever had — not the alive set, because a move's whole point
is that the predecessor has just come off. A pointer at another wall's hold, or at
nothing, would name a predecessor that was never there.

### One open draft per wall

A wall carries **at most one draft at a time**. `createSprayWallVersion` refuses a
second and names the open one; the ways out are `publishSprayWallVersion` and
`discardSprayWallVersion`.

The reason is `spray_wall_holds.removed_version_id`: it is a single column, so two
drafts each marking the same inherited hold removed means the second write wins —
and publishing the FIRST then no longer removes the hold, so a climb that lost it
reads intact. Making removal a range per draft would be a schema change for a
workflow nobody asked for: a wall has one owner and a hold edit is one sitting.

**A discarded draft is DELETED, not marked.** There is no status that works.
`superseded` is the obvious candidate and is exactly wrong — `aliveHolds` treats
any non-draft version as having LANDED, so a discarded draft's additions would come
back as alive and its removals would take effect, which is the abandoned-draft bug
made permanent. A new `discarded` enum value would mean a migration for a state
nothing reads. Deleting leaves nothing to reason about, and is safe precisely
because a draft has never been published: no climb can reference its work. The
discard un-marks what the draft removed, drops the holds it added (catalogue rows
included), then deletes the version row.

### Drafts belong to one editing flow

The single open draft is either initial setup or hold maintenance. Hold
maintenance reuses the current published private photo key and its exact pixel
dimensions, anchors and homography. Any other photo or mapping on a published
wall is a reset-purpose draft, which only the retired in-place reset made. This
is inferred from immutable photo identity, so existing drafts need no migration.
Expiring URL signatures never determine identity.

The plain publish endpoint accepts initial setup and hold maintenance.
`commitSprayWallVersion` accepts initial setup only and refuses hold maintenance
(`SPRAY_WALL_DRAFT_PURPOSE_MISMATCH`). Both refuse a reset-purpose draft with
`SPRAY_WALL_RESET_RETIRED`, under the wall lock. Creating a version with the same
uploaded photo, dimensions, corners and notes returns its existing draft after a
lost response. A different upload or mapping still receives
`SPRAY_WALL_DRAFT_ALREADY_OPEN` and must be explicitly resumed or discarded.

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
| `commitSprayWallVersion` | the version being published, for the hold count (a first publish only) |

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
| `sprayReferenceVisibilityCondition({ boardType, climbUuid }, userId)` | in the WHERE, over the referencing table | the smart-playlist ref queries, `browseProposals`, `globalCommentFeed`, `userProfileStats`, `followingClimbAscents`, `climbLogs` |
| `sprayClimbUuidIsReadable(climbUuid, userId)` | before the query | `comments`, `climbProposals` — the uuid-keyed threads |

It is phrased "there is **no INVISIBLE** spray climb behind this reference"
rather than "there is a visible climb", so a reference whose climb row has gone
survives; and because it starts from the reference, it works in a query that
never mentions `board_climbs` — `userProfileStats` shares one condition list
across three aggregates, one of which selects distinct climb uuids straight off
`boardsesh_ticks`.

`followingClimbAscents` (the play drawer's "Climber logs") takes the predicate
from `climbLogConditions` in
`packages/backend/src/graphql/resolvers/social/climb-log-query.ts`, which is the
one array both its list query and its count query spread. That is deliberate: a
count without the predicate would tell a follower that people log on a wall they
cannot see. A climb on a hidden wall answers exactly like a climb nobody has
logged (empty list, zero counts, no error).

`climbLogs` (the "Everyone" section of the same list) is the PUBLIC sibling: no
sign-in needed, and the caller names the climb. It spreads the same
`climbLogConditions` array, and on its one-row-per-climber path the array sits
inside the window's own WHERE, so a hidden log can neither be returned nor be
the row that represents a climber. The viewer id handed to the predicate is null
unless the request is authenticated. A wall the caller cannot see, an unknown
climb and a board-type mismatch all return the same empty page. It has no row in
the sweep's allow-list: `spray-visibility-sweep.test.ts` enumerates it like any
other reader, and `climb-logs.test.ts` runs each wall state against both paths.

The reference form alone is not enough there. It passes a spray tick whose
`board_climbs` row is missing, for every viewer, and a climb row does go missing:
deleting a wall is a soft delete that keeps its climbs, but `deleteDraftClimb`
and account deletion (which removes the deleted user's drafts) hard-delete the
climb and leave its ticks. With no climb there is no wall to check, so
`climbLogConditions` adds a second condition that fails closed: a spray tick is
returned only when its climb row still exists. Other board types keep the lenient
behaviour, because an Aurora tick can arrive before its climb. Any new per-climb
log reader imports `climbLogConditions` rather than writing its own.

#### References to a hard-deleted climb

That second condition is `sprayReferenceClimbExistsCondition`, next to the
reference form in `spray-visibility.ts`. It needs a board type on the
referencing row, and takes an optional author exemption (the row's author
column and the viewer) for readers where a climber is reading their own rows.
The readers in the table above were audited for this case in #5981:

| Reader | A reference to a hard-deleted spray climb |
| --- | --- |
| `followingClimbAscents`, `climbLogs` | hidden from everybody (`climbLogConditions`) |
| `browseProposals`, `climbProposals` | hidden from everybody; `climbProposals` answers the empty page |
| `comments` on a proposal | empty page (`sprayProposalUuidIsReadable`) |
| `globalCommentFeed`, proposal threads | hidden from everybody: the proposal carries its board type |
| `globalCommentFeed`, climb comments | hidden from everybody, **on every board** (below) |
| `userProfileStats` | hidden from everybody but the climber whose log it is |
| `activityFeed` | hidden from everybody. A comment on a proposal fans out with the climb's name, frames and layout id in the feed row's metadata; the row's own `boardType` says spray once the climb cannot |
| the smart-playlist ref queries | not gated. Hydration reads `board_climbs`, so no row is returned; only `totalCount` can include it |
| the stats and grade readers (`climbStatsForAngles` and friends) | nothing to read: the stats rows are deleted with the climb, and the recompute seed only inserts for a climb that has a row |
| `comments` on a climb or a tick, keyed by uuid | not gated. A comment has no board type, and the caller must already hold the uuid |
| `climbCommunityStatus`, `voteSummary` | not gated. Numbers for a uuid the caller already holds (`openProposalCount`, `communityGrade`, vote counts) |

A comment row has no board type, so there is no spray-only version of the rule
for a climb comment. `globalCommentFeed` lists a climb comment only while its
climb still has a `board_climbs` row. That hides more than spray:

- a comment on a deleted draft, on any board;
- a comment on an upstream climb that `clearAuroraBoard` removed and a re-import
  did not restore.

Both stay readable through `comments(entityType: climb)` for a caller holding
the uuid. There is no alias arm: a deduplicated climb keeps its `board_climbs`
row (the MoonBoard merges delist the loser and repoint its comments at the
survivor), so no comment sits under an alias uuid that has no row. The
board-filtered feed already required the row, so the two paths now agree.

The uuid-keyed checks (`sprayClimbRowExists`, `sprayProposalUuidIsReadable`)
read the replica like their neighbours. A spray climb created inside the
replication lag answers the empty page for its proposals until the replica has
the row.

`userProfileStats` is the one reader with the author exemption. The others list
rows written by other people, so nobody is exempt. A profile's totals are the
climber's own numbers, their logbook still lists the log as "Unknown Climb", and
totals that dropped it would disagree with that logbook. The web profile's
server render fetches the stats with no viewer, so the owner's first paint omits
the log until the signed-in client fetch replaces it; the same already holds for
their logs on a private wall.

**The logbook readers** LEFT JOIN `board_climbs` and use the column form, and
`IS DISTINCT FROM 'spray'` is true for a missing climb. That is right for the
other boards, where such a log renders as "Unknown Climb", and wrong for spray.
They carry `sprayTickClimbExistsCondition(viewer)`
(`packages/backend/src/graphql/resolvers/shared/spray-tick-visibility.ts`), which
is the reference condition above keyed on the tick, with the author exemption
(#6031):

| Reader | A log on a hard-deleted spray climb |
| --- | --- |
| `userTicks`, `userAscentsFeed`, `userGroupedAscentsFeed` | the climber who logged it only; rows, totals and groups |
| `globalAscentsFeed` | the climber who logged it only |
| `followingAscentsFeed` | nobody: the feed lists the people a viewer follows, never the viewer |
| `sessionDetail` | the climber who logged it only; a session of nothing else answers null to everybody else |
| the session summary's hardest send | the climber who logged it only |
| `gymStats` top climbs | nobody (the reader has no viewer) |

**The session cards** (`sessionGroupedFeed`, and the crew feed built on it)
choose a tick first and join `board_climbs` afterwards: the session's hardest
send, a day's highlight, the featured beta. A wall rule in that join only nulls
the climb's columns. The tick that was chosen still carries its own uuid, climb
uuid and comment, and a beta link its url, so for a live private wall as much as
for a deleted climb the card handed those to anybody. The whole rule,
`sprayTickVisibleSql(alias, viewer)`, now sits where the tick is CHOSEN:

| Query in `social/session-feed.ts` | What it leaves out for a viewer who may not see the wall |
| --- | --- |
| `fetchHardestSendsBatch`, the `ranked` CTE | the send is not a candidate; the next hardest visible send is picked |
| `daily_hardest` in `getSessionFeed` | the log is not the day's highlight; a day of nothing else has no card |
| `fetchSessionFeaturedBetaRows`, `fetchDailyFeaturedBetaRows` | the beta link is not a candidate |
| `fetchTickHighlightsByUuid` | a uuid that reached it some other way is not hydrated |

Still not gated, and the same for a live private wall and a deleted climb:

- the session cards' and the session summary's COUNTS (tick count, sends, grade
  distribution, board types, participants) include every tick in the session;
- `sessionDetail`'s participant list is built from every tick, while its rows
  and totals are filtered;
- `userTickCountsByBoard` returns a count per board type, spray included. Its
  own comment calls counts non-sensitive, so that one is a product decision;
- `comments` on a tick, `climbCommunityStatus` and `voteSummary` answer a caller
  who already holds the uuid.

The smart-playlist ref queries can still count a reference to a deleted climb in
`totalCount`; no row is returned.

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

`boardBySlug(slug, wallUuid)` takes the share link's `?wall=` as `wallUuid`. When
it is the uuid of the row the slug resolved to, the lookup uses `'capability'`
instead, so www's `/b/{slug}/...` pages can open an unlisted wall for whoever
holds the link. A uuid that names a different wall is ignored, so the answer is
the same as a request without one. A private or hidden wall stays shut to
everybody but its owner (and its gym). www's layouts under `/b/[board_slug]/[angle]` do not
resolve the board, because a layout never sees the query string; each page
resolves it with the capability and runs `resolveSprayWallAccess`
(`packages/web/app/lib/spray/spray-visibility.ts`) on the row. That page-side check
is still needed because a signed-in owner gets their unlisted row without a uuid,
and these paths carry a shared `s-maxage`. Every such page is `noindex, follow`
with no canonical and no OG card, so the uuid only appears in the URL the reader
already has.

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

#### Writing to a climb is a fifth rule

The read side cannot leak a wall whose existence it never confirms, but a write
that accepts the climb anyway answers "found" versus "not found" — an existence
oracle in the error message — and lands rows that the reads then have to keep
masking. So the same by-layout rule sits in front of the writes too (#6032):

| Write | Where the gate lives | Answers |
| --- | --- | --- |
| `createProposal`, `reportClimb` | `loadTargetClimb` (`social/proposals/lifecycle.ts`) — `sprayClimbVisibilityCondition` in the load's WHERE, plus the draft/unlisted check `validateEntityExists` already applies to comments, on every board type | `Climb not found`, the same words a missing uuid gets |
| `saveTick` | one primary read before the insert, spray-only — the climb row must exist and the wall must be visible, with the tick's `boardUuid` honoured as the unlisted capability | `Climb not found` with code `CLIMB_NOT_FOUND`, which the offline drainer treats as permanent: a replay whose climb was hard-deleted dead-letters on attempt one |
| the feed fan-out | `getProposalContextMetadata` and the tick/climb branches of `getCommentContextMetadata` (`events/feed-fanout.ts`) skip rows whose climb is a draft, and whose spray wall may not announce | nothing written |

Proposals carry no wall-uuid input, so unlike `saveTick` they get no unlisted
capability — exactly as comments already treat an unlisted wall. And the fan-out
gate is the WALL's rule ("public and unhidden", the same `publishesFeedEvents`
answer `saveClimb` and `saveTick` consult before they announce), never a
per-recipient one: the fan-out writes rows for many readers at once, and which
reader may see their own rows stays the read side's job.

`packages/backend/src/__tests__/spray-write-visibility.test.ts` pins all of it,
including the oracle itself: an invisible wall and a uuid with no row must answer
with identical text.



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
Bluetooth scan on a photograph. `updateBoard` refuses a change to `hasLeds` or
`isAngleAdjustable` on a spray board (`SPRAY_WALL_HAS_NO_HARDWARE`, #5483), so the
flag cannot be unpinned through the ordinary board door either.

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

## Editing the holds of a live wall

A wall's holds stay editable after it is published, whether or not climbs are set
on it. The owner (or anyone `requireBoardEditAccess` lets edit the wall) opens a
hold-edit draft on the published photo (`createSprayWallVersion` with
`sourceVersionId`), adds, moves or removes holds on it, and publishes it.

Removing a hold that climbs use is the owner's call, confirmed in the app first:

1. Before it removes (or moves) holds, the hold editor asks
   `sprayWallHoldUsage(wallUuid, holdIds)` how many published and draft climbs use
   each one (see [The `SprayWall` fields](#the-spraywall-fields)).
2. When published climbs use one, the app asks the climber to confirm.
3. On yes, the publish stamps the removal, and the recompute in
   `publishDraftUnderLock` raises those climbs' `missing_hold_count`.

The usage check is advisory: a climb published between the check and the publish
is marked lost without a warning. The authoritative after-the-fact count is
`climbsChanged` from the publish: in `commitSprayWallVersion`'s result, and in the
server's publish log line (`publishSprayWallVersion` returns only the version).

What a climb that lost a hold gets:

- **It stays listed**, in the wall's climb list and search, with a badge from
  `Climb.missingHoldCount`. It still opens by uuid (logbook, playlist, share
  link, queue).
- **The Holds filter works again** (`ClimbSearchInput.holdIntegrity`): ANY adds
  no filter, INTACT keeps `COALESCE(missing_hold_count, 0) = 0`, BROKEN keeps
  `> 0` (`holdIntegrityCondition` in
  `packages/db/src/queries/climbs/create-climb-filters.ts`), drafts included. On a
  catalogue board every climb reads intact, so BROKEN there is the empty list.
  The default view still hides climbs a full in-place reset retired
  (`retiredByResetCondition`), as before.
- **It can be remixed** through the app's generic fork route. `Climb.lostHolds`
  returns each removed hold's last geometry (centre, radius, outline, the
  version that installed it and the one that removed it), and the remix editor
  draws it as a grey ghost that has to come off before the remix saves.
  `lostHolds` is resolved per climb and only for a spray climb whose
  `missingHoldCount` is above 0; it counts a removal only once the version that
  made it has published, and a wall the viewer may not see answers `[]`.
- **Its setter can fix it** inside their 24 hour window by moving it onto holds
  that are there; `updateClimb`'s per-climb recompute brings the count back to 0.
  A draft is fixable at any time.

## Resets

A reset is a clone: a new wall with the old wall's settings, a new photo and
holds marked from scratch. Its first publish archives the old wall. The whole
flow, its caps and what an archived wall refuses are in
[Archive and reset](#archive-and-reset).

The in-place reset is retired: a new photo on a published wall, matched against
the old one, with kept / removed / added decisions and a partial or full flag.
Lost holds and remixing stay, now driven by hold edits on the published photo
(see [Editing the holds of a live wall](#editing-the-holds-of-a-live-wall)). What
is left of the reset on the server:

- `createSprayWallVersion` with a new `photoId` on a published wall refuses with
  `SPRAY_WALL_RESET_RETIRED`, "Resets changed. Update Boardsesh, then use Reset
  wall." A new photo is only for a wall's first version: the add-wall wizard and
  a reset clone.
- `proposeSprayWallReset` always refuses the same way.
- A **reset-purpose draft** (a draft whose photo is not the published one) that
  the old flow left on a live wall cannot be published through either
  publish mutation. `discardSprayWallVersion` still deletes it and un-marks
  whatever it had taken off.
- `commitSprayWallVersion` still does a wall's **first** publish, because an
  older app may send it there. It accepts the decision lists and `fullReset`
  and ignores them, and answers `keptCount` = the holds the draft carries,
  `removedCount` 0, `addedCount` 0.

Both installed apps (2.5.0 on `main`, the 2.6.0 beta on `release/next`) publish a
new wall through `publishSprayWallVersion`, and only their reset screen calls
`commitSprayWallVersion`. Both first-publish paths are covered by
`spray-wall-retired-reset.test.ts`, for a wizard wall and for a reset clone.

The hold matcher (`matchHolds`, `suggestMoves`, the Hungarian solver) is gone
from `@boardsesh/spray-wall-geometry`; nothing else imported it.

### The generation rule

A hold generation counts only once its installing (or removing) version has
**landed**: `status <> 'draft'`, or it is the version being asked about. Both
`aliveHolds` and `recomputeMissingHoldCounts` carry that bound on both ends.

Without it, an abandoned draft poisons the wall forever. Version numbers are dense
per wall and handed out when a draft is created, so a draft nobody ever published
still owns a number: publish v1, start a hold edit as v2 and walk away, publish
v3, and v2's additions would come back as alive holds nobody ever screwed to the
wall, while its removals would badge every climb through them as broken with no
way back.

`discardSprayWallVersion` therefore **deletes** a draft rather than marking it.
There is no status that would work: `superseded` is read as landed, so a discarded
draft's work would take effect, which is the abandoned-draft bug made permanent.

### Climbs that lost holds to an old reset

Climbs whose `missing_hold_count` an in-place reset raised before it was retired
are treated like any other climb that lost a hold (see
[Editing the holds of a live wall](#editing-the-holds-of-a-live-wall)): listed with
a badge, found by the Holds filter, remixable with `Climb.lostHolds`. The climbs a
FULL reset retired (`retired_by_reset`) still leave the default view, as before.

## Archive and reset

The only way to reset a wall. Changing a live wall in place turned out to be hard
to follow for climbers, so a reset is a **clone**: a new wall with the old wall's
settings, a new photo and holds marked from scratch. When the new wall is
published, the old one is **archived**. The in-place reset is retired (see
[Resets](#resets)).

Holds stay editable on a live wall, published climbs or not (see
[Editing the holds of a live wall](#editing-the-holds-of-a-live-wall)).

### The two columns

| Column | Meaning |
| --- | --- |
| `spray_walls.archived_at` | When a reset replaced this wall. NULL for a live wall. |
| `spray_walls.reset_from_wall_id` | The wall this one was cloned from. Self-reference, `ON DELETE SET NULL`, with a partial index where it is not null (almost no wall has one). |

Migration 0257 adds both. Nothing is dropped or rewritten.

### `resetSprayWall`

`resetSprayWall(input: { wallUuid })` returns the clone as a `SprayWall`.

- **The owner only.** `board.ownerId` must be the caller. A gym admin or a
  community leader, who can edit the wall's holds, gets
  `SPRAY_WALL_RESET_OWNER_ONLY`; replacing the wall is the owner's call. A
  caller who cannot see the wall gets `SPRAY_WALL_NOT_FOUND`, like every other
  wall read.
- **A published, live wall.** A wall with no published version gets
  `SPRAY_WALL_RESET_SOURCE_UNPUBLISHED`, an archived one gets
  `SPRAY_WALL_ARCHIVED`, a deleted one is not found. A wall an admin has hidden
  gets `SPRAY_WALL_RESET_HIDDEN` ("This wall is hidden while a report is
  reviewed, so it can't be reset yet."): a reset copies the audience and
  carries the followers over, so it would put the wall straight back in front
  of them.
- **Idempotent.** Under the owner's account lock and then the old wall's lock,
  it looks for a live clone of this wall that has not been published yet and
  returns it. A retry, or the owner coming back to the wizard, gets the same
  clone, never a second one.
- **Settings only.** The clone is made by `insertSprayWallRows`, the same
  function `createSprayWall` uses, so its catalogue rows, board row and slug are
  made exactly like any new wall's. It copies the name, description, angle,
  location fields and the stored look (`render_settings`). The retired climb
  edit policy is not copied. The gym link and `hide_location` are copied as they were when the
  reset started; a later change to the old wall does not follow. No photo,
  version, hold or climb is copied.
- **Visibility.** The old wall's visibility is parked on `pending_is_public` /
  `pending_is_unlisted`, so the clone is private until its first publish, like
  any new wall (#5513). At that publish the clone gets the NARROWER of the
  parked pair and the old wall's visibility at that moment (private, then
  unlisted, then public and unlisted, then public; a tie keeps the parked
  pair). An owner who makes the old wall private mid-reset publishes a private
  new wall, and an old wall made WIDER mid-reset does not widen the clone. An
  old wall an admin hid in between counts as private. A deleted old wall still
  bounds the clone by the flags it last had, so narrowing it and then deleting
  it cannot widen the clone back.
- **An explicit choice opts out of narrowing.** Once the owner states a
  visibility for the clone itself through `updateSprayWall`, the parked pair is
  dropped and the clone's own board row is what publishes, unnarrowed. Narrowing
  exists to catch a stale parked copy of the old wall's audience, not to
  overrule a choice the owner made for the new wall, and dropping the pair makes
  the result the same whichever wall the owner edited first.
- **Caps.** The clone skips the 10-wall live cap, because a reset nets to zero
  live walls once it publishes. It counts against
  `MAX_ARCHIVED_SPRAY_WALLS_PER_USER` (50) instead: the count is the owner's
  archived walls plus their unfinished clones, since each of those will archive
  one more wall. At 50 the call is refused with
  `SPRAY_WALL_ARCHIVE_LIMIT_REACHED`. The create-wall rate limit (5 a minute)
  applies. Archived walls also do not count toward `MAX_BOARDS_PER_ACCOUNT`
  (50 boards, `assertBoardCapNotReached`), so resets never block `createBoard`
  or the BLE auto-mint.

Until the clone is published, the old wall is untouched. An abandoned clone, or
one the owner deletes, leaves the old wall live and listed, and the next
`resetSprayWall` starts a new clone.

### Archive at first publish

`publishDraftUnderLock` reads `reset_from_wall_id` with the rest of the wall.
On the clone's FIRST publish (both `publishSprayWallVersion` and
`commitSprayWallVersion` go through it), in the same transaction:

1. it takes the old wall's lock, while already holding the clone's, and reads
   the old wall's visibility to narrow the clone's (above);
2. stamps `archived_at` (and `updated_at`) on the old wall, if it is not
   already archived or deleted;
3. copies the old board's `board_follows` rows, its pins
   (`user_board_activity.pinned_at`) and its new-climb subscriptions
   (`new_climb_subscriptions`, keyed by layout, so the old ones would never fire
   again) onto the clone.

They only go to people the clone is shared with. A follow and a subscription
carry over on the `followBoard` rule (a public board, or its owner). A pin
carries over to the owner, to everyone on a public board, and to members of the
board's gym. An existing activity row on the clone keeps its pin and gains one
if it had none. Nothing carries to strangers on an unlisted or private clone.

Deleting the published successor later does NOT un-archive the old wall. That
is intended: the old wall's photo no longer matches a real wall.

**Lock order is new wall, then old wall.** A clone is always inserted after its
source, so it has the higher id. `deleteAccountSprayWalls`, the only other path
that holds two wall locks at once, walks walls highest id first to match.
`resetSprayWall` takes the account lock, then the old wall's lock, which is the
order account deletion uses too.

### What an archived wall refuses

Each check reads `archived_at` under the wall lock, so a write either commits
before the archive or sees it. The refusal is `SPRAY_WALL_ARCHIVED`, "This wall
is archived. Its climbs stay, but nothing new can be set on it."

| Refused | Still allowed |
| --- | --- |
| `saveClimb`, every `updateClimb` (including publishing a draft) | `saveTick` (the offline drainer would dead-letter a refusal) |
| `createSprayWallVersion`, and a photo upload to `/api/spray-wall-photos` (409, before and after the bytes land) | `deleteDraftClimb` |
| `upsertSprayWallHolds`, `removeSprayWallHolds` | `discardSprayWallVersion` |
| `publishSprayWallVersion`, `commitSprayWallVersion` | `updateSprayWall`, `setSprayWallRenderSettings`, `deleteSprayWall` |

`viewerCanEditClimbs` is false on every wall now, archived or not (see
[What an older app gets back](#what-an-older-app-gets-back)). `viewerCanEdit`
stays true for the owner, because it also gates renaming and deleting the wall,
which an archived wall still allows.

### Where an archived wall shows up

Left out of:

- `listableSprayWallCondition` (both branches), so `myBoards`, `searchBoards`
  and `gymBoards`. The archived test sits outside the owner escape, so the
  owner's own pickers drop the wall too;
- `sprayWallIsListable`, so `gymSprayWalls`;
- `boardDiscovery`, the www homepage rail;
- a gym kiosk's slots (`resolveKioskView` skips the board like a deleted one);
- the public spray wall sitemap. An archived public wall's climb pages leave
  the climb sitemap with it, which is intended: the successor is the page worth
  crawling;
- the 10-wall live cap in `createSprayWall`, `MAX_BOARDS_PER_ACCOUNT`, and a
  gym's `boardCount`;
- a gym kiosk layout write (`assertLayoutBoardsInGym` refuses a slot or
  leaderboard naming an archived wall, matching the read side).

Deliberately still counted: a gym's `boardTypes` and angle chips, the gym
directory's board type filter, and the admin duplicate and stray-board tools.
The successor has the same type and angle, so the chips and the filter come
out the same either way, and the admin tools are about rows, archived or not.

Still returned by: `sprayWall`, `sprayWallByLayout`, `sprayWallRenderData`,
`board`, `boardBySlug`, `mySprayWalls` (where the owner finds archived walls),
`syncSprayWalls`, climb sync, and every climb, tick, playlist, feed and logbook
read.

**Archived is not deleted.** Every spray climb visibility predicate in
`packages/db/src/queries/climbs/spray-visibility.ts` tests `sw.deleted_at`,
never `archived_at`, so an archived wall's climbs keep resolving everywhere. A
test reads search, the climb, a logbook, render data, the layout lookup and
both syncs on an archived wall, so adding `archived_at` there goes red.

An offline device learns a wall is archived from the wall payload
(`archivedAt`), not from its SQLite mirror, which has no column for it.

### The `SprayWall` fields

| Field | Meaning |
| --- | --- |
| `archivedAt` | ISO time of the archive, or null. |
| `resetOfWallUuid` | The wall this one was cloned from, if it is not deleted, and only for a viewer who can see that wall without its uuid: its owner, a member of its gym, or anyone when it is public. |
| `replacedByWallUuid` | The live, PUBLISHED clone that replaced this wall, null while the clone is unfinished. Shown to a viewer who can see the successor without its uuid, plus one carry-forward: when the old wall is unlisted and NOT public, and the successor is unlisted too, someone holding the old share link is shown the new one. Old to new only. |

`mySprayWalls` and `gymSprayWalls` read these fields for every wall in two
queries (`loadSprayWallArchiveFacts`), not two per wall.

`sprayWallHoldUsage(wallUuid, holdIds)` answers one row per distinct requested
hold (at most 500 per call): `publishedClimbCount` (listed, non-draft) and
`draftClimbCount`, from `board_climb_holds` joined to this wall's climbs.
Hidden climbs and climbs a full reset retired are not counted. It takes the
same gate as editing the holds and refuses an archived wall with
`SPRAY_WALL_ARCHIVED`.

These fields are in the SDL only. The shared `SPRAY_WALL_FIELDS` selection does
not ask for them yet, so a client built against it keeps working against a
backend that has not deployed them.

### Generated wall art

Art (`spray_wall_versions.art`, migration 0256) is generated per published
version and requested inside `publishDraftUnderLock`, so a reset clone's first
publish requests art for the clone exactly as any new wall's does, and the clone
copies the old wall's `render_settings` (including a generated `background`)
like every other setting. If the clone's photo fails the quality gate, the
read-side fallback draws the photo. An archived wall gets no new art: no version
can be published on it, and the two backfills (`sprayWallArt` on read and
`setSprayWallRenderSettings`) skip an archived wall. Its existing art keeps
rendering.

### Known gaps

- A kiosk slot that named the old wall is not repointed to the successor. The
  kiosk layout is a validated JSON blob (unique slots, a leaderboard board that
  must be one of them), so repointing is a rewrite, not an UPDATE. The slot
  simply drops the archived wall until a gym editor places the new one.

## What an older app gets back

The retired calls and fields stay in the schema, marked `@deprecated`, with their
types and nullability unchanged, so 2.5.0 and the 2.6.0 beta keep validating
against this backend. Each answers like this:

| Call or field | Answer |
| --- | --- |
| `createSprayWallVersion` with a new photo on a published wall | `SPRAY_WALL_RESET_RETIRED`, "Resets changed. Update Boardsesh, then use Reset wall." |
| `proposeSprayWallReset` | `SPRAY_WALL_RESET_RETIRED`, same message |
| `publishSprayWallVersion` / `commitSprayWallVersion` of a reset-purpose draft | `SPRAY_WALL_RESET_RETIRED`, same message |
| `commitSprayWallVersion` of a wall's first draft | Publishes it. `kept`, `removed`, `added` and `fullReset` are ignored. |
| `createSprayWallVersion` (hold edit), `upsertSprayWallHolds`, `removeSprayWallHolds`, a later publish | Work as before, climbs or not. A removal under published climbs gives them a lost hold. |
| `updateClimb` by anyone but the setter | `CLIMB_EDIT_NOT_ALLOWED`, "You can only update your own climbs" |
| `updateClimb` by the setter more than 24 hours after first publish | `CLIMB_EDIT_WINDOW_EXPIRED`, "The 24 hour edit window has expired" |
| `Query.climbRevisions` (`[ClimbRevision!]!`) | `[]` |
| `climbCurrentRevision` on `AscentFeedItem`, `FollowingAscentFeedItem`, `ClimbLogItem` (`Int`) | `null`, which hides the "Earlier version" tag |
| `Query.remixClimb` (`SprayRemixSeed`) | `null` |
| `Climb.lostHolds` (`[SprayWallHold!]`) | Live, not retired: the removed holds' last geometry on a spray climb that lost holds, `[]` on an intact one, `null` on every other board and when `missingHoldCount` is unknown (a fetch path that does not project the column) |
| `SprayWall.climbEditPolicy` (`SprayClimbEditPolicy!`) | `SETTER` |
| `SprayWall.viewerCanEditClimbs` (`Boolean!`) | `false` |
| `CreateSprayWallInput.climbEditPolicy`, `UpdateSprayWallInput.climbEditPolicy` | Accepted and not written. No owner-only refusal. |
| `SaveClimbInput.remixOfClimbUuid` | Accepted and ignored on every board. No lineage row. |
| `ClimbSearchInput.holdIntegrity` | Live, not retired: ANY no filter, INTACT the climbs that lost nothing, BROKEN the ones that lost a hold |
| `Climb.missingHoldCount`, `Climb.revisionNumber`, `Climb.holdsRevisionNumber`, `Tick.climbRevision`, `SaveTickInput.climbRevision` | Unchanged: the stored values, and a tick is still stamped. |

`SPRAY_WALL_RESET_REVIEW_REQUIRED`, `SPRAY_WALL_ANCHORS_REQUIRED` and
`SPRAY_WALL_CLIMB_EDIT_POLICY_OWNER_ONLY` are no longer sent. `saveTick` is never
refused by any of this.

What a climber on an older app sees, known and accepted until the app update:

- **The 2.6.0 beta calls the reset "New photo"**, while the refusal says "Reset
  wall", the new app's name for it.
- **Its who-can-edit toggle reads back as setter-only** whatever the owner picks,
  because the policy is not written and every wall answers `SETTER`.
- **A new photo on a published wall with no climbs is refused too.** Decision:
  the owner uses Reset wall, which works on any published wall, climbs or not.

### Kept, not written

Nothing is dropped and there is no migration. These stay in the database, pending
a separately approved cleanup:

| Table or column | Written now? |
| --- | --- |
| `board_climb_revisions` | No |
| `spray_climb_lineage` | No |
| `spray_walls.climb_edit_policy` | No (new walls take the column default, `setter`) |
| `spray_wall_versions.is_full_reset` | No (new versions take the default, `false`) |
| `board_climbs.revision_number`, `holds_revision_number` | No. Frozen at their stored values; the holds-epoch reads still use them. |
| `spray_wall_holds.moved_from_hold_id` | Yes, by the hold editor: a correction to an inherited hold links its successor |
| `board_climbs.missing_hold_count`, `retired_by_reset` | Yes, by the publish recompute and by `updateClimb`'s per-climb recompute. A hold-edit publish that removes a used hold raises the count; `retired_by_reset` only moves for climbs an old full reset touched. |
| `boardsesh_ticks.climb_revision` | Yes, by `saveTick`, as before |

The device still mirrors `missing_hold_count`, `revision_number`,
`holds_revision_number`, `retired_by_reset` and the tick's `climb_revision`.
`syncClimbs`, tick sync and the snapshot export keep shipping the stored values.

## Photo privacy

### Device cleanup

Sign-out withdraws every registered wall and clears renderer photographs in
`{cache}/spray-walls`, durable offline photographs in
`{document}/spray-wall-photos`, and spray PNGs in `board-thumbnails`. Catalogue
board PNGs remain. Removing a downloaded wall or receiving its deletion
tombstone withdraws only that layout, including all cached photo versions and
its overlays. A loader discovering that a wall is no longer readable uses the
same withdrawal path. Filesystem cleanup still runs without an offline database
and when the SQLite sign-out wipe fails.

Session and per-wall generations fence pending downloads and render results.
Partial photo downloads use generation-specific destinations; a late transfer
removes its own partial rather than publishing it or erasing a replacement.
Selective renderer cleanup recognizes legacy wall/version names and staging
names with the producer's launch nonce and two epoch counters. Offline photo
sinks skip rows with non-finite layout IDs rather than persist unfenced photos.
Spray overlay destinations include a launch nonce and privacy generation, so a
late native render cannot overwrite another session's PNG. Stale completions
delete their own PNG and never enter the synchronous overlay index. Warm-up
rejects legacy spray PNGs and those from earlier launches. Catalogue cache keys
remain unchanged.

Registry withdrawal preserves the installed loader and subscribers. Loader
replacement and teardown fence pending work independently, and query keys
include privacy generations so a new session cannot join an old request.
The installed loader also removes all cached epochs of the withdrawn wall's
layout identity, UUID identity, published/draft render data and version history.
Known version IDs allow selective reset-proposal removal; a version-only pending
proposal without cached wall history cannot be mapped to a layout and is not
covered by single-wall removal. Global withdrawal removes these spray query
families. Other walls and catalogue queries survive selective withdrawal.
Removal destroys matching pending queries, preventing late responses from
recaching payloads. A link response whose layout was unknown at withdrawal is
removed by its exact old query key when its revocation check fails.
Persisted editor drafts keep version-only keys, allowing recovery after an app
restart. Cleanup is best effort: failed filesystem deletion is retried by later
withdrawal or cache sweeping; a crash during native I/O can leave a partial until
the next cleanup.

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

**Two sizes per photo (#5911).** The hold editor zooms to 8×, where a 2048 px
photo shows about 190 photo pixels across a phone screen and a small hold goes
soft. So a photo larger than 2048 px on its long side is stored twice:

| Object | Key | Long side | Read by |
| --- | --- | --- | --- |
| Base | `spray-walls/<wallUuid>/<photoId>.jpg` | ≤ 2048 px (`SPRAY_WALL_PHOTO_BASE_MAX_DIMENSION`) | the canonical frame, the hold detector, the climb view, search, offline sync, the public copy |
| Thumbnail | `<base key>@280.jpg` | 280 px square | list rows, the reset compare view |
| Full | `spray-walls/<wallUuid>/<photoId>-full.jpg` | ≤ 4096 px (`SPRAY_WALL_PHOTO_FULL_MAX_DIMENSION`) | the hold editor, once zoomed past the base's resolution |

- **The base keeps every number it had.** The response's `width`/`height` and
  the base object's metadata are the BASE's, so `createSprayWallVersion`, the
  canonical frame and every hold coordinate stay in the base's pixels. The full copy
  is the same picture with more pixels, never a different frame: a client scales
  it down to the base's size and draws holds exactly as before.
- **No full copy for a photo that already fits.** A source at or under 2048 px
  is stored once, as before. Both sizes are resized from the source, so the base
  takes one JPEG generation and the full copy goes through the same
  `rotate()` + re-encode that strips EXIF and GPS.
- **Write order:** thumbnail, full, base. A reader who can see the base can see
  both copies.
- **The full key is derived from the base key** (`sprayWallFullPhotoKey`), never
  stored. Every path that follows `photo_key` follows the copy for free: a
  `sourceVersionId` version reuses the key, the purge and account deletion erase
  the whole `spray-walls/<wallUuid>/` prefix, and a withdrawn upload erases every
  key it wrote. SW-14's public promotion copies the BASE only; the full copy is
  never public.
- **`SprayWallRenderData.photoFullUrl`** is the presigned GET, minted with the
  base's and expiring with `photo.expiresAt`. It is on the render payload and not
  on `SprayWallPhoto`, so version lists and moderation previews never pay for it.
  It is null when the version has no full copy. A base whose long side is not
  exactly 2048 px cannot have one, so most versions cost no storage call; the rest
  (including every pre-#5911 photo the app compressed to exactly 2048 px) get one
  `HEAD` per key per backend process, remembered after because the answer never
  changes for a key. An outage reads as null and is not remembered. No column
  records it, because the check costs less than a migration and a backfill.

Every stored object carries **`Cache-Control: private, no-store`**.
`uploadToS3` defaults to `public, max-age=31536000, immutable`, which is right for
an avatar and catastrophic here: a shared cache would keep serving the photo long
past the 15-minute presign that is supposed to BE the access control, and past the
owner making the wall private. The public-promotion copy SW-14 (#5447) writes to
`media` is the only place a long lifetime may ever be set.

The cap is 15MB (10MB before #5911 raised the app's upload to 4096 px), `files: 1`, the magic bytes decide the format regardless of the
declared Content-Type, and the caller must **own** the wall — not merely be able
to edit it. Nobody uploads a photograph of a stranger's living room.

There is also a **per-user budget of 20 uploads per 10 minutes**, answering `429`
with a `Retry-After: 600` once it is spent. It is the `feedback-screenshots.ts`
pattern and it is here for the same reason: every POST mints a NEW object, so one
authenticated account could otherwise fill the private bucket with 15MB objects,
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
| `sprayWallReports(uuid)` | Admin-only pending queue, newest first, excluding deleted walls and deleted board rows. Each report includes `wallName` and a nullable `photo` preview, including private and hidden walls. The app review route ships separately in [#5953](https://github.com/boardsesh/boardsesh/pull/5953), targeting `release/next`. |
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

The rule lands in **eleven** implementations, which is the thing to keep in step —
they do not share a query builder:

1. `viewerCanSeeSprayWall` (by uuid) and 2. `viewerCanSeeSprayWallByLayout` in
   `packages/backend/src/graphql/resolvers/board/spray-walls.ts`, both
   short-circuiting on `hiddenAt` before the public/unlisted question;
3. `viewerCanWriteSprayClimbs`, which additionally refuses the presented-uuid
   capability on a hidden wall;
4. the three SQL predicates in
   `packages/db/src/queries/climbs/spray-visibility.ts`, each carrying
   `AND (sw.hidden_at IS NULL OR ub.owner_id = <viewer>)`. Those are what gate a
   spray climb's ~15 reads;
5. `sprayBoardRowIsReadable` in
   `packages/backend/src/graphql/resolvers/climbs/spray-read-access.ts`, whose
   `'capability'` half honours an unlisted wall's uuid only while the wall is not
   hidden. It gates `board(boardUuid)`, `boardLeaderboard` and `searchClimbs` /
   `holdHeatmap` with a `sprayWallUuid`, which never go through number 1;
6. `listableSprayWallCondition` in
   `packages/backend/src/graphql/resolvers/board/spray-wall-listing.ts`, the
   EXISTS behind `searchBoards`, `gymBoards` and `myBoards`. Its owner escape sits
   outside the default EXISTS. The climbing picker uses the stricter published
   EXISTS with its owner exception inside, retaining hidden published walls;
7. gym discovery's own EXISTS in
   `packages/backend/src/graphql/resolvers/social/board-discovery.ts`, with no
   owner escape at all;
8. the share card: `renderSprayOgCard` in
   `packages/backend/src/services/spray-og-card.ts` answers a hidden wall with
   the private wall's `404` + `no-store` (`docs/og-climb.md`), before a photo URL
   is derived;
9. `publicWallPhotoUrl` in `spray-walls.ts`, null on a hidden wall for the owner
   too, since a private wall has no public URL for anybody;
10. the climb sitemap's wall source, `buildPublicSprayWallQuery` in
    `packages/web/app/lib/seo/sitemap/spray-wall-configs.ts`. The sitemap's climb
    query carries number 4 as well, so this one is the first gate, not the only one;
11. `assertSprayBoardIsReadable` in `spray-read-access.ts`, the by-layout rule
    for history, recent climbs and presence stats, and
    `requireReadablePresenceBoard` in `board-presence/shared.ts`, which loads
    a numeric board id once and applies that same rule to `boardConnection`
    and `boardQueuePreview` (query and subscription).

Hiding does NOT delete the wall's `media` copy. Nothing in Boardsesh hands its URL
out once the wall is hidden, but a URL somebody already copied keeps working for as
long as that object exists. A share card an edge or an unfurler cached before the
hide keeps being served until that cache entry expires (a day of freshness at our
edge, see `docs/og-climb.md`).

Hiding also purges the wall's `feed_items`, the same as deleting it does — feed
rows are served straight out of that table and would outlive the gate. Unhiding
does NOT put them back: a feed is a record of what happened when, and
re-announcing week-old climbs would be a lie. Everything else comes back.

The queue authorizes a `spray`-scoped or global admin before reading or signing
any preview. It selects the current published version's photo; only a wall
without a published version falls back to its latest draft. Several reports for
one wall share one preview and one pair of private-bucket signatures. `photo`
can be null when there is no version, no configured private bucket, or signing
fails, so an unavailable preview does not block reviewing the remaining reports.
Photo URLs expire after 15 minutes: clients must refresh the queue rather than
persisting its URLs.

**SW-17b (#5501)** supplies the report action in `BoardDetailSheet` and the admin
review route in companion app PR [#5953](https://github.com/boardsesh/boardsesh/pull/5953),
targeting `release/next`. Those app changes depend on deploying the queue schema
and resolver additions from backend PR [#5952](https://github.com/boardsesh/boardsesh/pull/5952)
on `main` first; this backend PR does not itself ship the app UI or change its
spray-wall flag default.

## Retention: what happens to a deleted wall's photographs

### Account deletion

Deleting a wall owner's account also deletes every wall they owned, including
walls already soft-deleted. The account transaction keeps inaccessible wall,
version, hold and climb identities so other climbers' logs retain their references.
It writes deletion tombstones before moving the deleted board rows to the existing
system owner, clears sharing and gym links, and scrubs wall names, location,
description and version notes. This is a deleted-row retention mechanism: no wall
is transferred for somebody else to climb, and the system-owner visibility exception
does not override either deletion timestamp.

Photo erasure runs after commit, across both bucket prefixes, including resize
variants and uploads never adopted by a version. Account-deleted walls skip the
ordinary thirty-day retention window. Storage failure leaves `photos_purged_at`
NULL and the existing daily purge retries immediately eligible work; it never
prevents the committed account deletion. SQL rollback never erases photos.

Wall creation and account deletion share a transaction advisory lock for the
account. The account's user row is deleted last: locking that row first would
deadlock against a version writer holding a wall lock while checking its creator
foreign key. An upload or public-photo promotion that passed its first check before
deletion must recheck before reporting success or attaching a public copy. Failed
late-upload erasure marks a durable retry. The purge compares the wall's exact
database `updated_at` token under its wall lock after erasure, so an older prefix
listing cannot overwrite that newer retry with a success stamp.

Other climbers' logs remain stored under the existing deleted-wall privacy rules;
deleting the account does not delete their ticks or make private logs public.

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
   object — the photos, their resize variants, their `-full` copies (#5911), and
   any upload that was never adopted as a version;
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
| `Spray Holds Reviewed` | `holdCount`, `candidateCount`, `hadCandidates` | Candidate and saved counts on the same event. Older clients omit candidateCount. |
| `Board Created` (existing) | `boardType: 'spray'` | Closes the add funnel. The SAME event every other board type fires — a spray-only variant would hide walls from every board-creation number we already watch. |
| `Spray Wall Reset Previewed` | `keptCount`, `removedCount`, `addedCount`, `lowConfidenceCount`, `climbsAffected`, `aspectMismatch`, `detectionCount` | What the matcher found. Retired with the in-place reset: the server refuses the preview, so only historical data has it. |
| `Spray Wall Reset Applied` | `keptCount`, `removedCount`, `addedCount`, `climbsChanged`, `moveCount` | What landed. Retired the same way. |
| `Climb Remixed From Broken` | `lostHoldCount`, `source` | Whether a climb a reset broke is a dead end or a starting point. An older app can still fire it; the server writes no lineage for the remix. |

Two rules, both enforced by a test in
`packages/shared/analytics/src/__tests__/spray-wall-events.test.ts`:

- **Outcomes, not gestures.** PostHog is past the 1M-event tier, so every event
  fires once per wall per step. Nothing fires per tap, per frame, or per hold.
- **Nothing identifies the wall or what is on it.** No photo, no URI, no file
  name, no wall name, no gym, no hold coordinates, no free text. Every property
  is a number, a boolean, or a member of a closed string union, and the test
  reads the payloads back field by field rather than trusting the types.

Three older events also fire on a wall and now say so (#6027): `Tick Logged`,
`Set Active Climb` and `Climb Created` carry `boardType`, built by
`boardTypeProperty` in `packages/shared/analytics/src/board-type-property.ts`.
Its value is one of the nine board types or null and nothing else, so it stays
inside the second rule: a wall's name, slug or uuid passed to it comes out as
null. It is what makes a spray session countable at all, because a wall's
`layoutId` is created with the wall. `Set Active Climb` also carries `trigger`,
`climb_saved` or null: saving a climb on a wall puts it on the queue, and that
is not the same act as choosing a climb to climb. The spray-wall activation
definition built on both is in `docs/growth-metrics.md`.

## Rolling the flag out

The whole surface is behind the mobile flag `spray-walls`
(`docs/feature-flags.md` → "Mobile flags"). A POSITIVE rollout flag: unresolved
reads as off, so the tile never flickers in for the first frames of a cold open.

Three steps, each gated on a number rather than on a feeling:

The service rollout additionally requires 24-hour observation windows, 20
reviewed walls from five users before 10%, and ten reset previews before
everyone. The complete, current gates are in
[the service rollout runbook](spray-recognition-rollout.md).

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

### The climbing picker requires a published wall

`is_public` and the first publish are two separate moments: the API lets a caller
create a wall public and photograph it afterwards, and in between the row is a
public board with no photo, no holds and no climbs. So every listing that can
return a spray wall carries one more rule — a wall whose
`spray_walls.current_version_id` is NULL is unavailable to other climbers.
The normal `myBoards` picker excludes it for the owner too: unfinished walls
belong in `mySprayWalls`, where the add-wall flow can resume them.

`listableSprayWallCondition(viewerId)`
(`resolvers/board/spray-wall-listing.ts`) is that rule as SQL, and it is applied
in `searchBoards` (both the proximity and the text path), `gymBoards` and
`myBoards` with `{ requirePublished: true }`; `gymSprayWalls` applies the row-level twin `sprayWallIsListable`,
having already joined the wall. SQL rather than a post-filter because
`searchBoards` and `myBoards` each run a COUNT beside the page: a filter that
dropped rows from the page alone would leave the count promising results the last
page does not have. The picker additionally verifies the current version is
published and belongs to the same wall. Owners still see their hidden published
walls. Publish and wizard discard invalidate every cached `myBoards` page.
If hold geometry cannot load, the climb editor offers Close, including while
loading; a cold route without history returns to the climbs tab.

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

### Deleting a wall from the Boards picker

The generic `deleteBoard` mutation delegates spray boards to `deleteSprayWall`
after checking ownership. Both wall and board rows are tombstoned together,
including `sync_frozen_at`, feed retraction and public-photo cleanup. Older apps
using the generic mutation receive the same wall cleanup.

Removing the active board also leaves this device's shared session and clears
its queue, current climb and playlist source. The solo snapshot is removed
before the picker finishes, so relaunching cannot restore the deleted wall's
climb. Removing another board leaves the active queue alone. The confirmation
names the wall's photos and climbs, and a successful delete shows a toast.

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

## Editing a climb

A published spray climb follows the rule every board follows: **only its setter
edits it, and only within 24 hours of its first publish.** The edit is made in
place.

| The climb is | Who can edit it | For how long |
| --- | --- | --- |
| A draft | Its setter | Always, and publishing it still works |
| Published | Its setter | 24 hours from the first publish |

Nobody else, on any wall: not the wall owner, not a gym owner or admin, not a
community leader, not a collaborator or a share-link holder. The wall's stored
`climb_edit_policy` is not read. Before this, a spray climb could be edited with
no time limit by its setter and by anyone who could edit the wall (#5955), or
anyone who could set on it under the `collaborators` policy (#6025). The owner
decided a published climb holds still like on every board; a climb that loses a
hold to a hold edit is remixed instead (see
[Editing the holds of a live wall](#editing-the-holds-of-a-live-wall)).

The refusals keep their codes: `CLIMB_EDIT_NOT_ALLOWED` for anyone but the
setter (the same message whether the wall is private, unlisted or public, so it
says nothing about a wall existing), `CLIMB_EDIT_WINDOW_EXPIRED` past 24 hours,
`CLIMB_NOT_EDITABLE` for a published climb with no publish date, and
`CLIMB_EDIT_CONFLICT` when the climb changed between the resolver's first read
and its row lock (`climb-edit-guard.ts`). The non-setter refusal comes before
the spray wall is resolved.

What an edit does now:

- **No revision history.** No `board_climb_revisions` row is written, and
  `revision_number` / `holds_revision_number` do not move.
  `UpdateClimbResult.revisionNumber` and `holdsRevisionNumber` are the row's
  stored values.
- **A holds edit keeps the climb's sends, first ascent and stars.** There is no
  stats restart and no recompute marker any more.
- **The rest is as before:** the `board_climb_holds` rewrite, the neighbours row
  delete, the fingerprint refresh, `populateSprayClimbColumns`,
  `recomputeMissingHoldCountForClimb`, the web revalidation and the stats row
  upsert on a grade edit. Every spray edit still checks that the climb's holds are
  alive on the published version, and an edit never moves `published_at`. The
  setter stays the setter.

### The Edit action in the app

2.5.0 (`main`) already offers Edit on the server's rule: the setter only, a draft
always, a published climb for 24 hours (`computeCanUpdate` in
`@boardsesh/create-climb-react`, used by `ClimbActionsSheet`).

The 2.6.0 beta (`release/next`) offers it from `canEditClimb`, a rule that lives
only on that branch: on spray it offers Edit to the setter with no time limit
and, where it read `viewerCanEditClimbs: true`, to wall editors. The server now
answers `viewerCanEditClimbs: false` for everyone, so only the setter's own Edit
survives, and past 24 hours `updateClimb` refuses it with
`CLIMB_EDIT_WINDOW_EXPIRED`, which the editor already translates. The app update
removes the offer.

## Climb revisions (retired)

Revision history (#5955) and the holds-change stats restart (#6023) are retired.
`updateClimb` writes no `board_climb_revisions` row and does not move
`board_climbs.revision_number` or `holds_revision_number`. `climbRevisions`
answers `[]`, and `climbCurrentRevision` on the log and feed items answers `null`.
The rows already written stay.

What is still read:

- **The holds epoch.** A tick whose `climb_revision` is below the climb's
  `holds_revision_number` was climbed on older holds, and stays off the climb's
  ascensionist count, first ascent and stars (`recompute.ts`) and off every
  per-climb "has this climber sent / tried / rated it" check: search filters,
  recommendations, the Projects playlist, a wall's recent senders
  (`packages/db/src/queries/climb-stats/holds-epoch.ts`). For a climb nobody
  edited before the retirement the epoch is 1 and the rule changes nothing; for
  the few edited before, it stays correct.
- **The tick stamp.** `saveTick` still stores `boardsesh_ticks.climb_revision`
  (`resolveTickClimbRevision`): the client's `climbRevision` when it is from 1 up
  to the climb's stored revision, otherwise the revision live at `climbedAt` from
  the kept revision rows, 1 for a climb on revision 1, NULL when the climb has no
  row. No whole number the client sends gets a tick refused. `updateTick` never
  changes the stamp.

`Climb.revisionNumber`, `Climb.holdsRevisionNumber` and `Tick.climbRevision` come
back unchanged, and `syncTicks` / `syncClimbs` keep emitting the three columns.
`MAX_REVISIONS_PER_CLIMB` stays in `@boardsesh/board-config` for the app builds
whose history list reads it; the server no longer enforces it.

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

## Offline: a wall on the device

A wall lives in a garage or a basement, which is exactly where there is no
signal, so SW-15 (#5448) mirrors it. The mechanics live in
[`sync-table-manifest.md`](sync-table-manifest.md#spray_walls--syncspraywallsboardtype-layoutid-sizeid-board-data-per-board)
and [`offline-reads.md`](offline-reads.md); what matters here is what a wall
specifically needs that a catalogue board does not.

**Everything but the picture is a row.** The on-device `spray_walls` table
(SQLite migration v8, keyed on `layout_id`) holds the canonical frame, the
published version number, that version's homography, and the holds alive at it —
the same `aliveHolds` answer the render query gives. `syncSprayWalls` pages it on
`(updated_at, spray_walls.id)`, behind the by-layout visibility rule: owner, gym
member, or a public wall. **Unlisted is not an exemption on that key**, for the
reason spelled out under "Photo privacy" — a layout id comes out of a sequence,
so honouring unlisted there would let one account walk it and collect every
unlisted wall. The uuid paths (`sprayWall`, `sprayWallRenderData`) are where a
share link works.

The climbs come through the ordinary per-board tables, and
`board_climbs.missing_hold_count` is mirrored with them (v7) so the Intact /
Lost-holds filter works with no signal. It is synced WITHOUT a catalogue
refresh-revision bump; the reasoning is in `table-config.ts` next to the column.

**The picture is a file, and its URL is not storable.** The photo is in the
private bucket, so the sync payload carries a 15-minute presigned URL as a
*transient* field — handed to the device and never written, because
`presignVersionPhoto`'s rule ("minted per read and never stored") does not stop
being true on a phone. The bytes land under `Paths.document/spray-wall-photos/`,
named after `photo_key`. Deliberately NOT `Paths.cache`: the renderer's own photo
cache lives there and the OS may reclaim it whenever it likes, which is the one
thing an offline copy must not do. A download that fails records a pending marker
and rewinds that wall's cursor so the next pull re-offers the row with a live
signature, bounded by an attempt count — the dead URL cannot be retried.

**A wall's storage is reclaimed on four paths**, because a photograph outliving
its row is invisible until a phone fills up: a reset prunes the generation it
replaced, removing the board deletes the row and its file, a tombstone deletes
the file through the captured `photo_key`, and sign-out takes the rows and the
whole directory. `storage-usage.ts` does not count the directory and says so.

**Sign-out is the exception to "board data is a shared cache."** Every other
board table survives a sign-out because a Kilter catalogue is identical whoever
is signed in. A wall is not: `spray_walls` is the one board table
`USER_DATA_TABLES_TO_CLEAR` includes, the wall's climbs, stats and grades go with
it (`SPRAY_SCOPED_BOARD_TABLES`, `board_type = 'spray'` rows only — those rows
carry the climb names, frames and grades of somebody's garage, and
`searchClimbsLocal` reads reference data with no owner stamp), the photographs go
too, and `getSprayWallLocal` refuses to serve unless the `local_user_id` stamp
names the climber asking — the defence that survives a wipe that failed.

**One known gap, tracked as #5490.** The delete tombstone is scoped to the wall's
owner, so a gym member or public-wall viewer who mirrored a wall never receives
it: `syncSprayWalls` stops serving them the wall, but nothing tells their device
to drop what it has until they sign out or remove the board.

## Where spray is excluded

Five exclusions matter, and all five are about a wall being someone's private
property rather than a catalogue:

1. **Board pickers.** `SUPPORTED_BOARDS` in
   `packages/shared/board-config/src/board-data.ts` — the display-filter list,
   not the schema's — drops `spray` outright. No generic picker, board builder or
   wall finder offers it; a wall is created through the add-a-wall flow
   (`/boards/spray/new`, below) and reached at its own `/b/{slug}`.
2. **The popular-config rail.** `getPopularConfigs`
   (`packages/backend/src/services/popular-board-configs.ts`) feeds the www
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

A share link from the app opens on www, so two things are server-rendered: a
wall's CLIMBS, one page each at `/b/{slug}/{angle}/view/{climb}`, and the WALL
itself at `/b/{slug}/{angle}/list`, which is where `buildSprayWallShareUrl`
points and what `/b/{slug}` redirects into. Neither route ever reaches
`getBoardDetailsForBoard`, which has no catalogue size row for a wall and throws.

The wall page is not a climb list. The climbs of a wall are browsed in the app,
and the list machinery every other board uses is built around a configuration
tuple a wall does not have. What somebody following a shared link needs is to see
that they have the right wall, so the page is the photograph, the angle and the
hold count.

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

### `?wall=` is a capability, and it is checked as one

`buildSprayWallShareUrl` gives a PUBLIC wall a clean URL and an UNLISTED one
`?wall=<uuid>`, because `sprayWallByLayout` deliberately refuses an unlisted wall
— a layout id is a sequence number — while `sprayWall(uuid)` resolves it. The web
route redeems that param the same way `saveClimb` redeems `sprayWallUuid`: the
uuid has to be **this** wall's, the one the slug already resolved to. Without the
pairing one leaked uuid would open every wall in the sequence.

| The wall is | No `?wall=` | `?wall=` matches | `?wall=` is wrong |
| --- | --- | --- | --- |
| public | renders | renders | 404 |
| unlisted | 404 | renders | 404 |
| private | 404 | 404 | 404 |

A mismatch is the same 404 as no param at all, so the response is never an oracle
for which slugs are unlisted walls. `/b/{slug}` re-emits the param onto its
redirect — only that one, the way it already re-emits the QR attribution — because
that hop is the only thing between the shared link and the page that redeems it.

The wall page is always `noindex, follow` and emits no canonical: the URL an
unlisted wall is read at carries a capability, so there is no clean twin to point
a canonical at, and a canonical naming the bare path would invite a crawler to a
URL that answers 404.

### Which photograph the page shows

A PUBLIC wall shows `SprayWall.publicPhotoUrl` — the copy SW-14 makes in the
world-readable bucket — because a crawler, an unfurler and a CDN can all hold a
stable URL and none of them can hold a fifteen-minute signature. An UNLISTED
wall has no such copy by design, so it shows the presigned URL from
`sprayWallRenderData`, which is right for a page read by whoever has the link
and never indexed. Never the other way round: a presigned URL in a public page's
HTML is a dead image fifteen minutes later.

When the owner chose a generated background and the backend reports it READY
for the version the page draws, the page shows that instead
(`fetchSprayWallArtChoice`, `resolveSprayWallDrawing`): through the redirect
route for public and unlisted walls alike, in canonical mode, with the dark Aura
field behind Holds only (www has one colour scheme). Any miss draws the photo
as above.

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

### No `BreadcrumbList`, deliberately

SW-16 (#5449) asked for one on the climb page and it is left out. A breadcrumb
needs a parent to name, and a wall's only parent is its own page — which is
capability-gated and `noindex`. Emitting `Wall -> Climb` from an INDEXED climb
page to a `noindex` parent is the same conflicting signal the metadata avoids by
withholding a canonical on a noindex page, and Google can resolve it by
propagating the noindex up the chain. So: no breadcrumb until a wall has an
indexable page of its own, which is a decision about crawling somebody's home
wall rather than a markup change.

### The card and the sitemap

`GET /og/climb?board_name=spray` composes the card from the public copy and the
lit holds, for public walls only — see `docs/og-climb.md`. An unlisted wall's
page emits no `og:image` at all rather than pointing at a URL that answers 404.

Public walls' climbs are the only spray URLs in a sitemap, and the boards shard
stays catalogue-only because a wall has no `/list` page to submit. The rule, the
config source and the SQL belt behind it are in `docs/sitemap.md`.


### Newly saved climbs on downloaded walls

After a successful spray climb save or edit, mobile awaits an exact-UUID canonical
mirror before invalidating the downloaded climb list. `syncClimbDocuments`
requires the exact board type and layout, and the existing wall visibility rule (including an explicitly supplied unlisted wall
UUID). Climb and stats documents come from one repeatable-read primary snapshot,
including the real server `updated_at` and `sync_seq` values. Authors can mirror
their own drafts; other readable spray rows must be published. This supports
wall owners editing another setter's published climb without exposing anybody
else's draft. The response's authenticated `viewerId` gates the local account
stamp, while the climb keeps its original `user_id` attribution.

The SQLite mirror writes both tables in one transaction through the ordinary
pull document writer. It checks download coverage, the local account owner,
auth credential generation, and purge generation; it never changes pull
checkpoints or bypasses the ordinary pull stability window. Ordinary climb and
stats pulls preserve newer mirrored spray rows when an older response arrives later.
Each ordinary or refresh spray climb page also clears its derived holds index in the same
transaction. This fences an in-flight index build and lets delayed older rows
enter heatmaps and similar-climb searches even if a mirrored row advanced the
index watermark. The next index read rebuilds the bounded spray layout;
catalogue walls retain their existing incremental index behavior.
If the mirror fails, the remote save still succeeds and the app asks the climber
to reconnect to refresh their downloaded list. Mobile release depends on the
additive backend query being deployed first.
