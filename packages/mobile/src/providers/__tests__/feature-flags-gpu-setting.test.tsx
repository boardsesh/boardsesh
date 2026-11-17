// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

const capability = vi.hoisted(() => ({ apiVersion: 6 }));
vi.mock('../../lib/board-render/gpu-native-capability', () => ({
  get climbOverlayGpuApiVersion() {
    return capability.apiVersion;
  },
}));

import {
  FeatureFlagsProvider,
  useGpuAccelerationSettingOffered,
  useGpuClimbOverlayEnabled,
} from '../feature-flags-provider';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '../../settings';

function withFlag(flag: boolean | undefined) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flag === undefined ? {} : { 'aura-gpu-enabled': flag }}>
      {children}
    </FeatureFlagsProvider>
  );
}

afterEach(() => {
  setSetting('gpuAcceleration', DEFAULT_SETTINGS.gpuAcceleration);
  capability.apiVersion = 6;
});

describe('GPU acceleration setting', () => {
  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.gpuAcceleration).toBe(true);
    expect(getSetting('gpuAcceleration')).toBe(true);
  });

  it('reads the stored choice on the first render and reaches a mounted consumer in both directions', () => {
    setSetting('gpuAcceleration', false);
    const { result } = renderHook(() => useGpuClimbOverlayEnabled('kilter', 8), { wrapper: withFlag(undefined) });
    expect(result.current).toBe(false);
    act(() => setSetting('gpuAcceleration', true));
    expect(result.current).toBe(true);
    act(() => setSetting('gpuAcceleration', false));
    expect(result.current).toBe(false);
  });

  it('cannot force the GPU on past the remote kill switch', () => {
    const { result } = renderHook(() => useGpuClimbOverlayEnabled('kilter', 8), { wrapper: withFlag(false) });
    expect(result.current).toBe(false);
  });
});

describe('useGpuAccelerationSettingOffered', () => {
  it('is offered with the native module and no kill switch', () => {
    expect(renderHook(() => useGpuAccelerationSettingOffered(), { wrapper: withFlag(undefined) }).result.current).toBe(
      true,
    );
    expect(renderHook(() => useGpuAccelerationSettingOffered(), { wrapper: withFlag(true) }).result.current).toBe(true);
  });

  it('is hidden without the native module', () => {
    capability.apiVersion = 0;
    expect(renderHook(() => useGpuAccelerationSettingOffered(), { wrapper: withFlag(true) }).result.current).toBe(
      false,
    );
  });

  it('is hidden while the remote kill switch is off', () => {
    expect(renderHook(() => useGpuAccelerationSettingOffered(), { wrapper: withFlag(false) }).result.current).toBe(
      false,
    );
  });
});
