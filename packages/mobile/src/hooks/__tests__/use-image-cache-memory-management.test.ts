// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const clearMemoryCache = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const configureCache = vi.hoisted(() => vi.fn());

// The cap effect reads Platform.OS, so tests flip this to assert the iOS gate —
// expo-image's Android module exposes no configureCache and would throw.
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));

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
  Platform: platform,
}));

vi.mock('expo-image', () => ({
  Image: { clearMemoryCache, configureCache },
}));

// Control the background flag directly so the cache-flush effect can be asserted
// without driving the real AppState store.
const isBackgrounded = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/app-visibility', () => ({
  useIsAppBackgrounded: () => isBackgrounded.value,
}));

// Drive the focused route segments and the launch-fixed iPad flag directly so the
// tab-switch sweep can be asserted without a navigation container.
const segments = vi.hoisted(() => ({ value: ['(tabs)', 'home'] as readonly string[] }));
vi.mock('expo-router', () => ({ useSegments: () => segments.value }));
const deviceLayout = vi.hoisted(() => ({ isPad: true }));
vi.mock('../use-device-layout', () => ({ useDeviceLayout: () => ({ isPad: deviceLayout.isPad }) }));

import {
  IMAGE_MEMORY_CACHE_MAX_BYTES,
  useImageCacheMemoryManagement,
  useIpadTabSwitchImageCacheSweep,
} from '../use-image-cache-memory-management';

describe('image memory cache ceiling', () => {
  beforeEach(() => {
    configureCache.mockClear();
    platform.OS = 'ios';
    isBackgrounded.value = false;
  });

  it('caps the decoded-bitmap cache on iOS', () => {
    renderHook(() => useImageCacheMemoryManagement());
    // Pins the wiring, not the arithmetic: it must be maxMemoryCost (the in-memory
    // bitmap budget), not maxDiskSize — capping the disk cache instead would evict
    // the very PNGs a re-decode reads back and would not bound memory at all.
    expect(configureCache).toHaveBeenCalledWith({ maxMemoryCost: IMAGE_MEMORY_CACHE_MAX_BYTES });
  });

  it('applies the cap once, not on every render', () => {
    const { rerender } = renderHook(() => useImageCacheMemoryManagement());
    rerender();
    isBackgrounded.value = true;
    rerender();
    expect(configureCache).toHaveBeenCalledTimes(1);
  });

  it.each(['android', 'web'])('does not configure the cache on %s', (os) => {
    // expo-image declares configureCache @platform ios: the Android module defines
    // no such function, and web has no native cache behind it. The guard is
    // `!== 'ios'`, so both non-iOS targets must stay silent.
    platform.OS = os;
    renderHook(() => useImageCacheMemoryManagement());
    expect(configureCache).not.toHaveBeenCalled();
  });

  it('picks a ceiling that holds a real working set but still bounds a long session', () => {
    // A full-resolution board overlay decodes at roughly 8 MB of RGBA and the
    // widest surface (the play-drawer carousel: previous + current + peek) holds
    // three at once. Guards against a fat-fingered constant in either direction —
    // too low and the cap evicts art a live surface is about to swap to (the
    // peek→commit flash), too high and it stops bounding anything.
    const fullResOverlayBytes = 8 * 1024 * 1024;
    expect(IMAGE_MEMORY_CACHE_MAX_BYTES).toBeGreaterThan(8 * fullResOverlayBytes);
    expect(IMAGE_MEMORY_CACHE_MAX_BYTES).toBeLessThan(512 * 1024 * 1024);
  });
});

describe('useImageCacheMemoryManagement', () => {
  beforeEach(() => {
    clearMemoryCache.mockClear();
    appState.addEventListener.mockClear();
    isBackgrounded.value = false;
    platform.OS = 'ios';
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

  it('does not re-flush when returning to the foreground', () => {
    isBackgrounded.value = true;
    const { rerender } = renderHook(() => useImageCacheMemoryManagement());
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
    isBackgrounded.value = false;
    rerender();
    // Foregrounding must NOT sweep again — the effect gates on the flag value.
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
  });

  it('flushes again on each background across repeated background/foreground cycles', () => {
    isBackgrounded.value = true;
    const { rerender } = renderHook(() => useImageCacheMemoryManagement());
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
    isBackgrounded.value = false;
    rerender();
    isBackgrounded.value = true;
    rerender();
    // A second background sweeps again — the flag genuinely flipped.
    expect(clearMemoryCache).toHaveBeenCalledTimes(2);
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

describe('useIpadTabSwitchImageCacheSweep', () => {
  beforeEach(() => {
    clearMemoryCache.mockClear();
    deviceLayout.isPad = true;
    segments.value = ['(tabs)', 'home'];
  });

  it('does not sweep on mount — it seeds the current tab', () => {
    renderHook(() => useIpadTabSwitchImageCacheSweep());
    expect(clearMemoryCache).not.toHaveBeenCalled();
  });

  it('sweeps the memory cache on an iPad top-level tab change', () => {
    const { rerender } = renderHook(() => useIpadTabSwitchImageCacheSweep());
    expect(clearMemoryCache).not.toHaveBeenCalled();
    segments.value = ['(tabs)', 'climbs'];
    rerender();
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
  });

  it('does not sweep for a sub-route within the same tab', () => {
    segments.value = ['(tabs)', 'climbs'];
    const { rerender } = renderHook(() => useIpadTabSwitchImageCacheSweep());
    // Pushing climbs/[climbUuid] keeps the active tab 'climbs' (segment 1), so
    // navigating within a tab must not sweep.
    segments.value = ['(tabs)', 'climbs', 'abc-uuid'];
    rerender();
    expect(clearMemoryCache).not.toHaveBeenCalled();
  });

  it('does not sweep on a non-iPad device', () => {
    deviceLayout.isPad = false;
    const { rerender } = renderHook(() => useIpadTabSwitchImageCacheSweep());
    segments.value = ['(tabs)', 'climbs'];
    rerender();
    expect(clearMemoryCache).not.toHaveBeenCalled();
  });

  it('dedupes repeated identical tab emissions', () => {
    const { rerender } = renderHook(() => useIpadTabSwitchImageCacheSweep());
    segments.value = ['(tabs)', 'home'];
    rerender();
    expect(clearMemoryCache).not.toHaveBeenCalled();
  });

  it('sweeps again on each distinct tab change', () => {
    const { rerender } = renderHook(() => useIpadTabSwitchImageCacheSweep());
    segments.value = ['(tabs)', 'climbs'];
    rerender();
    segments.value = ['(tabs)', 'profile'];
    rerender();
    expect(clearMemoryCache).toHaveBeenCalledTimes(2);
  });

  it('seeds a null active tab on a root-modal cold start, then sweeps on the first tab nav', () => {
    // Cold-start straight into a root modal / player (segment 0 is not `(tabs)`),
    // so tabsActiveSegment is null. The seed must record that null without sweeping,
    // and the first real tab navigation must then sweep once.
    segments.value = ['play'];
    const { rerender } = renderHook(() => useIpadTabSwitchImageCacheSweep());
    expect(clearMemoryCache).not.toHaveBeenCalled();
    segments.value = ['(tabs)', 'home'];
    rerender();
    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
  });
});
