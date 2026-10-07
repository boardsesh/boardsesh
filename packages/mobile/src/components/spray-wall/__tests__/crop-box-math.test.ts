import { describe, expect, it } from 'vitest';
import { CROP_RESIZE_HANDLES, dragCropEdges, type CropEdges } from '../crop-box-math';

/** Pixel units, so the expectations read as plain numbers. */
const BOUNDS = { width: 1000, height: 800 };
const MIN = { width: 150, height: 120 };
const BOX: CropEdges = { left: 200, top: 100, right: 700, bottom: 600 };

describe('dragCropEdges', () => {
  it('moves one edge for an edge handle and two for a corner', () => {
    expect(dragCropEdges(BOX, 'left', -50, 999, BOUNDS, MIN)).toEqual({ ...BOX, left: 150 });
    expect(dragCropEdges(BOX, 'bottom', 999, 40, BOUNDS, MIN)).toEqual({ ...BOX, bottom: 640 });
    expect(dragCropEdges(BOX, 'topRight', 30, -20, BOUNDS, MIN)).toEqual({ ...BOX, top: 80, right: 730 });
    expect(dragCropEdges(BOX, 'bottomLeft', 10, 10, BOUNDS, MIN)).toEqual({ ...BOX, left: 210, bottom: 610 });
  });

  it('keeps every edge on the photo', () => {
    expect(dragCropEdges(BOX, 'topLeft', -5000, -5000, BOUNDS, MIN)).toEqual({ ...BOX, left: 0, top: 0 });
    expect(dragCropEdges(BOX, 'bottomRight', 5000, 5000, BOUNDS, MIN)).toEqual({ ...BOX, right: 1000, bottom: 800 });
  });

  it('stops at the minimum rather than turning the box inside out', () => {
    expect(dragCropEdges(BOX, 'left', 5000, 0, BOUNDS, MIN)).toEqual({ ...BOX, left: 700 - 150 });
    expect(dragCropEdges(BOX, 'top', 0, 5000, BOUNDS, MIN)).toEqual({ ...BOX, top: 600 - 120 });
    expect(dragCropEdges(BOX, 'right', -5000, 0, BOUNDS, MIN)).toEqual({ ...BOX, right: 200 + 150 });
    expect(dragCropEdges(BOX, 'bottom', 0, -5000, BOUNDS, MIN)).toEqual({ ...BOX, bottom: 100 + 120 });
  });

  it('moves the whole box without resizing it, and stops it at the edges', () => {
    expect(dragCropEdges(BOX, 'move', 100, 50, BOUNDS, MIN)).toEqual({ left: 300, top: 150, right: 800, bottom: 650 });
    expect(dragCropEdges(BOX, 'move', 5000, -5000, BOUNDS, MIN)).toEqual({
      left: 500,
      top: 0,
      right: 1000,
      bottom: 500,
    });
  });

  it('answers from the start of the drag, so a clamp never makes the box creep', () => {
    // Overshoot then come back: the same translation always gives the same box.
    const overshoot = dragCropEdges(BOX, 'right', 900, 0, BOUNDS, MIN);
    expect(overshoot.right).toBe(1000);
    expect(dragCropEdges(BOX, 'right', 20, 0, BOUNDS, MIN)).toEqual({ ...BOX, right: 720 });
  });

  it('treats a minimum bigger than the photo as the whole photo', () => {
    const whole = { left: 0, top: 0, right: 1, bottom: 1 };
    expect(dragCropEdges(whole, 'left', 0.5, 0, { width: 1, height: 1 }, { width: 1.5, height: 1 })).toEqual(whole);
  });

  it('works in fractions exactly as in pixels', () => {
    const fractions = dragCropEdges(
      { left: 0.2, top: 0.125, right: 0.7, bottom: 0.75 },
      'topLeft',
      -50 / 1000,
      -20 / 800,
      { width: 1, height: 1 },
      { width: 0.15, height: 0.15 },
    );
    expect(fractions.left).toBeCloseTo(0.15, 12);
    expect(fractions.top).toBeCloseTo(0.1, 12);
  });

  it('draws the corners last, so a corner wins where its target overlaps an edge', () => {
    expect(CROP_RESIZE_HANDLES.slice(-4)).toEqual(['topLeft', 'topRight', 'bottomRight', 'bottomLeft']);
  });
});
