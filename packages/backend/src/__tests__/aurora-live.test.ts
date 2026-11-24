import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { AuroraRequestError, fetchAuroraLiveHistory, type AuroraLiveDisplay } from '@boardsesh/aurora-sync/api';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { redisClientManager } from '../redis/client';
import { AuroraLiveSync, auroraLiveSync, isAuroraLiveEnabled } from '../services/aurora-live-sync';
import { boardPresenceSubscriptions } from '../graphql/resolvers/board-presence/subscription';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { importAuroraDisplays, matchAuroraWall } from '../services/aurora-live-import';
import { getAuroraLiveToken } from '../services/aurora-live-token';
import { catchUpAuroraHistory, parseAuroraCheckpoint } from '../services/aurora-live-catchup';
import { logger } from '../utils/logger';

vi.mock('@boardsesh/aurora-sync/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/aurora-sync/api')>()),
  fetchAuroraLiveHistory: vi.fn(),
}));
vi.mock('../services/aurora-live-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/aurora-live-token')>()),
  getAuroraLiveToken: vi.fn(async () => 'test-session'),
}));
let publisher: Redis;
let subscriber: Redis;
let boardId: number;
let boardUuid: string;
let climbUuid: string;
let serial: string;
let sourceKey: string;
let gymId: number;
let gymUserId: number;
const userId = 'aurora-live-test-user';
const pollers: AuroraLiveSync[] = [];
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
  vi.stubEnv('AURORA_LIVE_SYNC_ENABLED', '1');
  vi.stubEnv('AURORA_LIVE_SYNC_BOARDS', 'tension,decoy,touchstone,grasshopper,soill');
  await db.insert(schema.users).values({ id: userId, email: 'live@aurora.test' }).onConflictDoNothing();
  vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
  vi.spyOn(redisClientManager, 'getClients').mockReturnValue({ publisher, subscriber, streamConsumer: publisher });
  vi.spyOn(pubsub, 'publishBoardPresenceEvent').mockImplementation(publishEvent);
  publishEvent.mockClear();
  vi.mocked(fetchAuroraLiveHistory).mockReset().mockResolvedValue([]);
  vi.mocked(getAuroraLiveToken).mockReset().mockResolvedValue('test-session');
  boardUuid = randomUUID();
  climbUuid = randomUUID();
  serial = randomUUID();
  sourceKey = `tension:${boardUuid}`;
  gymUserId = Math.floor(Math.random() * 100_000_000) + 1;
  const [gym] = await db
    .insert(schema.gyms)
    .values({ uuid: randomUUID(), name: 'Aurora fixture', ownerId: userId })
    .returning();
  gymId = gym.id;
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid: boardUuid,
      slug: boardUuid,
      name: 'Fixture TB2',
      ownerId: userId,
      boardType: 'tension',
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
      gymId,
      serialNumber: serial,
    })
    .returning();
  boardId = board.id;
  await db.insert(schema.locationSyncGymSources).values({ sourceKey: `tension:${gymUserId}`, gymId });
  await db.insert(schema.auroraWallSources).values({
    sourceKey,
    sourceBoardUuid: boardUuid,
    boardType: 'tension',
    gymUserId,
    wallUuid: 'physical-wall',
    serialNumber: serial,
    layoutId: 10,
    sizeId: 6,
    setIds: '13,12',
  });
  await db.insert(schema.boardClimbs).values({
    uuid: climbUuid,
    boardType: 'tension',
    layoutId: 10,
    name: 'Catalog fixture',
    isListed: true,
    frames: 'p1r12',
    setterUsername: 'Fixture setter',
  });
  await db
    .insert(schema.auroraCredentials)
    .values({
      userId,
      boardType: 'tension',
      auroraUserId: 21,
      encryptedUsername: 'test-ciphertext',
      encryptedPassword: 'test-ciphertext',
      auroraToken: 'test-ciphertext',
    })
    .onConflictDoUpdate({
      target: [schema.auroraCredentials.userId, schema.auroraCredentials.boardType],
      set: { auroraUserId: 21, syncStatus: 'active' },
    });
});
afterEach(async () => {
  await Promise.all(pollers.splice(0).map((poller) => poller.shutdown()));
  await publisher.del(
    `aurora-live:${boardId}:viewers`,
    `aurora-live:${boardId}:owner`,
    `aurora-live:${boardId}:next`,
    `aurora-live:${boardId}:checkpoint`,
    `board:${boardId}:aurora-history`,
    `board:${boardId}:seq`,
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function display(overrides: Partial<AuroraLiveDisplay> = {}): AuroraLiveDisplay {
  const displayedAt = new Date().toISOString().replace('Z', '123Z');
  return {
    climbUuid,
    serialNumber: serial,
    displayedAt,
    rawTimestamp: displayedAt.replace('T', ' ').replace('Z', ''),
    ...overrides,
  };
}
function poller() {
  const instance = new AuroraLiveSync();
  pollers.push(instance);
  return instance;
}

describe('Aurora display imports', () => {
  it.each(['kilter', 'moonboard'])('skips unused Aurora history reads on %s walls', async (boardType) => {
    await db.update(schema.userBoards).set({ boardType }).where(eq(schema.userBoards.id, boardId));
    const cacheRead = vi.spyOn(publisher, 'get');
    expect(
      await boardPresenceQueries.boardRecentHistory(
        undefined,
        { boardId, includeAurora: true },
        { userId, connectionId: 'history-reader', isAuthenticated: true },
      ),
    ).toEqual([]);
    expect(cacheRead).not.toHaveBeenCalledWith(`board:${boardId}:aurora-history`);
  });

  it('keeps imported Tension history readable after new imports are disabled', async () => {
    const wall = await matchAuroraWall(boardId);
    await importAuroraDisplays(wall!, [display()], async () => true);
    vi.stubEnv('AURORA_LIVE_SYNC_ENABLED', '0');
    expect(
      await boardPresenceQueries.boardRecentHistory(
        undefined,
        { boardId, includeAurora: true },
        { userId, connectionId: 'history-reader', isAuthenticated: true },
      ),
    ).toMatchObject([{ source: 'aurora', climbUuid }]);
  });

  it('skips row-locking transactions for a duplicate page and locks only new occurrences', async () => {
    const wall = await matchAuroraWall(boardId);
    const first = display();
    expect(await importAuroraDisplays(wall!, [first], async () => true)).toBe(1);
    const transaction = vi.spyOn(db, 'transaction');
    const repeatedPage = Array.from({ length: 100 }, () => ({ ...first }));
    expect(await importAuroraDisplays(wall!, repeatedPage, async () => true)).toBe(0);
    expect(transaction).not.toHaveBeenCalled();

    const next = display({ displayedAt: first.displayedAt.replace('123Z', '124Z') });
    expect(await importAuroraDisplays(wall!, [...repeatedPage, next, next], async () => true)).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('retains the transactional duplicate guard when concurrent readers prefilter the same new occurrence', async () => {
    const wall = await matchAuroraWall(boardId);
    const occurrence = display();
    const imported = await Promise.all([
      importAuroraDisplays(wall!, [occurrence], async () => true),
      importAuroraDisplays(wall!, [occurrence], async () => true),
    ]);
    expect(imported.reduce((total, count) => total + count, 0)).toBe(1);
    expect(
      await db.select().from(schema.boardClimbEvents).where(eq(schema.boardClimbEvents.boardId, boardId)),
    ).toHaveLength(1);
  });

  it.each([true, false])(
    'retains unknown angle on adjustable=%s walls and deduplicates microsecond occurrences',
    async (adjustable) => {
      await db
        .update(schema.userBoards)
        .set({ isAngleAdjustable: adjustable })
        .where(eq(schema.userBoards.id, boardId));
      const wall = await matchAuroraWall(boardId);
      expect(wall).not.toBeNull();
      const first = display();
      const second = display({ displayedAt: first.displayedAt.replace('123Z', '124Z') });
      expect(await importAuroraDisplays(wall!, [first, first, second], async () => true)).toBe(2);
      expect(await importAuroraDisplays(wall!, [first, second], async () => true)).toBe(0);
      const rows = await db.select().from(schema.boardClimbEvents).where(eq(schema.boardClimbEvents.boardId, boardId));
      expect(rows).toHaveLength(2);
      expect(
        rows.every((row) => row.source === 'aurora' && row.angle === null && row.grade === null && row.userId === null),
      ).toBe(true);
      expect(publishEvent).toHaveBeenCalled();
    },
  );
  it.each([true, false])('rejects reused serials even when the competing source listed=%s', async (isListed) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await db.insert(schema.auroraWallSources).values({
      sourceKey: `${sourceKey}:other`,
      isListed,
      sourceBoardUuid: boardUuid,
      boardType: 'tension',
      gymUserId: 999,
      wallUuid: 'another-wall',
      serialNumber: serial,
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
    });
    expect(await matchAuroraWall(boardId)).toBeNull();
    expect(await matchAuroraWall(boardId)).toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[AuroraLive] Wall binding skipped',
      expect.objectContaining(
        isListed
          ? {
              boardId,
              reason: 'source_mapping_unresolved',
              sourceCount: 2,
            }
          : {
              boardId,
              reason: 'serial_conflict',
              serialNumber: serial,
              conflictingSources: [{ gymUserId: 999, wallUuid: 'another-wall' }],
            },
      ),
    );
  });
  it('does not confuse a different product reusing the same controller serial', async () => {
    await db.insert(schema.auroraWallSources).values({
      sourceKey: 'decoy:999',
      sourceBoardUuid: boardUuid,
      boardType: 'decoy',
      gymUserId: 999,
      wallUuid: 'another-wall',
      serialNumber: serial,
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
    });
    expect(await matchAuroraWall(boardId)).not.toBeNull();
  });
  it('revalidates wall binding inside the import transaction', async () => {
    const wall = await matchAuroraWall(boardId);
    let changed = false;
    const current = async (reader?: Pick<typeof db, 'select'>) => {
      if (reader && !changed) {
        changed = true;
        // Change the source, not the locked canonical board row.
        await db
          .update(schema.auroraWallSources)
          .set({ serialNumber: 'replacement-controller' })
          .where(eq(schema.auroraWallSources.sourceKey, sourceKey));
      }
      return true;
    };
    expect(await importAuroraDisplays(wall!, [display()], current)).toBe(0);
    expect(
      await db.select().from(schema.boardClimbEvents).where(eq(schema.boardClimbEvents.boardId, boardId)),
    ).toHaveLength(0);
  });
  it('does not commit when viewer eligibility disappears while holding the board lock', async () => {
    const wall = await matchAuroraWall(boardId);
    expect(await importAuroraDisplays(wall!, [display()], async (reader) => !reader)).toBe(0);
  });
  it.each([
    { isDraft: true, isListed: true },
    { isDraft: false, isListed: false },
    { isDraft: false, isListed: null },
  ])('never imports nonpublic catalog snapshots: %j', async (visibility) => {
    const wall = await matchAuroraWall(boardId);
    await db.update(schema.boardClimbs).set(visibility).where(eq(schema.boardClimbs.uuid, climbUuid));
    expect(await importAuroraDisplays(wall!, [display()], async () => true)).toBe(0);
  });
  it('rechecks catalog visibility after the initial public lookup', async () => {
    const wall = await matchAuroraWall(boardId);
    let checked = false;
    const current = async (reader?: Pick<typeof db, 'select'>) => {
      if (reader && !checked) {
        checked = true;
        await db.update(schema.boardClimbs).set({ isDraft: true }).where(eq(schema.boardClimbs.uuid, climbUuid));
      }
      return true;
    };
    expect(await importAuroraDisplays(wall!, [display()], current)).toBe(0);
  });
  it('skips foreign serials and unknown climbs', async () => {
    const wall = await matchAuroraWall(boardId);
    expect(
      await importAuroraDisplays(
        wall!,
        [display({ serialNumber: 'foreign' }), display({ climbUuid: randomUUID() })],
        async () => true,
      ),
    ).toBe(0);
  });
});

describe('Aurora viewer-driven lifecycle', () => {
  it.each(['redis', 'owner-lease', 'global-flag', 'board-allowlist'])(
    'resumes after stale %s coordination without rejecting the account for five minutes',
    async (staleReason) => {
      const instance = poller();
      vi.mocked(getAuroraLiveToken).mockImplementationOnce(async () => {
        if (staleReason === 'redis') vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);
        if (staleReason === 'owner-lease') await publisher.del(`aurora-live:${boardId}:owner`);
        if (staleReason === 'global-flag') vi.stubEnv('AURORA_LIVE_SYNC_ENABLED', '0');
        if (staleReason === 'board-allowlist') vi.stubEnv('AURORA_LIVE_SYNC_BOARDS', '');
        return 'test-session';
      });
      instance.watch(boardId, userId, 'coordination-socket');
      await vi.waitFor(() => expect(getAuroraLiveToken).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchAuroraLiveHistory).not.toHaveBeenCalled();
      vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
      vi.stubEnv('AURORA_LIVE_SYNC_ENABLED', '1');
      vi.stubEnv('AURORA_LIVE_SYNC_BOARDS', 'tension');
      const resumedAt = Date.now() + 35_000;
      vi.spyOn(Date, 'now').mockImplementation(() => resumedAt);
      await instance.credentialsChanged();
      await vi.waitFor(() => expect(fetchAuroraLiveHistory).toHaveBeenCalledOnce());
    },
  );

  it('does not register Aurora watchers for products outside the enabled allowlist', async () => {
    vi.stubEnv('AURORA_LIVE_SYNC_BOARDS', 'decoy');
    const watch = vi.spyOn(auroraLiveSync, 'watch').mockReturnValue(() => {});
    const subscribed = vi.fn();
    vi.spyOn(pubsub, 'subscribeBoardPresence').mockImplementation(async (_boardKey, listener) => {
      subscribed();
      // Give the eager iterator a payload so its initial setup must finish.
      setTimeout(() => listener({ __typename: 'BoardClimbCleared', clearedAt: new Date().toISOString(), seq: 1 }), 20);
      return () => {};
    });
    vi.spyOn(pubsub, 'getActiveBoardClear').mockResolvedValue(null);
    const iterator = boardPresenceSubscriptions.boardNowPlaying.subscribe(
      undefined,
      { boardId, includeAurora: true },
      { connectionId: 'disabled-product', isAuthenticated: true, userId },
    );
    const first = iterator.next();
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
    await first;
    expect(watch).not.toHaveBeenCalled();
    await iterator.return();
  });

  it('never selects a persistently refused credential for a second watched wall', async () => {
    await db
      .update(schema.auroraCredentials)
      .set({ syncStatus: 'expired', auroraToken: null })
      .where(and(eq(schema.auroraCredentials.userId, userId), eq(schema.auroraCredentials.boardType, 'tension')));
    const secondUuid = randomUUID();
    const [secondBoard] = await db
      .insert(schema.userBoards)
      .values({
        uuid: secondUuid,
        slug: secondUuid,
        ownerId: userId,
        name: 'Another watched wall',
        boardType: 'tension',
        layoutId: 10,
        sizeId: 6,
        setIds: '12,13',
      })
      .returning();
    const instance = poller();
    instance.watch(boardId, userId, 'first-refused-wall');
    instance.watch(secondBoard.id, userId, 'second-refused-wall');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAuroraLiveToken).not.toHaveBeenCalled();
    expect(fetchAuroraLiveHistory).not.toHaveBeenCalled();
    instance.releaseConnection('first-refused-wall');
    instance.releaseConnection('second-refused-wall');
  });

  it.each(['tension', 'decoy', 'touchstone', 'grasshopper', 'soill'] as const)(
    'enables %s independently and never enables Kilter',
    (boardType) => {
      expect(isAuroraLiveEnabled(boardType)).toBe(true);
      expect(isAuroraLiveEnabled('kilter')).toBe(false);
      vi.stubEnv('AURORA_LIVE_SYNC_BOARDS', '');
      expect(isAuroraLiveEnabled(boardType)).toBe(false);
    },
  );
  it('has one owner across instances and stops when the last linked viewer leaves', async () => {
    vi.mocked(fetchAuroraLiveHistory).mockResolvedValue([display()]);
    const first = poller();
    const second = poller();
    const leaveFirst = first.watch(boardId, userId, 'socket-a');
    const leaveSecond = second.watch(boardId, userId, 'socket-b');
    await vi.waitFor(() => expect(fetchAuroraLiveHistory).toHaveBeenCalledTimes(1));
    expect(fetchAuroraLiveHistory).toHaveBeenCalledWith(
      'tension',
      serial,
      'test-session',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    leaveFirst();
    leaveSecond();
    await vi.waitFor(async () => expect(await publisher.get(`aurora-live:${boardId}:owner`)).toBeNull());
  });
  it('refreshes a rejected session once before importing', async () => {
    vi.mocked(fetchAuroraLiveHistory)
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'http', message: 'Unauthorized', status: 401 }))
      .mockResolvedValue([display()]);
    poller().watch(boardId, userId, 'socket');
    await vi.waitFor(() => expect(getAuroraLiveToken).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getAuroraLiveToken).mock.calls[1]?.[4]).toBe('test-session');
    await vi.waitFor(() => expect(publishEvent).toHaveBeenCalled());
    expect(fetchAuroraLiveHistory).toHaveBeenCalledTimes(2);
  });
  it.each([{ sizeId: 7 }, { setIds: '12' }])(
    'discards an in-flight response after both canonical/source config change: %j',
    async (configuration) => {
      let finish: (rows: AuroraLiveDisplay[]) => void = () => {};
      vi.mocked(fetchAuroraLiveHistory).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const instance = poller();
      instance.watch(boardId, userId, 'socket');
      await vi.waitFor(() => expect(fetchAuroraLiveHistory).toHaveBeenCalledTimes(1));
      await db.update(schema.userBoards).set(configuration).where(eq(schema.userBoards.id, boardId));
      await db
        .update(schema.auroraWallSources)
        .set(configuration)
        .where(eq(schema.auroraWallSources.sourceKey, sourceKey));
      finish([display()]);
      await vi.waitFor(async () => expect(await publisher.get(`aurora-live:${boardId}:next`)).not.toBeNull());
      expect(
        await db.select().from(schema.boardClimbEvents).where(eq(schema.boardClimbEvents.boardId, boardId)),
      ).toHaveLength(0);
      expect(await publisher.get(`aurora-live:${boardId}:checkpoint`)).toBeNull();
      expect(publishEvent).not.toHaveBeenCalled();
    },
  );
  it('never borrows another product account', async () => {
    await db
      .update(schema.auroraCredentials)
      .set({ boardType: 'decoy' })
      .where(and(eq(schema.auroraCredentials.userId, userId), eq(schema.auroraCredentials.boardType, 'tension')));
    poller().watch(boardId, userId, 'socket');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getAuroraLiveToken).not.toHaveBeenCalled();
    expect(fetchAuroraLiveHistory).not.toHaveBeenCalled();
  });
  it('aborts a read when its socket leaves and discards its late response', async () => {
    let finish: (rows: AuroraLiveDisplay[]) => void = () => {};
    vi.mocked(fetchAuroraLiveHistory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const instance = poller();
    instance.watch(boardId, userId, 'socket');
    await vi.waitFor(() => expect(fetchAuroraLiveHistory).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(fetchAuroraLiveHistory).mock.calls[0]?.[3]?.signal;
    instance.releaseConnection('socket');
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    finish([display()]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(publishEvent).not.toHaveBeenCalled();
  });
  it('aborts on unlink while another capable viewer remains', async () => {
    let finish: (rows: AuroraLiveDisplay[]) => void = () => {};
    vi.mocked(fetchAuroraLiveHistory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const instance = poller();
    instance.watch(boardId, userId, 'socket');
    instance.watch(boardId, 'unlinked-viewer', 'socket-2');
    await vi.waitFor(() => expect(fetchAuroraLiveHistory).toHaveBeenCalledTimes(1));
    await db
      .delete(schema.auroraCredentials)
      .where(and(eq(schema.auroraCredentials.userId, userId), eq(schema.auroraCredentials.boardType, 'tension')));
    await instance.credentialsChanged();
    await vi.waitFor(() => expect(vi.mocked(fetchAuroraLiveHistory).mock.calls[0]?.[3]?.signal?.aborted).toBe(true));
    finish([display()]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('bounded Aurora catch-up', () => {
  it('resumes an unfinished interval without claiming completeness and reads newest each run', async () => {
    const row = (seconds: string) =>
      display({
        displayedAt: `2026-11-17T12:00:${seconds}.123456Z`,
        rawTimestamp: `2026-11-17 12:00:${seconds}.123456`,
      });
    const initial = { binding: 'fixture', completeThrough: row('01').displayedAt, pending: null };
    const pages = vi
      .fn()
      .mockResolvedValueOnce([row('09'), row('08')])
      .mockResolvedValueOnce([row('07'), row('06')])
      .mockResolvedValueOnce([row('05'), row('04')]);
    const importPage = vi.fn(async () => {});
    const onGap = vi.fn();
    const pending = await catchUpAuroraHistory({
      checkpoint: initial,
      fetchPage: pages,
      importPage,
      isCurrent: async () => true,
      onGap,
    });
    expect(pending?.completeThrough).toBe(initial.completeThrough);
    expect(pending?.pending?.before).toBe(row('04').rawTimestamp);
    expect(pages).toHaveBeenCalledTimes(3);
    expect(onGap).toHaveBeenCalledOnce();
    const resumedPages = vi
      .fn()
      .mockResolvedValueOnce([row('11'), row('10')])
      .mockResolvedValueOnce([row('03'), row('01')]);
    const completed = await catchUpAuroraHistory({
      checkpoint: pending!,
      fetchPage: resumedPages,
      importPage,
      isCurrent: async () => true,
      onGap,
    });
    expect(resumedPages.mock.calls[1]).toEqual([row('04').rawTimestamp]);
    expect(completed?.completeThrough).toBe(row('09').displayedAt);
    expect(completed?.pending).toBeNull();
  });
  it('records a retention gap when the historical feed ends before the known lower bound', async () => {
    const newest = display({ displayedAt: '2026-11-17T12:00:09.123456Z' });
    const checkpoint = { binding: 'fixture', completeThrough: '2026-11-17T12:00:01.123456Z', pending: null };
    const onGap = vi.fn();
    const fetchPage = vi.fn().mockResolvedValueOnce([newest]).mockResolvedValueOnce([]);
    const completed = await catchUpAuroraHistory({
      checkpoint,
      fetchPage,
      importPage: async () => {},
      isCurrent: async () => true,
      onGap,
    });
    expect(onGap).toHaveBeenCalledOnce();
    expect(completed?.pending).toBeNull();
  });
  it('resets a checkpoint when the physical binding changes', () => {
    expect(
      parseAuroraCheckpoint(
        JSON.stringify({ binding: 'old', completeThrough: display().displayedAt, pending: null }),
        'new',
      ),
    ).toEqual({ binding: 'new', completeThrough: null, pending: null });
  });
});
