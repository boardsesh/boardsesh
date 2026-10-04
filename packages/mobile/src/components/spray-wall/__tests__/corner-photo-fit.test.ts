import { describe, expect, it } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import { fitCornerPhoto, quadToPhoto, quadToRender, rescaleRenderCoordinate } from '../corner-photo-fit';

/** A portrait phone photo, as the picker hands it over after compression. */
const PORTRAIT = { photoWidth: 1536, photoHeight: 2048 };
const LANDSCAPE = { photoWidth: 2048, photoHeight: 1536 };

function expectQuadClose(actual: Quad, expected: Quad) {
  expect(actual).toHaveLength(expected.length);
  for (const [corner, [expectedX, expectedY]] of expected.entries()) {
    expect(actual[corner][0]).toBeCloseTo(expectedX, 6);
    expect(actual[corner][1]).toBeCloseTo(expectedY, 6);
  }
}

describe('fitCornerPhoto', () => {
  it('shrinks a portrait photo to the height it is given (#5958)', () => {
    // 370 points wide is an iPhone 17 Pro less its gutters. Fitted to the width
    // alone this photo is 493 points tall, which is what ran under the footer.
    const fit = fitCornerPhoto({ boxWidth: 370, boxHeight: 420, ...PORTRAIT });
    expect(fit).not.toBeNull();
    expect(fit!.height).toBeCloseTo(420, 6);
    expect(fit!.width).toBeCloseTo(315, 6);
  });

  it('never draws the photo taller or wider than its box, whatever the shape', () => {
    const boxes = [
      { boxWidth: 370, boxHeight: 420 },
      { boxWidth: 343, boxHeight: 200 },
      { boxWidth: 520, boxHeight: 900 },
      { boxWidth: 200, boxHeight: 700 },
    ];
    for (const box of boxes) {
      for (const photo of [PORTRAIT, LANDSCAPE, { photoWidth: 1000, photoHeight: 1000 }]) {
        const fit = fitCornerPhoto({ ...box, ...photo })!;
        expect(fit.width).toBeLessThanOrEqual(box.boxWidth + 1e-9);
        expect(fit.height).toBeLessThanOrEqual(box.boxHeight + 1e-9);
      }
    }
  });

  it('keeps a landscape photo at the full width when the height has room', () => {
    const fit = fitCornerPhoto({ boxWidth: 370, boxHeight: 420, ...LANDSCAPE })!;
    expect(fit.width).toBeCloseTo(370, 6);
    expect(fit.height).toBeCloseTo(277.5, 6);
  });

  it('uses one scale for both axes, so the frame keeps the photo’s shape exactly', () => {
    const fit = fitCornerPhoto({ boxWidth: 371.5, boxHeight: 419.25, ...PORTRAIT })!;
    expect(fit.width / PORTRAIT.photoWidth).toBeCloseTo(fit.scale, 12);
    expect(fit.height / PORTRAIT.photoHeight).toBeCloseTo(fit.scale, 12);
  });

  it('has no frame until both the box and the photo have a size', () => {
    expect(fitCornerPhoto({ boxWidth: 0, boxHeight: 420, ...PORTRAIT })).toBeNull();
    expect(fitCornerPhoto({ boxWidth: 370, boxHeight: 0, ...PORTRAIT })).toBeNull();
    expect(fitCornerPhoto({ boxWidth: 370, boxHeight: -44, ...PORTRAIT })).toBeNull();
    expect(fitCornerPhoto({ boxWidth: 370, boxHeight: 420, photoWidth: 0, photoHeight: 0 })).toBeNull();
    expect(fitCornerPhoto({ boxWidth: Number.NaN, boxHeight: 420, ...PORTRAIT })).toBeNull();
  });
});

describe('the corner mapping', () => {
  const quad: Quad = [
    [153.6, 204.8],
    [1382.4, 190],
    [1400, 1843.2],
    [120, 1900.5],
  ];

  it('gives back the same photo pixels it was seeded with, at any fit', () => {
    for (const box of [
      { boxWidth: 370, boxHeight: 420 },
      { boxWidth: 343, boxHeight: 244 },
      { boxWidth: 520, boxHeight: 900 },
    ]) {
      const { scale } = fitCornerPhoto({ ...box, ...PORTRAIT })!;
      expectQuadClose(quadToPhoto(quadToRender(quad, scale), scale), quad);
    }
  });

  it('maps the far corner of the frame onto the far corner of the photo', () => {
    // The handles are clamped to the frame. If the frame's bottom edge did not
    // land exactly on the photo's last row, a corner dragged all the way down
    // would save short of it — or past it, outside the photograph.
    const fit = fitCornerPhoto({ boxWidth: 370, boxHeight: 420, ...PORTRAIT })!;
    const corners: Quad = [
      [0, 0],
      [fit.width, 0],
      [fit.width, fit.height],
      [0, fit.height],
    ];
    expectQuadClose(quadToPhoto(corners, fit.scale), [
      [0, 0],
      [1536, 0],
      [1536, 2048],
      [0, 2048],
    ]);
  });

  it('keeps every ring on the same point of the photo when the frame is re-fitted', () => {
    // The space around the photo changes (a rotation, a hint that wraps) while
    // rings are where the climber dragged them. Carrying each one across by the
    // ratio of the two scales must land where a fresh seed at the new fit would.
    const before = fitCornerPhoto({ boxWidth: 370, boxHeight: 420, ...PORTRAIT })!;
    const after = fitCornerPhoto({ boxWidth: 370, boxHeight: 372, ...PORTRAIT })!;
    const carried: Quad = quadToRender(quad, before.scale).map(([renderX, renderY]) => [
      rescaleRenderCoordinate(renderX, before.scale, after.scale),
      rescaleRenderCoordinate(renderY, before.scale, after.scale),
    ]);
    expectQuadClose(carried, quadToRender(quad, after.scale));
    expectQuadClose(quadToPhoto(carried, after.scale), quad);
  });

  it('leaves a coordinate alone rather than divide by a scale that is not one', () => {
    expect(rescaleRenderCoordinate(120, 0, 0.2)).toBe(120);
    expect(rescaleRenderCoordinate(120, 0.2, Number.NaN)).toBe(120);
  });
});
