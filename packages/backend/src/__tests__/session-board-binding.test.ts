import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { resolveSessionBoardId } from '../services/session-board-binding';
import { ensureSessionRecordExists } from '../services/room-manager/client-lifecycle';
import {
  createDiscoverableSession,
  getUserSessions,
  updateSessionBoardPathIfChanged,
} from '../services/room-manager/session-discovery';
import { canAccessResource } from '../services/privacy';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';

const owner = 'board-binding-owner';
const stranger = 'board-binding-stranger';
const privateUuid = uuidv4();
const publicUuid = uuidv4();
let privateBoardId: number;
let publicBoardId: number;
const privatePath = '/b/binding-private/40';
const publicPath = '/b/binding-public/40';
const genericPath = '/kilter/1/1/1/30';

beforeAll(async () => {
  await db.insert(schema.users).values([owner, stranger].map((id) => ({ id, email: `${id}@test.com` })));
  const boards = await db
    .insert(schema.userBoards)
    .values([
      {
        uuid: privateUuid,
        slug: 'binding-private',
        ownerId: owner,
        name: 'Private',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        isPublic: false,
      },
      {
        uuid: publicUuid,
        slug: 'binding-public',
        ownerId: owner,
        name: 'Public',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 2,
        setIds: '1',
        isPublic: true,
      },
    ])
    .returning({ id: schema.userBoards.id, uuid: schema.userBoards.uuid });
  privateBoardId = boards.find((board) => board.uuid === privateUuid)!.id;
  publicBoardId = boards.find((board) => board.uuid === publicUuid)!.id;
});

async function sessionRow(sessionId: string) {
  const [session] = await db.select().from(schema.boardSessions).where(eq(schema.boardSessions.id, sessionId));
  return session;
}

const context = (userId: string): ConnectionContext => ({
  connectionId: `binding-${userId}`,
  transport: 'http',
  userId,
  isAuthenticated: true,
});
const input = (boardPath: string, boardIds?: number[]) => ({
  boardPath,
  boardIds,
  latitude: 0,
  longitude: 0,
  discoverable: false,
});

describe('session board path privacy binding', () => {
  it('resolves public paths while refusing private or missing names to strangers', async () => {
    expect(await resolveSessionBoardId(publicPath, stranger)).toBe(publicBoardId);
    await expect(resolveSessionBoardId(privatePath, stranger)).rejects.toThrow('Board not found');
    await expect(resolveSessionBoardId('/b/never-created/40', owner)).rejects.toThrow('Board not found');
  });
  it('binds a private named board on the initial WebSocket session insert', async () => {
    const sessionId = uuidv4();
    await ensureSessionRecordExists(sessionId, privatePath, owner);
    expect((await sessionRow(sessionId)).boardId).toBe(privateBoardId);
    expect(await canAccessResource('session', sessionId, owner)).toBe(true);
    expect(await canAccessResource('session', sessionId, stranger)).toBe(false);
  });
  it('binds non-discoverable HTTP session creation before returning its ID', async () => {
    const session = await sessionMutations.createSession(null, { input: input(privatePath) }, context(owner));
    expect((await sessionRow(session.id)).boardId).toBe(privateBoardId);
    expect(await canAccessResource('session', session.id, stranger)).toBe(false);
  });
  it('refuses a private switch without changing the existing public path', async () => {
    const sessionId = uuidv4();
    await ensureSessionRecordExists(sessionId, publicPath, owner);
    await expect(updateSessionBoardPathIfChanged(sessionId, privatePath, stranger)).rejects.toThrow('Board not found');
    expect((await sessionRow(sessionId)).boardPath).toBe(publicPath);
    expect((await sessionRow(sessionId)).boardId).toBe(publicBoardId);
  });
  it('keeps every previous board parent when an authorized party switches walls', async () => {
    const sessionId = uuidv4();
    await ensureSessionRecordExists(sessionId, publicPath, owner);
    await updateSessionBoardPathIfChanged(sessionId, privatePath, owner);
    await updateSessionBoardPathIfChanged(sessionId, genericPath, owner);
    const parents = await db
      .select({ boardId: schema.sessionBoards.boardId })
      .from(schema.sessionBoards)
      .where(eq(schema.sessionBoards.sessionId, sessionId));
    expect(new Set(parents.map((parent) => parent.boardId))).toEqual(new Set([publicBoardId, privateBoardId]));
    expect((await sessionRow(sessionId)).boardId).toBeNull();
    expect(await canAccessResource('session', sessionId, stranger)).toBe(false);
  });
  it('preserves the private parent of a legacy named session with no board ID', async () => {
    const sessionId = uuidv4();
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, boardPath: '/es//b/binding-private/40', createdByUserId: owner, isPublic: true });
    expect(await canAccessResource('session', sessionId, stranger)).toBe(false);
    await updateSessionBoardPathIfChanged(sessionId, genericPath, owner);
    expect(await canAccessResource('session', sessionId, stranger)).toBe(false);
  });
  it('checks attached boards even on non-discoverable multi-board creation', async () => {
    await expect(
      sessionMutations.createSession(null, { input: input(genericPath, [privateBoardId]) }, context(stranger)),
    ).rejects.toThrow('One or more board IDs do not exist');
    const session = await sessionMutations.createSession(
      null,
      { input: input(publicPath, [privateBoardId]) },
      context(owner),
    );
    expect(await canAccessResource('session', session.id, stranger)).toBe(false);
    expect(await canAccessResource('session', session.id, owner)).toBe(true);
  });
  it('restricts discoverable upserts to the original creator and existing board path', async () => {
    const sessionId = uuidv4();
    await ensureSessionRecordExists(sessionId, publicPath, owner);
    await createDiscoverableSession(sessionId, publicPath, owner, 10, 20, 'Owner session');
    await expect(createDiscoverableSession(sessionId, publicPath, stranger, 10, 20)).rejects.toThrow(
      'Session not found',
    );
    await expect(createDiscoverableSession(sessionId, privatePath, owner, 10, 20)).rejects.toThrow('Session not found');
    expect((await sessionRow(sessionId)).createdByUserId).toBe(owner);
    expect((await sessionRow(sessionId)).boardPath).toBe(publicPath);
  });
  it('removes an owned session from the list when access to its wall is revoked', async () => {
    const sessionId = uuidv4();
    await db.insert(schema.resourcePrivacy).values({
      kind: 'board',
      resourceId: privateUuid,
      ownerId: owner,
      audience: 'invite_only',
    });
    await db.insert(schema.resourceGrants).values({
      kind: 'board',
      resourceId: privateUuid,
      userId: stranger,
      status: 'approved',
    });
    await ensureSessionRecordExists(sessionId, privatePath, stranger);
    expect((await getUserSessions(stranger)).map((session) => session.id)).toContain(sessionId);
    await db
      .update(schema.resourceGrants)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(schema.resourceGrants.kind, 'board'),
          eq(schema.resourceGrants.resourceId, privateUuid),
          eq(schema.resourceGrants.userId, stranger),
        ),
      );
    expect((await getUserSessions(stranger)).map((session) => session.id)).not.toContain(sessionId);
  });
});
