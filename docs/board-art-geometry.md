# Board-art geometry: traced hold silhouettes (`@boardsesh/board-art-geometry`)

Every hold on every board, traced out of the board art's alpha channel and shipped as
polygons a renderer can stroke, fill or clip a glow to. Plus how light the art is under
each hold and around it, and where the art already paints an LED.

Issue #2202. The tracer and its rules come from the rendering spike on
`spike/board-rendering-dark-2202`; this package is that work made shippable — the whole
catalogue instead of seven boards, a lazy loader, and the spike's six capture gates as
tests.

## Why it exists

The point of a halo is to show the **shape** of the hold, so a climber can find that
shape on the wall. Hold sizes on one board run from a fingernail-sized foot chip to a
jug three times its width, and a ring at the placement radius says nothing about either.
So the shapes are traced offline and shipped as data: nothing at runtime can decode the
composited board photo, and on Hermes nothing should try.

The same run answers two more questions the renderer cannot ask at draw time:

- **How bright is the art the mark sits on?** A mark's legibility is decided by what it
  crosses. The annulus reading per board drives the field-colour veil (`veilOpacityFor`);
  the inside-the-silhouette reading is what a fill has to normalise against.
- **Where has the painter already drawn an LED?** Grasshopper paints 234 of its 332 LED
  locations bright and the rest dark, so an unlit hold looks lit and a lit one looks
  dead unless the renderer takes the dot over — and to cover it, it needs the blob's real
  position, a median 2.2 board px off the placement.

## The contract

```ts
type BoardArtGeometry = {
  outlines: Record<number, number[]>;
  silhouetteLightness: Record<number, number>;
  ledBright: Record<number, [number, number]>;
};
```

**Frozen.** A Rust renderer reads these field names. A field cannot change meaning,
change units, or grow a sentinel without that renderer changing with it; anything
genuinely new goes in a new field.

The renderer injection boundary is `HoldGeometryInput` in
`packages/shared/board-render/src/render-config.ts`. A caller passes a loaded
`BoardArtGeometry` as `holdGeometry`; `buildRenderConfig` copies these tables onto the
per-hold WASM config consumed by the Rust renderer.

### Coordinates

`outlines[placementId]` is a flat `[x0, y0, x1, y1, …]` ring — closed implicitly, the
last point joins the first — in units of **that placement's own radius `r`**, relative to
its centre:

```
emitted_x = (boardPixelX - cx) / r      draw at:  cx + emitted_x * r
emitted_y = (boardPixelY - cy) / r                cy + emitted_y * r
```

Rounded to 4 decimals, which is 0.005 board px at the catalogue's smallest radius. Radius
units and not board pixels because the same shard is drawn at every surface size, and
because one board's pixels are not another's — MoonBoard authors its art in a 650 px box
against 1080 for most of the catalogue.

`ledBright[placementId]` is `[dx, dy]` in the same units, from the **placement centre** to
the bright blob's centroid. The board's own LED offset is folded in (on MoonBoard the LED
sits half a row below the hold, derived from the placement spacing rather than
hardcoded), so no second table is needed to place the dot. The MoonBoard fold is a guarantee for future art, not a path any shard uses: no shipped MoonBoard shard has a bright pixel there, so every MoonBoard `ledBright` table is empty.

`silhouetteLightness[placementId]` is the alpha-weighted mean OkLab lightness of the art
inside the traced polygon, 0..1.

### What is absent, and why that matters

- A placement with **no traceable art** is absent from `outlines`. That is not an edge
  case: MoonBoard's placements are a synthetic 11x18 grid and most cells genuinely carry
  no hold. **Consumers must fall back to a ring at the placement radius.** 15,501 of
  15,784 placements are traced (98.2%); the shortfall is 232 empty MoonBoard grid cells
  and 51 Kilter Original 12x12 placements with no art of their own.
- A placement with **no outline** is absent from `silhouetteLightness`. There is no `-1`
  sentinel — the spike shipped one and a `?? target` read straight past it, painting 94
  of MoonBoard's 198 holds as if their art were black.
- A placement whose art **does not paint a bright LED** is absent from `ledBright`. Kilter
  draws a dark bolt hole, so its table is empty everywhere; that is the fact the renderer
  needs, not a gap.
- A board config with **no shard at all** returns `null` from `loadBoardArtGeometry`. See
  Skipped configs below.

### The shard key

`"<boardName>/<layoutId>-<sizeId>"`. **Set ids are not part of it.** Each shard is traced
on the composite with every set of that layout and size mounted, because the
nearest-placement partition that separates two touching holds is only conservative when
all the neighbours are present: trace a subset and a hold whose neighbour is missing
grows into the space that neighbour would have occupied. A per-subset table would also be
combinatorial (Decoy 2-1 mounts 19 layers) for a difference no renderer draws — it only
ever asks for the silhouette of a placement it is already lighting.

### The eager table

`wallLightness["<boardName>/<layoutId>-<sizeId>"] = { mean, coverage }` — the mean OkLab
lightness of the art in the annulus a selector ring is drawn in (0.85r..1.15r), over the
placements that have a reading, and the share of placements that do.

Placements with no art in the band are **excluded from the mean, not averaged in as 0**.
Averaging them measures how empty a board is rather than how bright: it dragged both
MoonBoards to 0.30/0.34 and turned their veil off entirely.

## Using it

```ts
import { loadBoardArtGeometry, getWallLightness, veilOpacityFor } from '@boardsesh/board-art-geometry';

const geometry = loadBoardArtGeometry({ boardName, layoutId, sizeId }); // memoised, or null
const outline = geometry?.outlines[placementId]; // or fall back to a ring at r

const wall = getWallLightness({ boardName, layoutId, sizeId });
const veil = wall ? veilOpacityFor({ ...wall, fieldColor: '#181225' }) : 0;
```

Shards are one `.cjs` file per config behind a generated index of literal `require`s, so
Metro and webpack resolve them statically and evaluate only the board being drawn. The
dual `require` / `createRequire` shim in `src/generated/shards.ts` is copied from
`@boardsesh/board-constants`' `hole-placements.ts`; it is the only shape that works in
Metro, webpack, bare Node ESM and vitest at once.

3.0 MB of generated data across 49 shards, largest 120 KB (Tension Board 2 12x12 Wide,
690 holds) — well under `scripts/check-large-files.mjs`'s 2 MB per-file limit, so no
allowlist entry is needed.

### `@boardsesh/board-art-geometry/ring`

Ring maths — `simplifyRing` (the tracer's own Douglas-Peucker, plus `SIMPLIFY_EPSILON`),
`closeRing`, `roundRing`, `pointInRing`, `isValidOutlineRing` — lives on its own subpath
that imports nothing from `loader`, `types` or `generated`:

```ts
import { pointInRing, roundRing, isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
```

The isolation is the point. Metro bundles what a module can reach, so importing the
package index to run a point-in-polygon test would put all 3.0 MB of polygons into the
mobile bundle. The subpath is ~2 KB and reaches nothing else.

`simplifyRing` and `SIMPLIFY_EPSILON` are the tracer's own Douglas-Peucker, copied verbatim
so a ring an editor redraws is decimated by exactly the algorithm that produced the ring
beside it. `scripts/generate-board-art-geometry.ts` still holds its own copy and switches to
importing this one; until it does, a change to either has to be made to both.

## Hand-corrected outlines (`hold_outline_overrides`)

The tracer gets most holds right; the ones it does not are fixed as database rows rather
than by regenerating and redeploying 3.0 MB of shards. `hold_outline_overrides` is keyed by
the shard's own merge key plus a placement — `(board_name, layout_id, size_id, placement_id)`
— with the same flat, implicitly-closed, 4-decimal ring in the same radius units, so a
consumer swaps one for the other with no conversion. Latest write wins; `author_id`,
`updated_at` and `note` are the record of who changed it and why, and there is no history
table.

Editing runs over GraphQL: `holdOutlines(input:)` returns the deployed shard's outlines
beside the live overrides (side by side, not merged, so an editor can show both and offer a
revert), and `upsertHoldOutlineOverride` / `deleteHoldOutlineOverride` write them. All three
are admin-only and BOARD-SCOPED — a community admin scoped to Kilter corrects Kilter's art
and nothing else. A write is checked three ways: the ring's shape against
`isValidOutlineRing`'s bounds, the placement against every set of the config (the composite
the shard was traced on), and the ring against its own placement centre. That last rule is
marginally stricter than the tracer, whose output misses its own centre on 5 of 15,501
shipped outlines, so a correction for one of those has to be drawn to include the bolt.

## Regenerating

```bash
vp run generate:board-art-geometry                     # write the shards
vp run generate:board-art-geometry -- --check          # drift gate (CI)
vp run generate:board-art-geometry -- --board=kilter    # one board
vp run generate:board-art-geometry -- --config=8-25     # one layout-size
```

~110 s for the whole catalogue on a laptop (Kilter 41 s, Tension 37 s, Grasshopper 11 s,
Decoy 11 s, MoonBoard 4 s, Soill 3 s, Touchstone 2 s). Output is deterministic — stable
key order, fixed decimals — so `--check` is a byte comparison. A filtered run touches only
the matching shards and leaves `wall-lightness.cjs`, `outline-counts.cjs` and `shards.ts`
alone; a full run also deletes shards whose config has left the catalogue.

CI runs `--check` in its own `board-art-geometry` job, with no path gate, for the same
reason `board-render-version` has none: the generator derives its inputs from the whole
board catalogue plus every board photo the catalogue composites, so a paths filter would
drift from the real input set and silently stop guarding.

Re-run it whenever the board catalogue changes (a new layout, size or hold set) or any
board photo under `packages/web/public/images/` is re-exported.

## The tracer

Per placement: flood-fill the opaque art under the placement centre, bounded to a box
2.6 placement radii wide; keep only the pixels whose **nearest placement is this one**;
drop the limbs joined to the body through a thin neck; pull the result back off any
boundary it shares with a neighbour's art; follow the outer border (Moore); simplify
(Douglas-Peucker, ε 1.6 board px).

Three rules, each bought by a defect the spike's design review found:

1. **Nearest-placement partition.** Without it a flood fill walks through a contact patch
   into the neighbouring hold and the pair traces as one blob — one glow covering three
   holds on Kilter Homewall.
2. **Thin-neck trim.** Where a small hold's bolt is closer to a strip of a neighbour's rim
   than the neighbour's own bolt is, that strip stays connected and gets traced. Kilter
   Homewall's STARTING 4628 came out as a numeral 6. The trim erodes to the pixels a
   neck-trim radius clear of the art's edge, keeps the core the seed sits on, and grows
   **that core alone** back — growing every core first re-bridges the neck.
3. **Contact pullback.** Where two holds' art genuinely touches, the partition cut runs
   through solid art, so the mark's brightest band lands on the neighbour. Everything
   within 3 board px (at 1080) of a neighbour-owned art pixel is deleted and the bolt's
   component kept. Shoulder ink sitting on a neighbour goes 29,455 board px² to 25 across
   the spike's seven boards.

There is **no area backstop**. Before the partition an "area far above the board median"
rule was the only way to catch a merge; after it a merge is not expressible, and the rule
was deleting real holds — 14 of Grasshopper's genuinely large square ones.

## The gates

`packages/shared/board-art-geometry/src/__tests__/geometry-gates.test.ts`, over the
committed shards. Gates 1-5 run on all 49; gate 6 decodes real board art, so it runs the
seven boards the spike drew by default and the whole catalogue under `BOARD_ART_GATES=all`
(which costs about 3 s more).

| # | What it checks | Result |
|---|---|---|
| 1 | Every outline sits on its own placement | 0 further than the 1.6 px simplification tolerance; 5 outlines (Kilter Original 12x12 Wide screw-ons, drawn beside their bolt) have the bolt 0.0-1.0 px outside and are pinned |
| 2 | No outline contains a second placement | 0 |
| 3 | No outline traces the search box | 0 by box-edge share, 0 by crop-rectangle shape |
| 4 | Traced counts match `outline-counts.cjs` | exact |
| 5 | No outline loses > 20 board px² to a 3-px open | 1 pinned (`tension/11-10` #952 at 23 px²); every other shard's worst is ≤ 18 |
| 6 | No silhouette boundary sits on a neighbour's art | pinned per shard; worst mean 0.3%, worst `opaqueMean` 20.8% |

Every gate carries a fixture that must trip it — a silhouette gate that has never failed
is indistinguishable from one that cannot fail. The fixtures were mutation-tested:
breaking the spur measure, the neighbour-ownership test and the search-box reach each
turn their fixture red.

Two pins are known exceptions rather than clean zeroes, and both are recorded in the test
with their measurement:

- **Gate 1's five.** Kilter Original 12x12 Wide screw-on holds whose art is drawn beside
  the bolt hole rather than over it. The worst puts the bolt 1.0 board px outside a
  polygon simplified at a 1.6 board px tolerance — inside the simplification's own error.
- **Gate 5's one.** `radiusForBoard` scales the neck-trim radius with the board's **pixel
  width**, on the assumption that hold size scales with it. TB2's 12x12 Wide is 1461 px
  across with the same 31.8 px placement radius as the 1080 px 12x12, so it trims at 4
  where the narrower board trims at 3, and Douglas-Peucker leaves a 3-px-wide limb the
  wider disc would have taken. Fixing it means re-deriving that radius rule against
  placement radius rather than board width, which moves every board's output.

## Skipped configs

Two of the catalogue's 51 configs ship no shard:

| Config | Why |
|---|---|
| `woods/1-1` (8x10) | Art is **100.0% opaque** |
| `woods/1-2` (12x12) | Art is **100.0% opaque** |

Woods' art is an opaque photograph of the hold set on a white ground, not a stack of
transparent hold layers — the same fact `scripts/generate-dark-board-art.ts` records for
the opposite reason. The tracer reads the alpha channel and nothing else, so on Woods
every "silhouette" it returns is a cell of the nearest-placement partition rather than a
hold: a third of the placements hit the search box and every one that survived had pulled
back off a neighbour's art, which is what a board with no gutters looks like.

The skip is a **measured** guard (`OPAQUE_ART_CEILING = 0.95`), not a board name: Woods is
100.0% and the next densest board in the catalogue, Touchstone, is 40.8%, so it is a check
on "is there an alpha channel to read" with a 2.3x margin. It fires for any board that
ships photographic art in future.

Downstream, a skipped config is `loadBoardArtGeometry(...) === null` and
`getWallLightness(...) === null`: draw rings at the placement radius, and no veil.

## Per-board coverage

| Board | Configs | Traced / placements |
|---|---|---|
| decoy | 3 | 1,035 / 1,035 (100%) |
| grasshopper | 5 | 1,432 / 1,432 (100%) |
| kilter | 16 | 5,330 / 5,381 (99.1%) |
| moonboard | 7 | 1,022 / 1,254 (81.5%) |
| soill | 2 | 560 / 560 (100%) |
| tension | 15 | 5,474 / 5,474 (100%) |
| touchstone | 1 | 648 / 648 (100%) |
| **total** | **49** | **15,501 / 15,784 (98.2%)** |

Per-config figures live in `src/generated/outline-counts.cjs`, written by the run that
produced the shards, so the record cannot drift from the tables.
