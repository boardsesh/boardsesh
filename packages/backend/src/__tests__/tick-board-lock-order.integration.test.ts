import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => {}),
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({ publishDebouncedSessionStats: vi.fn() }));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: vi.fn(() => true) }));
vi.mock('../graphql/resolvers/beta-videos/queries', () => ({ invalidateRecentBetaLinksCache: vi.fn(async () => {}) }));

const [{ db }, schemaModule, resolverModule, drizzleModule, rowsModule, serialLockModule, uuidModule] =
  await Promise.all([
    import('../db/client'),
    import('@boardsesh/db/schema'),
    import('../graphql/resolvers/ticks/mutations'),
    import('drizzle-orm'),
    import('@boardsesh/db/client'),
    import('../graphql/resolvers/board-serial-write-lock'),
    import('uuid'),
  ]);
const schema = schemaModule;
const { tickMutations } = resolverModule;
const { eq, inArray, sql } = drizzleModule;
const { rowsFromResult } = rowsModule;
const { lockBoardSerialWrite } = serialLockModule;
const { v4: uuidv4 } = uuidModule;

const climbUuid = `TICK-LOCK-${uuidv4()}`;
const climbedAt = '2026-10-01T12:00:00.000Z';

type Board = typeof schema.userBoards.$inferSelect;
type TestTick = typeof schema.boardseshTicks.$inferSelect;

function makeContext(userId: string): ConnectionContext {
  return { isAuthenticated: true, userId, connectionId: `pr5627-${userId}` } as ConnectionContext;
}

async function createBoard(ownerId: string, name: string, serialNumber: string): Promise<Board> {
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid: uuidv4(),
      slug: uuidv4(),
      ownerId,
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
      name,
      serialNumber,
      isPublic: true,
    })
    .returning();
  return board;
}

async function createSession(userId: string, boardId: number): Promise<string> {
  const sessionId = uuidv4();
  await db.insert(schema.boardSessions).values({
    id: sessionId,
    boardPath: '/kilter/8/17/26,27/35',
    boardId,
    createdByUserId: userId,
    name: 'Lock order fixture',
  });
  return sessionId;
}

async function createTick(userId: string, boardId: number, sessionId: string, auroraId?: string): Promise<string> {
  const uuid = uuidv4();
  await db.insert(schema.boardseshTicks).values({
    uuid,
    userId,
    boardType: 'kilter',
    climbUuid,
    angle: 35,
    origin: auroraId ? 'aurora_pull' : 'native',
    status: 'send',
    attemptCount: 1,
    isMirror: false,
    isBenchmark: false,
    comment: '',
    climbedAt,
    createdAt: climbedAt,
    updatedAt: climbedAt,
    sessionId,
    boardId,
    ...(auroraId
      ? {
          auroraType: 'ascents' as const,
          auroraId,
          auroraSyncedAt: climbedAt,
        }
      : {}),
  });
  return uuid;
}

async function createFixture(destinationFirst: boolean, includeTwinGroup: boolean) {
  const userId = `pr5627-user-${uuidv4()}`;
  const otherUserId = `pr5627-other-${uuidv4()}`;
  await db.insert(schema.users).values([
    { id: userId, email: `${userId}@example.test` },
    { id: otherUserId, email: `${otherUserId}@example.test` },
  ]);

  let destination: Board | null = null;
  if (destinationFirst) destination = await createBoard(userId, 'Destination', `pr5627-dest-${uuidv4()}`);
  const oldSerial = `pr5627-old-${uuidv4()}`;
  const losingBoard = await createBoard(userId, 'Old wall', oldSerial);
  const survivorBoard = await createBoard(otherUserId, 'Merged wall', oldSerial);
  if (!destination) destination = await createBoard(userId, 'Destination', `pr5627-dest-${uuidv4()}`);

  const targetSessionId = await createSession(userId, losingBoard.id);
  const targetUuid = await createTick(
    userId,
    losingBoard.id,
    targetSessionId,
    includeTwinGroup ? `pr5627-aurora-a-${uuidv4()}` : undefined,
  );
  const twinUuid = includeTwinGroup
    ? await createTick(
        userId,
        losingBoard.id,
        await createSession(userId, losingBoard.id),
        `pr5627-aurora-b-${uuidv4()}`,
      )
    : null;

  return { userId, losingBoard, survivorBoard, destination, targetUuid, twinUuid };
}

function observe<T>(promise: Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  return promise.then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function waitForBoardSurfaceBlocker(blockingPid: number): Promise<void> {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const blockedConnections = rowsFromResult<{ query: string }>(
      await db.execute(sql`
        SELECT query
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND ${blockingPid} = ANY(pg_blocking_pids(pid))
      `),
    );
    if (blockedConnections.some((connection) => connection.query.includes('anchor_boards'))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('updateTick did not wait on its sorted board surface before acquiring tick rows.');
}

async function runMergeBarrier(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  updateInput: Record<string, unknown>,
  expectedBoardId: number | null,
  expectedComment: string,
): Promise<void> {
  let signalMergeReady!: (pid: number) => void;
  const mergeReady = new Promise<number>((resolve) => {
    signalMergeReady = resolve;
  });
  let releaseMerge!: () => void;
  const mergeRelease = new Promise<void>((resolve) => {
    releaseMerge = resolve;
  });

  const mergeOutcome = observe(
    db.transaction(async (tx) => {
      const [connection] = rowsFromResult<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:serial-board-dedupe'))`);
      await tx
        .select({ id: schema.userBoards.id })
        .from(schema.userBoards)
        .where(inArray(schema.userBoards.id, [fixture.losingBoard.id, fixture.survivorBoard.id]))
        .orderBy(schema.userBoards.id)
        .for('update');
      await lockBoardSerialWrite(tx, fixture.losingBoard.serialNumber!);
      await tx
        .update(schema.boardSessions)
        .set({ boardId: fixture.survivorBoard.id })
        .where(eq(schema.boardSessions.boardId, fixture.losingBoard.id));
      signalMergeReady(connection.pid);
      await mergeRelease;
      await tx
        .update(schema.boardseshTicks)
        .set({ boardId: fixture.survivorBoard.id })
        .where(eq(schema.boardseshTicks.boardId, fixture.losingBoard.id));
      await tx
        .update(schema.userBoards)
        .set({ deletedAt: new Date(), mergedIntoBoardUuid: fixture.survivorBoard.uuid })
        .where(eq(schema.userBoards.id, fixture.losingBoard.id));
    }),
  );

  const mergeReadyOutcome = await Promise.race([
    mergeReady.then((pid) => ({ ok: true as const, pid })),
    mergeOutcome.then((outcome) => ({ ok: false as const, outcome })),
  ]);
  if (!mergeReadyOutcome.ok) {
    if (!mergeReadyOutcome.outcome.ok) throw mergeReadyOutcome.outcome.error;
    throw new Error('Merge fixture completed before it reached the lock barrier.');
  }

  const updateOutcome = observe(
    tickMutations.updateTick(undefined, { uuid: fixture.targetUuid, input: updateInput }, makeContext(fixture.userId)),
  );
  try {
    await waitForBoardSurfaceBlocker(mergeReadyOutcome.pid);
    releaseMerge();
    const [mergeResult, updateResult] = await Promise.all([mergeOutcome, updateOutcome]);
    if (!mergeResult.ok) throw mergeResult.error;
    if (!updateResult.ok) throw updateResult.error;

    const affectedUuids = [fixture.targetUuid, ...(fixture.twinUuid ? [fixture.twinUuid] : [])];
    const updatedTicks = await db
      .select()
      .from(schema.boardseshTicks)
      .where(inArray(schema.boardseshTicks.uuid, affectedUuids));
    expect(updatedTicks).toHaveLength(affectedUuids.length);
    expect(updatedTicks.map((tick: TestTick) => tick.uuid).sort()).toEqual([...affectedUuids].sort());
    expect(updatedTicks.every((tick: TestTick) => tick.boardId === expectedBoardId)).toBe(true);
    expect(updatedTicks.every((tick: TestTick) => tick.comment === expectedComment)).toBe(true);
  } finally {
    releaseMerge();
    await Promise.all([mergeOutcome, updateOutcome]);
  }
}

describe('updateTick board/session lock ordering against serial merges', () => {
  beforeAll(async () => {
    const [databaseIdentity] = rowsFromResult<{ databaseName: string }>(
      await db.execute(sql`SELECT current_database() AS "databaseName"`),
    );
    if (!/^boardsesh_(?:backend_test_w\d+|pr5627_[a-z0-9_]+)$/.test(databaseIdentity?.databaseName ?? '')) {
      throw new Error('The tick lock-order suite requires a dedicated disposable test database.');
    }
    await db.insert(schema.boardClimbs).values({
      uuid: climbUuid,
      boardType: 'kilter',
      layoutId: 8,
      name: 'Lock order climb',
      setterUsername: 'fixture',
      frames: '',
      compatibleSizeIds: [17],
      requiredSetIds: [26, 27],
    });
  });

  it.each([
    { destinationFirst: false, includeTwinGroup: false },
    { destinationFirst: true, includeTwinGroup: true },
  ])('moves to a different serial cluster without a row-lock cycle (%j)', async (options) => {
    const fixture = await createFixture(options.destinationFirst, options.includeTwinGroup);
    await runMergeBarrier(fixture, { boardUuid: fixture.destination.uuid }, fixture.destination.id, '');
  });

  it('keeps clear and non-board edits ahead of merge-held sessions', async () => {
    const clearFixture = await createFixture(false, false);
    await runMergeBarrier(clearFixture, { boardUuid: null }, null, '');

    const metadataFixture = await createFixture(true, false);
    await runMergeBarrier(
      metadataFixture,
      { comment: 'edited while a merge held the session' },
      metadataFixture.survivorBoard.id,
      'edited while a merge held the session',
    );
  });
});
