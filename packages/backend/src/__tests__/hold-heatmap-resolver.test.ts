/**
 * The holdHeatmap resolver: the admin gate, the ClimbSearchInput → route/search
 * params mapping (the same conversion searchClimbs makes), the cache key and the
 * spray-privacy guard. The aggregate itself is mocked; its row normalisation is
 * covered at the bottom.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ClimbSearchInput, ConnectionContext } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  getHoldHeatmapData: vi.fn(),
  hasAdmin: vi.fn(),
  applyRateLimit: vi.fn(async () => {}),
  sprayReadable: vi.fn(),
  publisherGet: vi.fn(),
  publisherSet: vi.fn(),
  redisConnected: false,
  dbRead: { marker: 'read-replica' },
}));

vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return { ...actual, getHoldHeatmapData: mocks.getHoldHeatmapData };
});
vi.mock('../db/client', () => ({ db: {}, dbRead: mocks.dbRead }));
vi.mock('../graphql/resolvers/social/roles', () => ({ hasAdmin: mocks.hasAdmin }));
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...actual, applyRateLimit: mocks.applyRateLimit };
});
vi.mock('../graphql/resolvers/climbs/spray-read-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/climbs/spray-read-access')>();
  return { ...actual, sprayLayoutIsReadableWithCapability: mocks.sprayReadable };
});
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => mocks.redisConnected,
    getClients: () => ({ publisher: { get: mocks.publisherGet, set: mocks.publisherSet } }),
  },
}));

import { climbQueries, holdHeatmapCacheKey } from '../graphql/resolvers/climbs/queries';
import { normalizeHoldHeatmapRow } from '@boardsesh/db/queries';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'heatmap-test',
    isAuthenticated: true,
    userId: 'admin-1',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

const input: ClimbSearchInput = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  minGrade: 16,
  maxGrade: 20,
  minAscents: 5,
};

const stats = [
  {
    holdId: 1133,
    totalUses: 12,
    startingUses: 4,
    handUses: 8,
    footUses: 0,
    finishUses: 0,
    totalAscents: 33,
    averageDifficulty: 17.5,
  },
];

describe('holdHeatmap resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisConnected = false;
    mocks.hasAdmin.mockResolvedValue(true);
    mocks.sprayReadable.mockResolvedValue(true);
    mocks.getHoldHeatmapData.mockResolvedValue(stats);
    mocks.publisherGet.mockResolvedValue(null);
    mocks.publisherSet.mockResolvedValue('OK');
  });

  it('refuses an anonymous caller before any query', async () => {
    await expect(
      climbQueries.holdHeatmap(undefined, { input }, makeCtx({ isAuthenticated: false, userId: undefined })),
    ).rejects.toThrow(/authenticat/i);
    expect(mocks.hasAdmin).not.toHaveBeenCalled();
    expect(mocks.getHoldHeatmapData).not.toHaveBeenCalled();
  });

  it('refuses a signed-in climber without an admin role', async () => {
    mocks.hasAdmin.mockResolvedValue(false);

    await expect(climbQueries.holdHeatmap(undefined, { input }, makeCtx({ userId: 'climber-1' }))).rejects.toThrow(
      /admin role required/i,
    );
    expect(mocks.hasAdmin).toHaveBeenCalledWith('climber-1', 'kilter');
    expect(mocks.getHoldHeatmapData).not.toHaveBeenCalled();
  });

  it('maps the search input the way searchClimbs does and reads the replica', async () => {
    const ctx = makeCtx();
    const result = await climbQueries.holdHeatmap(undefined, { input }, ctx);

    expect(result).toEqual(stats);
    expect(mocks.applyRateLimit).toHaveBeenCalledWith(ctx, 30, 'hold-heatmap');
    expect(mocks.getHoldHeatmapData).toHaveBeenCalledTimes(1);
    const [client, params, searchParams, userId] = mocks.getHoldHeatmapData.mock.calls[0];
    expect(client).toBe(mocks.dbRead);
    expect(params).toEqual({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20], angle: 40 });
    expect(searchParams).toMatchObject({ minGrade: 16, maxGrade: 20, minAscents: 5 });
    // No personal filter → no user id, so the aggregate is the anonymous one.
    expect(userId).toBeUndefined();
  });

  it('passes the caller for personal-progress filters', async () => {
    await climbQueries.holdHeatmap(undefined, { input: { ...input, hideAttempted: true } }, makeCtx());
    expect(mocks.getHoldHeatmapData.mock.calls[0][3]).toBe('admin-1');
  });

  it('serves a cached aggregate without querying Postgres', async () => {
    mocks.redisConnected = true;
    mocks.publisherGet.mockResolvedValue(JSON.stringify(stats));

    await expect(climbQueries.holdHeatmap(undefined, { input }, makeCtx())).resolves.toEqual(stats);
    expect(mocks.getHoldHeatmapData).not.toHaveBeenCalled();
  });

  it('caches a fresh aggregate for five minutes', async () => {
    mocks.redisConnected = true;

    await climbQueries.holdHeatmap(undefined, { input }, makeCtx());
    expect(mocks.publisherSet).toHaveBeenCalledWith(
      holdHeatmapCacheKey(input, undefined),
      JSON.stringify(stats),
      'EX',
      300,
    );
  });

  it('keys the cache on filters, not on sort or page', () => {
    const base = holdHeatmapCacheKey(input, undefined);
    expect(holdHeatmapCacheKey({ ...input, sortBy: 'quality', page: 3, pageSize: 50 }, undefined)).toBe(base);
    expect(holdHeatmapCacheKey({ ...input, minGrade: 17 }, undefined)).not.toBe(base);
    expect(holdHeatmapCacheKey(input, 'admin-1')).not.toBe(base);
  });

  it('answers an unreadable spray wall with nothing, uncached', async () => {
    mocks.redisConnected = true;
    mocks.sprayReadable.mockResolvedValue(false);

    await expect(
      climbQueries.holdHeatmap(undefined, { input: { ...input, boardName: 'spray', layoutId: 9001 } }, makeCtx()),
    ).resolves.toEqual([]);
    expect(mocks.getHoldHeatmapData).not.toHaveBeenCalled();
    expect(mocks.publisherGet).not.toHaveBeenCalled();
  });
});

describe('normalizeHoldHeatmapRow', () => {
  it('turns Postgres bigint/numeric text into numbers and keeps a null average', () => {
    expect(
      normalizeHoldHeatmapRow({
        holdId: '26',
        totalUses: '12',
        startingUses: '4',
        handUses: '8',
        footUses: null,
        finishUses: '0',
        totalAscents: '33',
        averageDifficulty: null,
      }),
    ).toEqual({
      holdId: 26,
      totalUses: 12,
      startingUses: 4,
      handUses: 8,
      footUses: 0,
      finishUses: 0,
      totalAscents: 33,
      averageDifficulty: null,
    });
    expect(normalizeHoldHeatmapRow({ holdId: 1, averageDifficulty: '17.25' }).averageDifficulty).toBe(17.25);
  });
});
