import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

vi.mock('../events/index', () => ({
  publishSocialEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(),
}));

vi.mock('../db/queries/util/table-select', () => ({
  UNIFIED_TABLES: {
    climbs: { uuid: 'uuid', layoutId: 'layoutId', boardType: 'boardType' },
    climbStats: { climbUuid: 'climbUuid', boardType: 'boardType', angle: 'angle' },
    difficultyGrades: { boardType: 'boardType', difficulty: 'difficulty' },
  },
  isValidBoardName: vi.fn().mockReturnValue(true),
}));

vi.mock('../db/queries/util/hold-state', () => ({
  convertLitUpHoldsStringToMap: vi.fn().mockReturnValue([{}]),
}));

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: false,
    userId: null,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

/** Thenable Drizzle chain whose terminal await resolves to `resolveValue`. */
function createMockChain(resolveValue: unknown = []) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'orderBy', 'limit', 'offset'];
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  return chain;
}

const NOW = new Date('2026-06-08T12:00:00Z');

function makeCohortRow(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(1),
    uuid: `pl-${slug}`,
    boardType: 'kilter',
    layoutId: 8,
    name: `${slug} · Kilter Board Homewall 10x12 @ 40°`,
    description: null,
    color: '#d65a4f',
    icon: 'LocalFireDepartmentOutlined',
    createdAt: NOW,
    updatedAt: NOW,
    creatorId: 'system-recommendations',
    creatorName: 'Boardsesh',
    climbCount: 50,
    generatedRecommendation: `kilter:8:25:40:${slug}`,
    ...overrides,
  };
}

const INPUT = { boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 40 };

describe('recommendedPlaylists resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the cohort playlists ordered by variant (crowd-favorites → hidden-gems → fresh)', async () => {
    // Seed deliberately out of order to prove the resolver sorts them.
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        makeCohortRow('fresh', { id: BigInt(3) }),
        makeCohortRow('crowd-favorites', { id: BigInt(1) }),
        makeCohortRow('hidden-gems', { id: BigInt(2) }),
      ]),
    );

    const result = (await playlistQueries.recommendedPlaylists(null, { input: INPUT }, makeCtx())) as Array<{
      uuid: string;
    }>;

    expect(result.map((playlist) => playlist.uuid)).toEqual(['pl-crowd-favorites', 'pl-hidden-gems', 'pl-fresh']);
    // The cohort key is an internal detail — not leaked on the GraphQL shape.
    expect(result[0]).not.toHaveProperty('generatedRecommendation');
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the board config has no generated cohort', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([]));

    const result = await playlistQueries.recommendedPlaylists(
      null,
      { input: { boardType: 'kilter', layoutId: 8, sizeId: 25, angle: 30 } },
      makeCtx(),
    );

    expect(result).toEqual([]);
  });

  it('does not require authentication', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([makeCohortRow('crowd-favorites')]));

    const result = (await playlistQueries.recommendedPlaylists(
      null,
      { input: INPUT },
      makeCtx({ isAuthenticated: false, userId: undefined }),
    )) as unknown[];

    expect(result).toHaveLength(1);
  });
});
