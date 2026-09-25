/**
 * Wiring tests for the climbQueries.similarClimbs resolver. The underlying
 * findSimilarClimbs helper has its own unit coverage in
 * climb-similarity.test.ts; here we exercise the *router* — which input path
 * runs (climbUuid → DB lookup vs frames → parser), how the excludeUuid is
 * propagated, and how the early-return / invalid-input cases behave.
 *
 * findSimilarClimbs itself is mocked so a regression in its signature would
 * show up here as a call-arg mismatch rather than a DB integration error.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const {
  mockDb,
  mockDbRead,
  findSimilarClimbsMock,
  parseFramesToHoldEntriesMock,
  getMaterializedSimilarClimbsMock,
  hasCatalogQueryAccessMock,
} = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    execute: vi.fn(),
  },
  mockDbRead: { execute: vi.fn() },
  findSimilarClimbsMock: vi.fn(),
  parseFramesToHoldEntriesMock: vi.fn(),
  getMaterializedSimilarClimbsMock: vi.fn(),
  hasCatalogQueryAccessMock: vi.fn(),
}));

vi.mock('../db/client', () => ({ db: mockDb, dbRead: mockDbRead }));

vi.mock('@boardsesh/db/queries', async () => {
  const actual = await vi.importActual<typeof import('@boardsesh/db/queries')>('@boardsesh/db/queries');
  return { ...actual, getMaterializedSimilarClimbs: getMaterializedSimilarClimbsMock };
});

// Only the boolean gate is scripted; `requireCatalogQueryAccess` stays real so
// the frames-only rejection below exercises the actual error.
vi.mock('../graphql/resolvers/social/roles', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/social/roles')>(
    '../graphql/resolvers/social/roles',
  );
  return { ...actual, hasCatalogQueryAccess: hasCatalogQueryAccessMock };
});

vi.mock('../graphql/resolvers/climbs/climb-similarity', async () => {
  // Pull through everything else (CLIMB_DUPLICATE_ERROR_CODE etc.) so other
  // modules that import from this same path are unaffected.
  const actual = await vi.importActual<typeof import('../graphql/resolvers/climbs/climb-similarity')>(
    '../graphql/resolvers/climbs/climb-similarity',
  );
  return {
    ...actual,
    findSimilarClimbs: findSimilarClimbsMock,
    parseFramesToHoldEntries: parseFramesToHoldEntriesMock,
  };
});

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

import { climbQueries } from '../graphql/resolvers/climbs/queries';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: false,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

// The shape varies by select: the board_climb_holds branch yields
// (holdId, holdState) rows; the legacy-frames fallback yields (frames)
// rows. Keep the helper polymorphic so callers can drive either path.
function mockSelectChain(rows: ReadonlyArray<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

describe('climbQueries.similarClimbs — non-admin callers read the materialised index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findSimilarClimbsMock.mockReset();
    getMaterializedSimilarClimbsMock.mockReset();
    getMaterializedSimilarClimbsMock.mockResolvedValue([]);
    hasCatalogQueryAccessMock.mockReset();
    hasCatalogQueryAccessMock.mockResolvedValue(false);
    mockDb.select.mockReset();
  });

  it('serves an anonymous climbUuid lookup from board_climb_neighbors, never the live CTE', async () => {
    const materialised = [{ uuid: 'neighbour', similarity: 0.8 }];
    getMaterializedSimilarClimbsMock.mockResolvedValue(materialised);

    const result = await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 1, climbUuid: 'target', angle: 40, threshold: 0.6, limit: 10 } },
      makeCtx(),
    );

    expect(result).toBe(materialised);
    expect(getMaterializedSimilarClimbsMock).toHaveBeenCalledWith(mockDbRead, {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'target',
      threshold: 0.6,
      limit: 10,
      sizeId: undefined,
      statsAngle: 40,
    });
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('applies the resolver defaults (0.5, 25) on the materialised path', async () => {
    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'tension', layoutId: 9, climbUuid: 'target' } },
      makeCtx(),
    );
    expect(getMaterializedSimilarClimbsMock).toHaveBeenCalledWith(
      mockDbRead,
      expect.objectContaining({ threshold: 0.5, limit: 25, statsAngle: undefined }),
    );
  });

  it('passes a Woods size through and drops it on other boards', async () => {
    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'woods', layoutId: 1, climbUuid: 'target', sizeId: 2 } },
      makeCtx(),
    );
    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 1, climbUuid: 'target', sizeId: 10 } },
      makeCtx(),
    );
    expect(getMaterializedSimilarClimbsMock.mock.calls[0][1]).toMatchObject({ sizeId: 2 });
    expect(getMaterializedSimilarClimbsMock.mock.calls[1][1]).toMatchObject({ sizeId: undefined });
  });

  it('rejects a frames-only lookup for a non-admin: there is no materialised answer for it', async () => {
    await expect(
      climbQueries.similarClimbs({}, { input: { boardType: 'kilter', layoutId: 1, frames: 'p1r12' } }, makeCtx()),
    ).rejects.toThrow('This live catalogue query is limited to admins');
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
    expect(getMaterializedSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('returns [] for a spray wall without touching either path', async () => {
    const result = await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'spray', layoutId: 7, climbUuid: 'wall-climb' } },
      makeCtx({ isAuthenticated: true, userId: 'user-1' }),
    );
    expect(result).toEqual([]);
    expect(getMaterializedSimilarClimbsMock).not.toHaveBeenCalled();
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('answers a frames-only spray lookup with [] rather than an error', async () => {
    expect(
      await climbQueries.similarClimbs({}, { input: { boardType: 'spray', layoutId: 7, frames: 'p1r42' } }, makeCtx()),
    ).toEqual([]);
  });

  it('asks the gate with the board, so a board-scoped admin counts', async () => {
    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'tension', layoutId: 9, climbUuid: 'target' } },
      makeCtx(),
    );
    expect(hasCatalogQueryAccessMock).toHaveBeenCalledWith(expect.anything(), 'tension');
  });
});

describe('climbQueries.similarClimbs — admins keep the live path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findSimilarClimbsMock.mockReset();
    parseFramesToHoldEntriesMock.mockReset();
    findSimilarClimbsMock.mockResolvedValue([]);
    getMaterializedSimilarClimbsMock.mockReset();
    hasCatalogQueryAccessMock.mockReset();
    hasCatalogQueryAccessMock.mockResolvedValue(true);
    mockDb.select.mockReset();
  });

  it('never reads the materialised index', async () => {
    mockDb.select.mockReturnValueOnce(mockSelectChain([{ holdId: 1, holdState: 'STARTING' }]));
    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 8, climbUuid: 'target' } },
      makeCtx(),
    );
    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    expect(getMaterializedSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('looks up Woods physical size from the target climb', async () => {
    mockDb.select.mockReturnValueOnce(mockSelectChain([{ holdId: 0, holdState: 'STARTING' }]));
    mockDb.select.mockReturnValueOnce(mockSelectChain([{ frames: 'p0r4', compatibleSizeIds: [2] }]));
    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'woods', layoutId: 1, climbUuid: 'target' } },
      makeCtx(),
    );
    expect(findSimilarClimbsMock).toHaveBeenCalledWith(expect.objectContaining({ sizeId: 2 }));
  });

  it('does not compare Woods frames across unknown physical sizes', async () => {
    parseFramesToHoldEntriesMock.mockReturnValue([{ holdId: 0, holdState: 'STARTING' }]);
    expect(
      await climbQueries.similarClimbs({}, { input: { boardType: 'woods', layoutId: 1, frames: 'p0r4' } }, makeCtx()),
    ).toEqual([]);
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('rejects invalid board names before reaching the helper', async () => {
    await expect(
      climbQueries.similarClimbs({}, { input: { boardType: 'not-a-board', layoutId: 1, climbUuid: 'x' } }, makeCtx()),
    ).rejects.toThrow();
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('rejects input that supplies neither climbUuid nor frames', async () => {
    // SimilarClimbsInputSchema's refine() requires exactly one — Zod throws.
    await expect(
      climbQueries.similarClimbs({}, { input: { boardType: 'kilter', layoutId: 1 } }, makeCtx()),
    ).rejects.toThrow();
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('accepts angle -5 and forwards it to the similarity helper as statsAngle: -5', async () => {
    // Aurora boards support negative tilt (e.g. grasshopper at -5°). angle is
    // only an optional stats-join key, so a negative value must pass
    // validation and flow straight through to findSimilarClimbs.
    mockDb.select.mockReturnValueOnce(mockSelectChain([{ holdId: 1, holdState: 'STARTING' }]));

    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 8, climbUuid: 'target-uuid', angle: -5 } },
      makeCtx(),
    );

    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    const args = findSimilarClimbsMock.mock.calls[0][0];
    expect(args).toMatchObject({ statsAngle: -5 });
  });

  it('rejects angle -95 before reaching the helper', async () => {
    await expect(
      climbQueries.similarClimbs(
        {},
        { input: { boardType: 'kilter', layoutId: 8, climbUuid: 'target-uuid', angle: -95 } },
        makeCtx(),
      ),
    ).rejects.toThrow();
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('climbUuid path reads the target climbs holds and passes them through with excludeUuid set to the target', async () => {
    mockDb.select.mockReturnValueOnce(
      mockSelectChain([
        { holdId: 4122, holdState: 'STARTING' },
        { holdId: 4182, holdState: 'HAND' },
      ]),
    );

    await climbQueries.similarClimbs(
      {},
      {
        input: {
          boardType: 'kilter',
          layoutId: 8,
          climbUuid: 'target-uuid',
          threshold: 0.7,
          limit: 5,
        },
      },
      makeCtx(),
    );

    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    const args = findSimilarClimbsMock.mock.calls[0][0];
    expect(args).toMatchObject({
      boardType: 'kilter',
      layoutId: 8,
      threshold: 0.7,
      limit: 5,
      // The target climbs uuid must always be excluded from its own similar
      // list — otherwise it would always rank itself at 100% match.
      excludeUuid: 'target-uuid',
    });
    expect(args.holds).toEqual([
      { holdId: 4122, holdState: 'STARTING' },
      { holdId: 4182, holdState: 'HAND' },
    ]);
    // parseFramesToHoldEntries must NOT have been called on the climbUuid path.
    expect(parseFramesToHoldEntriesMock).not.toHaveBeenCalled();
  });

  it('frames path parses the frames input and forwards excludeClimbUuid verbatim', async () => {
    parseFramesToHoldEntriesMock.mockReturnValueOnce([
      { frameNumber: 0, holdId: 9001, holdState: 'STARTING' },
      { frameNumber: 0, holdId: 9002, holdState: 'HAND' },
    ]);

    await climbQueries.similarClimbs(
      {},
      {
        input: {
          boardType: 'tension',
          layoutId: 11,
          frames: 'p9001r1p9002r2',
          excludeClimbUuid: 'caller-supplied-exclude',
        },
      },
      makeCtx(),
    );

    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledWith('tension', 'p9001r1p9002r2');
    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    const args = findSimilarClimbsMock.mock.calls[0][0];
    expect(args).toMatchObject({
      boardType: 'tension',
      layoutId: 11,
      // The frames path keeps the caller-supplied excludeClimbUuid as-is
      // rather than overriding it — there is no candidate uuid to exclude.
      excludeUuid: 'caller-supplied-exclude',
    });
    expect(args.holds).toHaveLength(2);
    // Db.select must NOT have been called on the frames path.
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('short-circuits to an empty array when the target has no holds, without calling the helper', async () => {
    // First select: board_climb_holds lookup → no rows.
    // Second select: legacy frames-fallback on board_climbs → no row.
    // Both empty → resolver returns [] without hitting findSimilarClimbs.
    mockDb.select.mockReturnValueOnce(mockSelectChain([])).mockReturnValueOnce(mockSelectChain([]));

    const result = await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 8, climbUuid: 'empty-uuid' } },
      makeCtx(),
    );

    expect(result).toEqual([]);
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('falls back to parsing board_climbs.frames when board_climb_holds is empty (legacy MoonBoard climbs)', async () => {
    findSimilarClimbsMock.mockResolvedValue([]);
    // First select: board_climb_holds → no rows (legacy state).
    // Second select: board_climbs → returns the frames blob the gate
    // recorded in the legacy import. The resolver should parse that and
    // pass the resulting holds to findSimilarClimbs, so the duplicate
    // drawer doesn't silently surface "no identical climbs" for a match
    // that absolutely exists.
    mockDb.select
      .mockReturnValueOnce(mockSelectChain([]))
      .mockReturnValueOnce(mockSelectChain([{ frames: 'p1r12p2r13' }]));
    parseFramesToHoldEntriesMock.mockReturnValueOnce([
      { frameNumber: 0, holdId: 1, holdState: 'STARTING' },
      { frameNumber: 0, holdId: 2, holdState: 'HAND' },
    ]);

    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'moonboard', layoutId: 1, climbUuid: 'legacy-mb' } },
      makeCtx(),
    );

    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledWith('moonboard', 'p1r12p2r13');
    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    const args = findSimilarClimbsMock.mock.calls[0][0];
    expect(args.holds).toHaveLength(2);
    expect(args.excludeUuid).toBe('legacy-mb');
  });
});
