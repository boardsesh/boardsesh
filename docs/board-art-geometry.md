# Board-art geometry: traced hold silhouettes (`@boardsesh/board-art-geometry`)

Every hold on every board, traced out of the board art — its alpha channel, or, where the
art is a photograph, the substance recovered by keying its white ground away — and shipped
as polygons a renderer can stroke, fill or clip a glow to. Plus how light the art is under
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
  no hold. **Consumers must fall back to a ring at the placement radius.** 16,836 of
  17,163 placements are traced (98.1%); the shortfall is 232 empty MoonBoard grid cells,
  51 Kilter Original 12x12 placements with no art of their own, 42 Woods bolts sitting on
  bare white sweep, and 2 Decoy frame-rail T-nuts whose own-layer art runs to the search
  box.
- A placement with **no outline** is absent from `silhouetteLightness`. There is no `-1`
  sentinel — the spike shipped one and a `?? target` read straight past it, painting 94
  of MoonBoard's 198 holds as if their art were black.
- A placement whose art **does not paint a bright LED** is absent from `ledBright`. Kilter
  draws a dark bolt hole, so its table is empty everywhere; that is the fact the renderer
  needs, not a gap.
- A board config with **no shard at all** returns `null` from `loadBoardArtGeometry`.
  Every config in the catalogue ships one today; see Photographic art below for the rule
  that decides whether a board can ship one.

### The shard key

`"<boardName>/<layoutId>-<sizeId>"`. **Set ids are not part of it**, and since the tracer
went per-image that is exact rather than merely adequate.

Each placement is traced against the one art layer that draws it, partitioned only over
the other placements on that same layer. Nothing about a placement's silhouette depends on
which *other* sets are mounted, so one shard is correct for every subset of its layout and
size — mount three sets or nineteen and the holds you get back are the ones this table
already holds. A per-subset table would be combinatorial (Decoy 2-1 mounts 19 layers) for
a difference that provably does not exist.

That was not true before. While the tracer cut on the composite, a hold's mask was clipped
against every neighbour on the board, so tracing a subset would have let a hold grow into
the space a missing neighbour would have occupied — the full mount was the conservative
choice rather than the right one.

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

3.1 MB of generated data across 51 shards, largest 120 KB (Tension Board 2 12x12 Wide,
690 holds) — well under `scripts/check-large-files.mjs`'s 2 MB per-file limit, so no
allowlist entry is needed.

## Regenerating

```bash
vp run generate:board-art-geometry                     # write the shards
vp run generate:board-art-geometry -- --check          # drift gate (CI)
vp run generate:board-art-geometry -- --board=kilter    # one board
vp run generate:board-art-geometry -- --config=8-25     # one layout-size
vp run generate:board-art-geometry -- --report=<dir>    # pictures + metrics, writes no shards
```

`--report` writes, per config, the composited board art with every silhouette stroked on
it (amber pulled back off a neighbour, red keeping under 0.8 of its own art, dashed grey
untraced) plus a per-hold metric table, and one `summary.txt` over the run. It touches no
generated file, so a before/after pair can be captured from a dirty tree without the drift
gate seeing it. Put the output somewhere gitignored — `.boardsesh/art-report/` is the
convention; the whole catalogue is about 54 MB of PNG.

~125 s for the whole catalogue on a laptop (Kilter 38 s, Tension 42 s, Decoy 20 s,
Grasshopper 14 s, MoonBoard 4 s, Soill 3 s, Woods 2 s, Touchstone 2 s). Output is deterministic — stable
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

Each art layer is decoded once and becomes a **trace field**: that layer's hold substance
(alpha ≥ 96), the placements that layer draws, the exact nearest-placement partition over
them, and the search-box width to trace at. `traceOutlines` reads a field and nothing else
— no alpha channel, no sharp, no file paths — so what counts as hold substance is a
decision about the art and lives with whoever decoded it. That seam is what lets a
photographic board hand the tracer a white-keyed mask in place of an alpha channel without
the geometry code changing at all; see Photographic art below.

Per placement, inside its field: flood-fill the layer's art under the placement centre,
bounded to a box 2.6 placement radii wide (3.5 on a photographic board); keep only the pixels whose **nearest placement
is this one**; drop the limbs joined to the body through a thin neck; pull the result back
off any boundary it shares with a same-layer neighbour's art; follow the outer border
(Moore); simplify (Douglas-Peucker, ε 1.6 board px). The fields' outlines are a disjoint
union — every placement id lives in at most one field, asserted, not assumed.

**Per image, not per composite.** The composite is what a climber sees and the wrong thing
to trace against. Two holds from different sets are bolted into different holes and their
art overlaps by 0.06% of opaque pixels catalogue-wide, but stack the layers into one bitmap
and they touch — and touching is what drives every cut below. On Kilter Homewall 12x12, 439
of 499 placements are art-adjacent to a differently-labelled hold on the composite and 64
are when each layer is measured alone; the other 375 were being chopped at a boundary that
existed only because two images had been flattened together. Every **colour** reading still
measures the composite, because what a mark has to be legible against is the stack.

Four rules, each bought by a defect:

1. **Nearest-placement partition.** Without it a flood fill walks through a contact patch
   into the neighbouring hold and the pair traces as one blob — one glow covering three
   holds on Kilter Homewall. It is an **exact** Euclidean distance transform
   (Felzenszwalb–Huttenlocher, separable, carrying the label along). The chamfer it
   replaces ran up to ~4% long on a diagonal, which mislabelled a strip a pixel or two wide
   either side of every diagonal midline; determinism comes from integer squared distances
   and exact integer cross-multiplication in the envelope, with ties resolved lower column,
   then lower row, then lower placement index.
2. **Thin-neck trim.** Where a small hold's bolt is closer to a strip of a neighbour's rim
   than the neighbour's own bolt is, that strip stays connected and gets traced. Kilter
   Homewall's STARTING 4628 came out as a numeral 6. The trim erodes to the pixels a
   neck-trim radius clear of the art's edge, keeps the core the seed sits on, and grows
   **that core alone** back — growing every core first re-bridges the neck.
3. **Contact pullback.** Where two same-layer holds' art genuinely touches, the partition
   cut runs through solid art, so the mark's brightest band lands on the neighbour.
   Everything within the clearance of a neighbour-owned art pixel is deleted and the bolt's
   component kept, then the neck trim runs again because the pullback makes necks of its
   own.
4. **Seed containment.** The seed disc is `max(4, min(0.15 × nearest-placement pitch,
   0.75r))`. The pitch term steps off a punched-out bolt hole; the `0.75r` cap is what
   keeps it on the hold when a layer is sparse — Kilter Homewall's two screw-on layers
   carry 13 and 14 placements across the whole board, so their pitch spans hundreds of
   pixels.

Both radii in 2 and 3 are `max(2, round(0.078 × r))`: a hold's neck is a fraction of the
hold, so the radius is a fraction of the placement radius. The rule this replaced scaled
with the board's **pixel width**, which is not the same thing — TB2's 12x12 Wide is 1461 px
across carrying the same 31.8 px placement radius as the 1080 px 12x12, so it trimmed at 4
where the narrower board trimmed at 3 and left the one outline that had to be pinned as a
known gate-5 failure. 0.078 is the coefficient that holds Kilter Homewall at 3 and both
MoonBoards at 2, so the boards the old rule was calibrated on do not move.

There is **no area backstop**. Before the partition an "area far above the board median"
rule was the only way to catch a merge; after it a merge is not expressible, and the rule
was deleting real holds — 14 of Grasshopper's genuinely large square ones.

## The gates

`packages/shared/board-art-geometry/src/__tests__/geometry-gates.test.ts`, over the
committed shards. Gates 1-5 run on all 51; gates 6 and 7 decode real board art, so they
run a nine-board sample by default — the seven the spike drew, plus both Woods sizes,
which are the only configs on the white-key path — and the whole catalogue under
`BOARD_ART_GATES=all`. The measurements deliberately **restate** the generator's constants
and its placement→image routing rather than importing them: a gate that shares its inputs
with the code it audits only checks that the code agrees with itself.

**One input is shared, deliberately.** The gates *import* `buildWhiteKeyMask` and
`mergeCoincidentPlacements` for the photographic boards. A mask is not a threshold to
re-derive, it is the substance itself: measure a silhouette's boundary against a mask cut
half a pixel differently to the one the tracer cut it from, and the gate reports the
difference between two flood fills rather than a defect in the geometry — noise on exactly
the board it is newest on. The independent anchor for that half sits in `white-key.test.ts`
instead, which pins the mask's ground and hold shares on the real art as golden four-decimal
numbers and cross-checks the merged-group counts against `COINCIDENT_PAIR_BUDGET` in
`@boardsesh/board-config`, derived from the hold table rather than from this package. A
change to the key that moves one pixel fails there before it can move a gate here.

| # | What it checks | Result |
|---|---|---|
| 1 | Every outline sits on its own placement | 0 on the 49 sprite-sheet shards; 12 Woods outlines are pinned by id, worst 4.24 board px outside on a 13.5 px radius. Separately, 3 Kilter Original 12x12 Wide screw-ons (drawn beside their bolt) and 50 Woods pieces have the bolt on the boundary, pinned as counts |
| 2 | No outline contains a placement **from another hold** | 0, no exceptions. Outlines covering their own coincident twin are a separate pinned per-id table (94 on Woods) |
| 3 | No outline traces the search box | 0 by box-edge share, 0 by crop-rectangle shape |
| 4 | Traced counts match `outline-counts.cjs` | exact |
| 5 | No outline loses > 20 board px² to an open at the trim radius | 1, pinned: `woods/1-2`'s 712 at 22 px² |
| 6 | No silhouette boundary sits on a **same-layer** neighbour's art | pinned per shard; worst sprite-sheet mean 0.6% and `opaqueMean` 10.4%, Woods 3.5% and 22.4% |
| 7 | Every silhouette keeps its own hold | pinned per shard; sprite-sheet recovery mean ≥ 0.911, Woods ≥ 0.877 |

Every gate carries a fixture that must trip it — a silhouette gate that has never failed
is indistinguishable from one that cannot fail. The fixtures were mutation-tested:
breaking the spur measure, the neighbour-ownership test and the search-box reach each
turn their fixture red.

**Gate 6 is measured per image, like the tracer.** A boundary where two *sets*' art abuts
is not a defect and is no longer counted as one: those holds are bolted into different
holes, they do not overlap, and the edge the tracer stops at there IS the hold's true art
edge. Its `opaqueMean` half is a **ratchet** and the chop metric — boundary with art on the
far side of it is boundary put inside the hold rather than at its edge, so it falls only
when the tracer stops cutting holds it had no reason to cut.

**Gate 7 is the one that catches a hold losing half of itself.** `recovery` is the shipped
polygon's area over every art pixel in the search box the exact partition gives that
placement on its own layer. Nothing else here sees that defect: gate 3 clears a chopped
silhouette, gate 5's open clears it, and gate 6 positively likes it, because a boundary
well inside the hold's own art is what a pullback is supposed to produce. Recovery above 1
is not a defect — the tracer fills holes before taking the outer border, so a hold with a
punched-out bolt hole ships a polygon covering art the partition never counted.

**Woods' pins are not comparable to the other boards'**, and the test comments say so.
Every other board's art is a sprite sheet drawn with gutters between the holds; Woods' is a
photograph of a real wall, where holds touch, and its hold table is CV-detected, so a wide
hold routinely carries two or three centres that the partition then splits it between. Half
its silhouettes pull back off a neighbour against 12% on TB2's densest size, and its 89 and
193 "chopped" outlines are mostly slivers of a multi-detected hold — which is the right
drawing, since lighting the middle bolt should light the middle of the rail. Each number is
pinned against its own shard's history, exactly like every other shard's; comparing them
across boards measures the boards rather than the tracer.

Two pins are known exceptions rather than clean zeros, recorded in the tests with their
measurements: **gate 1's three** — Kilter Original 12x12 Wide screw-on holds whose art is
drawn beside the bolt hole rather than over it, the worst putting the bolt 1.0 board px
outside a polygon simplified at a 1.6 board px tolerance, inside the simplification's own
error (it was five while the tracer cut on the composite; two of those were the cut rather
than the art) — and **gate 1's twelve Woods outlines**, 0.9% of that board's silhouettes,
all of them pieces of a hold the detector put more than one centre on.

Gate 6's `overFivePercent` moved **up** on nine shards, and the nine are exactly those
whose cut clearance dropped from 3 board px to 2 when the radius stopped scaling with board
width (`touchstone/1-1` 2 → 32, `grasshopper/1-4` and five TB2 configs 0 → 12–16). A
narrower clearance leaves the boundary closer to a same-set neighbour. It is a real trade
against the chop numbers — measured under this same per-image probe, `opaqueMean` fell on
41 of the 49 shards and holds keeping under 0.8 of their own art fell on 33 — and it is
pinned rather than smoothed over, because raising the clearance back is a one-coefficient
change and these are the numbers to weigh it against.

## Photographic art

Woods is the one board whose art is not a stack of transparent layers. It is an opaque
photograph of the hold set on a flat white sweep — the same fact
`scripts/generate-woods-dark-art.ts` records for the opposite reason — so its alpha channel
is 100% filled and there is no substance in it to read. It shipped no shard until the
tracer learned to recover that alpha.

**The rule is measured, not a board name.** `OPAQUE_ART_CEILING = 0.95` is asked twice,
with no second knob:

1. The composited art is measured. Under the ceiling, the alpha channel IS the hold
   substance and nothing changes. Woods is 100.0%; the next densest board in the
   catalogue, Touchstone, is 40.8%, so the first reading has a 2.3x margin and is a check
   on "is there an alpha channel to read".
2. A config over the ceiling has its white ground keyed out and is measured again. Under
   the ceiling now, it traces off the keyed mask. Still over, and the key found no ground
   — the corners were not board ground — so the config is skipped with the old message
   plus the keyed share that explains why. Woods clears it 3.5x over: 26.3% and 28.6%.

A board shot on a coloured sweep therefore falls back to rings honestly rather than tracing
its own noise.

### The white key

`@boardsesh/board-art-geometry/segmentation`, shared with the dark-art generator so the two
never drift. Flood the connected ground from the four corners over pixels at least
`GROUND_FLOOR = 235` on every channel, then erode the surviving region by one pixel.

**Connectivity is the point.** Pale holds carry near-white specular highlights, and a
global "near-white is ground" rule punches holes straight through them; nothing reachable
from a corner is a hold. The threshold is verified insensitive — sweeping it across 225-245
moves the filled fraction by at most 2.1 points — so the flood is doing the work, not the
number. The erode drops the antialiased rim that blends into the sweep, which would
otherwise ship as a one-pixel white collar traced into every silhouette.

| Config | Ground | Hold | Placements | Traced |
|---|---|---|---|---|
| `woods/1-1` (8x10) | 68.04% | 26.32% | 485 | 469 |
| `woods/1-2` (12x12) | 66.24% | 28.58% | 894 | 868 |

The mask is keyed from the **lossless `.png`** sibling of the shipped art and never
resampled: keying the `.webp` leaves its compression ringing behind as speckle (the two
disagree on 0.30% of pixels), and a photographic board's art is authored at board size, so
a dimension mismatch stops the run rather than being interpolated away. Every **colour**
reading still measures the shipped composite, because that is what a climber sees.

### Two things a photographed board needs that a sprite sheet does not

**Coincident placements merge.** Woods' hold table is CV-detected, and it emits pairs of
centres 0-2 board px apart for one physical hold — `COINCIDENT_PAIR_BUDGET` in
`@boardsesh/board-config` pins 24 such pairs on the 8x10 and 17 on the 12x12 as an upper
bound. Seed the partition with both and it cuts that one hold in half down the midline;
where the pair rounds to the same board pixel, the second gets no seed at all and silently
falls back to a ring. `mergeCoincidentPlacements` unions them (rounded centres, ≤ 2 px,
lowest id canonical — 31 groups on the 8x10, 18 on the 12x12, a superset of the budget's
pairs), the group traces once, and its outline is emitted under every member id,
re-anchored to each member's own centre.

**The search box goes to 3.5 placement radii** (`PHOTO_SEARCH_RADII`), per field rather
than for everybody. Swept on the shipped geometry: at 2.6 the box is traced into four
silhouettes and gate 3 throws all four away; from 3.0 up none are clipped. The 49
sprite-sheet shards keep 2.6 and are byte-identical.

### Colour, measured after the key

`applyRecoveredAlpha` puts the mask back on the composite before any colour reading, and
`wallLightness` is why it matters. That reading is the brightness a selector ring competes
with over the 0.85r..1.15r annulus, which on a photographed board is mostly white sweep:
measured with the photograph's own alpha it reads 0.743 and 0.766 at 100% coverage, and
keyed it reads **0.530 and 0.540 at 93%**, with the ground excluded exactly the way every
other board's transparent gutter already is.

`ledBright` is the second reason to key before measuring, and on Woods it is a guard rather
than a fix: a placement on bare sweep reads a linear luma of 1.0 at its centre, but its
surround disc sits on the same sweep, so the ratio stays near 1 and neither size flags a
painted LED either way. That is a fact about this board's ground rather than about
photographic art.

### Downstream

A config with no shard is `loadBoardArtGeometry(...) === null` and
`getWallLightness(...) === null`: draw rings at the placement radius, and no veil. No
config in the catalogue is in that state today. The 42 Woods placements with no outline —
bolts sitting on bare sweep — fall back to a ring individually, which is the same contract
MoonBoard's 232 empty grid cells already use.

## Per-board coverage

| Board | Configs | Traced / placements |
|---|---|---|
| decoy | 3 | 1,033 / 1,035 (99.8%) |
| grasshopper | 5 | 1,432 / 1,432 (100%) |
| kilter | 16 | 5,330 / 5,381 (99.1%) |
| moonboard | 7 | 1,022 / 1,254 (81.5%) |
| soill | 2 | 560 / 560 (100%) |
| tension | 15 | 5,474 / 5,474 (100%) |
| touchstone | 1 | 648 / 648 (100%) |
| woods | 2 | 1,337 / 1,379 (97.0%) |
| **total** | **51** | **16,836 / 17,163 (98.1%)** |

Per-config figures live in `src/generated/outline-counts.cjs`, written by the run that
produced the shards, so the record cannot drift from the tables.

Two placements changed traced state when the tracer went per-image: `decoy/2-1`'s 935 and
950, whose art on their own layer runs to the search box, so the box backstop drops them to
a ring. Nothing else in the catalogue moved.
