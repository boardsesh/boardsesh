// Measuring and clearing the caches, against a seeded filesystem.
//
// The load-bearing assertions: the Photos row is ABSENT rather than zero when we
// can't find expo-image's cache directory (the issue's design note is explicit
// that a fake number is worse than no number), Clear never deletes a file that
// isn't ours, and a `clearDiskCache()` that resolves FALSE — which is what
// Android does with no current activity — is reported as partial, not success.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Imported by path — see cache-dir-io.test.ts for why.
import { __resetFileSystem, __seedFileSystem } from '../../../test/expo-file-system-stub';

// The stub aliased in for expo-image is a bare render component with no statics,
// so the disk-cache call has to be mocked here.
const clearDiskCache = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock('expo-image', () => ({ Image: { clearDiskCache } }));

import { clearCachedImages, measureCachedImageBytes, sweepSnapshotLeftovers } from '../sweep-caches';
import { invalidateCacheMeasurement } from '../cache-size-meter';
import { cacheRenderedOverlay, _renderedOverlaysForTests, _resetOverlayIndexForTests } from '../overlay-index';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  invalidateCacheMeasurement();
  _resetOverlayIndexForTests();
  clearDiskCache.mockReset();
  clearDiskCache.mockResolvedValue(true);
});

afterEach(() => {
  __resetFileSystem();
  invalidateCacheMeasurement();
  _resetOverlayIndexForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('measureCachedImageBytes', () => {
  it('counts finished board art only, and omits Photos when the directory is unknown', async () => {
    __seedFileSystem({
      'cache/board-thumbnails': {
        'a.png': { size: 60_000, lastModified: NOW },
        '.bsov-live.tmp': { size: 40_000, lastModified: NOW },
        '.dat.nosync0f1e.abc': { size: 10_000, lastModified: NOW },
      },
    });
    const measurement = await measureCachedImageBytes();
    expect(measurement?.artBytes).toBe(60_000);
    // Null, never 0: the row is omitted rather than fabricated.
    expect(measurement?.photoBytes).toBeNull();
    expect(measurement?.leftoverSnapshotBytes).toBe(0);
  });

  it('measures expo-image and leaked snapshot artifacts when they are there', async () => {
    __seedFileSystem({
      'cache/board-thumbnails': { 'a.png': { size: 1_000, lastModified: NOW } },
      'cache/com.hackemist.SDImageCache': {},
      'cache/com.hackemist.SDImageCache/default': { photo: { size: 5_000, lastModified: NOW } },
      'cache/board-snapshots': { 'kilter-1.db': { size: 271_000_000, lastModified: NOW - 2 * DAY_MS } },
    });
    const measurement = await measureCachedImageBytes();
    expect(measurement).toEqual({ artBytes: 1_000, photoBytes: 5_000, leftoverSnapshotBytes: 271_000_000 });
  });

  it('reuses a measurement rather than re-walking on every focus', async () => {
    __seedFileSystem({ 'cache/board-thumbnails': { 'a.png': { size: 1_000, lastModified: NOW } } });
    await measureCachedImageBytes();
    // The disk moved on, but within the memo window the screen keeps the number
    // it already has — that is the point, one walk per minute, not per focus.
    __seedFileSystem({ 'cache/board-thumbnails': { 'a.png': { size: 9_999_999, lastModified: NOW } } });
    expect((await measureCachedImageBytes())?.artBytes).toBe(1_000);

    vi.setSystemTime(NOW + 61_000);
    expect((await measureCachedImageBytes())?.artBytes).toBe(9_999_999);
  });
});

describe('sweepSnapshotLeftovers', () => {
  it('reaps an artifact leaked by a kill and leaves a recent one for the retry', async () => {
    __seedFileSystem({
      'cache/board-snapshots': {
        'leaked.db': { size: 271_000_000, lastModified: NOW - 2 * DAY_MS },
        'in-flight.db': { size: 40_000_000, lastModified: NOW - 30_000 },
      },
    });
    expect(await sweepSnapshotLeftovers()).toBe(271_000_000);
    const measurement = await measureCachedImageBytes();
    expect(measurement?.leftoverSnapshotBytes).toBe(40_000_000);
  });

  it('does nothing when the directory was never created', async () => {
    expect(await sweepSnapshotLeftovers()).toBe(0);
  });
});

describe('clearCachedImages', () => {
  it('deletes every overlay PNG and dead temp, and nothing that is not ours', async () => {
    __seedFileSystem({
      'cache/board-thumbnails': {
        'v5_f_w400_kilter_1_7_1,20_aa.png': { size: 60_000, lastModified: NOW },
        'v5_f_w400_kilter_1_7_1,20_bb.png': { size: 60_000, lastModified: NOW },
        '.bsov-dead.tmp': { size: 9, lastModified: NOW - 2 * 60 * 60 * 1000 },
        '.bsov-live.tmp': { size: 9, lastModified: NOW },
        '.dat.nosync0f1e.abc': { size: 9, lastModified: NOW },
      },
    });
    const result = await clearCachedImages();
    expect(result.filesDeleted).toBe(3);
    expect(result.freedBytes).toBe(120_000);
    expect(result.photoCacheCleared).toBe(true);

    // The in-flight temp and the foreign staging file survived — deleting either
    // is how a sweeper manufactures the render-failure storm.
    const measurement = await measureCachedImageBytes();
    expect(measurement?.artBytes).toBe(0);
  });

  it('drops the cleared keys from the in-memory index so nothing serves a dead URI', async () => {
    __seedFileSystem({
      'cache/board-thumbnails': { 'live.png': { size: 100, lastModified: NOW } },
    });
    cacheRenderedOverlay('live', 'file:///cache/board-thumbnails/live.png');
    await clearCachedImages();
    expect(_renderedOverlaysForTests.size).toBe(0);
  });

  // Android's Image.clearDiskCache resolves false — a no-op — when the module has
  // no current activity. Reporting that as success is a lie the very next
  // measurement contradicts.
  it('reports partial rather than success when expo-image declines', async () => {
    clearDiskCache.mockResolvedValue(false);
    const result = await clearCachedImages();
    expect(result.photoCacheCleared).toBe(false);
  });

  it('reports partial rather than throwing when expo-image rejects', async () => {
    clearDiskCache.mockRejectedValue(new Error('no activity'));
    await expect(clearCachedImages()).resolves.toMatchObject({ photoCacheCleared: false });
  });

  it('leaves a snapshot download that could still be in flight alone', async () => {
    __seedFileSystem({
      'cache/board-snapshots': { 'downloading.db': { size: 271_000_000, lastModified: NOW - 30_000 } },
    });
    const result = await clearCachedImages();
    expect(result.freedBytes).toBe(0);
  });
});
