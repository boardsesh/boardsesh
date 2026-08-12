// The in-memory overlay index, and the two things the disk sweeper needs from it.
//
// The design this replaced protected "the tail of the map" from eviction, which
// looked like an LRU and wasn't: the launch warm-up inserts a couple of hundred
// prior-session PNGs in directory-listing order, so the tail after launch is an
// arbitrary sample of the disk rather than anything on screen. The regression
// test for that is `getRecentlyUsedCacheKeys` returning only what was READ.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cacheRenderedOverlay,
  getRenderedOverlay,
  invalidateRenderedOverlay,
  getRecentlyUsedCacheKeys,
  forgetOverlays,
  clearOverlayIndex,
  onOverlayWriteThreshold,
  _renderedOverlaysForTests,
  _resetOverlayIndexForTests,
} from '../overlay-index';

beforeEach(() => {
  _resetOverlayIndexForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _resetOverlayIndexForTests();
});

describe('getRecentlyUsedCacheKeys', () => {
  it('returns what a surface READ, not the tail of the insertion order', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // The warm-up shape: 150 prior-session PNGs inserted in directory order.
    for (let index = 0; index < 150; index += 1) cacheRenderedOverlay(`warm-${index}`, `file:///warm-${index}.png`);

    // Five minutes of browsing later, three of them are actually on screen.
    vi.setSystemTime(5 * 60 * 1000);
    getRenderedOverlay('warm-3');
    getRenderedOverlay('warm-77');
    getRenderedOverlay('warm-149');

    const recent = getRecentlyUsedCacheKeys(120_000);
    expect([...recent].sort()).toEqual(['warm-149', 'warm-3', 'warm-77']);
  });

  it('lets a key that has not been read since the window fall out of protection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    cacheRenderedOverlay('stale', 'file:///stale.png');
    vi.setSystemTime(200_000);
    cacheRenderedOverlay('fresh', 'file:///fresh.png');
    expect([...getRecentlyUsedCacheKeys(120_000)]).toEqual(['fresh']);
  });

  it('does not keep protecting a key whose entry is gone', () => {
    cacheRenderedOverlay('gone', 'file:///gone.png');
    forgetOverlays(['gone']);
    expect(getRecentlyUsedCacheKeys(120_000).size).toBe(0);
  });
});

describe('forgetOverlays', () => {
  it('removes exactly the named keys', () => {
    cacheRenderedOverlay('a', 'file:///a.png');
    cacheRenderedOverlay('b', 'file:///b.png');
    expect(forgetOverlays(['a', 'never-existed'])).toBe(1);
    expect(_renderedOverlaysForTests.has('a')).toBe(false);
    expect(_renderedOverlaysForTests.has('b')).toBe(true);
  });
});

describe('index bookkeeping', () => {
  it('mints a new generation even when the URI is unchanged', () => {
    const first = cacheRenderedOverlay('a', 'file:///a.png');
    const second = cacheRenderedOverlay('a', 'file:///a.png');
    expect(second.generation).toBeGreaterThan(first.generation);
    // A stale handle must not be able to invalidate the replacement.
    expect(invalidateRenderedOverlay('a', first)).toBe(false);
    expect(invalidateRenderedOverlay('a', second)).toBe(true);
  });

  it('clears wholesale', () => {
    cacheRenderedOverlay('a', 'file:///a.png');
    clearOverlayIndex();
    expect(_renderedOverlaysForTests.size).toBe(0);
    expect(getRecentlyUsedCacheKeys(120_000).size).toBe(0);
  });
});

describe('write odometer', () => {
  it('notifies once per threshold and starts counting again', () => {
    const listener = vi.fn();
    const unsubscribe = onOverlayWriteThreshold(4, listener);
    for (let index = 0; index < 3; index += 1) cacheRenderedOverlay(`k-${index}`, `file:///k-${index}.png`);
    expect(listener).not.toHaveBeenCalled();

    cacheRenderedOverlay('k-3', 'file:///k-3.png');
    expect(listener).toHaveBeenCalledTimes(1);

    for (let index = 4; index < 8; index += 1) cacheRenderedOverlay(`k-${index}`, `file:///k-${index}.png`);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    for (let index = 8; index < 20; index += 1) cacheRenderedOverlay(`k-${index}`, `file:///k-${index}.png`);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('costs nothing when nobody is listening', () => {
    expect(() => cacheRenderedOverlay('a', 'file:///a.png')).not.toThrow();
  });
});
