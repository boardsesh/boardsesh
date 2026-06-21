// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const ctrl = vi.hoisted(() => ({
  os: 'ios' as string,
  glass: true,
  glassApi: true,
  rt: false,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
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

vi.mock('../use-reduce-transparency', () => ({
  useReduceTransparency: () => ctrl.rt,
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant }),
}));

import { useEffectiveSurfaceMode } from '../use-effective-surface-mode';

beforeEach(() => {
  ctrl.os = 'ios';
  ctrl.glass = true;
  ctrl.glassApi = true;
  ctrl.rt = false;
  ctrl.variant = 'liquidGlass';
});

describe('useEffectiveSurfaceMode', () => {
  it('returns glass on iOS 26+ with Liquid Glass available', () => {
    const { result } = renderHook(() => useEffectiveSurfaceMode());
    expect(result.current).toBe('glass');
  });

  it('returns solid when Reduce Transparency is enabled (a11y wins over everything)', () => {
    ctrl.rt = true;
    const { result } = renderHook(() => useEffectiveSurfaceMode());
    expect(result.current).toBe('solid');
  });

  it('returns material when the Material variant is active', () => {
    ctrl.variant = 'material';
    const { result } = renderHook(() => useEffectiveSurfaceMode());
    expect(result.current).toBe('material');
  });

  it('returns solid when Reduce Transparency wins over the Material variant', () => {
    ctrl.variant = 'material';
    ctrl.rt = true;
    const { result } = renderHook(() => useEffectiveSurfaceMode());
    expect(result.current).toBe('solid');
  });

  it('returns blur on iOS when Liquid Glass is unavailable', () => {
    ctrl.glass = false;
    const { result } = renderHook(() => useEffectiveSurfaceMode());
    expect(result.current).toBe('blur');
  });

  it('returns blur on iOS when the glass-effect API check fails', () => {
    ctrl.glassApi = false;
    const { result } = renderHook(() => useEffectiveSurfaceMode());
    expect(result.current).toBe('blur');
  });

  it('returns solid on Android (no glass, no blur)', () => {
    ctrl.os = 'android';
    // glass/glassApi are irrelevant here — the hook short-circuits on Platform.OS before calling them
    const { result } = renderHook(() => useEffectiveSurfaceMode());
    expect(result.current).toBe('solid');
  });
});
