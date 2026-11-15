import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  os: 'android',
  version: 33,
  present: true,
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
  requireOptionalNativeModule: () => (native.present ? {} : null),
  requireNativeViewManager: native.resolve,
}));

afterEach(() => {
  vi.resetModules();
  native.resolve.mockClear();
  native.present = true;
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

  it('keeps older native binaries on the fallback', async () => {
    native.os = 'android';
    native.version = 33;
    native.present = false;
    const { NativeFrostedBokehGPU } = await import('../../../modules/frosted-bokeh-gpu/src/index');
    expect(NativeFrostedBokehGPU).toBeNull();
    expect(native.resolve).not.toHaveBeenCalled();
  });
});
