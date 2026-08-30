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
  ledInner?: Record<number, number[]>;
};
```

**Frozen.** A Rust renderer reads these field names. A field cannot change meaning,
change units, or grow a sentinel without that renderer changing with it; anything
genuinely new goes in a new field.

`ledInner` is that path taken once: a **new optional field**, so a renderer that has never
heard of it reads exactly what it read before. It holds the INNER boundary of the hold's
LED base plate — the lit region is the silhouette MINUS that polygon, the ring of plate
visible around the hold proper. Same flat, implicitly-closed, 4-decimal radius-unit form as
`outlines`. Nothing extracts it from the art yet: every entry is hand-annotated (see
Hand-corrected outlines below), so a shard carries the table only once somebody has drawn
one, and most shards do not carry it at all. An absent table and an absent placement mean
the same thing to a consumer — light the whole silhouette.

The renderer injection boundary is `HoldGeometryInput` in
`packages/shared/board-render/src/render-config.ts`. A caller passes a loaded
`BoardArtGeometry` as `holdGeometry`; `buildRenderConfig` copies these tables onto the
per-hold WASM config consumed by the Rust renderer.

### What the renderer draws from `ledInner`

The field reaches the Rust renderer as the per-hold `led_inner`, and only ever alongside
the `outline` it was traced inside — a ring with no outer edge describes no plate. Where
both are present and the ring is usable, `packages/board-renderer/core/src/boardsesh/`:

- fills the plate ring (`outline` minus `led_inner`, even-odd) with the role colour at
  `led_base.opacity`, 0.92 by default — the LED lighting up;
- dims the role fill inside the ring by `led_base.interior_fill_scale`, so the hold's own
  shape still reads under the lit rim (`mark-style: glow`, the play view's default, draws
  no fill at all and leaves the body untouched);
- measures the outward glow's distance field from the plate ring rather than the whole
  silhouette (`led_base.glow_from_base`). A rim that reaches the silhouette edge all the
  way round gives the same nearest site to every pixel outside the hold, so the glow is
  byte-identical; it only differs where the plate does not reach the edge, and there the
  glow correctly fades. A plate too thin to own a single pixel falls back to the
  silhouette rather than losing its glow.

A ring that is malformed, non-finite, as large as the silhouette, or not inside its
bounding box is ignored — the hold lights whole, and a bad ring can never push the
silhouette onto the circle fallback. `led_base.opacity: 0` turns the whole treatment off.

Two consequences of adding it. `RenderConfig` grew a field, so
`core/tests/native_artifact_contract.rs` demands a 20-element marker and **every committed
native artifact must be rebuilt** (`scripts/build-native-renderer.sh`; the iOS half needs a
Mac) — a Rust change is invisible to the app until then. And `RENDERER_VERSION`
(`packages/mobile/src/hooks/renderer-version.ts`) had to move, because the overlay cache
key describes the settings a render was asked for and the plate is not a setting.

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
  no hold. **Consumers must fall back to a ring at the placement radius.** 15,499 of
  15,784 placements are traced (98.2%); the shortfall is 232 empty MoonBoard grid cells,
  51 Kilter Original 12x12 placements with no art of their own, and 2 Decoy frame-rail
  T-nuts whose own-layer art runs to the search box.
- A placement with **no outline** is absent from `silhouetteLightness`. There is no `-1`
  sentinel — the spike shipped one and a `?? target` read straight past it, painting 94
  of MoonBoard's 198 holds as if their art were black.
- A placement whose art **does not paint a bright LED** is absent from `ledBright`. Kilter
  draws a dark bolt hole, so its table is empty everywhere; that is the fact the renderer
  needs, not a gap.
- A board config with **no shard at all** returns `null` from `loadBoardArtGeometry`. See
  Skipped configs below.

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
the shard's own merge key plus a placement and a kind — `(board_name, layout_id, size_id,
placement_id, kind)` — with the same flat, implicitly-closed, 4-decimal ring in the same
radius units, so a consumer swaps one for the other with no conversion. Latest write wins;
`author_id`, `updated_at` and `note` are the record of who changed it and why, and there is
no history table.

`kind` says which boundary a row traces. `silhouette` is the hold's outer edge — what the
tracer produces and the renderer lights. `led_inner` is the INNER boundary of the same
hold's LED base plate, an annotation the tracer never produced at all: the lit ring region
is the silhouette MINUS that polygon, so a `led_inner` row stores no part of the outer edge
and only means anything alongside the silhouette it sits inside.

Editing runs over GraphQL: `holdOutlines(input:)` returns the deployed shard's outlines
beside the live overrides of every kind (side by side, not merged, so an editor can show
both and offer a revert), and `upsertHoldOutlineOverride` / `deleteHoldOutlineOverride`
write them — both defaulting to `SILHOUETTE`, and the delete scoped to one kind so dropping
an LED annotation leaves the corrected silhouette standing. All three operations are
admin-only and BOARD-SCOPED — a community admin scoped to Kilter corrects Kilter's art and
nothing else.

A write is checked three ways. The ring's shape goes through `isValidOutlineRing` itself
(the Zod schema `.refine`s on it, so the editor and the backend cannot disagree about what
is storable). The placement has to exist on the config with every set mounted — the
composite the shard was traced on; an unknown config comes back as
`HOLD_OUTLINE_UNKNOWN_CONFIG` rather than a raw error naming every size that does exist.
And the ring has to COVER its own placement centre: inside it, or outside by no more than
`CENTRE_TOLERANCE_RADII` (0.25). Not strict containment, because two shipped outlines
(kilter/1-28 placements 4800 and 4810 — hooks whose bolt sits under a concave underside)
miss their own centre by up to 0.03 radii, and a strict gate would make exactly those holds
un-correctable. It was five while the tracer cut on the composite; three of those were the
cut rather than the art and went away when the tracer moved per image. The failure the
tolerance exists to catch is a ring drawn around the NEIGHBOURING hold, ~2 radii away.

### From a row to a shard

A row in a database is not something the generator can read: CI's drift gate reruns it with
no database at all, and a contributor regenerating shards on a laptop has to produce the
same bytes as the run that shipped them. So the rows are **exported to committed JSON** and
merged from there.

```bash
vp run db:export-outline-overrides    # rows  -> packages/shared/board-art-geometry/overrides/
vp run generate:board-art-geometry    # files -> the shards       (FULL run, not --board/--config)
```

Then commit the overrides and the shards **together** — one without the other is what the
drift gate exists to catch. The PR then reads the way it should: the JSON diff is the exact
ring somebody drew, and the shard diff is that same ring landing in the generated table.

One file per config that has rows, `overrides/<board>/<layoutId>-<sizeId>.json`; a config
whose last row was deleted loses its file. `outlines` holds the `silhouette` rows,
`ledInner` the `led_inner` rows, both keyed by placement id. `meta` records who drew each
one, when and why — **for the reviewer only; the generator never reads it.** Placements are
sorted numerically and ring values are written verbatim (the backend already stores them at
4 decimals), so a re-export with unchanged rows produces no diff. The directory ships empty
and its `README.md` is the operator's copy of this loop.

The merge is `scripts/outline-overrides-merge.ts`, called from three points at the
generator's **emission boundary** and nowhere near the tracer:

1. **After tracing, before the lightness measurement.** The corrected ring is converted
   back into the tracer's own frame (`v · r − rounding`, the exact inverse of the emission
   maths) and replaces the traced one, so `silhouetteLightness` is measured inside the
   shape that ships rather than the shape a human already rejected. It can also ADD an
   outline to a placement the tracer never traced.
2. **At the radius-unit conversion.** An overridden placement's stored 4-decimal value goes
   into the shard **verbatim**, not round-tripped back through board pixels. The round trip
   is algebraically the identity and numerically is not, and byte-predictability is what
   lets `overrides.test.ts` prove the merge actually ran.
3. **Counts and the shard header.** Overridden placements count as traced, so gate 4's pin
   moves with the correction; the header gains `; N hand-corrected override(s) applied`
   when there are any. A shard with no overrides is byte-identical to before.

An override naming a placement its config no longer has **throws out of the generator**. It
is not skipped: a dropped correction is invisible — the shard passes every gate and quietly
ships the tracer's version of a hold somebody had already fixed.

`scripts/outline-overrides-merge.test.ts` carries the must-trip fixtures for every refusal
(stale placement, unstorable ring, ring drawn on the neighbour, unparseable file). They live
beside the loader rather than in the package because the package's tsconfig sets
`rootDir: ./src` and cannot import from `scripts/`.
`packages/shared/board-art-geometry/src/__tests__/overrides.test.ts` checks the other half:
every committed file parses, every ring validates, every placement exists, and every
overridden placement's shard value equals the committed ring byte for byte.

### What the gates do with a hand-drawn outline

Gates 1-3 still bind on it. They are geometric invariants any drawing has to satisfy — it
sits on its own placement, it swallows no second placement, it is not the crop rectangle —
and the backend already refuses a write that fails gate 1's core.

**Gate 1's pin table, gate 5 and gate 6 are exempt.** All three measure *tracer
pathologies*: a bolt left outside a boundary the simplification wobbled, a limb joined
through a thin neck, a boundary that is a partition cut rather than an art edge. A human
correcting exactly those defects trips them by construction — the commonest correction is a
contact cut, and repairing one means drawing the hold's real edge, which is on the
neighbour's art by definition. Gate 7 still binds: "did this polygon keep its own hold" is a
question a drawing has to answer too, and a correction ought to improve it.

`ledInner` rings are outside all seven — a base-plate boundary is not a silhouette and none
of those measures say anything about one. They get the same structural validation as a
silhouette (storable ring, drawn around its own placement) in `overrides.test.ts`.

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

Each art layer is decoded once and becomes a **trace field**: that layer's hold substance
(alpha ≥ 96), the placements that layer draws, and the exact nearest-placement partition
over them. `traceOutlines` reads a field and nothing else — no alpha channel, no sharp, no
file paths — so what counts as hold substance is a decision about the art and lives with
whoever decoded it.

Per placement, inside its field: flood-fill the layer's art under the placement centre,
bounded to a box 2.6 placement radii wide; keep only the pixels whose **nearest placement
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
committed shards. Gates 1-5 run on all 49; gates 6 and 7 decode real board art, so they
run the seven boards the spike drew by default and the whole catalogue under
`BOARD_ART_GATES=all`. The measurements deliberately **restate** the generator's constants
and its placement→image routing rather than importing them: a gate that shares its inputs
with the code it audits only checks that the code agrees with itself.

| # | What it checks | Result |
|---|---|---|
| 1 | Every outline sits on its own placement | 0 further than the 1.6 px simplification tolerance; 3 outlines (Kilter Original 12x12 Wide screw-ons, drawn beside their bolt) have the bolt 0.0-1.0 px outside and are pinned |
| 2 | No outline contains a second placement | 0 |
| 3 | No outline traces the search box | 0 by box-edge share, 0 by crop-rectangle shape |
| 4 | Traced counts match `outline-counts.cjs` | exact |
| 5 | No outline loses > 20 board px² to an open at the trim radius | 0, with no exceptions |
| 6 | No silhouette boundary sits on a **same-layer** neighbour's art | pinned per shard; worst mean 0.6%, worst `opaqueMean` 3.8% (was 20.8%) |
| 7 | Every silhouette keeps its own hold | pinned per shard; recovery mean ≥ 0.911, worst p10 0.843 |

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

One pin is a known exception rather than a clean zero, recorded in the test with its
measurement: **gate 1's three**, Kilter Original 12x12 Wide screw-on holds whose art is
drawn beside the bolt hole rather than over it. The worst puts the bolt 1.0 board px
outside a polygon simplified at a 1.6 board px tolerance — inside the simplification's own
error. It was five while the tracer cut on the composite; two of those were the cut rather
than the art.

Gate 6's `overFivePercent` moved **up** on nine shards, and the nine are exactly those
whose cut clearance dropped from 3 board px to 2 when the radius stopped scaling with board
width (`touchstone/1-1` 2 → 32, `grasshopper/1-4` and five TB2 configs 0 → 12–16). A
narrower clearance leaves the boundary closer to a same-set neighbour. It is a real trade
against the chop numbers — measured under this same per-image probe, `opaqueMean` fell on
41 of the 49 shards and holds keeping under 0.8 of their own art fell on 33 — and it is
pinned rather than smoothed over, because raising the clearance back is a one-coefficient
change and these are the numbers to weigh it against.

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
| decoy | 3 | 1,033 / 1,035 (99.8%) |
| grasshopper | 5 | 1,432 / 1,432 (100%) |
| kilter | 16 | 5,330 / 5,381 (99.1%) |
| moonboard | 7 | 1,022 / 1,254 (81.5%) |
| soill | 2 | 560 / 560 (100%) |
| tension | 15 | 5,474 / 5,474 (100%) |
| touchstone | 1 | 648 / 648 (100%) |
| **total** | **49** | **15,499 / 15,784 (98.2%)** |

Per-config figures live in `src/generated/outline-counts.cjs`, written by the run that
produced the shards, so the record cannot drift from the tables.

Two placements changed traced state when the tracer went per-image: `decoy/2-1`'s 935 and
950, whose art on their own layer runs to the search box, so the box backstop drops them to
a ring. Nothing else in the catalogue moved.
