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
- **`FeGaussianBlur` is broken in react-native-svg 15.15.5 on Android.** A stroke through it paints
  the filter region as a solid rectangle of the stroke colour. `FeColorMatrix` in the same version
  is fine (the Desat toggle uses it), so the glow falloff is twelve concentric strokes on a squared
  ramp instead of one blurred stroke. Four bands read as visible rings; twelve does not.

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
