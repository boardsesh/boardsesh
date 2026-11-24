import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db, runWithDatabaseTransaction } from '../../../db/client';
import { socialGymMutations } from '../../../graphql/resolvers/social/gyms';
import { socialBoardMutations } from '../../../graphql/resolvers/social/boards';
import { assertGymActionPermission, authorizeGymBoardRemoval, resolveGymForTool } from '../domain';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function actorContext(userId: string): ConnectionContext {
  return { connectionId: `mcp-authority-test-${randomUUID()}`, transport: 'http', userId, isAuthenticated: true };
}

let ownerId: string;
let leaderId: string;
let gymA: { id: number; uuid: string };
let gymB: { id: number; uuid: string };
let board: { id: number; uuid: string };

async function waitForLock(pid: number, finished: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100 && !finished(); attempt += 1) {
    const rows = await db.execute<{ waitType: string | null }>(sql`
      SELECT wait_event_type AS "waitType" FROM pg_stat_activity WHERE pid = ${pid}
    `);
    if (Array.from(rows)[0]?.waitType === 'Lock') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

beforeEach(async () => {
  const suffix = randomUUID();
  ownerId = `mcp-domain-owner-${suffix}`;
  leaderId = `mcp-domain-leader-${suffix}`;
  await db.insert(tables.users).values([
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Owner' },
    { id: leaderId, email: `${leaderId}@example.test`, name: 'Leader' },
  ]);
  const gyms = await db
    .insert(tables.gyms)
    .values([
      { uuid: randomUUID(), name: 'Selected gym', slug: `mcp-a-${suffix}`, ownerId, isPublic: true },
      { uuid: randomUUID(), name: 'Other gym', slug: `mcp-b-${suffix}`, ownerId, isPublic: true },
    ])
    .returning({ id: tables.gyms.id, uuid: tables.gyms.uuid });
  [gymA, gymB] = [gyms[0]!, gyms[1]!];
  const boards = await db
    .insert(tables.userBoards)
    .values({
      uuid: randomUUID(),
      slug: `mcp-board-${suffix}`,
      name: 'The qualifying board',
      ownerId,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      gymId: gymA.id,
      isPublic: true,
    })
    .returning({ id: tables.userBoards.id, uuid: tables.userBoards.uuid });
  board = boards[0]!;
  await db.insert(tables.communityRoles).values({ userId: leaderId, role: 'community_leader', boardType: 'kilter' });
});

afterEach(async () => {
  await db.delete(tables.users).where(inArray(tables.users.id, [ownerId, leaderId]));
});

describe('MCP gym authority against concurrent first-party board writes', () => {
  it('allows a gym foreign-key insert while still serializing changes to the locked gym', async () => {
    const gymLocked = deferred<void>();
    const releaseGym = deferred<void>();
    const competingWriteStarted = deferred<number>();
    let competingWriteCommitted = false;
    const gymAction = runWithDatabaseTransaction(async () => {
      await resolveGymForTool(gymA.uuid, ownerId, true, true);
      gymLocked.resolve();
      await releaseGym.promise;
    });
    await gymLocked.promise;
    const competingWrite = db
      .transaction(async (transaction) => {
        const pidRows = await transaction.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        competingWriteStarted.resolve(Array.from(pidRows)[0]!.pid);
        await transaction
          .update(tables.gyms)
          .set({ description: 'Concurrent edit' })
          .where(eq(tables.gyms.id, gymA.id));
      })
      .then(() => {
        competingWriteCommitted = true;
      });
    try {
      expect(await waitForLock(await competingWriteStarted.promise, () => competingWriteCommitted)).toBe(true);
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('lock_timeout', '500ms', true)`);
        await transaction.insert(tables.gymMembers).values({ gymId: gymA.id, userId: leaderId, role: 'member' });
      });
      expect(competingWriteCommitted).toBe(false);
      releaseGym.resolve();
      await Promise.all([gymAction, competingWrite]);
      expect(competingWriteCommitted).toBe(true);
    } finally {
      releaseGym.resolve();
      await Promise.allSettled([gymAction, competingWrite]);
    }
  });

  it('conflicts with an owner move in flight, then refuses the old gym after the move commits', async () => {
    const boardLocked = deferred<void>();
    const allowMove = deferred<void>();
    const ownerMove = runWithDatabaseTransaction(async () => {
      await db
        .select({ id: tables.userBoards.id })
        .from(tables.userBoards)
        .where(eq(tables.userBoards.id, board.id))
        .for('update');
      boardLocked.resolve();
      await allowMove.promise;
      await socialGymMutations.linkBoardToGym(
        {},
        { input: { boardUuid: board.uuid, gymUuid: gymB.uuid } },
        actorContext(ownerId),
      );
    });
    try {
      await boardLocked.promise;
      await expect(
        runWithDatabaseTransaction(() => authorizeGymBoardRemoval(gymA.uuid, board.uuid, ownerId, false)),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
      allowMove.resolve();
      await ownerMove;
      await expect(
        runWithDatabaseTransaction(() => authorizeGymBoardRemoval(gymA.uuid, board.uuid, ownerId, false)),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
      const [current] = await db
        .select({ gymId: tables.userBoards.gymId })
        .from(tables.userBoards)
        .where(eq(tables.userBoards.id, board.id));
      expect(current?.gymId).toBe(gymB.id);
    } finally {
      allowMove.resolve();
      await Promise.allSettled([ownerMove]);
    }
  });

  it('does not lock or disclose the busy state of a board at another gym', async () => {
    await socialGymMutations.linkBoardToGym(
      {},
      { input: { boardUuid: board.uuid, gymUuid: gymB.uuid } },
      actorContext(ownerId),
    );
    const boardLocked = deferred<void>();
    const releaseBoard = deferred<void>();
    const competingWriter = db.transaction(async (transaction) => {
      await transaction
        .select({ id: tables.userBoards.id })
        .from(tables.userBoards)
        .where(eq(tables.userBoards.id, board.id))
        .for('update');
      boardLocked.resolve();
      await releaseBoard.promise;
    });
    try {
      await boardLocked.promise;
      await expect(
        runWithDatabaseTransaction(() => authorizeGymBoardRemoval(gymA.uuid, board.uuid, ownerId, false)),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    } finally {
      releaseBoard.resolve();
      await competingWriter;
    }
  });

  it('prevents deletion of the final scoped-authority witness until the gym edit commits', async () => {
    const editAuthorized = deferred<void>();
    const finishEdit = deferred<void>();
    const deleteStarted = deferred<number>();
    let deleteCommitted = false;
    const gymEdit = runWithDatabaseTransaction(async () => {
      await resolveGymForTool(gymA.uuid, leaderId, true, true);
      editAuthorized.resolve();
      await finishEdit.promise;
      await db
        .update(tables.gyms)
        .set({ description: 'Saved while scoped authority was pinned' })
        .where(eq(tables.gyms.id, gymA.id));
    });
    await editAuthorized.promise;
    const ownerDelete = runWithDatabaseTransaction(async () => {
      const pidRows = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      deleteStarted.resolve(Array.from(pidRows)[0]!.pid);
      await socialBoardMutations.deleteBoard({}, { boardUuid: board.uuid }, actorContext(ownerId));
    }).then(() => {
      deleteCommitted = true;
    });
    try {
      expect(await waitForLock(await deleteStarted.promise, () => deleteCommitted)).toBe(true);
      expect(deleteCommitted).toBe(false);
      finishEdit.resolve();
      await Promise.all([gymEdit, ownerDelete]);
      expect(deleteCommitted).toBe(true);
      const [current] = await db
        .select({ description: tables.gyms.description })
        .from(tables.gyms)
        .where(eq(tables.gyms.id, gymA.id));
      expect(current?.description).toBe('Saved while scoped authority was pinned');
      await expect(
        runWithDatabaseTransaction(() => resolveGymForTool(gymA.uuid, leaderId, true, true)),
      ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    } finally {
      finishEdit.resolve();
      await Promise.allSettled([gymEdit, ownerDelete]);
    }
  });

  it('pins access-grant coverage when a scoped community leader is also a gym editor', async () => {
    await db.insert(tables.gymMembers).values({ gymId: gymA.id, userId: leaderId, role: 'editor' });
    const boardLocked = deferred<void>();
    const releaseBoard = deferred<void>();
    const ownerWriter = db.transaction(async (transaction) => {
      await transaction
        .select({ id: tables.userBoards.id })
        .from(tables.userBoards)
        .where(eq(tables.userBoards.id, board.id))
        .for('update');
      boardLocked.resolve();
      await releaseBoard.promise;
    });
    try {
      await boardLocked.promise;
      await expect(
        runWithDatabaseTransaction(async () => {
          const gym = await resolveGymForTool(gymA.uuid, leaderId, true, true);
          await assertGymActionPermission('grant_gym_edit_access', {}, gym, actorContext(leaderId), false);
        }),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    } finally {
      releaseBoard.resolve();
      await ownerWriter;
    }
  });
});
