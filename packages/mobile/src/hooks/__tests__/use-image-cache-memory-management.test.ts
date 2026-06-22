// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const clearMemoryCache = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));

// Capture each AppState handler by event name so tests can fire them and assert
// the registered subscriptions are torn down on unmount.
const appState = vi.hoisted(() => {
  const handlers: Record<string, (state?: string) => void> = {};
  const removers: Record<string, ReturnType<typeof vi.fn>> = {};
  return {
    handlers,
    removers,
    addEventListener: vi.fn((event: string, cb: (state?: string) => void) => {
      handlers[event] = cb;
      const remove = vi.fn();
      removers[event] = remove;
      return { remove };
    }),
    fire: (event: string, state?: string) => handlers[event]?.(state),
  };
});

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

vi.mock('expo-image', () => ({
  Image: { clearMemoryCache },
}));

// Control the background flag directly so the cache-flush effect can be asserted
// without driving the real AppState store.
const isBackgrounded = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/app-visibility', () => ({
  useIsAppBackgrounded: () => isBackgrounded.value,
}));

import { useImageCacheMemoryManagement } from '../use-image-cache-memory-management';

describe('useImageCacheMemoryManagement', () => {
  beforeEach(() => {
    clearMemoryCache.mockClear();
    appState.addEventListener.mockClear();
    isBackgrounded.value = false;
  });

  it('does not flush while foregrounded', () => {
    renderHook(() => useImageCacheMemoryManagement());
    expect(clearMemoryCache).not.toHaveBeenCalled();
  });

  it('flushes the image memory cache once the app is backgrounded', () => {
    isBackgrounded.value = true;
    renderHook(() => useImageCacheMemoryManagement());
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
  });

  it('flushes when transitioning foreground -> background', () => {
    const { rerender } = renderHook(() => useImageCacheMemoryManagement());
    expect(clearMemoryCache).not.toHaveBeenCalled();
    isBackgrounded.value = true;
    rerender();
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
  });

  it('registers and tears down the memoryWarning listener', () => {
    const { unmount } = renderHook(() => useImageCacheMemoryManagement());
    expect(appState.addEventListener).toHaveBeenCalledWith('memoryWarning', expect.any(Function));
    appState.fire('memoryWarning');
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
    unmount();
    expect(appState.removers.memoryWarning).toHaveBeenCalledTimes(1);
  });
});
