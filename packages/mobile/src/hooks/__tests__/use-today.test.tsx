// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ listener: null as null | ((status: string) => void) }));
const clock = vi.hoisted(() => ({ frozenMs: null as number | null }));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (status: string) => void) => {
      appState.listener = listener;
      return {
        remove: () => {
          appState.listener = null;
        },
      };
    },
  },
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
// Screenshot mode's frozen clock, when a test sets one; the wall clock otherwise.
vi.mock('../../lib/clock', () => ({
  nowDate: () => new Date(clock.frozenMs ?? Date.now()),
}));

import { resetTodayForTests, useToday } from '../use-today';

beforeEach(() => {
  vi.useFakeTimers();
  clock.frozenMs = null;
  resetTodayForTests();
});

afterEach(() => {
  resetTodayForTests();
  vi.useRealTimers();
});

describe('useToday', () => {
  it('rolls over at local midnight while the screen stays open and in front', () => {
    vi.setSystemTime(new Date(2026, 5, 30, 23, 59, 30));
    const { result } = renderHook(() => useToday());
    const before = result.current;
    expect(before.getTime()).toBe(new Date(2026, 5, 30).getTime());

    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(result.current).toBe(before);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.getTime()).toBe(new Date(2026, 6, 1).getTime());

    // And again the next night, from the timer it re-armed.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(result.current.getTime()).toBe(new Date(2026, 6, 2).getTime());
  });

  it('keeps one Date all day, and reads the new day on foreground', () => {
    vi.setSystemTime(new Date(2026, 5, 30, 9, 0, 0));
    const { result } = renderHook(() => useToday());
    const morning = result.current;
    vi.setSystemTime(new Date(2026, 5, 30, 18, 0, 0));
    act(() => appState.listener?.('active'));
    expect(result.current).toBe(morning);

    vi.setSystemTime(new Date(2026, 6, 3, 8, 0, 0));
    act(() => appState.listener?.('background'));
    expect(result.current).toBe(morning);
    act(() => appState.listener?.('active'));
    expect(result.current.getTime()).toBe(new Date(2026, 6, 3).getTime());
  });

  it('stops its timer once nobody reads it', () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    const { unmount } = renderHook(() => useToday());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(appState.listener).toBeNull();
  });

  it('never rolls over on the frozen screenshot clock', () => {
    vi.setSystemTime(new Date(2026, 5, 30, 23, 0, 0));
    clock.frozenMs = new Date(2026, 5, 30, 12, 0, 0).getTime();
    const { result } = renderHook(() => useToday());
    act(() => {
      vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);
    });
    act(() => appState.listener?.('active'));
    expect(result.current.getTime()).toBe(new Date(2026, 5, 30).getTime());
  });
});
