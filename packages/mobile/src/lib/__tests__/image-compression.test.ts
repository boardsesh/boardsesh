import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeImageRef = {
  width: number;
  height: number;
  saveAsync: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};
type FakeContext = { source: string | FakeImageRef; resizes: Array<{ width?: number; height?: number }> };

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
vi.mock('react-native', () => ({ Platform: platform }));

const manipulator = vi.hoisted(() => ({
  contexts: [] as FakeContext[],
  refs: [] as FakeImageRef[],
  /** The upright size the "native" decode reports for the picked file. */
  decodedSize: { width: 0, height: 0 },
}));

vi.mock('expo-image-manipulator', () => {
  function makeRef(width: number, height: number): FakeImageRef {
    const ref = {
      width,
      height,
      saveAsync: vi.fn(async () => ({ uri: `file:///out-${width}x${height}.jpg` })),
      release: vi.fn(),
    };
    manipulator.refs.push(ref);
    return ref;
  }
  return {
    SaveFormat: { JPEG: 'jpeg' },
    ImageManipulator: {
      manipulate(source: string | FakeImageRef) {
        const context: FakeContext = { source, resizes: [] };
        manipulator.contexts.push(context);
        return {
          resize(size: { width?: number; height?: number }) {
            context.resizes.push(size);
            return this;
          },
          async renderAsync() {
            const start =
              typeof source === 'string' ? manipulator.decodedSize : { width: source.width, height: source.height };
            const resize = context.resizes.at(-1);
            if (!resize) return makeRef(start.width, start.height);
            const scale = resize.width ? resize.width / start.width : (resize.height ?? start.height) / start.height;
            return makeRef(Math.round(start.width * scale), Math.round(start.height * scale));
          },
        };
      },
    },
  };
});

const { compressPickedImageWithSize } = await import('../image-compression');

beforeEach(() => {
  platform.OS = 'android';
  manipulator.contexts.length = 0;
  manipulator.refs.length = 0;
});

describe('compressPickedImageWithSize', () => {
  it('re-encodes a photo already inside the cap in one pass, with no resize', async () => {
    manipulator.decodedSize = { width: 4032, height: 3024 };
    const result = await compressPickedImageWithSize('file:///in.jpg', 4032, 3024, {
      maxDimension: 5712,
      quality: 0.92,
    });
    expect(manipulator.contexts).toHaveLength(1);
    expect(manipulator.contexts[0].resizes).toEqual([]);
    expect(result).toEqual({ uri: 'file:///out-4032x3024.jpg', width: 4032, height: 3024 });
  });

  it('sizes a portrait photo by its upright height even when the picker reported it landscape', async () => {
    // The picker says 8064x6048 (the sensor's numbers); the decoded photo is upright.
    manipulator.decodedSize = { width: 6048, height: 8064 };
    const result = await compressPickedImageWithSize('file:///in.jpg', 8064, 6048, {
      maxDimension: 5712,
      quality: 0.92,
    });
    expect(manipulator.contexts[1].resizes).toEqual([{ height: 5712 }]);
    expect(result.height).toBe(5712);
    expect(result.width * result.height).toBeLessThanOrEqual(5712 * 4284 + 5712);
  });

  it('resizes the long side of a landscape photo', async () => {
    manipulator.decodedSize = { width: 8064, height: 6048 };
    const result = await compressPickedImageWithSize('file:///in.jpg', 8064, 6048, {
      maxDimension: 5712,
      quality: 0.92,
    });
    expect(manipulator.contexts[1].resizes).toEqual([{ width: 5712 }]);
    expect(result).toMatchObject({ width: 5712, height: 4284 });
  });

  it('releases the upright full-size bitmap once the resized one is saved', async () => {
    manipulator.decodedSize = { width: 6048, height: 8064 };
    await compressPickedImageWithSize('file:///in.jpg', 8064, 6048, { maxDimension: 5712, quality: 0.92 });
    expect(manipulator.refs).toHaveLength(2);
    for (const ref of manipulator.refs) expect(ref.release).toHaveBeenCalledTimes(1);
  });

  it('falls back to the picker size when the decode reports none', async () => {
    manipulator.decodedSize = { width: 0, height: 0 };
    await compressPickedImageWithSize('file:///in.jpg', 3024, 8064, { maxDimension: 5712, quality: 0.92 });
    expect(manipulator.contexts[1].resizes).toEqual([{ height: 5712 }]);
  });

  it('keeps iOS to one pass sized by the picker, which reports the upright size there', async () => {
    // A second iOS pass would redraw the full upright bitmap (ImageFixOrientationTransformer).
    platform.OS = 'ios';
    manipulator.decodedSize = { width: 6048, height: 8064 };
    const result = await compressPickedImageWithSize('file:///in.jpg', 6048, 8064, {
      maxDimension: 5712,
      quality: 0.92,
    });
    expect(manipulator.contexts).toHaveLength(1);
    expect(manipulator.contexts[0].resizes).toEqual([{ height: 5712 }]);
    expect(result).toMatchObject({ width: 4284, height: 5712 });
  });
});
