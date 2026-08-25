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
  is actually drawn in, mean OkLab L is 0.411 but the range is 0.000 (bare field) to 0.847 (a pale
  hold). That spread is what a fixed casing colour cannot serve and `contrast-color()` is for.

## Regenerating the derived data

Three generators, all offline, all committed output:

```
vp run spike:oklab-board-art          # contrast-stretched art (default 0.6 and 1.0)
vp run spike:oklab-board-art -- 0.4   # any amount in (0, 1]
vp run spike:hold-outlines            # each hold's real silhouette, traced from the alpha channel
vp run spike:hold-lightness           # art lightness under each ring, for the contrast casing
```

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
- The overlays are drawn in `react-native-svg` because the Rust renderer cannot draw a radial
  gradient or a non-circular outline today. Whichever treatment wins gets ported into
  `packages/board-renderer/core/src/renderer.rs`, so web, OG cards and the native overlay agree.
- The traced silhouettes are a committed table for one board config. Every board would need the
  same pass, and the tracing has two known failure modes visible in its own output: a hold whose
  art touches its neighbour's traces as the merged blob, and a placement with no art under it is
  simply absent (the renderer falls back to a ring for those).
- `app/board-spike.tsx` is an ordinary route, so it and its assets are in production bundles as
  written. It wants gating (or deleting) before merge.
- Only the Android emulator was exercised. iOS renders the same SVG but has not been looked at.
