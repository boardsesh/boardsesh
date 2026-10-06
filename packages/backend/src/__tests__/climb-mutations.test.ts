import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';

const { mockDb, mockPublishSocialEvent, insertCalls, lockedClimb, mockRecordClimbRevision } = vi.hoisted(() => {
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];
  // What `lockClimbForRevision` answers: the draft flag of the climb row the test
  // last scripted. See the `climb-revisions` mock below.
  const lockedClimb: { current: Record<string, unknown> | null } = { current: null };
  // Answers what the real one does for a save that records nothing: the locked
  // row's own numbers. `updateClimb` puts them on its result and compares the
  // holds epoch with the locked row's to decide whether to restart the stats.
  const mockRecordClimbRevision = vi.fn(
    async (_executor: unknown, params: { before: { revisionNumber?: number; holdsRevisionNumber?: number } }) => ({
      revisionNumber: params.before.revisionNumber,
      holdsRevisionNumber: params.before.holdsRevisionNumber,
    }),
  );

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  };

  const mockPublishSocialEvent = vi.fn().mockResolvedValue(undefined);

  return { mockDb, mockPublishSocialEvent, insertCalls, lockedClimb, mockRecordClimbRevision };
});

// Revision history re-reads the climb row under a lock and writes its own rows,
// inside the transaction. Both would eat entries off the `mockDb.select` queue the
// tests below script call by call, so those two functions are stubbed here and
// exercised against a real database in climb-revisions.test.ts. The lock answers
// with the row the test scripted (captured in `createMockChain`), i.e. "nothing
// changed since you loaded it", unless a test sets `lockedClimb.current` itself.
// The staleness check and the error code stay real.
vi.mock('../graphql/resolvers/climbs/climb-revisions', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/climbs/climb-revisions')>(
    '../graphql/resolvers/climbs/climb-revisions',
  );
  return {
    ...actual,
    lockClimbForRevision: vi.fn(async () => lockedClimb.current),
    recordClimbRevision: mockRecordClimbRevision,
  };
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

  // A scripted climb row (the only rows here carrying both keys) is what the
  // stubbed row lock should report back.
  const [firstRow] = Array.isArray(resolveValue) ? (resolveValue as unknown[]) : [];
  if (firstRow && typeof firstRow === 'object' && 'uuid' in firstRow && 'isDraft' in firstRow) {
    lockedClimb.current = { ...firstRow, isDraft: (firstRow as { isDraft: unknown }).isDraft === true };
  }

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
    lockedClimb.current = null;
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

  it('stores client-supplied toggleable characteristics on a new Aurora climb', async () => {
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
          name: 'No Kickboard Climb',
          description: '',
          isDraft: false,
          frames: 'p1r43',
          angle: 40,
          characteristics: ['no_kickboard'],
        },
      },
      makeCtx(),
    );

    expect(insertCalls[0].values).toMatchObject({ characteristics: ['no_kickboard'] });
  });

  it('stores null characteristics on a new Aurora climb when the field is omitted', async () => {
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
          name: 'Plain Climb',
          description: '',
          isDraft: false,
          frames: 'p1r43',
          angle: 40,
        },
      },
      makeCtx(),
    );

    expect(insertCalls[0].values).toMatchObject({ characteristics: null });
  });

  it('accepts an explicit null characteristics field on saveClimb (mobile always sends the field, not omission)', async () => {
    mockDb.execute.mockResolvedValueOnce([]);
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );

    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'kilter',
            layoutId: 1,
            name: 'Plain Climb',
            description: '',
            isDraft: false,
            frames: 'p1r43',
            angle: 40,
            characteristics: null,
          },
        },
        makeCtx(),
      ),
    ).resolves.toBeDefined();

    expect(insertCalls[0].values).toMatchObject({ characteristics: null });
  });

  it('rejects a characteristics array with a duplicate token', async () => {
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'kilter',
            layoutId: 1,
            name: 'Duplicate Token Climb',
            description: '',
            isDraft: false,
            frames: 'p1r43',
            angle: 40,
            characteristics: ['no_kickboard', 'no_kickboard'],
          },
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/duplicate/i);
  });

  it('rejects an unknown characteristic token', async () => {
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'kilter',
            layoutId: 1,
            name: 'Unknown Token Climb',
            description: '',
            isDraft: false,
            frames: 'p1r43',
            angle: 40,
            characteristics: ['some_unknown_token'],
          },
        },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  it('rejects no_match sent through the characteristics field (it must ride the description instead)', async () => {
    await expect(
      climbMutations.saveClimb(
        {},
        {
          input: {
            boardType: 'kilter',
            layoutId: 1,
            name: 'No Match Via Wrong Field',
            description: '',
            isDraft: false,
            frames: 'p1r43',
            angle: 40,
            characteristics: ['no_match'],
          },
        },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  it('derives no_match from the description and merges it with a client-supplied toggle on creation', async () => {
    // Regression: saveClimb used to store ONLY the client-supplied toggleable
    // tokens, so a climb created with no_match (via the description prefix) AND
    // a toggle stored characteristics=['no_kickboard'] — non-null, so readers
    // that prefer the array over the description fallback silently dropped the
    // no-match badge until the next edit.
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
          name: 'No Match No Kickboard',
          description: 'No match\nbeta',
          isDraft: false,
          frames: 'p1r43',
          angle: 40,
          characteristics: ['no_kickboard'],
        },
      },
      makeCtx(),
    );

    const stored = insertCalls[0].values as { characteristics: string[]; description: string };
    expect(stored.characteristics.sort()).toEqual(['no_kickboard', 'no_match']);
    // The prefix is stripped from the stored description — characteristics is
    // the sole source of truth going forward, matching updateClimb's behavior.
    expect(stored.description).toBe('beta');
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

  // MoonBoard problems have no updateClimb-based edit path today: there is no
  // saveMoonBoardClimb caller in web/mobile UI that later calls updateClimb on
  // the same row, and the MoonBoard "method" field is only ever set once, at
  // creation, via SaveMoonBoardClimbInput. So a
  // `boardType: 'moonboard'` + `characteristics: [...]` updateClimb call isn't
  // a real flow to test today — the toggleable-tokens loop below doesn't gate
  // on boardType (unlike the no_match-from-description derivation), so if a
  // MoonBoard row *were* ever routed through updateClimb with a `characteristics`
  // field, the requested no_kickboard/campus tokens would still merge in
  // (leaving any method_* token untouched, since the loop only ever touches the
  // two TOGGLEABLE_CLIMB_CHARACTERISTICS tokens).

  it('updateClimb merges a client-supplied characteristic onto an existing no_match row', async () => {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-3',
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
      { input: { boardType: 'kilter', uuid: 'climb-3', characteristics: ['campus'] } },
      makeCtx(),
    );

    expect(updateSet?.characteristics).toEqual(expect.arrayContaining(['no_match', 'campus']));
    expect((updateSet?.characteristics as string[]).sort()).toEqual(['campus', 'no_match']);
  });

  it('updateClimb composes a description-driven no_match flip with a client-supplied characteristic in the same call', async () => {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-4',
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
      {
        input: {
          boardType: 'kilter',
          uuid: 'climb-4',
          description: 'No match\nbeta',
          characteristics: ['no_kickboard'],
        },
      },
      makeCtx(),
    );

    // This is the exact "one clobbering the other" case: without the
    // restructure, only the last-applied branch's characteristics write would
    // have survived.
    expect((updateSet?.characteristics as string[]).sort()).toEqual(['no_kickboard', 'no_match']);
  });

  it('updateClimb sending an empty characteristics array turns off previously-set toggleable tokens, leaving no_match/method alone', async () => {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-5',
          userId: 'user-123',
          isDraft: true,
          publishedAt: null,
          createdAt: '2026-05-14T20:00:00.000Z',
          angle: 35,
          layoutId: 8,
          frames: 'p1r1',
          framesCount: 1,
          setterUsername: 'Alice Setter',
          characteristics: ['no_match', 'no_kickboard', 'campus'],
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
      { input: { boardType: 'kilter', uuid: 'climb-5', characteristics: [] } },
      makeCtx(),
    );

    expect(updateSet?.characteristics).toEqual(['no_match']);
  });

  it('updateClimb sending an explicit null characteristics field behaves like an empty array (mobile sends null, not [])', async () => {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(
      createMockChain([
        {
          uuid: 'climb-6',
          userId: 'user-123',
          isDraft: true,
          publishedAt: null,
          createdAt: '2026-05-14T20:00:00.000Z',
          angle: 35,
          layoutId: 8,
          frames: 'p1r1',
          framesCount: 1,
          setterUsername: 'Alice Setter',
          characteristics: ['no_match', 'no_kickboard', 'campus'],
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

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { boardType: 'kilter', uuid: 'climb-6', characteristics: null } },
        makeCtx(),
      ),
    ).resolves.toBeDefined();

    expect(updateSet?.characteristics).toEqual(['no_match']);
  });

  // The catalogue-board edit rule, which #5955 leaves exactly as it was: the
  // setter only, and a published climb only within 24 hours of its publish. The
  // spray half of the rule needs a real wall and lives in spray-wall-api.test.ts.
  describe('updateClimb edit rule on a catalogue board', () => {
    const HOUR_MS = 60 * 60 * 1000;

    function scriptPublishedClimb(overrides: Record<string, unknown> = {}) {
      mockDb.select.mockReturnValueOnce(
        createMockChain([
          {
            uuid: 'climb-1',
            userId: 'user-123',
            isDraft: false,
            publishedAt: new Date(Date.now() - HOUR_MS).toISOString(),
            createdAt: '2026-05-14T20:00:00.000Z',
            angle: 35,
            layoutId: 8,
            frames: 'p1117r12p1140r15',
            framesCount: 1,
            setterUsername: 'Alice Setter',
            characteristics: null,
            description: '',
            compatibleSizeIds: null,
            ...overrides,
          },
        ]),
      );
      mockDb.update = vi.fn().mockReturnValue(createMockChain(undefined));
    }

    const rename = (ctx = makeCtx()) =>
      climbMutations.updateClimb({}, { input: { boardType: 'kilter', uuid: 'climb-1', name: 'Renamed' } }, ctx);

    it('lets the setter edit a published climb inside the 24 hour window, and records the edit', async () => {
      scriptPublishedClimb();

      await rename();

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockRecordClimbRevision).toHaveBeenCalledTimes(1);
      expect(mockRecordClimbRevision.mock.calls[0][1]).toMatchObject({
        boardType: 'kilter',
        climbUuid: 'climb-1',
        editorId: 'user-123',
        sprayTarget: null,
      });
    });

    it('still refuses the setter once the 24 hour window has passed', async () => {
      scriptPublishedClimb({ publishedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() });

      await expect(rename()).rejects.toThrow('The 24 hour edit window has expired');
      scriptPublishedClimb({ publishedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() });
      await expect(rename()).rejects.toMatchObject({ extensions: { code: 'CLIMB_EDIT_WINDOW_EXPIRED' } });

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockRecordClimbRevision).not.toHaveBeenCalled();
    });

    it('still refuses a published climb with no publish time', async () => {
      scriptPublishedClimb({ publishedAt: null });

      await expect(rename()).rejects.toThrow('This climb can no longer be edited');
      scriptPublishedClimb({ publishedAt: null });
      await expect(rename()).rejects.toMatchObject({ extensions: { code: 'CLIMB_NOT_EDITABLE' } });
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('still refuses anyone but the setter, inside the window or not', async () => {
      scriptPublishedClimb();
      await expect(rename(makeCtx({ userId: 'someone-else' }))).rejects.toThrow('You can only update your own climbs');

      scriptPublishedClimb({ isDraft: true, publishedAt: null });
      await expect(rename(makeCtx({ userId: 'someone-else' }))).rejects.toThrow('You can only update your own climbs');

      // An Aurora-synced climb has no Boardsesh setter at all.
      scriptPublishedClimb({ userId: null });
      await expect(rename()).rejects.toThrow('You can only update your own climbs');

      // A stable code rides every one of them, so a client can translate the
      // refusal without matching on the sentence.
      scriptPublishedClimb();
      await expect(rename(makeCtx({ userId: 'someone-else' }))).rejects.toMatchObject({
        extensions: { code: 'CLIMB_EDIT_NOT_ALLOWED' },
      });

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockRecordClimbRevision).not.toHaveBeenCalled();
    });

    const conflict = { extensions: { code: 'CLIMB_EDIT_CONFLICT' } };

    it('refuses an edit when the climb was published or deleted while it was being edited', async () => {
      scriptPublishedClimb({ isDraft: true, publishedAt: null });
      lockedClimb.current = { ...lockedClimb.current, isDraft: false };
      await expect(rename()).rejects.toMatchObject(conflict);

      scriptPublishedClimb({ isDraft: true, publishedAt: null });
      lockedClimb.current = null;
      await expect(rename()).rejects.toThrow('Climb not found');

      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockRecordClimbRevision).not.toHaveBeenCalled();
    });

    it('refuses an edit decided on frames, rules, an angle or a description that another edit has since replaced', async () => {
      // Each of these is a column the resolver decided from before its
      // transaction: whether to rewrite the holds, what the rule set becomes,
      // what the duplicate gate checked. The canonical case is the first: the
      // request carries the frames it loaded plus a rename, so it would put the
      // OLD frames back and skip the hold rewrite.
      const landedMeanwhile: Array<Record<string, unknown>> = [
        { frames: 'p1117r12p1141r15' },
        { framesCount: 2 },
        { angle: 40 },
        { characteristics: ['any_feet'] },
        { description: 'No match\nSit start' },
      ];
      for (const change of landedMeanwhile) {
        scriptPublishedClimb();
        lockedClimb.current = { ...lockedClimb.current, ...change };
        await expect(
          climbMutations.updateClimb(
            {},
            { input: { boardType: 'kilter', uuid: 'climb-1', name: 'Renamed', frames: 'p1117r12p1140r15' } },
            makeCtx(),
          ),
        ).rejects.toMatchObject(conflict);
      }

      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockRecordClimbRevision).not.toHaveBeenCalled();
    });

    it('does not refuse over a concurrent rename, which no decision depends on', async () => {
      scriptPublishedClimb();
      lockedClimb.current = { ...lockedClimb.current, name: 'Renamed by someone else', framesPace: 400 };

      await climbMutations.updateClimb(
        {},
        { input: { boardType: 'kilter', uuid: 'climb-1', description: 'Sit start' } },
        makeCtx(),
      );

      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });

    it('answers a publish that already landed as a success, without writing or announcing again', async () => {
      const publishedAt = new Date(Date.now() - 1000).toISOString();
      scriptPublishedClimb({ isDraft: true, publishedAt: null, name: 'Draft name' });
      // The duplicate gate runs before the row lock, and finds nothing.
      mockDb.execute.mockResolvedValueOnce([]);
      // What the first, identical publish left behind.
      lockedClimb.current = { ...lockedClimb.current, isDraft: false, publishedAt, name: 'Published name' };

      const result = await climbMutations.updateClimb(
        {},
        { input: { boardType: 'kilter', uuid: 'climb-1', isDraft: false, name: 'Published name' } },
        makeCtx(),
      );

      expect(result).toMatchObject({ uuid: 'climb-1', isDraft: false, publishedAt });
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(insertCalls).toEqual([]);
      expect(mockRecordClimbRevision).not.toHaveBeenCalled();
      expect(mockPublishSocialEvent).not.toHaveBeenCalled();
    });

    it('still refuses a second publish that would write something different', async () => {
      scriptPublishedClimb({ isDraft: true, publishedAt: null, name: 'Draft name' });
      mockDb.execute.mockResolvedValueOnce([]);
      lockedClimb.current = { ...lockedClimb.current, isDraft: false, publishedAt: new Date().toISOString() };

      await expect(
        climbMutations.updateClimb(
          {},
          { input: { boardType: 'kilter', uuid: 'climb-1', isDraft: false, name: 'A different name' } },
          makeCtx(),
        ),
      ).rejects.toMatchObject(conflict);
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockPublishSocialEvent).not.toHaveBeenCalled();
    });
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

  // -----------------------------------------------------------------------
  // Rule flags: no_match and any_feet ride their own booleans rather than the
  // `characteristics` array, so an old client that has never heard of them
  // cannot clear one by sending the array it does know about.
  // -----------------------------------------------------------------------

  function mockCreateChain() {
    mockDb.execute.mockResolvedValueOnce([]);
    mockDb.select.mockReturnValueOnce(
      createMockChain([{ name: 'Alice', displayName: 'Alice Setter', image: null, avatarUrl: null }]),
    );
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );
  }

  function auroraSaveInput(overrides: Record<string, unknown> = {}) {
    return {
      boardType: 'kilter',
      layoutId: 1,
      name: 'Rule Flag Climb',
      description: '',
      isDraft: false,
      frames: 'p1r43',
      angle: 40,
      ...overrides,
    };
  }

  it('saveClimb stores an explicit noMatch flag', async () => {
    mockCreateChain();
    await climbMutations.saveClimb({}, { input: auroraSaveInput({ noMatch: true }) }, makeCtx());
    expect(insertCalls[0].values).toMatchObject({ characteristics: ['no_match'] });
  });

  it('saveClimb lets an explicit noMatch:false beat the legacy description prefix', async () => {
    mockCreateChain();
    await climbMutations.saveClimb(
      {},
      { input: auroraSaveInput({ description: 'No match\nbeta', noMatch: false }) },
      makeCtx(),
    );
    const stored = insertCalls[0].values as { characteristics: string[] | null; description: string };
    expect(stored.characteristics).toBeNull();
    expect(stored.description).toBe('beta');
  });

  it('saveClimb still derives no_match from the description when the flag is absent (old client)', async () => {
    mockCreateChain();
    await climbMutations.saveClimb({}, { input: auroraSaveInput({ description: 'No match\nbeta' }) }, makeCtx());
    expect(insertCalls[0].values).toMatchObject({ characteristics: ['no_match'] });
  });

  it('saveClimb stores anyFeet alongside a toggleable characteristic', async () => {
    mockCreateChain();
    await climbMutations.saveClimb(
      {},
      { input: auroraSaveInput({ anyFeet: true, characteristics: ['no_kickboard'] }) },
      makeCtx(),
    );
    const stored = insertCalls[0].values as { characteristics: string[] };
    expect([...stored.characteristics].sort()).toEqual(['any_feet', 'no_kickboard']);
  });

  it('saveClimb rejects anyFeet combined with campus', async () => {
    await expect(
      climbMutations.saveClimb(
        {},
        { input: auroraSaveInput({ anyFeet: true, characteristics: ['campus'] }) },
        makeCtx(),
      ),
    ).rejects.toThrow(/"any_feet" cannot be combined with "campus"/);
    expect(insertCalls).toHaveLength(0);
  });

  it('saveClimb accepts anyFeet with no_kickboard — "any hold but the kickboard" is a real rule', async () => {
    mockCreateChain();
    await expect(
      climbMutations.saveClimb(
        {},
        { input: auroraSaveInput({ anyFeet: true, characteristics: ['no_kickboard'] }) },
        makeCtx(),
      ),
    ).resolves.toBeDefined();
  });

  function makeExistingRow(overrides: Record<string, unknown> = {}) {
    return {
      uuid: 'climb-flags',
      userId: 'user-123',
      isDraft: true,
      publishedAt: null,
      createdAt: '2026-05-14T20:00:00.000Z',
      angle: 35,
      layoutId: 8,
      // Real Kilter role codes (12 = STARTING, 15 = FOOT). A code the board's
      // HOLD_STATE_MAP doesn't know is dropped by the frames parser, which would
      // leave an empty hold signature and silently disable the duplicate gate.
      frames: 'p1117r12p1140r15',
      framesCount: 1,
      setterUsername: 'Alice Setter',
      characteristics: null,
      description: '',
      compatibleSizeIds: null,
      ...overrides,
    };
  }

  function mockUpdateChain(existing: Record<string, unknown>): { get: () => Record<string, unknown> | undefined } {
    let updateSet: Record<string, unknown> | undefined;
    mockDb.select.mockReturnValueOnce(createMockChain([existing]));
    const updateChain: Record<string, unknown> = {
      set: vi.fn((values: Record<string, unknown>) => {
        updateSet = values;
        return updateChain;
      }),
      where: vi.fn(() => updateChain),
    };
    mockDb.update = vi.fn().mockReturnValue(updateChain);
    mockDb.delete.mockReturnValue(createMockChain(undefined));
    mockDb.insert.mockImplementation((table: unknown) =>
      createMockChain(undefined, (values) => insertCalls.push({ table, values })),
    );
    return { get: () => updateSet };
  }

  it('updateClimb leaves the new flags alone when an old client omits them', async () => {
    // The regression this guards: an old build sends only `characteristics`, the
    // full desired state of the two toggles it knows about. If no_match/any_feet
    // were merged into that list, every save from that build would silently clear
    // both.
    const captured = mockUpdateChain(makeExistingRow({ characteristics: ['no_match', 'any_feet', 'campus'] }));

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-flags', characteristics: ['no_kickboard'] } },
      makeCtx(),
    );

    expect((captured.get()?.characteristics as string[]).sort()).toEqual(['any_feet', 'no_kickboard', 'no_match']);
  });

  it('updateClimb clears a flag only when the client says so explicitly', async () => {
    const captured = mockUpdateChain(makeExistingRow({ characteristics: ['no_match', 'any_feet'] }));

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-flags', noMatch: false } },
      makeCtx(),
    );

    expect(captured.get()?.characteristics).toEqual(['any_feet']);
  });

  it('updateClimb treats an explicit null flag as "leave it alone", not "turn it off"', async () => {
    const captured = mockUpdateChain(makeExistingRow({ characteristics: ['no_match', 'any_feet'] }));

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-flags', noMatch: null, anyFeet: null, name: 'Renamed' } },
      makeCtx(),
    );

    // Nothing touched the rules, so the column is not in the update set at all.
    expect(captured.get()).not.toHaveProperty('characteristics');
  });

  it('updateClimb lets an explicit noMatch beat the description in the same call', async () => {
    const captured = mockUpdateChain(makeExistingRow());

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-flags', description: 'No match\nbeta', noMatch: false } },
      makeCtx(),
    );

    expect(captured.get()?.characteristics).toBeNull();
    expect(captured.get()?.description).toBe('beta');
  });

  it('updateClimb carries a legacy description-derived no_match into the first explicit array it writes', async () => {
    // characteristics IS NULL + a "No match" description is the un-backfilled
    // shape. Turning on any_feet must not be the moment the climb quietly stops
    // being a no-match climb.
    const captured = mockUpdateChain(makeExistingRow({ characteristics: null, description: 'No match\nbeta' }));

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-flags', anyFeet: true } },
      makeCtx(),
    );

    expect((captured.get()?.characteristics as string[]).sort()).toEqual(['any_feet', 'no_match']);
  });

  it('updateClimb rejects anyFeet on a climb already stored as footless', async () => {
    const captured = mockUpdateChain(makeExistingRow({ boardType: 'moonboard', characteristics: ['method_footless'] }));

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { boardType: 'moonboard', uuid: 'climb-flags', anyFeet: true } },
        makeCtx(),
      ),
    ).rejects.toThrow(/"any_feet" cannot be combined with "method_footless"/);
    expect(captured.get()).toBeUndefined();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Rule variants are distinct climbs, so a rule-only edit is a fork and has
  // to face the duplicate gate.
  // -----------------------------------------------------------------------

  it('updateClimb re-runs the duplicate gate on a rule-only edit', async () => {
    const publishedAt = new Date(Date.now() - 60 * 1000).toISOString();
    mockUpdateChain(makeExistingRow({ isDraft: false, publishedAt, createdAt: publishedAt, characteristics: [] }));
    // findExactDuplicateMatch → a no-match version of these holds already exists.
    mockDb.execute.mockResolvedValueOnce([
      { uuid: 'twin', name: 'No Match Twin', setter_username: 'somebody', angle: 30 },
    ]);

    await expect(
      climbMutations.updateClimb({}, { input: { boardType: 'kilter', uuid: 'climb-flags', noMatch: true } }, makeCtx()),
    ).rejects.toThrow(/holds already exists/);

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('updateClimb skips the gate when an edit leaves the rule signature unchanged', async () => {
    const publishedAt = new Date(Date.now() - 60 * 1000).toISOString();
    mockUpdateChain(
      makeExistingRow({ isDraft: false, publishedAt, createdAt: publishedAt, characteristics: ['no_match'] }),
    );

    await climbMutations.updateClimb(
      {},
      // Re-asserting a flag the row already carries is not a fork.
      { input: { boardType: 'kilter', uuid: 'climb-flags', noMatch: true } },
      makeCtx(),
    );

    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Woods authoring. The board is code-driven — no placements, no product
  // sizes — so saveClimb has to write the denormalised columns itself and
  // validate the shape against the shared geometry tables.
  // -----------------------------------------------------------------------

  function woodsSaveInput(overrides: Record<string, unknown> = {}) {
    return {
      boardType: 'woods',
      layoutId: 1,
      sizeId: 2,
      name: 'Woods Problem',
      description: '',
      isDraft: false,
      // Wire roles: 4 = start, 2 = hand, 3 = finish.
      frames: 'p10r4p20r2p30r3',
      angle: 40,
      ...overrides,
    };
  }

  it('saveClimb writes a Woods climb with its size, empty rule set and hold fingerprint', async () => {
    mockCreateChain();

    const result = await climbMutations.saveClimb({}, { input: woodsSaveInput() }, makeCtx());

    const climbRow = insertCalls[0].values as Record<string, unknown>;
    expect(climbRow).toMatchObject({
      boardType: 'woods',
      layoutId: 1,
      isDraft: false,
      isListed: true,
      // Boardsesh-only: there is no Aurora account to push a Woods climb to, so
      // `synced: false` would park it as pending forever.
      synced: true,
      compatibleSizeIds: [2],
      // `{} <@ anything` is true, so an empty required-set array can never filter
      // the climb out; NULL would read as "not backfilled yet" and drop it.
      requiredSetIds: [],
    });
    // `[]` and not NULL: on Woods a NULL characteristics column means "rules
    // unknown until the catalog repair fills them in".
    expect(climbRow.characteristics).toEqual([]);
    expect(climbRow.holdFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.synced).toBe(true);

    expect(insertCalls[1].values).toEqual([
      expect.objectContaining({ boardType: 'woods', holdId: 10, holdState: 'STARTING' }),
      expect.objectContaining({ boardType: 'woods', holdId: 20, holdState: 'HAND' }),
      expect.objectContaining({ boardType: 'woods', holdId: 30, holdState: 'FINISH' }),
    ]);
    expect(insertCalls[2].values).toMatchObject({ boardType: 'woods', angle: 40, ascensionistCount: 0 });
  });

  it('saveClimb stores Woods rules as an explicit array', async () => {
    mockCreateChain();
    await climbMutations.saveClimb({}, { input: woodsSaveInput({ anyFeet: true, noMatch: true }) }, makeCtx());
    const stored = insertCalls[0].values as { characteristics: string[] };
    expect([...stored.characteristics].sort()).toEqual(['any_feet', 'no_match']);
  });

  it('keeps Woods description prose beginning with No match on save and edit', async () => {
    mockCreateChain();
    const description = 'No match for these crimps anywhere else.';
    await climbMutations.saveClimb({}, { input: woodsSaveInput({ description }) }, makeCtx());
    expect(insertCalls[0].values).toMatchObject({ description, characteristics: [] });
    const captured = mockUpdateChain(makeWoodsRow());
    await climbMutations.updateClimb({}, { input: { boardType: 'woods', uuid: 'woods-1', description } }, makeCtx());
    expect(captured.get()).toMatchObject({ description });
  });

  it('explicit matching defaults override Aurora prose when no other rules survive', async () => {
    mockCreateChain();
    const description = 'No matching hands';
    await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          layoutId: 1,
          name: 'Prose',
          frames: 'p1r12p2r14',
          angle: 40,
          isDraft: true,
          description,
          noMatch: false,
        },
      },
      makeCtx(),
    );
    expect(insertCalls[0].values).toMatchObject({ description, characteristics: [] });
    const captured = mockUpdateChain(makeWoodsRow({ characteristics: ['no_match'], description }));
    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'kilter', uuid: 'climb-1', noMatch: false, description } },
      makeCtx(),
    );
    expect(captured.get()).toMatchObject({ description, characteristics: [] });
  });

  it('saveClimb rejects a Woods climb with no board size', async () => {
    await expect(
      climbMutations.saveClimb({}, { input: woodsSaveInput({ sizeId: undefined }) }, makeCtx()),
    ).rejects.toThrow(/must name the board size/i);
    expect(insertCalls).toHaveLength(0);
  });

  it('saveClimb rejects a Woods angle off the 5 degree grid', async () => {
    await expect(climbMutations.saveClimb({}, { input: woodsSaveInput({ angle: 42 }) }, makeCtx())).rejects.toThrow(
      /5° steps/,
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('saveClimb rejects a hold that only exists on the other Woods wall', async () => {
    // Hold 600 is on the 12x12 (0-893) and not on the 8x10 (0-484).
    await expect(
      climbMutations.saveClimb({}, { input: woodsSaveInput({ sizeId: 1, frames: 'p600r4p20r2p30r3' }) }, makeCtx()),
    ).rejects.toThrow(/Hold 600 does not exist on the 8x10/);
    expect(insertCalls).toHaveLength(0);
  });

  it('saveClimb rejects Aurora role codes on a Woods climb', async () => {
    await expect(
      climbMutations.saveClimb({}, { input: woodsSaveInput({ frames: 'p10r12p20r13' }) }, makeCtx()),
    ).rejects.toThrow(/Unknown Woods hold role 12/);
    expect(insertCalls).toHaveLength(0);
  });

  it('saveClimb rejects publishing a Woods climb with no finish hold', async () => {
    await expect(
      climbMutations.saveClimb({}, { input: woodsSaveInput({ frames: 'p10r4p20r2' }) }, makeCtx()),
    ).rejects.toThrow(/needs at least one finish hold/);
  });

  it('saveClimb allows a Woods draft without a start or finish', async () => {
    mockCreateChain();
    await expect(
      climbMutations.saveClimb({}, { input: woodsSaveInput({ isDraft: true, frames: 'p20r2' }) }, makeCtx()),
    ).resolves.toBeDefined();
  });

  function makeWoodsRow(overrides: Record<string, unknown> = {}) {
    return makeExistingRow({
      uuid: 'woods-1',
      layoutId: 1,
      angle: 40,
      frames: 'p10r4p20r2p30r3',
      characteristics: [],
      compatibleSizeIds: [2],
      ...overrides,
    });
  }

  it('updateClimb refuses to move a Woods climb to the other wall', async () => {
    mockUpdateChain(makeWoodsRow());

    await expect(
      climbMutations.updateClimb({}, { input: { boardType: 'woods', uuid: 'woods-1', sizeId: 1 } }, makeCtx()),
    ).rejects.toThrow(/board size cannot be changed/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('updateClimb validates Woods edits against the STORED size', async () => {
    // The request names no size; the 8x10 row is what makes hold 600 illegal.
    mockUpdateChain(makeWoodsRow({ compatibleSizeIds: [1], frames: 'p10r4p20r2p30r3' }));

    await expect(
      climbMutations.updateClimb(
        {},
        { input: { boardType: 'woods', uuid: 'woods-1', frames: 'p600r4p20r2p30r3' } },
        makeCtx(),
      ),
    ).rejects.toThrow(/Hold 600 does not exist on the 8x10/);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('updateClimb accepts a Woods edit that agrees with the stored size and refreshes the fingerprint', async () => {
    const captured = mockUpdateChain(makeWoodsRow());

    await climbMutations.updateClimb(
      {},
      { input: { boardType: 'woods', uuid: 'woods-1', sizeId: 2, frames: 'p10r4p25r2p30r3' } },
      makeCtx(),
    );

    expect(captured.get()?.frames).toBe('p10r4p25r2p30r3');
    // A stale fingerprint would describe the climb the user just replaced, and
    // nothing downstream re-derives it for Woods.
    expect(captured.get()?.holdFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('updateClimb keeps Woods rules as an explicit array when the last rule is turned off', async () => {
    const captured = mockUpdateChain(makeWoodsRow({ characteristics: ['any_feet'] }));

    await climbMutations.updateClimb({}, { input: { boardType: 'woods', uuid: 'woods-1', anyFeet: false } }, makeCtx());

    // NULL would demote the climb back to "rules unknown".
    expect(captured.get()?.characteristics).toEqual([]);
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
