import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import {
  fetchKilterLiveHistory,
  getStoredKilterAccessToken,
  KilterLiveError,
  type KilterLiveDisplay,
} from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { importKilterDisplays, matchKilterWall } from '../services/kilter-live-import';
import { parseHistoryPageCursor, readBoardHistoryPage, readMergedRecentHistory } from '../services/board-history';
import { KilterLiveSync } from '../services/kilter-live-sync';

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

  it('pages by display time and sequence, retaining microseconds despite late arrival', async () => {
    for (const [seq, confirmedAt] of [
      [1, '2026-01-01 12:00:00.000002'],
      [2, '2026-01-01 12:00:00.000001'],
      [3, '2025-12-01 00:00:00'],
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

describe('subscription-driven polling', () => {
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
