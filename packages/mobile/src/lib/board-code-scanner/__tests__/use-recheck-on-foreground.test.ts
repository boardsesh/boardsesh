// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => {
  let currentState = 'active';
  const handlers = new Set<(state: string) => void>();
  return {
    getCurrentState: () => currentState,
    emit: (state: string) => {
      currentState = state;
      for (const handler of handlers) handler(state);
    },
    addEventListener: vi.fn((_event: string, handler: (state: string) => void) => {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    }),
    listenerCount: () => handlers.size,
    reset: () => {
      currentState = 'active';
      handlers.clear();
    },
  };
});

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.getCurrentState();
    },
    addEventListener: appState.addEventListener,
  },
}));

import { useRecheckOnForeground } from '../use-recheck-on-foreground';

afterEach(() => {
  appState.reset();
});

describe('useRecheckOnForeground', () => {
  it('re-reads the camera permission when the climber comes back from Settings', () => {
    const getPermission = vi.fn(async () => ({ granted: true }));
    renderHook(() => useRecheckOnForeground(getPermission));
    // The mount read is expo's own; this hook adds nothing until the app returns.
    expect(getPermission).not.toHaveBeenCalled();

    appState.emit('background');
    expect(getPermission).not.toHaveBeenCalled();
    appState.emit('active');
    expect(getPermission).toHaveBeenCalledTimes(1);
  });

  it('re-reads after an iOS interruption too (the Settings switch passes through inactive)', () => {
    const getPermission = vi.fn(async () => ({ granted: false }));
    renderHook(() => useRecheckOnForeground(getPermission));
    appState.emit('inactive');
    appState.emit('active');
    expect(getPermission).toHaveBeenCalledTimes(1);
  });

  it('does not re-read on a repeated active event', () => {
    const getPermission = vi.fn(async () => ({ granted: true }));
    renderHook(() => useRecheckOnForeground(getPermission));
    appState.emit('active');
    expect(getPermission).not.toHaveBeenCalled();
  });

  it('keeps the last answer when the re-read fails', async () => {
    const getPermission = vi.fn(() => Promise.reject(new Error('native module gone')));
    renderHook(() => useRecheckOnForeground(getPermission));
    appState.emit('background');
    appState.emit('active');
    expect(getPermission).toHaveBeenCalledTimes(1);
    // No unhandled rejection: the catch swallows it.
    await Promise.resolve();
  });

  it('stops listening when the scan screen unmounts', () => {
    const getPermission = vi.fn(async () => ({ granted: true }));
    const { unmount } = renderHook(() => useRecheckOnForeground(getPermission));
    expect(appState.listenerCount()).toBe(1);
    unmount();
    expect(appState.listenerCount()).toBe(0);
    appState.emit('background');
    appState.emit('active');
    expect(getPermission).not.toHaveBeenCalled();
  });
});
