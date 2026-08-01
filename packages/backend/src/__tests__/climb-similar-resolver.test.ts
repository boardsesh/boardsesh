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

const { mockDb, findSimilarClimbsMock, parseFramesToHoldEntriesMock } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    execute: vi.fn(),
  },
  findSimilarClimbsMock: vi.fn(),
  parseFramesToHoldEntriesMock: vi.fn(),
}));

vi.mock('../db/client', () => ({ db: mockDb }));

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

// The joined target rows vary by fixture: materialized holds populate the hold
// columns, while missing materialized holds leave those columns null.
function mockSelectChain(rows: ReadonlyArray<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'leftJoin', 'where']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

describe('climbQueries.similarClimbs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findSimilarClimbsMock.mockReset();
    parseFramesToHoldEntriesMock.mockReset();
    findSimilarClimbsMock.mockResolvedValue([]);
    mockDb.select.mockReset();
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
    const selectChain = mockSelectChain([
      { frames: 'p4122r42p4182r43', framesCount: 1, holdId: 4122, holdState: 'STARTING' },
      { frames: 'p4122r42p4182r43', framesCount: 1, holdId: 4182, holdState: 'HAND' },
    ]);
    mockDb.select.mockReturnValueOnce(selectChain);

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
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(selectChain.leftJoin).toHaveBeenCalledTimes(1);
    // A materialized single-frame target must not fall back to parsing.
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

  it('short-circuits to an empty array when the target climb is missing', async () => {
    mockDb.select.mockReturnValueOnce(mockSelectChain([]));

    const result = await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 8, climbUuid: 'empty-uuid' } },
      makeCtx(),
    );

    expect(result).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).not.toHaveBeenCalled();
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('short-circuits when an existing target has neither materialized holds nor frames', async () => {
    mockDb.select.mockReturnValueOnce(
      mockSelectChain([{ frames: null, framesCount: 1, holdId: null, holdState: null }]),
    );

    const result = await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 8, climbUuid: 'no-holds-or-frames' } },
      makeCtx(),
    );

    expect(result).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).not.toHaveBeenCalled();
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('falls back to parsing board_climbs.frames when board_climb_holds is empty (legacy MoonBoard climbs)', async () => {
    findSimilarClimbsMock.mockResolvedValue([]);
    // The LEFT JOIN keeps the climb row and returns null hold columns when the
    // legacy target has no materialized rows. Parse its frames without a
    // second query so the duplicate drawer still finds the exact match.
    mockDb.select.mockReturnValueOnce(
      mockSelectChain([{ frames: 'p1r12p2r13', framesCount: 1, holdId: null, holdState: null }]),
    );
    parseFramesToHoldEntriesMock.mockReturnValueOnce([
      { frameNumber: 0, holdId: 1, holdState: 'STARTING' },
      { frameNumber: 0, holdId: 2, holdState: 'HAND' },
    ]);

    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'moonboard', layoutId: 1, climbUuid: 'legacy-mb' } },
      makeCtx(),
    );

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledWith('moonboard', 'p1r12p2r13');
    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    const args = findSimilarClimbsMock.mock.calls[0][0];
    expect(args.holds).toHaveLength(2);
    expect(args.excludeUuid).toBe('legacy-mb');
  });

  it('parses board_climbs.frames directly for a multi-frame target', async () => {
    mockDb.select.mockReturnValueOnce(
      mockSelectChain([{ frames: 'p1r12,"x1p2r13', framesCount: 2, holdId: 999, holdState: 'HAND' }]),
    );
    parseFramesToHoldEntriesMock.mockReturnValueOnce([
      { frameNumber: 0, holdId: 1, holdState: 'STARTING' },
      { frameNumber: 1, holdId: 2, holdState: 'HAND' },
    ]);

    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 1, climbUuid: 'animated' } },
      makeCtx(),
    );

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledWith('kilter', 'p1r12,"x1p2r13');
    expect(findSimilarClimbsMock.mock.calls[0][0].holds).toEqual([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 2, holdState: 'HAND' },
    ]);
  });

  it('does not parse a multi-frame target twice when its authoritative projection is empty', async () => {
    mockDb.select.mockReturnValueOnce(
      mockSelectChain([{ frames: 'x1,"', framesCount: 2, holdId: 999, holdState: 'HAND' }]),
    );
    parseFramesToHoldEntriesMock.mockReturnValueOnce([]);

    const result = await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 1, climbUuid: 'empty-animated' } },
      makeCtx(),
    );

    expect(result).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledWith('kilter', 'x1,"');
    expect(findSimilarClimbsMock).not.toHaveBeenCalled();
  });

  it('filters nonpositive and noncanonical materialized rows for a single-frame target', async () => {
    mockDb.select.mockReturnValueOnce(
      mockSelectChain([
        { frames: 'p1r12', framesCount: 1, holdId: 0, holdState: '0=undefined' },
        { frames: 'p1r12', framesCount: 1, holdId: -1, holdState: 'HAND' },
        { frames: 'p1r12', framesCount: 1, holdId: 1, holdState: 'STARTING' },
        { frames: 'p1r12', framesCount: 1, holdId: 2, holdState: '2=999' },
      ]),
    );

    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 1, climbUuid: 'single' } },
      makeCtx(),
    );

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(findSimilarClimbsMock.mock.calls[0][0].holds).toEqual([{ holdId: 1, holdState: 'STARTING' }]);
    expect(parseFramesToHoldEntriesMock).not.toHaveBeenCalled();
  });

  it('falls back to frames when every single-frame materialized row is invalid', async () => {
    mockDb.select.mockReturnValueOnce(
      mockSelectChain([
        { frames: 'p1r12p2r13', framesCount: 1, holdId: 0, holdState: '0=undefined' },
        { frames: 'p1r12p2r13', framesCount: 1, holdId: 2, holdState: '2=999' },
      ]),
    );
    parseFramesToHoldEntriesMock.mockReturnValueOnce([
      { frameNumber: 0, holdId: 1, holdState: 'STARTING' },
      { frameNumber: 0, holdId: 2, holdState: 'HAND' },
    ]);

    await climbQueries.similarClimbs(
      {},
      { input: { boardType: 'kilter', layoutId: 1, climbUuid: 'invalid-materialized' } },
      makeCtx(),
    );

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledTimes(1);
    expect(parseFramesToHoldEntriesMock).toHaveBeenCalledWith('kilter', 'p1r12p2r13');
    expect(findSimilarClimbsMock.mock.calls[0][0].holds).toEqual([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 2, holdState: 'HAND' },
    ]);
  });
});
