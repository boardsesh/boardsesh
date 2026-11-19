# Frosted bokeh

Pure TypeScript geometry and colour math for frosted backgrounds. Points can
describe any coloured layout; the engine has no board, React or platform imports.

```ts
import { buildBokehBlobs, blobGradient } from '@boardsesh/frosted-bokeh';

const blobs = buildBokehBlobs({
  points: [{ x: 50, y: 100, color: '#4DF5FD' }],
  source: { w: 100, h: 120 },
  target: { w: 360, h: 44 },
  rotation: 'clockwise',
  effectScale: 1,
});

const gradients = blobs.map((blob) => blobGradient(blob));
```

Rotation defaults to `none`; effect scale defaults to `1`. Scale controls the
blur and disc radii together, separately from point placement. Invalid dimensions
or no finite points return no blobs. Points outside the source clamp to its edges;
the consumer clips the background to its surface. The engine limits the result
to 15 blobs, retaining their spread across the target.

`BOKEH_FALLOFF`, `BOKEH_DARK_SURFACE`, `BOKEH_LIGHT_SURFACE`, `FROST_ALPHA` and
`GRAIN_ALPHA` describe the shared look. The original texture is exported as
`@boardsesh/frosted-bokeh/grain.png`. `bokehPixel` samples composited colour for
contrast checks, conservatively accounting for the brightest/darkest grain.

## Moving frost

`BOKEH_DRIFT` (3.5 pt) and `BOKEH_SWELL` (0.14) describe the moving frost: each
light drifts on its own slow orbit no further than the drift and swells by up to
the swell share of its peak. Its phase is `bokehSeed`: a hash of the hold id (or
the position), so a light keeps its phase whatever slot it is drawn in. The
native views in `packages/mobile/modules/frosted-bokeh-gpu` take all of these as
props, so this package is the only place they are set.

`swap.ts` is how the frost changes climbs: the board's swap look at pill scale
(option I). The native views follow the board's swap frames light by light
(`frostLightWeight`, `frostLightShape`), and with no frames run a release of
their own (`frostReleaseFill`, `frostReleaseFade`: old lights out by
`BOKEH_SWAP_OUT_MS`, new ones filling from the right edge over `BOKEH_SWAP_MS`).
Under Reduce Motion the wall button draws a still frost. A light lit in both
climbs (`sameBokehHold`) stays whole; at most `MAX_GPU_BOKEH_LIGHTS` are drawn,
the strongest kept (`capBokehLights`). `BokehMotion.swift` and `BokehMotion.kt`
implement the same rules, held to the golden vectors in `swap.test.ts` (the
same numbers `BokehMotionTest.kt` pins); change all three together. `BOKEH_GLIDE_MS` (700) is
the old index glide, kept for binaries without the swap-frame API.

`bokehPixel(point, blobs, { ..., motion: true })` returns the worst frame that
breathing can draw at a point: every light as close as its drift allows and fully
swelled. Screen and multiply both move a pixel further from the base as alpha
grows, so a contrast check over `motion: true` covers every breathing frame.
A change of climb is not covered by that bound; the wall button holds the
stronger of the two climbs' label fades while the board shows both and through
the release.

Native consumers use `FrostedBokeh` in the mobile component library. The board
button's `WallGlow` adapter owns its label fade and interaction-specific choices.
The server adapter is `@boardsesh/board-render/frosted-bokeh`, which rasterises
the same geometry and texture with Sharp.
