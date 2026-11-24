import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, inArray, sql } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db, runWithDatabaseTransaction } from '../db/client';
import type { DbTransaction } from '../db/after-commit';
import { lockActiveBoardForWrite } from '../services/board-reference-lock';
import { ensureSessionRecordExists } from '../services/room-manager/client-lifecycle';
import { createDiscoverableSession, updateSessionBoardPathIfChanged } from '../services/room-manager/session-discovery';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';

const userIds: string[] = [];
const sessionIds: string[] = [];
let ownerId: string;
let original: typeof tables.userBoards.$inferSelect;
let canonical: typeof tables.userBoards.$inferSelect;

beforeEach(async () => {
  ownerId = randomUUID();
  userIds.push(ownerId);
  await db.insert(tables.users).values({ id: ownerId, email: `${ownerId}@test.com` });
  const boards = await db
    .insert(tables.userBoards)
    .values(
      [0, 1].map((index) => ({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId,
        name: `Session lock wall ${index}`,
        boardType: 'moonboard',
        layoutId: 5,
        sizeId: 1,
        setIds: '17,18,19,20,21,22,23',
        isPublic: true,
      })),
    )
    .returning();
  [original, canonical] = boards as [typeof original, typeof canonical];
});

afterAll(async () => {
  await db.delete(tables.boardSessions).where(inArray(tables.boardSessions.id, sessionIds));
  await db.delete(tables.users).where(inArray(tables.users.id, userIds));
});

const context = (): ConnectionContext => ({
  connectionId: randomUUID(),
  transport: 'http',
  userId: ownerId,
  isAuthenticated: true,
});

async function createSession(kind: 'join' | 'discoverable' | 'http', slug: string, boardIds?: number[]) {
  const boardPath = `/b/${slug}/40`;
  if (kind === 'http') {
    const created = await sessionMutations.createSession(
      null,
      {
        input: {
          boardPath,
          latitude: 59.299,
          longitude: 17.991,
          discoverable: false,
          ...(boardIds ? { boardIds } : {}),
        },
      },
      context(),
    );
    sessionIds.push(created.id);
    return created.id;
  }
  const sessionId = randomUUID();
  sessionIds.push(sessionId);
  if (kind === 'join') await ensureSessionRecordExists(sessionId, boardPath, ownerId);
  else await createDiscoverableSession(sessionId, boardPath, ownerId, 59.299, 17.991);
  return sessionId;
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function waitForLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [activity] = Array.from(
      await db.execute<{ waitType: string | null }>(
        sql`SELECT wait_event_type AS "waitType" FROM pg_stat_activity WHERE pid = ${pid}`,
      ),
    );
    if (activity?.waitType === 'Lock') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function holdTickStyleBoardLock(afterRelease?: (transaction: DbTransaction) => Promise<void>) {
  const locked = deferred<void>();
  const release = deferred<void>();
  const done = db.transaction(async (transaction) => {
    await transaction
      .select()
      .from(tables.userBoards)
      .where(eq(tables.userBoards.id, original.id))
      .for('no key update');
    locked.resolve();
    await release.promise;
    await afterRelease?.(transaction);
  });
  await locked.promise;
  return { release: () => release.resolve(), done };
}

function sessionActionWithPid<Result>(work: () => Promise<Result>) {
  const pid = deferred<number>();
  const action = runWithDatabaseTransaction(async (executor) => {
    const [backend] = Array.from(await executor.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`));
    pid.resolve(backend!.pid);
    return work();
  });
  return { pid: pid.promise, action };
}

describe('session writers serialize with identity merges', () => {
  it.each(['join', 'discoverable', 'http'] as const)(
    '%s waits for an ordinary tick writer, then starts on the same board',
    async (kind) => {
      const tick = await holdTickStyleBoardLock();
      const start = sessionActionWithPid(() => createSession(kind, original.slug));
      const settled = start.action.then(
        (sessionId) => ({ sessionId }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(await waitForLock(await start.pid)).toBe(true);
        tick.release();
        await tick.done;
        const result = await settled;
        expect(result).not.toHaveProperty('error');
        if (!('sessionId' in result)) throw new Error('Session did not start after the tick committed.');
        const [session] = await db
          .select()
          .from(tables.boardSessions)
          .where(eq(tables.boardSessions.id, result.sessionId));
        expect(session!.boardId).toBe(original.id);
      } finally {
        tick.release();
        await Promise.allSettled([tick.done, start.action]);
      }
    },
  );

  it('waits for an additional numeric board without refusing a normal tick update', async () => {
    const tick = await holdTickStyleBoardLock();
    const start = sessionActionWithPid(() => createSession('http', canonical.slug, [original.id]));
    const settled = start.action.then(
      (sessionId) => ({ sessionId }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await waitForLock(await start.pid)).toBe(true);
      tick.release();
      await tick.done;
      const result = await settled;
      expect(result).not.toHaveProperty('error');
      if (!('sessionId' in result)) throw new Error('Multi-board session did not start after the tick committed.');
      const links = await db
        .select()
        .from(tables.sessionBoards)
        .where(eq(tables.sessionBoards.sessionId, result.sessionId));
      expect(links.map((link) => link.boardId)).toContain(original.id);
    } finally {
      tick.release();
      await Promise.allSettled([tick.done, start.action]);
    }
  });

  it('changes session angle after a board-to-session tick update without reversing its lock order', async () => {
    const sessionId = await createSession('join', original.slug);
    const tick = await holdTickStyleBoardLock(async (transaction) => {
      await transaction
        .update(tables.boardSessions)
        .set({ lastActivity: new Date() })
        .where(eq(tables.boardSessions.id, sessionId));
    });
    const change = sessionActionWithPid(() =>
      updateSessionBoardPathIfChanged(sessionId, `/b/${original.slug}/45`, ownerId),
    );
    const settled = change.action.then(
      (previous) => ({ previous }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await waitForLock(await change.pid)).toBe(true);
      tick.release();
      await tick.done;
      expect(await settled).toEqual({ previous: `/b/${original.slug}/40` });
      const [session] = await db.select().from(tables.boardSessions).where(eq(tables.boardSessions.id, sessionId));
      expect(session).toMatchObject({ boardId: original.id, boardPath: `/b/${original.slug}/45` });
    } finally {
      tick.release();
      await Promise.allSettled([tick.done, change.action]);
    }
  });

  it.each(['join', 'discoverable', 'http'] as const)(
    '%s pins its creator before its board when an owner privacy edit is in flight',
    async (kind) => {
      const locked = deferred<void>();
      const release = deferred<void>();
      const edit = db.transaction(async (transaction) => {
        await transaction.select().from(tables.users).where(eq(tables.users.id, ownerId)).for('update');
        locked.resolve();
        await release.promise;
        await transaction.select().from(tables.userBoards).where(eq(tables.userBoards.id, original.id)).for('update');
      });
      await locked.promise;
      const start = sessionActionWithPid(() => createSession(kind, original.slug));
      const settled = start.action.then(
        (sessionId) => ({ sessionId }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(await waitForLock(await start.pid)).toBe(true);
        release.resolve();
        await edit;
        expect(await settled).not.toHaveProperty('error');
      } finally {
        release.resolve();
        await Promise.allSettled([edit, start.action]);
      }
    },
  );

  it('restores a longer caller lock timeout after obtaining its board fence', async () => {
    await runWithDatabaseTransaction(async (executor) => {
      const transaction = executor as unknown as DbTransaction;
      await transaction.execute(sql`SELECT set_config('lock_timeout', '7s', true)`);
      expect(await lockActiveBoardForWrite(transaction, { id: original.id }, { lockTimeoutMs: 2000 })).toMatchObject({
        id: original.id,
      });
      const [setting] = Array.from(
        await transaction.execute<{ timeout: string }>(sql`SELECT current_setting('lock_timeout') AS timeout`),
      );
      expect(setting!.timeout).toBe('7s');
    });
  });

  it('preserves a stricter caller timeout and leaves its transaction usable after a lock timeout', async () => {
    const tick = await holdTickStyleBoardLock();
    try {
      await runWithDatabaseTransaction(async (executor) => {
        const transaction = executor as unknown as DbTransaction;
        await transaction.execute(sql`SELECT set_config('lock_timeout', '250ms', true)`);
        const startedAt = performance.now();
        await expect(
          lockActiveBoardForWrite(transaction, { id: original.id }, { lockTimeoutMs: 2000 }),
        ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
        expect(performance.now() - startedAt).toBeLessThan(1800);
        const [setting] = Array.from(
          await transaction.execute<{ timeout: string }>(sql`SELECT current_setting('lock_timeout') AS timeout`),
        );
        expect(setting!.timeout).toBe('250ms');
      });
    } finally {
      tick.release();
      await tick.done;
    }
  });

  it.each(['join', 'discoverable', 'http'] as const)(
    '%s times out on a long-held board, then refuses the merged-away identity',
    async (kind) => {
      let markLocked = () => {};
      let releaseLock = () => {};
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const merge = db.transaction(async (transaction) => {
        await transaction.select().from(tables.userBoards).where(eq(tables.userBoards.id, original.id)).for('update');
        markLocked();
        await released;
        await transaction
          .update(tables.userBoards)
          .set({ deletedAt: new Date(), mergedIntoBoardUuid: canonical.uuid })
          .where(eq(tables.userBoards.id, original.id));
      });
      await locked;
      try {
        await expect(createSession(kind, original.slug)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
      } finally {
        releaseLock();
        await merge;
      }
      await expect(createSession(kind, original.slug)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
      const sessionId = await createSession(kind, canonical.slug);
      const [session] = await db.select().from(tables.boardSessions).where(eq(tables.boardSessions.id, sessionId));
      expect(session!.boardId).toBe(canonical.id);
    },
  );

  it('refuses merged-away additional numeric boards during HTTP creation', async () => {
    await db
      .update(tables.userBoards)
      .set({ deletedAt: new Date(), mergedIntoBoardUuid: canonical.uuid })
      .where(eq(tables.userBoards.id, original.id));
    await expect(
      sessionMutations.createSession(
        null,
        {
          input: {
            boardPath: `/b/${canonical.slug}/40`,
            boardIds: [original.id],
            latitude: 59.299,
            longitude: 17.991,
            discoverable: false,
          },
        },
        context(),
      ),
    ).rejects.toThrow('One or more board IDs do not exist');
  });

  it('moves a session whose stored old slug already points at a merged board', async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    await db.insert(tables.boardSessions).values({
      id: sessionId,
      boardPath: `/b/${original.slug}/40`,
      boardId: canonical.id,
      createdByUserId: ownerId,
      isPublic: true,
    });
    await db
      .update(tables.userBoards)
      .set({ deletedAt: new Date(), mergedIntoBoardUuid: canonical.uuid })
      .where(eq(tables.userBoards.id, original.id));
    await expect(updateSessionBoardPathIfChanged(sessionId, `/b/${canonical.slug}/45`, ownerId)).resolves.toBe(
      `/b/${original.slug}/40`,
    );
    const [session] = await db.select().from(tables.boardSessions).where(eq(tables.boardSessions.id, sessionId));
    expect(session).toMatchObject({ boardId: canonical.id, boardPath: `/b/${canonical.slug}/45` });
  });
});
