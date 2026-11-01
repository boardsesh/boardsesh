// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  focused: true,
  appState: 'active',
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('expo-router', () => ({ useIsFocused: () => controls.focused }));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return controls.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      controls.listeners.add(listener);
      return { remove: () => controls.listeners.delete(listener) };
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count: number }) => `${key}:${options?.count ?? ''}` }),
}));

import { useWallCapsuleHistoryAge } from '../use-wall-capsule-history-age';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-31T10:20:00Z');
  controls.focused = true;
  controls.appState = 'active';
});
afterEach(() => {
  cleanup();
  controls.listeners.clear();
  vi.useRealTimers();
});

describe('useWallCapsuleHistoryAge', () => {
  it('updates visible history once a minute and cleans up on unmount', () => {
    const { result, unmount } = renderHook(() => useWallCapsuleHistoryAge('2026-10-31T10:00:00Z', true));
    expect(result.current).toBe('mobile.boardPresence.litAgoMinutes:20');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe('mobile.boardPresence.litAgoMinutes:21');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(controls.listeners.size).toBe(0);
  });

  it('does no timed work while hidden, linked, invalid or covered', () => {
    const { rerender } = renderHook(({ stamp, enabled }) => useWallCapsuleHistoryAge(stamp, enabled), {
      initialProps: { stamp: '2026-10-31T10:00:00Z', enabled: false },
    });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ stamp: 'invalid', enabled: true });
    expect(vi.getTimerCount()).toBe(0);
    controls.focused = false;
    rerender({ stamp: '2026-10-31T10:00:00Z', enabled: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(controls.listeners.size).toBe(0);
  });

  it('pauses in background and refreshes immediately on foreground', () => {
    const { result } = renderHook(() => useWallCapsuleHistoryAge('2026-10-31T10:00:00Z', true));
    act(() => {
      controls.appState = 'background';
      controls.listeners.forEach((listener) => listener('background'));
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime('2026-10-31T10:40:00Z');
    act(() => {
      controls.appState = 'active';
      controls.listeners.forEach((listener) => listener('active'));
    });
    expect(result.current).toBe('mobile.boardPresence.litAgoMinutes:40');
    expect(vi.getTimerCount()).toBe(1);
  });
});
