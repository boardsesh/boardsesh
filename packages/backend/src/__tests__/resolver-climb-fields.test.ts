import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// Regression guard: every resolver that returns Climb objects must project the
// same set of board_climbs columns that searchClimbs and getClimb do. The list
// surfaces are not a lesser view of a climb — they open the play drawer with the
// payload they were handed, no refetch, so a column missing here is a feature
// missing on screen.
//
// It covers userFavoriteClimbs, playlistClimbs (specific-board + all-boards via
// hydrateClimbsByRefs), smartPlaylist, setterClimbsFull (both modes) and
// userClimbs.
//
// The field list has now been outgrown three times: framesCount/framesPace
// (multi-frame routes played at the wrong pace), compatibleSizeIds (threaded
// through with no guard at all), and characteristics — whose absence printed
// "Matching rule not recorded" on every Woods climb opened from a list, and
// dropped the no-match glyph on every other board, because the derived
// `Climb.is_no_match` resolver falls back to the Aurora description convention
// when the array is absent (issue #5214). So the guard is a table now: add a
// row, not another copy-pasted describe block.

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../db/client', () => ({ db: mockDb, dbRead: mockDb }));

// `userClimbs` resolves which board to draw each climb on via its own helper,
// which runs its own queries — stub it out so these tests keep driving only the
// climb query's mock. The ladder has its own coverage in @boardsesh/board-config.
vi.mock('../graphql/resolvers/shared/render-board', () => ({
  fetchOwnerBoards: () => Promise.resolve(new Map()),
  toTickBoardCandidate: () => null,
}));

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
      characteristics: 'characteristics',
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
    compatibleSizeIds: [2],
    compatible_size_ids: [2],
    characteristics: ['no_match'],
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

// `verifyPlaylistAccess` is hoisted out of the table below: it is a module mock,
// not per-entry-point priming.
vi.mock('../graphql/resolvers/playlists/helpers/enrichment', () => ({
  verifyPlaylistAccess: vi.fn().mockResolvedValue(BigInt(1)),
}));

// ============================================================
// The contract
// ============================================================

/**
 * Column keys every climb-returning projection must pass to `db.select()`.
 * Snake_case because that is how these resolvers alias board_climbs columns.
 */
const REQUIRED_SELECT_KEYS = ['frames_count', 'frames_pace', 'compatible_size_ids', 'characteristics'] as const;

/**
 * `Climb` fields every mapper must land those columns on, with the value
 * `rawClimbRow()` supplies. Asserted BY VALUE, not by key presence: a mapper
 * that reads the wrong row key still produces the key, just with `null` — which
 * is exactly the shape of the bug this file exists to catch.
 */
const REQUIRED_CLIMB_FIELDS: Record<string, unknown> = {
  framesCount: 3,
  framesPace: 900,
  compatibleSizeIds: [2],
  characteristics: ['no_match'],
};

/**
 * Flatten a Drizzle `sql` template back into its literal text so a raw-SQL entry
 * point can be checked for the columns it selects. Only the string chunks matter
 * — the interpolated params are bind values, never column names.
 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join('');
}

type EntryPoint = {
  name: string;
  /** Prime the db mocks, call the resolver, return the climbs it produced. */
  run: () => Promise<Record<string, unknown>[]>;
  /**
   * Which `db.select()` call carries the climb projection. `null` for a raw-SQL
   * path, which has no projection object — the mapper assertion covers it, driven
   * by an `executeRows` fixture instead.
   */
  dataSelectCallIndex: number | null;
  /**
   * For a raw-SQL entry point: the text of the statement it built, so the guard
   * checks the columns it actually asks Postgres for rather than trusting the
   * fixture. Without this the raw-SQL mapper assertion passes vacuously — the
   * fixture supplies the value whether or not the SELECT still names the column.
   */
  lastSqlText?: () => string;
  /** Extra reset for an entry point that needs a fresh module registry. */
  resetModules?: boolean;
};

/** The last statement `userClimbs` handed to executeRows, for the SQL-text guard. */
let lastUserClimbsSql: unknown;

const ENTRY_POINTS: EntryPoint[] = [
  {
    name: 'userFavoriteClimbs',
    // 0: count, 1: climb data.
    dataSelectCallIndex: 1,
    run: async () => {
      const { favoriteClimbsQuery } = await import('../graphql/resolvers/favorites/favorite-climbs-query');
      mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
      mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));
      const result = await favoriteClimbsQuery.userFavoriteClimbs(
        null,
        { input: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 } },
        makeCtx(),
      );
      return result.climbs as unknown as Record<string, unknown>[];
    },
  },
  {
    // The real-world playlist path: web and mobile always supply boardName, so
    // hydrateClimbsByRefs is only the all-boards fallback.
    name: 'playlistClimbs (specific board)',
    // 0: count, 1: ref page, 2: the hydrator's climb data.
    dataSelectCallIndex: 2,
    run: async () => {
      const { playlistClimbs } = await import('../graphql/resolvers/playlists/queries/playlist-climbs');
      mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
      mockDb.select.mockReturnValueOnce(makeChain([{ climbUuid: 'climb-abc', playlistAngle: 40 }]));
      mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));
      const result = await playlistClimbs(
        null,
        { input: { playlistId: '1', boardName: 'kilter', angle: 40 } },
        makeCtx(),
      );
      return result.climbs as unknown as Record<string, unknown>[];
    },
  },
  {
    // Covers the all-boards playlist path and smartPlaylist, which both hydrate
    // through here.
    name: 'hydrateClimbsByRefs',
    dataSelectCallIndex: 0,
    run: async () => {
      const { hydrateClimbsByRefs } = await import('../graphql/resolvers/playlists/helpers/hydrate-climbs');
      mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));
      const climbs = await hydrateClimbsByRefs([{ climbUuid: 'climb-abc', boardType: 'kilter' }]);
      return climbs as unknown as Record<string, unknown>[];
    },
  },
  {
    name: 'setterClimbsFull (specific board)',
    // 0: count, 1: climb data.
    dataSelectCallIndex: 1,
    run: async () => {
      const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');
      mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
      mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));
      const result = await setterFollowQueries.setterClimbsFull(
        null,
        { input: { username: 'alice', boardType: 'kilter', angle: 40 } },
        makeCtx(),
      );
      return result.climbs as unknown as Record<string, unknown>[];
    },
  },
  {
    name: 'setterClimbsFull (all boards)',
    // 0: distinct board types, 1: count, 2: climb data.
    dataSelectCallIndex: 2,
    run: async () => {
      const { setterFollowQueries } = await import('../graphql/resolvers/social/setter-follows');
      mockDb.select.mockReturnValueOnce(makeChain([{ boardType: 'kilter' }]));
      mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
      mockDb.select.mockReturnValueOnce(makeChain([rawClimbRow()]));
      const result = await setterFollowQueries.setterClimbsFull(null, { input: { username: 'alice' } }, makeCtx());
      return result.climbs as unknown as Record<string, unknown>[];
    },
  },
  {
    name: 'userClimbs',
    // Raw SQL through executeRows: no projection object to inspect, so the
    // fixture below is the only thing standing between a dropped column and a
    // green run. Keep it in sync with REQUIRED_SELECT_KEYS.
    dataSelectCallIndex: null,
    resetModules: true,
    lastSqlText: () => sqlText(lastUserClimbsSql),
    run: async () => {
      const { executeRows } = await import('@boardsesh/db/client');
      const executeRowsMock = executeRows as ReturnType<typeof vi.fn>;
      // 0: linked userBoardMappings, 1: count.
      mockDb.select.mockReturnValueOnce(makeChain([]));
      mockDb.select.mockReturnValueOnce(makeChain([{ count: 1 }]));
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
          compatible_size_ids: [2],
          characteristics: ['no_match'],
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
      lastUserClimbsSql = executeRowsMock.mock.calls.at(-1)?.[1];
      return result.climbs as unknown as Record<string, unknown>[];
    },
  },
];

for (const entryPoint of ENTRY_POINTS) {
  describe(`${entryPoint.name} carries every required climb field`, () => {
    beforeEach(() => {
      mockDb.select.mockReset();
      // A fresh module registry so the dynamic import below picks up a new
      // @boardsesh/db/client mock. executeRows must be imported AFTER the reset;
      // importing it at the top of the file would capture the stale reference.
      if (entryPoint.resetModules) vi.resetModules();
    });

    it('maps every required field onto the returned Climb', async () => {
      const climbs = await entryPoint.run();

      expect(climbs).toHaveLength(1);
      for (const [field, expected] of Object.entries(REQUIRED_CLIMB_FIELDS)) {
        expect(climbs[0][field]).toEqual(expected);
      }
    });

    if (entryPoint.lastSqlText) {
      it('names every required column in both halves of the raw SQL it builds', async () => {
        await entryPoint.run();

        const statement = entryPoint.lastSqlText!();
        expect(statement).not.toBe('');
        for (const column of REQUIRED_SELECT_KEYS) {
          // Both halves, because dropping either one is the bug: `c.<column>` is
          // where the owned_climbs CTE reads it off board_climbs, and
          // `owned_climbs.<column>` is where the outer SELECT carries it out to
          // the mapper. A bare substring check would pass with one of them gone.
          expect(statement).toContain(`c.${column}`);
          expect(statement).toContain(`owned_climbs.${column}`);
        }
      });
    }

    if (entryPoint.dataSelectCallIndex != null) {
      it('projects every required column in the DB select', async () => {
        await entryPoint.run();

        const projection = mockDb.select.mock.calls[entryPoint.dataSelectCallIndex!]?.[0] as
          | Record<string, unknown>
          | undefined;
        expect(Object.keys(projection ?? {})).toEqual(expect.arrayContaining([...REQUIRED_SELECT_KEYS]));
      });
    }
  });
}
