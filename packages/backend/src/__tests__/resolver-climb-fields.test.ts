import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  buildSchema,
  getNamedType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  type GraphQLObjectType,
  type GraphQLSchema,
} from 'graphql';
import { typeDefs, type ConnectionContext } from '@boardsesh/shared-schema';

// Regression guard: every resolver that returns Climb objects must project the
// same set of board_climbs columns that searchClimbs and getClimb do. The list
// surfaces are not a lesser view of a climb — they open the play drawer with the
// payload they were handed, no refetch, so a column missing here is a feature
// missing on screen.
//
// It covers userFavoriteClimbs, playlistClimbs (specific-board + all-boards via
// hydrateClimbsByRefs), smartPlaylist, setterClimbsFull (both modes) and
// userClimbs. The coverage check at the bottom walks the live schema and fails
// when a new query hands out a Climb without a row here (issue #5263): the table
// only guards the producers someone remembered to list.
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

vi.mock('../db/client', async () => {
  const { playlistOwnership } = await import('@boardsesh/db/schema');
  const mockClient = {
    ...mockDb,
    select: (selection?: Record<string, unknown>) =>
      // These payload/format tests use a public-playlist visitor; membership authorization has real-DB matrix coverage.
      selection?.id === playlistOwnership.id ? makeChain([]) : mockDb.select(selection),
  };
  return { db: mockClient, dbRead: mockClient };
});

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
  const chain = Object.assign(Promise.resolve(rows), {} as Record<string, unknown>);
  const methods = ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset', 'groupBy'];
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
    missingHoldCount: 2,
    missing_hold_count: 2,
    revisionNumber: 4,
    revision_number: 4,
    holdsRevisionNumber: 3,
    holds_revision_number: 3,
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
const REQUIRED_SELECT_KEYS = [
  'frames_count',
  'frames_pace',
  'compatible_size_ids',
  'characteristics',
  // Spray-wall integrity (SW-12, #5445). Dropping it is the same class of bug as
  // `characteristics`: the column is NULL on every catalogue board, so an absent
  // projection is indistinguishable from an intact climb — and a climb that lost
  // three holds, opened from the queue, a playlist or the climb screen, would say
  // it was fine.
  'missing_hold_count',
  // The climb's revision and its holds epoch (#6023). A list row opens the play
  // drawer with the payload it was handed, and the tick logged from there sends
  // `revisionNumber` back, so a projection that drops it leaves that tick to the
  // server's by-date guess.
  'revision_number',
  'holds_revision_number',
] as const;

/**
 * Projection keys that are NOT board_climbs columns, so they are checked in the
 * Drizzle projections only: the raw-SQL guard below asserts its columns against
 * the `c.` / `owned_climbs.` spellings of the owned_climbs CTE, and `statsAngle`
 * comes off the joined stats row instead (`best.angle AS stats_angle`), which
 * that guard checks separately.
 */
const REQUIRED_STATS_SELECT_KEYS = ['statsAngle'] as const;

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
  // How many of the climb's holds have come off the wall. 2 rather than 0 in the
  // fixture on purpose: 0 and "the mapper never wrote the field" both read as
  // falsy, so a zero would make this assertion pass for a projection that dropped
  // the column.
  missingHoldCount: 2,
  // Two different numbers, and neither of them 1: the column default is 1, so a
  // fixture of 1 would pass for a mapper that crossed the two or invented one.
  revisionNumber: 4,
  holdsRevisionNumber: 3,
  // Where the stats on this row were read from (issue #5405). On an angle-bound
  // board it is not the browsed angle, and a list row that drops it leaves the
  // play drawer unable to say the grade beside it belongs to another angle.
  statsAngle: 40,
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
          missing_hold_count: 2,
          revision_number: 4,
          holds_revision_number: 3,
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
        // `stats_angle` is aliased out of the best_angle CTE, not off board_climbs,
        // so it gets its own spelling rather than the two-halves check below.
        expect(statement).toContain('AS stats_angle');
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
        expect(Object.keys(projection ?? {})).toEqual(
          expect.arrayContaining([...REQUIRED_SELECT_KEYS, ...REQUIRED_STATS_SELECT_KEYS]),
        );
      });
    }
  });
}

// ============================================================
// Coverage: every root that hands out a Climb has a row above
// ============================================================
//
// The table only guards producers somebody remembered to add. A new query whose
// mapper never reads `characteristics` compiles clean, and `Climb.is_no_match`
// quietly falls back to the description (issue #5263). So the live schema decides
// which roots need a row, not this file.

/**
 * Field edges the walk does not follow, each with the guard that covers it
 * instead. A queue item's climb is the client's own ClimbInput, stored and echoed
 * back, not a board_climbs projection.
 */
const NON_PROJECTION_CLIMB_EDGES: Record<string, string> = {
  'ClimbQueueItem.climb': 'client-supplied ClimbInput, pinned by queue-climb-field-contract.test.ts',
};

/**
 * Which ENTRY_POINTS rows exercise a root's producers, or, for the two reference
 * projections every row is measured against, the guard that covers them.
 */
type ClimbRootCoverage = { entryPoints: string[] } | { reference: string };

const CLIMB_ROOT_COVERAGE: Record<string, ClimbRootCoverage> = {
  'Query.searchClimbs': {
    reference:
      '@boardsesh/db search: ClimbRow requires `characteristics`, and search-climbs.test.ts pins the outer SELECT to statsDrivenClimbFields()',
  },
  'Query.climb': {
    reference: 'getClimbByUuid: a typed drizzle select, so a dropped column fails to compile in the mapper',
  },
  'Query.userFavoriteClimbs': { entryPoints: ['userFavoriteClimbs'] },
  'Query.playlistClimbs': { entryPoints: ['playlistClimbs (specific board)', 'hydrateClimbsByRefs'] },
  'Query.smartPlaylist': { entryPoints: ['hydrateClimbsByRefs'] },
  'Query.setterClimbsFull': { entryPoints: ['setterClimbsFull (specific board)', 'setterClimbsFull (all boards)'] },
  'Query.userClimbs': { entryPoints: ['userClimbs'] },
};

/**
 * `Root.field` for every Query / Mutation / Subscription field whose result can
 * hold a `Climb`, through any depth of object fields, lists, unions and
 * interfaces.
 *
 * Reachability is worked backwards from `Climb` over the whole type graph rather
 * than by a memoised descent from each root: the schema has cycles, and a descent
 * records a type as "no Climb" when its only way back runs through a type still
 * on the stack — so one root would hide another depending on field order.
 */
function rootFieldsReturningClimb(schema: GraphQLSchema, skippedEdges: ReadonlySet<string>): string[] {
  const rootTypes = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].filter(
    (rootType): rootType is GraphQLObjectType => rootType != null,
  );
  const rootTypeNames = new Set(rootTypes.map((rootType) => rootType.name));

  // Child type name → the type names that can hand it out. Root types are left
  // out on both ends: their fields are read directly below.
  const parentsByChild = new Map<string, Set<string>>();
  const addEdge = (parentName: string, childName: string) => {
    if (rootTypeNames.has(parentName) || rootTypeNames.has(childName)) return;
    const parentNames = parentsByChild.get(childName) ?? new Set<string>();
    parentNames.add(parentName);
    parentsByChild.set(childName, parentNames);
  };

  for (const namedType of Object.values(schema.getTypeMap())) {
    if (namedType.name.startsWith('__')) continue;
    if (isObjectType(namedType) || isInterfaceType(namedType)) {
      for (const field of Object.values(namedType.getFields())) {
        if (skippedEdges.has(`${namedType.name}.${field.name}`)) continue;
        addEdge(namedType.name, getNamedType(field.type).name);
      }
    }
    if (isUnionType(namedType) || isInterfaceType(namedType)) {
      for (const memberType of schema.getPossibleTypes(namedType)) addEdge(namedType.name, memberType.name);
    }
  }

  const typesReachingClimb = new Set<string>(['Climb']);
  const pendingTypeNames = ['Climb'];
  while (pendingTypeNames.length > 0) {
    const childName = pendingTypeNames.pop()!;
    for (const parentName of parentsByChild.get(childName) ?? []) {
      if (typesReachingClimb.has(parentName)) continue;
      typesReachingClimb.add(parentName);
      pendingTypeNames.push(parentName);
    }
  }

  return rootTypes
    .flatMap((rootType) =>
      Object.values(rootType.getFields())
        .filter(
          (field) =>
            !skippedEdges.has(`${rootType.name}.${field.name}`) &&
            typesReachingClimb.has(getNamedType(field.type).name),
        )
        .map((field) => `${rootType.name}.${field.name}`),
    )
    .sort();
}

describe('every GraphQL root that returns a Climb has a row in ENTRY_POINTS (#5263)', () => {
  const skippedEdges = new Set(Object.keys(NON_PROJECTION_CLIMB_EDGES));

  it('hands out Climb from exactly the roots in CLIMB_ROOT_COVERAGE', () => {
    const roots = rootFieldsReturningClimb(buildSchema(typeDefs.join('\n')), skippedEdges);

    expect(
      roots,
      'A query now returns Climb without a row here. Add an ENTRY_POINTS row that drives its ' +
        'producer, then list the root in CLIMB_ROOT_COVERAGE. Remove a root only once the schema dropped it.',
    ).toEqual(Object.keys(CLIMB_ROOT_COVERAGE).sort());
  });

  it('names only ENTRY_POINTS rows that exist', () => {
    const entryPointNames = new Set(ENTRY_POINTS.map((entryPoint) => entryPoint.name));

    for (const [rootField, coverage] of Object.entries(CLIMB_ROOT_COVERAGE)) {
      if ('reference' in coverage) continue;
      expect(coverage.entryPoints.length, `${rootField} names no ENTRY_POINTS row`).toBeGreaterThan(0);
      for (const entryPointName of coverage.entryPoints) {
        expect(entryPointNames.has(entryPointName), `${rootField} → missing ENTRY_POINTS row "${entryPointName}"`).toBe(
          true,
        );
      }
    }
  });

  // The two tests above pass on a walker that finds nothing new, so prove it
  // finds a Climb wherever a real one could hide.
  it('finds a Climb behind a new root, through lists, unions and cycles, and skips the queue edge', () => {
    const probeTypeDefs = /* GraphQL */ `
      union ClimbProducerProbeResult = PlaylistClimbsResult | QueueState

      type ClimbProducerProbeCycleA {
        back: ClimbProducerProbeCycleB
        climbs: PlaylistClimbsResult
      }

      type ClimbProducerProbeCycleB {
        forward: ClimbProducerProbeCycleA
      }

      extend type Query {
        climbProducerProbeDirect: PlaylistClimbsResult!
        climbProducerProbeThroughUnion: [ClimbProducerProbeResult!]!
        climbProducerProbeCycleEntry: ClimbProducerProbeCycleA
        climbProducerProbeCycleBack: ClimbProducerProbeCycleB
        climbProducerProbeQueueOnly: QueueState
      }

      extend type Mutation {
        climbProducerProbeBareClimb: Climb
      }
    `;
    const roots = rootFieldsReturningClimb(buildSchema([...typeDefs, probeTypeDefs].join('\n')), skippedEdges);

    expect(roots).toEqual(
      expect.arrayContaining([
        ...Object.keys(CLIMB_ROOT_COVERAGE),
        'Query.climbProducerProbeDirect',
        'Query.climbProducerProbeThroughUnion',
        'Query.climbProducerProbeCycleEntry',
        'Query.climbProducerProbeCycleBack',
        'Mutation.climbProducerProbeBareClimb',
      ]),
    );
    // A queue state reaches Climb only through ClimbQueueItem.climb, which is skipped.
    expect(roots).not.toContain('Query.climbProducerProbeQueueOnly');
  });
});
