import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// Regression guard: every resolver that returns Climb objects must surface
// framesCount/framesPace so multi-frame Aurora routes/circuits play at their
// authored pace. This file covers the entry points fixed alongside
// searchClimbs/getClimb: userFavoriteClimbs, playlistClimbs/smartPlaylist
// (via hydrateClimbsByRefs), and setterClimbsFull/userClimbs.

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../db/client', () => ({ db: mockDb, dbRead: mockDb }));

// executeRows (used by userClimbs) lives in @boardsesh/db/client.
vi.mock('@boardsesh/db/client', () => ({
  executeRows: vi.fn(),
}));

vi.mock('../db/queries/util/table-select', () => ({
  UNIFIED_TABLES: {
    climbs: {
      uuid: 'uuid',
      layoutId: 'layoutId',
      boardType: 'boardType',
      setterUsername: 'setterUsername',
      name: 'name',
      description: 'description',
      frames: 'frames',
      framesCount: 'framesCount',
      framesPace: 'framesPace',
      createdAt: 'createdAt',
      isDraft: 'isDraft',
      userId: 'userId',
      isListed: 'isListed',
      compatibleSizeIds: 'compatibleSizeIds',
    },
    climbStats: {
      climbUuid: 'climbUuid',
      boardType: 'boardType',
      angle: 'angle',
      ascensionistCount: 'ascensionistCount',
      qualityAverage: 'qualityAverage',
      difficultyAverage: 'difficultyAverage',
      displayDifficulty: 'displayDifficulty',
      benchmarkDifficulty: 'benchmarkDifficulty',
    },
  },
  isValidBoardName: vi.fn().mockReturnValue(true),
}));

vi.mock('../events/index', () => ({ publishSocialEvent: vi.fn() }));
vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), applyRateLimit: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn() }));

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: 'user-123',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

function makeChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset', 'groupBy'];
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  return chain;
}

function rawClimbRow(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'climb-abc',
    climbUuid: 'climb-abc',
    layoutId: 1,
    boardType: 'kilter',
    setterUsername: 'alice',
    setter_username: 'alice',
    name: 'Multi-Frame Route',
    description: '',
    frames: 'p1r1,p2r1',
    framesCount: 3,
    framesPace: 900,
    frames_count: 3,
    frames_pace: 900,
    statsAngle: 40,
    angle: 40,
    ascensionistCount: 5,
    ascensionist_count: '5',
    displayDifficulty: 20,
    difficulty_id: 20,
    qualityAverage: 4.5,
    quality_average: 4.5,
    difficultyAverage: 20.1,
    difficulty_error: 0.1,
    benchmarkDifficulty: null,
    benchmark_difficulty: null,
    createdAt: null,
    favoritedAt: null,
    climbUuid_fav: 'climb-abc',
    ...overrides,
  };
}

// ============================================================
// userFavoriteClimbs
// ============================================================

describe('userFavoriteClimbs surfaces framesCount/framesPace', () => {
  beforeEach(() => mockDb.select.mockReset());

  it('maps frames_count/frames_pace from DB into framesCount/framesPace', async () => {
    const { favoriteClimbsQuery } = await import('../graphql/resolvers/favorites/favorite-climbs-query');

    // First select: count query
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    // Second select: climb data
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    const result = await favoriteClimbsQuery.userFavoriteClimbs(
      null,
      { input: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 } },
      makeCtx(),
    );

    expect(result.climbs[0].framesCount).toBe(3);
    expect(result.climbs[0].framesPace).toBe(900);
  });

  it('passes framesCount/framesPace columns to the DB select', async () => {
    const { favoriteClimbsQuery } = await import('../graphql/resolvers/favorites/favorite-climbs-query');

    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    await favoriteClimbsQuery.userFavoriteClimbs(
      null,
      { input: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 } },
      makeCtx(),
    );

    // Second call is the data select; first arg is the projection object
    const dataSelectArg = mockDb.select.mock.calls[1]?.[0] as Record<string, unknown> | undefined;
    const keys = dataSelectArg ? Object.keys(dataSelectArg) : [];
    expect(keys).toContain('frames_count');
    expect(keys).toContain('frames_pace');
  });
});

// ============================================================
// playlistClimbs — fetchSpecificBoardClimbs (the real-world path:
// web + mobile always supply boardName, so hydrateClimbsByRefs is
// only the all-boards fallback; this is the broken path identified
// in the PR review)
// ============================================================

vi.mock('../graphql/resolvers/playlists/helpers/enrichment', () => ({
  verifyPlaylistAccess: vi.fn().mockResolvedValue(BigInt(1)),
}));

describe('playlistClimbs (specific-board) surfaces framesCount/framesPace', () => {
  beforeEach(() => mockDb.select.mockReset());

  it('maps frame fields from fetchSpecificBoardClimbs', async () => {
    const { playlistClimbs } = await import('../graphql/resolvers/playlists/queries/playlist-climbs');

    // count query
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    // climb data (fetchSpecificBoardClimbs)
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    const result = await playlistClimbs(
      null,
      { input: { playlistId: '1', boardName: 'kilter', angle: 40 } },
      makeCtx(),
    );

    expect(result.climbs[0].framesCount).toBe(3);
    expect(result.climbs[0].framesPace).toBe(900);
  });

  it('passes framesCount/framesPace columns to the DB select', async () => {
    const { playlistClimbs } = await import('../graphql/resolvers/playlists/queries/playlist-climbs');

    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    await playlistClimbs(null, { input: { playlistId: '1', boardName: 'kilter', angle: 40 } }, makeCtx());

    const dataSelectArg = mockDb.select.mock.calls[1]?.[0] as Record<string, unknown> | undefined;
    const keys = dataSelectArg ? Object.keys(dataSelectArg) : [];
    expect(keys).toContain('frames_count');
    expect(keys).toContain('frames_pace');
  });
});

// ============================================================
// hydrateClimbsByRefs (covers the all-boards playlist path +
// smartPlaylist)
// ============================================================

describe('hydrateClimbsByRefs surfaces framesCount/framesPace', () => {
  beforeEach(() => mockDb.select.mockReset());

  it('maps frame fields into Climb objects', async () => {
    const { hydrateClimbsByRefs } = await import('../graphql/resolvers/playlists/helpers/hydrate-climbs');

    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    const climbs = await hydrateClimbsByRefs([{ climbUuid: 'climb-abc', boardType: 'kilter' }]);

    expect(climbs[0].framesCount).toBe(3);
    expect(climbs[0].framesPace).toBe(900);
  });

  it('passes framesCount/framesPace columns to the DB select', async () => {
    const { hydrateClimbsByRefs } = await import('../graphql/resolvers/playlists/helpers/hydrate-climbs');

    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    await hydrateClimbsByRefs([{ climbUuid: 'climb-abc', boardType: 'kilter' }]);

    const selectArg = mockDb.select.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const keys = selectArg ? Object.keys(selectArg) : [];
    expect(keys).toContain('frames_count');
    expect(keys).toContain('frames_pace');
  });
});

// ============================================================
// setterClimbsFull — specific-board mode
// ============================================================

describe('setterClimbsFull (specific board) surfaces framesCount/framesPace', () => {
  beforeEach(() => mockDb.select.mockReset());

  it('maps frame fields in specific-board mode', async () => {
    const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');

    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    const result = await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: 'alice', boardType: 'kilter', angle: 40 } },
      makeCtx(),
    );

    expect(result.climbs[0].framesCount).toBe(3);
    expect(result.climbs[0].framesPace).toBe(900);
  });

  it('passes framesCount/framesPace columns to the DB select in specific-board mode', async () => {
    const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');

    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: 'alice', boardType: 'kilter', angle: 40 } },
      makeCtx(),
    );

    const dataSelectArg = mockDb.select.mock.calls[1]?.[0] as Record<string, unknown> | undefined;
    const keys = dataSelectArg ? Object.keys(dataSelectArg) : [];
    expect(keys).toContain('frames_count');
    expect(keys).toContain('frames_pace');
  });
});

// ============================================================
// setterClimbsFull — all-boards mode
// ============================================================

describe('setterClimbsFull (all-boards) surfaces framesCount/framesPace', () => {
  beforeEach(() => mockDb.select.mockReset());

  it('maps frame fields in all-boards mode', async () => {
    const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');

    // 1: distinct board types
    mockDb.select.mockReturnValueOnce(makeChain([{ boardType: 'kilter' }]));
    // 2: total count
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    // 3: climb data
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    const result = await setterFollowQueries.setterClimbsFull(null, { input: { username: 'alice' } }, makeCtx());

    expect(result.climbs[0].framesCount).toBe(3);
    expect(result.climbs[0].framesPace).toBe(900);
  });

  it('passes framesCount/framesPace columns to the DB select in all-boards mode', async () => {
    const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');

    mockDb.select.mockReturnValueOnce(makeChain([{ boardType: 'kilter' }]));
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));

    await setterFollowQueries.setterClimbsFull(null, { input: { username: 'alice' } }, makeCtx());

    const dataSelectArg = mockDb.select.mock.calls[2]?.[0] as Record<string, unknown> | undefined;
    const keys = dataSelectArg ? Object.keys(dataSelectArg) : [];
    expect(keys).toContain('frames_count');
    expect(keys).toContain('frames_pace');
  });
});

// ============================================================
// userClimbs (raw SQL path via executeRows)
// ============================================================

describe('userClimbs surfaces framesCount/framesPace', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
    // vi.resetModules() re-registers the mock for @boardsesh/db/client so the
    // dynamic import below picks up a fresh mock instance. executeRows must be
    // imported AFTER resetModules so it resolves to the new mock; importing it
    // at the top of the file would capture the stale pre-reset reference.
    vi.resetModules();
  });

  it('maps frames_count/frames_pace from raw SQL rows', async () => {
    const { executeRows } = await import('@boardsesh/db/client');
    const executeRowsMock = executeRows as ReturnType<typeof vi.fn>;

    // First call: linked userBoardMappings (db.select)
    mockDb.select.mockReturnValueOnce(makeChain([]));
    // Second call: count (db.select)
    mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
    // executeRows call: the raw SQL CTE that returns climb rows
    executeRowsMock.mockResolvedValueOnce([
      {
        uuid: 'climb-abc',
        layout_id: 1,
        board_type: 'kilter',
        setter_username: 'alice',
        name: 'Multi-Frame',
        description: '',
        frames: 'p1r1,p2r1',
        frames_count: 3,
        frames_pace: 900,
        stats_angle: 40,
        ascensionist_count: 5,
        difficulty_id: 20,
        quality_average: 4.5,
        difficulty_error: 0.1,
        benchmark_difficulty: null,
      },
    ]);

    const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');

    const result = await setterFollowQueries.userClimbs(null, { input: { userId: 'user-123' } }, makeCtx());

    expect(result.climbs[0].framesCount).toBe(3);
    expect(result.climbs[0].framesPace).toBe(900);
  });
});
