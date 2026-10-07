import { describe, expect, it } from 'vitest';
import { lookPreviewMask, lookPreviewSourceFromRenderData, lookPreviewTileSize } from '../spray-look-preview';

const RENDER_DATA = {
  boardWidth: 2000,
  boardHeight: 1500,
  homography: [1, 0, -100, 0, 1, -100, 0, 0, 1],
  photo: { url: 'https://private.example/photo.jpg', thumbUrl: null, width: 2400, height: 1800, expiresAt: 'later' },
  holds: [
    {
      id: 1,
      cx: 400,
      cy: 400,
      r: 40,
      outline: [1, 0, 0, 1, -1, 0, 0, -1],
      installedVersion: 1,
      source: 'MANUAL' as const,
    },
  ],
};

describe('lookPreviewSourceFromRenderData', () => {
  it('keeps the photo, map, frame and canonical holds', () => {
    expect(lookPreviewSourceFromRenderData(RENDER_DATA)).toEqual({
      photoUrl: 'https://private.example/photo.jpg',
      photo: { width: 2400, height: 1800 },
      homography: [1, 0, -100, 0, 1, -100, 0, 0, 1],
      frame: { width: 2000, height: 1500 },
      holds: [{ cx: 400, cy: 400, r: 40, outline: [1, 0, 0, 1, -1, 0, 0, -1] }],
    });
  });

  it.each([
    ['no payload', null],
    ['a photo with no size', { ...RENDER_DATA, photo: { ...RENDER_DATA.photo, width: null } }],
    ['no frame', { ...RENDER_DATA, boardWidth: 0 }],
    ['a short homography', { ...RENDER_DATA, homography: [1, 0, 0] }],
    ['a NaN in the homography', { ...RENDER_DATA, homography: [1, 0, 0, 0, 1, 0, 0, 0, Number.NaN] }],
  ])('is null for %s', (_name, renderData) => {
    expect(lookPreviewSourceFromRenderData(renderData)).toBeNull();
  });
});

describe('lookPreviewTileSize', () => {
  it('fills the slot at the frame aspect', () => {
    expect(lookPreviewTileSize({ width: 2000, height: 1500 }, 120, 160)).toEqual({ width: 120, height: 90 });
  });

  it('narrows a tall wall rather than growing past the height cap', () => {
    expect(lookPreviewTileSize({ width: 1000, height: 3000 }, 120, 160)).toEqual({ width: 53, height: 160 });
  });

  it('is null before the slot is measured', () => {
    expect(lookPreviewTileSize({ width: 2000, height: 1500 }, 0, 160)).toBeNull();
  });
});

describe('lookPreviewMask', () => {
  it('is one path of every outline in tile pixels, with a grow of at least 1 and a feather', () => {
    const mask = lookPreviewMask(
      [
        { cx: 400, cy: 400, r: 40, outline: [1, 0, 0, 1, -1, 0, 0, -1] },
        { cx: 1000, cy: 500, r: 50, outline: null },
      ],
      0.1,
    )!;
    // The traced hold: centre (40, 40) in tile pixels, radius 4.
    expect(mask.path.startsWith('M44.0 40.0L40.0 44.0L36.0 40.0L40.0 36.0Z')).toBe(true);
    // The untraced one is the 32-point circle the job draws.
    expect(mask.path.split('M')).toHaveLength(3);
    expect(mask.path.match(/L/g)).toHaveLength(3 + 31);
    expect(mask.grow).toBe(1);
    expect(mask.feather).toBeGreaterThanOrEqual(1);
  });

  it('stays one path for a full wall', () => {
    const holds = Array.from({ length: 300 }, (_, index) => ({ cx: 10 * index, cy: 20, r: 30, outline: null }));
    const mask = lookPreviewMask(holds, 0.06)!;
    expect(mask.path.split('M')).toHaveLength(301);
  });

  it('is null with no holds or no scale', () => {
    expect(lookPreviewMask([], 0.1)).toBeNull();
    expect(lookPreviewMask([{ cx: 1, cy: 1, r: 1 }], 0)).toBeNull();
  });
});
