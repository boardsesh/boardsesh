// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Capture the 'change' handler the store installs on first subscribe.
const appState = vi.hoisted(() => {
  const ref: { handler: ((state: string) => void) | null } = { handler: null };
  return {
    ref,
    addEventListener: vi.fn((_event: string, cb: (state: string) => void) => {
      ref.handler = cb;
      return { remove: vi.fn() };
    }),
    fire: (state: string) => ref.handler?.(state),
  };
});

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

import { useIsAppBackgrounded } from '../app-visibility';

// The store is a module-level singleton — reset it to the foreground after every
// test so they pass in any order. The captured handler stays callable even after
// the component unmounts, so this resets the flag regardless of subscriptions.
afterEach(() => {
  act(() => appState.fire('active'));
});

describe('app-visibility store', () => {
  it('subscribes to AppState change events', () => {
    renderHook(() => useIsAppBackgrounded());
    expect(appState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('reports backgrounded on "background" and clears on "active"', () => {
    const { result } = renderHook(() => useIsAppBackgrounded());
    expect(result.current).toBe(false);
    act(() => appState.fire('background'));
    expect(result.current).toBe(true);
    act(() => appState.fire('active'));
    expect(result.current).toBe(false);
  });

  it('ignores the transient "inactive" state', () => {
    const { result } = renderHook(() => useIsAppBackgrounded());
    act(() => appState.fire('inactive'));
    expect(result.current).toBe(false);
  });
});
