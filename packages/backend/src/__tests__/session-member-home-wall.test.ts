/**
 * #7013: joining a session counts as holding its wall's link, for that session.
 * A crew member in the wall OWNER's live session on a private or unlisted home
 * wall reads the wall the session is on (its named path, its page by slug, its
 * binding when they change the angle) while they are in the session's live
 * roster. Discovery, gym walls, spray walls, a revoked grant and a session
 * someone other than the owner started keep every gate.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { projectSessionBoardPath } from '../services/board-session-privacy';
import { resolveSessionBoardId } from '../services/session-board-binding';
import { canAccessBoard } from '../services/privacy';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { updateSessionBoardPathIfChanged } from '../services/room-manager/session-discovery';
import { roomManager } from '../services/room-manager';
import { buildSessionPayload } from '../graphql/resolvers/sessions/helpers';
import { sessionQueries } from '../graphql/resolvers/sessions/queries';
import { handleSessionJoin } from '../handlers/join';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findReachableActiveBoardByUuid, requireAnonReadableBoard } from '../graphql/resolvers/board-presence/shared';

const HOST = 'home-wall-host';
const GRANTEE = 'home-wall-grantee';
const MEMBER = 'home-wall-member';
const STRANGER = 'home-wall-stranger';
const GYM_OWNER = 'home-wall-gym-owner';
const GEOMETRY = '/kilter/1/1/1/40';

const named = (slug: string, angle = 40) => `/b/${slug}/${angle}`;
const viewer = (userId: string): ConnectionContext =>
  ({ connectionId: `home-wall-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const boardIds = new Map<string, number>();
const boardUuid = (slug: string) => `${slug}-board`;

beforeAll(async () => {
  await db
    .insert(schema.users)
    .values([HOST, GRANTEE, MEMBER, STRANGER, GYM_OWNER].map((id) => ({ id, name: id, email: `${id}@test.invalid` })));
  const [gym] = await db
    .insert(schema.gyms)
    .values({ uuid: 'home-wall-gym', name: 'Home wall gym', ownerId: GYM_OWNER, isPublic: true })
    .returning({ id: schema.gyms.id });
  const board = (slug: string, values: Partial<typeof schema.userBoards.$inferInsert>) => ({
    uuid: boardUuid(slug),
    slug,
    ownerId: HOST,
    name: slug,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    ...values,
  });
  const rows = await db
    .insert(schema.userBoards)
    .values([
      board('private-home-wall', {
        isPublic: false,
        locationName: 'Sam’s garage, 12 Example Road',
        latitude: -33.86,
        longitude: 151.2,
      }),
      board('unlisted-home-wall', { isPublic: true, isUnlisted: true }),
      board('invite-only-home-wall', { isPublic: false }),
      board('other-home-wall', { isPublic: true }),
      board('member-private-wall', { isPublic: false, ownerId: MEMBER }),
      board('private-gym-wall', { isPublic: false, gymId: Number(gym.id) }),
      board('private-spray-wall', {
        isPublic: false,
        boardType: 'spray',
        layoutId: 876_543,
        sizeId: 876_543,
        hasLeds: false,
      }),
    ])
    .returning({ id: schema.userBoards.id, slug: schema.userBoards.slug });
  for (const row of rows) boardIds.set(row.slug!, Number(row.id));
  // An Invite-only wall the owner shared with one friend.
  await db.insert(schema.resourcePrivacy).values({
    kind: 'board',
    resourceId: boardUuid('invite-only-home-wall'),
    ownerId: HOST,
    audience: 'invite_only',
  });
});

let sessionId = '';
let connections = 0;

/** Join the live session the way joinSession does: a roster seat and a participant row. */
async function join(userId: string, boardPath = GEOMETRY): Promise<string> {
  const connectionId = `home-wall-${userId}-${(connections += 1)}`;
  await roomManager.registerClient(connectionId, userId, userId);
  await roomManager.joinSession(connectionId, sessionId, boardPath);
  return connectionId;
}

/** A live session on this wall, started by `host`, with the member in it. */
async function sessionOn(slug: string, host = HOST) {
  sessionId = randomUUID();
  await join(host, named(slug));
  return join(MEMBER);
}

async function endSession() {
  await db
    .update(schema.boardSessions)
    .set({ status: 'ended', endedAt: new Date() })
    .where(eq(schema.boardSessions.id, sessionId));
}

const boardBySlug = (slug: string, userId: string) => socialBoardQueries.boardBySlug(null, { slug }, viewer(userId));

beforeEach(async () => {
  await db.delete(schema.resourceGrants);
});

describe('a session member on a home wall', () => {
  it('gets the named path of a private home wall, its page by slug, and its reads', async () => {
    await sessionOn('private-home-wall');
    expect(await projectSessionBoardPath(named('private-home-wall'), MEMBER)).toBe(named('private-home-wall'));
    expect((await boardBySlug('private-home-wall', MEMBER))?.uuid).toBe(boardUuid('private-home-wall'));
    expect(await canAccessBoard(boardUuid('private-home-wall'), MEMBER, null)).toBe(true);
  });

  it('gets the named path of an unlisted home wall', async () => {
    await sessionOn('unlisted-home-wall');
    expect(await projectSessionBoardPath(named('unlisted-home-wall'), MEMBER)).toBe(named('unlisted-home-wall'));
  });

  it('keeps the session on the wall when the member changes the angle', async () => {
    await sessionOn('private-home-wall');
    await updateSessionBoardPathIfChanged(sessionId, named('private-home-wall', 45), MEMBER, 'member-pid');
    const [session] = await db
      .select({ boardPath: schema.boardSessions.boardPath, boardId: schema.boardSessions.boardId })
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, sessionId));
    expect(session).toEqual({ boardPath: named('private-home-wall', 45), boardId: boardIds.get('private-home-wall') });
  });

  it('cannot carry the wall into a session of their own', async () => {
    await sessionOn('private-home-wall');
    await expect(resolveSessionBoardId(named('private-home-wall'), MEMBER)).rejects.toThrow('Board not found');
    await expect(resolveSessionBoardId(named('private-home-wall'), MEMBER, 'another-session')).rejects.toThrow(
      'Board not found',
    );
  });

  it('loses the wall when the session ends', async () => {
    await sessionOn('private-home-wall');
    await endSession();
    expect(await projectSessionBoardPath(named('private-home-wall'), MEMBER)).toBe(GEOMETRY);
    expect(await boardBySlug('private-home-wall', MEMBER)).toBeNull();
    expect(await canAccessBoard(boardUuid('private-home-wall'), MEMBER, null)).toBe(false);
  });

  it('withholds the wall from anyone not in the session, and from discovery', async () => {
    await sessionOn('private-home-wall');
    expect(await projectSessionBoardPath(named('private-home-wall'), STRANGER)).toBe(GEOMETRY);
    expect(await boardBySlug('private-home-wall', STRANGER)).toBeNull();
    expect(await projectSessionBoardPath(named('private-home-wall'), MEMBER, { discovery: true })).toBe(GEOMETRY);
  });

  it('withholds the wall from a member whose grant the owner revoked', async () => {
    await sessionOn('private-home-wall');
    await db.insert(schema.resourceGrants).values({
      kind: 'board',
      resourceId: boardUuid('private-home-wall'),
      userId: MEMBER,
      status: 'revoked',
    });
    expect(await projectSessionBoardPath(named('private-home-wall'), MEMBER)).toBe(GEOMETRY);
    expect(await boardBySlug('private-home-wall', MEMBER)).toBeNull();
  });

  it('leaves a private wall at a gym, and a private spray wall, to their own gates', async () => {
    await sessionOn('private-gym-wall');
    expect(await projectSessionBoardPath(named('private-gym-wall'), MEMBER)).toBe(GEOMETRY);
    expect(await canAccessBoard(boardUuid('private-gym-wall'), MEMBER, null)).toBe(false);

    await sessionOn('private-spray-wall');
    expect(await projectSessionBoardPath(named('private-spray-wall'), MEMBER)).toBe('/spray/876543/876543/1/40');
    expect(await canAccessBoard(boardUuid('private-spray-wall'), MEMBER, null)).toBe(false);
  });

  it('names the wall to a fresh joiner once they have joined, not from the invite before', async () => {
    // No seeded rows: the owner opens the session, the friend joins it through
    // the room manager the way joinSession does.
    sessionId = randomUUID();
    await join(HOST, named('private-home-wall'));
    const sessionRead = async (userId: string) => {
      const [sessionData] = await db.select().from(schema.boardSessions).where(eq(schema.boardSessions.id, sessionId));
      const payload = await buildSessionPayload(sessionId, viewer(userId), {
        users: [],
        queueState: null,
        sessionData,
        lastConnectedBoardSerial: null,
        isLeader: false,
        clientId: '',
      });
      return payload.boardPath;
    };

    // The invite alone is not the wall's link: the confirm screen shows geometry.
    expect(await sessionRead(MEMBER)).toBe(GEOMETRY);
    await join(MEMBER);
    expect(await sessionRead(MEMBER)).toBe(named('private-home-wall'));
    expect(await sessionRead(STRANGER)).toBe(GEOMETRY);
  });

  it('grants nothing through a session someone other than the owner started on the wall', async () => {
    // The owner shared the Invite-only wall with GRANTEE, who may start a
    // session on it. That must not hand the wall to whoever joins.
    await db.insert(schema.resourceGrants).values({
      kind: 'board',
      resourceId: boardUuid('invite-only-home-wall'),
      userId: GRANTEE,
      status: 'approved',
    });
    await sessionOn('invite-only-home-wall', GRANTEE);
    expect(await projectSessionBoardPath(named('invite-only-home-wall'), MEMBER)).toBe(GEOMETRY);
    expect(await canAccessBoard(boardUuid('invite-only-home-wall'), MEMBER, null)).toBe(false);

    // The same wall in the owner's own session does.
    await sessionOn('invite-only-home-wall');
    expect(await projectSessionBoardPath(named('invite-only-home-wall'), MEMBER)).toBe(named('invite-only-home-wall'));
  });

  it('withholds the wall from a member who left, while the session goes on', async () => {
    const memberConnection = await sessionOn('private-home-wall');
    expect(await canAccessBoard(boardUuid('private-home-wall'), MEMBER, null)).toBe(true);
    await roomManager.leaveSession(memberConnection);
    // Their participant row stays, a permanent record; the live roster decides.
    expect(await projectSessionBoardPath(named('private-home-wall'), MEMBER)).toBe(GEOMETRY);
    expect(await canAccessBoard(boardUuid('private-home-wall'), MEMBER, null)).toBe(false);
  });

  it('refuses a member angle change that lost a race with the owner moving off the wall', async () => {
    await sessionOn('private-home-wall');
    // The owner's move holds the session row; the member's angle change on the
    // old wall arrives while it is uncommitted and must not write the old wall back.
    let releaseMove: () => void = () => {};
    const moveHeld = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    let moveLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      moveLocked = resolve;
    });
    const move = db.transaction(async (tx) => {
      await tx.select().from(schema.boardSessions).where(eq(schema.boardSessions.id, sessionId)).for('update');
      await tx
        .update(schema.boardSessions)
        .set({ boardPath: named('other-home-wall'), boardId: boardIds.get('other-home-wall') })
        .where(eq(schema.boardSessions.id, sessionId));
      moveLocked();
      await moveHeld;
    });
    await locked;
    const angleChange = updateSessionBoardPathIfChanged(
      sessionId,
      named('private-home-wall', 45),
      MEMBER,
      'member-pid',
    );
    const settled = angleChange.then(
      () => 'written',
      () => 'refused',
    );
    // Long enough for the angle change to reach the row lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseMove();
    await move;
    expect(await settled).toBe('refused');
    const [session] = await db
      .select({ boardId: schema.boardSessions.boardId })
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, sessionId));
    expect(session.boardId).toBe(boardIds.get('other-home-wall'));
  });

  // #7220: the crew of a Relay mode MoonBoard binds presence to the owner's
  // board, so the reads a crewmate needs at the wall go through the same rule.
  it('lets the crew read the wall, but never its place, its edit rights or its listing', async () => {
    await sessionOn('private-home-wall');
    const page = await boardBySlug('private-home-wall', MEMBER);
    expect(page).toMatchObject({ uuid: boardUuid('private-home-wall'), canEdit: false });
    expect(page).toMatchObject({ locationName: null, latitude: null, longitude: null, distanceMeters: null });
    // The owner still sees the place.
    expect(await boardBySlug('private-home-wall', HOST)).toMatchObject({ latitude: -33.86, longitude: 151.2 });
    // Search and the member's own board list never carry it.
    const search = await socialBoardQueries.searchBoards(
      null,
      { input: { query: 'private-home-wall' } },
      viewer(MEMBER),
    );
    expect(search.boards.map((listed: { uuid: string }) => listed.uuid)).not.toContain(boardUuid('private-home-wall'));
    const mine = await socialBoardQueries.myBoards(null, {}, viewer(MEMBER));
    expect(mine.boards.map((listed: { uuid: string }) => listed.uuid)).not.toContain(boardUuid('private-home-wall'));
  });

  it('binds the crew’s presence to the wall and opens its feed, until they leave', async () => {
    const memberConnection = await sessionOn('private-home-wall');
    const wallId = boardIds.get('private-home-wall')!;
    expect((await findReachableActiveBoardByUuid(MEMBER, boardUuid('private-home-wall')))?.id).toBe(wallId);
    await expect(requireAnonReadableBoard(wallId, MEMBER, boardUuid('private-home-wall'))).resolves.toBeUndefined();
    await expect(requireAnonReadableBoard(wallId, MEMBER)).resolves.toBeUndefined();
    // A stranger gets neither.
    expect(await findReachableActiveBoardByUuid(STRANGER, boardUuid('private-home-wall'))).toBeUndefined();
    await expect(requireAnonReadableBoard(wallId, STRANGER, boardUuid('private-home-wall'))).rejects.toThrow();

    await roomManager.leaveSession(memberConnection);
    expect(await findReachableActiveBoardByUuid(MEMBER, boardUuid('private-home-wall'))).toBeUndefined();
    await expect(requireAnonReadableBoard(wallId, MEMBER, boardUuid('private-home-wall'))).rejects.toThrow();
  });

  it('redirects a signed-out session link to the wall’s geometry, never its slug', async () => {
    await sessionOn('private-home-wall');
    let location = '';
    const response = {
      setHeader: () => {},
      writeHead: (_status: number, headers?: Record<string, string>) => {
        location = headers?.Location ?? '';
      },
      end: () => {},
    } as unknown as ServerResponse;
    const request = { headers: { host: 'api.test' } } as unknown as IncomingMessage;
    await handleSessionJoin(request, response, sessionId, 4000, 'https://boardsesh.test');
    expect(location.startsWith(`https://boardsesh.test${GEOMETRY}?`)).toBe(true);
    expect(location).not.toContain('private-home-wall');
  });

  it('names a crewmate’s private wall in the host’s session list only to people who may read it', async () => {
    await sessionOn('private-home-wall');
    // A crewmate moved the session onto a private wall of their own.
    await db
      .update(schema.boardSessions)
      .set({ boardPath: named('member-private-wall'), boardId: boardIds.get('member-private-wall') })
      .where(eq(schema.boardSessions.id, sessionId));
    const listed = await sessionQueries.mySessions(null, null, viewer(HOST));
    const hostSession = listed.find((session) => session.id === sessionId);
    expect(hostSession?.boardPath).toBe(GEOMETRY);
  });
});
