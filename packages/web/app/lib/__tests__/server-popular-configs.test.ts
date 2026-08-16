import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
// The Next Data Cache is a pass-through here: `unstable_cache` memoises across
// requests in production, and the layer under test is the in-process one in
// front of it.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: never[]) => unknown) => fn,
}));

const backend = vi.hoisted(() => ({ hasMore: false, totalCount: 51, gate: null as null | Promise<void> }));

const CONFIG: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: '12 x 12 Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99,
  boardCount: 12,
  displayName: 'Kilter Original 12x12',
};

const requestedInputs: unknown[] = [];

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  executeGraphQLInternal: async (_document: unknown, variables: { input: unknown }) => {
    requestedInputs.push(variables.input);
    // A real await point, so two concurrent callers genuinely overlap and the
    // single-flight promise is observable rather than an accident of timing.
    await Promise.resolve();
    if (backend.gate) await backend.gate;
    return {
      popularBoardConfigs: {
        configs: [CONFIG],
        hasMore: backend.hasMore,
        totalCount: backend.totalCount,
      },
    };
  },
}));

const { getAllBoardConfigsOrThrow, resetBoardConfigCacheForTests } = await import('../server-popular-configs');

describe('getAllBoardConfigsOrThrow', () => {
  beforeEach(() => {
    // The in-process TTL outlives a test, so without this every case after the
    // first would assert against the previous one's cached answer.
    resetBoardConfigCacheForTests();
    requestedInputs.length = 0;
    backend.hasMore = false;
    backend.totalCount = 51;
    backend.gate = null;
  });

  it('asks for the API cap in one page', () => {
    return getAllBoardConfigsOrThrow().then((configs) => {
      expect(configs).toEqual([CONFIG]);
      expect(requestedInputs[0]).toEqual({ limit: 100, offset: 0 });
    });
  });

  it('throws rather than quietly dropping the tail when the API says there is more', async () => {
    // `limit: 100` is the schema's hard max, so a catalogue that outgrows it can
    // only be reached by paging. Returning the first 100 with a 200 tells Google
    // the rest of the board pages were deleted — the exact failure the shard's
    // 503 doctrine exists to prevent, so this must surface as a throw.
    backend.hasMore = true;
    backend.totalCount = 137;
    await expect(getAllBoardConfigsOrThrow()).rejects.toThrow(/truncated/);
    await expect(getAllBoardConfigsOrThrow()).rejects.toThrow(/137/);
  });

  it('serves a second call from cache instead of re-running the fetch', async () => {
    // #4519: uncached, this ran live on every `/sitemap.xml` miss at ~10s cold
    // and blew the index's 3s per-shard deadline, publishing an index with no
    // boards shard at all.
    await getAllBoardConfigsOrThrow();
    await getAllBoardConfigsOrThrow();
    expect(requestedInputs).toHaveLength(1);
  });

  it('collapses concurrent misses into one fetch', async () => {
    // `unstable_cache` does not deduplicate concurrent misses, and one cold
    // `/sitemap.xml` already calls this twice in parallel — the boards shard and
    // the climbs summary — before a crawl burst piles on.
    let release: () => void = () => {};
    backend.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = [getAllBoardConfigsOrThrow(), getAllBoardConfigsOrThrow(), getAllBoardConfigsOrThrow()];
    release();
    const results = await Promise.all(inFlight);

    expect(requestedInputs).toHaveLength(1);
    for (const configs of results) {
      expect(configs).toEqual([CONFIG]);
    }
  });

  it('does not cache a failure — a poisoned hour of empty sitemaps is worse than a retry', async () => {
    backend.hasMore = true;
    await expect(getAllBoardConfigsOrThrow()).rejects.toThrow(/truncated/);

    backend.hasMore = false;
    await expect(getAllBoardConfigsOrThrow()).resolves.toEqual([CONFIG]);
    expect(requestedInputs).toHaveLength(2);
  });
});
