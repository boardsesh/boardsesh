import { describe, expect, it } from 'vite-plus/test';
import { getClimbCoverPlacement, getClimbThumbnailCrop, getClimbThumbnailCropPlacement } from '../climb-thumbnail-crop';

const board = {
  board_name: 'kilter' as const,
  boardWidth: 100,
  boardHeight: 200,
  holdsData: [
    { id: 1, cx: 10, cy: 30, r: 5 },
    { id: 2, cx: 95, cy: 190, r: 8 },
  ],
};

describe('public thumbnail lit-hold crop', () => {
  it('includes a single hold ring and ten percent padding on each side', () => {
    expect(getClimbThumbnailCrop(board, 'p1r12')).toEqual({ x: 0.04, y: 0.12, width: 0.12, height: 0.06 });
  });
  it('clamps an asymmetric edge crop to the art without dropping its ring', () => {
    const crop = getClimbThumbnailCrop(board, 'p1r12p2r14')!;
    expect(crop.x).toBe(0);
    expect(crop.y).toBeCloseTo(0.0385);
    expect(crop.width).toBe(1);
    expect(crop.height).toBeCloseTo(0.9615);
  });
  it('uses the first rendered frame, rather than later animation holds', () => {
    expect(getClimbThumbnailCrop(board, 'p1r12,"p2r14')).toEqual(getClimbThumbnailCrop(board, 'p1r12'));
  });
  it.each(['', 'p3r12', 'p1r999'])('keeps full art for an empty or unknown render: %s', (frames) => {
    expect(getClimbThumbnailCrop(board, frames)).toBeNull();
  });
  it('keeps full art when catalogue geometry is unavailable or invalid', () => {
    expect(getClimbThumbnailCrop({ ...board, boardWidth: 0 }, 'p1r12')).toBeNull();
    expect(getClimbThumbnailCrop({ ...board, holdsData: [] }, 'p1r12')).toBeNull();
  });
  it('fits the complete padded crop on a wide board, with vertical breathing room', () => {
    const crop = getClimbThumbnailCrop(
      { ...board, boardWidth: 300, boardHeight: 100, holdsData: [{ id: 1, cx: 150, cy: 50, r: 10 }] },
      'p1r12',
    )!;
    const placement = getClimbThumbnailCropPlacement(crop, 300, 100, false);
    expect(placement.width).toBe('1250%');
    expect(parseFloat(placement.top)).toBeCloseTo(100 / 7);
    expect(placement.left).toBe('0%');
  });
  it('moves the crop to the reflected position without applying another mirror', () => {
    const crop = getClimbThumbnailCrop(board, 'p1r12')!;
    expect(getClimbThumbnailCropPlacement(crop, 100, 200, false).transform).toBe('translate(-4%, -12%)');
    expect(getClimbThumbnailCropPlacement(crop, 100, 200, true).transform).toBe('translate(-84%, -12%)');
  });
});

it.each([false, true])('keeps a padded bottom-edge hold in the slot with valid CSS, mirrored=%s', (mirrored) => {
  const crop = getClimbThumbnailCrop(board, 'p2r14')!;
  const placement = getClimbThumbnailCropPlacement(crop, 100, 200, mirrored);
  expect(placement.transform).not.toContain('--');
  const offsets = placement.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
  expect(offsets).toHaveLength(2);
  expect(offsets[0]).toBeCloseTo(mirrored ? 0 : -85.4);
  expect(offsets[1]).toBeCloseTo(-90.2);
  const artWidth = parseFloat(placement.width) / 100;
  const artHeight = artWidth * (5 / 7) * (board.boardHeight / board.boardWidth);
  const centreX = parseFloat(placement.left) / 100 + (offsets[0] / 100 + (mirrored ? 0.05 : 0.95)) * artWidth;
  const centreY = parseFloat(placement.top) / 100 + (offsets[1] / 100 + 0.95) * artHeight;
  expect(centreX).toBeGreaterThanOrEqual(0);
  expect(centreX).toBeLessThanOrEqual(1);
  expect(centreY).toBeGreaterThanOrEqual(0);
  expect(centreY).toBeLessThanOrEqual(1);
});

describe('playlist cover placement', () => {
  const percent = (value: string) => parseFloat(value);

  it('fits the whole board, centred, when there is no crop', () => {
    const square = getClimbCoverPlacement(null, 100, 100, false, 1);
    expect([square.left, square.top, square.width].map(percent)).toEqual([0, 0, 100]);

    // A tall board in a square cell: full height, centred across.
    const tall = getClimbCoverPlacement(undefined, 100, 200, false, 1);
    expect([tall.left, tall.top, tall.width].map(percent)).toEqual([25, 0, 50]);

    // A square board in a tall half-tile cell: full width, centred down.
    const halfTile = getClimbCoverPlacement(null, 100, 100, false, 0.5);
    expect([halfTile.left, halfTile.top, halfTile.width].map(percent)).toEqual([0, 25, 100]);
  });

  it('zooms a central crop to fill the cell, centred on it', () => {
    const placement = getClimbCoverPlacement({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, 100, 100, false, 1);
    expect(percent(placement.width)).toBeCloseTo(500);
    expect(percent(placement.left)).toBeCloseTo(-200);
    expect(percent(placement.top)).toBeCloseTo(-200);
  });

  it('slides an edge crop back so the art covers the cell instead of leaving a strip', () => {
    // Centring this top-edge crop alone would leave a quarter of the cell empty above the board.
    const placement = getClimbCoverPlacement({ x: 0, y: 0, width: 0.5, height: 0.25 }, 100, 100, false, 1);
    expect(percent(placement.width)).toBeCloseTo(200);
    expect(percent(placement.left)).toBeCloseTo(0);
    expect(percent(placement.top)).toBeCloseTo(0);
  });

  it('places a mirrored climb’s crop where the flipped art draws it', () => {
    const crop = { x: 0.1, y: 0.4, width: 0.2, height: 0.2 };
    expect(percent(getClimbCoverPlacement(crop, 100, 100, false, 1).left)).toBeCloseTo(-50);
    expect(percent(getClimbCoverPlacement(crop, 100, 100, true, 1).left)).toBeCloseTo(-350);
  });
});
