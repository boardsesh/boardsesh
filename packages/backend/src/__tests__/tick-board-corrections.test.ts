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
const thirdUser = 'tick-board-correction-third';
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
        { id: thirdUser, email: `${thirdUser}@test.com` },
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
  it.each(['move', 'clear'] as const)(
    'uses corrected %s attribution when an older ascent event arrives later',
    async (correction) => {
      const uuid = await save(homewall, { boardUuid: homewall.uuid });
      await db.update(schema.boardseshTicks).set({ boardId: original.id }).where(eq(schema.boardseshTicks.uuid, uuid));
      await db.insert(schema.userFollows).values({ followerId: otherUser, followingId: userId }).onConflictDoNothing();
      const correctedBoardUuid = correction === 'move' ? homewall.uuid : null;
      await tickMutations.updateTick(undefined, { uuid, input: { boardUuid: correctedBoardUuid } }, ctx);
      await fanoutFeedItems({
        type: 'ascent.logged',
        actorId: userId,
        entityType: 'tick',
        entityId: uuid,
        timestamp: Date.now(),
        metadata: { boardUuid: original.uuid, boardType: 'kilter', climbUuid },
      });
      const [feed] = await db.select().from(schema.feedItems).where(eq(schema.feedItems.entityId, uuid));
      expect(feed.boardUuid).toBe(correctedBoardUuid);
      // Feed metadata excludes board attribution, so a stale event cannot retain it there.
      expect(feed.metadata).not.toHaveProperty('boardUuid');
    },
  );
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
  it.each(['invite_only', 'only_me', 'revoked'] as const)(
    'honors current %s board access for options, saves and corrections',
    async (restriction) => {
      const [board] = await db
        .insert(schema.userBoards)
        .values({
          uuid: uuidv4(),
          slug: uuidv4(),
          ownerId: otherUser,
          name: 'Restricted compatible wall',
          isPublic: true,
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 25,
          setIds: '26,27',
        })
        .returning();
      await db.insert(schema.boardFollows).values({ userId, boardUuid: board.uuid });
      if (restriction === 'revoked') {
        await db
          .insert(schema.resourceGrants)
          .values({ kind: 'board', resourceId: board.uuid, userId, status: 'revoked' });
      } else {
        await db
          .insert(schema.resourcePrivacy)
          .values({ kind: 'board', resourceId: board.uuid, ownerId: otherUser, audience: restriction });
      }
      try {
        const newTickUuid = await save(board, { boardUuid: board.uuid });
        expect((await readTick(newTickUuid)).boardId).toBeNull();
        const uuid = await save(homewall, { boardUuid: homewall.uuid });
        // A historic tick still pointing at the now-restricted wall does not
        // grant the tick owner permission to read that wall's name/config.
        await db.update(schema.boardseshTicks).set({ boardId: board.id }).where(eq(schema.boardseshTicks.uuid, uuid));
        const options = await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid }, ctx);
        expect(options.currentBoard).toBeNull();
        expect(options.boards.some((choice) => choice.uuid === board.uuid)).toBe(false);
        await expect(
          tickMutations.updateTick(
            undefined,
            { uuid, input: { boardUuid: board.uuid, comment: 'Rejected edit' } },
            ctx,
          ),
        ).rejects.toMatchObject({ extensions: { code: 'TICK_BOARD_UNAVAILABLE' } });
        expect((await readTick(uuid)).comment).toBe('');
        const edited = await tickMutations.updateTick(undefined, { uuid, input: { comment: 'My own recap' } }, ctx);
        expect(edited).toMatchObject({ comment: 'My own recap', boardDisplayName: null });
      } finally {
        await db.delete(schema.resourcePrivacy).where(eq(schema.resourcePrivacy.resourceId, board.uuid));
        await db.delete(schema.resourceGrants).where(eq(schema.resourceGrants.resourceId, board.uuid));
        await db.delete(schema.userBoards).where(eq(schema.userBoards.uuid, board.uuid));
      }
    },
  );

  it('names an Unlisted board only when this edit explicitly presents its UUID, outside the picker list', async () => {
    const [board] = await db
      .insert(schema.userBoards)
      .values({
        uuid: uuidv4(),
        slug: uuidv4(),
        ownerId: otherUser,
        name: 'Link only compatible wall',
        // Saved the way the current audience control saves Unlisted.
        isPublic: false,
        isUnlisted: true,
        boardType: 'kilter',
        layoutId: 8,
        sizeId: 25,
        setIds: '26,27',
      })
      .returning();
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'board', resourceId: board.uuid, ownerId: otherUser, audience: 'unlisted' });
    try {
      const uuid = await save(board, { boardUuid: board.uuid });
      expect((await readTick(uuid)).boardId).toBe(board.id);

      const options = await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid }, ctx);
      expect(options.currentBoard).toBeNull();
      expect(JSON.stringify(options)).not.toContain(board.uuid);
      // The picker list is a listing: the board is not offered there.
      expect(options.boards.some((choice) => choice.uuid === board.uuid)).toBe(false);

      const edited = await tickMutations.updateTick(undefined, { uuid, input: { comment: 'Linked recap' } }, ctx);
      expect(edited).toMatchObject({ comment: 'Linked recap', boardDisplayName: null });
      const selected = await tickMutations.updateTick(undefined, { uuid, input: { boardUuid: board.uuid } }, ctx);
      expect(selected).toMatchObject({ boardDisplayName: 'Link only compatible wall' });
      // A later tick-only lookup still has no persisted link provenance.
      expect((await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid }, ctx)).currentBoard).toBeNull();
      await db
        .insert(schema.resourceGrants)
        .values({ kind: 'board', resourceId: board.uuid, userId, status: 'approved' });
      expect((await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid }, ctx)).currentBoard?.uuid).toBe(
        board.uuid,
      );
      expect(
        await tickMutations.updateTick(undefined, { uuid, input: { comment: 'Approved recap' } }, ctx),
      ).toMatchObject({ boardDisplayName: board.name });
    } finally {
      await db.delete(schema.boardseshTicks).where(eq(schema.boardseshTicks.boardId, board.id));
      await db.delete(schema.resourcePrivacy).where(eq(schema.resourcePrivacy.resourceId, board.uuid));
      await db.delete(schema.resourceGrants).where(eq(schema.resourceGrants.resourceId, board.uuid));
      await db.delete(schema.userBoards).where(eq(schema.userBoards.uuid, board.uuid));
    }
  });

  it.each(['updateTick', 'saveTick'] as const)(
    '%s follows a merged-away UUID as a link only when one owner holds both boards',
    async (operation) => {
      const insertWall = async (ownerId: string, name: string, flags: { isPublic: boolean; isUnlisted: boolean }) => {
        const [wall] = await db
          .insert(schema.userBoards)
          .values({
            uuid: uuidv4(),
            slug: uuidv4(),
            ownerId,
            name,
            ...flags,
            boardType: 'kilter',
            layoutId: 8,
            sizeId: 25,
            setIds: '26,27',
          })
          .returning();
        return wall;
      };
      // The survivor is someone else's wall, Unlisted with the current control.
      const survivor = await insertWall(otherUser, 'Merged survivor wall', { isPublic: false, isUnlisted: true });
      await db
        .insert(schema.resourcePrivacy)
        .values({ kind: 'board', resourceId: survivor.uuid, ownerId: otherUser, audience: 'unlisted' });
      // The climber holds the link of a wall another owner merged into it...
      const foreignLoser = await insertWall(thirdUser, 'Foreign loser wall', { isPublic: true, isUnlisted: false });
      // ...and of a wall the survivor's own owner merged into it.
      const sameOwnerLoser = await insertWall(otherUser, 'Same owner loser wall', {
        isPublic: true,
        isUnlisted: false,
      });
      for (const loser of [foreignLoser, sameOwnerLoser]) {
        await db
          .update(schema.userBoards)
          .set({ deletedAt: new Date(), mergedIntoBoardUuid: survivor.uuid })
          .where(eq(schema.userBoards.id, loser.id));
      }
      try {
        if (operation === 'updateTick') {
          const uuid = await save(homewall, { boardUuid: homewall.uuid });
          await expect(
            tickMutations.updateTick(undefined, { uuid, input: { boardUuid: foreignLoser.uuid } }, ctx),
          ).rejects.toThrow('Board is no longer available');
          expect((await readTick(uuid)).boardId).toBe(homewall.id);
          const moved = await tickMutations.updateTick(
            undefined,
            { uuid, input: { boardUuid: sameOwnerLoser.uuid } },
            ctx,
          );
          expect(moved).toMatchObject({ boardDisplayName: survivor.name });
          expect((await readTick(uuid)).boardId).toBe(survivor.id);
        } else {
          const foreign = await save(survivor, { boardUuid: foreignLoser.uuid });
          expect((await readTick(foreign)).boardId).toBeNull();
          const sameOwner = await save(survivor, { boardUuid: sameOwnerLoser.uuid });
          expect((await readTick(sameOwner)).boardId).toBe(survivor.id);
        }
      } finally {
        await db.delete(schema.boardseshTicks).where(eq(schema.boardseshTicks.boardId, survivor.id));
        await db.delete(schema.resourcePrivacy).where(eq(schema.resourcePrivacy.resourceId, survivor.uuid));
        for (const wall of [foreignLoser, sameOwnerLoser, survivor]) {
          await db.delete(schema.userBoards).where(eq(schema.userBoards.uuid, wall.uuid));
        }
      }
    },
  );

  it.each(['numeric', 'session'] as const)(
    'does not mint a link from historical %s tick attribution',
    async (source) => {
      const [board] = await db
        .insert(schema.userBoards)
        .values({
          uuid: uuidv4(),
          slug: uuidv4(),
          ownerId: otherUser,
          name: 'Never presented wall',
          isPublic: false,
          isUnlisted: true,
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 25,
          setIds: '26,27',
        })
        .returning();
      await db
        .insert(schema.resourcePrivacy)
        .values({ kind: 'board', resourceId: board.uuid, ownerId: otherUser, audience: 'unlisted' });
      const sessionId = source === 'session' ? uuidv4() : null;
      if (sessionId)
        await db.insert(schema.boardSessions).values({
          id: sessionId,
          createdByUserId: otherUser,
          boardId: board.id,
          boardPath: '/kilter/8/25/26,27/35',
          isPublic: true,
        });
      try {
        const overrides = sessionId ? { sessionId } : { boardId: board.id };
        const uuid = await save(board, overrides);
        // Current saves reject this no-link association. Older records have only
        // a numeric board ID; reconstruct one without ever presenting its UUID.
        expect((await readTick(uuid)).boardId).toBeNull();
        await db.update(schema.boardseshTicks).set({ boardId: board.id }).where(eq(schema.boardseshTicks.uuid, uuid));
        const options = await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid }, ctx);
        expect(options.currentBoard).toBeNull();
        expect(JSON.stringify(options)).not.toContain(board.uuid);
        expect(JSON.stringify(options)).not.toContain(board.name);
        expect(options.boards.some((choice) => choice.uuid === board.uuid)).toBe(false);
        const edited = await tickMutations.updateTick(undefined, { uuid, input: { comment: 'My own notes' } }, ctx);
        expect(edited).toMatchObject({ comment: 'My own notes', boardDisplayName: null });
        expect((await readTick(uuid)).boardId).toBe(board.id);
      } finally {
        await db.delete(schema.boardseshTicks).where(eq(schema.boardseshTicks.boardId, board.id));
        if (sessionId) await db.delete(schema.boardSessions).where(eq(schema.boardSessions.id, sessionId));
        await db.delete(schema.resourcePrivacy).where(eq(schema.resourcePrivacy.resourceId, board.uuid));
        await db.delete(schema.userBoards).where(eq(schema.userBoards.uuid, board.uuid));
      }
    },
  );

  it.each(['deleted', 'hidden_spray'] as const)(
    'does not expose a historical %s board through an ordinary tick edit',
    async (kind) => {
      const sprayLayout = 1_990_562_700;
      const [board] = await db
        .insert(schema.userBoards)
        .values({
          uuid: uuidv4(),
          slug: uuidv4(),
          ownerId: otherUser,
          name: 'Unavailable wall',
          isPublic: true,
          boardType: kind === 'hidden_spray' ? 'spray' : 'kilter',
          layoutId: kind === 'hidden_spray' ? sprayLayout : 8,
          sizeId: kind === 'hidden_spray' ? sprayLayout : 25,
          setIds: kind === 'hidden_spray' ? '1' : '26,27',
          deletedAt: kind === 'deleted' ? new Date() : null,
        })
        .returning();
      if (kind === 'hidden_spray')
        await db
          .insert(schema.sprayWalls)
          .values({ boardUuid: board.uuid, layoutId: sprayLayout, hiddenAt: new Date() });
      try {
        const uuid = await save(homewall, { boardUuid: homewall.uuid });
        await db.update(schema.boardseshTicks).set({ boardId: board.id }).where(eq(schema.boardseshTicks.uuid, uuid));
        expect((await tickBoardQueries.tickBoardOptions(undefined, { tickUuid: uuid }, ctx)).currentBoard).toBeNull();
        const edited = await tickMutations.updateTick(undefined, { uuid, input: { comment: 'Keep my recap' } }, ctx);
        expect(edited).toMatchObject({ comment: 'Keep my recap', boardDisplayName: null });
      } finally {
        await db.delete(schema.sprayWalls).where(eq(schema.sprayWalls.boardUuid, board.uuid));
        await db.delete(schema.userBoards).where(eq(schema.userBoards.uuid, board.uuid));
      }
    },
  );

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
