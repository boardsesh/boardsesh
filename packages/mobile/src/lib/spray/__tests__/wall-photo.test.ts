import { describe, expect, it, vi } from 'vitest';

// Only the two pure helpers are under test here; the picker and the native image
// manipulator are stubbed so the module loads outside a React Native runtime.
vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
}));
vi.mock('../../image-compression', () => ({ compressPickedImage: vi.fn() }));
import { WALL_PHOTO_MAX_DIMENSION, predictCompressedSize, rescalePoint } from '../wall-photo';

describe('predictCompressedSize', () => {
  it('leaves a photo that is already small enough alone', () => {
    expect(predictCompressedSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
  });

  it('constrains the long edge of a landscape photo', () => {
    expect(predictCompressedSize(4032, 3024)).toEqual({ width: WALL_PHOTO_MAX_DIMENSION, height: 1536 });
  });

  it('constrains the long edge of a portrait photo', () => {
    expect(predictCompressedSize(3024, 4032)).toEqual({ width: 1536, height: WALL_PHOTO_MAX_DIMENSION });
  });

  it('answers something usable for a photo whose size the picker could not report', () => {
    expect(predictCompressedSize(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe('rescalePoint', () => {
  it('carries an anchor from the local file onto the stored photo', () => {
    expect(rescalePoint([100, 50], { width: 1000, height: 500 }, { width: 2000, height: 1000 })).toEqual([200, 100]);
  });

  it('is the identity when the two photos match', () => {
    expect(rescalePoint([12, 34], { width: 800, height: 600 }, { width: 800, height: 600 })).toEqual([12, 34]);
  });

  it('refuses to divide by a photo with no size', () => {
    expect(rescalePoint([12, 34], { width: 0, height: 0 }, { width: 800, height: 600 })).toEqual([12, 34]);
  });
});
