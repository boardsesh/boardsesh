// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// `Platform.isPad` is launch-fixed, and the screen dimensions are read once via
// `Dimensions.get('screen')`, so both are driven directly rather than through a
// real react-native runtime.
const platform = vi.hoisted(() => ({ OS: 'ios' as string, isPad: true as boolean }));
const screen = vi.hoisted(() => ({ width: 1024, height: 1366 }));
const windowWidth = vi.hoisted(() => ({ value: 1024 }));

vi.mock('react-native', () => ({
  Platform: platform,
  Dimensions: { get: () => screen },
  useWindowDimensions: () => ({ width: windowWidth.value, height: screen.height }),
}));

import { useDeviceLayout } from '../use-device-layout';

describe('useDeviceLayout', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    platform.isPad = true;
    screen.width = 1024;
    screen.height = 1366;
    windowWidth.value = 1024;
  });

  // Regression guard: `isPad` is computed inside the hook but has to be part of
  // the RETURNED object too. It was dropped once while consumers still
  // destructured it (use-image-cache-memory-management, board-art-visibility-
  // provider), which reads `undefined` at runtime — a silent iPad-only bug that
  // only `tsc` caught. Assert the whole public shape, not just one field.
  it('returns isPad alongside isTablet and wallDeviceClass', () => {
    const { result } = renderHook(() => useDeviceLayout());

    expect(result.current).toMatchObject({
      isPad: true,
      isTablet: true,
      wallDeviceClass: expect.any(String),
      widthClass: expect.any(String),
    });
  });

  it('reports isPad false on Android tablets', () => {
    platform.OS = 'android';
    platform.isPad = false;

    const { result } = renderHook(() => useDeviceLayout());

    // An Android tablet is still a tablet — only the iPad-specific flag flips.
    expect(result.current.isPad).toBe(false);
    expect(result.current.isTablet).toBe(true);
  });

  it('treats a desktop-sized web screen as a panel-capable tablet surface', () => {
    platform.OS = 'web';
    platform.isPad = false;
    screen.width = 1440;
    screen.height = 900;
    windowWidth.value = 1440;

    const { result } = renderHook(() => useDeviceLayout());

    expect(result.current).toMatchObject({
      isPad: false,
      isTablet: true,
      widthClass: 'regular',
      expanded: true,
      wallDeviceClass: 'panel-capable',
    });
  });

  it('keeps an eligible web screen on the same shell when its live window becomes compact', () => {
    platform.OS = 'web';
    platform.isPad = false;
    screen.width = 1440;
    screen.height = 900;
    windowWidth.value = 699;

    const { result } = renderHook(() => useDeviceLayout());

    expect(result.current.isTablet).toBe(true);
    expect(result.current.widthClass).toBe('compact');
    expect(result.current.wallDeviceClass).toBe('panel-capable');
  });

  it('reports isPad false on a phone', () => {
    platform.OS = 'ios';
    platform.isPad = false;
    screen.width = 390;
    screen.height = 844;
    windowWidth.value = 390;

    const { result } = renderHook(() => useDeviceLayout());

    expect(result.current.isPad).toBe(false);
    expect(result.current.isTablet).toBe(false);
  });

  // The window width is live (Split View / Stage Manager / multi-window) while
  // `isPad` is launch-fixed, so a narrow split must not flip it.
  it('keeps isPad true when an iPad is resized into a narrow split', () => {
    windowWidth.value = 400;

    const { result } = renderHook(() => useDeviceLayout());

    expect(result.current.isPad).toBe(true);
    expect(result.current.widthClass).toBe('compact');
  });
});
