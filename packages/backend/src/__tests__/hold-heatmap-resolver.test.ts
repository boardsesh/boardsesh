import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  getHoldHeatmapData: vi.fn(),
  applyRateLimit: vi.fn(async () => {}),
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
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...actual, applyRateLimit: mocks.applyRateLimit };
});
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => mocks.redisConnected,
    getClients: () => ({ publisher: { get: mocks.publisherGet, set: mocks.publisherSet } }),
  },
}));

import { climbQueries } from '../graphql/resolvers/climbs/queries';

const ctx = { isAuthenticated: false, connectionId: 'heatmap-test' } as unknown as ConnectionContext;
const input = { boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: '2,3,4', angle: 40 };
const stats = [
  {
    holdId: 26,
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
    mocks.getHoldHeatmapData.mockResolvedValue(stats);
    mocks.publisherGet.mockResolvedValue(null);
    mocks.publisherSet.mockResolvedValue('OK');
  });

  it('uses the read client and preserves MoonBoard renderer cell IDs', async () => {
    const result = await climbQueries.holdHeatmap(undefined, { input }, ctx);

    expect(result).toEqual(stats);
    expect(mocks.getHoldHeatmapData).toHaveBeenCalledWith(
      mocks.dbRead,
      { board_name: 'moonboard', layout_id: 2, size_id: 1, set_ids: [2, 3, 4], angle: 40 },
      {},
    );
    expect(result[0]?.holdId).toBe(26);
    expect(mocks.applyRateLimit).toHaveBeenCalledWith(ctx, 30, 'hold-heatmap');
  });

  it('serves a cached narrow payload without querying Postgres', async () => {
    mocks.redisConnected = true;
    mocks.publisherGet.mockResolvedValue(JSON.stringify(stats));

    await expect(climbQueries.holdHeatmap(undefined, { input }, ctx)).resolves.toEqual(stats);
    expect(mocks.getHoldHeatmapData).not.toHaveBeenCalled();
  });

  it('rejects malformed or unbounded set ID lists before querying', async () => {
    await expect(climbQueries.holdHeatmap(undefined, { input: { ...input, setIds: '2,,4' } }, ctx)).rejects.toThrow(
      /invalid input/i,
    );
    await expect(
      climbQueries.holdHeatmap(undefined, { input: { ...input, setIds: '1,'.repeat(300) + '1' } }, ctx),
    ).rejects.toThrow(/invalid input/i);
    expect(mocks.getHoldHeatmapData).not.toHaveBeenCalled();
  });
});
