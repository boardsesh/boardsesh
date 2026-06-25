import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';

const { mockDb, mockPublishSocialEvent, insertCalls } = vi.hoisted(() => {
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  };

  const mockPublishSocialEvent = vi.fn().mockResolvedValue(undefined);

  return { mockDb, mockPublishSocialEvent, insertCalls };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

// Stub the advisory-xact-lock acquisition so it doesn't consume the same
// mockResolvedValueOnce queue the tests use to script findExactDuplicateMatch
// responses. The lock fires a SELECT on the same `executor.execute` channel,
// and without this it would eat each test's gate response. The actual locking
// behavior is exercised at the DB level — the resolver-level tests only need
// to verify the gate sequence, not the lock side-effect.
vi.mock('../graphql/resolvers/climbs/climb-similarity', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/climbs/climb-similarity')>(
    '../graphql/resolvers/climbs/climb-similarity',
  );
  return {
    ...actual,
    acquireDuplicateGateLock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../events', () => ({
  publishSocialEvent: mockPublishSocialEvent,
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

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

function createMockChain(resolveValue: unknown = [], onValues?: (values: unknown) => void): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = [
    'from',
    'where',
    'leftJoin',
    'orderBy',
    'limit',
    'values',
    'set',
    'returning',
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ];

  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);

  for (const method of methods) {
    chain[method] = vi.fn((...args: unknown[]) => {
      if (method === 'values' && onValues) {
        onValues(args[0]);
      }
      return chain;
    });
  }

  return chain;
}

describe('climb mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT the mockResolvedValueOnce
    // queue. Reset the queued values too — a test that throws partway through
    // would otherwise leak its leftover queue entries into the next test and
    // cause inscrutable cascade failures.
    mockDb.execute.mockReset();
    mockDb.select.mockReset();
    insertCalls.length = 0;
    mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => Promise<unknown>) =>
      callback(mockDb),
    );
  });

  it('stores non-draft Aurora climbs as listed', async () => {
    // No exact-match duplicate found — findExactDuplicateMatch on a non-draft save.
    mockDb.execute.mockResolvedValueOnce([]);
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          layoutId: 1,
          name: 'Test Aurora Climb',
          description: '',
          isDraft: false,
          frames: 'p1r43',
          angle: 40,
        },
      },
      makeCtx(),
    );

    // INSERTs: board_climbs, board_climb_holds, board_climb_stats
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].values).toMatchObject({
      isDraft: false,
      isListed: true,
    });
    expect(insertCalls[1].values).toEqual([
      expect.objectContaining({
        boardType: 'kilter',
        holdId: 1,
        holdState: 'HAND',
      }),
    ]);
    expect(insertCalls[2].values).toMatchObject({
      boardType: 'kilter',
      angle: 40,
      ascensionistCount: 0,
    });
  });

  it('skips the duplicate gate for multi-frame Aurora climbs', async () => {
    // Multi-frame climbs (Aurora dynos with intermediate frames) are out of
    // scope for the gate. We don't queue any "found a match" execute
    // response — if the gate fired regardless it would either error on the
    // missing mock or come back with no result and proceed; either way the
    // climb should save successfully (no rejection).
    //
    // populateDenormalizedColumns runs raw SQL via execute too, so we
    // can't assert "execute never called" — instead verify the save
    // completes end-to-end with framesCount=2 preserved on the row.
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          layoutId: 1,
          name: 'Multi-frame Dyno',
          description: '',
          isDraft: false,
          frames: 'p1r43,p2r43',
          framesCount: 2,
          angle: 40,
        },
      },
      makeCtx(),
    );

    // board_climbs INSERT + holds INSERT + stats INSERT.
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0].values).toMatchObject({
      framesCount: 2,
      isDraft: false,
      isListed: true,
    });
  });

  it('skips the stats seed for draft Aurora climbs', async () => {
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          layoutId: 1,
          name: 'Draft Aurora Climb',
          description: '',
          isDraft: true,
          frames: 'p1r43',
          angle: 40,
        },
      },
      makeCtx(),
    );

    // Draft skips the duplicate-gate query AND the stats seed, but still
    // writes board_climb_holds so the next save's gate has authoritative data.
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0].values).toMatchObject({
      isDraft: true,
      isListed: false,
    });
    expect(insertCalls[1].values).toEqual([
      expect.objectContaining({
        boardType: 'kilter',
        holdId: 1,
        holdState: 'HAND',
      }),
    ]);
  });

  it('stores non-draft MoonBoard climbs as listed', async () => {
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.select
      .mockReturnValueOnce(
        createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
      )
      .mockReturnValueOnce(createMockChain([{ difficulty: 17 }]));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveMoonBoardClimb(
      {},
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          name: 'MoonBoard Climb',
          description: '',
          holds: {
            start: ['A1'],
            hand: ['B2'],
            finish: ['C3'],
          },
          angle: 40,
          isDraft: false,
          userGrade: '6A+',
          isBenchmark: false,
        },
      },
      makeCtx(),
    );

    expect(insertCalls[0].values).toMatchObject({
      isDraft: false,
      isListed: true,
    });
    expect(insertCalls[1].values).toEqual([
      expect.objectContaining({
        boardType: 'moonboard',
        climbUuid: expect.any(String),
        holdId: 1,
        holdState: 'STARTING',
      }),
      expect.objectContaining({
        boardType: 'moonboard',
        climbUuid: expect.any(String),
        holdId: 13,
        holdState: 'HAND',
      }),
      expect.objectContaining({
        boardType: 'moonboard',
        climbUuid: expect.any(String),
        holdId: 25,
        holdState: 'FINISH',
      }),
    ]);
    expect(insertCalls[2].values).toMatchObject({
      boardType: 'moonboard',
      angle: 40,
      displayDifficulty: 17,
      benchmarkDifficulty: null,
      difficultyAverage: 17,
    });
  });

  it('rejects isBenchmark for a user without an admin/leader role', async () => {
    // requireAdminOrLeader's community_roles lookup returns nothing → the gate
    // throws before any climb/stats row is written.
    mockDb.select.mockReturnValueOnce(createMockChain([]));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await expect(
      climbMutations.saveMoonBoardClimb(
        {},
        {
          input: {
            boardType: 'moonboard',
            layoutId: 3,
            name: 'Sneaky Benchmark',
            description: '',
            holds: { start: ['A1'], hand: ['B2'], finish: ['C3'] },
            angle: 40,
            isDraft: false,
            userGrade: '6A+',
            isBenchmark: true,
          },
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/admin or community leader/i);
    expect(insertCalls).toHaveLength(0);
  });

  it('lets a community leader set isBenchmark and records benchmarkDifficulty', async () => {
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.select
      .mockReturnValueOnce(createMockChain([{ role: 'community_leader', boardType: null }]))
      .mockReturnValueOnce(
        createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
      )
      .mockReturnValueOnce(createMockChain([{ difficulty: 17 }]));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveMoonBoardClimb(
      {},
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          name: 'Real Benchmark',
          description: '',
          holds: { start: ['A1'], hand: ['B2'], finish: ['C3'] },
          angle: 40,
          isDraft: false,
          userGrade: '6A+',
          isBenchmark: true,
        },
      },
      makeCtx(),
    );

    expect(insertCalls[2].values).toMatchObject({ benchmarkDifficulty: 17 });
  });

  it('stores the MoonBoard method as a characteristic on the climb row', async () => {
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.select
      .mockReturnValueOnce(
        createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
      )
      .mockReturnValueOnce(createMockChain([{ difficulty: 17 }]));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveMoonBoardClimb(
      {},
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          name: 'Footless Problem',
          description: '',
          holds: { start: ['A1'], hand: ['B2'], finish: ['C3'] },
          angle: 40,
          isDraft: false,
          userGrade: '6A+',
          method: 'method_footless',
        },
      },
      makeCtx(),
    );

    expect(insertCalls[0].values).toMatchObject({ characteristics: ['method_footless'] });
  });

  it('stores null characteristics when no MoonBoard method is supplied', async () => {
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.select
      .mockReturnValueOnce(
        createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
      )
      .mockReturnValueOnce(createMockChain([{ difficulty: 17 }]));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveMoonBoardClimb(
      {},
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          name: 'Feet Follow Hands Problem',
          description: '',
          holds: { start: ['A1'], hand: ['B2'], finish: ['C3'] },
          angle: 40,
          isDraft: false,
          userGrade: '6A+',
          // No `method` — the "feet follow hands" default carries no characteristic token.
        },
      },
      makeCtx(),
    );

    expect(insertCalls[0].values).toMatchObject({ characteristics: null });
  });

  it('seeds a stats row for MoonBoard climbs saved without a grade', async () => {
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Bob', displayName: 'Bob Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveMoonBoardClimb(
      {},
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          name: 'No-grade MoonBoard',
          description: '',
          holds: {
            start: ['A1'],
            hand: ['B2'],
            finish: ['C3'],
          },
          angle: 40,
          isDraft: false,
        },
      },
      makeCtx(),
    );

    const statsInsert = insertCalls.find(
      (call) =>
        typeof call.values === 'object' &&
        call.values !== null &&
        'ascensionistCount' in call.values &&
        'angle' in call.values,
    );
    expect(statsInsert?.values).toMatchObject({
      boardType: 'moonboard',
      angle: 40,
      ascensionistCount: 0,
    });
    expect(statsInsert?.values).not.toHaveProperty('displayDifficulty');
    expect(statsInsert?.values).not.toHaveProperty('difficultyAverage');
  });

  it('skips the stats seed for draft MoonBoard climbs without a grade', async () => {
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Bob', displayName: 'Bob Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveMoonBoardClimb(
      {},
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          name: 'Draft No-grade MoonBoard',
          description: '',
          holds: { start: ['A1'], hand: ['B2'], finish: ['C3'] },
          angle: 40,
          isDraft: true,
        },
      },
      makeCtx(),
    );

    // climb_holds rows are still inserted, but no board_climb_stats row should appear.
    const statsInsert = insertCalls.find(
      (call) => typeof call.values === 'object' && call.values !== null && 'ascensionistCount' in call.values,
    );
    expect(statsInsert).toBeUndefined();
  });

  it('seeds a stats row with the grade for draft MoonBoard climbs that supplied one', async () => {
    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockDb.select
      .mockReturnValueOnce(createMockChain([{ name: 'Bob', displayName: 'Bob Setter', image: null, avatarUrl: null }]))
      .mockReturnValueOnce(createMockChain([{ difficulty: 17 }]));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.saveMoonBoardClimb(
      {},
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          name: 'Draft Graded MoonBoard',
          description: '',
          holds: { start: ['A1'], hand: ['B2'], finish: ['C3'] },
          angle: 40,
          isDraft: true,
          userGrade: '6A+',
          isBenchmark: false,
        },
      },
      makeCtx(),
    );

    // We preserve the grade for draft MoonBoard climbs even though the search
    // filter masks the draft. Otherwise the user's grade would be lost on
    // publish (updateClimb has no userGrade source to reconstruct it from).
    const statsInsert = insertCalls.find(
      (call) => typeof call.values === 'object' && call.values !== null && 'displayDifficulty' in call.values,
    );
    expect(statsInsert?.values).toMatchObject({
      boardType: 'moonboard',
      angle: 40,
      displayDifficulty: 17,
      difficultyAverage: 17,
    });
  });

  it('seeds a stats row on draft → publish transition in updateClimb', async () => {
    mockDb.select
      .mockReturnValueOnce(
        createMockChain([
          {
            uuid: 'climb-1',
            userId: 'user-123',
            isDraft: true,
            publishedAt: null,
            createdAt: '2026-05-14T20:00:00.000Z',
            angle: 35,
            layoutId: 8,
            setterUsername: 'Alice Setter',
          },
        ]),
      )
      .mockReturnValueOnce(
        createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
      );
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          uuid: 'climb-1',
          isDraft: false,
        },
      },
      makeCtx(),
    );

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({
      boardType: 'kilter',
      climbUuid: 'climb-1',
      angle: 35,
      ascensionistCount: 0,
      faUsername: 'Alice Setter',
    });
    // Prove the full publish path ran past the stats insert — getUserProfile is
    // called inside the `transitioningToPublished` block and feeds the social
    // event payload, so a successful publish event call means both the second
    // select mock was consumed and publishSocialEvent received it.
    expect(mockPublishSocialEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishSocialEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'climb.created',
        entityId: 'climb-1',
        metadata: expect.objectContaining({
          setterDisplayName: 'Alice Setter',
          // The draft→publish path must propagate the climb's layoutId into
          // the social event so follower feeds get the layout context (the
          // payload was previously '' even though the existing row knew it).
          layoutId: '8',
        }),
      }),
    );
  });

  it('updateClimb syncs the no_match characteristic from the description on Aurora boards', async () => {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-1',
          userId: 'user-123',
          isDraft: true,
          publishedAt: null,
          createdAt: '2026-05-14T20:00:00.000Z',
          angle: 35,
          layoutId: 8,
          frames: 'p1r1',
          framesCount: 1,
          setterUsername: 'Alice Setter',
          characteristics: null,
        },
      ]),
    );
    // updateClimb does `await tx.update(...).set(...).where(...)` but ignores the
    // result, so the chain doesn't need to be thenable — `.where()` returns a
    // plain object and `await` resolves it as-is. (Avoids a `then` literal, which
    // oxlint flags as an accidental thenable.)
    const updateChain: Record<string, unknown> = {
      set: vi.fn((values: Record<string, unknown>) => {
        updateSet = values;
        return updateChain;
      }),
      where: vi.fn(() => updateChain),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChain);
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-1', description: 'No match\nbeta' } },
      makeCtx(),
    );

    expect(updateSet?.characteristics).toEqual(['no_match']);
  });

  it('updateClimb clears no_match (to null) when the Aurora description prefix is removed', async () => {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-2',
          userId: 'user-123',
          isDraft: true,
          publishedAt: null,
          createdAt: '2026-05-14T20:00:00.000Z',
          angle: 35,
          layoutId: 8,
          frames: 'p1r1',
          framesCount: 1,
          setterUsername: 'Alice Setter',
          characteristics: ['no_match'],
        },
      ]),
    );
    const updateChain: Record<string, unknown> = {
      set: vi.fn((values: Record<string, unknown>) => {
        updateSet = values;
        return updateChain;
      }),
      where: vi.fn(() => updateChain),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChain);
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-2', description: 'just a regular climb now' } },
      makeCtx(),
    );

    // Token removed → stored as null (not an empty array).
    expect(updateSet?.characteristics).toBeNull();
  });

  it('updateClimb never derives no_match for MoonBoard, preserving the method token', async () => {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'mb-1',
          userId: 'user-123',
          isDraft: true,
          publishedAt: null,
          createdAt: '2026-05-14T20:00:00.000Z',
          angle: 40,
          layoutId: 3,
          frames: 'p1r1',
          framesCount: 1,
          setterUsername: 'Alice Setter',
          characteristics: ['method_footless'],
        },
      ]),
    );
    // updateClimb does `await tx.update(...).set(...).where(...)` but ignores the
    // result, so the chain doesn't need to be thenable — `.where()` returns a
    // plain object and `await` resolves it as-is. (Avoids a `then` literal, which
    // oxlint flags as an accidental thenable.)
    const updateChain: Record<string, unknown> = {
      set: vi.fn((values: Record<string, unknown>) => {
        updateSet = values;
        return updateChain;
      }),
      where: vi.fn(() => updateChain),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChain);
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      // A MoonBoard description that *looks* like the Aurora "no match" prefix.
      { input: { boardType: 'moonboard', uuid: 'mb-1', description: 'no match for the feet here' } },
      makeCtx(),
    );

    // The guard skips the no_match derivation entirely — characteristics is not
    // in the update set, so the stored method_footless token is untouched.
    expect(updateSet).toBeDefined();
    expect(updateSet).not.toHaveProperty('characteristics');
  });

  it('throws when publishing a draft without an angle', async () => {
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-no-angle',
          userId: 'user-123',
          isDraft: true,
          publishedAt: null,
          createdAt: '2026-05-14T20:00:00.000Z',
          angle: null,
          setterUsername: null,
        },
      ]),
    );
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { boardType: 'kilter', uuid: 'climb-no-angle', isDraft: false } },
        makeCtx(),
      ),
    ).rejects.toThrow('Cannot publish climb without an angle');

    // The throw must fire BEFORE the board_climbs update — otherwise the caller
    // sees a 500 but the row is left in a half-published state (isDraft = false,
    // publishedAt = now, no stats row), which is the bug this PR is fixing.
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it('seeds a stats row on angle change for a published climb in updateClimb', async () => {
    const publishedAt = new Date(Date.now() - 60 * 1000).toISOString();
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-2',
          userId: 'user-123',
          isDraft: false,
          publishedAt,
          createdAt: publishedAt,
          angle: 35,
          setterUsername: 'Bob Setter',
        },
      ]),
    );
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          uuid: 'climb-2',
          angle: 40,
        },
      },
      makeCtx(),
    );

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({
      boardType: 'kilter',
      climbUuid: 'climb-2',
      angle: 40,
      ascensionistCount: 0,
      faUsername: 'Bob Setter',
    });
  });

  it('does not re-seed stats on a no-op publish/angle update', async () => {
    const publishedAt = new Date(Date.now() - 60 * 1000).toISOString();
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-3',
          userId: 'user-123',
          isDraft: false,
          publishedAt,
          createdAt: publishedAt,
          angle: 35,
          setterUsername: 'Carol Setter',
        },
      ]),
    );
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          uuid: 'climb-3',
          name: 'Renamed',
        },
      },
      makeCtx(),
    );

    expect(insertCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // updateClimb duplicate-gate coverage. These tests exercise the path
  // added in this PR: the gate fires on draft→publish transitions, on
  // frames-changing republishes within the 24h edit window, and stays out
  // of the way for non-frames updates. The shared helper itself is unit-
  // tested in climb-similarity.test.ts; here we only verify the resolver
  // wiring.
  // -----------------------------------------------------------------------

  function makeExistingDraft(overrides: Record<string, unknown> = {}) {
    return {
      uuid: 'climb-x',
      userId: 'user-123',
      isDraft: true,
      publishedAt: null,
      createdAt: '2026-05-14T20:00:00.000Z',
      angle: 35,
      layoutId: 1,
      frames: 'p1117r12p1140r15',
      framesCount: 1,
      setterUsername: 'Alice Setter',
      ...overrides,
    };
  }

  it('updateClimb rejects a draft→publish whose holds match an existing published climb', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([makeExistingDraft()]));
    // First execute call: findExactDuplicateMatch — returns a match.
    mockDb.execute.mockResolvedValueOnce([
      { uuid: 'twin', name: 'Twin Climb', setter_username: 'somebody', angle: 30 },
    ]);
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await expect(
      climbMutations.updateClimb({}, { input: { boardType: 'kilter', uuid: 'climb-x', isDraft: false } }, makeCtx()),
    ).rejects.toThrow(/holds already exists/);

    // The gate must fire BEFORE the UPDATE so the row isn't flipped to
    // isDraft=false + publishedAt=now before the throw. Same invariant the
    // existing 'throws when publishing a draft without an angle' test enforces.
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
    expect(mockPublishSocialEvent).not.toHaveBeenCalled();
  });

  it('updateClimb allows a draft→publish when no existing climb matches', async () => {
    mockDb.select
      .mockReturnValueOnce(createMockChain([makeExistingDraft()]))
      .mockReturnValueOnce(
        createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
      );
    // findExactDuplicateMatch → no match.
    mockDb.execute.mockResolvedValueOnce([]);
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-x', isDraft: false } },
      makeCtx(),
    );

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockPublishSocialEvent).toHaveBeenCalledTimes(1);
  });

  it('updateClimb rejects a frames-changing publish whose new holds match another climb', async () => {
    const publishedAt = new Date(Date.now() - 60 * 1000).toISOString();
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        makeExistingDraft({
          uuid: 'climb-y',
          isDraft: false,
          publishedAt,
          createdAt: publishedAt,
        }),
      ]),
    );
    // findExactDuplicateMatch on the *new* frames → returns a match.
    mockDb.execute.mockResolvedValueOnce([
      { uuid: 'twin', name: 'Twin Climb', setter_username: 'somebody', angle: 30 },
    ]);
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb));
    mockDb.delete.mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await expect(
      climbMutations.updateClimb(
        {},
        {
          input: {
            boardType: 'kilter',
            uuid: 'climb-y',
            frames: 'p9999r12p8888r13',
          },
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/holds already exists/);

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it('updateClimb skips the gate query when only metadata changes (no frames, no publish)', async () => {
    const publishedAt = new Date(Date.now() - 60 * 1000).toISOString();
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        makeExistingDraft({
          uuid: 'climb-z',
          isDraft: false,
          publishedAt,
          createdAt: publishedAt,
        }),
      ]),
    );
    mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-z', name: 'New name only' } },
      makeCtx(),
    );

    // No duplicate-gate query and no holds replace — execute must be untouched.
    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate MoonBoard climbs before inserting', async () => {
    mockDb.execute
      .mockResolvedValueOnce([
        {
          uuid: 'existing-uuid',
          name: 'Already There',
          ascensionist_count: 12,
          signature: '1:STARTING,13:HAND,25:FINISH',
        },
      ])
      .mockResolvedValueOnce([]);
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    // Capture the thrown error so we can assert both the message and the
    // CLIMB_IS_DUPLICATE GraphQL extension. The frontend's duplicate-error
    // UX branches on extensions.code, so this is the contract the
    // saveMoonBoardClimb gate has to honour for parity with saveClimb.
    let caught: unknown;
    try {
      await climbMutations.saveMoonBoardClimb(
        {},
        {
          input: {
            boardType: 'moonboard',
            layoutId: 3,
            name: 'MoonBoard Climb',
            description: '',
            holds: {
              start: ['A1'],
              hand: ['B2'],
              finish: ['C3'],
            },
            angle: 40,
            isDraft: false,
          },
        },
        makeCtx(),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      'A MoonBoard climb with the same holds already exists: "Already There"',
    );
    const extensions = (caught as { extensions?: Record<string, unknown> }).extensions;
    expect(extensions).toMatchObject({
      code: 'CLIMB_IS_DUPLICATE',
      existingClimbUuid: 'existing-uuid',
      existingClimbName: 'Already There',
    });

    expect(insertCalls).toHaveLength(0);
    expect(mockPublishSocialEvent).not.toHaveBeenCalled();
  });

  it('deletes an owned draft climb', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([{ uuid: 'draft-1', userId: 'user-123', isDraft: true }]));
    mockDb.delete.mockReturnValue(createMockChain([{ uuid: 'draft-1' }]));

    const result = await climbMutations.deleteDraftClimb(
      {},
      {
        uuid: 'draft-1',
        boardType: 'kilter',
      },
      makeCtx(),
    );

    expect(result).toBe(true);
    expect(mockDb.delete).toHaveBeenCalledTimes(4);
  });

  it('rejects non-owned draft deletion', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([{ uuid: 'draft-1', userId: 'other-user', isDraft: true }]));
    mockDb.delete.mockReturnValue(createMockChain([{ uuid: 'draft-1' }]));

    await expect(
      climbMutations.deleteDraftClimb(
        {},
        {
          uuid: 'draft-1',
          boardType: 'kilter',
        },
        makeCtx(),
      ),
    ).rejects.toThrow('You can only delete your own draft climbs');

    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('rejects published climb deletion', async () => {
    mockDb.select.mockReturnValueOnce(createMockChain([{ uuid: 'published-1', userId: 'user-123', isDraft: false }]));
    mockDb.delete.mockReturnValue(createMockChain([{ uuid: 'published-1' }]));

    await expect(
      climbMutations.deleteDraftClimb(
        {},
        {
          uuid: 'published-1',
          boardType: 'kilter',
        },
        makeCtx(),
      ),
    ).rejects.toThrow('Published climbs cannot be deleted here');

    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
