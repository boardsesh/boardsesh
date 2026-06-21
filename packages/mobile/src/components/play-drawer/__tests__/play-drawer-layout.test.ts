import { describe, expect, it } from 'vitest';
import { computeContainedBoardSize, computeFirstScreenHeight } from '../play-drawer-layout';

describe('computeContainedBoardSize', () => {
  it('height-bounds a tall board on a wide box (horizontal letterbox)', () => {
    // box 400x800, board aspect 0.4 → full height, width 320 < 400.
    expect(computeContainedBoardSize(400, 800, 0.4)).toEqual({ width: 320, height: 800 });
  });

  it('width-bounds a wide board (vertical letterbox)', () => {
    // box 400x800, board aspect 2 → full width, height 200 < 800.
    expect(computeContainedBoardSize(400, 800, 2)).toEqual({ width: 400, height: 200 });
  });

  it('width-bounds a square board in a tall box', () => {
    expect(computeContainedBoardSize(400, 800, 1)).toEqual({ width: 400, height: 400 });
  });

  it('height-bounds a square board in a wide box', () => {
    expect(computeContainedBoardSize(800, 400, 1)).toEqual({ width: 400, height: 400 });
  });

  it('treats an exact fit as height-bound (boundary)', () => {
    // box 300x400, aspect 0.75 → widthAtFullHeight === boxWidth (300).
    expect(computeContainedBoardSize(300, 400, 0.75)).toEqual({ width: 300, height: 400 });
  });

  it('never exceeds the box on either axis', () => {
    const box = computeContainedBoardSize(360, 500, 0.73);
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(360);
    expect(box!.height).toBeLessThanOrEqual(500);
  });

  it('returns null for a not-yet-measured or invalid box', () => {
    expect(computeContainedBoardSize(0, 800, 0.7)).toBeNull();
    expect(computeContainedBoardSize(400, 0, 0.7)).toBeNull();
    expect(computeContainedBoardSize(400, 800, 0)).toBeNull();
    expect(computeContainedBoardSize(-1, 800, 0.7)).toBeNull();
  });
});

describe('computeFirstScreenHeight', () => {
  it('subtracts the reserve from the window when above the floor', () => {
    expect(computeFirstScreenHeight(800, 100)).toBe(700);
  });

  it('floors at half the window when the reserve is too large', () => {
    expect(computeFirstScreenHeight(800, 500)).toBe(400);
  });

  it('honours a custom floor fraction', () => {
    expect(computeFirstScreenHeight(1000, 900, 0.6)).toBe(600);
  });
});
