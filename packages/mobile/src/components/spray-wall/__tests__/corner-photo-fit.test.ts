import { describe, expect, it } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import {
  CORNER_FRAME_INSET,
  CORNER_HANDLE_SIZE,
  cornerLayerLayout,
  fitCornerPhoto,
  planCornerRefit,
  quadToPhoto,
  quadToRender,
  rescaleRenderCoordinate,
} from '../corner-photo-fit';

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

describe('cornerLayerLayout', () => {
  const fit = { width: 315, height: 420 };
  const layout = cornerLayerLayout(fit);

  it('makes the handle layer the photo plus the inset on every side', () => {
    expect(layout.layer).toEqual({ width: 315 + 2 * CORNER_FRAME_INSET, height: 420 + 2 * CORNER_FRAME_INSET });
    expect(layout.frame).toEqual({ left: CORNER_FRAME_INSET, top: CORNER_FRAME_INSET, width: 315, height: 420 });
  });

  it('puts the centre of a handle on the point of the frame it stands for', () => {
    // A handle is drawn at (coordinate + handleOffset) and is CORNER_HANDLE_SIZE
    // across, so that is where its centre — the ring — ends up in the layer. It
    // has to be the same place the frame puts that coordinate, or every saved
    // corner is off from the ring the climber saw by the difference.
    for (const coordinate of [0, 31.5, fit.width]) {
      const handleCentre = coordinate + layout.handleOffset + CORNER_HANDLE_SIZE / 2;
      expect(handleCentre).toBe(layout.frame.left + coordinate);
    }
  });

  it('keeps a handle on any corner of the photo inside the layer, so it stays touchable', () => {
    for (const [renderX, renderY] of [
      [0, 0],
      [fit.width, 0],
      [fit.width, fit.height],
      [0, fit.height],
    ]) {
      const left = renderX + layout.handleOffset;
      const top = renderY + layout.handleOffset;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + CORNER_HANDLE_SIZE).toBeLessThanOrEqual(layout.layer.width);
      expect(top + CORNER_HANDLE_SIZE).toBeLessThanOrEqual(layout.layer.height);
    }
  });
});

describe('planCornerRefit', () => {
  const shown = { seedKey: '1,2;3,4;5,6;7,8', scale: 0.2 };

  it('does nothing when neither the quad nor the fit changed', () => {
    // A re-render must not move a ring that is under a finger.
    expect(planCornerRefit(shown, { ...shown })).toBe('none');
  });

  it('re-seeds when the saved quad changed', () => {
    expect(planCornerRefit(shown, { ...shown, seedKey: '9,9;3,4;5,6;7,8' })).toBe('seed');
  });

  it('rescales, and does not re-seed, when only the fit changed', () => {
    // Re-seeding here would throw away a quad that was dragged, refused for
    // crossing itself and so never saved.
    expect(planCornerRefit(shown, { ...shown, scale: 0.18 })).toBe('rescale');
  });

  it('re-seeds when both changed: the new seed is already at the new scale', () => {
    expect(planCornerRefit(shown, { seedKey: '9,9;3,4;5,6;7,8', scale: 0.18 })).toBe('seed');
  });
});
