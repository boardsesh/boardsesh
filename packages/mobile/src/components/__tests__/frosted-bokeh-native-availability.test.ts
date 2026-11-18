import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  os: 'android',
  version: 33,
  present: true,
  swapFrameApi: undefined as unknown,
  resolve: vi.fn(() => 'NativeFrostedBokehGPU'),
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
    get Version() {
      return native.version;
    },
  },
}));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => (native.present ? { swapFrameApi: native.swapFrameApi } : null),
  requireNativeViewManager: native.resolve,
}));

afterEach(() => {
  vi.resetModules();
  native.resolve.mockClear();
  native.present = true;
  native.swapFrameApi = undefined;
});

describe('native frost availability', () => {
  it.each([
    ['android', 32, false],
    ['android', 33, true],
    ['android', 36, true],
    ['ios', 26, true],
    ['web', 33, false],
  ] as const)('%s %s resolves the renderer only when supported', async (os, version, supported) => {
    native.os = os;
    native.version = version;
    const { NativeFrostedBokehGPU } = await import('../../../modules/frosted-bokeh-gpu/src/index');
    expect(NativeFrostedBokehGPU !== null).toBe(supported);
    expect(native.resolve).toHaveBeenCalledTimes(supported ? 1 : 0);
  });

  it.each([
    [1, 1],
    [undefined, 0],
    ['1', 0],
    [0, 0],
  ] as const)('reads swapFrameApi %s as %s, so only newer binaries get the board frames', async (constant, api) => {
    native.os = 'ios';
    native.swapFrameApi = constant;
    const { frostedBokehSwapFrameApi } = await import('../../../modules/frosted-bokeh-gpu/src/index');
    expect(frostedBokehSwapFrameApi).toBe(api);
  });

  it('reads no swap-frame API where the renderer is not resolved', async () => {
    native.os = 'android';
    native.version = 32;
    native.swapFrameApi = 1;
    const { frostedBokehSwapFrameApi } = await import('../../../modules/frosted-bokeh-gpu/src/index');
    expect(frostedBokehSwapFrameApi).toBe(0);
  });

  it('keeps older native binaries on the fallback', async () => {
    native.os = 'android';
    native.version = 33;
    native.present = false;
    const { NativeFrostedBokehGPU } = await import('../../../modules/frosted-bokeh-gpu/src/index');
    expect(NativeFrostedBokehGPU).toBeNull();
    expect(native.resolve).not.toHaveBeenCalled();
  });
});
