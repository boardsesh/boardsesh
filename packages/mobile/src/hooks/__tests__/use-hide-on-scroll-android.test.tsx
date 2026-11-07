// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

const ctrl = vi.hoisted(() => ({ focused: true }));

vi.mock('expo-router', () => ({ useIsFocused: () => ctrl.focused }));

// Vitest never resolves `.android` files on its own; import the Android hook directly.
import { useHideOnScroll } from '../use-hide-on-scroll.android';
import {
  configureTabBarVisibility,
  getTabBarHidden,
  resetTabBarVisibility,
  resetTabBarVisibilityForTests,
} from '../../lib/tab-bar-visibility-store';

const scrollTo = (y: number) =>
  ({ nativeEvent: { contentOffset: { x: 0, y } } }) as unknown as NativeSyntheticEvent<NativeScrollEvent>;

describe('useHideOnScroll (Android)', () => {
  beforeEach(() => {
    resetTabBarVisibilityForTests();
    configureTabBarVisibility({ enabled: true, reduceMotion: true });
    ctrl.focused = true;
  });

  it('forwards every event first, then hides the bar after 24dp down', () => {
    const forward = vi.fn();
    const { result } = renderHook(() => useHideOnScroll(forward));
    result.current?.(scrollTo(40));
    result.current?.(scrollTo(70));
    expect(forward).toHaveBeenCalledTimes(2);
    expect(getTabBarHidden()).toBe(true);
  });

  it('keeps one handler identity across renders', () => {
    const { result, rerender } = renderHook(({ forward }) => useHideOnScroll(forward), {
      initialProps: { forward: vi.fn() },
    });
    const first = result.current;
    rerender({ forward: vi.fn() });
    expect(result.current).toBe(first);
  });

  it('ignores scrolling while its screen is not focused', () => {
    ctrl.focused = false;
    const { result } = renderHook(() => useHideOnScroll());
    result.current?.(scrollTo(40));
    result.current?.(scrollTo(400));
    expect(getTabBarHidden()).toBe(false);
  });

  it('starts over after a route change', () => {
    const { result } = renderHook(() => useHideOnScroll());
    result.current?.(scrollTo(40));
    resetTabBarVisibility();
    // 40 -> 70 would hide; after the reset 70 is a first event and only records.
    result.current?.(scrollTo(70));
    expect(getTabBarHidden()).toBe(false);
  });
});
