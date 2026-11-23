import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { findActiveBoardsBySerial } from '../graphql/resolvers/board-presence/shared';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';
import { db } from '../db/client';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { boardMergeMutations, boardMergeQueries } from '../graphql/resolvers/social/board-merges';

const manager = 'merge-manager';
const leader = 'merge-leader';
const reporter = 'merge-reporter';
const otherReporter = 'merge-reporter-two';
const ctx = (userId: string) => ({ connectionId: userId, isAuthenticated: true, userId }) as ConnectionContext;
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE user_boards, gyms, board_merge_requests, board_merge_audit, community_roles RESTART IDENTITY CASCADE`,
  );
  for (const userId of [manager, leader, reporter, otherReporter])
    await db
      .insert(schema.users)
      .values({ id: userId, email: `${userId}@example.test`, name: userId })
      .onConflictDoNothing();
  await db.insert(schema.communityRoles).values({ userId: leader, role: 'community_leader', boardType: 'tension' });
});
async function pair() {
  const [gym] = await db
    .insert(schema.gyms)
    .values({
      uuid: randomUUID(),
      slug: randomUUID(),
      name: 'Mammoth fixture',
      ownerId: manager,
      latitude: 50,
      longitude: 5,
    })
    .returning();
  const boards = [];
  for (const layoutId of [10, 11]) {
    const [board] = await db
      .insert(schema.userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: reporter,
        gymId: gym.id,
        name: `TB2 ${layoutId}`,
        boardType: 'tension',
        layoutId,
        sizeId: 6,
        setIds: layoutId === 10 ? '12,13' : '13,12',
        angle: layoutId === 10 ? 40 : 50,
      })
      .returning();
    boards.push(board);
  }
  return { gym, boards, boardUuids: boards.map((board) => board.uuid) };
}
async function preview(boardUuids: string[], userId = manager) {
  return boardMergeQueries.boardMergePreview(null, { boardUuids }, ctx(userId));
}
describe('public board merges', () => {
  it('merges TB2 layouts at different angles and preserves ticks, follows, aliases and audit IDs', async () => {
    const { boards, boardUuids } = await pair();
    const [tick] = await db
      .insert(schema.boardseshTicks)
      .values({
        uuid: randomUUID(),
        userId: reporter,
        boardType: 'tension',
        climbUuid: randomUUID(),
        angle: 50,
        status: 'send',
        climbedAt: '2026-11-20T12:00:00Z',
        boardId: boards[1].id,
      })
      .returning();
    await db.insert(schema.boardFollows).values({ userId: reporter, boardUuid: boards[1].uuid });
    const comparison = await preview(boardUuids);
    expect(comparison.canMerge).toBe(true);
    await boardMergeMutations.mergeBoards(
      null,
      {
        input: {
          boardUuids,
          canonicalBoardUuid: boards[0].uuid,
          version: comparison.version,
          reason: 'Two listings for one physical wall',
        },
      },
      ctx(manager),
    );
    const [survivor] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.uuid, boards[0].uuid));
    const [loser] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.uuid, boards[1].uuid));
    expect(survivor.layoutId).toBe(10);
    expect(survivor.angle).toBe(40);
    expect(survivor.name).toBe(boards[0].name);
    expect(loser.mergedIntoBoardUuid).toBe(survivor.uuid);
    expect(loser.syncFrozenAt).not.toBeNull();
    const [movedTick] = await db.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.uuid, tick.uuid));
    expect(movedTick.boardId).toBe(survivor.id);
    expect(movedTick.angle).toBe(50);
    const [follow] = await db.select().from(schema.boardFollows).where(eq(schema.boardFollows.userId, reporter));
    expect(follow.boardUuid).toBe(survivor.uuid);
    const [audit] = await db.select().from(schema.boardMergeAudit);
    expect(JSON.stringify(audit.beforeState)).toContain(tick.id.toString());
  });
  it('coalesces concurrent duplicate requests and lets each reporter read the request', async () => {
    const { boards, boardUuids } = await pair();
    const input = { boardUuids, canonicalBoardUuid: boards[0].uuid, reason: 'This is the same physical board' };
    const requests = await Promise.all([
      boardMergeMutations.requestBoardMerge(null, { input }, ctx(reporter)),
      boardMergeMutations.requestBoardMerge(
        null,
        { input: { ...input, boardUuids: [...boardUuids].reverse() } },
        ctx(otherReporter),
      ),
    ]);
    expect(requests[0].uuid).toBe(requests[1].uuid);
    const queue = await boardMergeQueries.boardMergeRequests(null, { input: { status: 'open' } }, ctx(otherReporter));
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0].reports).toHaveLength(2);
    const comparison = await preview(boardUuids, leader);
    const approved = await boardMergeMutations.resolveBoardMergeRequest(
      null,
      {
        input: {
          requestUuid: requests[0].uuid,
          approve: true,
          canonicalBoardUuid: boards[0].uuid,
          version: comparison.version,
        },
      },
      ctx(leader),
    );
    expect(approved.status).toBe('approved');
  });
  it('does not grant direct merge authority to board ownership alone', async () => {
    const { boardUuids, boards } = await pair();
    const comparison = await preview(boardUuids, reporter);
    expect(comparison.canMerge).toBe(false);
    await expect(
      boardMergeMutations.mergeBoards(
        null,
        {
          input: {
            boardUuids,
            canonicalBoardUuid: boards[0].uuid,
            version: comparison.version,
            reason: 'Two listings for one wall',
          },
        },
        ctx(reporter),
      ),
    ).rejects.toThrow('manage every');
  });
  it('rechecks changed configurations and permission revocations', async () => {
    const { boardUuids, boards } = await pair();
    const comparison = await preview(boardUuids, leader);
    await db
      .update(schema.userBoards)
      .set({ name: 'A deliberate edit', updatedAt: new Date() })
      .where(eq(schema.userBoards.uuid, boards[0].uuid));
    await expect(
      boardMergeMutations.mergeBoards(
        null,
        {
          input: {
            boardUuids,
            canonicalBoardUuid: boards[0].uuid,
            version: comparison.version,
            reason: 'Two listings for one wall',
          },
        },
        ctx(leader),
      ),
    ).rejects.toThrow('changed');
    await db.delete(schema.communityRoles).where(eq(schema.communityRoles.userId, leader));
    const refreshed = await preview(boardUuids, leader);
    expect(refreshed.canMerge).toBe(false);
  });
  it('refuses other layout changes and boards that became private', async () => {
    const { boardUuids, boards } = await pair();
    await db.update(schema.userBoards).set({ layoutId: 9 }).where(eq(schema.userBoards.uuid, boards[1].uuid));
    await expect(preview(boardUuids)).rejects.toThrow('configurations differ');
    await db.update(schema.userBoards).set({ layoutId: 11 }).where(eq(schema.userBoards.uuid, boards[1].uuid));
    await boardMergeMutations.requestBoardMerge(
      null,
      { input: { boardUuids, canonicalBoardUuid: boards[0].uuid, reason: 'Two listings for the same wall' } },
      ctx(reporter),
    );
    await db.update(schema.userBoards).set({ isPublic: false }).where(eq(schema.userBoards.uuid, boards[1].uuid));
    await expect(preview(boardUuids)).rejects.toThrow('public catalog');
    const queue = await boardMergeQueries.boardMergeRequests(null, { input: {} }, ctx(leader));
    expect(queue.requests).toHaveLength(0);
    const own = await boardMergeQueries.boardMergeRequests(null, { input: {} }, ctx(reporter));
    expect(own.requests[0].boards.every((board) => board.uuid !== boards[1].uuid)).toBe(true);
  });
  it('requires gym managers to manage every selected board', async () => {
    const { boardUuids, boards } = await pair();
    await db.update(schema.userBoards).set({ gymId: null }).where(eq(schema.userBoards.uuid, boards[1].uuid));
    expect((await preview(boardUuids)).canMerge).toBe(false);
    expect((await preview(boardUuids, leader)).canMerge).toBe(true);
  });
  it('keeps resolved requests visible and approval retries idempotent', async () => {
    const { boards, boardUuids } = await pair();
    const request = await boardMergeMutations.requestBoardMerge(
      null,
      { input: { boardUuids, canonicalBoardUuid: boards[0].uuid, reason: 'One board with two listings' } },
      ctx(reporter),
    );
    const comparison = await preview(boardUuids, leader);
    const input = {
      requestUuid: request.uuid,
      approve: true,
      canonicalBoardUuid: boards[0].uuid,
      version: comparison.version,
    };
    await boardMergeMutations.resolveBoardMergeRequest(null, { input }, ctx(leader));
    const retry = await boardMergeMutations.resolveBoardMergeRequest(null, { input }, ctx(leader));
    expect(retry.status).toBe('approved');
    const history = await boardMergeQueries.boardMergeRequests(null, { input: { status: 'approved' } }, ctx(leader));
    expect(history.requests).toHaveLength(1);
  });
  it('retains effective unlisted and location policies without exposing them in discovery', async () => {
    const { boards, boardUuids } = await pair();
    await db.insert(schema.resourcePrivacy).values({
      kind: 'board',
      resourceId: boards[1].uuid,
      ownerId: reporter,
      audience: 'unlisted',
      locationAudience: 'only_me',
    });
    const candidates = await boardMergeQueries.boardMergeCandidates(null, { input: {} }, ctx(reporter));
    expect(candidates.boards.some((board) => board.uuid === boards[1].uuid)).toBe(false);
    const comparison = await preview(boardUuids, leader);
    await boardMergeMutations.mergeBoards(
      null,
      {
        input: {
          boardUuids,
          canonicalBoardUuid: boards[0].uuid,
          version: comparison.version,
          reason: 'Two entries for one board',
        },
      },
      ctx(leader),
    );
    const [policy] = await db
      .select()
      .from(schema.resourcePrivacy)
      .where(eq(schema.resourcePrivacy.resourceId, boards[0].uuid));
    expect(policy.audience).toBe('unlisted');
    expect(policy.locationAudience).toBe('only_me');
  });
  it('resolves a loser serial for a fresh user and preserves reused serial candidates', async () => {
    const { boards, boardUuids } = await pair();
    await db
      .update(schema.userBoards)
      .set({ serialNumber: 'RETIRED-CONTROLLER' })
      .where(eq(schema.userBoards.uuid, boards[1].uuid));
    const comparison = await preview(boardUuids);
    await boardMergeMutations.mergeBoards(
      null,
      {
        input: {
          boardUuids,
          canonicalBoardUuid: boards[0].uuid,
          version: comparison.version,
          reason: 'Two entries for one board',
        },
      },
      ctx(manager),
    );
    expect((await findActiveBoardsBySerial('RETIRED-CONTROLLER')).map((board) => board.uuid)).toEqual([boards[0].uuid]);
    const cleanupCatalog = await seedAuroraCatalogFixtures([
      {
        boardType: 'tension',
        productId: 2140001000,
        layoutId: 11,
        sizeId: 6,
        setIds: [12, 13],
        associationIdBase: 2140001010,
      },
    ]);
    try {
      await expect(
        socialBoardMutations.createBoard(
          null,
          {
            input: {
              name: 'Accidental clone',
              boardType: 'tension',
              layoutId: 11,
              sizeId: 6,
              setIds: '12,13',
              angle: 40,
              serialNumber: 'RETIRED-CONTROLLER',
            },
          },
          ctx(otherReporter),
        ),
      ).rejects.toMatchObject({ extensions: { code: 'BOARD_SERIAL_EXISTS' } });
    } finally {
      await cleanupCatalog();
    }
    const [other] = await db
      .insert(schema.userBoards)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: otherReporter,
        name: 'Another real wall',
        boardType: 'tension',
        layoutId: 10,
        sizeId: 6,
        setIds: '12,13',
        serialNumber: 'RETIRED-CONTROLLER',
      })
      .returning();
    expect((await findActiveBoardsBySerial('RETIRED-CONTROLLER')).map((board) => board.uuid)).toEqual([
      boards[0].uuid,
      other.uuid,
    ]);
  });
  it('prunes cross-gym kiosk aliases while preserving valid kiosk slots', async () => {
    const { boards, boardUuids, gym } = await pair();
    const [otherGym] = await db
      .insert(schema.gyms)
      .values({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: manager,
        name: 'Other gym',
        latitude: 51,
        longitude: 5,
      })
      .returning();
    await db.update(schema.userBoards).set({ gymId: otherGym.id }).where(eq(schema.userBoards.uuid, boards[1].uuid));
    await db.insert(schema.gymKiosks).values({
      uuid: randomUUID(),
      gymId: otherGym.id,
      slug: 'screen',
      name: 'Screen',
      layout: {
        version: 1,
        boards: [{ boardUuid: boards[1].uuid }],
        leaderboard: { boardUuid: boards[1].uuid, period: 'week' },
        showInstallQr: false,
      },
    });
    const comparison = await preview(boardUuids, leader);
    await boardMergeMutations.mergeBoards(
      null,
      {
        input: {
          boardUuids,
          canonicalBoardUuid: boards[0].uuid,
          version: comparison.version,
          reason: 'Duplicate from another listing',
        },
      },
      ctx(leader),
    );
    const [kiosk] = await db.select().from(schema.gymKiosks);
    expect(kiosk.layout.boards).toEqual([]);
    expect(kiosk.layout.leaderboard?.boardUuid).toBeNull();
    expect(gym.id).not.toBe(otherGym.id);
  });
  it('reserves moved board events above existing durable sequence floors', async () => {
    const { boards, boardUuids } = await pair();
    await db.update(schema.userBoards).set({ presenceSeq: 100 }).where(eq(schema.userBoards.uuid, boards[0].uuid));
    for (const board of boards)
      await db.insert(schema.boardClimbEvents).values({
        boardId: board.id,
        boardType: board.boardType,
        climbUuid: randomUUID(),
        angle: board.angle,
        seq: 1,
        confirmedAt: '2026-11-20T12:00:00Z',
      });
    const comparison = await preview(boardUuids);
    await boardMergeMutations.mergeBoards(
      null,
      {
        input: {
          boardUuids,
          canonicalBoardUuid: boards[0].uuid,
          version: comparison.version,
          reason: 'One wall with duplicate entries',
        },
      },
      ctx(manager),
    );
    const events = await db.select().from(schema.boardClimbEvents);
    expect(events.every((event) => event.boardId === boards[0].id)).toBe(true);
    expect(events.map((event) => event.seq).sort((first, second) => first - second)).toEqual([1, 101]);
  });
  it('deduplicates same-gym kiosk slots and serializes concurrent approvals', async () => {
    const { boards, boardUuids, gym } = await pair();
    await db.insert(schema.gymKiosks).values({
      uuid: randomUUID(),
      gymId: gym.id,
      slug: 'screen',
      name: 'Screen',
      layout: {
        version: 1,
        boards: boardUuids.map((boardUuid) => ({ boardUuid })),
        leaderboard: { boardUuid: boards[1].uuid, period: 'week' },
        showInstallQr: false,
      },
    });
    const request = await boardMergeMutations.requestBoardMerge(
      null,
      { input: { boardUuids, canonicalBoardUuid: boards[0].uuid, reason: 'Two listings for one physical wall' } },
      ctx(reporter),
    );
    const comparison = await preview(boardUuids, leader);
    const input = {
      requestUuid: request.uuid,
      approve: true,
      canonicalBoardUuid: boards[0].uuid,
      version: comparison.version,
    };
    const approvals = await Promise.all([
      boardMergeMutations.resolveBoardMergeRequest(null, { input }, ctx(leader)),
      boardMergeMutations.resolveBoardMergeRequest(null, { input }, ctx(leader)),
    ]);
    expect(approvals.every((request) => request.status === 'approved')).toBe(true);
    const [kiosk] = await db.select().from(schema.gymKiosks);
    expect(kiosk.layout.boards.map((slot) => slot.boardUuid)).toEqual([boards[0].uuid]);
    expect(kiosk.layout.leaderboard?.boardUuid).toBe(boards[0].uuid);
    const audits = await db.select().from(schema.boardMergeAudit);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].beforeState)).toContain(kiosk.uuid);
  });
  it('excludes spray walls from merge discovery and requests even for their owners', async () => {
    const { boards, boardUuids } = await pair();
    for (const board of boards)
      await db.update(schema.userBoards).set({ boardType: 'spray' }).where(eq(schema.userBoards.uuid, board.uuid));
    const candidates = await boardMergeQueries.boardMergeCandidates(null, { input: {} }, ctx(reporter));
    expect(candidates.boards).toEqual([]);
    await expect(
      boardMergeMutations.requestBoardMerge(
        null,
        { input: { boardUuids, canonicalBoardUuid: boards[0].uuid, reason: 'Two entries for one spray wall' } },
        ctx(reporter),
      ),
    ).rejects.toThrow('public catalog');
  });
});
