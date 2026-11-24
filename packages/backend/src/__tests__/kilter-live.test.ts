import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import {
  fetchKilterLiveHistory,
  getStoredKilterAccessToken,
  KilterLiveError,
  KilterApiError,
  type KilterLiveDisplay,
} from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { importKilterDisplays, matchKilterWall } from '../services/kilter-live-import';
import { parseHistoryPageCursor, readBoardHistoryPage, readMergedRecentHistory } from '../services/board-history';
import { KilterLiveSync, kilterLiveSync } from '../services/kilter-live-sync';
import { logger } from '../utils/logger';
import { boardPresenceSubscriptions } from '../graphql/resolvers/board-presence/subscription';

vi.mock('@boardsesh/kilter-sync/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/kilter-sync/api')>()),
  fetchKilterLiveHistory: vi.fn(),
  getStoredKilterAccessToken: vi.fn(async () => 'test-access-token'),
}));

let publisher: Redis;
let subscriber: Redis;
let boardId: number;
let boardUuid: string;
let sourceKey: string;
let climbUuid: string;
const pollers: KilterLiveSync[] = [];
const linkedUser = 'kilter-live-test-user';
const publishEvent = vi.fn();

beforeAll(async () => {
  publisher = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  subscriber = publisher.duplicate();
  await publisher.ping();
});
afterAll(async () => {
  await Promise.all([publisher.quit(), subscriber.quit()]);
});
beforeEach(async () => {
  vi.stubEnv('KILTER_LIVE_SYNC_ENABLED', '1');
  await db
    .insert(schema.users)
    .values({ id: linkedUser, email: 'live@kilter.test', name: 'Live test user' })
    .onConflictDoNothing();
  vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
  vi.spyOn(redisClientManager, 'getClients').mockReturnValue({ publisher, subscriber, streamConsumer: publisher });
  publishEvent.mockClear();
  vi.spyOn(pubsub, 'publishBoardPresenceEvent').mockImplementation(publishEvent);
  vi.mocked(fetchKilterLiveHistory).mockReset().mockResolvedValue([]);
  vi.mocked(getStoredKilterAccessToken).mockClear();
  boardUuid = randomUUID();
  climbUuid = randomUUID();
  sourceKey = `kilter:${boardUuid}:wall`;
  const [gym] = await db
    .insert(schema.gyms)
    .values({ uuid: randomUUID(), name: 'Test gym', ownerId: linkedUser })
    .returning();
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid: boardUuid,
      slug: boardUuid,
      name: 'Test board',
      ownerId: linkedUser,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '2,1',
      gymId: gym.id,
    })
    .returning();
  boardId = board.id;
  await db.insert(schema.locationSyncGymSources).values({ sourceKey: `kilter:${boardUuid}`, gymId: gym.id });
  await db.insert(schema.kilterWallSources).values({
    sourceKey,
    sourceBoardUuid: boardUuid,
    gymUuid: boardUuid,
    productLayoutUuid: 'layout',
    wallUuid: 'wall',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
  });
  await db
    .insert(schema.boardClimbs)
    .values({ uuid: climbUuid, boardType: 'kilter', layoutId: 1, name: 'Catalog climb', frames: 'p1r12' });
  await db
    .insert(schema.auroraCredentials)
    .values({ userId: linkedUser, boardType: 'kilter', encryptedRefreshToken: 'test-ciphertext' })
    .onConflictDoUpdate({
      target: [schema.auroraCredentials.userId, schema.auroraCredentials.boardType],
      set: { encryptedRefreshToken: 'test-ciphertext' },
    });
  await db
    .insert(schema.userBoardMappings)
    .values({ userId: linkedUser, boardType: 'kilter', boardUserIdText: 'upstream-user' })
    .onConflictDoNothing();
});
afterEach(async () => {
  await Promise.all(pollers.splice(0).map((poller) => poller.shutdown()));
  await publisher.del(
    `kilter-live:${boardId}:viewers`,
    `kilter-live:${boardId}:owner`,
    `kilter-live:${boardId}:next`,
    `board:${boardId}:kilter-history`,
    `board:${boardId}:aurora-history`,
    `board:${boardId}:history`,
    `board:${boardId}:seq`,
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function display(overrides: Partial<KilterLiveDisplay> = {}): KilterLiveDisplay {
  return {
    climbUuid,
    angle: 40,
    displayedAt: new Date().toISOString(),
    occurrenceKey: randomUUID(),
    displayName: null,
    ...overrides,
  };
}
function poller() {
  const sync = new KilterLiveSync();
  pollers.push(sync);
  return sync;
}

describe('Kilter history integration', () => {
  it.each([
    { depth: 3, listed: true },
    { depth: 3, listed: false },
    { depth: 4, listed: true },
  ])(
    'diagnoses only unresolved searches beyond the merge bound: $depth links, listed=$listed',
    async ({ depth, listed }) => {
      const [original] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.id, boardId));
      await db
        .update(schema.kilterWallSources)
        .set({ isListed: listed })
        .where(eq(schema.kilterWallSources.sourceKey, sourceKey));
      let previousBoardId = boardId;
      for (let link = 0; link < depth; link++) {
        const [survivor] = await db
          .insert(schema.userBoards)
          .values({
            uuid: randomUUID(),
            slug: randomUUID(),
            name: 'Merged survivor',
            ownerId: linkedUser,
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2',
            gymId: original.gymId,
          })
          .returning();
        await db
          .update(schema.userBoards)
          .set({ deletedAt: new Date(), mergedIntoBoardUuid: survivor.uuid })
          .where(eq(schema.userBoards.id, previousBoardId));
        previousBoardId = survivor.id;
      }
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const matched = await matchKilterWall(previousBoardId);
      if (depth === 3 && listed) expect(matched).toMatchObject({ sourceKey, boardId: previousBoardId });
      else expect(matched).toBeNull();
      if (depth > 3) {
        expect(warn).toHaveBeenCalledExactlyOnceWith('[KilterLive] Unresolved wall exceeds merge lookup depth', {
          boardId: previousBoardId,
          maxDepth: 3,
        });
      } else expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 42, 'not-a-timestamp'])(
    'recovers durable history for invalid cached sentAt %s',
    async (sentAt) => {
      const wall = (await matchKilterWall(boardId))!;
      await importKilterDisplays(wall, [display()], async () => true);
      const [entry] = (await readBoardHistoryPage(boardId)).entries;
      await publisher.set(`board:${boardId}:kilter-history`, JSON.stringify([{ ...entry, sentAt }]));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

      expect(await readMergedRecentHistory(boardId)).toEqual([entry]);
      expect(warn).toHaveBeenCalledWith('[BoardHistory] Invalid imported history cache; reading durable history', {
        boardId,
        source: 'kilter',
      });
    },
  );

  it('logs malformed native timestamps while retaining valid recent history', async () => {
    const wall = (await matchKilterWall(boardId))!;
    await importKilterDisplays(wall, [display()], async () => true);
    const [entry] = (await readBoardHistoryPage(boardId)).entries;
    vi.spyOn(pubsub, 'getRecentBoardClimbs').mockResolvedValue([
      { ...entry, seq: entry.seq + 1, source: 'boardsesh', sentAt: 'invalid' },
      { ...entry, seq: entry.seq + 2, source: 'boardsesh', sentAt: '2000-01-01T00:00:00Z' },
    ]);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    expect(await readMergedRecentHistory(boardId)).toEqual([entry]);
    expect(warn).toHaveBeenCalledWith('[BoardHistory] Skipped history with invalid timestamps', {
      boardId,
      invalidTimestampCount: 1,
    });
  });

  it.each([
    ['angle', '40'],
    ['angle', 40.5],
    ['frames', {}],
    ['name', false],
    ['grade', 5],
    ['gradeColor', []],
    ['setter', 2],
    ['queueItemUuid', {}],
    ['sentByDisplayName', []],
    ['sentByAvatarUrl', false],
    ['sentByUserId', 4],
    ['seq', -1],
    ['seq', 1.5],
  ])('recovers durable history for invalid cached %s', async (field, invalidField) => {
    const wall = (await matchKilterWall(boardId))!;
    await importKilterDisplays(wall, [display()], async () => true);
    const [entry] = (await readBoardHistoryPage(boardId)).entries;
    await publisher.set(
      `board:${boardId}:kilter-history`,
      JSON.stringify([{ ...entry, [field as string]: invalidField }]),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    expect(await readMergedRecentHistory(boardId)).toEqual([entry]);
    expect(warn).toHaveBeenCalledWith('[BoardHistory] Invalid imported history cache; reading durable history', {
      boardId,
      source: 'kilter',
    });
  });

  it('provides the transaction connection for the eligibility check under the board lock', async () => {
    const wall = (await matchKilterWall(boardId))!;
    let checkedWithinTransaction = false;
    await importKilterDisplays(wall, [display()], async (reader) => {
      if (reader) {
        expect(reader).not.toBe(db);
        const [board] = await reader
          .select({ id: schema.userBoards.id })
          .from(schema.userBoards)
          .where(eq(schema.userBoards.id, boardId));
        expect(board.id).toBe(boardId);
        checkedWithinTransaction = true;
      }
      return true;
    });
    expect(checkedWithinTransaction).toBe(true);
    expect((await readBoardHistoryPage(boardId)).entries).toHaveLength(1);
  });

  it('retains climb metadata without borrowing a grade from another angle', async () => {
    await db
      .insert(schema.boardDifficultyGrades)
      .values({ boardType: 'kilter', difficulty: 987, boulderName: 'Test grade' })
      .onConflictDoNothing();
    await db
      .insert(schema.boardClimbStats)
      .values({ boardType: 'kilter', climbUuid, angle: 40, displayDifficulty: 987 });
    const wall = (await matchKilterWall(boardId))!;

    expect(await importKilterDisplays(wall, [display({ angle: 40 }), display({ angle: 50 })], async () => true)).toBe(
      2,
    );
    const { entries } = await readBoardHistoryPage(boardId);
    expect(entries.find((entry) => entry.angle === 40)).toMatchObject({ grade: 'Test grade' });
    expect(entries.find((entry) => entry.angle === 50)).toMatchObject({
      name: 'Catalog climb',
      frames: 'p1r12',
      grade: null,
    });
  });

  it('stops between occurrences when eligibility is lost and leaves the cache untouched', async () => {
    const wall = (await matchKilterWall(boardId))!;
    const first = display();
    // Initial check, first loop check, and first transaction check succeed;
    // eligibility disappears before the second occurrence starts.
    const isCurrent = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    expect(await importKilterDisplays(wall, [first, display()], isCurrent)).toBe(1);
    const rows = await db.select().from(schema.boardClimbEvents).where(eq(schema.boardClimbEvents.boardId, boardId));
    expect(rows.map((row) => row.externalOccurrenceKey)).toEqual([first.occurrenceKey]);
    expect(await publisher.get(`board:${boardId}:kilter-history`)).toBeNull();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('does not commit when eligibility is lost inside the transaction', async () => {
    const wall = (await matchKilterWall(boardId))!;
    const isCurrent = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    expect(await importKilterDisplays(wall, [display()], isCurrent)).toBe(0);
    expect((await readBoardHistoryPage(boardId)).entries).toEqual([]);
    expect(await publisher.get(`board:${boardId}:kilter-history`)).toBeNull();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it.each([
    { change: { layoutId: 2 }, reason: 'board_unavailable_or_layout_changed' },
    { change: { sizeId: 20 }, reason: 'wall_binding_changed' },
  ])('logs changed mapping validation once per batch: $reason', async ({ change, reason }) => {
    const wall = (await matchKilterWall(boardId))!;
    await db.update(schema.userBoards).set(change).where(eq(schema.userBoards.id, boardId));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    expect(await importKilterDisplays(wall, [display(), display()], async () => true)).toBe(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[KilterLive] Import validation failed', {
      boardId,
      sourceKey,
      reason,
    });
    expect((await readBoardHistoryPage(boardId)).entries).toEqual([]);
  });

  it('cleans source mappings when an owning account is deleted', async () => {
    await db.delete(schema.users).where(eq(schema.users.id, linkedUser));
    expect(
      await db.select().from(schema.kilterWallSources).where(eq(schema.kilterWallSources.sourceKey, sourceKey)),
    ).toEqual([]);
  });

  it('merges repeated polls, preserves native reports, and repairs a missing Redis cache', async () => {
    const wall = (await matchKilterWall(boardId))!;
    const entry = display();
    await db.insert(schema.boardClimbEvents).values({
      boardId,
      boardType: 'kilter',
      climbUuid,
      angle: 40,
      seq: 1,
      confirmedAt: entry.displayedAt,
      userId: linkedUser,
    });
    expect(await importKilterDisplays(wall, [entry], async () => true)).toBe(1);
    expect(await importKilterDisplays(wall, [entry], async () => true)).toBe(0);
    const page = await readBoardHistoryPage(boardId);
    expect(page.entries.map((climb) => climb.source)).toEqual(['kilter', 'boardsesh']);
    expect(page.entries[0]).toMatchObject({
      name: 'Catalog climb',
      sentByUserId: null,
      sentByDisplayName: null,
      frames: 'p1r12',
    });
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent).toHaveBeenCalledWith(
      String(boardId),
      expect.objectContaining({ __typename: 'BoardHistoryUpdated' }),
    );
    expect(await publisher.lrange(`board:${boardId}:history`, 0, -1)).toEqual([]);
    await publisher.del(`board:${boardId}:kilter-history`);
    expect((await readMergedRecentHistory(boardId)).map((climb) => climb.source)).toEqual(['kilter']);
    await importKilterDisplays(wall, [entry], async () => true);
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(await publisher.ttl(`board:${boardId}:kilter-history`)).toBeGreaterThan(600_000);
  });

  it('keeps distinct occurrences, skips unknown climbs, and ignores cancelled work', async () => {
    const wall = (await matchKilterWall(boardId))!;
    expect(
      await importKilterDisplays(wall, [display(), display(), display({ climbUuid: 'missing' })], async () => true),
    ).toBe(2);
    expect(await importKilterDisplays(wall, [display()], async () => false)).toBe(0);
    expect((await readBoardHistoryPage(boardId)).entries).toHaveLength(2);
  });

  it('filters Aurora before legacy pagination and preserves opted-in unknown metadata', async () => {
    const confirmedAt = new Date().toISOString();
    await db.insert(schema.boardClimbEvents).values([
      { boardId, boardType: 'kilter', climbUuid, angle: 40, seq: 1, confirmedAt },
      { boardId, boardType: 'kilter', climbUuid, angle: null, seq: 2, confirmedAt, source: 'aurora' },
      { boardId, boardType: 'kilter', climbUuid, angle: 40, seq: 3, confirmedAt, source: 'kilter' },
    ]);
    const legacy = await readBoardHistoryPage(boardId, 1);
    expect(legacy.entries.map((climb) => climb.seq)).toEqual([3]);
    const nextLegacy = await readBoardHistoryPage(boardId, 1, legacy.nextCursor);
    expect(nextLegacy.entries.map((climb) => climb.seq)).toEqual([1]);
    expect(nextLegacy.nextCursor).toBeNull();
    const capable = await readBoardHistoryPage(boardId, 3, undefined, true);
    expect(capable.entries.map((climb) => climb.source)).toEqual(['kilter', 'aurora', 'boardsesh']);
    expect(capable.entries[1]).toMatchObject({ angle: null, grade: null, sentByUserId: null });
    expect((await readMergedRecentHistory(boardId)).map((climb) => climb.source)).toEqual(['kilter']);
    expect((await readMergedRecentHistory(boardId, true)).map((climb) => climb.source)).toEqual(['kilter', 'aurora']);
  });

  it('pages by display time and sequence, retaining microseconds despite late arrival', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-02T12:00:00Z'));
    for (const [seq, confirmedAt] of [
      [1, '2026-01-01 12:00:00.000002'],
      [2, '2026-01-01 12:00:00.000001'],
      [3, '2025-12-30 00:00:00'],
      [4, '2026-01-01 12:00:00.000002'],
    ] as const) {
      await db
        .insert(schema.boardClimbEvents)
        .values({ boardId, boardType: 'kilter', climbUuid, angle: 40, seq, confirmedAt });
    }
    const first = await readBoardHistoryPage(boardId, 2);
    expect(first.entries.map((climb) => climb.seq)).toEqual([4, 1]);
    const second = await readBoardHistoryPage(boardId, 2, first.nextCursor);
    expect(second.entries.map((climb) => climb.seq)).toEqual([2, 3]);
    expect(second.nextCursor).toBeNull();
    expect(() => parseHistoryPageCursor(first.nextCursor!, boardId + 1)).toThrow('Invalid history cursor');
  });

  it('bounds chronological pages by display time before limits, including late imports and exact cutoffs', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-24T12:00:00.123Z'));
    for (const [seq, confirmedAt, source] of [
      [1, '2026-11-17 12:00:00.123000', 'boardsesh'],
      [2, '2026-11-17 12:00:00.123001', 'kilter'],
      [3, '2026-11-18 12:00:00', 'boardsesh'],
      [4, '2026-11-17 12:00:00.122999', 'kilter'],
      [5, '2026-01-01 12:00:00', 'boardsesh'],
    ] as const) {
      await db
        .insert(schema.boardClimbEvents)
        .values({ boardId, boardType: 'kilter', climbUuid, angle: 40, seq, confirmedAt, source });
    }
    const first = await readBoardHistoryPage(boardId, 1);
    expect(first.entries.map((entry) => entry.seq)).toEqual([3]);
    const final = await readBoardHistoryPage(boardId, 2, first.nextCursor);
    expect(final.entries.map((entry) => entry.seq)).toEqual([2, 1]);
    expect(final.nextCursor).toBeNull();
    const cursor = (timestamp: string, cursorBoard = boardId) =>
      Buffer.from(JSON.stringify([cursorBoard, timestamp, 100])).toString('base64url');
    expect(await readBoardHistoryPage(boardId, 2, cursor('2026-01-01 12:00:00'))).toEqual({
      entries: [],
      nextCursor: null,
    });
    expect(
      (await readBoardHistoryPage(boardId, 100, cursor('2027-01-01 12:00:00'))).entries.map((entry) => entry.seq),
    ).toEqual([3, 2, 1]);
    await expect(readBoardHistoryPage(boardId, 2, cursor('2026-01-01 12:00:00', boardId + 1))).rejects.toThrow(
      'Invalid history cursor',
    );
    await expect(readBoardHistoryPage(boardId, 2, 'invalid')).rejects.toThrow('Invalid history cursor');
    clock.mockReturnValue(Date.parse('2026-11-24T12:00:00.124Z'));
    expect(await readBoardHistoryPage(boardId, 2, first.nextCursor)).toEqual({ entries: [], nextCursor: null });
    expect(
      await db.select().from(schema.boardClimbEvents).where(eq(schema.boardClimbEvents.boardId, boardId)),
    ).toHaveLength(5);
  });

  it('applies the window to opted-in Aurora pages and cached displays', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-24T12:00:00.123Z'));
    const displays = [
      { seq: 1, sentAt: '2026-11-17T12:00:00.122999Z' },
      { seq: 2, sentAt: '2026-11-17T12:00:00.123000Z' },
      { seq: 3, sentAt: '2026-11-17T12:00:00.123001Z' },
      { seq: 4, sentAt: '2026-11-24T11:00:00Z' },
    ];
    await db.insert(schema.boardClimbEvents).values(
      displays.map(({ seq, sentAt }) => ({
        boardId,
        boardType: 'kilter',
        climbUuid,
        seq,
        confirmedAt: sentAt,
        source: 'aurora',
      })),
    );
    await publisher.set(
      `board:${boardId}:aurora-history`,
      JSON.stringify(displays.map((display) => ({ ...display, climbUuid, source: 'aurora' }))),
      'EX',
      604800,
    );
    expect(await readBoardHistoryPage(boardId)).toEqual({ entries: [], nextCursor: null });
    expect(await readMergedRecentHistory(boardId)).toEqual([]);
    const first = await readBoardHistoryPage(boardId, 1, undefined, true);
    expect(first.entries.map((entry) => entry.seq)).toEqual([4]);
    const final = await readBoardHistoryPage(boardId, 2, first.nextCursor, true);
    expect(final.entries.map((entry) => entry.seq)).toEqual([3, 2]);
    expect(final.nextCursor).toBeNull();
    expect((await readMergedRecentHistory(boardId, true)).map((entry) => entry.seq)).toEqual([4, 3, 2]);
    clock.mockReturnValue(Date.parse('2026-11-24T12:00:00.124Z'));
    expect(await readBoardHistoryPage(boardId, 2, first.nextCursor, true)).toEqual({ entries: [], nextCursor: null });
    expect((await readMergedRecentHistory(boardId, true)).map((entry) => entry.seq)).toEqual([4]);
  });

  it('rechecks native and imported Redis entries even when a newer write refreshed their key TTL', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-24T12:00:00Z'));
    vi.spyOn(pubsub, 'isRedisConnected').mockReturnValue(true);
    const old = { climbUuid, seq: 1, sentAt: '2026-11-01T12:00:00Z' };
    const recent = { climbUuid, seq: 2, sentAt: '2026-11-24T11:00:00Z' };
    await publisher.rpush(`board:${boardId}:history`, JSON.stringify(old), JSON.stringify(recent));
    await publisher.expire(`board:${boardId}:history`, 604800);
    await publisher.set(
      `board:${boardId}:kilter-history`,
      JSON.stringify([{ ...old, seq: 3, source: 'kilter' }]),
      'EX',
      604800,
    );
    expect((await readMergedRecentHistory(boardId)).map((entry) => entry.seq)).toEqual([2]);
    expect((await pubsub.getRecentBoardClimbs(String(boardId))).map((entry) => entry.seq)).toEqual([2, 1]);
  });

  it('follows merged source boards and refuses changed configuration or gym identity', async () => {
    const original = await matchKilterWall(boardId);
    expect(original).not.toBeNull();
    await db.update(schema.userBoards).set({ sizeId: 20 }).where(eq(schema.userBoards.id, boardId));
    expect(await matchKilterWall(boardId)).toBeNull();
    expect(await importKilterDisplays(original!, [display()], async () => true)).toBe(0);
    await db.update(schema.userBoards).set({ sizeId: 10, gymId: null }).where(eq(schema.userBoards.id, boardId));
    expect(await matchKilterWall(boardId)).toBeNull();
    const [source] = await db
      .select()
      .from(schema.locationSyncGymSources)
      .where(eq(schema.locationSyncGymSources.sourceKey, `kilter:${boardUuid}`));
    const [survivor] = await db
      .insert(schema.userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        name: 'Survivor',
        ownerId: linkedUser,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        gymId: source.gymId,
      })
      .returning();
    await db
      .update(schema.userBoards)
      .set({ deletedAt: new Date(), mergedIntoBoardUuid: survivor.uuid })
      .where(eq(schema.userBoards.id, boardId));
    expect(await matchKilterWall(survivor.id)).toMatchObject({ sourceKey, boardId: survivor.id });
  });
});

describe('presence subscription lifetime', () => {
  it('releases the Kilter watcher and listener immediately while next is idle', async () => {
    const unsubscribe = vi.fn();
    const stopWatching = vi.fn();
    vi.spyOn(pubsub, 'subscribeBoardPresence').mockResolvedValue(unsubscribe);
    const watch = vi.spyOn(kilterLiveSync, 'watch').mockReturnValue(stopWatching);
    const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(
      undefined,
      { boardId },
      {
        connectionId: 'idle-socket',
        userId: linkedUser,
        isAuthenticated: true,
      },
    );
    const pending = iterator.next();
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(boardId, linkedUser, 'idle-socket'));

    await iterator.return();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(stopWatching).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await iterator.return();
    expect(stopWatching).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('filters Aurora subscription payloads unless opted in: %s', async (includeAurora) => {
    let deliver: ((event: import('@boardsesh/shared-schema').BoardPresenceEvent) => void) | undefined;
    vi.spyOn(pubsub, 'subscribeBoardPresence').mockImplementation(async (_key, callback) => {
      deliver = callback;
      return () => {};
    });
    vi.spyOn(kilterLiveSync, 'watch').mockReturnValue(vi.fn());
    const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(
      undefined,
      { boardId, includeAurora },
      { connectionId: 'capability-socket', userId: linkedUser, isAuthenticated: true },
    );
    const pending = iterator.next();
    await vi.waitFor(() => expect(deliver).toBeDefined());
    const climbs: import('@boardsesh/shared-schema').BoardPresenceClimb[] = [
      { climbUuid, source: 'aurora', seq: 20, angle: null, sentAt: new Date().toISOString() },
      { climbUuid, source: 'kilter', seq: 19, angle: 40, sentAt: new Date().toISOString() },
      {
        climbUuid,
        source: 'future-provider',
        seq: 999,
        sentAt: new Date().toISOString(),
      } as unknown as import('@boardsesh/shared-schema').BoardPresenceClimb,
    ];
    deliver!({ __typename: 'BoardHistoryUpdated', climbs, seq: 21 });
    const message = await pending;
    expect(message.done).toBe(false);
    const event: import('@boardsesh/shared-schema').BoardPresenceEvent | undefined = message.value?.boardNowPlaying;
    expect(event?.__typename).toBe('BoardHistoryUpdated');
    if (event?.__typename === 'BoardHistoryUpdated') {
      expect(event.climbs.map((climb) => climb.source)).toEqual(includeAurora ? ['aurora', 'kilter'] : ['kilter']);
    }
    await iterator.return();
  });

  it('never starts a Kilter watcher when unsubscribe precedes Redis setup completion', async () => {
    const unsubscribe = vi.fn();
    let finishSetup!: (cleanup: () => void) => void;
    const subscribe = vi.spyOn(pubsub, 'subscribeBoardPresence').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSetup = resolve;
        }),
    );
    const watch = vi.spyOn(kilterLiveSync, 'watch').mockReturnValue(vi.fn());
    const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(
      undefined,
      { boardId },
      {
        connectionId: 'setup-socket',
        userId: linkedUser,
        isAuthenticated: true,
      },
    );
    const pending = iterator.next();
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

    await iterator.return();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    finishSetup(unsubscribe);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(watch).not.toHaveBeenCalled();
  });
});

describe('subscription-driven polling', () => {
  it('benches a revoked Kilter grant across walls and uses a valid alternate viewer', async () => {
    const alternateUser = 'zz-valid-kilter-viewer';
    await db.insert(schema.users).values({ id: alternateUser, email: `${alternateUser}@test.invalid` });
    await db.insert(schema.auroraCredentials).values({
      userId: alternateUser,
      boardType: 'kilter',
      encryptedRefreshToken: 'alternate-ciphertext',
    });
    await db.insert(schema.userBoardMappings).values({
      userId: alternateUser,
      boardType: 'kilter',
      boardUserIdText: 'alternate-upstream-user',
    });
    const [firstBoard] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.id, boardId));
    const secondUuid = randomUUID();
    const [secondBoard] = await db
      .insert(schema.userBoards)
      .values({
        uuid: secondUuid,
        slug: secondUuid,
        name: 'Second watched wall',
        ownerId: linkedUser,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
        gymId: firstBoard.gymId,
      })
      .returning();
    await db.insert(schema.kilterWallSources).values({
      sourceKey: `${sourceKey}:second`,
      sourceBoardUuid: secondUuid,
      gymUuid: boardUuid,
      productLayoutUuid: 'layout',
      wallUuid: 'second-wall',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    });
    vi.mocked(getStoredKilterAccessToken).mockImplementation(async (_database, userId) => {
      if (userId === linkedUser) throw new KilterApiError('invalid_grant', 'Revoked grant', 400);
      return 'alternate-token';
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const sync = poller();
    try {
      sync.watch(boardId, linkedUser, 'revoked-first-wall');
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[KilterLive] Poll failed',
          expect.objectContaining({ kind: 'invalid_grant' }),
        ),
      );
      sync.watch(secondBoard.id, linkedUser, 'revoked-second-wall');
      sync.watch(secondBoard.id, alternateUser, 'valid-second-wall');
      await vi.waitFor(() =>
        expect(fetchKilterLiveHistory).toHaveBeenCalledWith(
          'alternate-token',
          expect.any(Object),
          expect.any(AbortSignal),
        ),
      );
      expect(
        vi.mocked(getStoredKilterAccessToken).mock.calls.filter(([, userId]) => userId === linkedUser),
      ).toHaveLength(1);
    } finally {
      await sync.shutdown();
      vi.mocked(getStoredKilterAccessToken).mockImplementation(async () => 'test-access-token');
      await publisher.del(
        `kilter-live:${secondBoard.id}:viewers`,
        `kilter-live:${secondBoard.id}:owner`,
        `kilter-live:${secondBoard.id}:next`,
      );
    }
  });

  it('releases the board lock without importing when the in-transaction Redis read stalls', async () => {
    vi.mocked(fetchKilterLiveHistory).mockResolvedValue([display()]);
    const transactions = vi.spyOn(db, 'transaction');
    const originalGet = publisher.get.bind(publisher);
    const stalledGet = vi.spyOn(publisher, 'get').mockImplementation((key) => {
      if (key === `kilter-live:${boardId}:owner` && transactions.mock.calls.length) {
        return new Promise(() => {});
      }
      return originalGet(key);
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(
      () => expect(warn).toHaveBeenCalledWith('[KilterLive] Poll failed', expect.objectContaining({ boardId })),
      { timeout: 4000 },
    );
    stalledGet.mockRestore();
    // A subsequent board write must acquire the lock after the read deadline,
    // even though the mocked Redis response never completes.
    await db.update(schema.userBoards).set({ name: 'Lock released' }).where(eq(schema.userBoards.id, boardId));
    expect((await readBoardHistoryPage(boardId)).entries).toEqual([]);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('logs failed Redis viewer removal and still removes the local watcher and aborts its read', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetchKilterLiveHistory).mockImplementation((_token, _wall, signal) => {
      requestSignal = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    });
    const sync = poller();
    const stop = sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const remove = vi.spyOn(publisher, 'zrem').mockRejectedValueOnce(new Error('test removal failure'));
    stop();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[KilterLive] Viewer removal coordination failed', {
        boardId,
        error: 'test removal failure',
      }),
    );
    expect(requestSignal?.aborted).toBe(true);
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${boardId}:next`)).not.toBeNull());
  });

  it('releases every operation on a socket while preserving another connected viewer', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetchKilterLiveHistory).mockImplementation((_token, _wall, signal) => {
      requestSignal = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    });
    const sync = poller();
    sync.watch(boardId, linkedUser, 'shared-socket');
    sync.watch(boardId, linkedUser, 'shared-socket');
    const stopOther = sync.watch(boardId, linkedUser, 'other-socket');
    await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${boardId}:viewers`)).toBe(3));
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));

    sync.releaseConnection('shared-socket');
    sync.releaseConnection('shared-socket');
    await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${boardId}:viewers`)).toBe(1));
    expect(requestSignal?.aborted).toBe(false);
    stopOther();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${boardId}:owner`)).toBeNull());
  });

  it('releases a socket across all watched boards', async () => {
    const [secondBoard] = await db
      .insert(schema.userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        name: 'Another board',
        ownerId: linkedUser,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      })
      .returning();
    const sync = poller();
    sync.watch(boardId, linkedUser, 'shared-socket');
    sync.watch(secondBoard.id, linkedUser, 'shared-socket');
    try {
      for (const watchedBoardId of [boardId, secondBoard.id]) {
        await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${watchedBoardId}:viewers`)).toBe(1));
        await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${watchedBoardId}:next`)).not.toBeNull());
      }
      sync.releaseConnection('shared-socket');
      for (const watchedBoardId of [boardId, secondBoard.id]) {
        await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${watchedBoardId}:viewers`)).toBe(0));
        await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${watchedBoardId}:owner`)).toBeNull());
      }
    } finally {
      await sync.shutdown();
      await publisher.del(
        `kilter-live:${secondBoard.id}:viewers`,
        `kilter-live:${secondBoard.id}:owner`,
        `kilter-live:${secondBoard.id}:next`,
      );
    }
  });

  it('reacts to remote credential broadcasts without waiting for the heartbeat', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetchKilterLiveHistory).mockImplementation((_token, _wall, signal) => {
      requestSignal = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    });
    const owner = poller();
    const remote = poller();
    owner.watch(boardId, linkedUser, 'owner-socket');
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));
    await db.delete(schema.auroraCredentials).where(eq(schema.auroraCredentials.userId, linkedUser));

    // The remote instance has no local watchers: only its Redis broadcast can
    // wake the owner before its 15-second heartbeat.
    await remote.credentialsChanged();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true), { timeout: 2000 });
    await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${boardId}:owner`)).toBeNull());
    expect((await readBoardHistoryPage(boardId)).entries).toEqual([]);
  });

  it('cleans up a failed Redis control subscription and retries successfully', async () => {
    const baselineListeners = subscriber.listenerCount('message');
    vi.spyOn(subscriber, 'subscribe').mockRejectedValueOnce(new Error('test subscribe failure'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[KilterLive] Coordination failed', {
        boardId,
        error: 'test subscribe failure',
      }),
    );
    expect(subscriber.listenerCount('message')).toBe(baselineListeners);
    expect(fetchKilterLiveHistory).not.toHaveBeenCalled();

    await sync.credentialsChanged();
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));
    expect(subscriber.listenerCount('message')).toBe(baselineListeners + 1);
    await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${boardId}:next`)).not.toBeNull());
  });

  it('does not poll after a Redis lease pipeline error and recovers on retry', async () => {
    const failedPipeline = publisher.pipeline();
    vi.spyOn(failedPipeline, 'exec').mockResolvedValueOnce([[new Error('test lease failure'), null]]);
    vi.spyOn(publisher, 'pipeline').mockReturnValueOnce(failedPipeline);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[KilterLive] Coordination failed', {
        boardId,
        error: 'Kilter viewer lease update failed',
      }),
    );
    expect(fetchKilterLiveHistory).not.toHaveBeenCalled();
    expect(await publisher.get(`kilter-live:${boardId}:owner`)).toBeNull();

    await sync.credentialsChanged();
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${boardId}:next`)).not.toBeNull());
  });

  it('aborts an active read on a Redis coordination error without importing its late response', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetchKilterLiveHistory).mockImplementation((_token, _wall, signal) => {
      requestSignal = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve([display()]), { once: true }));
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));
    vi.spyOn(publisher, 'zrangebyscore').mockRejectedValueOnce(new Error('test Redis outage'));

    await sync.credentialsChanged();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(warn).toHaveBeenCalledWith('[KilterLive] Coordination failed', { boardId, error: 'test Redis outage' });
    await vi.waitFor(async () => expect(await publisher.get(`kilter-live:${boardId}:next`)).not.toBeNull());
    expect((await readBoardHistoryPage(boardId)).entries).toEqual([]);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('waits five minutes to retry an unmatched wall without requesting credentials or history', async () => {
    await db
      .update(schema.kilterWallSources)
      .set({ isListed: false })
      .where(eq(schema.kilterWallSources.sourceKey, sourceKey));
    const startedAt = Date.now();
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(async () =>
      expect(Number(await publisher.get(`kilter-live:${boardId}:next`))).toBeGreaterThanOrEqual(startedAt + 300_000),
    );
    await sync.credentialsChanged();
    expect(getStoredKilterAccessToken).not.toHaveBeenCalled();
    expect(fetchKilterLiveHistory).not.toHaveBeenCalled();
  });

  it('refreshes a rejected access token once and waits at least 30 seconds', async () => {
    vi.mocked(fetchKilterLiveHistory).mockRejectedValueOnce(new KilterLiveError(401)).mockResolvedValue([]);
    const startedAt = Date.now();
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(async () =>
      expect(Number(await publisher.get(`kilter-live:${boardId}:next`))).toBeGreaterThan(startedAt + 29_999),
    );
    expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(2);
    expect(getStoredKilterAccessToken).toHaveBeenLastCalledWith(db, linkedUser, expect.any(Object), true);
    await sync.credentialsChanged();
    expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After without starting another request on viewer changes', async () => {
    vi.mocked(fetchKilterLiveHistory).mockRejectedValue(new KilterLiveError(429, 600_000));
    const startedAt = Date.now();
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(async () =>
      expect(Number(await publisher.get(`kilter-live:${boardId}:next`))).toBeGreaterThanOrEqual(startedAt + 600_000),
    );
    sync.watch(boardId, linkedUser, 'second-socket');
    await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${boardId}:viewers`)).toBe(2));
    expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1);
  });

  it('has one owner across instances and stops after the last linked viewer leaves', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetchKilterLiveHistory).mockImplementation((_token, _wall, signal) => {
      requestSignal = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    });
    const first = poller();
    const second = poller();
    const stopFirst = first.watch(boardId, linkedUser, 'socket-one');
    const stopSecond = second.watch(boardId, linkedUser, 'socket-two');
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${boardId}:viewers`)).toBe(2));
    stopFirst();
    await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${boardId}:viewers`)).toBe(1));
    expect(requestSignal?.aborted).toBe(false);
    stopSecond();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1);
  });

  it('does not poll for unlinked users and aborts when credentials are removed', async () => {
    await db.delete(schema.auroraCredentials).where(eq(schema.auroraCredentials.userId, linkedUser));
    const sync = poller();
    sync.watch(boardId, linkedUser, 'socket');
    await vi.waitFor(async () => expect(await publisher.zcard(`kilter-live:${boardId}:viewers`)).toBe(1));
    expect(fetchKilterLiveHistory).not.toHaveBeenCalled();
    await db
      .insert(schema.auroraCredentials)
      .values({ userId: linkedUser, boardType: 'kilter', encryptedRefreshToken: 'new-ciphertext' });
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetchKilterLiveHistory).mockImplementation((_token, _wall, signal) => {
      requestSignal = signal;
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    });
    await sync.credentialsChanged();
    await vi.waitFor(() => expect(fetchKilterLiveHistory).toHaveBeenCalledTimes(1));
    await db.delete(schema.auroraCredentials).where(eq(schema.auroraCredentials.userId, linkedUser));
    await sync.credentialsChanged();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect((await readBoardHistoryPage(boardId)).entries).toEqual([]);
  });
});
