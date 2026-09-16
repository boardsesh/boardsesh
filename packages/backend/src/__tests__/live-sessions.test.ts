/**
 * Real-DB coverage for the live-sessions listings (`followedLiveSessions`,
 * `boardLiveSessions`) and the session privacy switch (`isPublic` on
 * createSession / updateSession).
 *
 * The room manager runs for real in its Redis-less single-instance mode, so
 * "live" means a registered connection joined to the session — exactly what a
 * climber's phone does. The one liveness rule that needs Redis (a dormant
 * session whose Redis key survives) is driven through a spy on
 * `roomManager.getSessionLiveness`.
 *
 * `applyRateLimit` is stubbed to a no-op, matching session-update.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { eq, like } from 'drizzle-orm';
import type { ClimbQueueItem, ConnectionContext, LiveSession } from '@boardsesh/shared-schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import { roomManager, type SessionLiveness } from '../services/room-manager';
import { resolveLiveSessionBoards, parseSessionBoardPath } from '../services/live-sessions';
import { liveSessionQueries } from '../graphql/resolvers/sessions/live-sessions';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { sessionQueries } from '../graphql/resolvers/sessions/queries';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';

vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    applyRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

const USER_PREFIX = 'ls-user-';
const VIEWER = `${USER_PREFIX}viewer`;
const FRIEND = `${USER_PREFIX}friend`;
const STRANGER = `${USER_PREFIX}stranger`;
const OTHER_STRANGER = `${USER_PREFIX}stranger-2`;
const BOARD_OWNER = `${USER_PREFIX}board-owner`;
const ALL_USERS = [VIEWER, FRIEND, STRANGER, OTHER_STRANGER, BOARD_OWNER];

const KILTER_PATH = 'kilter/1/10/1,2/40';

let connectionCounter = 0;
let slugCounter = 0;

function authCtx(userId: string, overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: `ls-conn-${connectionCounter++}`,
    transport: 'http',
    userId,
    participantId: userId,
    isAuthenticated: true,
    ...overrides,
  };
}

function anonCtx(): ConnectionContext {
  return { connectionId: `ls-anon-${connectionCounter++}`, transport: 'http', isAuthenticated: false };
}

async function seedUsers(): Promise<void> {
  await db
    .insert(dbSchema.users)
    .values(ALL_USERS.map((id) => ({ id, email: `${id}@test.com`, name: `Account ${id}` })))
    .onConflictDoNothing();
  await db
    .insert(dbSchema.userProfiles)
    .values({ userId: FRIEND, displayName: 'Friend Profile', avatarUrl: 'https://example.com/friend.png' })
    .onConflictDoNothing();
}

async function follow(followerId: string, followingId: string): Promise<void> {
  await db.insert(dbSchema.userFollows).values({ followerId, followingId }).onConflictDoNothing();
}

async function makeBoard(
  options: { ownerId?: string; isPublic?: boolean; name?: string } = {},
): Promise<{ id: number; uuid: string; slug: string; name: string }> {
  const uuid = uuidv4();
  const slug = `ls-board-${Date.now().toString(36)}-${slugCounter++}`;
  const name = options.name ?? `Live Wall ${slugCounter}`;
  const [row] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug,
      ownerId: options.ownerId ?? BOARD_OWNER,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      name,
      isPublic: options.isPublic ?? true,
    })
    .returning({ id: dbSchema.userBoards.id });
  return { id: Number(row.id), uuid, slug, name };
}

async function followBoard(userId: string, boardUuid: string): Promise<void> {
  await db.insert(dbSchema.boardFollows).values({ userId, boardUuid }).onConflictDoNothing();
}

async function makeSession(
  options: {
    createdBy?: string | null;
    boardPath?: string | null;
    isPublic?: boolean;
    status?: string;
    origin?: 'explicit' | 'inferred';
    lastActivity?: Date;
    endedAt?: Date | null;
    boardId?: number | null;
    name?: string;
  } = {},
): Promise<string> {
  const id = uuidv4();
  await db.insert(dbSchema.boardSessions).values({
    id,
    boardPath: options.boardPath === undefined ? KILTER_PATH : options.boardPath,
    createdByUserId: options.createdBy === undefined ? STRANGER : options.createdBy,
    isPublic: options.isPublic ?? true,
    status: options.status ?? 'active',
    origin: options.origin ?? 'explicit',
    lastActivity: options.lastActivity ?? new Date(),
    endedAt: options.endedAt ?? null,
    boardId: options.boardId ?? null,
    name: options.name ?? null,
    startedAt: new Date(),
  });
  return id;
}

/** Connect a climber's phone to the session. Returns the connection id. */
async function goLive(sessionId: string, userId: string | null, boardPath = KILTER_PATH): Promise<string> {
  const connectionId = `ls-live-${connectionCounter++}`;
  await roomManager.registerClient(connectionId, userId ? `Live ${userId}` : undefined, userId ?? undefined);
  await roomManager.joinSession(connectionId, sessionId, boardPath);
  return connectionId;
}

async function addTick(options: {
  sessionId: string;
  userId?: string;
  boardId?: number | null;
  status?: 'flash' | 'send' | 'attempt';
  difficulty?: number | null;
  climbedAt?: Date;
}): Promise<void> {
  const climbedAt = (options.climbedAt ?? new Date()).toISOString();
  await db.insert(dbSchema.boardseshTicks).values({
    uuid: uuidv4(),
    userId: options.userId ?? STRANGER,
    boardType: 'kilter',
    climbUuid: `ls-climb-${uuidv4()}`,
    angle: 40,
    status: options.status ?? 'send',
    difficulty: options.difficulty ?? null,
    climbedAt,
    sessionId: options.sessionId,
    boardId: options.boardId ?? null,
  });
}

let eventSeq = 1;
async function addBoardEvent(sessionId: string, boardId: number, confirmedAt = new Date()): Promise<void> {
  await db.insert(dbSchema.boardClimbEvents).values({
    boardId,
    boardType: 'kilter',
    climbUuid: `ls-climb-${uuidv4()}`,
    angle: 40,
    userId: STRANGER,
    sessionId,
    seq: eventSeq++,
    confirmedAt: confirmedAt.toISOString(),
  });
}

function makeQueueItem(name: string): ClimbQueueItem {
  return {
    uuid: `ls-queue-${uuidv4()}`,
    climb: {
      uuid: `ls-climb-${uuidv4()}`,
      setter_username: 'setter',
      name,
      frames: 'p1r12',
      angle: 40,
      ascensionist_count: 1,
      difficulty: '6c/V5',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0',
      benchmark_difficulty: null,
    },
    addedBy: STRANGER,
    tickedBy: [],
  };
}

async function followedLiveSessions(
  viewerId: string,
  args: { boardUuid?: string | null; limit?: number | null } = {},
): Promise<LiveSession[]> {
  return liveSessionQueries.followedLiveSessions(undefined, args, authCtx(viewerId));
}

const ids = (sessions: LiveSession[]) => sessions.map((session) => session.sessionId);

beforeEach(async () => {
  // board_sessions (and everything referencing it: ticks, events, participants)
  // is truncated by setup.ts; users cascade to follows, boards and board follows.
  await db.delete(dbSchema.users).where(like(dbSchema.users.id, `${USER_PREFIX}%`));
  await seedUsers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSessionBoardPath', () => {
  it('reads board type and angle from a config path, with or without the leading slash', () => {
    expect(parseSessionBoardPath('/kilter/1/10/1,2/40')).toEqual({ slug: null, boardType: 'kilter', angle: 40 });
    expect(parseSessionBoardPath('tension/9/1/8/25')).toEqual({ slug: null, boardType: 'tension', angle: 25 });
  });

  it('reads the slug and angle from a /b/ path', () => {
    expect(parseSessionBoardPath('/b/my-wall/35')).toEqual({ slug: 'my-wall', boardType: null, angle: 35 });
  });
});

describe('followedLiveSessions — social arm', () => {
  it('lists a live session started by someone the viewer follows, with profile identity and stats', async () => {
    await follow(VIEWER, FRIEND);
    const sessionId = await makeSession({ createdBy: FRIEND, name: 'Board night' });
    await goLive(sessionId, FRIEND);
    await addTick({ sessionId, userId: FRIEND, status: 'flash', difficulty: 18 });
    await addTick({ sessionId, userId: FRIEND, status: 'send', difficulty: 20 });
    await addTick({ sessionId, userId: FRIEND, status: 'attempt', difficulty: 26 });
    const current = makeQueueItem('Current Wall Climb');
    await roomManager.updateQueueStateImmediate(sessionId, [current], current);

    const [session, ...rest] = await followedLiveSessions(VIEWER);

    expect(rest).toEqual([]);
    expect(session.sessionId).toBe(sessionId);
    expect(session.name).toBe('Board night');
    expect(session.reasons).toEqual(['FOLLOWING_USER']);
    expect(session.viewerIsMember).toBe(false);
    expect(session.host).toEqual({
      userId: FRIEND,
      displayName: 'Friend Profile',
      avatarUrl: 'https://example.com/friend.png',
    });
    expect(session.participants.map((participant) => participant.userId)).toEqual([FRIEND]);
    expect(session.followedParticipantIds).toEqual([FRIEND]);
    expect(session.participantCount).toBe(1);
    expect(session.boardType).toBe('kilter');
    expect(session.angle).toBe(40);
    expect(session.sendCount).toBe(2);
    expect(session.flashCount).toBe(1);
    expect(session.hardestSendGrade).toBe(getGradeLabel(20));
    expect(session.currentClimb).toEqual({ name: 'Current Wall Climb', grade: '6c/V5' });
    // Redaction: the current climb never says who queued it.
    expect(JSON.stringify(session)).not.toContain(STRANGER);
  });

  it('lists a session a followed climber joined only while they are on the live roster', async () => {
    await follow(VIEWER, FRIEND);
    const sessionId = await makeSession({ createdBy: STRANGER });
    await goLive(sessionId, STRANGER);
    const friendConnection = await goLive(sessionId, FRIEND);

    const whileJoined = await followedLiveSessions(VIEWER);
    expect(ids(whileJoined)).toEqual([sessionId]);
    expect(whileJoined[0].reasons).toEqual(['FOLLOWING_USER']);
    expect(whileJoined[0].followedParticipantIds).toEqual([FRIEND]);
    // Followed climbers first on the card.
    expect(whileJoined[0].participants[0].userId).toBe(FRIEND);

    // The participant row is permanent; leaving must still drop the session.
    await roomManager.leaveSession(friendConnection);
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });

  it('does not list a live session nobody the viewer follows is in', async () => {
    const sessionId = await makeSession({ createdBy: STRANGER });
    await goLive(sessionId, STRANGER);

    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });
});

describe('followedLiveSessions — board arm', () => {
  it('lists a session on a followed board resolved through board_climb_events', async () => {
    const board = await makeBoard({ name: 'Events Wall' });
    await followBoard(VIEWER, board.uuid);
    const sessionId = await makeSession();
    await goLive(sessionId, STRANGER);
    await addBoardEvent(sessionId, board.id);

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.reasons).toEqual(['FOLLOWED_BOARD']);
    expect(session.board).toEqual({
      uuid: board.uuid,
      name: 'Events Wall',
      slug: board.slug,
      boardType: 'kilter',
      gymName: null,
    });
  });

  it('lists a session on a followed board resolved through its ticks', async () => {
    const board = await makeBoard();
    await followBoard(VIEWER, board.uuid);
    const sessionId = await makeSession();
    await goLive(sessionId, STRANGER);
    await addTick({ sessionId, boardId: board.id });

    const sessions = await followedLiveSessions(VIEWER);
    expect(ids(sessions)).toEqual([sessionId]);
    expect(sessions[0].reasons).toEqual(['FOLLOWED_BOARD']);
  });

  it('lists a session on a followed board resolved through a /b/<slug> path', async () => {
    const board = await makeBoard();
    await followBoard(VIEWER, board.uuid);
    const boardPath = `/b/${board.slug}/35`;
    const sessionId = await makeSession({ boardPath });
    await goLive(sessionId, STRANGER, boardPath);

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.reasons).toEqual(['FOLLOWED_BOARD']);
    expect(session.boardType).toBe('kilter');
    expect(session.angle).toBe(35);
  });

  it('lists a session on a followed board resolved only through the live board binding', async () => {
    const board = await makeBoard();
    await followBoard(VIEWER, board.uuid);
    const sessionId = await makeSession();
    await goLive(sessionId, STRANGER);
    await pubsub.commitBoardClimb({
      boardId: String(board.id),
      emitterId: STRANGER,
      climb: { climbUuid: 'ls-bound-climb', sentAt: new Date().toISOString(), seq: 1 },
      climbUuid: 'ls-bound-climb',
      effectiveAngle: 40,
      sessionId,
    });

    const sessions = await followedLiveSessions(VIEWER);
    expect(ids(sessions)).toEqual([sessionId]);
    expect(sessions[0].reasons).toEqual(['FOLLOWED_BOARD']);
  });

  it('lists a session on the selected board with SELECTED_BOARD', async () => {
    const board = await makeBoard();
    const sessionId = await makeSession();
    await goLive(sessionId, STRANGER);
    await addTick({ sessionId, boardId: board.id });

    expect(await followedLiveSessions(VIEWER)).toEqual([]);
    const sessions = await followedLiveSessions(VIEWER, { boardUuid: board.uuid });
    expect(ids(sessions)).toEqual([sessionId]);
    expect(sessions[0].reasons).toEqual(['SELECTED_BOARD']);
  });

  it('resolves events before ticks before the board_id column', async () => {
    const [eventBoard, tickBoard, columnBoard] = [await makeBoard(), await makeBoard(), await makeBoard()];
    const sessionId = await makeSession({ boardId: columnBoard.id });
    await addTick({ sessionId, boardId: tickBoard.id });
    const columnOnly = await makeSession({ boardId: columnBoard.id });

    let resolved = await resolveLiveSessionBoards([
      { id: sessionId, boardId: columnBoard.id, boardPath: KILTER_PATH },
      { id: columnOnly, boardId: columnBoard.id, boardPath: KILTER_PATH },
    ]);
    expect(resolved.get(sessionId)).toBe(tickBoard.id);
    expect(resolved.get(columnOnly)).toBe(columnBoard.id);

    await addBoardEvent(sessionId, eventBoard.id);
    resolved = await resolveLiveSessionBoards([{ id: sessionId, boardId: columnBoard.id, boardPath: KILTER_PATH }]);
    expect(resolved.get(sessionId)).toBe(eventBoard.id);
  });
});

describe('followedLiveSessions — exclusions', () => {
  beforeEach(async () => {
    await follow(VIEWER, FRIEND);
  });

  it('drops ended, inferred and stale (> 4h) sessions even with someone connected', async () => {
    const ended = await makeSession({ createdBy: FRIEND });
    await goLive(ended, FRIEND);
    await db
      .update(dbSchema.boardSessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(dbSchema.boardSessions.id, ended));

    const inferred = await makeSession({ createdBy: FRIEND });
    await goLive(inferred, FRIEND);
    await db.update(dbSchema.boardSessions).set({ origin: 'inferred' }).where(eq(dbSchema.boardSessions.id, inferred));

    const stale = await makeSession({ createdBy: FRIEND });
    await goLive(stale, FRIEND);
    await db
      .update(dbSchema.boardSessions)
      .set({ lastActivity: new Date(Date.now() - 5 * 60 * 60 * 1000) })
      .where(eq(dbSchema.boardSessions.id, stale));

    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });

  it('drops a session nobody is connected to', async () => {
    await makeSession({ createdBy: FRIEND });
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });

  it('keeps a dormant session only while its Redis key survives and it was touched in the last 20 minutes', async () => {
    const recent = await makeSession({ createdBy: FRIEND, lastActivity: new Date(Date.now() - 10 * 60 * 1000) });
    const old = await makeSession({ createdBy: FRIEND, lastActivity: new Date(Date.now() - 30 * 60 * 1000) });
    // Nobody connected, but the Redis session key is still there.
    vi.spyOn(roomManager, 'getSessionLiveness').mockImplementation(
      async (sessionIds) =>
        new Map<string, SessionLiveness>(
          sessionIds.map((sessionId): [string, SessionLiveness] => [
            sessionId,
            { liveConnectionCount: 0, participantCount: 0, redisKeyExists: true, roster: [] },
          ]),
        ),
    );

    const listed = ids(await followedLiveSessions(VIEWER));
    expect(listed).toEqual([recent]);
    expect(listed).not.toContain(old);
  });

  it('hides a private session from a follower who is not in it', async () => {
    const sessionId = await makeSession({ createdBy: FRIEND, isPublic: false });
    await goLive(sessionId, FRIEND);

    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });

  it('hides a private session from a viewer who joined it and left', async () => {
    const sessionId = await makeSession({ createdBy: FRIEND, isPublic: false });
    await goLive(sessionId, FRIEND);
    const viewerConnection = await goLive(sessionId, VIEWER);
    expect(ids(await followedLiveSessions(VIEWER))).toEqual([sessionId]);

    // The participant row survives leaving; only the live roster makes a member.
    await roomManager.leaveSession(viewerConnection);
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });

  it('lists a private session to a viewer on its live roster, as a member, without the current climb', async () => {
    const sessionId = await makeSession({ createdBy: STRANGER, isPublic: false });
    await goLive(sessionId, STRANGER);
    await goLive(sessionId, VIEWER);
    const current = makeQueueItem('Private Climb');
    await roomManager.updateQueueStateImmediate(sessionId, [current], current);

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.viewerIsMember).toBe(true);
    expect(session.isPublic).toBe(false);
    expect(session.reasons).toEqual([]);
    expect(session.currentClimb).toBeNull();
  });
});

describe('followedLiveSessions — board privacy and ordering', () => {
  it('never names a private board the viewer does not own', async () => {
    await follow(VIEWER, FRIEND);
    await follow(BOARD_OWNER, FRIEND);
    const privateBoard = await makeBoard({ isPublic: false, name: 'Secret Garage Wall' });
    const sessionId = await makeSession({ createdBy: FRIEND });
    await goLive(sessionId, FRIEND);
    await addTick({ sessionId, userId: FRIEND, boardId: privateBoard.id });

    const [forViewer] = await followedLiveSessions(VIEWER);
    expect(forViewer.board).toBeNull();
    expect(forViewer.boardType).toBe('kilter');
    expect(JSON.stringify(forViewer)).not.toContain('Secret Garage Wall');
    expect(JSON.stringify(forViewer)).not.toContain(privateBoard.uuid);

    const [forOwner] = await followedLiveSessions(BOARD_OWNER);
    expect(forOwner.board?.name).toBe('Secret Garage Wall');
  });

  it('orders own sessions, then followed climbers, then bigger crews, then most recent — and applies the limit', async () => {
    await follow(VIEWER, FRIEND);
    const board = await makeBoard();
    await followBoard(VIEWER, board.uuid);
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

    const own = await makeSession({ createdBy: VIEWER, lastActivity: minutesAgo(50) });
    await goLive(own, VIEWER);

    const withFriend = await makeSession({ createdBy: FRIEND, lastActivity: minutesAgo(40) });
    await goLive(withFriend, FRIEND);

    const bigCrew = await makeSession({ createdBy: STRANGER, boardId: board.id, lastActivity: minutesAgo(30) });
    await goLive(bigCrew, STRANGER);
    await goLive(bigCrew, OTHER_STRANGER);

    const soloRecent = await makeSession({ createdBy: STRANGER, boardId: board.id, lastActivity: minutesAgo(1) });
    await goLive(soloRecent, STRANGER);

    const soloOlder = await makeSession({ createdBy: STRANGER, boardId: board.id, lastActivity: minutesAgo(10) });
    await goLive(soloOlder, STRANGER);

    const all = await followedLiveSessions(VIEWER);
    expect(ids(all)).toEqual([own, withFriend, bigCrew, soloRecent, soloOlder]);
    expect(all[0].viewerIsMember).toBe(true);
    expect(all[2].participantCount).toBe(2);

    expect(ids(await followedLiveSessions(VIEWER, { limit: 2 }))).toEqual([own, withFriend]);
  });

  it('requires authentication', async () => {
    await expect(liveSessionQueries.followedLiveSessions(undefined, {}, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );
  });
});

describe('boardLiveSessions', () => {
  it('masks a private board from an anonymous caller as NOT_FOUND', async () => {
    const privateBoard = await makeBoard({ isPublic: false });
    await expect(
      liveSessionQueries.boardLiveSessions(undefined, { boardId: privateBoard.id }, anonCtx()),
    ).rejects.toThrow('Board not found');
  });

  it('shows anonymous callers the public sessions on a public board, with no social reasons', async () => {
    await follow(VIEWER, FRIEND);
    const board = await makeBoard();
    const publicSession = await makeSession({ createdBy: FRIEND });
    await goLive(publicSession, FRIEND);
    await addTick({ sessionId: publicSession, userId: FRIEND, boardId: board.id });

    const privateSession = await makeSession({ createdBy: STRANGER, isPublic: false });
    await goLive(privateSession, STRANGER);
    await addTick({ sessionId: privateSession, boardId: board.id });

    const elsewhere = await makeSession({ createdBy: FRIEND });
    await goLive(elsewhere, FRIEND);

    const forAnon = await liveSessionQueries.boardLiveSessions(undefined, { boardId: board.id }, anonCtx());
    expect(ids(forAnon)).toEqual([publicSession]);
    expect(forAnon[0].reasons).toEqual(['SELECTED_BOARD']);
    expect(forAnon[0].followedParticipantIds).toEqual([]);

    const forFollower = await liveSessionQueries.boardLiveSessions(undefined, { boardId: board.id }, authCtx(VIEWER));
    expect(ids(forFollower)).toEqual([publicSession]);
    expect(forFollower[0].reasons).toEqual(['FOLLOWING_USER', 'SELECTED_BOARD']);
  });
});

describe('session privacy switch', () => {
  const readIsPublic = async (sessionId: string) => {
    const [row] = await db
      .select({ isPublic: dbSchema.boardSessions.isPublic })
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, sessionId));
    return row?.isPublic;
  };

  const createInput = (overrides: Record<string, unknown> = {}) => ({
    boardPath: '/kilter/1/10/1,2/40',
    latitude: 0,
    longitude: 0,
    discoverable: false,
    name: 'Quiet sesh',
    ...overrides,
  });

  it('HTTP createSession with isPublic false writes a private row that the creator join cannot flip', async () => {
    const result = await sessionMutations.createSession(
      undefined,
      { input: createInput({ isPublic: false }) },
      authCtx(VIEWER),
    );

    expect(result.isPublic).toBe(false);
    expect(await readIsPublic(result.id)).toBe(false);

    await goLive(result.id, VIEWER, result.boardPath);
    expect(await readIsPublic(result.id)).toBe(false);
  });

  it('HTTP createSession defaults to public and still leaves the row to the WebSocket join', async () => {
    const result = await sessionMutations.createSession(undefined, { input: createInput() }, authCtx(VIEWER));

    expect(result.isPublic).toBe(true);
    expect(await readIsPublic(result.id)).toBeUndefined();

    await goLive(result.id, VIEWER, result.boardPath);
    expect(await readIsPublic(result.id)).toBe(true);
  });

  it('WebSocket createSession with isPublic false creates the row private', async () => {
    const connectionId = `ls-ws-${connectionCounter++}`;
    await roomManager.registerClient(connectionId, 'Viewer', VIEWER);

    const result = await sessionMutations.createSession(
      undefined,
      { input: createInput({ isPublic: false }) },
      authCtx(VIEWER, { connectionId, transport: 'ws' }),
    );

    expect(result.isPublic).toBe(false);
    expect(await readIsPublic(result.id)).toBe(false);
  });

  it('a private session can still be joined by link and read by its members', async () => {
    const result = await sessionMutations.createSession(
      undefined,
      { input: createInput({ isPublic: false }) },
      authCtx(VIEWER),
    );
    await goLive(result.id, VIEWER, result.boardPath);

    await goLive(result.id, STRANGER, result.boardPath);
    const users = await roomManager.getSessionUsers(result.id);
    expect(new Set(users.map((user) => user.userId))).toEqual(new Set([STRANGER, VIEWER]));

    const payload = await sessionQueries.session(undefined, { sessionId: result.id }, authCtx(STRANGER));
    expect(payload?.id).toBe(result.id);
    expect(payload?.isPublic).toBe(false);
  });

  it('updateSession flips visibility for the creator only, and leaves it alone when isPublic is absent or null', async () => {
    const sessionId = await makeSession({ createdBy: VIEWER });

    const madePrivate = await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId, isPublic: false } },
      authCtx(VIEWER),
    );
    expect(madePrivate.isPublic).toBe(false);
    expect(await readIsPublic(sessionId)).toBe(false);

    const renamed = await sessionEditMutations.updateSession(
      undefined,
      { input: { sessionId, name: 'Renamed' } },
      authCtx(VIEWER),
    );
    expect(renamed.isPublic).toBe(false);

    await sessionEditMutations.updateSession(undefined, { input: { sessionId, isPublic: null } }, authCtx(VIEWER));
    expect(await readIsPublic(sessionId)).toBe(false);

    await expect(
      sessionEditMutations.updateSession(undefined, { input: { sessionId, isPublic: true } }, authCtx(STRANGER)),
    ).rejects.toThrow(/Only the session creator/);
    expect(await readIsPublic(sessionId)).toBe(false);

    await sessionEditMutations.updateSession(undefined, { input: { sessionId, isPublic: true } }, authCtx(VIEWER));
    expect(await readIsPublic(sessionId)).toBe(true);
  });

  it('a session made private drops out of its followers’ rail', async () => {
    await follow(VIEWER, FRIEND);
    const sessionId = await makeSession({ createdBy: FRIEND });
    await goLive(sessionId, FRIEND);
    expect(ids(await followedLiveSessions(VIEWER))).toEqual([sessionId]);

    await sessionEditMutations.updateSession(undefined, { input: { sessionId, isPublic: false } }, authCtx(FRIEND));
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });
});
