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
`outlines`. Two sources fill it: the automatic extractor (see The LED base-plate extractor
below), which qualifies the ten Kilter Homewall configs whose art carries a two-tone plate,
and hand-drawn `led_inner` annotations, which replace an extraction wherever one exists.
The other 39 shards carry no table at all. An absent table and an absent placement mean the
same thing to a consumer — light the whole silhouette.

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
  glow correctly fades. That byte-identity assumes a **simple** outer ring — one that does
  not cross itself. The silhouette is filled non-zero and the plate even-odd, and the two
  rules only agree on a simple polygon; a self-intersecting outline would light and glow
  differently under each. The tracer does not emit one, and a hand-drawn override should
  not either.

A ring is rejected — the hold lights whole, exactly as before the field existed, and the
silhouette is never pushed onto the circle fallback — when it is malformed or non-finite,
when its box escapes the silhouette's, when a vertex lies outside the silhouette itself,
or when the band it leaves is under a pixel wide at the size being rendered. The vertex
test is not redundant with the box test: a hook or C silhouette's *box* contains bare
wall, and an even-odd fill over two disjoint rings fills that hollow. The width test is
what keeps a hairline ring from dimming a hold body under a rim nothing can draw — all
three consumers read one verdict, so a hold is never dimmed for a plate that is not there.
On top of that the paint and the glow's sites are both clipped to the silhouette, so an
even-odd fill can never reach wall whatever the ring does *between* its vertices.

`led_base.opacity: 0` turns the whole treatment off — paint, interior dim and glow source
together. There is no TypeScript-side switch for any of this, deliberately: the `led_base`
defaults in the Rust core are the only tuning until a board has enough annotated plates
for a knob to be worth arguing about.

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
  no hold. **Consumers must fall back to a ring at the placement radius.** 16,834 of
  17,163 placements are traced (98.1%); the shortfall is 232 empty MoonBoard grid cells,
  51 Kilter Original 12x12 placements with no art of their own, 42 Woods bolts sitting on
  bare white sweep, 2 Woods slivers whose ring crossed itself, and 2 Decoy frame-rail
  T-nuts whose own-layer art runs to the search box.
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

### Tracer profiles: the crisp edge

The Boardsesh glow paints fully opaque colour immediately OUTSIDE the outline polygon and
nothing inside it, and sprite art ends in a 1-3 px anti-aliased alpha ramp that reads as a
black ring over the dark wall. The classic tracer put most of that ramp inside the polygon:
`ALPHA_FLOOR = 96` is the 37.6% alpha isoline (outside the 50% coverage point), the Moore
follower staircases by ±0.5 px, and two-sided Douglas-Peucker at ε=1.6 board px bulges
chords outward on concave arcs. The glow stopped a ramp short of the hold and the ramp
stayed black.

`TracerProfile` (in the generator) bundles the knobs that decide where the boundary sits,
and `CRISP_TRACER_PROFILES` activates a crisp profile per `<boardName>/<layoutId>` — every
sprite layout in the catalogue (kilter 1 and 8, tension 9/10/11, decoy 2, grasshopper 1,
soill 1, touchstone 1, and MoonBoard 1-7: its placements route through a synthetic grid,
but once a trace field exists the sprite pipeline is the same). Woods stays on the default
profile — a white-keyed photograph is a binary mask with no alpha isoline to snap to — and
its shards are byte-identical. The crisp profile:

- masks substance at the **50% isoline** (`alphaFloor: 128`) — the perceived edge of an
  anti-aliased shape;
- **snaps** each border vertex to the 128-crossing along the local normal, sub-pixel
  (`snapBorderToIsoline`), leaving vertices on partition-cut edges — where alpha is high on
  both sides — exactly where the cut put them;
- simplifies **one-sidedly** (`simplifyInwardOnly`): a chord may cut inward up to 0.75 px
  but outward only 0.25 px, so no chord bulges past the isoline. Runs a deterministic retry
  ladder (snapped one-sided → unsnapped one-sided → classic) so one pathological border
  degrades a rung at a time instead of falling to a ring;
- applies a constant **0.5 px inward inset** covering the outward allowance and the
  renderer's own ~1 px anti-aliased coverage band;
- emits float vertices (the classic path stays integer), still 4 decimals in radius units;
- applies the cut machinery **only where holds genuinely touch** (`contestedCutsOnly`, next
  section).

Any shard-data change that moves pixels must bump `RENDERER_VERSION`
(`packages/mobile/src/hooks/renderer-version.ts`) — the overlay cache key hashes settings,
not shard bytes. The crisp re-cut took it to 13 (12 was already spent by the Aura seam fix).

### Sprite-aware cuts: contested components only

The nearest-placement partition is a global Voronoi over bolt positions, and holds are not
Voronoi cells: a wide sprite's lobe routinely crosses the bisector towards a neighbouring
bolt it never touches. The classic path amputates that lobe along a dead-straight line — it
is labelled to the neighbour, whose own art it is not connected to, so NOBODY ships it —
and the pullback then carves a further clearance scallop. On Kilter Homewall 10x12 all 33
"pulled back" holds were this: not one genuine art contact on the whole board (placements
4244 and 4352 were the two a user pointed at in a lit render).

Under a crisp profile the tracer floods the seed over ALL art in the box first, labels
ignored. A component containing no other placement's centre is one hold's own sprite and
ships whole (holes filled); only components genuinely shared between placements go through
the partition clip, neck trim and pullback — which stay exactly as they were, there and on
every default-profile board.

### Canonical per-layout tracing

The same physical hold is drawn on up to four art files per layout (one per size family),
and tracing each independently ships up to four slightly different silhouettes for one
hold. For layouts in `CANONICAL_LAYOUTS` (the crisp-profile layouts) the generator traces
two canonical configs once per run — the highest-resolution config (on the homewall,
kilter/8-23 at 12.27 px/unit) and the full-coverage config (kilter/8-25, all 499
placements) — and projects those rings into every size shard. A single-config layout
(touchstone) has nothing to share and is a no-op.

Two measured facts shape the mechanism:

- **The families are globally misregistered.** The 10x10 art sits ~2.4 px below the 8x12
  render's frame, the 7x10 ~1.3-3.2 px off. `measureRegistrationOffsets`
  (`scripts/canonical-outlines.ts`) correlates ~40 alpha windows per image pair and bakes
  the median offset into the projected vertices per config, so one canonical SHAPE lands on
  each size's actual pixels. Same-image configs are forced to offset exactly (0, 0), which
  is what keeps the five LED-kit twin shards byte-identical on shared placements.
- **The families also jitter per hold.** The 7x10 render disagrees with the 8x12 beyond a
  rigid shift (per-window IQR up to 5.7 px — the run logs it per pair). A canonical ring
  shipped there would misplace the glow by the jitter, so every projection is compared
  against the config's own direct trace (`ringAgreement`, rasterised IoU) and accepted only
  at ≥ `CANONICAL_AGREEMENT_FLOOR` (0.9). Rejections fall to the next tier
  (8x12-canonical → 10x12-canonical → the config's own trace), and the shard header counts
  them: `; N outline(s) from the layout's canonical traces (M kept their own trace)`. On
  the 10x10 configs ~80% of placements unify; on the 7x10 most honestly keep their own
  pixel-true trace. The direct trace is never skipped — it is both the comparison baseline
  and the fallback.

The 8x12-before-10x12 tier order also guards a subtler hazard: a hold whose *touching*
neighbour exists only on the bigger board traces without that neighbour's pullback on the
smaller board's layer, and projecting that ring outward would overreach — the coverage
config mounts every neighbour, so its trace is the safe second opinion.

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

The package also exports the **light-spill neighbour contract**:
`SPILL_NEIGHBOUR_RADII` (5) and `isWithinSpillRange(litHold, unlitHold)` — how far, in
placement radii, an unlit hold can sit from a lit one and still catch the renderer's
`glow.spill_boost`. Every config builder that attaches unlit outlines (the mobile
native path and the shared/WASM path) must use this one predicate, because the JS
pre-filter and the Rust glow reach have to agree: a narrower bound would silently clip
the spill. The check is an axis-aligned box scaled by `max(lit.r, unlit.r)` — the
renderer's own distance field decides where light actually lands.

Shards are one `.cjs` file per config behind a generated index of literal `require`s, so
Metro and webpack resolve them statically and evaluate only the board being drawn. The
dual `require` / `createRequire` shim in `src/generated/shards.ts` is copied from
`@boardsesh/board-constants`' `hole-placements.ts`; it is the only shape that works in
Metro, webpack, bare Node ESM and vitest at once.

3.1 MB of generated data across 51 shards, largest 120 KB (Tension Board 2 12x12 Wide,
690 holds) — well under `scripts/check-large-files.mjs`'s 2 MB per-file limit, so no
allowlist entry is needed.

### Who reads it

- **The mobile app** — `packages/mobile/src/hooks/use-native-climb-render.ts` loads the
  shard for the board being drawn and attaches the lit holds' outlines to the native
  render config.
- **The server renderer** — `packages/backend/src/services/board-render.ts` does the same
  for `/render/board` and `GET /og/climb`, so a share card and an in-app render draw the
  same silhouettes. It reads `getWallLightness` too, for the veil.
- **The browser**, over `GET /render/geometry` on the backend
  (`packages/backend/src/handlers/board-geometry.ts`, same-origin alias
  `/api/internal/board-geometry`). www's WASM worker cannot import this package —
  the shard index is 51 literal `require`s, so webpack would put all 5.2 MB in the
  client bundle to draw one board. The endpoint hands over the single config
  instead: `{ outlines, ledInner, ledBright, silhouetteLightness, wallLightness }`,
  gzipped, immutably cached under the same `v=` the images carry. 43 KB gzipped at
  the worst (Kilter Original 12x12), fetched once per board config per session.
  A config with no shard answers `{}` with a 200, not a 404 — "no silhouettes" is
  a normal answer, and a 404 would make every caller special-case it.
- **The tracer's own gates** and the iPad outline editor (`hold_outline_overrides` below).

The renderer-facing half of the contract is `HoldGeometryInput` in
`packages/shared/board-render/src/render-config.ts`: outlines, LED plates, LED offsets and
silhouette lightness go in, per-hold `outline` / `led_inner` / `led` /
`silhouette_lightness` come out on the WASM config. It is a parameter and not an import,
so the browser can fetch the one config it needs rather than bundling all 51 shards.

### `@boardsesh/board-art-geometry/spill`, `/veil`, `/types`

Three more subpaths that reach nothing else, for the same reason `ring` exists: a config
builder needs `isWithinSpillRange` or `veilOpacityFor`, not 3.0 MB of polygons.
`packages/shared/board-render/src/render-config.ts` imports through them precisely so it
stays safe to pull into a browser bundle.

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

**On canonical layouts a silhouette correction travels with its art.** Two configs of a
layout that mount the SAME image for a placement show byte-identical art there, so the
generator adopts the row verbatim on both (`adoptSameImageOverrides`) — draw once on the
10x12 Full Ride and the 10x12 Mainline ships it too, and the gate exemption travels with
the ring. Configs from a **different art family never adopt it**, deliberately: the
families are separate renders whose holds jitter against each other by up to ~3 px per
hold, and a projected human correction would inherit exactly the misplacement it was drawn
to fix. Two same-image configs carrying DIFFERENT rings for one placement fail the
generator outright — that is an editing mistake to resolve, not a precedence rule.
`led_inner` rows never travel; an annotation is calibration ground truth for the extractor
and stays where it was drawn.

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
Nothing pins that set of two: which placements miss their own centre is a property of
whichever tracer last wrote the shards, so `ring.test.ts` sweeps every committed shard and
asserts the invariant — every outline the tracer produced passes the gate — rather than a
list of ids that a regeneration would invalidate.

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

Gates 2, 3 and 7 still bind on it, and those are the invariants that matter for a drawing:
it swallows no second placement, it is not the crop rectangle, it keeps its own hold. A
correction ought to *improve* gate 7.

**Gates 5 and 6 are exempt** because they measure *tracer pathologies* — a limb joined
through a thin neck, a boundary that is a partition cut rather than an art edge. A human
correcting exactly those defects trips them by construction: the commonest correction is a
contact cut, and repairing one means drawing the hold's real edge, which is on the
neighbour's art by definition.

**Gate 1 is exempt for a sharper reason — the two centre rules disagree.** Gate 1 asks
whether the placement sits within `SIMPLIFY_EPSILON` of the polygon: 1.6 board px, which is
0.052 radii on kilter/1-28. The rule a correction is actually held to, by the backend on
write and by the merge on read, is `CENTRE_TOLERANCE_RADII` at **0.25 radii** — five times
looser. A perfectly legal correction whose bolt sits 0.1 radii outside the drawn edge would
pass the editor, the export and the merge and then red gate 1 with no remedy available: the
hold could neither be corrected nor left alone. The 0.25 rule binds instead on the committed
ring, in `overrides.test.ts`, which is where it can be satisfied.

`ledInner` rings are outside all seven — a base-plate boundary is not a silhouette and none
of those measures say anything about one. They get their own checks in `led-inner.test.ts`
(storable ring, drawn around its own placement, inside the silhouette it is subtracted
from, and a pinned count per config), whether they were extracted or drawn.

## The LED base-plate extractor

Kilter's Homewall art draws each hold as a neutral silver-grey body sitting on a beige LED
base plate, and the plate shows as a band hugging the hold's perimeter — thick along the
shaded bottom edge, thin along the lit top edge. That band is the part that actually glows,
so `scripts/led-ring-extract.ts` finds the hold-proper boundary inside each silhouette and
writes it to `ledInner`; the renderer lights the silhouette minus it.

The image reasoning is in
`packages/shared/board-art-geometry/src/segmentation/led-ring.ts` and is **pure** — no
sharp, no file paths, no board data — so the whole classifier is unit-tested against
synthetic two-tone art in `led-ring.test.ts` rather than against 499 real holds. The script
is the glue: it crops the composited board, runs the extractor once per shipping
silhouette, and applies the two acceptance layers the pure code cannot ask about. It is
tested the same way, against synthetic art, in `scripts/led-ring-extract.test.ts`.

The script reaches the package by **relative path**, not by the `@boardsesh/…` subpath, the
same way `scripts/outline-overrides-merge.ts` does: the repo's isolated linker leaves
workspace packages out of the root `node_modules`, so a bare specifier does not resolve for
a script run from the repo root. `segmentation/led-ring` is deliberately NOT a package
export — the only consumers are this script and the package's own tests, and leaving it
unexported keeps a 3 MB shard set's worth of neighbours out of anyone's bundle graph.

### The discriminator

**Normalised chromaticity, `(R − B) / (R + B)`.** Three classifiers were tried against a
hand-marked ground-truth hold first, and the two that failed are worth recording:

- **Luma** (2- and 3-class Otsu inside the silhouette) splits every hold strongly, and the
  split it finds is the hold's own shading gradient. The global luma histogram is broad and
  unimodal: there are no tone bands to find.
- **Raw warmth (`R − B ≥ 30`)** does find the plate, and thins or vanishes wherever the art
  is brightly lit or deeply shaded, because a difference of channels scales with
  illumination. A shaded stretch of beige plate reads colder than a lit stretch of grey
  hold, so no single cut separates them.
- **Normalised chromaticity is illumination-invariant** — scaling all three channels leaves
  it unchanged, so brown stays brown in shadow. The ring then closes around virtually every
  hold, lit tops included.

Quantiles over Kilter Homewall 12x12 hold pixels: p25 0.050, p50 0.073, p75 0.112,
p90 0.158.

### The pipeline

Per hold, inside the silhouette that ships (hand-corrected ones included, because a
corrected polygon is the one a renderer subtracts from):

1. `(R − B)/(R + B) ≥ WARM_CHROMA_THRESHOLD` (0.10).
2. `close(2)` — bridge the pinholes a hard threshold leaves in a nearly-uniform band.
3. `open(1)` — take back the fringe closing adds.
4. Drop warm components under `MIN_WARM_COMPONENT_PX` (30 board px²) — speckle in the body.
5. Gaussian blur at `BLUR_SIGMA` (2) and re-threshold at 0.5. **Not cosmetic:** a per-pixel
   class boundary reads as a hard, sharp line, which a real base plate does not have. This
   is the step that turns it into a curve.
6. Re-clip to the silhouette, then keep only the band components that **touch the silhouette
   boundary**. A plate is what the hold sits on, so it is visible around the edge by
   construction — and this is also what drops Kilter's bolt hole, which reads warm and is a
   dot in the middle of the hold.
7. Interior = silhouette minus that band; take the component around the bolt (the *largest*
   component where the bolt is not interior — see Limitations), fill its holes, and **trim
   its thin necks** at the tracer's own radius, `max(2, round(0.078 · r))`.
8. Trace the outer border with the tracer's own Moore follower, simplify with
   Douglas-Peucker at the same 1.6 board px, and **refuse anything that crosses itself**.

**Steps 7 and 8 are one fix and its proof, and both were added after measurement.** The
first version of the extractor did neither, and 176 of its 2,306 rings self-intersected —
against 0 of 15,499 silhouettes. The cause is that the tracer trims necks twice before it
takes a border and the interior mask was trimmed not at all: the blur's re-threshold leaves
the interior joined across a 1-pixel isthmus here and there, the border follower walks out
along one side of it and back along the other, and Douglas-Peucker then replaces that round
trip with two chords that cross. A bow tie renders as a hole in the wrong place and passes
every area, containment and centre test there is, which is why the simple-ring refusal
stays as a backstop even though the trim is the actual fix.

**The blur is exact integer arithmetic.** The separable kernel is built once as integer
weights at a scale of 65536 (the only floating-point step, immediately rounded), and both
passes accumulate integers that stay well inside the 2^53 a double holds exactly. The
threshold is the exact comparison `2 · blurred ≥ kernelSum²`, so there is no rounding
anywhere after the kernel and no tie-breaking rule to get wrong. The kernel is pinned in
`led-ring.test.ts`.

### Acceptance, per hold and per config

A hold is **omitted rather than guessed at** — an absent entry just means "light the whole
silhouette", which is what every renderer did before the field existed. It has to clear:

- some warm pixels at all, and a band that reaches the silhouette boundary;
- an interior that is not empty and whose component around the bolt carries at least
  `MIN_INTERIOR_DOMINANCE` (0.75) of it — a plate surrounds a hold, it does not bisect one;
- an interior between `MIN_INTERIOR_AREA_SHARE` and `MAX_INTERIOR_AREA_SHARE` (0.25..0.95)
  of the silhouette;
- an inner contour of at least 24 border points;
- on the radius-unit ring that would actually ship, `isValidOutlineRing` plus the same
  centre rule the backend enforces on a hand-drawn annotation (inside the ring, or outside
  by at most `CENTRE_TOLERANCE_RADII`);
- and containment: no vertex more than 0.9 board px outside the silhouette it is
  subtracted from (`escapes-the-silhouette`). The renderer refuses an escaping ring and
  lights the hold whole, so shipping one is shipping a row that will never draw; under a
  pixel is contour quantisation, not a defect, and rejecting at 0.5 px took a quarter of
  the homewall's real plates. `led-inner.test.ts` holds the shipped tables to 1 px.

A **config** emits a `ledInner` table only when at least `MIN_CONFIG_ACCEPTANCE` (60%) of
its traced holds produce a ring. That is a cliff-edge separator rather than a threshold
anything balances on: the ten Kilter Homewall configs run 73.2%–92.1%, and the highest
anywhere else in the catalogue is tension/9-3 at 22.3%. Nothing sits in the 50 points
between them.

| config | rings | accepted |
| --- | --- | --- |
| kilter/8-17 | 275 / 305 | 90.2% |
| kilter/8-18 | 148 / 165 | 89.7% |
| kilter/8-19 | 127 / 140 | 90.7% |
| kilter/8-21 | 353 / 391 | 90.3% |
| kilter/8-22 | 177 / 195 | 90.8% |
| kilter/8-23 | 339 / 389 | 87.1% |
| kilter/8-24 | 182 / 219 | 83.1% |
| kilter/8-25 | 389 / 499 | 78.0% |
| kilter/8-26 | 195 / 261 | 74.7% |
| kilter/8-29 | 176 / 196 | 89.8% |

2,361 rings over ten shards (re-measured inside the crisp silhouettes), and the other 39
shards are byte-identical to what they were before the extractor existed.

### Limitations

**`MIN_INTERIOR_DOMINANCE` is 0.75, not 1.0, so a dropped fragment can render lit.** The
emitted ring is the boundary of ONE component — the body around the bolt — and a hold whose
interior broke into a large piece plus a small one ships only the large piece. Up to a
quarter of the interior can be discarded that way, and whatever was discarded is inside the
silhouette and outside the inner ring, which is to say the renderer lights it. In practice
the effect is small and bounded: the centroid of the emitted ring sits a median 0.126 radii
from the placement centre and at most 0.605, and `MIN_INTERIOR_AREA_SHARE` refuses anything
that kept less than a quarter of the silhouette, so a hold cannot ship a fragment and pass.
Tightening the dominance would trade these for outright omissions; 0.75 is where that trade
was made, and an annotation is the remedy for any individual hold it gets wrong.

**Nothing here knows where the LED physically is.** The band is whatever the art paints
beige around the hold's edge, which on Homewall art is the base plate. A board that paints
a warm rim for a decorative reason would extract the same way, which is what the per-config
acceptance rate and the contact sheets are for.

### Annotations always win

An extraction is written into `ledInner` first and a committed `led_inner` override
replaces it afterwards, for the same placement. That ordering is the whole point rather
than an implementation detail: **the annotations are the ground truth this extractor is
calibrated against**, and a calibration target the thing being calibrated could overwrite
is not one. `led-inner.test.ts` binds the ordering on the shipped shards.

### Retuning

Every constant above is a calibration anchor, tuned by eye against one board's art and one
hand-marked hold — not a law. The loop to retune them:

1. Draw `led_inner` annotations in the editor on holds the extractor got wrong. Those rows
   export to `packages/shared/board-art-geometry/overrides/<board>/<layout>-<size>.json` and
   ship verbatim, so the fix lands whether or not the extractor ever improves.
2. Move a constant in `segmentation/led-ring.ts`, regenerate with
   `--report=<dir> --report-crop=300,400,360`, and compare the annotated holds against what
   the extractor now produces on them.
3. Re-pin `PINNED_LED_INNER_COUNTS` in `led-inner.test.ts` from the shipping run. The counts
   are pinned rather than bounded precisely so a threshold nudge cannot quietly drop forty
   rings — the shard diff has to say how many holds moved.

### The editor that writes them

The rows are drawn by hand in the Expo app, on two admin-only routes under the profile
stack: `app/(tabs)/profile/outline-editor.tsx` picks a board, layout and size, and
`outline-canvas.tsx` opens the board with every placement's outline drawn over it —
traced, overridden, missing, and a ghost of the shard outline still sitting under a
differing override. The entry point is More → Development → Hold Outlines, gated
`__DEV__ || isAdmin`; both routes re-check that themselves, because a deep link reaches
them directly. The implementation lives in `packages/mobile/src/components/outline-editor/`.

Drawing is Apple-Pencil-first. The stroke surface only claims a touch when the pointer is a
stylus — or when the finger-draw toggle is on — so a finger still pans and pinches the
zoomed board mid-edit. v1 is freehand redraw plus revert; there is no vertex dragging, on
the grounds that a whole silhouette is quicker to re-trace with a pencil than to nudge point
by point, and the tracer's decimation runs over the result either way.

Its coordinate chain is pure and tested (`outline-editor/stroke.ts`): invert the board's
zoom transform, scale render px to board px, decimate with `simplifyRing` at
`SIMPLIFY_EPSILON_BOARD_PX` **while still in board pixels**, and only then divide through by
the placement radius. Two details are parity, not preference, and will silently diverge if
either side changes alone: the ring is rounded BEFORE it is implicitly closed
(`closeRing(roundRing(...))`, the resolver's order — rounding can newly equate a head and
tail), and the centre gate is the same softened `pointInRing` OR `CENTRE_TOLERANCE_RADII`
test, so the editor never rejects a ring the backend would have taken.

A revert deletes the row immediately, but the deployed shard keeps its old traced outline
until the next export, so what a corrected hold renders as in the meantime is the shard's
version. The toolbar says so.

## Regenerating

```bash
vp run generate:board-art-geometry                     # write the shards
vp run generate:board-art-geometry -- --check          # drift gate (CI)
vp run generate:board-art-geometry -- --board=kilter    # one board
vp run generate:board-art-geometry -- --config=8-25     # one layout-size
vp run generate:board-art-geometry -- --report=<dir>    # pictures + metrics, writes no shards
vp run generate:board-art-geometry -- --report=<dir> --report-crop=300,400,360   # + one crop
```

`--report` writes, per config, the composited board art with every silhouette stroked on
it (amber pulled back off a neighbour, red keeping under 0.8 of its own art, dashed grey
untraced, cyan the extracted LED base plate's inner edge) plus a per-hold metric table, and
one `summary.txt` over the run that also carries the LED extractor's per-config acceptance.
`--report-crop=x,y,size` additionally writes `<key>-crop.png`, the same square of board art
twice — bare beside marked. A full-board sheet cannot answer whether a cyan line landed on
the right edge, because the plate is a few pixels wide on a 1080-pixel board. It touches no
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
than the art) — and **gate 1's eleven Woods outlines**, 0.8% of that board's silhouettes,
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
| `woods/1-1` (8x10) | 68.04% | 26.32% | 485 | 467 |
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

**A silhouette that crosses itself is rejected**, which is the backstop `segmentation/led-ring.ts`
already pairs with the neck trim for the LED plate's inner ring, applied one level up. A
1-pixel isthmus the trim did not take makes the border follower walk out along one side of
a limb and back along the other, and Douglas-Peucker then replaces that round trip with a
pair of crossing segments. Even-odd fill punches the overlap out, so the mark would show a
hole where the hold is solid. Every sprite-sheet outline is simple, so this costs them
nothing; it drops 2 of Woods' 1,337, both slivers of a multi-detected hold, back to a ring.

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
| woods | 2 | 1,335 / 1,379 (96.8%) |
| **total** | **51** | **16,834 / 17,163 (98.1%)** |

Per-config figures live in `src/generated/outline-counts.cjs`, written by the run that
produced the shards, so the record cannot drift from the tables.

Two placements changed traced state when the tracer went per-image: `decoy/2-1`'s 935 and
950, whose art on their own layer runs to the search box, so the box backstop drops them to
a ring. Nothing else in the catalogue moved.
