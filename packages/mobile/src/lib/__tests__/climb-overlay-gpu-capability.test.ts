import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  nativeModule: null as null | { apiVersion?: number; compare: ReturnType<typeof vi.fn> },
  requireView: vi.fn(() => 'ClimbOverlayGPUView'),
}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => controls.nativeModule,
  requireNativeViewManager: controls.requireView,
}));

describe('GPU frame-update binary capability', () => {
  beforeEach(() => {
    vi.resetModules();
    controls.nativeModule = null;
    controls.requireView.mockClear();
  });

  it('keeps the native view absent on binaries without the module', async () => {
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeFrameClimbOverlayGPU).toBeNull();
    expect(module.NativeClimbOverlayGPU).toBeNull();
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

  it('allows scrubbed and editor motion only when native supports v3', async () => {
    controls.nativeModule = { apiVersion: 3, compare: vi.fn() };
    const module = await import('../../../modules/climb-overlay-gpu/src');
    expect(module.NativeMotionClimbOverlayGPU).not.toBeNull();
  });
});
