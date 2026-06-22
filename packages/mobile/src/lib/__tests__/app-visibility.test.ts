// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Capture the single 'change' handler the store installs at module load.
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

describe('app-visibility store', () => {
  it('installs a single AppState change listener at module load', () => {
    expect(appState.addEventListener).toHaveBeenCalledTimes(1);
    expect(appState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('flips to backgrounded on "background" and back on "active"', () => {
    const { result } = renderHook(() => useIsAppBackgrounded());
    expect(result.current).toBe(false);
    act(() => appState.fire('background'));
    expect(result.current).toBe(true);
    act(() => appState.fire('active'));
    expect(result.current).toBe(false);
  });

  it('ignores the transient "inactive" state (no blank-on-app-switcher-peek)', () => {
    const { result } = renderHook(() => useIsAppBackgrounded());
    act(() => appState.fire('inactive'));
    expect(result.current).toBe(false);
  });
});
