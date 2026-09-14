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
