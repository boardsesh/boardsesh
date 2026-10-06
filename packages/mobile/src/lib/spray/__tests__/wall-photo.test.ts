import { beforeEach, describe, expect, it, vi } from 'vitest';

// The picker and the native image manipulator are stubbed so the module loads
// outside a React Native runtime.
const picker = vi.hoisted(() => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
}));
vi.mock('expo-image-picker', () => picker);
const compressPickedImage = vi.hoisted(() => vi.fn());
vi.mock('../../image-compression', () => ({ compressPickedImage }));
import {
  WALL_PHOTO_MAX_DIMENSION,
  WALL_PHOTO_QUALITY,
  pickWallPhotoFromCamera,
  pickWallPhotoFromLibrary,
  predictCompressedSize,
  rescalePoint,
} from '../wall-photo';

const pickedAsset = { uri: 'file:///wall.heic', width: 4032, height: 3024 };

beforeEach(() => {
  // A spy only: the library pick must never ask. It answers "denied" so a
  // request that came back would also block the pick, not just trip the count.
  picker.requestMediaLibraryPermissionsAsync.mockReset().mockResolvedValue({ granted: false });
  picker.requestCameraPermissionsAsync.mockReset().mockResolvedValue({ granted: true });
  picker.launchImageLibraryAsync.mockReset().mockResolvedValue({ canceled: false, assets: [pickedAsset] });
  picker.launchCameraAsync.mockReset().mockResolvedValue({ canceled: false, assets: [pickedAsset] });
  compressPickedImage.mockReset().mockResolvedValue('file:///wall.jpg');
});

describe('pickWallPhotoFromLibrary', () => {
  // The system picker hands back only the chosen photo and needs no permission
  // (#5957). Asking first put a whole-library prompt in front of the picker, and
  // a climber who refused it could not add a wall at all.
  it('opens the library without asking for photo library access', async () => {
    const result = await pickWallPhotoFromLibrary();

    expect(result).toEqual({
      outcome: 'picked',
      photo: { uri: 'file:///wall.jpg', width: 4032, height: 3024 },
    });
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith({ mediaTypes: ['images'], quality: 1 });
    expect(compressPickedImage).toHaveBeenCalledWith('file:///wall.heic', 4032, 3024, {
      maxDimension: WALL_PHOTO_MAX_DIMENSION,
      quality: WALL_PHOTO_QUALITY,
    });
  });

  it('answers cancelled when the climber backs out of the picker', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });

    expect(await pickWallPhotoFromLibrary()).toEqual({ outcome: 'cancelled' });
    expect(compressPickedImage).not.toHaveBeenCalled();
  });
});

describe('pickWallPhotoFromCamera', () => {
  it('still asks for the camera, and answers denied without opening it when refused', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });

    expect(await pickWallPhotoFromCamera()).toEqual({ outcome: 'denied' });
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('photographs the wall once the camera is allowed', async () => {
    expect(await pickWallPhotoFromCamera()).toEqual({
      outcome: 'picked',
      photo: { uri: 'file:///wall.jpg', width: 4032, height: 3024 },
    });
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('predictCompressedSize', () => {
  it('leaves a photo that is already small enough alone', () => {
    expect(predictCompressedSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
  });

  // #5911: the server keeps its own 2048 px base and stores this larger copy
  // beside it for the hold editor's deep zoom, so a 12 MP phone photo goes up
  // whole instead of being thrown down to 2048 on the phone.
  it('keeps a 12 MP phone photo at its full size', () => {
    expect(WALL_PHOTO_MAX_DIMENSION).toBe(4096);
    expect(predictCompressedSize(4032, 3024)).toEqual({ width: 4032, height: 3024 });
  });

  it('constrains the long edge of a landscape photo', () => {
    expect(predictCompressedSize(6000, 4000)).toEqual({ width: WALL_PHOTO_MAX_DIMENSION, height: 2731 });
  });

  it('constrains the long edge of a portrait photo', () => {
    expect(predictCompressedSize(4000, 6000)).toEqual({ width: 2731, height: WALL_PHOTO_MAX_DIMENSION });
  });

  it('still honours a smaller cap when one is asked for', () => {
    expect(predictCompressedSize(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
  });

  it('answers zero for a photo whose size the picker could not report', () => {
    expect(predictCompressedSize(0, 0)).toEqual({ width: 0, height: 0 });
    expect(predictCompressedSize(-1, 100)).toEqual({ width: 0, height: 0 });
  });

  it('never lets a NaN dimension out', () => {
    // A NaN flowing on would make every anchor and every rescaled candidate NaN
    // too, which draws nothing and reports nothing.
    expect(predictCompressedSize(Number.NaN, 1200)).toEqual({ width: 0, height: 0 });
    expect(predictCompressedSize(1600, Number.NaN)).toEqual({ width: 0, height: 0 });
    expect(predictCompressedSize(Number.POSITIVE_INFINITY, 1200)).toEqual({ width: 0, height: 0 });
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
