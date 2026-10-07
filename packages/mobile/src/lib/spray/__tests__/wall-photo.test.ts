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
const compressPickedImageWithSize = vi.hoisted(() => vi.fn());
vi.mock('../../image-compression', () => ({ compressPickedImageWithSize }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('../../error-reporting', () => ({ reportError }));

/**
 * A recorder for `expo-image-manipulator`: every `manipulate` call keeps its
 * source and the operations chained onto it, and renders to whatever the test
 * says that source renders to (or throws, for a source that cannot be read).
 */
type ManipulateCall = { source: string; ops: [string, unknown][] };
const manipulator = vi.hoisted(() => ({
  calls: [] as { source: string; ops: [string, unknown][] }[],
  renders: new Map<string, { width: number; height: number } | Error>(),
}));
vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (source: string) => {
      const call: ManipulateCall = { source, ops: [] };
      manipulator.calls.push(call);
      const context = {
        rotate: (degrees: number) => (call.ops.push(['rotate', degrees]), context),
        crop: (rect: unknown) => (call.ops.push(['crop', rect]), context),
        resize: (size: unknown) => (call.ops.push(['resize', size]), context),
        renderAsync: async () => {
          const rendered = manipulator.renders.get(source) ?? { width: 0, height: 0 };
          if (rendered instanceof Error) throw rendered;
          return {
            width: rendered.width,
            height: rendered.height,
            saveAsync: async () => ({ uri: `${source}.rendered.jpg` }),
            release: vi.fn(),
          };
        },
      };
      return context;
    },
  },
}));

import {
  WALL_PHOTO_MAX_DIMENSION,
  WALL_PHOTO_QUALITY,
  pickWallPhotoFromCamera,
  pickWallPhotoFromLibrary,
  predictCompressedSize,
  renderRotatedPreview,
  renderWallPhotoEdit,
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
  compressPickedImageWithSize.mockReset().mockResolvedValue({ uri: 'file:///wall.jpg', width: 4032, height: 3024 });
  reportError.mockReset();
  manipulator.calls.length = 0;
  manipulator.renders.clear();
});

/**
 * What the pickers answer for `pickedAsset`: a 12 MP photo is under the cap, so
 * the base keeps its size, and the base is the upload until it is edited.
 */
const PICKED_PHOTO = {
  uri: 'file:///wall.jpg',
  width: 4032,
  height: 3024,
  base: { uri: 'file:///wall.jpg', width: 4032, height: 3024 },
  original: { uri: 'file:///wall.heic', longSide: 4032 },
  edit: null,
};

/** A photo picked from a capture of `longSide` px, which the compressor shrank to 4096 x 3072. */
function shrunkPhoto(name: string, longSide: number) {
  const base = { uri: `file:///${name}.jpg`, width: 4096, height: 3072 };
  return { ...base, base, original: { uri: `file:///${name}.heic`, longSide }, edit: null };
}

/** A 24 MP capture (5712 x 4284), the default on recent flagship phones. */
const PHOTO_24MP = shrunkPhoto('wall-24mp', 5712);
/** A 48 MP capture (8064 x 6048): about 195 MB decoded, so the render reads its base. */
const PHOTO_48MP = shrunkPhoto('wall-48mp', 8064);

describe('pickWallPhotoFromLibrary', () => {
  // The system picker hands back only the chosen photo and needs no permission
  // (#5957). Asking first put a whole-library prompt in front of the picker, and
  // a climber who refused it could not add a wall at all.
  it('opens the library without asking for photo library access', async () => {
    const result = await pickWallPhotoFromLibrary();

    expect(result).toEqual({ outcome: 'picked', photo: PICKED_PHOTO });
    expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith({ mediaTypes: ['images'], quality: 1 });
    expect(compressPickedImageWithSize).toHaveBeenCalledWith('file:///wall.heic', 4032, 3024, {
      maxDimension: WALL_PHOTO_MAX_DIMENSION,
      quality: WALL_PHOTO_QUALITY,
    });
  });

  it('answers cancelled when the climber backs out of the picker', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });

    expect(await pickWallPhotoFromLibrary()).toEqual({ outcome: 'cancelled' });
    expect(compressPickedImageWithSize).not.toHaveBeenCalled();
  });
});

describe('pickWallPhotoFromCamera', () => {
  it('still asks for the camera, and answers denied without opening it when refused', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });

    expect(await pickWallPhotoFromCamera()).toEqual({ outcome: 'denied' });
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('photographs the wall once the camera is allowed', async () => {
    expect(await pickWallPhotoFromCamera()).toEqual({ outcome: 'picked', photo: PICKED_PHOTO });
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

describe('the picked photo size', () => {
  it('trusts the rendered size over the picker, which can ignore EXIF orientation', () => {
    // An Android picker reporting the sensor's landscape numbers for a portrait
    // photo: the compressor baked the orientation in, and its render says so.
    compressPickedImageWithSize.mockResolvedValue({ uri: 'file:///wall.jpg', width: 3024, height: 4032 });
    return expect(pickWallPhotoFromLibrary()).resolves.toMatchObject({
      photo: { width: 3024, height: 4032, base: { width: 3024, height: 4032 } },
    });
  });

  it('falls back to the prediction when the render could not report a size', async () => {
    compressPickedImageWithSize.mockResolvedValue({ uri: 'file:///wall.jpg', width: 0, height: 0 });
    const result = await pickWallPhotoFromLibrary();
    expect(result).toMatchObject({ photo: { width: 4032, height: 3024 } });
  });
});

describe('renderWallPhotoEdit', () => {
  const CROP_AND_TURN = { quarterTurns: 1 as const, crop: { left: 0, top: 0, right: 1, bottom: 0.5 } };

  it('renders nothing for the identity edit: the base is that photo', async () => {
    const edited = { ...PICKED_PHOTO, uri: 'file:///old-edit.jpg', width: 900, height: 900 };
    expect(
      await renderWallPhotoEdit(edited, { quarterTurns: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } }),
    ).toEqual(PICKED_PHOTO.base);
    expect(manipulator.calls).toHaveLength(0);
  });

  it('renders from the original in one pass and takes its size from the rendered image', async () => {
    // The plan expects 4096 x 2731; the native render is the authority.
    manipulator.renders.set('file:///wall-24mp.heic', { width: 4096, height: 2732 });
    const result = await renderWallPhotoEdit(PHOTO_24MP, CROP_AND_TURN);

    expect(result).toEqual({ uri: 'file:///wall-24mp.heic.rendered.jpg', width: 4096, height: 2732 });
    expect(manipulator.calls).toHaveLength(1);
    expect(manipulator.calls[0].source).toBe('file:///wall-24mp.heic');
    // Turned, the original is 4283 x 5712 (the short side derived as a lower
    // bound); its top half is still past the cap, so it shrinks to 4096 across.
    expect(manipulator.calls[0].ops).toEqual([
      ['rotate', 90],
      ['crop', { originX: 0, originY: 0, width: 4283, height: 2856 }],
      ['resize', { width: WALL_PHOTO_MAX_DIMENSION }],
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("keeps a 12 MP photo's own pixels: under the cap, nothing is resized", async () => {
    manipulator.renders.set('file:///wall.heic', { width: 3024, height: 2016 });
    await renderWallPhotoEdit(PICKED_PHOTO, CROP_AND_TURN);
    expect(manipulator.calls.map((call) => call.source)).toEqual(['file:///wall.heic']);
    expect(manipulator.calls[0].ops).toEqual([
      ['rotate', 90],
      ['crop', { originX: 0, originY: 0, width: 3024, height: 2016 }],
    ]);
  });

  it('falls back to the base when the original will not render', async () => {
    manipulator.renders.set('file:///wall-24mp.heic', new Error('out of memory'));
    manipulator.renders.set('file:///wall-24mp.jpg', { width: 3072, height: 2048 });
    const result = await renderWallPhotoEdit(PHOTO_24MP, CROP_AND_TURN);

    expect(result).toEqual({ uri: 'file:///wall-24mp.jpg.rendered.jpg', width: 3072, height: 2048 });
    expect(manipulator.calls.map((call) => call.source)).toEqual(['file:///wall-24mp.heic', 'file:///wall-24mp.jpg']);
    // The same edit, planned against the base's own size: already under the
    // cap, so no resize.
    expect(manipulator.calls[1].ops).toEqual([
      ['rotate', 90],
      ['crop', { originX: 0, originY: 0, width: 3072, height: 2048 }],
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('reads the base, not the original, when the original is too big to decode safely', async () => {
    manipulator.renders.set('file:///wall-48mp.jpg', { width: 3072, height: 2048 });
    await renderWallPhotoEdit(PHOTO_48MP, CROP_AND_TURN);
    expect(manipulator.calls.map((call) => call.source)).toEqual(['file:///wall-48mp.jpg']);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('falls back to the planned size when the platform reports none', async () => {
    const result = await renderWallPhotoEdit(PICKED_PHOTO, CROP_AND_TURN);
    expect(result.width).toBeGreaterThan(0);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(WALL_PHOTO_MAX_DIMENSION);
  });
});

describe('renderRotatedPreview', () => {
  it('is the base itself with no turn', async () => {
    expect(await renderRotatedPreview(PICKED_PHOTO.base, 0)).toBe('file:///wall.jpg');
    expect(manipulator.calls).toHaveLength(0);
  });

  it('turns the base and keeps the preview small', async () => {
    manipulator.renders.set('file:///wall.jpg', { width: 1200, height: 1600 });
    expect(await renderRotatedPreview(PICKED_PHOTO.base, 3)).toBe('file:///wall.jpg.rendered.jpg');
    expect(manipulator.calls[0].ops).toEqual([
      ['rotate', 270],
      ['resize', { height: 1600 }],
    ]);
  });
});
