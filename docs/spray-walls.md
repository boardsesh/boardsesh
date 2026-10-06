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

**A crop is not a warp either.** The photo step's crop happens on the phone
before the upload, so the server only ever sees the cropped file: its stored
width and height are the cropped photo's, the anchors are tapped on it, and the
homography is solved in its pixels — exactly as for a photo framed that tightly
in the camera. Nothing on the server knows a crop happened, and nothing has to.
A crop is a translation of the pixel grid, and a homography solved from anchors
that moved with the grid absorbs it: `homography.test.ts` ("a crop before the
upload") pins that a wall point maps to the same canonical point however the
photo was cropped. Cropping a version-1 photo to the wall's edges also makes
"Skip for now" on the corner step honest: without anchors the frame is the whole
photo, so a photo cropped to the wall is a frame that IS the wall. An uncropped
version 1 with no anchors is the case that goes wrong: every later reset maps
the wall's corners onto that photo's corners and is off by the floor and
ceiling margin ([#6157](https://github.com/boardsesh/boardsesh/issues/6157)).

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

### Recognition service and shared post-processing

The current rollout uses a dedicated homelab Node worker consuming pg-boss
jobs from the writable primary. Mobile requests and resumes jobs over GraphQL;
the physical standby is not a queue endpoint. See
[deployment and exposure gates](spray-recognition-rollout.md) for the pinned
segmentation model, tiling, outlines, retries and native-runtime cleanup.

The box-model measurements below are historical evidence, not the current
segmentation service's inference configuration. The native runtime and benchmark
have been removed; see [native cleanup](spray-recognition-native-cleanup.md).

`@boardsesh/hold-detection` is the platform-free detection post-processing:
tile planning, preprocessing into the model's input tensor, decoding RF-DETR's
two output tensors, merging what several tiles saw, and handing back circles. The
inference runtime and the image decoder are injected, so the same code runs in
a browser worker or Node, without a mobile native inference dependency.

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
one more reason the editor's confidence cutoffs (below) are coarse bands rather
than a tuned threshold.

## Adding a wall

`packages/mobile/app/boards/spray/new.tsx` → `SprayWallWizardScreen` (SW-09,
#5442). One route, seven steps, available to every climber.

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
| `photo` | Library pick; the camera button only on a binary at or past the version that shipped the usage description. Compressed to a 4096 px JPEG (`WALL_PHOTO_MAX_DIMENSION`), which bakes the EXIF orientation into the pixels. A 12 MP phone photo goes up unscaled. The server keeps a 2048 px base for the frame, the detector and the climb view, and the larger copy only for the hold editor's deep zoom (#5911). The photo's size is the rendered JPEG's own (`compressPickedImageWithSize`), not the picker's, which on some Android builds describes the sensor rather than the picture. "Crop or rotate" under the preview opens `adjust`. |
| `adjust` | Not counted, and always returns to `photo`. A free-aspect crop box (four corners, four edges, drag inside to move) and a Rotate button that turns the photo a quarter clockwise, over the BASE — the first compressed, uncropped copy. Copy: "Crop to the edges of the wall". Done renders the edit in one pass with `renderWallPhotoEdit` (rotate, crop, shrink to `WALL_PHOTO_MAX_DIMENSION`, JPEG 0.85) from the picker's ORIGINAL, falling back to the base when the original is over 25 MP (`ORIGINAL_RENDER_MAX_PIXELS`: decoded memory, about 195 MB for a 48 MP capture), gone, or fails to render; the result's size is the rendered image's. At the 4096 px cap the base keeps half a 48 MP original's width, so only a crop tighter than half of each side comes out softer. The output is at most 4096 x 4096 (a square crop of a 24 MP photo), about 3.5 MB for a real wall photo against the 15 MB upload cap. It clears the anchors, as a new photo does: a quarter turn changes which corner is the top-left. Reset puts the photo back as picked, Cancel (Back) leaves it as it was, and Back and leaving wait while the edit renders (`photoProcessing`). The smallest crop keeps 15% of each side and at least 512 base pixels, which guarantees 512 uploaded ones; under 1200 px on the long side a soft warning says holds may look soft, predicted from the same file the render will read (`renderableOriginalSize`). Rotation renders a turned preview of the base per quarter turn (`renderRotatedPreview`, 1600 px) rather than a view transform, because a rotated view hands pan translations back in its own axes. The pure halves are `photo-edit.ts` and `crop-box-math.ts`. Re-opening starts from the base with the last edit, so a crop can be loosened again. |
| `anchors` | Optional, Skip by default. Four draggable handles with the marked area outlined between them; a quad that crosses itself is refused client-side, because the server's fallback for a degenerate quad is the identity matrix. The photo is fitted on both axes to the space between the header and the footer (`corner-photo-fit.ts`), so all four handles are on screen and the step does not scroll; the footer is the same height before and after the first drag. When that space would fall under about 200 points the photo stops shrinking and the step scrolls instead — reachable on a 375x667 phone with the reset flow's longer copy, not only at large text sizes — and the page is held still while a ring is being dragged, so a drag never becomes a scroll. The hint and the refusal that replaces it share one slot, so a refused quad does not re-fit the photo. The reset flow's corner step is the same component. |
| `upload` | `createSprayWall`, then the multipart POST, then `createSprayWallVersion`. |
| `detect` | Request or resume a server-owned recognition job. New walls can enter manual editing while queued ("Mark holds myself"); published reset versions remain unchanged until review and confirmation. With the photo still on the phone the step is full-screen (`SprayScanPhoto`): the photo sits exactly where the editor will put it (`fitSprayPhoto`), dimmed, with a violet band looping down it and a glass status card. A run resumed without the file, and the reset flow, keep the plain spinner. |
| `review` | `SprayHoldEditorScreen`. Its one button, "Pick a look", commits the holds (`REVIEW_COMMITTED`) and hands over to the look step. Until its draft has loaded it shows `SprayEditorLoading`, never a bare spinner: the local photo dimmed with a status card and no scan band when the wizard still has the file, a spinner and a status line otherwise, and "Couldn't load your wall" with "Try again" when the read has given up or is parked offline (`useSprayWallDraft`'s `isStalled`; an automatic retry still in flight keeps the plain wait). "Try again" re-probes connectivity before it refetches, because an offline connectivity store refuses requests before they reach the network. The wizard prefetches that draft during `detect` (`prefetchSprayWallDraft`). |
| `look` → `publish` | `SprayWallLookStep`. The onboarding board-look rail without Custom, every card drawn on the creator's own draft with ~12 of its holds lit as a stand-in problem (`samplePreviewHolds`, `useSyntheticSprayWallPreview`). Defaults to `DEFAULT_SPRAY_WALL_LOOK_OPTION_ID` (Aura Outline); no Skip. Its button stores the card's bundle with `setSprayWallRenderSettings`, then `LOOK_CONFIRMED`; the publish step then runs by itself once — `publishSprayWallVersion`, `invalidateSprayWallRenderData`, and the board bind — and only stops to show an error with Try again. Like `review`, it has no step behind it: Back leaves and keeps the draft. |

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
  The bind itself (`runPostPublishBind` in
  `packages/mobile/src/lib/spray/post-publish-bind.ts`) cannot hold the `done`
  spinner forever: the render-data refresh is started and never waited on, the
  visibility write and the board read plus bind each get 30 s (past the GraphQL
  client's 20 s deadline), and a stage that runs out lands on the publish step's
  error and Try again, reported with its stage as `Spray Wall Bind Stalled`. A
  timed-out run cannot start a bind or navigate when its answer arrives late
  (a board write already in flight may still land). If the wizard is still
  mounted 1.5 s after its `dismissTo`, it leaves by a second road: it closes the
  Boards modal through the root stack, or replaces it with the tab when nothing
  is underneath. After 5 s `done` shows its own "Back to climbing" button, which
  takes that second road too. The maintenance editor (`spray/holds`) puts the
  same 30 s ceiling on its post-publish refresh, which ends in its Retry screen.

The wizard always exposes a header close control, including cold deep links
without a back stack. It returns to the resolved source tab when no back route
exists, and native removal prevention runs the same busy, unsaved-edit and
stale-confirmation checks for header and footer exits. The editor and Look
surfaces reserve the transparent header's measured height. When a Look preview
cannot be drawn, the creator can still select any offered look and save it.
Photo replacement controls precede the preview so portrait photos cannot hide
them below the fold.

Both the wizard and the reset guard leaving with `usePreventRemove`, which
registers native dismissal prevention before a gesture can remove the screen,
and carries that protection up to the containing Boards modal. The wizard
registers it through `useSprayWizardLeaveGuard`, always on, and hands the held
navigation action to the leave decision above; the reset uses
`useSprayLeaveGuard`, on while there is something to lose. Cancelling keeps the
flow mounted; confirming redispatches the original navigation action. Footer
exits use the same guard, so they ask once. Both routes disable the native
back-button history menu, which does not support removal prevention.

### Full screen on iPad

On iPad the three spray routes (`spray/new`, `spray/holds`, `spray/reset`) are a
`fullScreenModal`, not the page card every other Boards screen is. A card leaves
the editor a box in the middle of the screen with the app dimmed around it.
`sprayFlowCoversScreen()` (`src/lib/spray/spray-flow-presentation.ts`) is the
one switch: `Platform.isPad` on iOS. Phones and Android, tablets included, keep
the presentation and layout they had, key for key.

- **Two places set it.** Pushed over the picker, a spray screen's own options
  make it full screen (`sprayFlowScreenOptions`). Opened from the live wall
  sheet, `/boards/spray/holds` or `/reset` is the FIRST screen of the Boards
  stack, and a stack's first screen ignores its own presentation. So the root
  `boards` screen in `app/_layout.tsx` takes an options function and asks
  `opensIntoSprayFlow(route)` which screen the modal was opened on: the nested
  navigate's `params.screen`, or the first route of a cold link's state. It reads
  the ENTRY, so the presentation does not change while the modal is up. With
  neither, it opens as the card, which still works.
- **An X on holds and reset.** A full-screen modal has no swipe down and no back
  chevron, so both need the wizard's header X (`SprayWizardExitButton`). Reset
  already carries it on every platform (#5960), so iPad only adds the
  presentation there; holds gets it on iPad only. It calls `router.back()` like
  the screens' own Back buttons, so the `usePreventRemove` guards above still
  ask first; with nothing to go back to it dismisses to Climbs.
- **The home indicator fades** (`autoHideHomeIndicator`). The status bar stays:
  hiding it per screen needs the view-controller-based status bar appearance,
  which Expo turns off.
- **Form steps keep a column.** The wizard's and the reset's scrolling steps are
  capped at `SPRAY_FORM_MAX_WIDTH` (640 pt) and centred.
- **The photo gets the screen.** `useSprayEditorLayout()` answers `tablet` for an
  iPad window at the regular width (700 pt and up) and `phone` otherwise, live,
  so Split View, Slide Over and a small iPadOS 26 window fall back to the phone
  layout. On `tablet`, `fitSprayPhoto` keeps no room free for the bottom bar
  (`reserveBottom: false`) and the chrome floats over the photo. The scan step
  (`SprayScanPhoto`) fits with the same answer, through the same
  `sprayPhotoReservesBottom`, or the rings would not land where the band swept.
- **A resize resets the zoom.** When the photo's fitted size changes under the
  editor (rotation, Split View, Stage Manager), the zoom is reset through the
  board's `controlRef`, and a stroke or hold drag in progress is dropped by
  remounting the gesture overlay. The stroke's points are board pixels, so what
  was drawn is not wrong; the rest of it would be. Phones are portrait-locked and
  never resize.

Why iPad may use `fullScreenModal` when `docs/mobile-sheets-vs-routes.md` rule 2
bans it: the ban is about the iOS 26 NativeTabs, and iPad never mounts them.

### The iPad editor and Apple Pencil

On the `tablet` layout the hold editor keeps every handler the phone has and
changes where they live. The phone layout is untouched, key for key.

- **A tool rail down one side** (`SprayToolRail`): Undo, Redo, Mark (the resting
  pick-and-switch tool) and Add, the maybes' show-or-hide and Keep all, "Pencil
  only" once a Pencil has been seen, Fit (the zoom reset), the wall-wide menu
  (Start over) and the "?". It is the phone's bottom bar on its side, minus the
  counts and the primary button. It docks to the leading edge; dragging its grip
  past the middle of the screen springs it to the other edge, and the side is
  kept per device (`boardsesh_spray_editor_rail_side`, `useSprayRailSide`). A
  screen reader activates the grip to switch sides.
- **Everything else stays away from the rail** (`sprayTabletPlacement` in
  `spray-tablet-layout.ts`, tested as a table). The picked hold's
  `SprayHoldInspector` replaces the chip bar: a 300 pt glass card with the
  hold's role, where it came from ("Found by scan · 82%" or "Added by you"),
  the size stepper, the role's actions (Switch off, Redraw, Refine, Join;
  Switch on, Delete; Keep, Switch off) and Previous / Next, which pick the neighbouring
  ring in reading order (`sprayHoldReadingOrder`, the screen reader's walk) and
  frame it through the board's `controlRef.zoomTo`. In landscape the card sits
  under the header on the side away from the rail; in portrait it sits low on
  that side, above the cluster. The undo toast and Corners' Finish stack above
  the cluster on the same side. The reset-zoom control moves to the top corner
  away from the rail, and the banner and hints keep a column of up to 520 pt in
  the middle, narrower in landscape so it clears the inspector.
- **A primary cluster along the bottom**: the count capsule
  (`SprayCountCapsule`, shared with the phone's bottom bar) and the primary
  button. Landscape docks it to the side away from the rail, portrait centres
  it at up to 520 pt.

**The Pencil marks and fingers inspect.** The Pencil needs no mode: on the
tablet layout every touch is checked for `PointerType.STYLUS`. "Pencil only"
is about fingers. It turns itself on the first time a Pencil touches or hovers
over the wall in a session (`pencil-session.ts`, module-scoped so the wizard
remounting the editor does not forget it), and the rail's toggle overrides it,
kept per device (`boardsesh_spray_editor_pencil_only`).

| Input | On a ring | On bare wall |
|---|---|---|
| Pencil tap | switch it on or off | add a circle at the median hold size |
| Pencil stroke | starting on the SELECTED ring: move it | outline a new hold (`holdFromStroke`); centred inside the selected hold, redraw that hold instead (`SET_OUTLINE`), which also switches a selected ghost or maybe on |
| Pencil hover | a violet halo round it: a tap will switch it | a dashed circle of the size a tap would add |
| Finger tap, Pencil only on | pick it (the inspector opens) | put the picked ring down |
| Finger tap, Pencil only off | the phone rule (`resolveEditTap`) | the phone rule |
| Finger long press or drag on the picked ring | pick up and move | Pencil only off: place a hold (the phone rule). On: pan when zoomed |
| Pinch | zoom and pan | zoom and pan |
| Two-finger tap | undo the last wall edit | undo the last wall edit |

- **How the touches are split.** The resting editor nests a Pencil-only
  `DrawStrokeOverlay` (`SprayPencilSurface`: Add's Manual recognizer, finger
  draw off) inside `SprayEditGestureOverlay`, the same ancestor fall-through
  Trace relies on. A finger fails it at touch-down and lands on the edit
  overlay. A Pencil touch inside the selected hold's grab radius fails it too
  (`declineOnSelectionSV`), so the edit overlay's drag claims it and the
  Pencil moves the ring. The grab radius is the drag's own claim at
  touch-down: the hold's radius, or 22 screen pt when that is bigger. Were the
  two to differ, a small ring would be claimed by both on the same touch, and
  the drag's end ignores a cancelled touch (`success` false) for the same
  reason. Everything else the Pencil does comes back as one
  stroke: within 10 screen pt it is a tap (`resolveEditTap` with
  `input: 'pencil'`), otherwise an outline (`pencilStrokeTarget` decides new
  hold or redraw).
- **Add mode, Trace and Refine follow Pencil only.** With it on, Add's Draw takes only
  the Pencil (`fingerDrawSV` false), Corners takes only the Pencil
  (`PolygonTapOverlay`'s `stylusOnlySV` fails a finger at touch-down, so it
  pans), and Trace draws only with the Pencil and says so in its banner.
- **Hover** is RNGH's `Gesture.Hover()`, already in the binary, simultaneous
  with the edit overlay's race. It writes `[id, cx, cy, r]` (or `[0, x, y, r]`
  on bare wall) to a shared value on the UI thread with the same hit test a
  tap uses, and `SprayHoverPreview` draws it inside the zoom transform. A
  mouse or trackpad pointer is ignored. Hover only exists on the iPads whose
  Pencil hovers (iPad Pro M2 and later, and the Pencil Pro models); elsewhere
  nothing arrives and nothing draws.
- **The Pencil hint** ("Apple Pencil adds and switches holds. Fingers move
  around and pick a hold.") is asked for by the first Pencil touch or hover,
  and again by each later wizard step once one has been seen, and goes ahead
  of every other hint. It is used up when a finger then picks a
  ring, or when it is closed (`onboarding_tip_spray_pencil_seen`).
- **Two-finger tap undo** is a `Gesture.Tap().minPointers(2)` of at most 250 ms
  and 15 pt, simultaneous with the pinch, so a quick tap undoes and anything
  longer or wider is a pinch.
- **With the resize handle, press and hold, and the loupe.** These came from
  the phone editor and keep working on iPad unchanged. The resize handle is
  mounted after the edit overlay, so its own detector still wins a touch on
  the handle, Pencil or finger. Press and hold to place a hold is for fingers
  only: the edit overlay's long press steps aside at touch-down for a Pencil
  on bare wall (the Pencil adds by tapping or drawing), and with "Pencil only"
  on, a finger's press and hold on bare wall steps aside too and pans, since
  fingers do not add then. The loupe follows fingers only (`pointerWantsLoupe`),
  so a Pencil never brings it up. On iPad the handle avoids the bottom count
  and primary cluster instead of the phone's dock.

What can only be checked on hardware: palm rejection while the Pencil draws,
a Pencil landing on the selection while zoomed, hover on a Pencil Pro iPad,
and a two-finger tap against a short pinch.

### Keyboard shortcuts and the Pencil's double tap and squeeze

Neither has a JS path on iOS: React Native 0.86's `onKeyDown` is Android only,
and nothing else references `UIPencilInteraction`. On Android `onKeyDown`
exists but sits behind the native `enableKeyEvents` feature flag, which is off
in every OSS release level and cannot be turned on from JS. So both platforms
use one local Expo module, `packages/mobile/modules/spray-editor-input`, which
ships on the `release/next` train because it moves the native fingerprint.

- **The native half only turns keys into ids.** `SprayEditorKeyScope` is the
  editor's root view, so the module's view is the ancestor of everything a
  touch lands on. It is `box-none`, not `none`: on iOS, Fabric turns `none` into
  `userInteractionEnabled = NO`, and UIKit can then refuse it first responder
  and never hit-tests it, which would silence both the key commands and the
  Pencil interaction. For a climber who can edit, JS hands it the shortcut
  list (`sprayShortcutCommands`: keys, plus the titles the iPad's Cmd-hold
  overlay shows). iOS registers each one as a `UIKeyCommand` on a view that
  makes itself first responder. Android matches key presses on a view that
  takes key focus (`SprayShortcutMatcher`, JVM-tested in CI). Both report
  `onShortcut({ id })`, and neither takes the keyboard from a text field. iOS
  takes it back when its window becomes key, when the app becomes active, or
  when a touch lands on the editor, because UIKit gives it to nobody after an
  alert.
- **What a shortcut does is JS** (`resolveSprayShortcut` in
  `spray-editor-shortcuts.ts`, tested as a table), so it ships by OTA. Each one
  runs the handler its button runs, under the same lock (the table below). On
  Android, `command` means Ctrl or Meta, so undo is Ctrl+Z.
- **The Pencil's double tap and squeeze follow the iPad's own Pencil setting**
  (`resolvePencilGesture`), on the tablet layout only. A switch setting ("switch
  between current tool and eraser" or "…and last used") swaps between Mark and
  Add. A palette setting opens `SprayPencilPalette`: Mark, Draw, Corners, Undo
  and Redo in a ring round the Pencil tip, pulled in from the edges by
  `pencilPaletteCentre`, or mid-screen when the Pencil was not hovering.
  Ignore and a system shortcut are left alone. A squeeze (Pencil Pro, iPadOS
  17.5 and later) acts when it is let go, and a second squeeze closes the
  palette.
- **An older binary does nothing.** `modules/spray-editor-input/src/index.ts`
  resolves the module with `requireOptionalNativeModule('SprayEditorInput')`
  and only asks for the view when the module is there. An OTA of this JS on a
  store build without the module renders nothing, and the shortcuts are absent.

| Keys | Does | Only when |
|---|---|---|
| ⌘Z / ⇧⌘Z | Undo / Redo | there is something to undo or redo |
| Delete or Backspace | switch the picked ring off; on a ghost, delete it | Mark, a ring picked |
| Esc | close the Pencil palette or the wall menu; otherwise leave Add, cancel Trace or Join, or put the ring down | |
| A | Add on or off | |
| − / = (or +) | smaller / bigger | Mark, a ring picked |
| [ / ] | previous / next ring in reading order | Mark, more than one ring |
| ⌘↩ | the primary button | the button's own enabled rule |

Each key is matched as its US layout types it, with exactly the modifiers in
the table. On a layout where `[`, `]` or `=` needs Shift, Option or AltGr
(German and French, for two), previous, next and bigger do not fire from those
keys; the inspector's buttons and the keypad `+` still do.

What can only be checked on hardware: the shortcuts on an iPad keyboard (and
that they survive an alert and a trip to the home screen), that the scope view
becomes first responder at all, which input the Delete and forward-delete keys
reach (`UIKeyCommand.inputDelete` against `"\u{8}"`), the Cmd-hold overlay's
titles, double tap on a Pencil 2 or Pro, squeeze and its hover point
on a Pencil Pro, and Ctrl+Z on an Android tablet with a keyboard.

## Caps

| Cap | Value | Why |
| --- | --- | --- |
| `MAX_SPRAY_WALLS_PER_USER` | 10 | Each wall costs a private-bucket photo per version plus a catalogue layout row. Well past what a home climber or a gym needs, low enough that a scripted account cannot fill the bucket. |
| `MAX_HOLDS_PER_WALL` | 1500 | A dense commercial spray wall runs 400–800 holds. The cap bounds what a detector run, a hold-editor session and a reset match hold in memory at once. |
| `MAX_VERSIONS_PER_WALL` | 50 | A wall reset monthly for four years stays inside it. Every version keeps its own photo and its own hold generation. |
| `MAX_REVISIONS_PER_CLIMB` | 50 | A spray climb can be edited with no time limit, so its history needs a bound. A rename every week for a year stays inside it. Applies to every board, but only a spray climb can get near it. |

The first three are reachable by ordinary use — ten walls is a gym with a lot of bays,
1,500 holds is a dense commercial spray wall, fifty resets is four years of
monthly changes — so each is **said out loud with its number** rather than met as
"Something went wrong":

| Cap | Where the climber reads it |
| --- | --- |
| Walls | A hint on the create step, BEFORE it bites (`sprayCaps.wallsHint`), and the refusal itself. Meeting the cap on the publish step with a photo already uploaded is the worst moment to learn it. |
| Holds | The hold editor's save refusal (`sprayEditor.errors.tooManyHolds`). |
| Versions | The reset flow's upload failure (`sprayCaps.versions`). |
| Revisions | Nowhere. This cap never refuses an edit: at 50 the oldest edit is dropped and the original is kept, so there is nothing to tell the climber. See [Climb revisions](#climb-revisions). |

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
the column existed, and the mobile resolver falls back to the climber's own look
for it. On a wall that has one, the wall's look wins over the climber's own,
unless they turned on "Use my look on spray walls" (More → Board look).

The dimming over unlit holds (the Aura veil) is set by the creator in the same
step, with a slider under the looks, and stored in the look as `veil: 'custom'`
plus `veilOpacity` (or `veil: 'off'` at zero). A spray wall cannot use
`veil: 'auto'`: that sizes the veil from a measured wall brightness, which only
the catalogue boards have, so on a photo it draws nothing. Until the creator
touches the slider each look keeps its own dimming, which for Aura Outline is
none. `withSprayWallDim` applies the value to the options themselves, so the
previews and the stored bundle cannot disagree.

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
removes one. Old clients that supply an uploaded `photoId` keep the same behavior.

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

### Drafts belong to one editing flow

The single open draft is either initial setup, hold maintenance, or a photo reset.
Hold maintenance reuses the current published private photo key and its exact
pixel dimensions, anchors and homography. Any other photo or mapping requires
reset review. This is inferred from immutable photo identity, so existing drafts
need no migration. Expiring URL signatures never determine identity.

The plain publish endpoint accepts initial setup and hold maintenance only.
Photo resets publish through `commitSprayWallVersion`; propose and commit refuse
hold-maintenance drafts. Initial setup may still use the commit endpoint for its
first publication, including its saved visibility choice. Publishing checks the current source again under the
wall lock, so an older client cannot bypass comparison through “Publish holds”.
Creating a version with the same uploaded photo, dimensions, corners and notes
returns its existing draft after a lost response. A different upload or mapping
still receives `SPRAY_WALL_DRAFT_ALREADY_OPEN` and must be explicitly resumed or
discarded.

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
| `sprayReferenceVisibilityCondition({ boardType, climbUuid }, userId)` | in the WHERE, over the referencing table | the smart-playlist ref queries, `browseProposals`, `globalCommentFeed`, `userProfileStats`, `followingClimbAscents`, `climbLogs` |
| `sprayClimbUuidIsReadable(climbUuid, userId)` | before the query | `comments`, `climbProposals` — the uuid-keyed threads; `climbRevisions`, a climb's edit history |

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
`viewerCanEdit`, an optional `candidates` list, the `primaryLabel` of its one
button, an optional `notice` for an empty wall, and two callbacks:
`onCommitted` (every hold is on the draft, with the count) and `onDirtyChange`
(which the host's leave guard reads before `confirmDiscardSprayEdits`). Dirty
includes confident finds nobody has touched yet: they are ON and unsaved, and a
resumed draft never re-runs detection, so leaving straight after detection
asks first. SW-09
hosts it as the review step of `/boards/spray/new`; SW-11 wires the owner's
later entry points.

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
- **Rings are holds. A tap picks one, and a tap on the picked one switches it.**
  At rest there are no finger modes, and no single tap changes the wall. The
  rule is pure (`resolveEditTap` in `spray-edit-tap.ts`, tested row by row) and
  the screen's `handleTap` is a switch over its answer:

  | Tap on | Result |
  |---|---|
  | a ring that is not picked (ON, OFF or maybe) | pick it: the chip bar for its role appears, nothing changes |
  | the picked ring | switch it: ON goes OFF (a ghost), OFF or maybe goes ON; it stays picked, so a third tap reverses it |
  | bare wall, with a ring picked | put it down |
  | bare wall, nothing picked | nothing changes; a ripple plays where it landed and the add-a-hold hint asks to be shown |

  A double tap is pick + switch with no added delay. A TAP on bare wall never
  adds a hold: that was the old rule, and on a dense wall it put a stray hold
  under every missed tap. A long press does the deliberate things:

  | Press and hold (400 ms) on | Result |
  |---|---|
  | a ring | pick it up: it is selected, and the same touch carries on into a move |
  | bare wall | place a hold: a median-size circle appears under the finger (medium haptic), slides with it, and lands where the finger lifts — one `ADD_HOLD` then `SELECT`, so one undo step, and the resize handle is on it straight away |

  Placement lives in `SprayEditGestureOverlay`: the long press no longer fails
  at touch-down on bare wall, it arms instead, and still steps aside for Join,
  a second finger, or a wall at the hold cap (`canAdd`). The circle is
  `placeHoldSV` on the UI thread, drawn by `SprayPlacementPreview` inside the
  zoom transform; the screen clears it in the layout effect of the commit that
  draws the real ring, so the two never both show or both vanish. A finger that
  slid past the board's edge lands the hold on the edge, and so does a move
  (`clampPointToPhoto`): a hold centred off the photo would be saved and drawn
  nowhere. A zoomed
  board's one-finger pan still wins a finger that moves, because it activates
  at 8 px and the long press allows 10. Add mode (the +, below) stays for
  adding several in a row, and the screen reader keeps "Add a hold in the
  middle of the view". Two fingers always zoom. Trace and Join are one-shot
  tools with a banner and a Cancel; Join still takes its second hold with a
  tap. The one mode is add mode, below.
- **Resizing is a handle on a 5% grid** (`SprayResizeHandle`). The selected
  ring carries a 12 pt dot (white edge) at the centre of a 44 pt touch box
  turned 45°, on the bottom-right diagonal. The box's flat face towards the
  hold stays 2 pt outside the hold's own disc — its farthest point, or the
  22 pt fingertip grab around a small hold, whichever is bigger
  (`resizeHandleDistance`) — so the dot sits 46 pt from a small hold's centre
  at 1x and 24 pt past a big or zoomed hold's edge. The handle has its own
  gesture detector, and a touch on it never reaches the edit surface under it;
  keeping it off the disc is what keeps a tap on the selected ring a toggle and
  a press there a pick-up at every zoom. The spec's "10 pt outside" would have
  laid the box over the whole ring of a typical hold at 1x. It flips to another
  diagonal when its touch box would leave the board or sit under the bottom
  dock (toast, chip bar) or bar (`resizeHandleAnchor`, which the dock's
  measured top feeds). It is placed in screen space, so it is the same size at
  any zoom. One finger
  drags it and the hold scales uniformly about its centre: the drag is
  projected onto the handle's outward diagonal at grab time and mapped through
  `scale = exp(pt / 120)` (`RESIZE_GAIN_PT`), so one 5% step is about 6 pt of
  travel at any zoom and on any size of hold. The size snaps to the grid
  `median × 1.05ⁿ`, with two magnets that each capture within half a step: the
  size at grab time and the wall's median. Bounds are
  `max(MIN_HOLD_RADIUS_BOARD_PX, 0.3 × median)` to
  `min(4 × median, 0.2 × the photo's shorter side)` (`holdRadiusBounds`); a
  hold already outside them (a wide merge) can still be dragged back to its own
  size, and a drag away from the bounds leaves it at that size rather than
  clamping it the other way. Each new step ticks (selection haptic, at most once per 30 ms), a
  magnet ticks light, and reaching a bound bumps medium once. A pill above the
  handle reads "+15%" against the grab size, or "Typical" on the median. The
  full-strength ring scales live on the UI thread (`resizeScaleSV` on
  `SelectedHoldOverlay`, with its stroke divided back to constant width) over
  the ghost at the original size; JS hears from the drag only when the step
  changes and once on release, which commits one `RESIZE_HOLD` (one undo
  step). Resizing an OFF ring or a maybe switches it ON and meets the cap
  check, and a refusal snaps the ring back. The chip bar's − and + step the
  same grid, one step and one undo step per press, always strictly past the
  current size (`stepHoldRadius`), so "+" can never shrink a hold. In add mode
  the hold just added keeps the handle, without the chip bar, until the next
  add or the next touch on the wall. None of this touches the ring contract:
  outlines are stored in radius units, so a resize changes `r` alone.
- **The chip bar is one set per role** (`SprayHoldChipBar`). ON: `[−] [+]
  Trace Refine Join Switch off` (− and + are 44 pt icon chips; on a 375 pt
  phone the row wraps to two). An OFF ghost: `Switch
  on  Delete`. A maybe: `Keep  Switch off`. The picked ring is drawn in its
  role's line pattern (`SelectedHoldOverlay`'s `role`), so the second tap
  visibly switches it.
- **Refine touches up an outline with a brush; Trace redraws it.** The two sit
  side by side on purpose: Trace is one loop that replaces the whole outline,
  which is right when the scan got the hold wrong everywhere; Refine is for the
  common case of one bad lobe or a missed corner, where re-tracing would throw
  away the nine-tenths that were fine. Refine (an ON ring only, like Trace)
  turns the hold into a filled violet AREA over its own faint ghost; the rest of
  the wall drops to 35% so the area reads. Plain circles start as their circle.
  - **Add | Erase** is a segmented control on the banner, beside Cancel; on
    iPad a Pencil double tap (or squeeze) set to "switch to eraser" flips it
    too, instead of leaving the tool. The brush size is three dot chips in the
    dock (radio buttons to VoiceOver) with Done: Small, Medium (default) and
    Large paint with 0.15, 0.3 and 0.6 of the hold's radius when Refine opened
    (`REFINE_BRUSH_RADIUS_FRACTION`, `refineBrushRadiusBoardPx`), never smaller
    than the engine's 3-unit floor, below which a dab vanishes in the
    decimation. Relative to the hold, not the screen: the job is fine-tuning one
    hold, and screen-point brushes were bigger than a typical hold at 1x on a
    phone (12 pt is about 66 board px on a 2048 px photo against a 40 px hold),
    so the default dab re-shaped the whole hold. The preview draws the true
    size, so zooming in shows exactly what a dab covers. Mode and size carry
    from one hold to the next for the visit.
  - **Painting.** `DrawStrokeOverlay` with `acceptStationaryTaps`, so a dab
    paints too, and the loupe for a finger. Two fingers zoom and pan
    (`pinchPans`). On iPad with "Pencil only" on, fingers pan and only the
    Pencil paints, and the banner says so. The stroke is drawn on the UI thread
    as a round-capped path one brush DIAMETER wide in board px (violet for Add,
    dark for Erase), so the preview covers what the brush will paint. When the
    finger lifts, JS runs the stroke through the shared brush engine
    (`@boardsesh/board-art-geometry/brush`, via `use-brush-session.ts` — the
    catalogue editor's brush, see `docs/board-art-geometry.md`) and the area
    redraws. The preview stays until the new area is drawn, cleared on the UI
    thread only if it is still that stroke (`clearStrokeIfStill`), so a quick
    second dab is never lost.
  - **What a stroke may leave.** Holes fill (a stored outline has none). A
    split keeps the piece holding the hold's centre, and the banner says how
    many stray bits went; that is the engine's rule, because the biggest piece
    is not always the hold (an erase that cuts a neighbour's lobe off). An
    erase through the middle keeps the BIGGEST piece and moves the hold onto it
    (`strokeKeepingLargestPiece`), so Refine can still shift a scan circle that
    sat half off its hold. An erase that leaves nothing is refused with a
    warning buzz and "Switch it off instead". Every kept stroke must still be a
    storable hold, checked there and then, so Done never refuses.
  - **One edit.** Strokes have their own undo: while Refine is open the bar's
    (and the rail's) Undo takes back one stroke, up to 20, and Redo is hidden.
    Cancel throws every stroke away. Done (and the rail's Mark, and a tap on +)
    commits ONE `SET_OUTLINE`: the centre is the area's centroid (the hold's
    anchor when a concave area's centroid falls outside it), the radius the
    equivalent-area one grown until the ring fits (`radiusForRing`), and the
    ring goes through round, close, `isValidOutlineRing` and the centre gate
    (`holdFromRefinedOutline`). So the editor's Undo takes the whole refine back
    in one step. Publish waits until Refine is closed; Start over discards it.
    An open Refine with a kept stroke counts as unsaved work for the leave
    guard (`onDirtyChange`), since its strokes reach the reducer only on Done.
  - **Resolution.** The engine works in a frame centred on the hold with its
    radius at 32 units (`REFINE_FRAME_RADIUS` in `spray-refine.ts`): 5% of the
    hold's radius whatever the photo, so the 4096 px full photo past 3x
    changes nothing.
  - **The 4x limit.** The engine's bitmap reaches from the anchor to the
    outline plus one radius, and is capped at 4 radii (`MAX_RING_COORDINATE`
    times the radius Refine opened with) along either axis, because nothing
    past that is storable: 512 x 512 cells at the cap. So Add can grow a hold
    to about 4x its original radius in any direction, and no further. An Add
    stroke whose brush crosses that line keeps what landed inside, and the
    banner says "That's as far as this hold can grow" with a warning buzz,
    rather than clipping silently; erasing out there clips nothing that
    matters and says nothing. Trace is the way to make a hold much bigger. The
    bitmap never shrinks within a session, so once a stroke has reached the
    cap every later stroke pays the cap's cost.
  - **Cost per lift.** Measured through the session (`useSprayRefineSession`,
    60 strokes of the three sizes on a 40 px hold, Node on the dev box): about
    19 ms median with the relative brushes, whose frame stays near 310-350
    cells a side; 48 ms median once a stroke has pushed the bitmap to the
    512-cell cap. Hermes runs these loops several times slower than Node's JIT,
    so expect tens of milliseconds per lift on a phone and around 100 ms at the
    cap. The cost lands once per lift on the JS thread, never during a stroke,
    and the stroke's preview stays on screen until the new area is drawn.
- **Nothing is removed by accident.** Every switch-off is a ghost — a hold this
  session drew by hand included, which used to vanish on its second tap. A
  ghost is never written (`buildSprayHoldWritePlan` skips rejected holds and a
  re-seed drops a hand-drawn one), and only a ghost offers Delete, so taking a
  hold off the photo is two deliberate steps. Delete, Join, Keep all maybes and
  Start over raise `SprayUndoToast` ("Joined 2 holds · Undo") in the bottom
  dock above the chip bar for 4 s; the next edit takes it down, so its Undo can
  only undo what it names, and an edit the reducer refused raises no toast at
  all (`actionChangesWall`: the action must move `past`). The toast's Undo
  always takes back a wall edit, never the last corner of a Corners outline
  in progress the way the bar's Undo does. It is drawn inside the screen because the app's global toast draws
  behind this modal. Toggles raise no toast: the ring is still there.
- **Undo has Redo.** The reducer keeps a `future` beside the capped `past`:
  Undo pushes the present onto it, `REDO` pops it back, and every new edit,
  `LOAD` and `MARK_SAVED` empties it. `MARK_REMOVED` scrubs it the same way it
  scrubs the past, or a Redo could bring back a hold the server has already
  stamped off. Selecting leaves it alone. In the bar, Undo and Redo share one
  split glass pill and the Redo half only fades in while there is something to
  redo; Redo spotlights the hold it changes with the same violet halo as Undo. The gesture surface (`SprayEditGestureOverlay`) hit-tests on the UI
  thread only to decide whether a long press has a ring under it, and whether a
  touch-down claims a drag of the selected ring — which it does only when the
  full hit test at that point names the selection, so a touch on a neighbour
  inside a big selection's grab radius never moves the selection. Every tap is
  resolved in JS by `holdAtPoint` (smallest containing hold first, then the
  nearest centre within `max(1.4r, 22 pt on screen)`). With maybes hidden, a tap
  on a hidden maybe picks it, so the chip bar can keep it or switch it off.
  Moving, resizing or tracing an OFF ring or a maybe switches it ON, so each is
  held to the hold cap like an add. To a screen reader the wall is one image
  labelled with the counts, and activating it does nothing: the bar and the chip
  bar are the accessible path. The wall also keeps its "Add a hold in the middle
  of the view" action in the resting editor, and its named actions follow the
  chip bar's roles (Make smaller / Make bigger for an ON ring, Delete for a
  ghost). Make smaller / Make bigger move four grid steps (about 22%) per
  swipe and one undo step, where a chip press moves one. Add mode itself is a
  touch tool.
- **Add mode is for the holds detection missed** (#5906). At rest a tap never
  adds, so a press and hold places one at a time and the glass + in the bottom
  bar, after the count capsule, is how a run of them goes in. It is an icon, not a label, so the row fits a 375 pt phone with the
  Undo | Redo pill at its widest and German counts.
  While add mode is on the + becomes a check, and the check and the banner's
  Done both leave it. It is the one tool that is a mode rather than one-shot: it
  stays on until Done, so several missed holds go in one go. In add mode no
  touch selects, toggles or picks up a ring. Because Draw takes every
  one-finger touch, the editor passes `pinchPans` to `InteractiveFilterBoard`:
  two fingers pan as well as zoom, so a climber can move across a zoomed wall
  without leaving add mode. Every other board keeps the pinch as zoom only.
  Undo removes the last corner while an outline is in progress, then falls back
  to the reducer undo (the last added hold), and never brings back a selection
  in add mode. Publish is disabled while corners are placed but not closed.
- **Add mode has two shapes, Draw and Corners.** A Draw | Corners segmented
  control on the banner picks one and is remembered per device in AsyncStorage
  (`boardsesh_spray_editor_add_shape`, default Draw).
  - Draw: one finger drags round the hold, and the stroke goes through the same
    `holdFromStroke` then `buildOutlineRing` chain as Trace. A stroke that stays
    within 10 screen pt is a tap and drops a circle at the median radius. Add
    captures raw pointer DOWN and matching UP with a Manual gesture, so a
    stationary tap or long press commits without waiting for Pan movement.
    Cancellation releases that pointer before handing a pinch back. Trace
    keeps its existing Pan recognizer. If a
    second finger lands during a finger stroke, the stroke is dropped and the
    pinch zooms (Trace works the same way); a Pencil stroke still ignores a
    resting palm.
  - Corners: touch the photo, slide to the exact spot and lift; the corner
    lands where the finger lifted, and a quick tap still drops one where it
    landed. `PolygonTapOverlay` is a Manual recognizer that owns one pointer
    from touch-down to lift, as Draw does, so a slide positions the corner
    instead of panning the board: a zoomed board pans with two fingers here
    too (`pinchPans`). A second finger drops the corner and the pinch zooms.
    A live preview is drawn on the UI thread so corners never round-trip
    through React per frame. The corners
    live in one shared value, and the corner count React shows is derived from
    it. Tapping the first corner once there are 3, or pressing the Finish chip,
    closes the outline. The close target is 11 pt, capped at 35% of the
    outline's own size (`CORNERS_CLOSE_EXTENT_FRACTION`); without the cap the
    fourth corner of a small hold at 1× landed inside the target and closed a
    triangle. The closing tap empties the corners on the UI thread before JS
    hears of it, so a quick second tap cannot add the same hold twice. `holdFromPolygon` keeps the corners exactly, with no
    stroke sampling, no loop-closing trim and no simplification. It refuses
    fewer than 3 corners or zero area, more than the ring contract's cap
    (`POLYGON_MAX_VERTICES`), crossing sides (`self-overlap`), and a shape whose
    centre falls outside it. A refused outline keeps its corners so they can be
    fixed, with Corners-specific copy (`errors.cornersCross`,
    `cornersTooFew`, `cornersHollow`). Done closes a valid outline before
    leaving; one that cannot close keeps add mode on with its error.
- **A loupe follows the finger** (`SprayLoupe`), so a thumb never hides the
  spot it is drawing, placing or moving. It shows during Draw, Trace and
  Refine strokes, a Corners touch, a move of the selected ring, a press-and-hold
  placement and a pick-up — and only once the touch has lasted 120 ms or
  moved 4 pt (`loupeGateOpen`), so a tap never flashes it. A gesture that is
  already long, like the 400 ms pick-up, shows it at once. Fingers only: a
  Pencil's tip hides nothing, so a stylus never gets one. It is a 112 pt
  circle centred 88 pt above the touch; with no room above it moves the same
  distance to the side, left by default and right when left would leave the
  screen, keeps that side while it fits, and only comes back above with
  12 pt to spare so it cannot flicker at the boundary (`loupePlacement`). It
  magnifies the unzoomed board `min(2 × zoom, 12)` times, with a hairline
  crosshair and a centre dot on the exact point under the finger. It is
  mounted in the screen, outside the board's clip, so it can overhang the
  board's edge and draws over the chrome; it takes no touches and is hidden
  from screen readers. Inside the circle is a board-sized view moved by one
  animated translate and scale (`loupeInnerTransform`, which accounts for RN
  scaling about the view's centre: `t = size/2 − c − (p − c)·m`), holding a
  second `expo-image` of the same URI (a memory-cache hit), the same dim, and
  second instances of `SprayHoldSvgLayer` (with the loupe's magnification as
  its scale, so strokes stay thin, and the board's zoom as its
  `geometryScaleSV`, so the Corners dots and close target are magnified with
  the photo and the target covers exactly what `PolygonTapOverlay` closes
  on), `SelectedHoldOverlay` (with
  `syncSharedValues={false}`: the board's copy owns re-syncing) and
  `SprayPlacementPreview`. Those layers draw from shared values, so the
  stroke, the Corners preview, the move and the placed circle show in the
  loupe for free. The loupe cannot read the board's zoom transform from
  where it is mounted, so the overlay that owns the touch writes a
  `SprayLoupeFeed` (`spray-loupe-feed.ts`): the touch-down time (0 when off),
  the finger in the board clip's points, the point under it in render px,
  and the zoom. An overlay unmounted mid-touch (a tool chip or Done tapped
  with a finger still on the wall) never finalizes, so each one clears the
  feed on unmount while it still carries its own touch
  (`useReleaseLoupeOnUnmount`). The loupe's own state across readings — the
  touch's start point, its side and whether the gate has opened — is one
  pure step per reading (`stepLoupe`). It is always mounted at opacity 0, and
  only transforms and opacity animate, so a gesture never re-renders it; the
  second ring layer re-renders only when the rings do, or on the first touch
  after a pinch that crossed a stroke step (the feed's zoom is written at
  touch-down). `DrawStrokeOverlay` takes the feed as
  an opt-in `loupe` prop, which the catalogue editor never passes. The
  resize handle has none (the finger is beside the ring, not on it), and
  the anchors step has none yet.
- **The spray editor zooms to 8x, every other board to 4x.** The editor passes
  `maxScale={SPRAY_EDITOR_MAX_SCALE}` (8) to `InteractiveFilterBoard`, which
  hands it to `useZoomPanGesture`. Everything else keeps `MAX_SCALE = 4` from
  `@boardsesh/play-view`: climb view, search, zone, the catalogue outline
  editor, reset compare and web. Ring strokes snap through zoom steps 1, 1.5, 2,
  3, 4, 6 and 8 so they stay thin.
- **Past 3x the editor swaps in the full-resolution photo (#5911).** The base
  photo is 2048 px on its long side, so at 8x a phone shows at most about 190
  of its pixels across and a small hold goes soft. On iOS it is fewer still:
  expo-image resizes the base to the view's un-zoomed pixel size (about 1179 px
  across on an iPhone), so 8x shows about 150. Decoding the base at full size
  too is a possible follow-up. A version uploaded larger also has a
  copy at up to 4096 px, which only the draft read (`GET_SPRAY_WALL_DRAFT_RENDER_DATA`)
  asks for, as `photoFullUrl`; the climb view, search and every other read keep
  the base alone. The editor hands it to `InteractiveFilterBoard` as
  `fullResolutionPhoto` (`spray-full-photo.ts`), and `FullResolutionPhotoLayer`
  draws it over the base, inside the zoom transform.
  - **Fetched on the first zoom past 3x** (`SPRAY_FULL_PHOTO_MIN_SCALE`), not on
    open: a 4096x3072 photo is about 48 MB decoded. One `useAnimatedReaction`
    tells the JS thread once, on the first crossing.
  - **No flash.** The base stays mounted underneath and shows until the full
    photo has loaded, so the swap reads as the wall sharpening. Both are drawn
    `fill` into the same box, so every ring stays where it was.
  - **Decoded at full size.** The layer passes `allowDownscaling={false}`.
    Without it expo-image on iOS resizes any image larger than its view's
    pixel size down to that size, `fill` included, and the zoom transform does
    not change the view's layout box, so the 4096 px copy would land smaller
    than the base. Android's `fill` path keeps the pixels either way.
  - **Kept for the visit.** Zooming back out does not unload it, so a climber
    working up and down the wall decodes it once. It is cached in memory only,
    like the base, under a key naming the version (`spray-full/<wallUuid>/v<versionId>`),
    so a refetch that re-signs the URL does not download it again.
  - **A lapsed signature is refetched.** The first deep zoom can come after the
    draft's 15-minute signature ran out; a load that fails past `photo.expiresAt`
    reads the draft again for fresh URLs, at most once a minute. Any other
    failure leaves the base on screen.
  - **Walls without a copy are unchanged.** `photoFullUrl` is null for every
    version uploaded before #5911 and for any photo already 2048 px or smaller;
    the editor then shows the base alone, as before.
- **Motion is whole-layer or one spotlight, never per hold.** After a fresh
  scan (`revealOnMount`) the ring layer is revealed by a 700 ms top-to-bottom
  clip of one wrapper view, with the scan band riding its edge, then the maybes
  fade in (one SVG group's opacity) and a success buzz closes it; a resumed
  draft opens without it. The board, the bars and the "?" take no touch until
  the reveal ends, so a tap cannot land on a ring that is not drawn yet. A
  toggled, added, undone or redone hold is marked by `SprayHoldSpotlight`, one
  small box at that hold that springs, ripples or pulses violet; a ring switched
  off pops in the OFF ghost's dotted style, never as a solid ON ring, and a tap
  on bare wall with nothing picked throws the ripple alone (`ping`). Publishing
  sweeps the ON rings violet (`SprayPublishSweep`) and turns the count capsule
  into a checkmark, and `onCommitted` fires once that has played, about 700 ms
  later. From the press until then `onHandoverChange(true)` tells the host, and
  the wizard swallows every back gesture without a dialog (`leaveDecision` in
  `add-wall-machine.ts`): the dirty flag is already clear, so the generic
  "draft kept" question would otherwise appear, and either answer would race
  the hand-over. A Leave pressed on an older dialog is re-checked when pressed
  (`leaveStillApplies`) and dropped if publishing began under it. A screen
  reader hears each hint as it appears, the counts when the reveal ends,
  "Holds saved", then "Publishing your wall…". Every frame is a UI-thread transform,
  opacity or clip height; the ring SVG never re-renders for an animation. With
  Reduce Motion the reveal is a 150 ms fade, taps change the rings with no
  extra motion, the undo halo is a static 300 ms highlight, the count only
  crossfades, and publishing shows the checkmark alone.
- **First-run hints, one at a time** (`use-spray-editor-hints.ts`): tap a
  ring to pick it and again to switch it, then (only with maybes on the wall)
  tap a dashed maybe and Keep it, then after three edits press and hold to move
  a ring. A fourth, "Press and hold to add a hold.", waits to be asked: the
  first tap on bare wall with nothing picked shows it ahead of the others, and
  adding a hold (a press and hold, or add mode) or closing it uses it up. Each is marked seen when the climber does the thing
  or closes it, never just for showing; picking a ring or tapping bare wall is
  not an edit for the long-press gate. On iPad a fifth, the Pencil hint, is
  asked for by the first Pencil (see "The iPad editor and Apple Pencil"). The
  top-right "?" (the rail's "?" on iPad) replays them all for the session. None show in screenshot mode or on a read-only wall. The tap
  hint is stored under a new key (`onboarding_tip_spray_tap_select_seen`, not
  the old `..._toggle_seen`), so a climber who learned "a tap switches a ring"
  sees the new rule once.
- **Provenance survives a round trip.** The render payload carries each stored
  hold's `source` and `confidence`, the registry carries them into photo space,
  and the seed reads them back; without that, an accepted detector hold is
  re-submitted as MANUAL the first time it is nudged, overwriting what the wall
  records about where its holds came from.
- **Confidence sets the starting state, not a slider.** A find at or above
  `SPRAY_ON_CUTOFF` (0.75) opens ON; between `SPRAY_MAYBE_FLOOR` (0.6) and the
  cutoff it opens as a dashed amber MAYBE that is drawn but not written; below
  the floor the seed drops it. The worker only sends finds at or above its
  manifest's `thresholds.default` (0.6 for `2026-09-18-seg`), so the app works
  inside a 0.6–1.0 band; a cutoff under 0.6 would make every find ON. Both
  constants live in `spray-hold-tools.ts` with their provenance (on a 240-hold
  validation wall: 224 finds, 189 ON, 35 maybes); re-derive them once a seg
  precision curve is checked in. Tapping a
  picked confident find switches it OFF (a faint dotted ghost, never written);
  tapping a picked maybe or ghost switches it ON, and a maybe's Switch off chip
  makes it a ghost too. A stored hold switched off is queued for
  `removeSprayWallHolds`, and switching it back takes it off the queue.
- **One pure step builds the commit.** `prepareCommit` accepts the confident
  finds and builds the write plan in one go, and is idempotent: run on its own
  output it hands back the same state and plan, and after `MARK_SAVED` a second
  run has nothing left to upsert — so a double press cannot write a hold twice.
  The screen still refuses a second press while one is in flight.
- **A save clears the dirty flags of the holds it actually wrote**
  (`MARK_SAVED` takes the ids), rather than waiting for the refetch, and drops
  the undo history and the redo future — a snapshot from before the write still holds those finds
  as unwritten, and undoing into it would let the next commit write them again. Until they
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

**A wall's own look wins, unless the climber opted out.** The wall's look is
read in its own query (`GET_SPRAY_WALL_LOOK`), never in the shared
`SPRAY_WALL_FIELDS`: a field a deployed backend lacks fails validation for the
whole operation, and in the shared fragment that took down creating, loading and
drawing every wall. `loadSprayWall` starts that read alongside the render
payload and registers the wall with the look already on it, so a surface draws
once rather than in the climber's settings and again when the look lands. The
read never rejects; a failure registers "no stored look" and is retried after
30 s. The value runs through `sanitizeBoardRenderDefault` (a `JSON` scalar
promises nothing: an unknown mode or a missing knob bundle reads as "no stored
look", a present bundle is clamped like a stored preference, an unknown option
name falls back to that knob's default).

`useNativeClimbRender` subscribes to it through `sprayBoardRenderDefault(boardName,
layoutId)` — `null` off spray — and `boardLookForRender` decides whether this
render uses it: not for a climber who turned on "Use my look on spray walls"
(`spray-wall-look-preference.ts`, its own AsyncStorage key so applying a preset
cannot reset it), and not for a preview card or the heatmap, which each ask for a
specific drawing. The rule is whole-bundle: the wall's mode AND its knobs, with
the climber's own Role glyphs kept on (the same floor a preset pick respects).
It is not "only for a climber on `mode: 'default'`": the onboarding look step
stores an explicit mode for nearly everyone, so that rule meant almost nobody saw
a wall's look. The look moves the render signature with it, so the two never
share a PNG. It has its own subscription rather than riding `sprayCacheToken`,
because a look stored without a reset does not move the version. The registry
keeps an unchanged look's identity across re-registrations, so a revalidation
does not re-resolve every row.

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

### Maintenance on the live wall sheet

`sprayDetailRows(board)` is the gate behind the wall-maintenance rows ("Edit
holds", "New photo"): two rows on a spray wall whose `canEdit` is true, none
anywhere else. It reads `canEdit` rather than `isOwned` because that is the field
the spray API gates every version mutation on, so the affordance and the
permission cannot drift.

`SprayWallActions` renders these rows in the live `BoardSheet` list header,
alongside sharing for public and unlisted walls. The kiosk column has no account
actions. The Boards picker's `BoardDetailSheet` retains details, sharing and
reporting; maintenance lives on the active wall's live sheet.

Both routes use `wallUuid`; restored links with `boardUuid` still work. The hold
route rechecks edit access and resumes the wall's one open draft. With no draft,
it creates one from the current published photo using `sourceVersionId`, without
uploading the photograph again or changing its coordinate frame. Editing saves
the draft, then publishes it. An uncertain response is reconciled before retry;
refreshing a successful publication never publishes a second time. Leaving
retains the server draft, with confirmation for unsaved changes.

Re-cropping a published wall's photo is not offered, on purpose. "Edit holds"
reuses the published photo through `sourceVersionId`, which copies the photo,
anchors and homography exactly, and the schema refuses anchors together with
`sourceVersionId` — so there is no way to say "the same picture, cropped". A
cropped re-upload would carry a new `photoId`, and `classifySprayDraft` reads a
new photo as a reset, which asks for four corners and runs the reset review.
Re-cropping needs its own draft purpose
([#6156](https://github.com/boardsesh/boardsesh/issues/6156)). To crop
a wall today, reset it and crop the new photo.

Maintenance navigation and sharing wait for `BoardSheet.dismissAndWait()` to
settle. `DrawerHostProvider` owns the share snapshot and sibling share sheet, so
the panel's normal dismissal/unmount cannot lose it. A board switch, changed
permissions/visibility or reopening cancels a pending handoff. The share payload
stays mounted through its own closing animation.

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

### Refresh after publication

After a reset commits, `refreshPublishedSprayClimbs` refreshes climb integrity
before the local-first climb list refetches. For a downloaded wall, it awaits
one `pullSync` invocation scoped to `spray:<layoutId>:<layoutId>`; the existing
engine owns bounded delta paging. Shared `pullSync` serializes cycles per SQLite
handle, including scheduler pulls, and each refresh awaits its own queued cycle.
Its purge token and board scope are captured before waiting so sign-out or wall
removal cannot authorize stale work when the queue advances. It then invalidates `searchClimbs`,
`infiniteSearchClimbs`, `searchClimbsCount`, and `climb`. Walls that are not
downloaded, or whose SQLite schema or offline engine is unavailable, skip the
pull and still invalidate those readers. An offline or backgrounded pull can
be deferred by the engine; a thrown refresh error is reported without turning
an already committed reset into a failed publication. Freshness then waits for
a later successful sync.

The modern existing-wall hold editor uses the same refresh after publishing
hold changes. The onboarding Look step retains its separate first-publication
flow.

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

The reset's photo step has the same "Crop or rotate" detour as the add-a-wall
flow (`adjust`, uncounted). Its copy adds one thing: keep all four corners inside
the crop. From version 2 on the corners are mandatory (`assertResetVersionIsAnchored`),
so a corner cut off by the crop is a corner nobody can mark, and the gate would
hold the flow on the anchors step with no way to satisfy it but to crop again.
The crop itself changes nothing the reset depends on: version 1's frame is
inherited under the wall lock, and the new photo's homography is solved from its
own anchors in its own (cropped) pixels.

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

### Marking a reset as full

The compare view has a **Full reset** switch above Confirm, off by default. When it
is on, the commit sends `fullReset: true`, and every climb that loses a hold in
that reset is retired: it leaves the wall's default list but stays in logbooks,
playlists and share links (#6024). The switch sits inside the scrolling controls,
not in the footer, so the board keeps the space `CHROME_BUDGET` gives it.
`Spray Wall Reset Applied` carries `fullReset`.

### A climb that lost holds

`Climb.missingHoldCount` reaches three mobile surfaces, and the rule across all
three is that a broken climb stays findable and stays playable:

Compatibility treats a reported lost hold on the same spray layout as historical
content. The play drawer and playlist rows keep logging, queue and favourite
actions available. A different wall or known incompatible size still fails the
normal compatibility checks; catalogue-board hold containment remains strict.

- the climb-row chip ("2 holds gone"), beside the Hidden chip and in the same
  neutral grey — colour in that row means grade and nothing else;
- the **Holds** filter in the climb filter sheet (Current / All / Intact only /
  Lost holds), defaulting to Current. Current sends nothing, and the server
  then hides only climbs a full reset retired (#6024), so a climb that lost
  holds in a partial reset stays listed. All sends `ANY` on a spray wall and
  shows retired climbs too; Lost holds shows every climb that lost a hold,
  retired or not;
- the play drawer banner, which states the number and offers the one thing that
  fixes it. Remix goes through the same `useCreateClimbNavigation` handoff the
  climb-actions sheet uses, carrying the parent's frames — the create editor's
  own sanitiser drops the hold ids that are no longer on the wall, so it opens
  with exactly the holds that survived.

`Climb.lostHolds` carries the geometry of those holds as they were. The create
editor draws it (#5493); the play drawer does not yet, because it renders through
the board render pipeline rather than `InteractiveCreateBoard`'s `overlay` slot.

### Fixing a climb that lost holds, in the editor

**Set active opens the editor for someone who can fix it.** `openPlayDrawer` in
`DrawerHostProvider` is the one door every list, queue-sheet, board-sheet and
suggestion tap goes through, and it asks `useLostHoldsAutoEdit` first. The rule,
`shouldAutoEditBrokenClimb`, routes to the editor in edit mode only when all of
these hold, and otherwise the climb plays with the banner as before:

- `missingHoldCount > 0` on a spray climb, on the climber's own wall;
- the viewer can edit it (`canEditClimb`: the setter, a wall editor, or a
  collaborator under the `'collaborators'` policy);
- `lostHoldsEditReadiness` is `'ready'` (the device's wall agrees with the server
  and some holds survive);
- the open makes the climb current: not a preview, not a crew session (a tap there
  is a look), and not the climb that is already current;
- the `/play` route is not already on screen. Inside the player (a swipe, a
  similar climb, a browse commit, a queue tap over it) the banner's Edit is one
  tap away, and leaving the player would lose the climber's place. The iPad's
  side pane does not count: it stays on screen under the editor, so routing
  from it loses nothing.

The routed climb is still made current, so the next open of it (the bottom bar, a
second tap) is a reopen and plays it. That is what stops a climber who backed out
of the editor from being sent back in. Closing the editor is a plain back to the
list. A second tap inside 1.5 s is swallowed rather than opening the player over
the editor. The route is counted as `Climb Edited From Broken` with
`source: 'set_active'`.

**Ghost rings.** The editor (edit, and remix through the `forkParentUuid` route
param) asks `GetClimbLostHolds` for the climb's `lostHolds` and maps each one
through the registered wall's inverse homography, the same map the live holds
went through (`RegisteredSprayWall.homography`, set by both loaders). Each lost
hold the climb used and the device's wall no longer has is a dashed ring in its
old role's colour (`LostHoldGhostLayer`, in the `overlay` slot). The ghosts join
the board's hit targets — a lost hold's id can never be a live hold's — so a tap
on one opens `LostHoldSheet` instead of painting.

A banner floats over the top of the board ("1 hold on this climb is gone — tap
the dashed ring to replace it"). It floats rather than sitting above the board
because the drawer's peek height is measured from the blocks above the fold, and a
banner that came and went there would re-snap the sheet.

**Use a hold nearby.** The sheet's first action highlights
candidates on the board, from `rankReplacementCandidates` in
`@boardsesh/create-climb-react`: the live hold whose `movedFromHoldId` names the
lost one first, then the nearest free holds within eight radii, or the three
nearest when none are that close. Holds already in the climb are never offered.
Tapping a highlighted hold places it in every frame the lost hold was in, with the
role it had there, as one undo step (`placeHold`). Any other tap is swallowed
while the pick is open. If the role is full (two starts or two finishes), the
banner says so and the pick stays open.

A ghost leaves once something stands in for it: the hold picked for it this
session, or any painted hold whose centre is inside the ghost's radius. The second
rule covers a restored autosave, which carries the paint but not which ghost it
answered. A replacement picked from further away than that shows its ghost again
after a restore. The ghost is only a picture; Save is unaffected.

**Offline.** The device mirrors `missing_hold_count` but not the hold history, so
the positions need a connection. With no signal the banner still states the count
(the device's own: the climb's holds its wall no longer has) and says the rings
need a connection.

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

The photo steps leave JPEGs in the app's cache directory: the compressed base,
`expo-image-picker`'s copy of the original, a turned preview per quarter turn
the crop step drew, and each rendered edit. The crop step deletes its own
previews when it closes (a preview that finishes rendering after that is deleted
as it lands), and applying a new edit deletes the edit it replaced
(`discardLocalPhoto`, best effort; a no-op in the browser build). The base and
the original are never deleted mid-flow — the base is what a re-edit starts
from, the original what it renders from — and are left, like the picker's other
files, to the OS's own cache eviction.

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
| `sprayWallReports(uuid)` | The pending queue, newest first, excluding walls the owner has since deleted — those are no longer work. Admins only. Each report carries `wallName` and a nullable `photo` preview behind private-bucket presigned URLs. The admin route groups reports by wall. |
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

The Boards picker mounts `BoardDetailSheet` through a Details action on each
spray-wall card, plus the active wall's Details control. The active control
also covers an unlisted wall opened through a share link that is not in the
climber's saved list. Any signed-in viewer can choose Report wall and one of
the four fixed reasons; edit permission is not required, and there is no
free-text field. `CREATED` and `ALREADY_REPORTED` both confirm quietly.

Settings → Moderation → Spray-wall reports opens `/moderation/spray-walls`,
a root-stack modal available to global or spray-scoped community admins. The
queue groups pending reports by wall and shows its name, current photograph
(or latest draft for an unpublished wall), and reasons. Hide wall and Keep
visible/Unhide both call `setSprayWallHidden`, which reviews every pending
report for the wall. General wall visibility rules are unchanged: privileged
photo previews are produced only inside the admin-authorized queue query.

Reporting and review both read `climb-moderation-kill`; they wait for flag
resolution before accepting actions. Signed preview URLs remain in memory,
are refreshed when expired, and never enter persistent storage.

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

Eight events, all in `SHARED_EVENTS` with typed builders in
`packages/shared/analytics/src/spray-wall-events.ts` (the `board-render-events.ts`
style: each builder returns `{ name, properties }` together, so a call site
cannot pair one event's props with another event's name). Mobile fires them
through `trackSprayEvent`; nothing calls `track` with a spray event name directly.

| Event | Properties | What it answers |
| --- | --- | --- |
| `Spray Wall Photo Picked` | `source` | Camera or library — the two feel different on a slow phone. |
| `Spray Wall Upload Finished` | `outcome`, `durationMs`, `determinate`, `attempt`, `cropped?`, `rotated?` | Whether the photo lands, and how long a climber waits for it. `cropped` and `rotated` say whether the photo step's crop step changed the photo (two booleans, never the rectangle or the angle); older clients omit both, so a missing value is unknown, not false. |
| `Spray Wall Detection Finished` | `outcome`, `candidateCount`, `durationMs` | `unavailable` is a SUCCESS — the flow lands in the editor in manual mode. Read it against `ok` for the fraction of the fleet placing every hold by hand. |
| `Spray Holds Reviewed` | `holdCount`, `candidateCount`, `hadCandidates` | Candidate and saved counts on the same event. Older clients omit candidateCount. |
| `Spray Wall Bind Stalled` | `stage`, `elapsedMs` | A wall that published and then sat on "Setting your wall up…": `visibility`, `fetch_board` or `bind` ran past 30 s, or `navigate` was dispatched and the wizard was still on screen 1.5 s later. |
| `Board Created` (existing) | `boardType: 'spray'` | Closes the add funnel. The SAME event every other board type fires — a spray-only variant would hide walls from every board-creation number we already watch. |
| `Spray Wall Reset Previewed` | `keptCount`, `removedCount`, `addedCount`, `lowConfidenceCount`, `climbsAffected`, `aspectMismatch`, `detectionCount` | What the matcher found. |
| `Spray Wall Reset Applied` | `keptCount`, `removedCount`, `addedCount`, `climbsChanged`, `moveCount` | What landed. The server's counts, not the review's. |
| `Climb Remixed From Broken` | `lostHoldCount`, `source` | Whether a climb a reset broke is a dead end or a starting point. |
| `Climb Edited From Broken` | `lostHoldCount`, `source` | How often the setter or a wall editor repairs a broken climb in place instead of remixing it. |

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

## Availability and detection quality

Spray walls are enabled by default. The picker tile and `/boards/spray/*`
routes do not depend on PostHog or an enablement environment variable. The old
`spray-walls` flag and on-device overrides no longer gate these surfaces.
Maintenance requires the additive backend `sourceVersionId` input. Deploy that
backend contract before shipping a mobile build
with maintenance; this deployment order is independent of wall availability.

The detection service has separate deployment and quality checks in
[the service rollout runbook](spray-recognition-rollout.md). Enabling the mobile
surface does not certify those checks or deploy a detection worker. The upload
success, detection correction and reset commit ratios remain available through
`SPRAY_ROLLOUT_GATES` in `spray-wall-events.ts` for monitoring. The correction
rate is a proxy, not an F1: equal candidate and saved counts can hide corrections.

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
host-wide `applinks:` entitlement. Android's verified intent filters in
`packages/mobile/app.config.ts` include `/b/` on `www.boardsesh.com`, alongside
`/join`, `/preview`, `/auth/reset-password` and one prefix per board name for
classic climb links, repeated under `/es`, `/fr` and `/de`. The apex `boardsesh.com` is not claimed on Android: it
answers `assetlinks.json` with a redirect, which fails verification.
The native-intent handoff preserves the query string through
`useLocalSearchParams`. Board adoption awaits `sprayWall(uuid)` with the
complete board fields, then checks the returned wall UUID and board slug against
the link before adopting it or seeding the rendering cache. This lets a recipient
who neither owns the wall nor belongs to its gym open an unlisted share without
the enumerable `boardBySlug` lookup. Denied or mismatched capabilities never
fall back to a stored board or populate the public slug cache.

The `/b/<slug>/<angle>/view/<climb>` and `/play/<climb>` routes also pass
`wall` through board adoption. Climb reads retain their separate backend access
rules: this wall-list share fix does not grant a nonmember access to an unlisted
wall's individual climb link.

`SprayWall.uuid` is the owning `UserBoard.uuid`: the backend resolves UUID
lookups through `spray_walls.board_uuid` and returns `board.uuid`. The numeric
`spray_walls.id` stays internal. Native adoption checks both UUID fields against
the capability to prevent adopting a different board from the response.

Capability links require a fresh network authorization, including previously
opened links. Offline opens show not found without adopting cached wall content;
reconnecting retries the lookup automatically. This keeps revoked shares from
reopening a wall through stale cached permissions.

Adding the filter moves the native fingerprint, so Android needs the new store
binary from `release/next`; an OTA on an older binary cannot add it (SW-14b).

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

On the catalogue boards a published climb can be edited by its setter for 24
hours and then locks. A catalogue board is shared by everyone who owns one, so a
published climb is something other people have already sent and logged.

A spray wall is one physical wall, and its holds move. A climb set last year may
need a new start hold next week. So on spray (#5955, #6025):

| The climb is | Who can edit it | For how long |
| --- | --- | --- |
| A draft | Its setter | Always |
| Published (`climbEditPolicy: 'setter'`, default) | Its setter, or anyone who can edit the wall | Always |
| Published (`climbEditPolicy: 'collaborators'`) | Its setter, anyone who can edit the wall, or anyone who can set climbs on the wall | Always |

"Anyone who can edit the wall" is `canEditBoard` in `social/boards.ts`, the same
rule that guards the wall's holds, with nothing added for climbs:

- the wall's owner;
- the owner or an admin of the gym the wall is linked to (a gym `editor` cannot);
- a community admin or leader for spray, on a public wall only.

`requireBoardEditAccess` is that function plus a throw, so the two cannot drift.
**`requireBoardEditAccess` is NOT widened by the climb edit policy.** Editing holds,
resetting photos and publishing wall versions stay restricted to the wall owner
and gym admins.

When the wall owner selects the `'collaborators'` policy (#6025), anyone who can
write climbs on the wall (`viewerCanWriteSprayClimbs`: gym members on gym walls,
share-link holders on unlisted walls, or anyone on public walls) may also edit
published climbs. Only the wall creator may change the wall's `climbEditPolicy`.

Four things the rule is careful about:

- **The setter stays the setter.** `updateClimb` never writes `user_id` or
  `setter_username`, and a regrade goes on the climb's stats row with
  `fa_username` left as it was. A collaborator or wall owner who fixes your climb
  has not taken it. Who made each edit is in the revision history instead.
- **A draft is its setter's alone.** Collaborators and wall editors cannot edit or
  publish somebody else's draft. Publishing announces a new climb to followers, and
  it would announce it under the wrong name.
- **An editor has to be able to see the wall too.** The setter's edit needs
  `viewerCanWriteSprayClimbs`, as before. Collaborators need `viewerCanWriteSprayClimbs`
  and `'collaborators'` policy. Wall editors need that and `canEditBoard`.
- **One refusal for every stranger.** A caller who is neither the setter nor
  permitted by the wall's policy gets `You can only update your own climbs` with
  the code `CLIMB_EDIT_NOT_ALLOWED`, whether the wall is private, unlisted, or
  public, or the climb is a draft. It is the message the mutation always gave,
  and it does not say that a wall exists.

Not changed: a climb that has lost holds to a reset still cannot be saved until
the edit moves it onto holds that are on the wall (`assertSprayHoldsAreAlive`
runs on every spray edit). An edit never moves `published_at`.

### The Edit action in the app

The app offers Edit from one shared rule, `canEditClimb` in
`@boardsesh/create-climb-react`, used by both menus (`ClimbActionsSheet` and
`use-climb-actions.ts`). It is the table above plus the catalogue rule (setter
only, 24 hours).

It is a hint. `updateClimb` decides.

- **Where "can edit climbs" comes from.** `RegisteredSprayWall.viewerCanEditClimbs`
  in the spray registry, filled from `sprayWallRenderData.wall.viewerCanEditClimbs`.
  Only a literal `true` counts, and a re-registration never inherits the last
  answer. `SprayWall.viewerCanEdit` continues to guard the hold editor and photo
  reset screens.
- **Which climbs it covers.** Only climbs on that wall. A queue can hold a climb
  from another wall or from Kilter; when the climb carries `boardType` or
  `layoutId` and they say it is somewhere else, a wall editor is not offered
  Edit on it.
- **How stale it can be.** Ten minutes, the registry's revalidation window.
  `useSprayWallViewerCanEdit` asks for the wall each time a menu mounts, which
  is what re-reads it.
- **Account changes.** The registry is module state and outlives a sign-out, and
  the app tree below `AuthProvider` is replaced on every auth change, so the
  reset lives in `AuthProvider`. Signing in, and the signed-out cleanup beside
  `queryClient.clear()`, call `refreshSprayWallViewerAccess`: every wall reads
  "cannot edit" at once and is refetched. A flip to signed-out with no cleanup
  only calls `dropSprayWallViewerAccess`, which fetches nothing. A native
  keychain failure flips that way, and a request sent then carries no token, so
  a private wall would resolve null and be withdrawn from the live player.
- **A request that crosses the account change.** The registry counts account
  changes (`sprayWallViewerGeneration`). A fetch notes the number before it
  leaves, and it is part of the published render-data query key, as an object
  (`{ viewerGeneration }`), so it can never equal the hold editor's draft key,
  whose third segment is a version number. Two accounts never share a request
  or a cache entry. A payload that lands under a different number registers the
  wall but not its `viewerCanEdit`, and is stamped stale. `loadSprayWall` asks
  once more by itself when it sees the number moved. The hold editor's draft
  and its publish reload pass the generation they fetched under too, so the
  owner keeps Edit while and after editing holds.
- **When the hint is wrong.** A role taken away inside the window still shows
  Edit. The save is refused and nothing is lost. `updateClimb` gives each
  refusal an `extensions.code` (`CLIMB_EDIT_NOT_ALLOWED`,
  `CLIMB_EDIT_WINDOW_EXPIRED`, `CLIMB_NOT_EDITABLE`, `CLIMB_EDIT_CONFLICT`) and
  the editor shows a translated line for each. The server's own sentence is
  never shown; a failure with no known code gets the generic line.
- **Two saves crossing.** `CLIMB_EDIT_CONFLICT` shows "Someone else just changed
  this climb. Reopen it to see the latest." There is no automatic retry, and the
  working copy stays on screen and in the autosave slot. Tapping Save again
  re-reads the climb and can succeed.
- **The setter stays the setter in the queue too.** The queue row the editor
  builds after a save takes `userId` and `setter_username` from the climb being
  edited (`resolveProvisionalSetter`), not from whoever saved. A row with no `userId`
  whose setter name is the saver's own keeps the saver's id, as before.

## Climb revisions

Unlimited edits mean a climb you sent last month may not be the climb that is
there today. So every edit to a published climb is kept, on every board, in
`board_climb_revisions` (`packages/db/src/schema/app/climb-revisions.ts`). On a
catalogue board the 24 hour window means a climb collects a handful of revisions
at most. On spray it can collect up to the cap.

### What a row is

A row is the climb **as it stood after an edit**: name, description, frames,
frame count and pace, angle, rules, and on spray the setter grade. It also
carries what the edit changed (`name`, `description`, `holds`, `grade`, `angle`,
`rules`), who made it, and when.

Rows are written lazily, by `updateClimb` only:

| Event | Rows written |
| --- | --- |
| A climb is saved or published | 0. The live `board_climbs` row is its only revision. |
| A draft is edited | 0. History starts when the climb is published. |
| A draft is published by `updateClimb` | 0, even when the same call also edits it. |
| A published climb is edited for the first time | 2. Revision 1 is the climb as it was published, dated to `published_at` and credited to the setter. Revision 2 is the new state. |
| A published climb is edited again | 1. |
| A save changes nothing | 0. |

So the highest-numbered row always matches the live climb, and a climb with no
rows has never been edited. There was no backfill: an edit made before this
shipped left no row.

"Changes nothing" is judged on what a climber would call different. A missing and
an empty description are the same. On the Aurora boards the `No match`
description prefix counts as a rule, not as description text.

### The cap

`MAX_REVISIONS_PER_CLIMB` is 50. Past it the oldest edit is deleted and revision
1 is always kept, so the original is always there to compare against. An edit is
never refused for being one too many. Revision numbers are never reused, so a
pruned climb's numbers have a gap after 1.

### Two editors at once

The setter and the wall owner can save at the same moment. Inside its
transaction `updateClimb` takes the wall lock, then locks the climb row
(`lockClimbForRevision`, `SELECT … FOR NO KEY UPDATE`) and reads it. The second
edit waits for the first to commit, and its "before" is the first edit's result.
Both sides of the diff are read under that lock, never taken from the row the
resolver loaded before the transaction. Two saves give two consecutive revision
numbers, and each row names only its own change.

The order is wall, then row. A reset holds the wall lock while it rewrites
`missing_hold_count` on the wall's climbs, so taking the row first would be a
deadlock.

The resolver makes its decisions (did the holds change, does the duplicate gate
run) from the row it loaded before the transaction. So the locked row is compared
with that row on `isDraft`, `frames`, `framesCount`, `angle`, `characteristics`
and, on the Aurora boards, `description`. If any differ, another edit landed in
between: the save is refused with "This climb changed while you were editing it"
(`extensions.code` `CLIMB_EDIT_CONFLICT`) and nothing is written. `name` and
`framesPace` are not compared, because they feed no decision.

The decisions are not recomputed under the lock. The duplicate-gate lock is keyed
on the hold signature and is taken before the wall lock, so recomputing would
mean taking it while holding the row, which reverses the lock order.

One case succeeds instead: a publish that arrives after the same publish already
landed (a double tap). When every field the request carries equals the locked
row, `updateClimb` returns the published climb and writes nothing: no revision,
no second `climb.created`.

### Which wall photo a revision belongs to

A spray revision stores the wall version it was drawn on, so an old revision can
be shown on the photograph it was set against.

- A revision written by an edit takes the wall's current version, read under the
  wall lock.
- Revision 1 is written later than the state it describes, possibly several
  resets later, so its version is worked out: of the versions in which every one
  of the climb's holds was on the wall, the newest one published at or before
  the climb's `published_at`. If none is that old, the oldest version that had
  all the holds. If no version ever had them all, the column is NULL and the app
  shows the revision without a board.

The foreign key to `spray_wall_versions` is `RESTRICT`. Only a draft version is
ever deleted and a revision only points at a version that was published, so the
restriction should never fire.

### Reading them

`climbRevisions(boardType, climbUuid)` returns the rows newest first, with
`isCurrent` on the top row, the editor's name and avatar, `editedBySetter`, and
`sprayWallVersionNumber` to pass to `sprayWallRenderData`. No pagination: the cap
is 50.

It answers an empty list, never an error, for a climb nobody has edited, for a
draft, and for a spray climb on a wall the caller cannot see
(`sprayClimbUuidIsReadable`, the same gate as `betaLinks`). Someone holding only
a share link to an unlisted wall gets the empty list in v1. The visibility sweep
(`spray-visibility-sweep.test.ts`) edits its sentinel climb once so that this
field is proven to show the owner the history and a stranger nothing.

Revisions are read-only. There is no restore, and an old revision cannot be
queued or lit up.

### Which revision a tick was logged on

A send on revision 2 of a climb is not a send of revision 5 if the holds moved
in between. So every tick records the revision it was logged against (#6023),
in `boardsesh_ticks.climb_revision`:

| Value | Meaning |
| --- | --- |
| 1 | The climb had never been edited, or the tick was on it as first published. |
| 2 and up | That revision, the same number `climbRevisions` returns. |
| NULL | Not known. Every imported tick (Aurora, Kilter, JSON, MoonBoard) and every tick older than the column. |

The number is set once, when `saveTick` inserts the row. `updateTick` never
changes it, not even when the edit moves `climbedAt`. A replayed `saveTick`
returns the row as first stored. There is no foreign key to
`board_climb_revisions`: a climb nobody has edited has no rows there, and rows
past the cap are pruned, so a tick can name a revision whose row is gone.

To make that one cheap read, `board_climbs` carries two numbers of its own.
`recordClimbRevision` writes both in the same transaction as the revision row.

| Column | What it is |
| --- | --- |
| `revision_number` | The climb's current revision. 1 until its first recorded edit, then the newest revision's number. Pruning does not change it. |
| `holds_revision_number` | The revision at which the holds last changed: the frames, or the number of frames. A rename, new notes, a regrade, a rule change, an angle change or a pace change all leave it alone. |

Both are `NOT NULL DEFAULT 1`. A tick whose `climb_revision` is at or above the
climb's `holds_revision_number` was climbed on the holds the climb has now.
`updateClimb` answers with both numbers as the save left them, so the app that
made the edit knows the new revision without fetching the climb again.

Climbs edited before the columns existed were filled in once, by migration
0252, from their revision rows. For those climbs the holds number is a best
reading of the `changes` lists: a pace-only edit is listed there as `holds`, so
it can sit one edit too high, and a pruned revision cannot be counted at all.

`saveTick` takes an optional `climbRevision`: the revision the client was
showing when the climber logged it. The client is the better witness. A send
logged offline on revision 3 and delivered after the setter saved revision 4 was
still climbed on 3. What the server stores (`resolveTickClimbRevision`):

| Case | Stored |
| --- | --- |
| The climb has no `board_climbs` row | NULL |
| The client sent a revision from 1 up to the current one | That revision, even if its row has been pruned |
| The client sent a revision above the current one | The fallback, and a warning in the log |
| The client sent nothing, or 0, or a negative number | The fallback |
| The uuid the client sent was an alias of another climb | The fallback. The client's number was counted on the retired row. |

The fallback is the revision that was live when the climb was climbed: 1 when
the climb is still on revision 1, otherwise the highest revision created at or
before `climbedAt`, or 1 when the tick is older than all of them. With pruned
revisions in between it answers the newest row that survives, which can be
lower than the true one.

No whole number the client sends gets a tick refused. A refused send is
dead-lettered by the offline drainer and lost, and a wrong revision number costs
much less than that. Something that is not a whole number at all (`2.5`, `"2"`)
is a malformed request and GraphQL rejects it before `saveTick` runs, the same as
it would for any other field.

If the database read behind the lookup fails, the save fails with it. The app's
outbox retries that kind of error and a retry of the same tick uuid is safe, so
the send arrives later with its revision, where storing it at once with NULL
would have left it without one for good.

Readers: `Tick.climbRevision`, and `climbRevision` with `climbCurrentRevision`
(the climb's `revision_number` now) on the rows of `climbLogs`,
`followingClimbAscents`, `userAscentsFeed` and `userGroupedAscentsFeed`.
`Climb.revisionNumber` and `Climb.holdsRevisionNumber` come back from search,
climb detail, favourites, playlists and the setter's climb lists. `syncTicks` and `syncClimbs` emit the three columns,
and the phone stores them from on-device schema v11, where all three are
nullable: a row pulled before v11 reads NULL, which means unknown and not 1.

#### What the app sends

The app calls a revision a **version**. That is the only word a climber sees.

One rule decides everything below. The server stores any in-range version the
app sends, as sent. So a wrong version is worse than a missing one: a missing
one gets the fallback, which is the version live at `climbedAt` and is right for
a tick logged now, while a wrong one files the send under a version the climber
was not on, and if the holds moved since, the send stops counting. The app sends
a version only when it can show the number belongs to the holds on screen. When
it cannot, it leaves the key out. It is never sent as null either: a backend
from before the field rejects the key.

Where the number comes from (`resolveTickClimbRevision`,
`packages/mobile/src/lib/tick-climb-revision.ts`), in order:

1. The climb on screen, when it carries `revisionNumber`. A climb only carries
   one that was read together with its frames: a row from the phone's own
   search or detail read, or a network row that passed the check in step 2.
2. The phone's own copy of the climb (`board_climbs.revision_number`), but only
   when that row's `frames` are the same string as the frames on screen
   (`localRevisionMatchingFrames`). `useLocalClimbRevision` reads the number
   and the frames in one primary-key statement, when the form opens for a climb
   with no number of its own, and again whenever `['climb']` is invalidated: a
   saved tick, a climb edit and a completed board pull all do that.
3. Nowhere. The tick is sent with no version.

The frames check is an exact string comparison. The server's `holdsMoved`
compares parsed hold sets, so two strings that list the same holds in another
order are equal there and different here. That only makes the app leave the
number out more often, which is the safe side, and the parser stays on the
server.

Cases the check exists for:

| The climb on screen | The phone's row | Sent |
| --- | --- | --- |
| A network answer after the setter moved a hold | The version before the move | Nothing |
| A queue item from before an edit | The version after it | Nothing |
| The editor's unsaved holds (Set Active) | The last save | Nothing |
| The editor's second save, when the phone's row was not refreshed | The first save | Nothing |
| Same holds as the phone's row | That row | Its version |
| Anything, on a board that is not downloaded | No row | Nothing |

The last-but-two row is why the create screen puts no version on the climb it
queues, although `updateClimb` could tell it one. A local "make this current"
for the uuid that is already current is a no-op in the queue reducer
(`packages/shared/queue/src/reducer.ts`), so after Edit, Save, move a hold, Save
again the queue still holds the first save's item. `REFRESH_AUTHORED_CLIMB`
then patches the second save's name, holds and draft state onto it, and no
version. A version stamped by the first save would be one behind the server,
the setter's send would be stored on it, and it would not count. With none, the
send names the phone's version once the phone's row has the second save's
holds. The `UpdateClimb` document does not select the two numbers, since
nothing reads them.

Offline, the version is written twice: into the local `boardsesh_ticks` row
(`climb_revision`) and into the queued `SaveTick` payload. If the backend that
finally receives the queued tick answers `Field "climbRevision" is not defined`,
the outbox handler sends it once more without the field (`handlers.ts`,
`DROPPABLE_INPUT_FIELDS`), so the send is delivered instead of dead-lettered.
The match is on that clause and not on the field name: graphql-js prints the
whole input in such messages, so the name alone appears in rejections that are
about something else.

#### Why the version comes from the phone and not from the query

`SearchClimbs`, `GetClimb`, `GetTicks` and the queue documents (`QueueUpdates`,
`JoinSession`, `GetSessionQueueState`) are pinned by the App Store screenshot
fixtures, which key a recording on the document text
(`docs/mobile-screenshot-fixtures.md`). They cannot select `revisionNumber` or
`climbRevision` until the fixtures are recorded again. Until then:

- A climb's numbers come from `syncClimbs` (the phone's `board_climbs` row). A
  network `SearchClimbs` page or `GetClimb` answer is filled in from it
  (`fillClimbRevisionNumbersLocal`, one read per page): `revisionNumber` under
  the frames check above, `holdsRevisionNumber` always. The holds number is only
  a threshold for "does this send still count", it only rises, and the phone's
  value is a past one, so it can be too low and never too high. Too low counts
  a send that should have been dropped; it cannot drop one that counts. The fill
  has 150 ms (`NETWORK_ENRICHMENT_BUDGET_MS`); a busy database hands the
  network answer over as it came. It is skipped where there is no offline
  engine (the browser app).
- A tick's version in the play drawer's own history comes from `syncTicks`: the
  shared logbook joins the phone's `boardsesh_ticks.climb_revision` onto the
  `GetTicks` rows by tick uuid (`BoardAdapter.readLocalTickRevisions`). See
  "A tick the phone has not pulled yet" below.
- A queue item keeps `revisionNumber` and `holdsRevisionNumber` on the phone
  that queued it, and does not send them. `ClimbInput.revisionNumber` is
  accepted by the server, but no queue document returns it, so a climb that has
  been through a shared queue arrives without it and the tick form uses step 2
  above. `queue-climb-field-contract.test.ts` still lists the field as
  server-ready for this reason.

Adding the fields to those documents, and removing the local joins, is the
follow-up once the fixtures are re-recorded.

#### A tick the phone has not pulled yet

The join gives each of the climber's own ticks one of three answers, and they
are kept apart all the way to the sent mark (`isTickOnCurrentHolds`):

| The phone's `boardsesh_ticks` | The tick's version reads as | Counts as sent on a climb whose holds moved |
| --- | --- | --- |
| A row with a version | That version | When it is at or above the holds version |
| A row the server delivered, with no version (an import, a tick older than the field) | 1 | No |
| No row, or this phone's own write still in the outbox with no version | Not known | Yes |

The third row is the second-phone case: `GetTicks` answers before the tick pull
has written the row. Counting the tick is what the app did before the field, and
it is right far more often than not, since most ticks are on the holds a climb
has now. When the pull lands it invalidates `['logbook']`, the batches on screen
are read again, and the logbook cache takes the version from the later read
(`mergeLogbookEntries` upgrades `climb_revision` on a row it already holds, and
never trades a known value for less). A batch that is not on screen is read
again the next time its climb is opened.

#### Where the app says "Earlier version"

A log shows the words **Earlier version** when its version is known and lower
than the version the climb is on now. Any edit counts, a rename included: the
tag says the climb has changed since, not that the send stopped counting. No
version numbers are shown. A log with no known version shows nothing.

| Surface | Source of the two versions |
| --- | --- |
| Play drawer, your own history (`LogbookEntryRow`) | The tick from the phone's copy; the climb's current version from the phone's `board_climbs` row. No frames check here: the tag compares against the version the climb is on now, whatever holds a queue item is showing. |
| Play drawer, other climbers' logs (`ClimberLogRow`) | `climbRevision` and `climbCurrentRevision` on `climbLogs` and `followingClimbAscents` |
| You tab, the flat logbook (`LogbookRow`) | The same two fields on `userAscentsFeed` |
| You tab, the grouped logbook | No tag. `GetUserGroupedAscentsFeed` is a pinned document. |
| Session detail and the session feed | No tag, for the same reason. |

The tag is plain text. Opening the version a log was made on needs the version
sheet from #5973, which ships with the release train; making the tag a button
is the follow-up.

#### The app's own "sent" marks

Two places work "sent" out on the phone, and both follow the holds epoch:

- Search on a downloaded board (`search-climbs-local.ts`): hide or show sent,
  hide or show attempted, rated by me, my minimum rating, and the per-row
  `userAscents` / `userAttempts`. The SQL is written once
  (`tickOnCurrentHoldsLocalSql`, `climb-revisions-local.ts`) and COALESCEs both
  sides to 1, because on the phone the climb's column is nullable too. The
  personal grade is not filtered, as on the server.
- The sent glyph on a list row (`useAscentStatus`), through
  `isTickOnCurrentHolds` in `@boardsesh/logbook`. The row passes the climb's
  `holdsRevisionNumber`; a row whose source does not carry it (a playlist, a
  queue row) counts every tick, as before. A tick whose version is not known
  counts too (see the table above).

The Flash or Send label on the tick form still counts any earlier log on the
climb as history, old holds included.

### What a moved hold resets

A climb's sends, stars and first ascent belong to its holds. When an edit moves
a hold they start over, on every board. The rule is one comparison, written once
in `packages/db/src/queries/climb-stats/holds-epoch.ts`: a tick counts when

```sql
COALESCE(tick.climb_revision, 1) >= board_climbs.holds_revision_number
```

A tick with no revision counts as revision 1. A tick whose climb has no
`board_climbs` row is compared with 1 too.

- For a tick older than the column that is exact: no climb had a revision
  before the column existed.
- For an imported tick (Aurora, Kilter, JSON, MoonBoard) it is a choice, and it
  can be wrong one way. If a setter moves a hold on a Boardsesh-owned catalogue
  climb and someone's send of the new holds arrives later by import, the import
  has no revision, reads as 1, and does not count as a send of the current
  holds. Their "sent" mark and the first ascent stay off until they log it in
  Boardsesh. This is accepted: an import never adds to the Boardsesh ascent
  count in any case, the window is the setter's 24 hours after publishing, and
  spray walls, where edits have no limit, have no imports.

| An edit that changes | Sends, stars, first ascent, sent marks |
| --- | --- |
| Which holds are lit, a hold's role, or the number of frames | Start over |
| Name, notes, grade, angle, rules, pace | Unchanged |
| Only the order the holds are listed in the frames string | Unchanged, and no revision is recorded |

"The holds" means the parsed set: each frame's holds with their roles
(`holdsMoved`, `climbs/climb-revisions.ts`). The app sends the frames string
again on every save, written in ascending hold-id order. A stored string from
another encoder lists the same holds in a different order, and comparing the
strings would turn a rename into a reset. In a multi-frame climb a hold that
moves from one frame to another is a change.

On a climb whose holds never moved the epoch is 1 and every tick counts, so
catalogue boards behave as they always did. A catalogue climb can only be edited
by its setter in the first 24 hours.

What reads the rule:

| Surface | After a hold moves |
| --- | --- |
| `board_climb_stats.ascensionist_count` and the Boardsesh count behind it | Zero until someone sends the new holds |
| `fa_username`, `fa_at` on a Boardsesh-owned climb | Empty until someone sends the new holds. Then that climber. |
| `quality_average` and the Boardsesh star votes | Only ratings from sends of the new holds |
| Search filters: hide or show sent, hide or show attempted, rated by me, my minimum rating | Read only ticks on the new holds |
| Recommendations ("find new climbs") | The climb is offered again |
| The Projects smart playlist and its card count | A project is a climb tried on its current holds and not sent on them. A send of the old holds does not make it a project, and neither does an old attempt. The list is still ordered by total attempts on every version. |
| ↳ how it reads the epoch | Not from each climb's row. It joins the logbook against `board_climbs_holds_moved_idx` (migration 0253), a partial index holding only the climbs whose `holds_revision_number` is above 1. A climb that is not in it is at epoch 1. `climbHoldsEverMovedSql` in `holds-epoch.ts` is the predicate a query must repeat to use it. `boardClimbRecentSenders` reads its one epoch the same way. |
| `boardClimbRecentSenders` (the wall's recent senders for a climb) | Only senders of the new holds |

What does not:

- **The grade.** On a spray wall the grade is the setter's and no tick changes
  it. On other boards a Boardsesh-owned climb's grade is the average of every
  graded send, old holds included. Filtering it would leave the climb ungraded
  after an edit until someone logged a graded send, and an ungraded climb drops
  out of grade-filtered search.
- **Anything that counts what a climber has done.** Profile totals and
  percentiles, leaderboards, gym insights, a board's send totals, session
  summaries, the Five stars and Most repeated playlists, feeds, and logbook
  lists. A send of an older version is still a send by that climber. The lists
  that show a tick (`climbLogs`, `followingClimbAscents`, the ascent feeds)
  return `climbRevision` and `climbCurrentRevision` so a client can label it.
- **The climber's personal grade** on a search row, which is their latest
  graded tick on any version.

`updateClimb` does the reset, in its own transaction, in three steps
(`climbs/holds-change-stats.ts`):

1. Before it writes anything, if the request changes the frames string or the
   frame count, it lists the angles of the climb that have a flash or a send
   and writes one row per angle to `climb_stats_recompute_pending`
   (`markStatsKeysForHoldsChange`).
2. Once `recordClimbRevision` has moved the holds epoch, it recomputes
   `board_climb_stats` for those angles (`recomputeStatsAfterHoldsChange`).
   The new holds and the zeroed numbers commit together.
3. After the commit the same keys go through the debounced recompute, which
   publishes `climbStatsUpdated`.

An angle nobody has sent is left alone: there is nothing to reset, and a
recompute there would write an empty tick average over a grade a setter seeded.

The pending rows from step 1 are not deleted by the edit. They do two things:

- **They serialise the edit with the batched recomputes.** The hourly
  self-heal, a sync's deferred flush and the pending drain all lock the same
  rows, in the same `(board_type, climb_uuid, angle)` order, before they read a
  tick. A batch touching one of these keys either finishes before the edit goes
  on, or waits for it to commit and reads the new epoch. Because the edit takes
  the pending rows before any stats row, as the batches do, the two cannot wait
  on each other.
- **They get the key recomputed once more.** The next self-heal pass drains
  them (rows older than 2 minutes, hourly). That corrects a writer that takes no
  pending row and read the old epoch: a `saveTick` recompute, or a sync that
  recomputes inside its own write transaction, landing its count after the edit
  committed. The debounced recompute from step 3 normally fixes that within two
  seconds, but it is an in-process timer and a deploy drops it.

A save that re-sends the same holds in another order also writes the pending
rows (step 1 runs before the diff is known). The drain then recomputes a key
that has not changed, which writes nothing.

The old ticks are not changed or deleted. They stay in every logbook with the
revision they were logged on.

Known limits:

- A stale count can last until the next self-heal pass, up to about an hour,
  when the two-second timer was lost. It can outlast that pass only if the
  stale write lands after the drain ran, which needs a statement that started
  before the edit committed and was still running when the drain got to it.
  Then the next tick on the climb corrects it.
- A deadlock is possible, and rare, between a holds edit of a climb sent at two
  or more angles and a sync that recomputes two of those angles inside its own
  write transaction, with no pending rows. Postgres ends it after a second by
  failing one side. If that is the edit, nothing is written and the climber
  sees the save fail; saving again works. A spray wall has one fixed angle, so
  in practice this needs a catalogue climb inside its 24 hour window.
- `board_climb_popularity` needs nothing. Its incremental refresh re-reads
  climbs whose stats row has a new `updated_at`, and the reset writes the row.
- Cached anonymous search pages keep the old ascent count for up to 24 hours,
  the same as after any send. Spray searches are never cached.

### In the app

The server half (table, `updateClimb`, the `climbRevisions` query) is on `main`.
The app half below ships with the release train (#5973 on `release/next`).

The play drawer shows an **Edit history** section (`RevisionsSection`) after
Community and before Similar climbs. It renders nothing unless the query has two
or more rows, so most climbs never show it. Loading, failed and offline also
render nothing. It is collapsed by default and its summary counts edits from the
newest revision number, so pruned edits still count.

Five rows show inline and "Show all" reveals the rest, up to
`MAX_REVISIONS_PER_CLIMB`. A full history carries a one-line note with that
number, read through `spray-cap-copy.ts`.

A row opens `ClimbRevisionSheet`: board, name, grade (spray only), notes, date,
editor, and Older / Newer. It is mounted inside `PlayDrawer` and opened by a
handler the drawer owns, because a root sheet presents behind the `/play` modal.
The file imports nothing from the queue, Bluetooth or the editor.

The board is drawn one of two ways (`pickRevisionBoardPath`):

| Revision | Drawn by |
| --- | --- |
| Any catalogue board | `BoardImageNative`, with the revision's frames |
| Spray, same wall version as the registered wall | `BoardImageNative` |
| Spray, a different wall version | `SprayRevisionBoard` |
| Spray, no wall version on record | Nothing. One line: "This wall photo is no longer available" |

`SprayRevisionBoard` fetches `sprayWallRenderData(uuid, version)` itself, under
its own query key, and **never writes the spray registry**. The registry holds
one version per wall and the play drawer under the sheet draws from it, so
registering an old version would swap the photo and holds under the live player.
It draws the photo with `expo-image` (memory cache only, the URL is a 15 minute
signature) and the holds as rings in one SVG layer.

With no connection the sheet and the old-version board show the offline placard,
never "photo no longer available".

### Known limits

- The old-photo preview draws plain rings, not the wall's stored look.
- No history for edits made before this shipped.
- The data export does not include revisions.
- Deleting a climb deletes its revisions (the foreign key cascades).
- A tick imported from another app has no revision (NULL), and neither does one
  logged before the column existed. Nothing backfills them.

## Setting a climb on a wall (the editor)

The create-climb editor is board-agnostic once `create-board-holds.ts` knows the
holds and `getBoardCapabilities` allows authoring, and SW-07 made both true for a
wall — so `isAuthorableBoard`
(`packages/mobile/app/(tabs)/climbs/create.tsx`) already accepts `spray` through
the capability, the brush bar already offers all four roles (`STATE_TO_PRIMARY_CODE.spray`),
and start/finish still cap at two each. What is left is five rules a wall answers
differently, and they live as pure functions in
`packages/mobile/src/components/create-climb/spray-climb-rules.ts`:

1. **A setter grade is required to publish, optional on a draft.**
   `SetterGradeRow.tsx` puts the tick sheets' single-select grade rail in the
   create form, over the board's own scale (`useGrades`, which falls back to the
   bundled taxonomy offline — a wall copies the Tension scale, so the ids line up
   with what `resolveDifficultyId` matches server-side). The pick rides
   `SaveClimbInput.userGrade` / `UpdateClimbInput.userGrade` as the grade NAME
   (`"6c/V5"`), the same string `board_difficulty_grades.boulder_name` stores.
   A missing grade does not disable Save (#5954). The rail is below the fold, so
   a dead button up top gave no hint where to look: the status line under Save
   reads "Pick your grade to publish", and tapping Save sends nothing, bumps
   `focusGradeSignal`, and `CreateDrawer` opens the sheet and scrolls just far
   enough to show the rail with its "Needed to publish" subtitle in the warning
   colour. The prompt clears when a grade is picked, when the draft switch goes
   on, and when a new climb starts. Save is still disabled while a start or a
   finish hold is missing (`publishBlocked`). Both publish hints give their line
   to the hold heatmap's legend while the heat is on (`yieldsToHeatmap`), since
   on a wall one of them is up for most of an ordinary session. `use-last-used-grade.ts` seeds a FRESH climb's picker
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
5. **Save publishes.** `defaultIsDraft` starts the "Save as draft" switch off on a
   wall and on everywhere else (#5954). A draft is left out of the Climbs list,
   and on a wall a handful of people share, a climb missing from the list read as
   a climb that was lost. It is only the switch's starting position: an edit
   session takes the row's own value, and a restored autosave slot takes the one
   it stored, so work in progress from before this change still restores as a
   draft.

A second save of the same climb (a draft published, a rename) refreshes every
copy already in the queue through the queue reducer's local-only
`REFRESH_AUTHORED_CLIMB`. `setCurrentClimb` cannot: its same-uuid branch keeps
the current item on purpose, and it never rewrites a slot already queued. Only
the authored fields move (name, holds, description, rules, pace, draft state);
the queued copy's grade and send counts stay. A party peer's own queue slot is
not rewritten; they get the new payload for the current climb from the
`CurrentClimbChanged` broadcast.

Because a draft is not in the Climbs list, every surface that does show one marks
it with `DraftChip` (`packages/mobile/src/components/DraftChip.tsx`): the climb
row (list, queue, actions-sheet preview), the play drawer header, and the bottom
bar's capsule and iOS accessory row.

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

**Offline cold starts hydrate the published registry.** The loader reads the
owner-stamped `spray_walls` mirror while connectivity is unavailable or a
recognized transport request fails. It requires a published generation, valid
homography and a durable photo. Native image decoding supplies the photo's pixel
size; reference dimensions describe the canonical frame and are not substituted.
Canonical holds are mapped back into photo pixels before registration.

The local cache identity is `local-<photo UUID>-<published number>`, separate
from the online database row ID namespace. Published numbers never repeat, so a
same-photo hold edit also changes geometry caches. Offline registrations expose
read-only permission and use the durable file directly, without downloading a
`file://` URL. Account changes withdraw them; owner and removal generations are
checked across every read and native image decode.

Reconnect forces server revalidation for every requested wall, including one
whose local photo was missing. A reconnect during image decoding is handled by
the completing load itself. An authoritative absent or inaccessible wall removes
the offline registration rather than reusing the local mirror. Draft editor data
never writes this mirror: sync emits only the wall's current published version.

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

### Sharing a climb from the app (#5488)

The app's Share button on a wall climb hands out the same URL this page lives at,
`/b/{slug}/{angle}/view/{name-slug}-{uuid}`, built by `buildSprayClimbSharePath`
(`packages/mobile/src/lib/spray/spray-share.ts`) with the climb segment www's
`constructBoardSlugViewUrl` emits. It used to share the numeric
`/spray/{layout}/{size}/1/{angle}/view/...` path, which www 404s by design. The
slug, the angle and the two visibility flags come off the registered wall
(`RegisteredSprayWall.share`, filled by the loader from `sprayWallRenderData`'s
`wall.board`), so the share costs no request.

| The wall is | What Share sends | Card warmed before the sheet opens |
| --- | --- | --- |
| public | the clean `/b/` link | the exact `og:image` URL this page advertises |
| unlisted | the `/b/` link plus `?wall=<uuid>` | none (`/og/climb` answers 404) |
| private, admin-hidden, not loaded, or no slug | the climb name alone, no link | none |

**An unlisted climb link opens in the app only, for now.** The app's
`/b/.../view/` route hands `?wall=` to `BoardRouteHandoff` (`wallUuid`), which
resolves the wall before adopting the board, so a crew member who is not the
owner still gets the wall's photo. On www the same link 404s for anyone but the
owner and the gym's members: this page resolves the wall through `boardBySlug`,
which refuses an unlisted wall to an anonymous caller (a slug is derived from
the wall's name, so it is a guess and not a capability), and nothing on the page
reads `?wall=` yet. Teaching www to redeem it is a follow-up PR.

The registered wall is re-read whenever its owner saves the edit screen
(`useUpdateSprayWall` calls `invalidateSprayWallRenderData`), so a visibility
change moves what Share sends straight away instead of after the registry's
10-minute revalidation. An admin-hidden wall (`SprayWall.hiddenAt`, only set for
the owner) registers with no share fields at all, because hidden means exactly
what private means. The wall-level share row (`sprayShareTarget`) reads a
`UserBoard`, which carries no `hiddenAt`, so it does not apply that rule yet.

### The card and the sitemap

`GET /og/climb?board_name=spray` composes the card from the public copy and the
lit holds, for public walls only — see `docs/og-climb.md`. An unlisted wall's
page emits no `og:image` at all rather than pointing at a URL that answers 404.

Public walls' climbs are the only spray URLs in a sitemap, and the boards shard
stays catalogue-only because a wall has no `/list` page to submit. The rule, the
config source and the SQL belt behind it are in `docs/sitemap.md`.

### Immutable render caches and isolated drafts (#6038)

A discarded draft row can hand its `version_number` to the next draft. Mobile
photo filenames therefore use `<layout>-v<version-row-id>.jpg`; background keys,
render memos and overlay thumbnails carry that immutable row id too. Existing
number-based cache entries are bypassed, so an affected phone recovers without
manually clearing files. Presigned signature rotation leaves the identity unchanged.

Published reads verify the payload number matches `wall.currentVersion.number`
and use `wall.currentVersion.id`. Draft reads include the existing version
history selection and verify that the requested number still belongs to the
requested draft row id. A reused number resolving to a replacement row is
unavailable rather than drawn under the discarded row's identity.

Editors and reset comparison keep their mapped draft photo and holds locally.
Their background and touch targets use that local payload, while the published
registry, runtime geometry and climb thumbnails retain the published wall.
Only initial setup, before any published version exists, registers its draft
for the add-wall look carousel. Account and wall-removal generations also
withdraw local draft payloads; a delayed response cannot restore them.

### Hold maintenance and photo reset draft ownership

The hold editor adopts only initial setup or a draft reusing the exact published
photo and mapping. Opening it during a photo reset reports that the owner must
finish or discard the reset first. New photo sends a saved hold-edit draft back
to Edit holds, without offering detection or comparison.

Version history is fetched fresh on reentry and invalidated when a draft is
created, published, committed or discarded. An upload retry keeps the exact
uploaded photo id and corners; it never silently adopts another open draft.
If that other draft blocks creation, the owner explicitly resumes or discards
it. Discarding returns to the selected local photo so the next attempt is visible.
The backend protection in #6070 also refuses plain publishing of new-photo
reset drafts from older clients.

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
