import type { ClimbOverlayGPUComparison } from '../../../modules/climb-overlay-gpu/src';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  platform: 'ios' as 'ios' | 'android',
  nativeModule: null as null | { apiVersion?: number; compare?: ReturnType<typeof vi.fn> },
  requireView: vi.fn(() => 'ClimbOverlayGPUView'),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return controls.platform;
    },
  },
}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => controls.nativeModule,
  requireNativeViewManager: controls.requireView,
}));

describe.each(['ios', 'android'] as const)('%s GPU binary capability', (platform) => {
  beforeEach(() => {
    vi.resetModules();
    controls.platform = platform;
    controls.nativeModule = null;
    controls.requireView.mockClear();
  });

  it('keeps the native view absent on binaries without the module', async () => {
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeFrameClimbOverlayGPU).toBeNull();
    expect(module.NativeClimbOverlayGPU).toBeNull();
    expect(module.NativeMotionClimbOverlayGPU).toBeNull();
    expect(module.compareClimbOverlayGPU).toBeNull();
    expect(controls.requireView).not.toHaveBeenCalled();
  });

  it('keeps the legacy story available but rejects frame updates on v1', async () => {
    controls.nativeModule = { compare: vi.fn() };
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeClimbOverlayGPU).not.toBeNull();
    expect(module.NativeFrameClimbOverlayGPU).toBeNull();
    expect(controls.requireView).toHaveBeenCalledTimes(1);
  });

  it('allows separate frame props only when native explicitly supports v2', async () => {
    controls.nativeModule = { apiVersion: 2, compare: vi.fn() };
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeFrameClimbOverlayGPU).not.toBeNull();
    expect(module.NativeMotionClimbOverlayGPU).toBeNull();
    expect(controls.requireView).toHaveBeenCalledWith('ClimbOverlayGPU');
  });

  it('keeps live surfaces on PNG for the simulator legacy capability', async () => {
    controls.nativeModule = { apiVersion: 1, compare: vi.fn() };
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeClimbOverlayGPU).not.toBeNull();
    expect(module.NativeFrameClimbOverlayGPU).toBeNull();
    expect(module.NativeMotionClimbOverlayGPU).toBeNull();
  });

  it('allows scrubbed and editor motion only when native supports v3', async () => {
    controls.nativeModule = { apiVersion: 3, compare: vi.fn() };
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeMotionClimbOverlayGPU).not.toBeNull();
  });

  it('keeps comparison unavailable on a live-rendering binary without diagnostic readback', async () => {
    controls.nativeModule = { apiVersion: 3 };
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeMotionClimbOverlayGPU).not.toBeNull();
    expect(module.compareClimbOverlayGPU).toBeNull();
  });

  it('preserves unavailable GPU timing in the native comparison result', async () => {
    const result: ClimbOverlayGPUComparison = {
      width: 32,
      height: 32,
      maxChannelError: 0,
      rmse: 0,
      pixelsOverOne: 0,
      cpuRenderMs: 3,
      gpuMs: null,
      prepareMs: 2,
      uploadMs: 1,
      atlasBytes: 4096,
      atlasCacheHit: true,
      gpuUri: 'file:///gpu.png',
      referenceUri: 'file:///reference.png',
    };
    const compare = vi.fn().mockResolvedValue(result);
    controls.nativeModule = { apiVersion: 3, compare };
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(await module.compareClimbOverlayGPU?.('config')).toBe(result);
    expect(compare).toHaveBeenCalledWith('config');
    expect(compare.mock.contexts[0]).toBe(controls.nativeModule);
  });
});
