// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Capture the 'change' handler the store installs, and let `remove()` clear it
// so the ref-counted teardown is observable. `currentState` seeds the flag on
// each fresh install — since it's 'active' here, every test's first subscriber
// resets the module-level flag, keeping the tests order-independent.
const appState = vi.hoisted(() => {
  const ref: { handler: ((state: string) => void) | null; currentState: string } = {
    handler: null,
    currentState: 'active',
  };
  return {
    ref,
    addEventListener: vi.fn((_event: string, cb: (state: string) => void) => {
      ref.handler = cb;
      return {
        remove: vi.fn(() => {
          ref.handler = null;
        }),
      };
    }),
    fire: (state: string) => ref.handler?.(state),
  };
});

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: appState.addEventListener,
    get currentState() {
      return appState.ref.currentState;
    },
  },
}));

import { useIsAppBackgrounded } from '../app-visibility';

describe('app-visibility store', () => {
  beforeEach(() => {
    appState.addEventListener.mockClear();
    appState.ref.currentState = 'active';
  });

  // Unmount any hook a test left mounted (even if it threw before its own
  // unmount()) so the store's ref-counted listener drains between tests.
  afterEach(cleanup);

  it('installs a single AppState change listener on the first subscriber', () => {
    const { unmount } = renderHook(() => useIsAppBackgrounded());
    expect(appState.addEventListener).toHaveBeenCalledTimes(1);
    expect(appState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    unmount();
  });

  it('shares one listener across subscribers and removes it when the last unmounts', () => {
    const first = renderHook(() => useIsAppBackgrounded());
    const second = renderHook(() => useIsAppBackgrounded());
    expect(appState.addEventListener).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(appState.ref.handler).not.toBeNull();
    second.unmount();
    expect(appState.ref.handler).toBeNull();
  });

  it('flips to backgrounded on "background" and back on "active"', () => {
    const { result, unmount } = renderHook(() => useIsAppBackgrounded());
    expect(result.current).toBe(false);
    act(() => appState.fire('background'));
    expect(result.current).toBe(true);
    act(() => appState.fire('active'));
    expect(result.current).toBe(false);
    unmount();
  });

  it('ignores the transient "inactive" state (no blank-on-app-switcher-peek)', () => {
    const { result, unmount } = renderHook(() => useIsAppBackgrounded());
    act(() => appState.fire('inactive'));
    expect(result.current).toBe(false);
    unmount();
  });
});
