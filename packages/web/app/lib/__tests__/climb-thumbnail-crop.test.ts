import { describe, expect, it } from 'vite-plus/test';
import { getClimbThumbnailCrop, getClimbThumbnailCropPlacement } from '../climb-thumbnail-crop';

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
