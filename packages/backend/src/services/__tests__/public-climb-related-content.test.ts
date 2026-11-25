import { describe, expect, it, vi } from 'vite-plus/test';
import type { PublicClimbRelatedContentInput, SimilarClimb } from '@boardsesh/shared-schema';
import {
  PublicClimbRelatedContentService,
  PUBLIC_RELATED_MAX_ACTIVE,
  PUBLIC_RELATED_MAX_MISSES,
  publicRelatedCacheKey,
  publicRelatedNearbyCacheKey,
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
const EMPTY_SNAPSHOT: PublicRelatedSnapshot = { similar: [], nearby: [], nearbyGrade: null };
const NEARBY_POOL: PublicRelatedSnapshot = {
  similar: [],
  nearby: [{ ...CANDIDATE, similarity: 0 }],
  nearbyGrade: null,
};
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
    buildNearby: vi.fn(async () => NEARBY_POOL),
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

  it('keys nearby pools by the complete normalized board configuration and grade band', () => {
    const nearbyInput = {
      boardType: INPUT.boardType,
      layoutId: INPUT.layoutId,
      sizeId: INPUT.sizeId,
      setIds: INPUT.setIds,
      angle: INPUT.angle,
      minGrade: 14,
      maxGrade: 18,
    };
    const key = publicRelatedNearbyCacheKey(nearbyInput);
    expect(key).toBe(publicRelatedNearbyCacheKey({ ...nearbyInput, setIds: [1, 2, 1] }));
    for (const changed of [
      { boardType: 'tension' },
      { layoutId: 2 },
      { sizeId: 11 },
      { setIds: [1] },
      { angle: 30 },
      { minGrade: 13 },
      { maxGrade: 19 },
    ])
      expect(publicRelatedNearbyCacheKey({ ...nearbyInput, ...changed })).not.toBe(key);
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

  it('releases per-climb miss slots before coalescing one nearby pool for four distinct targets', async () => {
    const similar = deferred<PublicRelatedSnapshot>();
    const nearby = deferred<PublicRelatedSnapshot>();
    const { service, dependencies, cache } = setup({
      buildSnapshot: vi.fn(() => similar.promise),
      buildNearby: vi.fn(() => nearby.promise),
    });
    const requests = Array.from({ length: PUBLIC_RELATED_MAX_MISSES }, (_, index) =>
      service.read({ ...INPUT, climbUuid: `target-${index}` }),
    );
    await vi.waitFor(() => expect(service.getStats().misses).toBe(PUBLIC_RELATED_MAX_MISSES));
    similar.resolve(EMPTY_SNAPSHOT);
    await vi.waitFor(() => expect(dependencies.buildNearby).toHaveBeenCalledOnce());
    expect(service.getStats().misses).toBe(1);
    expect(service.getStats().rejected).toBe(0);
    const poolInput = vi.mocked(dependencies.buildNearby).mock.calls[0][0];
    expect(poolInput).not.toHaveProperty('climbUuid');
    nearby.resolve(NEARBY_POOL);
    const results = await Promise.all(requests);
    expect(results.every((result) => result.nearbyStatus === 'loaded')).toBe(true);
    expect(service.getStats().misses).toBe(0);
    // A newly deployed instance reads the pool independently; it never copies
    // those IDs into another per-climb entry with a later weekly expiry.
    const second = new PublicClimbRelatedContentService(dependencies);
    await second.read({ ...INPUT, climbUuid: 'another-target' });
    expect(dependencies.buildNearby).toHaveBeenCalledOnce();
    expect(vi.mocked(dependencies.writeCache).mock.calls.filter(([key]) => key.includes(':nearby:'))).toHaveLength(1);
    expect(cache.get(publicRelatedCacheKey({ ...INPUT, climbUuid: 'another-target' }, TARGET))).toEqual(EMPTY_SNAPSHOT);
  });

  it('falls back after cached similar IDs fail fresh hydration', async () => {
    const { service, dependencies } = setup({
      hydrate: vi.fn<PublicRelatedDependencies['hydrate']>(async (_input, candidates) =>
        candidates.some((candidate) => candidate.similarity === 0) ? [HYDRATED] : [],
      ),
    });
    const response = await service.read(INPUT);
    expect(response.similarClimbs).toEqual([]);
    expect(response.nearbyStatus).toBe('loaded');
    expect(response.nearbyClimbs).toHaveLength(1);
    expect(dependencies.buildNearby).toHaveBeenCalledOnce();
  });

  it('retains one shared nearby miss after callers time out until its real work settles', async () => {
    const nearby = deferred<PublicRelatedSnapshot>();
    const { service, dependencies } = setup(
      {
        buildSnapshot: vi.fn(async () => EMPTY_SNAPSHOT),
        buildNearby: vi.fn(() => nearby.promise),
      },
      5,
    );
    const requests = Array.from({ length: PUBLIC_RELATED_MAX_MISSES }, (_, index) =>
      service.read({ ...INPUT, climbUuid: `target-${index}` }),
    );
    await Promise.all(requests);
    expect(service.getStats().misses).toBe(1);
    expect(service.getStats().active).toBe(PUBLIC_RELATED_MAX_MISSES);
    expect(dependencies.buildNearby).toHaveBeenCalledOnce();
    nearby.resolve(NEARBY_POOL);
    await vi.waitFor(() => expect(service.getStats().active).toBe(0));
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
      buildSnapshot: vi.fn(async () => EMPTY_SNAPSHOT),
      buildNearby: vi.fn(async () => ({ ...EMPTY_SNAPSHOT, nearbyUnavailable: true })),
    });
    const response = await service.read(INPUT);
    expect(response.similarStatus).toBe('loaded');
    expect(response.nearbyStatus).toBe('unavailable');
    expect(vi.mocked(dependencies.writeCache).mock.calls.filter(([key]) => key.includes(':nearby:'))).toHaveLength(0);
    await service.read(INPUT);
    expect(dependencies.buildNearby).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a shared pool cache read fails instead of starting an uncached search', async () => {
    const { service, dependencies } = setup({
      buildSnapshot: vi.fn(async () => EMPTY_SNAPSHOT),
      readCache: vi.fn(async (key) => {
        if (key.includes(':nearby:')) throw new Error('Redis unavailable');
        return EMPTY_SNAPSHOT;
      }),
    });
    const response = await service.read(INPUT);
    expect(response.nearbyStatus).toBe('unavailable');
    expect(response.betaStatus).toBe('loaded');
    expect(dependencies.buildNearby).not.toHaveBeenCalled();
  });
});
