// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const ctrl = vi.hoisted(() => ({
  os: 'ios' as string,
  glass: true,
  glassApi: true,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
}));

vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => ctrl.glass,
  isGlassEffectAPIAvailable: () => ctrl.glassApi,
}));

import { useGlassCapability } from '../use-glass-capability';

beforeEach(() => {
  ctrl.os = 'ios';
  ctrl.glass = true;
  ctrl.glassApi = true;
});

describe('useGlassCapability', () => {
  it('returns true on iOS 26+ when both APIs are available', () => {
    const { result } = renderHook(() => useGlassCapability());
    expect(result.current).toBe(true);
  });

  it('returns false on Android', () => {
    ctrl.os = 'android';
    const { result } = renderHook(() => useGlassCapability());
    expect(result.current).toBe(false);
  });

  it('returns false when isLiquidGlassAvailable returns false', () => {
    ctrl.glass = false;
    const { result } = renderHook(() => useGlassCapability());
    expect(result.current).toBe(false);
  });

  it('returns false when isGlassEffectAPIAvailable returns false', () => {
    ctrl.glassApi = false;
    const { result } = renderHook(() => useGlassCapability());
    expect(result.current).toBe(false);
  });
});
