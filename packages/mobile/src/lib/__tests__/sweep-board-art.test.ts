// The LRU sweep that keeps `{cache}/board-thumbnails` under the cap during a
// session, rather than only on the cold launch the native pruner runs on.
//
// The two assertions that matter most: a foreign file is never in a plan (a
// sweeper that deletes an in-flight write manufactures the render-failure storm
// this issue also exists to stop), and eviction protects the keys a live surface
// READ — not the tail of the in-memory map, which after warm-up is an arbitrary
// sample of the disk.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Imported by path — see cache-dir-io.test.ts for why.
import { __resetFileSystem, __seedFileSystem } from '../../../test/expo-file-system-stub';

const clearDiskCache = vi.hoisted(() => vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)));
vi.mock('expo-image', () => ({ Image: { clearDiskCache } }));

const track = vi.hoisted(() => vi.fn());
vi.mock('../analytics', () => ({ track }));

import { sweepBoardArtCache, sweepOverlaysForScope, _resetSweepRateLimitForTests } from '../sweep-caches';
import { invalidateCacheMeasurement } from '../cache-size-meter';
import {
  cacheRenderedOverlay,
  getRenderedOverlay,
  _renderedOverlaysForTests,
  _resetOverlayIndexForTests,
} from '../overlay-index';

const NOW = 1_800_000_000_000;
const MB = 1024 * 1024;

function overlayName(index: number): string {
  return `v5_f_w400_kilter_1_7_1,20_${index.toString(16).padStart(8, '0')}.png`;
}

/** A directory of `count` 1 MB PNGs, oldest first. */
function seedOverlays(count: number, extra: Record<string, { size: number; lastModified: number }> = {}): void {
  const files: Record<string, { size: number; lastModified: number }> = { ...extra };
  for (let index = 0; index < count; index += 1) {
    files[overlayName(index)] = { size: MB, lastModified: NOW - (count - index) * 1_000 };
  }
  __seedFileSystem({ 'cache/board-thumbnails': files });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  _resetSweepRateLimitForTests();
  _resetOverlayIndexForTests();
  invalidateCacheMeasurement();
  track.mockReset();
});

afterEach(() => {
  __resetFileSystem();
  _resetSweepRateLimitForTests();
  _resetOverlayIndexForTests();
  invalidateCacheMeasurement();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sweepBoardArtCache', () => {
  it('does nothing, and reports nothing, while under the cap', async () => {
    seedOverlays(4);
    const result = await sweepBoardArtCache({ trigger: 'launch', targetBytes: 100 * MB });
    expect(result).toEqual({ beforeBytes: 4 * MB, freedBytes: 0, filesDeleted: 0 });
    expect(track).not.toHaveBeenCalled();
  });

  it('evicts oldest-first down to the target and forgets exactly those keys', async () => {
    seedOverlays(10);
    for (let index = 0; index < 10; index += 1) {
      cacheRenderedOverlay(overlayName(index).replace('.png', ''), `file:///${overlayName(index)}`);
    }
    // Past the protection window: these were rendered a while ago and nothing has
    // looked at them since, so none of them is on screen.
    vi.setSystemTime(NOW + 5 * 60 * 1000);

    const result = await sweepBoardArtCache({ trigger: 'background', targetBytes: 6 * MB });
    expect(result.beforeBytes).toBe(10 * MB);
    expect(result.freedBytes).toBe(4 * MB);
    expect(result.filesDeleted).toBe(4);
    // The four oldest are gone from the index; the survivors are untouched.
    for (let index = 0; index < 4; index += 1) {
      expect(_renderedOverlaysForTests.has(overlayName(index).replace('.png', ''))).toBe(false);
    }
    expect(_renderedOverlaysForTests.has(overlayName(9).replace('.png', ''))).toBe(true);
  });

  it('never deletes the art a surface just read, even though it is the oldest', async () => {
    seedOverlays(6);
    const oldestKey = overlayName(0).replace('.png', '');
    cacheRenderedOverlay(oldestKey, `file:///${overlayName(0)}`);
    // Long enough that mtime says "ancient" — then a mounted surface reads it.
    vi.setSystemTime(NOW + 5 * 60 * 1000);
    getRenderedOverlay(oldestKey);

    await sweepBoardArtCache({ trigger: 'write-threshold', targetBytes: 4 * MB });
    expect(_renderedOverlaysForTests.has(oldestKey)).toBe(true);
  });

  it('leaves an in-flight atomic write and a foreign staging file alone', async () => {
    seedOverlays(4, {
      '.bsov-live.tmp': { size: 30 * MB, lastModified: NOW },
      '.dat.nosync0f1e.abc': { size: 30 * MB, lastModified: NOW - 999_999 },
    });
    const result = await sweepBoardArtCache({ trigger: 'launch', targetBytes: 0 });
    // Only the four PNGs — the temps and hidden files were never in the budget
    // and are never in the plan.
    expect(result.filesDeleted).toBe(4);
    expect(result.beforeBytes).toBe(4 * MB);
  });

  it('reaps an orphaned temp once it is old enough to be certainly dead', async () => {
    seedOverlays(1, { '.bsov-orphan.tmp': { size: 5 * MB, lastModified: NOW - 2 * 60 * 60 * 1000 } });
    const result = await sweepBoardArtCache({ trigger: 'launch', targetBytes: 100 * MB });
    expect(result.filesDeleted).toBe(1);
  });

  it('rate-limits a trigger class so a chatty signal cannot re-walk the directory', async () => {
    seedOverlays(10);
    const first = await sweepBoardArtCache({ trigger: 'write-threshold', targetBytes: 6 * MB });
    expect(first.filesDeleted).toBe(4);

    seedOverlays(10);
    const second = await sweepBoardArtCache({ trigger: 'write-threshold', targetBytes: 6 * MB });
    expect(second.filesDeleted).toBe(0);

    // A different class is its own budget, and the window eventually reopens.
    const other = await sweepBoardArtCache({ trigger: 'background', targetBytes: 6 * MB });
    expect(other.filesDeleted).toBe(4);
  });

  it('reports a sweep that actually freed something, with the trigger that caused it', async () => {
    seedOverlays(10);
    await sweepBoardArtCache({ trigger: 'background', targetBytes: 6 * MB });
    expect(track).toHaveBeenCalledWith('Cached Images Swept', {
      trigger: 'background',
      beforeBytes: 10 * MB,
      freedBytes: 4 * MB,
      filesDeleted: 4,
    });
  });

  it('does nothing when the cache directory was never created', async () => {
    await expect(sweepBoardArtCache({ trigger: 'launch' })).resolves.toEqual({
      beforeBytes: 0,
      freedBytes: 0,
      filesDeleted: 0,
    });
  });
});

describe('sweepOverlaysForScope', () => {
  it('deletes only the removed board’s art', async () => {
    __seedFileSystem({
      'cache/board-thumbnails': {
        'v5_f_w400_kilter_1_7_1,20_aa.png': { size: MB, lastModified: NOW },
        'v5_s_wfull_kilter_1_7_1,20_bb.png': { size: MB, lastModified: NOW },
        // A neighbouring size, and a different board entirely.
        'v5_f_w400_kilter_1_70_1,20_cc.png': { size: MB, lastModified: NOW },
        'v5_f_w400_tension_1_7_1,20_dd.png': { size: MB, lastModified: NOW },
      },
    });
    const result = await sweepOverlaysForScope({ boardType: 'kilter', layoutId: 1, sizeId: 7 });
    expect(result.filesDeleted).toBe(2);
    expect(result.freedBytes).toBe(2 * MB);
  });

  it('is a no-op when that board rendered nothing', async () => {
    __seedFileSystem({ 'cache/board-thumbnails': {} });
    const result = await sweepOverlaysForScope({ boardType: 'kilter', layoutId: 1, sizeId: 7 });
    expect(result.filesDeleted).toBe(0);
    expect(track).not.toHaveBeenCalled();
  });
});
