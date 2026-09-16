import { describe, expect, it, vi } from 'vitest';
import type { BoardArtGeometry } from '../types';

/**
 * The web shard index and the async loader path it feeds.
 *
 * Node and native both resolve `./generated/shards` to the synchronous
 * `shards.ts`, so nothing in the default test run exercises the `import()` map
 * that the browser app actually uses. These tests reach it two ways: directly,
 * to pin that the two generated indexes agree, and through a mocked module, to
 * pin the loader behaviour that only happens when shards arrive late.
 */

describe('generated/shards.web.ts', () => {
  it('covers exactly the same configs as the native index', async () => {
    const native = await import('../generated/shards');
    const web = await import('../generated/shards.web');

    // Same keys, same order. A shard that exists on one platform and not the
    // other is a board that silently loses its silhouettes in a browser.
    expect(Object.keys(web.BOARD_ART_GEOMETRY_SHARDS_ASYNC ?? {})).toEqual(
      Object.keys(native.BOARD_ART_GEOMETRY_SHARDS),
    );
  });

  it('offers nothing synchronously, which is what makes the loader wait', async () => {
    // If this map were ever populated on web, `require` would pull all 51 shards
    // back into the entry chunk and undo the split without failing anything.
    const web = await import('../generated/shards.web');
    expect(Object.keys(web.BOARD_ART_GEOMETRY_SHARDS)).toEqual([]);
    expect(web.BOARD_ART_GEOMETRY_SHARDS_ASYNC).not.toBeNull();
  });

  it('is null off web, so the sync path stays the only one', async () => {
    const offWeb = await import('../shards-async');
    expect(offWeb.BOARD_ART_GEOMETRY_SHARDS_ASYNC).toBeNull();
  });

  it('keeps the small eager tables eager', async () => {
    const native = await import('../generated/shards');
    const web = await import('../generated/shards.web');
    // Wall lightness is ~3 KB and the veil decision happens before any shard is
    // needed, so it stays synchronous on web too.
    expect(web.WALL_LIGHTNESS).toEqual(native.WALL_LIGHTNESS);
  });
});

const PENDING_KEY = { boardName: 'kilter', layoutId: 1, sizeId: 10 } as const;
const ABSENT_KEY = { boardName: 'kilter', layoutId: 999, sizeId: 999 } as const;

const FAKE_SHARD = { outlines: { 1: [0, 0, 1, 0, 1, 1] }, lightness: {}, ledBright: {} } as unknown as BoardArtGeometry;

/**
 * Load a fresh copy of the loader whose shard index is async-only, the way Metro
 * resolves it on web.
 */
async function loadWebLoader(shard: () => Promise<BoardArtGeometry>) {
  vi.resetModules();
  // Both halves of the web resolution: the generated index goes empty, and the
  // async pair supplies the chunk thunks.
  vi.doMock('../generated/shards', () => ({
    BOARD_ART_GEOMETRY_SHARDS: {},
    WALL_LIGHTNESS: {},
    loadOutlineCounts: () => ({}),
  }));
  vi.doMock('../shards-async', () => ({
    BOARD_ART_GEOMETRY_SHARDS_ASYNC: { 'kilter/1-10': shard },
  }));
  return import('../loader');
}

describe('loader on an async shard index', () => {
  it('answers "not yet" without poisoning the cache', async () => {
    const loader = await loadWebLoader(() => Promise.resolve(FAKE_SHARD));

    // The critical invariant. `null` is also the answer for a board the tracer
    // skipped, and that answer IS cached — so if a pending shard were cached the
    // same way, the board would draw its ring fallback for the rest of the
    // session even after the chunk landed.
    expect(loader.loadBoardArtGeometry(PENDING_KEY)).toBeNull();
    expect(loader.boardArtGeometryPending(PENDING_KEY)).toBe(true);

    await loader.prefetchBoardArtGeometry(PENDING_KEY);

    expect(loader.boardArtGeometryPending(PENDING_KEY)).toBe(false);
    expect(loader.loadBoardArtGeometry(PENDING_KEY)).toBe(FAKE_SHARD);
  });

  it('caches a genuinely absent config, so it is asked for once', async () => {
    const loader = await loadWebLoader(() => Promise.resolve(FAKE_SHARD));

    expect(loader.loadBoardArtGeometry(ABSENT_KEY)).toBeNull();
    // Not pending: no async shard exists for it either, so the answer is final.
    expect(loader.boardArtGeometryPending(ABSENT_KEY)).toBe(false);
    await expect(loader.prefetchBoardArtGeometry(ABSENT_KEY)).resolves.toBeNull();
  });

  it('shares one download between concurrent callers', async () => {
    const shard = vi.fn(() => Promise.resolve(FAKE_SHARD));
    const loader = await loadWebLoader(shard);

    // A list of climbs on one wall mounts many rows at once. Each asks for the
    // same board; they must not each fetch the chunk.
    await Promise.all([
      loader.prefetchBoardArtGeometry(PENDING_KEY),
      loader.prefetchBoardArtGeometry(PENDING_KEY),
      loader.prefetchBoardArtGeometry(PENDING_KEY),
    ]);

    expect(shard).toHaveBeenCalledTimes(1);
  });

  it('survives a failed download, and stays retryable', async () => {
    let attempt = 0;
    const loader = await loadWebLoader(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(FAKE_SHARD);
    });

    // A dropped chunk costs the silhouettes, not the board — and it must not be
    // recorded as "this config has no art", because it is not evidence of that.
    await expect(loader.prefetchBoardArtGeometry(PENDING_KEY)).resolves.toBeNull();
    expect(loader.boardArtGeometryPending(PENDING_KEY)).toBe(true);

    await expect(loader.prefetchBoardArtGeometry(PENDING_KEY)).resolves.toBe(FAKE_SHARD);
    expect(loader.loadBoardArtGeometry(PENDING_KEY)).toBe(FAKE_SHARD);
  });

  it('stops re-downloading a chunk that keeps failing', async () => {
    const shard = vi.fn(() => Promise.reject(new Error('offline')));
    const loader = await loadWebLoader(shard as unknown as () => Promise<BoardArtGeometry>);

    // A caller that bounces its render on `boardArtGeometryPending` asks again
    // every time it re-renders. Without a cap, "failed" and "not finished yet"
    // are the same state, so this is an unbounded import loop off one board.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(loader.prefetchBoardArtGeometry(PENDING_KEY)).resolves.toBeNull();
    }

    expect(shard).toHaveBeenCalledTimes(3);
    // The ring fallback is the final answer now, which is what makes the caller
    // stop asking.
    expect(loader.boardArtGeometryPending(PENDING_KEY)).toBe(false);
    expect(loader.loadBoardArtGeometry(PENDING_KEY)).toBeNull();
  });

  it('forgets earlier failures once a download lands', async () => {
    let attempt = 0;
    const loader = await loadWebLoader(() => {
      attempt += 1;
      // Fail, fail, succeed: two failures is one short of the cap, so the third
      // try must still happen — and the count must not carry into a later key's
      // budget by surviving the success.
      return attempt <= 2 ? Promise.reject(new Error('offline')) : Promise.resolve(FAKE_SHARD);
    });

    await expect(loader.prefetchBoardArtGeometry(PENDING_KEY)).resolves.toBeNull();
    await expect(loader.prefetchBoardArtGeometry(PENDING_KEY)).resolves.toBeNull();
    expect(loader.boardArtGeometryPending(PENDING_KEY)).toBe(true);
    await expect(loader.prefetchBoardArtGeometry(PENDING_KEY)).resolves.toBe(FAKE_SHARD);
  });
});
