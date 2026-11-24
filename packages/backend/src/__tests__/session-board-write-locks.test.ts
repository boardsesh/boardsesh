import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, inArray } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
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

async function createSession(kind: 'join' | 'discoverable' | 'http', slug: string) {
  const boardPath = `/b/${slug}/40`;
  if (kind === 'http') {
    const created = await sessionMutations.createSession(
      null,
      { input: { boardPath, latitude: 59.299, longitude: 17.991, discoverable: false } },
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

describe('session writers serialize with identity merges', () => {
  it.each(['join', 'discoverable', 'http'] as const)(
    '%s refuses a held board, then refuses the merged-away identity',
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
