import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import { KioskLayoutSchema, emptyKioskLayout } from '@boardsesh/kiosk';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db, runWithDatabaseTransaction } from '../db/client';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { socialGymKioskMutations } from '../graphql/resolvers/social/gym-kiosks';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

let ownerId: string;
let requesterId: string;
let gym: typeof tables.gyms.$inferSelect;
let otherGym: typeof tables.gyms.$inferSelect;
let canonical: typeof tables.userBoards.$inferSelect;
let duplicate: typeof tables.userBoards.$inferSelect;
let kiosk: typeof tables.gymKiosks.$inferSelect;

function context(userId: string): ConnectionContext {
  return { connectionId: `directory-concurrency-${randomUUID()}`, transport: 'http', isAuthenticated: true, userId };
}

async function backendPid(executor: Pick<typeof db, 'execute'>): Promise<number> {
  const rows = await executor.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return Array.from(rows)[0]!.pid;
}

async function waitForLock(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await db.execute<{ waitType: string | null; query: string }>(sql`
      SELECT wait_event_type AS "waitType", query FROM pg_stat_activity WHERE pid = ${pid}
    `);
    const activity = Array.from(rows)[0];
    if (activity?.waitType === 'Lock') return activity.query;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The writer did not wait on the protected resource row.');
}

function duplicateLayout() {
  return KioskLayoutSchema.parse({ ...emptyKioskLayout(), boards: [{ boardUuid: duplicate.uuid }] });
}
function canonicalLayout() {
  return KioskLayoutSchema.parse({ ...emptyKioskLayout(), boards: [{ boardUuid: canonical.uuid }] });
}
async function storedGrant() {
  return db
    .select()
    .from(tables.resourceGrants)
    .where(
      and(
        eq(tables.resourceGrants.kind, 'board'),
        eq(tables.resourceGrants.resourceId, duplicate.uuid),
        eq(tables.resourceGrants.userId, requesterId),
      ),
    );
}

beforeEach(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  ownerId = `directory-owner-${randomUUID()}`;
  requesterId = `directory-requester-${randomUUID()}`;
  await db.insert(tables.users).values([ownerId, requesterId].map((id) => ({ id, email: `${id}@test.com`, name: id })));
  [gym, otherGym] = await db
    .insert(tables.gyms)
    .values(
      [0, 1].map((index) => ({
        uuid: randomUUID(),
        slug: `reference-gym-${randomUUID()}`,
        ownerId,
        name: `Reference gym ${index}`,
      })),
    )
    .returning();
  [canonical, duplicate] = await db
    .insert(tables.userBoards)
    .values(
      [0, 1].map((index) => ({
        uuid: randomUUID(),
        slug: `reference-board-${randomUUID()}`,
        ownerId,
        gymId: gym.id,
        name: `Reference board ${index}`,
        boardType: 'moonboard',
        layoutId: 5,
        sizeId: 1,
        setIds: '17,18,19,20,21,22,23',
      })),
    )
    .returning();
  [kiosk] = await db
    .insert(tables.gymKiosks)
    .values({
      uuid: randomUUID(),
      slug: `screen-${randomUUID()}`,
      gymId: gym.id,
      name: 'Reference screen',
      layout: duplicateLayout(),
    })
    .returning();
});
afterEach(() => vi.unstubAllEnvs());

describe('resource references serialize with directory repairs', () => {
  it('does not insert an access request after a winning board merge tombstones its target', async () => {
    const locked = deferred<void>();
    const release = deferred<void>();
    const started = deferred<number>();
    const repair = db.transaction(async (transaction) => {
      await transaction.select().from(tables.userBoards).where(eq(tables.userBoards.id, duplicate.id)).for('update');
      locked.resolve();
      await release.promise;
      await transaction
        .update(tables.userBoards)
        .set({ deletedAt: new Date(), mergedIntoBoardUuid: canonical.uuid })
        .where(eq(tables.userBoards.id, duplicate.id));
    });
    await locked.promise;
    const request = runWithDatabaseTransaction(async (transaction) => {
      started.resolve(await backendPid(transaction));
      return privacyMutations.requestResourceAccess(
        null,
        { kind: 'board', resourceId: duplicate.uuid },
        context(requesterId),
      );
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await waitForLock(await started.promise)).toContain('user_boards');
    } finally {
      release.resolve();
      await repair;
    }
    expect(await request).toMatchObject({ error: { extensions: { code: 'NOT_FOUND' } } });
    expect(await storedGrant()).toHaveLength(0);
  });

  it('holds the active board through a committed access request so merge cannot pass its grant check', async () => {
    const requested = deferred<void>();
    const release = deferred<void>();
    const request = runWithDatabaseTransaction(async () => {
      await privacyMutations.requestResourceAccess(
        null,
        { kind: 'board', resourceId: duplicate.uuid },
        context(requesterId),
      );
      requested.resolve();
      await release.promise;
    });
    await requested.promise;
    try {
      await expect(
        db.transaction(async (transaction) => {
          await transaction
            .select()
            .from(tables.userBoards)
            .where(eq(tables.userBoards.id, duplicate.id))
            .for('update', { noWait: true });
        }),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
    } finally {
      release.resolve();
      await request;
    }
    expect(await storedGrant()).toMatchObject([{ status: 'pending' }]);
  });

  it('retains session access-request behavior inside the same resource lock contract', async () => {
    const sessionId = randomUUID();
    await db.insert(tables.boardSessions).values({
      id: sessionId,
      boardPath: 'moonboard/5/1/17,18,19,20,21,22,23/40',
      createdByUserId: ownerId,
      isPublic: true,
    });
    await expect(
      privacyMutations.requestResourceAccess(null, { kind: 'session', resourceId: sessionId }, context(requesterId)),
    ).resolves.toBe(true);
    expect(
      await db
        .select()
        .from(tables.resourceGrants)
        .where(and(eq(tables.resourceGrants.kind, 'session'), eq(tables.resourceGrants.resourceId, sessionId))),
    ).toMatchObject([{ userId: requesterId, status: 'pending' }]);
  });

  it('does not restore stale kiosk UUIDs after a winning merge repairs its layout', async () => {
    const locked = deferred<void>();
    const release = deferred<void>();
    const started = deferred<number>();
    const repair = db.transaction(async (transaction) => {
      await transaction.select().from(tables.userBoards).where(eq(tables.userBoards.id, duplicate.id)).for('update');
      await transaction.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.id, kiosk.id)).for('update');
      locked.resolve();
      await release.promise;
      await transaction
        .update(tables.gymKiosks)
        .set({ layout: canonicalLayout() })
        .where(eq(tables.gymKiosks.id, kiosk.id));
      await transaction
        .update(tables.userBoards)
        .set({ deletedAt: new Date(), mergedIntoBoardUuid: canonical.uuid })
        .where(eq(tables.userBoards.id, duplicate.id));
    });
    await locked.promise;
    const update = runWithDatabaseTransaction(async (transaction) => {
      started.resolve(await backendPid(transaction));
      return socialGymKioskMutations.updateGymKiosk(
        null,
        { input: { kioskUuid: kiosk.uuid, layout: duplicateLayout() } },
        context(ownerId),
      );
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await waitForLock(await started.promise)).toContain('user_boards');
    } finally {
      release.resolve();
      await repair;
    }
    expect(await update).toMatchObject({ error: { extensions: { code: 'BAD_USER_INPUT' } } });
    const [stored] = await db.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.id, kiosk.id));
    expect(stored.layout.boards.map((slot) => slot.boardUuid)).toEqual([canonical.uuid]);
  });

  it('keeps every kiosk board locked through the layout commit', async () => {
    const saved = deferred<void>();
    const release = deferred<void>();
    const update = runWithDatabaseTransaction(async () => {
      await socialGymKioskMutations.updateGymKiosk(
        null,
        { input: { kioskUuid: kiosk.uuid, layout: duplicateLayout() } },
        context(ownerId),
      );
      saved.resolve();
      await release.promise;
    });
    await saved.promise;
    try {
      await expect(
        db.transaction(async (transaction) => {
          await transaction
            .select()
            .from(tables.userBoards)
            .where(eq(tables.userBoards.id, duplicate.id))
            .for('update', { noWait: true });
        }),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
    } finally {
      release.resolve();
      await update;
    }
  });

  it('rechecks a kiosk moved to another gym before saving a previously validated layout', async () => {
    const locked = deferred<void>();
    const release = deferred<void>();
    const started = deferred<number>();
    const move = db.transaction(async (transaction) => {
      await transaction.select().from(tables.userBoards).where(eq(tables.userBoards.id, duplicate.id)).for('update');
      locked.resolve();
      await release.promise;
      await transaction.update(tables.gymKiosks).set({ gymId: otherGym.id }).where(eq(tables.gymKiosks.id, kiosk.id));
    });
    await locked.promise;
    const update = runWithDatabaseTransaction(async (transaction) => {
      started.resolve(await backendPid(transaction));
      return socialGymKioskMutations.updateGymKiosk(
        null,
        { input: { kioskUuid: kiosk.uuid, name: 'Stale rename', layout: duplicateLayout() } },
        context(ownerId),
      );
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForLock(await started.promise);
    } finally {
      release.resolve();
      await move;
    }
    expect(await update).toMatchObject({ error: { extensions: { code: 'NOT_FOUND' } } });
    const [stored] = await db.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.id, kiosk.id));
    expect(stored.name).toBe('Reference screen');
    expect(stored.gymId).toBe(otherGym.id);
  });

  it('refuses a conflicting gym lock without waiting in board-to-gym order', async () => {
    const locked = deferred<void>();
    const release = deferred<void>();
    const gymRepair = db.transaction(async (transaction) => {
      await transaction.select().from(tables.gyms).where(eq(tables.gyms.id, gym.id)).for('update');
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      await expect(
        socialGymKioskMutations.updateGymKiosk(
          null,
          { input: { kioskUuid: kiosk.uuid, name: 'Must roll back', layout: duplicateLayout() } },
          context(ownerId),
        ),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    } finally {
      release.resolve();
      await gymRepair;
    }
    const [stored] = await db.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.id, kiosk.id));
    expect(stored.name).toBe('Reference screen');
  });

  it('does not create an empty kiosk on a gym merged while create waited for its cap lock', async () => {
    const locked = deferred<void>();
    const release = deferred<void>();
    const started = deferred<number>();
    const repair = db.transaction(async (transaction) => {
      await transaction.select().from(tables.gyms).where(eq(tables.gyms.id, gym.id)).for('update');
      locked.resolve();
      await release.promise;
      await transaction
        .update(tables.gyms)
        .set({ deletedAt: new Date(), mergedIntoGymId: otherGym.id })
        .where(eq(tables.gyms.id, gym.id));
    });
    await locked.promise;
    const create = runWithDatabaseTransaction(async (transaction) => {
      started.resolve(await backendPid(transaction));
      return socialGymKioskMutations.createGymKiosk(
        null,
        { input: { gymUuid: gym.uuid, name: 'Late screen', slug: 'late-screen' } },
        context(ownerId),
      );
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await waitForLock(await started.promise)).toContain('gyms');
    } finally {
      release.resolve();
      await repair;
    }
    expect(await create).toMatchObject({ error: { extensions: { code: 'NOT_FOUND' } } });
    expect(await db.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.slug, 'late-screen'))).toHaveLength(0);
  });
});
