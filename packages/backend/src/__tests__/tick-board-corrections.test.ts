import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';
import { createBarrier, createValueBarrier, handleLater } from './helpers/concurrency';

vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => {}),
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({ publishDebouncedSessionStats: vi.fn() }));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: vi.fn(() => true) }));
vi.mock('../graphql/resolvers/beta-videos/queries', () => ({ invalidateRecentBetaLinksCache: vi.fn(async () => {}) }));

import { db } from '../db/client';
import * as schema from '@boardsesh/db/schema';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { tickBoardQueries } from '../graphql/resolvers/ticks/board-options';
import { queueBoardStatsPublish } from '../graphql/resolvers/board-presence/stats';
import { fanoutFeedItems } from '../events/feed-fanout';

const userId = 'tick-board-correction-user';
const otherUser = 'tick-board-correction-other';
const climbUuid = 'TICK-BOARD-HOMEWALL';
const ctx = { isAuthenticated: true, userId, connectionId: 'tick-board-correction' } as ConnectionContext;
let original: typeof schema.userBoards.$inferSelect;
let homewall: typeof schema.userBoards.$inferSelect;

async function save(board = original, extra: Record<string, unknown> = {}) {
  const uuid = uuidv4();
  await tickMutations.saveTick(
    undefined,
    {
      input: {
        uuid,
        boardType: 'kilter',
        climbUuid,
        angle: 35,
        isMirror: false,
        status: 'flash',
        attemptCount: 1,
        isBenchmark: false,
        comment: '',
        climbedAt: new Date().toISOString(),
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        ...extra,
      },
    },
    ctx,
  );
  return uuid;
}
async function readTick(uuid: string) {
  const [tick] = await db.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.uuid, uuid));
  return tick;
}

describe('tick board corrections', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db
      .insert(schema.users)
      .values([
        { id: userId, email: `${userId}@test.com` },
        { id: otherUser, email: `${otherUser}@test.com` },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.boardClimbs)
      .values({
        uuid: climbUuid,
        boardType: 'kilter',
        layoutId: 8,
        name: 'sheep yoga',
        setterUsername: 'setter',
        frames: '',
        compatibleSizeIds: [17, 25],
        requiredSetIds: [26, 27],
      })
      .onConflictDoNothing();
    [original] = await db
      .insert(schema.userBoards)
      .values({
        uuid: uuidv4(),
        slug: uuidv4(),
        ownerId: userId,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        name: 'Original',
        isPublic: true,
      })
      .returning();
    [homewall] = await db
      .insert(schema.userBoards)
      .values({
        uuid: uuidv4(),
        slug: uuidv4(),
        ownerId: userId,
        boardType: 'kilter',
        layoutId: 8,
        sizeId: 17,
        setIds: '26,27',
        name: 'Homewall',
        isPublic: true,
      })
      .returning();
  });
  beforeEach(() => vi.mocked(queueBoardStatsPublish).mockClear());

  it.each(['boardUuid', 'boardId', 'config', 'session'] as const)('blocks wrong layout through %s', async (source) => {
    let overrides: Record<string, unknown> = {};
    if (source === 'boardUuid') overrides = { boardUuid: original.uuid };
    if (source === 'boardId') overrides = { boardId: original.id };
    if (source === 'session') {
      const sessionId = uuidv4();
      await db
        .insert(schema.boardSessions)
        .values({ id: sessionId, boardPath: '/kilter/1/10/1,20/35', boardId: original.id });
      overrides = { sessionId };
    }
    const uuid = await save(original, overrides);
    expect((await readTick(uuid)).boardId).toBeNull();
    expect(queueBoardStatsPublish).not.toHaveBeenCalled();
  });
  it('keeps compatible attribution and preserves omitted board fields on edit', async () => {
    const uuid = await save(homewall, { boardUuid: homewall.uuid });
    expect((await readTick(uuid)).boardId).toBe(homewall.id);
    await tickMutations.updateTick(undefined, { uuid, input: { comment: 'unchanged wall' } }, ctx);
    expect((await readTick(uuid)).boardId).toBe(homewall.id);
  });
  it.each([{ sizeId: 10 }, { setIds: '26' }])(
    'does not attribute a climb with incompatible physical configuration %j',
    async (config) => {
      const uuid = await save(homewall, { ...config, boardUuid: homewall.uuid });
      expect((await readTick(uuid)).boardId).toBeNull();
    },
  );
  it('moves and clears attribution, including feed copies and linked beta', async () => {
    const uuid = await save();
    // Reproduce the historic corrupt row; new writes already refuse it.
    await db.update(schema.boardseshTicks).set({ boardId: original.id }).where(eq(schema.boardseshTicks.uuid, uuid));
    await db.insert(schema.feedItems).values({
      recipientId: otherUser,
      actorId: userId,
      type: 'ascent',
      entityType: 'tick',
      entityId: uuid,
      boardUuid: original.uuid,
      metadata: { boardUuid: original.uuid },
    });
    await db.insert(schema.boardBetaLinks).values({
      boardType: 'kilter',
      climbUuid,
      link: `https://www.instagram.com/p/${uuid}/`,
      tickUuid: uuid,
      boardId: original.id,
      angle: 35,
    });
    const before = await readTick(uuid);
    await tickMutations.updateTick(undefined, { uuid, input: { boardUuid: homewall.uuid } }, ctx);
    expect((await readTick(uuid)).boardId).toBe(homewall.id);
    expect(queueBoardStatsPublish).toHaveBeenCalledWith(original.id, 'kilter');
    expect(queueBoardStatsPublish).toHaveBeenCalledWith(homewall.id, 'kilter');
    await tickMutations.updateTick(undefined, { uuid, input: { boardUuid: null } }, ctx);
    const after = await readTick(uuid);
    expect(after).toMatchObject({
      boardId: null,
      status: before.status,
      angle: before.angle,
      climbedAt: before.climbedAt,
      sessionId: before.sessionId,
    });
    const [feed] = await db.select().from(schema.feedItems).where(eq(schema.feedItems.entityId, uuid));
    expect(feed.boardUuid).toBeNull();
    expect(feed.metadata?.boardUuid).toBeNull();
    const [beta] = await db.select().from(schema.boardBetaLinks).where(eq(schema.boardBetaLinks.tickUuid, uuid));
    expect(beta.boardId).toBeNull();
  });
  it('rejects explicit incompatible selections without changing other fields', async () => {
    const uuid = await save(homewall);
    await expect(
      tickMutations.updateTick(undefined, { uuid, input: { boardUuid: original.uuid, comment: 'bad edit' } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'TICK_BOARD_INCOMPATIBLE' } });
    expect((await readTick(uuid)).comment).toBe('');
  });
  it('clears attribution after a board merge without locking the tick ahead of the board', async () => {
    const sessionId = uuidv4();
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, boardId: homewall.id, boardPath: '/kilter/8/17/26,27/35' });
    const uuid = await save(homewall, { boardUuid: homewall.uuid, sessionId });
    const mergeReady = createValueBarrier<number>();
    const releaseMerge = createBarrier();
    const merge = db.transaction(async (tx) => {
      const [connection] = rowsFromResult<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      await tx.select().from(schema.userBoards).where(eq(schema.userBoards.id, homewall.id)).for('update');
      await tx.update(schema.boardSessions).set({ boardId: homewall.id }).where(eq(schema.boardSessions.id, sessionId));
      mergeReady.release(connection.pid);
      await releaseMerge.promise;
      await tx.update(schema.boardseshTicks).set({ boardId: homewall.id }).where(eq(schema.boardseshTicks.uuid, uuid));
    });
    handleLater(merge);
    const mergePid = await mergeReady.promise;
    const clear = tickMutations.updateTick(undefined, { uuid, input: { boardUuid: null } }, ctx);
    handleLater(clear);
    try {
      await vi.waitFor(async () => {
        const waiting = rowsFromResult<{ query: string }>(
          await db.execute(sql`
          SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND ${mergePid} = ANY(pg_blocking_pids(pid))
        `),
        );
        expect(waiting.some((connection) => connection.query.includes('candidate_ids'))).toBe(true);
      });
    } finally {
      releaseMerge.release();
      await Promise.all([merge, clear]);
    }
    expect((await readTick(uuid)).boardId).toBeNull();
  });
  it('uses corrected attribution when an older ascent event arrives later', async () => {
    const uuid = await save(homewall, { boardUuid: homewall.uuid });
    await db.insert(schema.userFollows).values({ followerId: otherUser, followingId: userId }).onConflictDoNothing();
    await tickMutations.updateTick(undefined, { uuid, input: { boardUuid: null } }, ctx);
    await fanoutFeedItems({
      type: 'ascent.logged',
      actorId: userId,
      entityType: 'tick',
      entityId: uuid,
      timestamp: Date.now(),
      metadata: { boardUuid: homewall.uuid, boardType: 'kilter', climbUuid },
    });
    const [feed] = await db.select().from(schema.feedItems).where(eq(schema.feedItems.entityId, uuid));
    expect(feed.boardUuid).toBeNull();
  });
  it('filters choices before pagination and restricts the query to the tick owner', async () => {
    const uuid = await save();
    const options = await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid, limit: 1 }, ctx);
    expect(options.boards.map((board) => board.uuid)).toEqual([homewall.uuid]);
    expect(options.totalCount).toBe(1);
    expect(options.hasMore).toBe(false);
    await expect(
      tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid }, { ...ctx, userId: otherUser }),
    ).rejects.toMatchObject({ extensions: { code: 'TICK_NOT_FOUND' } });
  });
  it('pages saved and recent compatible boards, excluding private and unrelated boards', async () => {
    const createBoard = async (name: string, isPublic = true) => {
      const [board] = await db
        .insert(schema.userBoards)
        .values({
          uuid: uuidv4(),
          slug: uuidv4(),
          ownerId: otherUser,
          name,
          isPublic,
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 25,
          setIds: '26,27',
        })
        .returning();
      return board;
    };
    const recent = await createBoard('Recent Homewall');
    const saved = await createBoard('Saved Homewall');
    const privateBoard = await createBoard('Private Homewall', false);
    await createBoard('Unrelated Homewall');
    await db.insert(schema.userBoardActivity).values({ userId, boardUuid: recent.uuid, lastUsedAt: new Date() });
    await db.insert(schema.boardFollows).values([
      { userId, boardUuid: saved.uuid },
      { userId, boardUuid: privateBoard.uuid },
    ]);
    const uuid = await save();
    const first = await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid, limit: 1 }, ctx);
    const rest = await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid, offset: 1 }, ctx);
    expect(first.totalCount).toBe(3);
    expect(first.hasMore).toBe(true);
    expect(first.boards[0].uuid).toBe(recent.uuid);
    expect(rest.boards.map((board) => board.uuid).sort()).toEqual([homewall.uuid, saved.uuid].sort());
    const pinned = await createBoard('Pinned Homewall');
    await db.insert(schema.userBoardActivity).values({ userId, boardUuid: pinned.uuid, pinnedAt: new Date() });
    const withPinned = await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid, limit: 1 }, ctx);
    expect(withPinned.boards[0].uuid).toBe(pinned.uuid);
    expect(withPinned.totalCount).toBe(4);
    await expect(
      tickMutations.updateTick(undefined, { uuid, input: { boardUuid: privateBoard.uuid } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: 'TICK_BOARD_UNAVAILABLE' } });
    await expect(
      tickMutations.updateTick(undefined, { uuid, input: { boardUuid: null } }, { ...ctx, userId: otherUser }),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});
