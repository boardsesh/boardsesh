// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * MoonBoard `/list` front doors used to bypass the data cache entirely, so every
 * crawled page was a live search against the biggest board in the catalogue.
 * The bypass now only applies when the caller has NOT asked for caching
 * explicitly — and `fetchFrontDoorListPage` is the only caller that does.
 *
 * `unstable_cache` is mocked with a *memoising* recorder rather than the
 * identity stub used elsewhere: an identity stub cannot tell a cached call from
 * an uncached one, which is exactly what this test is about.
 */
const { searchExecutions, cacheStore } = vi.hoisted(() => ({
  searchExecutions: { count: 0 },
  cacheStore: new Map<string, unknown>(),
}));

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  unstable_cache:
    <T extends (...args: unknown[]) => Promise<unknown>>(fn: T, keyParts: string[]) =>
    async (...args: Parameters<T>) => {
      const key = `${keyParts.join('|')}::${JSON.stringify(args)}`;
      if (!cacheStore.has(key)) {
        cacheStore.set(key, await fn(...args));
      }
      return cacheStore.get(key);
    },
}));

vi.mock('@/app/lib/db/db', () => ({
  getReadDb: vi.fn(() => ({})),
}));

vi.mock('@boardsesh/db/queries', () => ({
  searchClimbs: vi.fn(async () => {
    searchExecutions.count += 1;
    return { climbs: [], hasMore: false };
  }),
  mapSearchInputToParams: vi.fn((input: unknown) => input),
}));

import { cachedSearchClimbs } from '../search-climbs';
import type { ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';

const moonboardParams: ParsedBoardRouteParameters = {
  board_name: 'moonboard',
  layout_id: 3,
  size_id: 1,
  set_ids: [1],
  angle: 40,
};

const searchParams = { page: 0, pageSize: 50 } as SearchRequestPagination;

describe('cachedSearchClimbs — MoonBoard front-door caching', () => {
  beforeEach(() => {
    searchExecutions.count = 0;
    cacheStore.clear();
  });

  it('caches a MoonBoard search the front door asked to cache', async () => {
    await cachedSearchClimbs(moonboardParams, searchParams, true, undefined, { cacheable: true });
    await cachedSearchClimbs(moonboardParams, searchParams, true, undefined, { cacheable: true });

    expect(searchExecutions.count).toBe(1);
  });

  it('still bypasses the cache for MoonBoard when the caller did not ask for it', async () => {
    await cachedSearchClimbs(moonboardParams, searchParams, true);
    await cachedSearchClimbs(moonboardParams, searchParams, true);

    expect(searchExecutions.count).toBe(2);
  });

  it('still bypasses the cache when the caller opts out explicitly', async () => {
    await cachedSearchClimbs(moonboardParams, searchParams, true, undefined, { cacheable: false });
    await cachedSearchClimbs(moonboardParams, searchParams, true, undefined, { cacheable: false });

    expect(searchExecutions.count).toBe(2);
  });

  it('still bypasses the cache for a personalised search', async () => {
    await cachedSearchClimbs(moonboardParams, searchParams, true, 'user-1');
    await cachedSearchClimbs(moonboardParams, searchParams, true, 'user-1');

    expect(searchExecutions.count).toBe(2);
  });

  it('keeps the random-sort bypass even when the front door asks for caching', async () => {
    const randomParams = { ...searchParams, sortBy: 'random', sortSeed: '12345' } as SearchRequestPagination;

    await cachedSearchClimbs(moonboardParams, randomParams, false, undefined, { cacheable: true });
    await cachedSearchClimbs(moonboardParams, randomParams, false, undefined, { cacheable: true });

    expect(searchExecutions.count).toBe(2);
  });

  it('leaves the non-MoonBoard front door caching as it was', async () => {
    const kilterParams: ParsedBoardRouteParameters = { ...moonboardParams, board_name: 'kilter' };

    await cachedSearchClimbs(kilterParams, searchParams, true, undefined, { cacheable: true });
    await cachedSearchClimbs(kilterParams, searchParams, true, undefined, { cacheable: true });

    expect(searchExecutions.count).toBe(1);
  });
});
