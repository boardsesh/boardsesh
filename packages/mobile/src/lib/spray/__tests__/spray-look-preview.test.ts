import { describe, expect, it } from 'vitest';
import {
  cachedPhotoUri,
  isLocalFileUri,
  lookPreviewMask,
  lookPreviewMaskSvgDataUri,
  lookPreviewSourceFromRenderData,
  lookPreviewTileSize,
} from '../spray-look-preview';

const IDENTITY = { layoutId: 9, versionId: '3' };

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
    expect(lookPreviewSourceFromRenderData(RENDER_DATA, IDENTITY)).toEqual({
      layoutId: 9,
      versionId: 3,
      photoUrl: 'https://private.example/photo.jpg',
      photoExpiresAt: 'later',
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
    expect(lookPreviewSourceFromRenderData(renderData, IDENTITY)).toBeNull();
  });

  it('is null without a version to cache the photo under', () => {
    expect(lookPreviewSourceFromRenderData(RENDER_DATA, { layoutId: 9, versionId: null })).toBeNull();
    expect(lookPreviewSourceFromRenderData(RENDER_DATA, { layoutId: 9, versionId: 'local-x' })).toBeNull();
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

describe('local photo URIs', () => {
  it('puts the scheme back on a native cache path and keeps a browser URL', () => {
    expect(cachedPhotoUri('/data/cache/spray-walls/9-v3.jpg')).toBe('file:///data/cache/spray-walls/9-v3.jpg');
    expect(cachedPhotoUri('https://private.example/photo.jpg')).toBe('https://private.example/photo.jpg');
    expect(cachedPhotoUri(null)).toBeNull();
  });

  it('counts only file:/// URIs as local', () => {
    expect(isLocalFileUri('file:///data/cache/spray-walls/9-v3.jpg')).toBe(true);
    expect(isLocalFileUri('https://private.example/photo.jpg')).toBe(false);
    expect(isLocalFileUri('file://host/photo.jpg')).toBe(false);
    expect(isLocalFileUri(null)).toBe(false);
  });
});

describe('lookPreviewMaskSvgDataUri', () => {
  it('is the same two strokes as the native mask, as an SVG document', () => {
    const mask = { path: 'M1 1L5 1L1 5Z', grow: 1, feather: 2 };
    const uri = lookPreviewMaskSvgDataUri(mask, { width: 110, height: 83 });
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('width="110" height="83" viewBox="0 0 110 83"');
    expect(svg.match(/<path d="M1 1L5 1L1 5Z"/g)).toHaveLength(2);
    expect(svg).toContain('stroke-opacity="0.4" stroke-width="6"');
    expect(svg).toContain('stroke-width="2" stroke-linejoin="round"/></svg>');
  });
});
