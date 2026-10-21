// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const ctrl = vi.hoisted(() => ({ isFocused: true }));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-router', () => ({ useIsFocused: () => ctrl.isFocused }));

import { HEADER_SETTLE_MS, useSettledHeaderValue } from '../use-settled-header-value';

describe('useSettledHeaderValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ctrl.isFocused = true;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes changes straight through on a focused, settled screen', () => {
    const { result, rerender } = renderHook(({ value }) => useSettledHeaderValue(value), {
      initialProps: { value: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ value: 'b' });
    expect(result.current).toBe('b');
  });

  it('holds the last focused value while the player covers the screen', () => {
    const { result, rerender } = renderHook(({ value }) => useSettledHeaderValue(value), {
      initialProps: { value: null as string | null },
    });
    ctrl.isFocused = false;
    rerender({ value: null });
    // Another phone lights a climb while the player is open.
    rerender({ value: 'wall climb' });
    expect(result.current).toBeNull();
  });

  it('keeps holding through the dismiss animation, then takes the newest value', () => {
    const { result, rerender } = renderHook(({ value }) => useSettledHeaderValue(value), {
      initialProps: { value: null as string | null },
    });
    ctrl.isFocused = false;
    rerender({ value: 'wall climb' });

    // The player starts closing: focus comes back on the same render.
    ctrl.isFocused = true;
    rerender({ value: 'wall climb' });
    expect(result.current).toBeNull();

    act(() => vi.advanceTimersByTime(HEADER_SETTLE_MS - 1));
    expect(result.current).toBeNull();

    // A newer wall event during the animation wins once it settles.
    rerender({ value: 'newer climb' });
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('newer climb');
  });

  it('holds its first value when it mounts already covered', () => {
    ctrl.isFocused = false;
    const { result, rerender } = renderHook(({ value }) => useSettledHeaderValue(value), {
      initialProps: { value: null as string | null },
    });
    rerender({ value: 'wall climb' });
    expect(result.current).toBeNull();

    ctrl.isFocused = true;
    rerender({ value: 'wall climb' });
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(HEADER_SETTLE_MS));
    expect(result.current).toBe('wall climb');
  });

  it('restarts the settle window when the screen is covered again mid-dismiss', () => {
    const { result, rerender } = renderHook(({ value }) => useSettledHeaderValue(value), {
      initialProps: { value: 'a' },
    });
    ctrl.isFocused = false;
    rerender({ value: 'b' });
    ctrl.isFocused = true;
    rerender({ value: 'b' });
    act(() => vi.advanceTimersByTime(HEADER_SETTLE_MS / 2));
    ctrl.isFocused = false;
    rerender({ value: 'b' });
    ctrl.isFocused = true;
    rerender({ value: 'b' });
    act(() => vi.advanceTimersByTime(HEADER_SETTLE_MS - 1));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('b');
  });
});
