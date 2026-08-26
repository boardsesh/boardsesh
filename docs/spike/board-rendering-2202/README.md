# Board rendering on a dark field — spike (issue #2202)

Everything proposed in [#2202](https://github.com/boardsesh/boardsesh/issues/2202) built as a
switchable dev screen, so the options can be compared on a real device instead of argued about
in the abstract. **This is a spike, not a shipping design** — see "What would have to change"
below before treating any of it as a plan.

**Regenerating the images: see [`HANDOVER.md`](./HANDOVER.md).** It has the emulator and Metro
sequence, the capture and figure scripts, the deep-link traps, and how to post to the issue.

## Running it

```
vp run dev:mobile                                       # or any Metro
adb shell am start -a android.intent.action.VIEW \
  -d "com.boardsesh.app:///board-spike" com.boardsesh.app.dev
```

Three slashes, not two: with `com.boardsesh.app://board-spike` the route name is parsed as the
URL _host_ and Expo Router never matches it (the same quirk `+native-intent.ts` works around for
`/preview`).

The screen has no navigation entry — it is reachable only by that link.

## What it renders

One climb on one board: Grasshopper "Master 8 x 12 with Tweeners" (layout 1, size 5, sets
1/2/3/4/6) — 332 hold placements, which is the density that makes the problem visible. The climb
is synthesised from real placements rather than pulled from the catalogue, so the screen needs no
network, no login and no seeded database.

Four independent axes, each a chip. The treatment list is `SPIKE_TREATMENTS` in
`spike-config.ts`; the arms below are the subset the captures use.

| Axis              | Options                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Overlay treatment | Baseline · Outward · Hybrid · Veil, plus the modifier chips the arms were chosen out of                                                    |
| LED layer         | on · off — on for every arm, baseline included, so it never varies between two panels                                                      |
| Role colours      | the board's own hues · Grasshopper's hues on every board · equal OkLab lightness · the four blue-HAND candidate hexes from the fourth pass |
| Play field        | dark `#181225` · neutral grey · near-black · plywood · white                                                                               |
| Role glyphs       | **off** · on — the opt-in accessibility mode, off in every default capture                                                                 |
| Render width      | full · 152 · 228 · 384 device px — the play view, then the surfaces that outnumber it                                                      |

`capture-boards.sh` pins **every** axis in the deep link, none inherited: the
screen keeps whatever it was last handed, so one stale chip press silently
rewrites a whole run and the caption in the shot does not say so. `FIELDS=`,
`PALETTES=`, `GLYPHS=` and `SIZES=` vary an axis; a non-default value lands in
its own subdirectory (`glyphs-on`, `size-152`, `field-grey__palette-equalL`) and
the default writes into the run root, so a run that varies one axis keeps its own
control beside it. `THUMBS=1` is the thumbnail sweep.

The board-art axis (an OkLab contrast stretch, Grasshopper only) is gone: it was
never one of the arms, never appeared in a capture, and it was the only reason
the board art was drawn through react-native-svg instead of `expo-image`.

## What the measurements said

- **The board art carries very little modelling.** Over the visible pixels of the whole 5-layer
  stack, OkLab lightness runs p10 = 0.312 to p90 = 0.516. Twenty points of lightness out of a
  hundred is not much for a hold's 3D shape to survive being composited onto a dark field.
  Stretching that band to 0.05–0.95 is a 4.4x expansion, and it is the single change that does
  most for "which hold is that, physically".
- **The role colours are nowhere near equal in lightness.** Grasshopper's shipped palette spans
  OkLab L 0.551 (HAND `#4455FF`) to 0.778 (STARTING `#00DD00`). The blue hand rings are 23 points
  of lightness below the green start rings, which is why hands are the first thing to disappear.
  Lifting every role to L 0.70 costs HAND 37% of its chroma and FOOT none.
- **A neutral outline on every placement has to be quiet.** Placements on this board sit exactly
  one placement-radius apart, so a ring at the full radius draws a solid mesh. 0.58 radius at 20%
  white keeps each ring inside its own cell.
- **A circle is the wrong shape for a halo.** Hold sizes on this board range from a fingernail
  chip to a jug three times its width, and a fixed ring says nothing about either — which is most
  of what a halo is for. Every one of the 332 placements has a traceable silhouette in the art's
  alpha channel (12.3 points each after simplification), so the outline can just be the hold.
- **The art under a ring varies far more than the field does.** Sampled in the annulus each ring
  is actually drawn in, Grasshopper's mean OkLab L is 0.411 with a range of 0.000 (bare field) to
  0.847 (a pale hold). That spread is what a fixed casing colour cannot serve and
  `contrast-color()` is for.
- **Across boards the mean moves as much as the range does within one.** Mean OkLab L under the
  ring: MoonBoard 2016 0.301, MoonBoard Masters 2019 0.337, Grasshopper 0.411, Kilter Original
  0.511, Tension Original 0.563, Kilter Homewall 0.626, TB2 Mirror 0.713. A white neutral outline
  is invisible on the top half of that list, which is why the traced halo picks black or white per
  hold rather than being a fixed colour.
- **Three numbers came from review, not from measurement, and they mattered.** The traced halo
  first shipped at 2.2px and 0.2 opacity and read as "that's just the baseline" — a hairline at a
  fifth opacity, drawn at board resolution then scaled to a phone, is not a visible treatment; it
  is 4px at 0.55 (0.7 for the dark-on-pale case) now. The glow spread was 40px, which is most of
  the ~50px pitch between placements, so lit holds bled into each other; it is 21px now. And the
  outlines were splined with _uniform_ Catmull-Rom, which bulges wherever a long segment meets a
  short one — on a hold outline that bulge is a tint spilling past the edge of the hold it is
  supposed to trace. Centripetal parameterisation fixes it and cannot cusp or self-intersect.
- **`FeGaussianBlur` is broken in react-native-svg 15.15.5 on Android.** A stroke through it paints
  the filter region as a solid rectangle of the stroke colour. `FeColorMatrix` in the same version
  renders correctly on the same device, so the glow falloff is concentric strokes instead of one
  blurred stroke. Four bands read as visible rings; fifteen is the floor and the band count is
  raised per hold wherever the step between two of them would render wider than 1.5 device px.

## The design review, and the three bugs it found

`design-review.md` is the output of a fifteen-agent design pass over the device captures — seven
lenses, every finding adversarially verified against the images, then synthesised. It made three
structural claims about the tracer, all three of which held up when audited against the generated
data:

| Defect                                                     | Before                                                                     | After           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | --------------- |
| Outlines that ran into the search box and traced its edge  | 215/499 on Kilter Homewall, 33 on TB2, 31 on Masters, 21 on MoonBoard 2016 | 0 everywhere    |
| Lit holds whose silhouette came from a _neighbouring_ hold | 31/143 on Masters 2019, 19/159 on MoonBoard 2016                           | 0 everywhere    |
| Merged blobs spanning two or more holds                    | up to 36 per board                                                         | not expressible |

The fixes, in the tracer:

- **Nearest-placement partition.** A jump-flood-style two-pass chamfer from every placement centre
  labels each pixel with the placement it belongs to, and a hold's mask is `opaque ∧ label == self`.
  Touching holds split along the midline between their bolts. This is what makes merges structurally
  impossible rather than something to filter for afterwards.
- **Seed containment.** The seed is now taken from a disc of
  `max(4px, 0.15 × nearest-placement pitch)` around the placement centre. The old rule — nearest
  filled pixel anywhere in the search box — reached two-thirds of the way into a neighbour on
  MoonBoard, where the cell pitch (58.7px) is barely larger than the marker radius (38.8px), and
  that is exactly how a light ended up on the wrong hold.
- **A bigger search box.** 1.25 → 2.6 placement radii. At 1.25 the box was smaller than a Kilter
  Homewall mainline hold, so the trace hit the boundary and followed it. The partition is what makes
  a big box safe.
- **No area backstop.** A "reject anything above 2.2× the board median area" rule was the only
  defence against merges before the partition. Afterwards it fired on Grasshopper's genuinely large
  square holds — 14 real holds deleted to catch nothing. A board with a 6× spread of hold sizes has
  no safe global area threshold.

One more finding acted on: tracing shrinks every mark, because a silhouette is the real hold and the
baseline circle is usually bigger than it. A hold whose longest extent falls below `0.45 × placement
diameter` gets a **bigger** mark rather than a second one — its glow bands widen by the shortfall,
capped at 1.7x. The first pass drew the baseline ring on top of the silhouette instead, and that
reads as two marks disagreeing about where the hold is: a precise outline and a circle that is not
it. The boost fires on 7/16 lit holds on TB2 Mirror and 6/10 on MoonBoard 2016, and on 0/16 on
Kilter Homewall, whose holds are already 70% of the circle.

## Acting on the review: four arms

The arm set is **Baseline · Outward glow · Glow + tint · Veil + glow**. Traced outline was an arm for one round
and the second design pass dropped it: at glance zoom it is last on all seven boards, because its
stroke is wider than the hold on every board with small holds, so the arm whose premise is "the
mark is the shape of the hold" paints a featureless blob on 6 of 10 lit holds on MoonBoard 2016.
The silhouette itself stays — it is the glow's path, the hybrid's fill boundary and the glyph's
clip. The calls behind the four that remain:

- **Baseline is the control, not literally what ships.** It carries the LED layer like the other
  three, so the only thing that changes across a row is the mark on the lit holds. Left off one arm
  it was a second variable: Grasshopper paints 234 of its 332 LED locations bright, and those discs
  are the difference between a wall that looks lit and one that does not.
- **Outward glow leads.** The only treatment that beat baseline on every board compared, and the
  only one where the wall's own bright holds cannot be mistaken for lit ones — a halo is something
  photographic hold art cannot produce.
- **Veil + glow is outward glow with the wall quieted.** Every other arm is additive — the climb
  lights 16 placements of the 303 to 499 on a board, 10 of 198 on the MoonBoards, and the rest is
  left alone. This one washes that other 95-97% down in the play field colour with the lit
  silhouettes punched out of a single even-odd path, at a strength bucketed on the GAP between the
  wall and the field it is washed toward — both in OkLab lightness, the wall being the mean in the
  ring annulus over every placement that has art in it. On the default field `#181225` (L 0.200)
  that gap is TB2 Mirror 0.541, Tension Original 0.461, Masters 0.441, Kilter Homewall 0.426,
  MoonBoard 2016 0.373, Kilter Original 0.325, Grasshopper 0.216, giving 0.45 on the first four and
  0.30 on the rest. Two things the third pass fixed: the annulus table's 0 sentinel means "no art in
  the band", not "dark wall", and averaging it in read both MoonBoards as empty (0.301 / 0.337) and
  returned no veil at all — filtered they are 0.573 and 0.641, the two loudest walls left once the
  other five are quieted, and both now get 0.30. And the wash is toward the FIELD, so a board whose
  wall is not meaningfully darker than the field gets 0 rather than being brightened: on the plywood
  chip Grasshopper and Kilter Original return 0, and on white every board does.
- **Traced halos is not an arm.** Its lit mark is byte-identical to baseline, so as an arm it can
  only lose on lit visibility. It is the per-board modifier described above, and nothing else.
- **Plain whole-hold tint is out, replaced by Glow + tint.** Plain tint lost to baseline on three
  of six boards on small holds, and on Grasshopper a tinted hold read as the same class as the
  wall's own cyan art. The hybrid normalises the art under the hold toward a common lightness
  (translucent, so the hold's shading and bolt hole survive), fills at α0.55, puts a crisp
  inside-clipped silhouette edge on it, and keeps the outward glow for reach.
- **Role glyphs are an opt-in accessibility mode, off in the default render.** They REPLACE the
  per-role marker shapes the app ships (#3204); a climber gets one system or the other, never both.
  Hue is the channel that fails: under protanopia Grasshopper's HAND `#4455FF` and FOOT `#FF00FF`
  land 3.2 ΔE00 apart — one colour. The second channel is silhouette: START a horizontal bar, HAND a
  vertical bar, FINISH an X, FOOT a ring, all stroked at one line width and sized inside the
  existing footprint so the mark does not grow. FOOT was a dot until the second pass measured it
  at a tenth of a bar's ink and noticed it was the same graphic the art paints on every hold that
  carries an LED. `boards/colour-vision.webp` simulates the two CONTROLS — baseline and outward
  glow, glyphs off — under Viénot 1999 protanopia and deuteranopia; `boards/accessibility-glyphs.webp`
  is the mode itself, the same arm with the glyphs off and on.
  **Every capture taken before this pass had the glyph unconditionally on**, so those panels are of
  a state no default render produces.

Two implementation notes worth pinning down:

- The glyph is **not scaled by the hold it sits on**: one line width per board, 0.11 of the
  placement radius, with the bars running out to 1.6 radii and the silhouette clip deciding where
  they stop. A marker has to mean the same thing on a jug and on a foot chip. (This paragraph used
  to say the glyph was sized on the hold's shortest axis, which contradicted both the code and the
  vocabulary section below. A silhouette's shortest extent feeds the glow's shape cap and nothing
  else.)
- The every-hold outline is one **unconditional two-tone casing** (dark pass, lighter core) rather
  than the review's per-hold black-or-white choice. The classifier flipped polarity on visually
  identical neighbours whose measured lightness straddled the threshold, which reads as
  salt-and-pepper.

### Those white dots are LEDs, and the renderer now owns them

They are not bolt holes. Physically the LED sits centrally on Grasshopper, Tension and Woods;
MoonBoard puts it in the gap above or below the hold; Kilter lights the translucent hold base so
the rim glows. Measured over the composited art (`scripts/spike-led-dots.ts`):

| Board                    | Placements with an LED | Art paints the LED bright | Median centre-vs-hold brightness |
| ------------------------ | ---------------------- | ------------------------- | -------------------------------- |
| Grasshopper Master       | 332/332                | 234                       | **10.19×**                       |
| Tension Original         | 303/303                | 0                         | **0.29×** (drawn _dark_)         |
| TB2 Mirror               | 498/498                | 0                         | 1.15×                            |
| Kilter Homewall          | 499/499                | 0                         | 0.42× (bolt hole)                |
| Kilter Original          | 476/476                | 0                         | 0.64×                            |
| MoonBoard 2016 / Masters | 198/198 (derived)      | 0 / 0                     | 0.77× / 0.89×                    |

Grasshopper is the only board with a non-zero `brightInArt` — Kilter Original's 10 and the
MoonBoards' 23 / 13 were a pre-fix run, zeroed once the generator got an absolute-luma floor. Two
consequences worth carrying into the port: the unlit dark disc is drawn on Grasshopper and nowhere
else, since it only ever renders over a bright blob the art already paints; and the lit dot is drawn
only where `ledOffsetY === 0`, which is five boards of seven — on the two MoonBoards the LED sits a
half-row below the hold, where a role-coloured pip would read as a second, smaller mark.

So Grasshopper paints roughly two thirds of its LEDs bright and leaves the rest dark, and Tension
paints all of them darker than the hold. An unlit hold with a bright LED competes with a lit mark;
a lit hold with a dark LED does not look lit. The renderer now takes the LED over from the art:
**role colour where the hold is lit, dark where it is not**.

MoonBoard has no LED table in `@boardsesh/board-constants`, but it does not need one. Its holds and
LEDs are both on a regular grid with the LED grid offset down by half a row, so an LED sits halfway
between each vertically adjacent pair of holds — none above the top row, one below the bottom row,
and therefore one below every hold. The generator derives that offset from the placement spacing
(25.0px on both MoonBoard layouts) rather than hardcoding it.

### The accessibility vocabulary

Every role carries a mark, so the absence of one is never meaningful — which also removes the
FOOT-dot-versus-LED collision, because the LED is now a rendered element rather than art:

| Role     | Mark                                      |
| -------- | ----------------------------------------- |
| FOOT     | ring, radius 0.24 r, one line width thick |
| STARTING | horizontal bar                            |
| HAND     | vertical bar                              |
| FINISH   | X                                         |

FOOT was a dot whose diameter was the line width until the second pass measured it at a tenth of a
bar's ink and noticed it was the same graphic the art paints over every LED. It has been a ring
since `ef0153125`.

One line width for every marker on a board, keyed to the placement radius so it is constant within
a board and scales between boards with hold pitch — **not** scaled by the hold it sits on. A marker
has to mean the same thing on a jug and on a foot chip. The bars run edge to edge and segment the
hold, clipped to its traced silhouette so they stop exactly at its edge. X rather than a plus for
FINISH so it cannot be read as the START and HAND bars drawn together.

Drawn in two passes — a dark casing under a light core — rather than picking a colour per hold from
the art beneath. The per-hold classifier flipped polarity between two visually identical hand holds
on the same climb, the same salt-and-pepper the unlit-hold casing had.

The passes run casing-then-core across the **whole glyph**, not per line. Drawing each line as
casing-then-core in turn put the second diagonal's dark casing over the first one's light core, and
cut dark stripes through the middle of the FINISH X where they cross.

The mark also goes on the **ring fallback**, not just on traced holds — the vocabulary has to be
complete, or the absence of a glyph starts to mean something.

### The glyph replaces the shipped marker shapes

The app already ships per-role marker **shapes** — circle, triangle-up, triangle-down, square,
diamond, octagon — user-configurable with brush-thickness and shape-size sliders, implemented in
both the SVG and Rust renderers and kept in sync with equal-area scaling (#3204).

That system works by changing the whole marker's shape, which a traced arm cannot do: its shape is
the hold's silhouette. So the glyph is what that setting becomes on a traced arm — the same
accessibility job, done inside the hold instead of by reshaping the marker. One replaces the other:
a climber who turns the accessibility mode on gets glyphs, and one who leaves it off gets neither
glyphs nor a second layer. It is off by default (`app/board-spike.tsx`, `&glyphs=on|off`), so judge
it on whether it serves someone who needs it, not on what it does to the default picture.

## Regenerating the derived data

Three generators, all offline, all committed output:

```
vp run spike:hold-outlines            # every hold's real silhouette on every board
vp run spike:hold-lightness           # art lightness in the ring's annulus AND inside the silhouette
vp run spike:led-dots                 # which holds have an LED, and where the art already paints one
```

In that order: the silhouette half of the lightness table is measured inside the
polygons the tracer emits, so re-running the tracer without re-running the
lightness pass leaves those values stale.

`spike:hold-outlines` traces 332/332 placements on Grasshopper, 303/303 on Tension Original,
498/498 on TB2 Mirror, 499/499 on Kilter Homewall, 476/476 on Kilter Original, 140/198 on MoonBoard
2016 and 112/198 on Masters 2019. The MoonBoard shortfall is not a bug: its placements are a
synthetic 11x18 grid and most cells genuinely have no hold, so those lit holds fall back to a ring
— visible in `boards/board-moonboard-*.webp`.

This file published 159 and 143 for the two MoonBoards for two rounds of fixes. Those were the
pre-fix run: the differences, 19 and 31, are exactly the neighbour leaks the table above reports as
gone. All seven counts are now pinned in
`packages/mobile/src/components/board-spike/__tests__/spike-hold-outlines.test.ts` along with the
rest of the design review's tracer gates, so they cannot drift out of this file again without a red
test.

## What would have to change before any of this ships

- Nothing here trips `vp run check:mobile-board-art-network` any more. The board art goes through
  `expo-image` on the same bundled `file://` paths the shipping stack resolves, and
  react-native-svg draws the overlay only. If a contrast variant of the art is ever wanted it is a
  second committed suffix in `scripts/generate-dark-board-art.ts` — that pipeline already has a
  `--check` CI mode and a golden test, and `background-image-cache.ts` already prefers a bundled
  sibling and falls through when there is none.
- The overlays are drawn in `react-native-svg` because the Rust renderer cannot draw a radial
  gradient or a non-circular outline today. Whichever treatment wins gets ported into
  `packages/board-renderer/core/src/renderer.rs`, so web, OG cards and the native overlay agree.
- The traced silhouettes and both lightness tables are committed data covering the seven boards
  here; the rest of the catalogue would need the same pass. The tracing has two known limits
  visible in its own output: where a hold's art touches a neighbour's, whatever falls on this
  placement's side of the nearest-placement partition and is joined by a neck wider than the trim
  radius stays with it, and a placement with no art under it is simply absent (consumers fall back
  to a ring).
- `app/board-spike.tsx` is an ordinary route, so it and its assets are in production bundles as
  written. It wants gating (or deleting) before merge.
- Only the Android emulator was exercised. iOS renders the same SVG but has not been looked at.
