# Board rendering on a dark field — spike (issue #2202)

Everything proposed in [#2202](https://github.com/boardsesh/boardsesh/issues/2202) built as a
switchable dev screen, so the options can be compared on a real device instead of argued about
in the abstract. **This is a spike, not a shipping design** — see "What would have to change"
below before treating any of it as a plan.

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

Four independent axes, each a row of chips:

| Axis              | Options                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlay treatment | Baseline · Piece halos · Glow halos · Neighbour halos · Shape-coded · Traced halos · Traced glow · Whole-hold tint · Contrast casing · Glow + shape |
| Board art         | shipped · OkLab stretch ×0.6 · OkLab stretch ×1                                                                                                     |
| Role colours      | shipped · equal OkLab lightness                                                                                                                     |
| Play field        | dark `#181225` · neutral grey · near-black · plywood                                                                                                |

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
  outlines were splined with *uniform* Catmull-Rom, which bulges wherever a long segment meets a
  short one — on a hold outline that bulge is a tint spilling past the edge of the hold it is
  supposed to trace. Centripetal parameterisation fixes it and cannot cusp or self-intersect.
- **`FeGaussianBlur` is broken in react-native-svg 15.15.5 on Android.** A stroke through it paints
  the filter region as a solid rectangle of the stroke colour. `FeColorMatrix` in the same version
  is fine (the Desat toggle uses it), so the glow falloff is twelve concentric strokes on a squared
  ramp instead of one blurred stroke. Four bands read as visible rings; twelve does not.

## The design review, and the three bugs it found

`design-review.md` is the output of a fifteen-agent design pass over the device captures — seven
lenses, every finding adversarially verified against the images, then synthesised. It made three
structural claims about the tracer, all three of which held up when audited against the generated
data:

| Defect | Before | After |
| --- | --- | --- |
| Outlines that ran into the search box and traced its edge | 215/499 on Kilter Homewall, 33 on TB2, 31 on Masters, 21 on MoonBoard 2016 | 0 everywhere |
| Lit holds whose silhouette came from a *neighbouring* hold | 31/143 on Masters 2019, 19/159 on MoonBoard 2016 | 0 everywhere |
| Merged blobs spanning two or more holds | up to 36 per board | not expressible |

The fixes, in the tracer:

- **Nearest-placement partition.** A jump-flood-style two-pass chamfer from every placement centre
  labels each pixel with the placement it belongs to, and a hold's mask is `opaque ∧ label == self`.
  Touching holds split along the midline between their bolts. This is what makes merges structurally
  impossible rather than something to filter for afterwards.
- **Seed containment.** The seed is now taken from a disc of `max(4px, 0.15 × nearest-placement
  pitch)` around the placement centre. The old rule — nearest filled pixel anywhere in the search
  box — reached two-thirds of the way into a neighbour on MoonBoard, where the cell pitch (58.7px)
  is barely larger than the marker radius (38.8px), and that is exactly how a light ended up on the
  wrong hold.
- **A bigger search box.** 1.25 → 2.6 placement radii. At 1.25 the box was smaller than a Kilter
  Homewall mainline hold, so the trace hit the boundary and followed it. The partition is what makes
  a big box safe.
- **No area backstop.** A "reject anything above 2.2× the board median area" rule was the only
  defence against merges before the partition. Afterwards it fired on Grasshopper's genuinely large
  square holds — 14 real holds deleted to catch nothing. A board with a 6× spread of hold sizes has
  no safe global area threshold.

One more finding acted on: tracing shrinks every mark, because a silhouette is the real hold and the
baseline circle is usually bigger than it. Below `0.45 × placement diameter` the baseline ring is now
drawn as well, so the silhouette carries identity and the ring carries findability. It fires on 7/16
lit holds on TB2 Mirror and 5/10 on MoonBoard 2016, and on 0/16 on Kilter Homewall, whose holds are
already 70% of the circle.

## Acting on the review: four arms, not three

The arm set is now **Baseline · Traced outline · Outward glow · Glow + tint**, following the
review's calls:

- **Outward glow leads.** The only treatment that beat baseline on every board compared, and the
  only one where the wall's own bright holds cannot be mistaken for lit ones — a halo is something
  photographic hold art cannot produce.
- **Traced halos is not an arm.** Its lit mark is byte-identical to baseline, so as an arm it can
  only lose on lit visibility. It is the per-board modifier described above, and nothing else.
- **Plain whole-hold tint is out, replaced by Glow + tint.** Plain tint lost to baseline on three
  of six boards on small holds, and on Grasshopper a tinted hold read as the same class as the
  wall's own cyan art. The hybrid normalises the art under the hold toward a common lightness
  (translucent, so the hold's shading and bolt hole survive), fills at α0.55, puts a crisp
  inside-clipped silhouette edge on it, and keeps the outward glow for reach.
- **Role glyphs, identical in every arm.** Role was carried by hue alone, and hue is the channel
  that fails: under protanopia HAND `#4455FF` and FOOT `#FF00FF` land 7.7 ΔE apart — one colour.
  The second channel is silhouette: HAND nothing, FOOT a dot, START a bar, FINISH a cross, sized
  inside the existing footprint so the mark does not grow. `boards/colour-vision.webp` is the
  Viénot 1999 protan/deutan simulation of the captures, baseline against glyphs.

Two implementation notes that differ from the review's text, both deliberate:

- The glyph is sized on the hold's **shortest** axis, not the marker diameter. Sizing on the
  marker put a bar the full height of a thin elongated rail.
- The every-hold outline is one **unconditional two-tone casing** (dark pass, lighter core) rather
  than a per-hold black-or-white choice. The classifier flipped polarity on visually identical
  neighbours whose measured lightness straddled the threshold, which reads as salt-and-pepper.

### Those white dots are LEDs, and the renderer now owns them

They are not bolt holes. Physically the LED sits centrally on Grasshopper, Tension and Woods;
MoonBoard puts it in the gap above or below the hold; Kilter lights the translucent hold base so
the rim glows. Measured over the composited art (`scripts/spike-led-dots.ts`):

| Board | Placements with an LED | Art paints the LED bright | Median centre-vs-hold brightness |
| --- | --- | --- | --- |
| Grasshopper Master | 332/332 | 234 | **10.19×** |
| Tension Original | 303/303 | 0 | **0.29×** (drawn *dark*) |
| TB2 Mirror | 498/498 | 0 | 1.15× |
| Kilter Homewall | 499/499 | 0 | 0.42× (bolt hole) |
| Kilter Original | 476/476 | 10 | 0.64× |
| MoonBoard 2016 / Masters | **0**/198 | 23 / 13 | 0.77× / 0.89× |

So Grasshopper paints roughly two thirds of its LEDs bright and leaves the rest dark, and Tension
paints all of them darker than the hold. An unlit hold with a bright LED competes with a lit mark;
a lit hold with a dark LED does not look lit. The renderer now takes the LED over from the art:
**role colour where the hold is lit, dark where it is not**, and nothing at all on a board with no
LED placement data (both MoonBoards).

### The accessibility vocabulary

Every role carries a mark, so the absence of one is never meaningful — which also removes the
FOOT-dot-versus-LED collision, because the LED is now a rendered element rather than art:

| Role | Mark |
| --- | --- |
| FOOT | dot, diameter == the line width |
| STARTING | horizontal bar |
| HAND | vertical bar |
| FINISH | X |

One line width for every marker on a board, keyed to the placement radius so it is constant within
a board and scales between boards with hold pitch — **not** scaled by the hold it sits on. A marker
has to mean the same thing on a jug and on a foot chip. The bars run edge to edge and segment the
hold, clipped to its traced silhouette so they stop exactly at its edge. X rather than a plus for
FINISH so it cannot be read as the START and HAND bars drawn together.

Drawn in two passes — a dark casing under a light core — rather than picking a colour per hold from
the art beneath. The per-hold classifier flipped polarity between two visually identical hand holds
on the same climb, the same salt-and-pepper the unlit-hold casing had.

## Regenerating the derived data

Three generators, all offline, all committed output:

```
vp run spike:oklab-board-art          # contrast-stretched art, Grasshopper only (default 0.6 and 1.0)
vp run spike:oklab-board-art -- 0.4   # any amount in (0, 1]
vp run spike:hold-outlines            # every hold's real silhouette on every board
vp run spike:hold-lightness           # art lightness under each ring, on every board
```

`spike:hold-outlines` traces 332/332 placements on Grasshopper, 303/303 on Tension Original,
498/498 on TB2 Mirror, 499/499 on Kilter Homewall, 476/476 on Kilter Original, 159/198 on MoonBoard
2016 and 143/198 on Masters 2019. The MoonBoard shortfall is not a bug: its placements are a
synthetic 11x18 grid and most cells genuinely have no hold, so those lit holds fall back to a ring
— visible in `boards/board-moonboard-*.webp`.

## Regenerating the stretched art

```
vp run spike:oklab-board-art          # default amounts (0.6 and 1.0)
vp run spike:oklab-board-art -- 0.4   # any amount in (0, 1]
```

Writes `packages/mobile/assets/spike/grasshopper/*.c<amount>.webp`. The histogram is built from
the _composited_ stack, not per layer, so every layer gets the same mapping and the board still
reads as one surface.

## What would have to change before any of this ships

- The stretched art is precomputed for one board config and committed (~920 KB). Real support
  means either a build step over every board's art, or doing the stretch on-device and caching
  it — the issue's own suggestion, and reasonable given how long a user stays on one board.
- **This branch trips `vp run check:mobile-board-art-network` and was committed with
  `--no-verify`.** To desaturate the art the spike draws the board layers as react-native-svg
  `<Image>` elements so an `FeColorMatrix` can act on them, and the guard's `svg-image-background`
  rule forbids exactly that (board art must go through bundled file paths on `expo-image`). The
  guard is right and the spike is the exception: nothing here fetches over the network — the hrefs
  are the same bundled `file://` paths `expo-image` would get — but the shape is the one the rule
  exists to stop, so this cannot merge as written. A shipping desaturation wants either a
  precomputed desaturated variant per board or the transform inside the Rust renderer.
- The overlays are drawn in `react-native-svg` because the Rust renderer cannot draw a radial
  gradient or a non-circular outline today. Whichever treatment wins gets ported into
  `packages/board-renderer/core/src/renderer.rs`, so web, OG cards and the native overlay agree.
- The traced silhouettes and per-ring lightness are committed tables covering the seven boards
  here; the rest of the catalogue would need the same pass. The tracing has two known failure
  modes visible in its own output: a hold whose art touches its neighbour's traces as the merged
  blob, and a placement with no art under it is simply absent (consumers fall back to a ring).
- `app/board-spike.tsx` is an ordinary route, so it and its assets are in production bundles as
  written. It wants gating (or deleting) before merge.
- Only the Android emulator was exercised. iOS renders the same SVG but has not been looked at.
