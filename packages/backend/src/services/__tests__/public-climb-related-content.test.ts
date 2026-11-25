import { describe, expect, it, vi } from 'vite-plus/test';
import type { PublicClimbRelatedContentInput, SimilarClimb } from '@boardsesh/shared-schema';
import {
  PublicClimbRelatedContentService,
  PUBLIC_RELATED_MAX_ACTIVE,
  PUBLIC_RELATED_MAX_MISSES,
  publicRelatedCacheKey,
  publicRelatedCacheTtlSeconds,
  type PublicRelatedDependencies,
  type PublicRelatedSnapshot,
} from '../public-climb-related-content';

const INPUT: PublicClimbRelatedContentInput = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: [2, 1],
  angle: 40,
  climbUuid: 'target',
};
const TARGET = { revision: '42', difficulty: 16 };
const CANDIDATE = {
  uuid: 'candidate',
  similarity: 0.8,
  sharedHoldCount: 8,
  candidateHoldCount: 10,
  targetHoldCount: 8,
};
const SNAPSHOT: PublicRelatedSnapshot = { similar: [CANDIDATE], nearby: [], nearbyGrade: null };
const HYDRATED: SimilarClimb = { ...CANDIDATE, name: 'Fresh name', layoutId: 1, compatibleSizeIds: [10] };

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<PublicRelatedDependencies> = {}, deadlineMs = 3000) {
  const cache = new Map<string, PublicRelatedSnapshot>();
  const dependencies: PublicRelatedDependencies = {
    readTarget: vi.fn(async () => TARGET),
    readCache: vi.fn(async (key) => cache.get(key) ?? null),
    writeCache: vi.fn(async (key, snapshot) => {
      cache.set(key, snapshot);
    }),
    buildSnapshot: vi.fn(async () => SNAPSHOT),
    hydrate: vi.fn(async () => [HYDRATED]),
    readBeta: vi.fn(async () => ({ links: [], hasMore: false })),
    reportFailure: vi.fn(),
    ...overrides,
  };
  return { cache, dependencies, service: new PublicClimbRelatedContentService(dependencies, deadlineMs) };
}

describe('public climb related content', () => {
  it('keeps cache keys independent of input object order and duplicate/set order', () => {
    expect(publicRelatedCacheKey(INPUT, TARGET)).toBe(
      publicRelatedCacheKey(
        {
          climbUuid: 'target',
          angle: 40,
          sizeId: 10,
          setIds: [1, 2, 1],
          layoutId: 1,
          boardType: 'kilter',
          includeNearby: true,
        },
        TARGET,
      ),
    );
    expect(publicRelatedCacheKey(INPUT, TARGET)).not.toBe(publicRelatedCacheKey(INPUT, { ...TARGET, revision: '43' }));
    expect(publicRelatedCacheKey(INPUT, TARGET)).not.toBe(publicRelatedCacheKey({ ...INPUT, sizeId: 11 }, TARGET));
    expect(publicRelatedCacheKey(INPUT, TARGET)).not.toBe(publicRelatedCacheKey({ ...INPUT, angle: 30 }, TARGET));
  });

  it('allows weekly or monthly freshness only, rejecting invalid TTL settings safely', () => {
    for (const invalid of [undefined, '', 'NaN', '-1', '999999', 'Infinity', '7.5'])
      expect(publicRelatedCacheTtlSeconds(invalid)).toBe(604800);
    expect(publicRelatedCacheTtlSeconds('7')).toBe(604800);
    expect(publicRelatedCacheTtlSeconds('30')).toBe(2592000);
  });

  it('shares cached IDs across service instances while hydrating current visibility every time', async () => {
    const first = setup();
    expect((await first.service.read(INPUT)).similarClimbs).toEqual([HYDRATED]);
    expect(first.cache.values().next().value).toEqual(SNAPSHOT);
    const second = new PublicClimbRelatedContentService({ ...first.dependencies, hydrate: vi.fn(async () => []) });
    expect((await second.read(INPUT)).similarClimbs).toEqual([]);
    expect(first.dependencies.buildSnapshot).toHaveBeenCalledOnce();
    expect(first.dependencies.readTarget).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first.cache.values().next().value)).not.toContain('Fresh name');
  });

  it('never reads recommendations or beta for a missing/unreadable target or private spray wall', async () => {
    const { service, dependencies } = setup({ readTarget: vi.fn(async () => null) });
    expect((await service.read(INPUT)).similarClimbs).toEqual([]);
    await service.read({ ...INPUT, boardType: 'spray' });
    expect(dependencies.readCache).not.toHaveBeenCalled();
    expect(dependencies.hydrate).not.toHaveBeenCalled();
    expect(dependencies.readBeta).not.toHaveBeenCalled();
    expect(dependencies.readTarget).toHaveBeenCalledOnce();
  });

  it('coalesces same-key cold misses instead of duplicating catalogue reads', async () => {
    const pending = deferred<PublicRelatedSnapshot>();
    const { service, dependencies } = setup({ buildSnapshot: vi.fn(() => pending.promise) });
    const requests = [service.read(INPUT), service.read(INPUT), service.read(INPUT)];
    await vi.waitFor(() => expect(service.getStats().misses).toBe(1));
    expect(dependencies.buildSnapshot).toHaveBeenCalledOnce();
    pending.resolve(SNAPSHOT);
    const results = await Promise.all(requests);
    expect(results.every((result) => result.similarStatus === 'loaded')).toBe(true);
    expect(service.getStats().active).toBe(0);
  });

  it('caps distinct misses and does not retain extra request keys', async () => {
    const pending = deferred<PublicRelatedSnapshot>();
    const { service, dependencies } = setup({ buildSnapshot: vi.fn(() => pending.promise) });
    const requests = Array.from({ length: PUBLIC_RELATED_MAX_MISSES + 1 }, (_, index) =>
      service.read({ ...INPUT, climbUuid: `target-${index}` }),
    );
    await vi.waitFor(() => expect(service.getStats().rejected).toBe(1));
    expect(dependencies.buildSnapshot).toHaveBeenCalledTimes(PUBLIC_RELATED_MAX_MISSES);
    expect(service.getStats().misses).toBe(PUBLIC_RELATED_MAX_MISSES);
    pending.resolve(SNAPSHOT);
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.similarStatus === 'unavailable')).toHaveLength(1);
    expect(service.getStats().misses).toBe(0);
  });

  it('retains real-work admission after response deadlines until underlying reads settle', async () => {
    const pending = deferred<null>();
    const { service, dependencies } = setup({ readTarget: vi.fn(() => pending.promise) }, 5);
    const requests = Array.from({ length: PUBLIC_RELATED_MAX_ACTIVE }, () => service.read(INPUT));
    await Promise.all(requests);
    expect(service.getStats().active).toBe(PUBLIC_RELATED_MAX_ACTIVE);
    expect((await service.read(INPUT)).similarStatus).toBe('unavailable');
    expect(dependencies.readTarget).toHaveBeenCalledTimes(PUBLIC_RELATED_MAX_ACTIVE);
    pending.resolve(null);
    await vi.waitFor(() => expect(service.getStats().active).toBe(0));
  });

  it('degrades a Redis outage without running expensive fallback work, while beta remains available', async () => {
    const { service, dependencies } = setup({
      readCache: vi.fn(async () => {
        throw new Error('Redis unavailable');
      }),
    });
    const response = await service.read(INPUT);
    expect(response.similarStatus).toBe('unavailable');
    expect(response.betaStatus).toBe('loaded');
    expect(dependencies.buildSnapshot).not.toHaveBeenCalled();
    expect(dependencies.hydrate).not.toHaveBeenCalled();
  });

  it('distinguishes failed beta reads from an honestly empty beta list', async () => {
    const { service } = setup({
      readBeta: vi.fn(async () => {
        throw new Error('Database unavailable');
      }),
    });
    const response = await service.read(INPUT);
    expect(response.betaStatus).toBe('unavailable');
    expect(response.similarStatus).toBe('loaded');
  });

  it('reports a failed nearby fallback separately and never caches its failure for a week', async () => {
    const { service, dependencies } = setup({
      buildSnapshot: vi.fn(async () => ({ similar: [], nearby: [], nearbyGrade: '6a/V3', nearbyUnavailable: true })),
    });
    const response = await service.read(INPUT);
    expect(response.similarStatus).toBe('loaded');
    expect(response.nearbyStatus).toBe('unavailable');
    expect(dependencies.writeCache).not.toHaveBeenCalled();
  });
});
