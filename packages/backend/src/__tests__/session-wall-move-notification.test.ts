import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { ensureSessionRecordExists } from '../services/room-manager/client-lifecycle';
import { updateSessionBoardPathIfChanged } from '../services/room-manager/session-discovery';

const OWNER = 'wall-move-notification-owner';
const OTHER = 'wall-move-notification-other';

beforeEach(async () => {
  await db
    .insert(schema.users)
    .values([OWNER, OTHER].map((id) => ({ id, name: id, email: `${id}@example.test` })))
    .onConflictDoNothing();
});
afterEach(() => vi.restoreAllMocks());

async function publicWall(ownerId: string) {
  const uuid = randomUUID();
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid,
      slug: uuid,
      ownerId,
      name: uuid,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      isPublic: true,
    })
    .returning({ id: schema.userBoards.id, slug: schema.userBoards.slug });
  return { id: Number(board.id), path: `/b/${board.slug}/40` };
}

describe('committed public wall move notification', () => {
  it('notifies this session with the original participant, without duplicate no-op events', async () => {
    const own = await publicWall(OWNER);
    const foreign = await publicWall(OTHER);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, own.path, OWNER);
    const sessionEvent = vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
    expect(await updateSessionBoardPathIfChanged(sessionId, foreign.path, OWNER, 'origin-participant')).toBe(own.path);
    expect(sessionEvent).toHaveBeenCalledExactlyOnceWith(sessionId, {
      __typename: 'SessionBoardPathChanged',
      boardPath: foreign.path,
      changedByParticipantId: 'origin-participant',
      wallChanged: true,
    });
    expect(await updateSessionBoardPathIfChanged(sessionId, foreign.path, OWNER, 'origin-participant')).toBeNull();
    expect(sessionEvent).toHaveBeenCalledOnce();
  });

  it('marks an angle change as keeping the wall, so peers only apply the path', async () => {
    const own = await publicWall(OWNER);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, own.path, OWNER);
    const sessionEvent = vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
    const steeper = own.path.replace(/\/40$/, '/45');
    expect(await updateSessionBoardPathIfChanged(sessionId, steeper, OWNER, 'origin-participant')).toBe(own.path);
    expect(sessionEvent).toHaveBeenCalledExactlyOnceWith(sessionId, {
      __typename: 'SessionBoardPathChanged',
      boardPath: steeper,
      changedByParticipantId: 'origin-participant',
      wallChanged: false,
    });
  });

  it('publishes the targeted refresh even when the subsequent preview lookup fails', async () => {
    const own = await publicWall(OWNER);
    const foreign = await publicWall(OTHER);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, own.path, OWNER);
    const sessionEvent = vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
    vi.spyOn(pubsub, 'getSessionBoard').mockRejectedValue(new Error('preview unavailable'));
    // The move has committed, so the failed kiosk refresh is logged, not thrown.
    await expect(updateSessionBoardPathIfChanged(sessionId, foreign.path, OWNER)).resolves.toBe(own.path);
    expect(sessionEvent).toHaveBeenCalledExactlyOnceWith(sessionId, {
      __typename: 'SessionBoardPathChanged',
      boardPath: foreign.path,
      changedByParticipantId: null,
      wallChanged: true,
    });
    const [session] = await db
      .select({ boardId: schema.boardSessions.boardId, boardPath: schema.boardSessions.boardPath })
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, sessionId));
    expect(session).toEqual({ boardId: foreign.id, boardPath: foreign.path });
  });
});
