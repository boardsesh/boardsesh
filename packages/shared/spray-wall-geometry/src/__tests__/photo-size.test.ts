// The wall photo size rule shared by the app's upload and the server's full copy.
import { describe, expect, it } from 'vite-plus/test';
import { SPRAY_WALL_PHOTO_MAX_LONG_SIDE, SPRAY_WALL_PHOTO_MAX_PIXELS, sprayWallPhotoMaxLongSide } from '../photo-size';

/** Android's `RecordingCanvas` refuses to draw a bitmap larger than this. */
const ANDROID_MAX_BITMAP_BYTES = 100 * 1024 * 1024;

/** The size a resize to `maxLongSide` leaves a photo at, rounding the short side as the resizers do. */
function resized(width: number, height: number): { width: number; height: number } {
  const cap = sprayWallPhotoMaxLongSide(width, height);
  const long = Math.max(width, height);
  if (long <= cap) return { width, height };
  const scale = cap / long;
  return width >= height
    ? { width: cap, height: Math.round(height * scale) }
    : { width: Math.round(width * scale), height: cap };
}

describe('sprayWallPhotoMaxLongSide', () => {
  it('lets a 24 MP phone photo through unscaled', () => {
    expect(SPRAY_WALL_PHOTO_MAX_LONG_SIDE).toBe(5712);
    expect(sprayWallPhotoMaxLongSide(5712, 4284)).toBe(5712);
    expect(sprayWallPhotoMaxLongSide(4284, 5712)).toBe(5712);
    expect(resized(5712, 4284)).toEqual({ width: 5712, height: 4284 });
  });

  it('caps a 48 MP 4:3 photo at the 24 MP size', () => {
    expect(resized(8064, 6048)).toEqual({ width: 5712, height: 4284 });
  });

  it('caps a wide photo by its long side alone', () => {
    // 3:2 is under the pixel cap at 5712 across.
    expect(sprayWallPhotoMaxLongSide(6000, 4000)).toBe(5712);
    expect(resized(6000, 4000)).toEqual({ width: 5712, height: 3808 });
  });

  it('shrinks a square photo below the long-side cap to stay under the pixel cap', () => {
    // 5712 x 5712 would be 130 MB decoded, over Android's limit.
    expect(sprayWallPhotoMaxLongSide(6000, 6000)).toBe(4946);
    expect(sprayWallPhotoMaxLongSide(6144, 6144)).toBe(4946);
    expect(resized(6000, 6000)).toEqual({ width: 4946, height: 4946 });
  });

  it('only reads the shape, so orientation does not change the answer', () => {
    expect(sprayWallPhotoMaxLongSide(4000, 5000)).toBe(sprayWallPhotoMaxLongSide(5000, 4000));
  });

  it('keeps every shape under the pixel cap and Android bitmap limit', () => {
    const aspects = [1, 1.05, 1.1, 1.2, 1.25, 4 / 3, 1.5, 16 / 9, 2, 3];
    for (const aspect of aspects) {
      for (const long of [5000, 5712, 6000, 8064, 12000]) {
        const size = resized(long, Math.round(long / aspect));
        const pixels = size.width * size.height;
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(SPRAY_WALL_PHOTO_MAX_LONG_SIDE);
        // Rounding the short side may add at most half a row.
        expect(pixels).toBeLessThanOrEqual(SPRAY_WALL_PHOTO_MAX_PIXELS + SPRAY_WALL_PHOTO_MAX_LONG_SIDE / 2);
        expect(pixels * 4).toBeLessThan(ANDROID_MAX_BITMAP_BYTES);
      }
    }
  });

  it('answers the long-side cap for a size it cannot read', () => {
    expect(sprayWallPhotoMaxLongSide(0, 0)).toBe(5712);
    expect(sprayWallPhotoMaxLongSide(Number.NaN, 3000)).toBe(5712);
    expect(sprayWallPhotoMaxLongSide(4000, -1)).toBe(5712);
    expect(sprayWallPhotoMaxLongSide(Number.POSITIVE_INFINITY, 3000)).toBe(5712);
  });
});
