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

`BOKEH_DRIFT` (3.5 pt), `BOKEH_SWELL` (0.14) and `BOKEH_GLIDE_MS` (700) describe
the moving frost: each light drifts on its own slow orbit no further than the
drift, swells by up to the swell share of its peak, and slides to the next
climb's light over the glide. The iOS Metal view in
`packages/mobile/modules/frosted-bokeh-gpu` takes all three as props, so this
package is the only place they are set.

`bokehPixel(point, blobs, { ..., motion: true })` returns the worst frame that
motion can draw at a point: every light as close as its drift allows and fully
swelled. Screen and multiply both move a pixel further from the base as alpha
grows, so a contrast check over `motion: true` covers every breathing frame.
The glide between two climbs is not covered by that bound; the wall button
holds the stronger of the two climbs' label fades until the glide ends.

Native consumers use `FrostedBokeh` in the mobile component library. The board
button's `WallGlow` adapter owns its label fade and interaction-specific choices.
The server adapter is `@boardsesh/board-render/frosted-bokeh`, which rasterises
the same geometry and texture with Sharp.
