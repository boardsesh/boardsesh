/**
 * Real-DB coverage for the live-sessions listings (`followedLiveSessions`,
 * `boardLiveSessions`) and the session privacy switch (`isPublic` on
 * createSession / updateSession).
 *
 * The room manager runs for real in its Redis-less single-instance mode, so
 * "live" means a registered connection joined to the session — exactly what a
 * climber's phone does. The one liveness rule that needs Redis (a dormant
 * session whose Redis key survives) is driven through a spy on
 * `roomManager.getSessionConnectionLiveness`.
 *
 * `applyRateLimit` is stubbed to a no-op, matching session-update.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import type { ClimbQueueItem, ConnectionContext, LiveSession } from '@boardsesh/shared-schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import { roomManager, type SessionConnectionLiveness } from '../services/room-manager';
import { resolveLiveSessionBoards, parseSessionBoardPath } from '../services/live-sessions';
import { resolvePublicPreviewSessionForBoard } from '../services/board-queue-preview';
import { liveSessionQueries } from '../graphql/resolvers/sessions/live-sessions';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { sessionQueries } from '../graphql/resolvers/sessions/queries';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { sessionVisibleUserIds } from '../services/board-session-privacy';

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

type BoardOptions = {
  ownerId?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  gymId?: number | null;
  name?: string;
};

async function makeBoard(
  options: BoardOptions & { boardType?: string } = {},
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
      boardType: options.boardType ?? 'kilter',
      layoutId: options.layoutId ?? 1,
      sizeId: options.sizeId ?? (options.boardType === 'spray' ? options.layoutId : undefined) ?? 10,
      setIds: options.setIds ?? (options.boardType === 'spray' ? '1' : '1,2'),
      name,
      isPublic: options.isPublic ?? true,
      isUnlisted: options.isUnlisted ?? false,
      hideLocation: options.hideLocation ?? false,
      hasLeds: options.boardType !== 'spray',
      gymId: options.gymId ?? null,
    })
    .returning({ id: dbSchema.userBoards.id });
  return { id: Number(row.id), uuid, slug, name };
}

/** A spray wall: its `user_boards` row plus the `spray_walls` row the visibility rules read. */
async function makeSprayWall(
  options: BoardOptions & { hidden?: boolean } = {},
): Promise<{ id: number; uuid: string; slug: string; name: string; layoutId: number; path: string }> {
  const layoutId = 900_000 + Math.floor(Math.random() * 90_000);
  const board = await makeBoard({ ...options, boardType: 'spray', layoutId });
  await db.insert(dbSchema.sprayWalls).values({
    boardUuid: board.uuid,
    layoutId,
    hiddenAt: options.hidden ? new Date() : null,
  });
  return { ...board, layoutId, path: `spray/${layoutId}/${layoutId}/1/40` };
}

async function makeGym(name: string, { isPublic = true }: { isPublic?: boolean } = {}): Promise<number> {
  const [row] = await db
    .insert(dbSchema.gyms)
    .values({ uuid: uuidv4(), name, ownerId: BOARD_OWNER, isPublic })
    .returning({ id: dbSchema.gyms.id });
  return Number(row.id);
}

async function followBoard(userId: string, boardUuid: string): Promise<void> {
  await db.insert(dbSchema.boardFollows).values({ userId, boardUuid }).onConflictDoNothing();
}

/** The audience control's write: a policy row, with the legacy booleans projected from it. */
async function chooseBoardAudience(boardUuid: string, audience: 'unlisted' | 'invite_only'): Promise<void> {
  await db
    .insert(dbSchema.resourcePrivacy)
    .values({ kind: 'board', resourceId: boardUuid, ownerId: BOARD_OWNER, audience, locationAudience: 'only_me' });
  await db
    .update(dbSchema.userBoards)
    .set({ isPublic: false, isUnlisted: audience === 'unlisted', hideLocation: true })
    .where(eq(dbSchema.userBoards.uuid, boardUuid));
}

async function approveSessionGuest(sessionId: string, userId: string): Promise<void> {
  await db
    .insert(dbSchema.resourceGrants)
    .values({ kind: 'session', resourceId: sessionId, userId, status: 'approved' });
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
  climbUuid?: string;
  climbedAt?: Date;
}): Promise<void> {
  const climbedAt = (options.climbedAt ?? new Date()).toISOString();
  await db.insert(dbSchema.boardseshTicks).values({
    uuid: uuidv4(),
    userId: options.userId ?? STRANGER,
    boardType: 'kilter',
    climbUuid: options.climbUuid ?? `ls-climb-${uuidv4()}`,
    angle: 40,
    status: options.status ?? 'send',
    difficulty: options.difficulty ?? null,
    climbedAt,
    sessionId: options.sessionId,
    boardId: options.boardId ?? null,
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
  // is truncated by setup.ts; users cascade to follows, boards, gyms and board
  // follows. spray_walls restricts its board's delete, so it goes first.
  await db.delete(dbSchema.sprayWalls).where(
    inArray(
      dbSchema.sprayWalls.boardUuid,
      db
        .select({ uuid: dbSchema.userBoards.uuid })
        .from(dbSchema.userBoards)
        .where(like(dbSchema.userBoards.ownerId, `${USER_PREFIX}%`)),
    ),
  );
  await db.delete(dbSchema.users).where(like(dbSchema.users.id, `${USER_PREFIX}%`));
  await seedUsers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSessionBoardPath', () => {
  it('reads board type and angle from a config path, with or without the leading slash', () => {
    expect(parseSessionBoardPath('/kilter/1/10/2,1/40')).toEqual({
      slug: null,
      config: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
      boardType: 'kilter',
      angle: 40,
    });
    expect(parseSessionBoardPath('tension/9/1/8/25')).toMatchObject({ slug: null, boardType: 'tension', angle: 25 });
  });

  it('reads the slug and angle from a /b/ path', () => {
    expect(parseSessionBoardPath('/b/my-wall/35')).toEqual({
      slug: 'my-wall',
      config: null,
      boardType: null,
      angle: 35,
    });
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
    await db.insert(dbSchema.boardClimbs).values({
      uuid: current.climb.uuid,
      boardType: 'kilter',
      layoutId: 1,
      name: current.climb.name,
      isDraft: false,
      isListed: true,
    });
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

  it("shows a private account's published current climb to everyone, and an unlisted one to its owner", async () => {
    const board = await makeBoard();
    const sessionId = await makeSession({ createdBy: FRIEND, boardId: board.id });
    await goLive(sessionId, FRIEND);
    const current = makeQueueItem('Private project name');
    await db.insert(dbSchema.boardClimbs).values({
      uuid: current.climb.uuid,
      boardType: 'kilter',
      layoutId: 1,
      userId: FRIEND,
      name: current.climb.name,
      isDraft: false,
      isListed: true,
    });
    await roomManager.updateQueueStateImmediate(sessionId, [current], current);
    const sessionsFor = (ctx: ConnectionContext) =>
      liveSessionQueries.boardLiveSessions(undefined, { boardId: board.id }, ctx);

    expect((await sessionsFor(anonCtx()))[0].currentClimb?.name).toBe('Private project name');
    // A published climb is public whoever set it: the setter going private
    // changes nothing about it.
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, FRIEND));
    expect((await sessionsFor(anonCtx()))[0].currentClimb?.name).toBe('Private project name');
    expect((await sessionsFor(authCtx(VIEWER)))[0].currentClimb?.name).toBe('Private project name');
    // Unlisting it takes it off a public projection for everyone but its owner.
    await db
      .update(dbSchema.boardClimbs)
      .set({ isListed: false })
      .where(eq(dbSchema.boardClimbs.uuid, current.climb.uuid));
    expect((await sessionsFor(anonCtx()))[0].currentClimb).toBeNull();
    expect((await sessionsFor(authCtx(VIEWER)))[0].currentClimb).toBeNull();
    expect((await sessionsFor(authCtx(FRIEND)))[0].currentClimb?.name).toBe('Private project name');
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
  it('lists a session on a followed board resolved through its ticks', async () => {
    const board = await makeBoard({ name: 'Ticked Wall' });
    await followBoard(VIEWER, board.uuid);
    const sessionId = await makeSession();
    await goLive(sessionId, STRANGER);
    await addTick({ sessionId, boardId: board.id });

    const sessions = await followedLiveSessions(VIEWER);
    expect(ids(sessions)).toEqual([sessionId]);
    expect(sessions[0].reasons).toEqual(['FOLLOWED_BOARD']);
    expect(sessions[0].board).toEqual({
      uuid: board.uuid,
      name: 'Ticked Wall',
      slug: board.slug,
      boardType: 'kilter',
      gymName: null,
    });
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

  it('resolves the board_id column before a /b/ slug before the binding before the newest tick', async () => {
    const [olderTickBoard, newerTickBoard, columnBoard, slugBoard, boundBoard] = [
      await makeBoard(),
      await makeBoard(),
      await makeBoard(),
      await makeBoard(),
      await makeBoard(),
    ];
    const slugPath = `/b/${slugBoard.slug}/40`;
    // The session's own board decides even when its newest tick is elsewhere:
    // the card and the session it opens must agree on one board.
    const columnTicked = await makeSession({ boardId: columnBoard.id, boardPath: slugPath });
    await addTick({ sessionId: columnTicked, boardId: newerTickBoard.id });
    const slugOnly = await makeSession({ boardPath: slugPath });
    await addTick({ sessionId: slugOnly, boardId: newerTickBoard.id });
    const bound = await makeSession();
    await addTick({ sessionId: bound, boardId: newerTickBoard.id });
    const tickedOnly = await makeSession();
    await addTick({ sessionId: tickedOnly, boardId: olderTickBoard.id, climbedAt: new Date(Date.now() - 60_000) });
    await addTick({ sessionId: tickedOnly, boardId: newerTickBoard.id });
    vi.spyOn(pubsub, 'getSessionBoard').mockImplementation(async (sessionId) =>
      sessionId === bound ? String(boundBoard.id) : null,
    );

    const resolved = await resolveLiveSessionBoards([
      { id: columnTicked, boardId: columnBoard.id, boardPath: slugPath, createdByUserId: STRANGER },
      { id: slugOnly, boardId: null, boardPath: slugPath, createdByUserId: STRANGER },
      { id: bound, boardId: null, boardPath: KILTER_PATH, createdByUserId: STRANGER },
      { id: tickedOnly, boardId: null, boardPath: KILTER_PATH, createdByUserId: STRANGER },
    ]);
    expect(resolved.get(columnTicked)).toBe(columnBoard.id);
    expect(resolved.get(slugOnly)).toBe(slugBoard.id);
    expect(resolved.get(bound)).toBe(boundBoard.id);
    expect(resolved.get(tickedOnly)).toBe(newerTickBoard.id);
  });

  it('leaves a session unplaced when its binding cannot be read, instead of guessing from ticks', async () => {
    const tickBoard = await makeBoard();
    const sessionId = await makeSession();
    await addTick({ sessionId, boardId: tickBoard.id });
    vi.spyOn(pubsub, 'getSessionBoard').mockRejectedValue(new Error('redis down'));

    const resolved = await resolveLiveSessionBoards([
      { id: sessionId, boardId: null, boardPath: KILTER_PATH, createdByUserId: STRANGER },
    ]);
    expect(resolved.has(sessionId)).toBe(false);
  });

  it('shows the card on the same board the session is judged on', async () => {
    const own = await makeBoard({ name: 'Session Wall' });
    const elsewhere = await makeBoard({ name: 'Latest Tick Wall' });
    await followBoard(VIEWER, own.uuid);
    await followBoard(VIEWER, elsewhere.uuid);
    const sessionId = await makeSession({ boardId: own.id });
    await goLive(sessionId, STRANGER);
    await addTick({ sessionId, boardId: elsewhere.id });

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.board?.name).toBe('Session Wall');
  });
});

describe('config-path sessions (personal LED boards)', () => {
  const PROJ_PATH = '/kilter/8/21/3,1,2/40';
  const projBoard = (options: BoardOptions = {}) =>
    makeBoard({ ownerId: FRIEND, layoutId: 8, sizeId: 21, setIds: '1,2,3', ...options });

  it('does not infer the actual wall from an owned or followed matching config', async () => {
    const owned = await projBoard({ name: 'My Wall' });
    const followed = await projBoard({ ownerId: BOARD_OWNER, name: 'Their Wall' });
    await followBoard(FRIEND, followed.uuid);
    await followBoard(VIEWER, owned.uuid);
    const sessionId = await makeSession({ createdBy: FRIEND, boardPath: PROJ_PATH });
    await goLive(sessionId, FRIEND, PROJ_PATH);
    const earlier = await makeSession({ createdBy: FRIEND, status: 'ended' });
    await addTick({ sessionId: earlier, userId: FRIEND, boardId: owned.id });
    const session = { id: sessionId, boardId: null, boardPath: PROJ_PATH, createdByUserId: FRIEND };

    expect((await resolveLiveSessionBoards([session])).has(sessionId)).toBe(false);
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
    // The creator's send filed under their own board of this config names the
    // config they hold, not the wall: saveTick files config-path sends there.
    await addTick({ sessionId, userId: FRIEND, boardId: owned.id });
    expect((await resolveLiveSessionBoards([session])).has(sessionId)).toBe(false);
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
    // Another climber's send on that board does place it.
    await addTick({ sessionId, userId: STRANGER, boardId: owned.id });
    expect((await resolveLiveSessionBoards([session])).get(sessionId)).toBe(owned.id);
    expect((await followedLiveSessions(VIEWER))[0].board?.uuid).toBe(owned.uuid);
  });

  it('excludes newer config-only false positives before the board candidate cap', async () => {
    const board = await projBoard({ name: 'Actually bound wall' });
    await followBoard(VIEWER, board.uuid);
    const bound = await makeSession({ createdBy: FRIEND, boardId: board.id, boardPath: PROJ_PATH });
    await goLive(bound, FRIEND, PROJ_PATH);
    await db
      .update(dbSchema.boardSessions)
      .set({ lastActivity: new Date(Date.now() - 10 * 60_000) })
      .where(eq(dbSchema.boardSessions.id, bound));
    await db.insert(dbSchema.boardSessions).values(
      Array.from({ length: 55 }, () => ({
        id: uuidv4(),
        createdByUserId: FRIEND,
        boardPath: PROJ_PATH,
        isPublic: true,
        status: 'active',
        lastActivity: new Date(),
        startedAt: new Date(),
      })),
    );
    expect(ids(await followedLiveSessions(VIEWER))).toEqual([bound]);
    expect(ids(await liveSessionQueries.boardLiveSessions(undefined, { boardId: board.id }, authCtx(VIEWER)))).toEqual([
      bound,
    ]);
  });

  it.each(['primary', 'named-path', 'binding', 'latest-tick'] as const)(
    'excludes historical wall matches behind stronger %s evidence before the candidate cap',
    async (evidence) => {
      const selected = await projBoard({ ownerId: BOARD_OWNER });
      const elsewhere = await projBoard({ ownerId: OTHER_STRANGER });
      const actual = await makeSession({ boardId: selected.id, boardPath: PROJ_PATH });
      await goLive(actual, STRANGER, PROJ_PATH);
      const staleIds = Array.from({ length: 55 }, () => `zz-stale-${uuidv4()}`);
      const stale = new Set(staleIds);
      await db.insert(dbSchema.boardSessions).values(
        staleIds.map((id) => ({
          id,
          createdByUserId: STRANGER,
          boardId: evidence === 'primary' ? elsewhere.id : null,
          boardPath: evidence === 'named-path' ? `/b/${elsewhere.slug}/40` : PROJ_PATH,
          isPublic: true,
          status: 'active',
        })),
      );
      await db.insert(dbSchema.boardseshTicks).values(
        staleIds.flatMap((sessionId) => [
          {
            uuid: uuidv4(),
            userId: STRANGER,
            boardType: 'kilter',
            climbUuid: `ls-climb-${uuidv4()}`,
            angle: 40,
            status: 'send' as const,
            climbedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            sessionId,
            boardId: selected.id,
          },
          ...(evidence === 'latest-tick'
            ? [
                {
                  uuid: uuidv4(),
                  userId: STRANGER,
                  boardType: 'kilter',
                  climbUuid: `ls-climb-${uuidv4()}`,
                  angle: 40,
                  status: 'send' as const,
                  climbedAt: new Date().toISOString(),
                  sessionId,
                  boardId: elsewhere.id,
                },
              ]
            : []),
        ]),
      );
      if (evidence === 'binding') {
        vi.spyOn(pubsub, 'getSessionBoard').mockImplementation(async (sessionId) =>
          stale.has(sessionId) ? String(elsewhere.id) : null,
        );
      }
      vi.spyOn(roomManager, 'getSessionConnectionLiveness').mockImplementation(
        async (sessionIds) =>
          new Map(sessionIds.map((sessionId) => [sessionId, { liveConnectionCount: 1, redisKeyExists: true }])),
      );
      // All rows tie at sub-millisecond precision. The stale IDs sort first;
      // an imprecise timestamp cursor would skip the real session on page two.
      await db
        .update(dbSchema.boardSessions)
        .set({
          lastActivity: sql`${new Date(Date.now() - 10 * 60_000).toISOString()}::timestamp + interval '123 microseconds'`,
        })
        .where(inArray(dbSchema.boardSessions.id, [...staleIds, actual]));
      expect(ids(await followedLiveSessions(VIEWER, { boardUuid: selected.uuid }))).toEqual([actual]);
      expect(
        ids(await liveSessionQueries.boardLiveSessions(undefined, { boardId: selected.id }, authCtx(VIEWER))),
      ).toEqual([actual]);
    },
  );

  it('keeps the exact social arm when a followed climber moved to another board', async () => {
    const selected = await projBoard({ ownerId: BOARD_OWNER });
    const elsewhere = await projBoard({ ownerId: FRIEND });
    await follow(VIEWER, FRIEND);
    const sessionId = await makeSession({ createdBy: FRIEND, boardId: elsewhere.id, boardPath: PROJ_PATH });
    await goLive(sessionId, FRIEND, PROJ_PATH);
    await addTick({ sessionId, userId: FRIEND, boardId: selected.id });
    const sessions = await followedLiveSessions(VIEWER, { boardUuid: selected.uuid });
    expect(ids(sessions)).toEqual([sessionId]);
    expect(sessions[0].reasons).toContain('FOLLOWING_USER');
    expect(sessions[0].reasons).not.toContain('SELECTED_BOARD');
    expect(await liveSessionQueries.boardLiveSessions(undefined, { boardId: selected.id }, authCtx(VIEWER))).toEqual(
      [],
    );
  });

  it('shows the followed climber without a guessed board when the actual wall is unidentified', async () => {
    await projBoard({ name: 'Same Config Garage' });
    await follow(VIEWER, FRIEND);
    const sessionId = await makeSession({ createdBy: FRIEND, boardPath: PROJ_PATH });
    await goLive(sessionId, FRIEND, PROJ_PATH);
    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.host?.userId).toBe(FRIEND);
    expect(session.board).toBeNull();
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
    vi.spyOn(roomManager, 'getSessionConnectionLiveness').mockImplementation(
      async (sessionIds) =>
        new Map<string, SessionConnectionLiveness>(
          sessionIds.map((sessionId): [string, SessionConnectionLiveness] => [
            sessionId,
            { liveConnectionCount: 0, redisKeyExists: true },
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

  it('keeps an approved follower’s private session visible after leaving until access is revoked', async () => {
    const sessionId = await makeSession({ createdBy: FRIEND, isPublic: false });
    await goLive(sessionId, FRIEND);
    await approveSessionGuest(sessionId, VIEWER);
    const viewerConnection = await goLive(sessionId, VIEWER);
    expect(ids(await followedLiveSessions(VIEWER))).toEqual([sessionId]);

    // Leaving clears live membership, but the host's approval still permits discovery.
    await roomManager.leaveSession(viewerConnection);
    expect(await followedLiveSessions(VIEWER)).toEqual([
      expect.objectContaining({ sessionId, viewerIsMember: false, reasons: ['FOLLOWING_USER'] }),
    ]);

    // Explicit revocation takes precedence over the durable participant row.
    await db
      .update(dbSchema.resourceGrants)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(dbSchema.resourceGrants.kind, 'session'),
          eq(dbSchema.resourceGrants.resourceId, sessionId),
          eq(dbSchema.resourceGrants.userId, VIEWER),
        ),
      );
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
  });

  it('lists a private session to a viewer on its live roster, as a member, without the current climb', async () => {
    const sessionId = await makeSession({ createdBy: STRANGER, isPublic: false });
    await goLive(sessionId, STRANGER);
    await approveSessionGuest(sessionId, VIEWER);
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

  it('names an unlisted board only to viewers who already hold it', async () => {
    await follow(VIEWER, FRIEND);
    const unlisted = await makeBoard({ isUnlisted: true, name: 'Link Only Wall' });
    const sessionId = await makeSession({ createdBy: FRIEND });
    await goLive(sessionId, FRIEND);
    await addTick({ sessionId, userId: FRIEND, boardId: unlisted.id });

    // Follows the climber, not the board: the board is not theirs to discover.
    const [forFollower] = await followedLiveSessions(VIEWER);
    expect(forFollower.reasons).toEqual(['FOLLOWING_USER']);
    expect(forFollower.board).toBeNull();
    expect(JSON.stringify(forFollower)).not.toContain('Link Only Wall');
    expect(JSON.stringify(forFollower)).not.toContain(unlisted.uuid);

    // Selected it by uuid: already holds it.
    const [selected] = await followedLiveSessions(VIEWER, { boardUuid: unlisted.uuid });
    expect(selected.reasons).toEqual(['FOLLOWING_USER', 'SELECTED_BOARD']);
    expect(selected.board?.name).toBe('Link Only Wall');

    // Follows the board: already holds it.
    await followBoard(OTHER_STRANGER, unlisted.uuid);
    const [boardFollower] = await followedLiveSessions(OTHER_STRANGER);
    expect(boardFollower.reasons).toEqual(['FOLLOWED_BOARD']);
    expect(boardFollower.board?.name).toBe('Link Only Wall');

    // An enumerable numeric ID is not an unlisted-link capability.
    await expect(liveSessionQueries.boardLiveSessions(undefined, { boardId: unlisted.id }, anonCtx())).rejects.toThrow(
      'Board not found',
    );
    const [onSheet] = await liveSessionQueries.boardLiveSessions(
      undefined,
      { boardId: unlisted.id },
      authCtx(BOARD_OWNER),
    );
    expect(onSheet.board?.name).toBe('Link Only Wall');
  });

  it('keeps the followed session visible while a revoked board grant hides its identity', async () => {
    await follow(VIEWER, FRIEND);
    const board = await makeBoard({ name: 'Revoked Board Identity' });
    const sessionId = await makeSession({ createdBy: FRIEND, boardId: board.id });
    await goLive(sessionId, FRIEND);
    await db.insert(dbSchema.resourceGrants).values({
      kind: 'board',
      resourceId: board.uuid,
      userId: VIEWER,
      status: 'revoked',
    });

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.host?.userId).toBe(FRIEND);
    expect(session.board).toBeNull();
    expect(JSON.stringify(session)).not.toContain(board.uuid);
    expect(JSON.stringify(session)).not.toContain(board.name);
    expect(JSON.stringify(session)).not.toContain(board.slug);
  });

  it('uses the board audience override before its legacy public flag on live cards', async () => {
    await follow(VIEWER, FRIEND);
    const board = await makeBoard({ isPublic: false });
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'board',
      resourceId: board.uuid,
      ownerId: BOARD_OWNER,
      audience: 'public',
    });
    const sessionId = await makeSession({ createdBy: FRIEND, boardId: board.id });
    await goLive(sessionId, FRIEND);

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.board?.uuid).toBe(board.uuid);
  });

  it.each([
    ['legacy booleans', false],
    ['current audience control', true],
  ] as const)(
    'names an unlisted board (%s) on its own sheet only for a caller holding its uuid',
    async (_shape, viaAudienceControl) => {
      const unlisted = await makeBoard({ isUnlisted: true, name: 'Link Sheet Wall' });
      if (viaAudienceControl) await chooseBoardAudience(unlisted.uuid, 'unlisted');
      const sessionId = await makeSession({ createdBy: FRIEND, boardId: unlisted.id });
      await goLive(sessionId, FRIEND);

      // The numeric id alone is countable: no sheet, and nothing on it names the board.
      for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
        await expect(liveSessionQueries.boardLiveSessions(undefined, { boardId: unlisted.id }, ctx)).rejects.toThrow(
          'Board not found',
        );
      }

      // The uuid is the link: the sheet opens and names its board.
      for (const ctx of [anonCtx(), authCtx(STRANGER)]) {
        const [onSheet] = await liveSessionQueries.boardLiveSessions(
          undefined,
          { boardId: unlisted.id, boardUuid: unlisted.uuid },
          ctx,
        );
        expect(onSheet.sessionId).toBe(sessionId);
        expect(onSheet.board?.name).toBe('Link Sheet Wall');
        expect(onSheet.board?.slug).toBe(unlisted.slug);
      }

      // The owner holds it already, so the id alone names it for them.
      const [forOwner] = await liveSessionQueries.boardLiveSessions(
        undefined,
        { boardId: unlisted.id },
        authCtx(BOARD_OWNER),
      );
      expect(forOwner.board?.uuid).toBe(unlisted.uuid);
    },
  );

  it("keeps the board's slug path in joinSession for a stranger who started a session from its link", async () => {
    const unlisted = await makeBoard({ isUnlisted: true, name: 'Link Join Wall' });
    await chooseBoardAudience(unlisted.uuid, 'unlisted');
    const boardPath = `/b/${unlisted.slug}/40`;
    const connectionId = `ls-ws-${connectionCounter++}`;
    await roomManager.registerClient(connectionId, 'Stranger', STRANGER);
    const wsCtx = authCtx(STRANGER, { connectionId, transport: 'ws' });

    const created = await sessionMutations.createSession(
      undefined,
      { input: { boardPath, latitude: 0, longitude: 0, discoverable: false } },
      wsCtx,
    );
    const joined = await sessionMutations.joinSession(undefined, { sessionId: created.id, boardPath }, wsCtx);
    expect(joined.boardPath.startsWith(`/b/${unlisted.slug}`)).toBe(true);

    // Somebody who only holds the session invite gets the board's geometry, not its slug.
    const preview = await sessionQueries.session(undefined, { sessionId: created.id }, authCtx(OTHER_STRANGER));
    expect(preview?.boardPath).not.toContain(unlisted.slug);
    expect(preview?.boardPath.startsWith('/kilter/1/10/')).toBe(true);
  });

  it("hides a private gym's name behind hideLocation from everyone but the board owner; a public gym's shows", async () => {
    await follow(VIEWER, FRIEND);
    await follow(BOARD_OWNER, FRIEND);
    const gymId = await makeGym('Crag Cave Gym');
    const homeGymId = await makeGym('Back Shed', { isPublic: false });
    const privateLocation = await makeBoard({ gymId: homeGymId, hideLocation: true, name: 'Quiet Location Wall' });
    // A public gym lists its own name to everyone, so a hidden board there shows
    // the gym (projectBoardLocation), never anything of its own.
    const hiddenAtPublicGym = await makeBoard({ gymId, hideLocation: true, name: 'Hidden Gym Wall' });
    const openLocation = await makeBoard({ gymId, name: 'Open Location Wall' });

    for (const board of [privateLocation, hiddenAtPublicGym, openLocation]) {
      const sessionId = await makeSession({ createdBy: FRIEND });
      await goLive(sessionId, FRIEND);
      await addTick({ sessionId, userId: FRIEND, boardId: board.id });
    }

    const gymNameByBoard = (sessions: LiveSession[]) =>
      new Map(sessions.map((session) => [session.board?.name, session.board?.gymName]));

    const forViewer = gymNameByBoard(await followedLiveSessions(VIEWER));
    expect(forViewer.get('Quiet Location Wall')).toBeNull();
    expect(forViewer.get('Hidden Gym Wall')).toBe('Crag Cave Gym');
    expect(forViewer.get('Open Location Wall')).toBe('Crag Cave Gym');

    const forOwner = gymNameByBoard(await followedLiveSessions(BOARD_OWNER));
    expect(forOwner.get('Quiet Location Wall')).toBe('Back Shed');
  });

  it('keeps followed climbers’ old participant rows from crowding the candidate cap', async () => {
    await follow(VIEWER, FRIEND);
    // More sessions than the cap, all newer than the friend's own session, each
    // holding a participant row the friend wrote five hours ago and never
    // removed (rows are permanent).
    const crowdIds = Array.from({ length: 55 }, () => uuidv4());
    await db.insert(dbSchema.boardSessions).values(
      crowdIds.map((id) => ({
        id,
        boardPath: KILTER_PATH,
        createdByUserId: STRANGER,
        lastActivity: new Date(),
        startedAt: new Date(),
      })),
    );
    await db.insert(dbSchema.boardSessionParticipants).values(
      crowdIds.map((sessionId) => ({
        sessionId,
        userId: FRIEND,
        joinedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      })),
    );

    const friendSession = await makeSession({ createdBy: FRIEND, lastActivity: new Date(Date.now() - 10 * 60 * 1000) });
    await goLive(friendSession, FRIEND);

    expect(ids(await followedLiveSessions(VIEWER))).toEqual([friendSession]);
  });

  it('keeps the viewer’s old private memberships from crowding the candidate cap', async () => {
    await follow(VIEWER, FRIEND);
    // Private sessions the viewer joined five hours ago, all newer than the
    // friend's public session: the visibility arm must not give them slots.
    const crowdIds = Array.from({ length: 55 }, () => uuidv4());
    await db.insert(dbSchema.boardSessions).values(
      crowdIds.map((id) => ({
        id,
        boardPath: KILTER_PATH,
        createdByUserId: STRANGER,
        isPublic: false,
        lastActivity: new Date(),
        startedAt: new Date(),
      })),
    );
    await db.insert(dbSchema.boardSessionParticipants).values(
      crowdIds.map((sessionId) => ({
        sessionId,
        userId: VIEWER,
        joinedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      })),
    );

    const friendSession = await makeSession({ createdBy: FRIEND, lastActivity: new Date(Date.now() - 10 * 60 * 1000) });
    await goLive(friendSession, FRIEND);

    expect(ids(await followedLiveSessions(VIEWER))).toEqual([friendSession]);
  });

  it('names the hardest send with the board’s own grade, from the consensus grade when the tick has none', async () => {
    await follow(VIEWER, FRIEND);
    const consensusClimb = `ls-climb-${uuidv4()}`;
    await db
      .insert(dbSchema.boardDifficultyGrades)
      .values({ boardType: 'kilter', difficulty: 22, boulderName: 'Board Grade Twenty-Two' })
      .onConflictDoNothing();
    await db
      .insert(dbSchema.boardClimbStats)
      .values({ boardType: 'kilter', climbUuid: consensusClimb, angle: 40, displayDifficulty: 22.2 });

    try {
      const sessionId = await makeSession({ createdBy: FRIEND });
      await goLive(sessionId, FRIEND);
      await addTick({ sessionId, userId: FRIEND, status: 'send', difficulty: 18 });
      await addTick({ sessionId, userId: FRIEND, status: 'send', difficulty: null, climbUuid: consensusClimb });

      const [session] = await followedLiveSessions(VIEWER);
      expect(session.hardestSendGrade).toBe('Board Grade Twenty-Two');
    } finally {
      await db.delete(dbSchema.boardClimbStats).where(eq(dbSchema.boardClimbStats.climbUuid, consensusClimb));
    }
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

describe('followedLiveSessions — spray walls', () => {
  it('lists a concrete spray path without a tick, primary board or live board binding', async () => {
    const wall = await makeSprayWall({ name: 'Path-only Spray Wall' });
    vi.spyOn(pubsub, 'getBoardSession').mockResolvedValue(null);
    vi.spyOn(pubsub, 'getSessionBoard').mockResolvedValue(null);
    await followBoard(VIEWER, wall.uuid);
    const sessionId = await makeSession({ boardPath: wall.path });
    await goLive(sessionId, STRANGER, wall.path);
    expect(
      await resolveLiveSessionBoards([
        { id: sessionId, createdByUserId: STRANGER, boardId: null, boardPath: wall.path },
      ]),
    ).toEqual(new Map([[sessionId, wall.id]]));

    const [followed] = await followedLiveSessions(VIEWER);
    expect(followed).toMatchObject({ sessionId, reasons: ['FOLLOWED_BOARD'], board: { name: wall.name } });
    const [onBoard] = await liveSessionQueries.boardLiveSessions(undefined, { boardId: wall.id }, authCtx(VIEWER));
    expect(onBoard).toMatchObject({ sessionId, reasons: ['SELECTED_BOARD'], board: { name: wall.name } });
  });

  it('lists a session on a followed public spray wall without the climb on the wall', async () => {
    const wall = await makeSprayWall({ name: 'Garage Spray Wall' });
    await followBoard(VIEWER, wall.uuid);
    const sessionId = await makeSession({ boardPath: wall.path });
    await goLive(sessionId, STRANGER, wall.path);
    await addTick({ sessionId, boardId: wall.id });
    const current = makeQueueItem('Secret Spray Problem');
    await roomManager.updateQueueStateImmediate(sessionId, [current], current);

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.reasons).toEqual(['FOLLOWED_BOARD']);
    expect(session.board?.name).toBe('Garage Spray Wall');
    expect(session.boardType).toBe('spray');
    expect(session.currentClimb).toBeNull();
    expect(JSON.stringify(session)).not.toContain('Secret Spray Problem');
  });

  it('stops listing a followed spray wall once it goes private or is hidden, except to its owner', async () => {
    const wall = await makeSprayWall({ name: 'Shed Spray Wall' });
    await followBoard(VIEWER, wall.uuid);
    await followBoard(BOARD_OWNER, wall.uuid);
    const sessionId = await makeSession({ boardPath: wall.path });
    await goLive(sessionId, STRANGER, wall.path);
    await addTick({ sessionId, boardId: wall.id });
    expect(ids(await followedLiveSessions(VIEWER))).toEqual([sessionId]);

    await db.update(dbSchema.userBoards).set({ isPublic: false }).where(eq(dbSchema.userBoards.id, wall.id));
    expect(await followedLiveSessions(VIEWER)).toEqual([]);

    await db.update(dbSchema.userBoards).set({ isPublic: true }).where(eq(dbSchema.userBoards.id, wall.id));
    await db
      .update(dbSchema.sprayWalls)
      .set({ hiddenAt: new Date() })
      .where(eq(dbSchema.sprayWalls.boardUuid, wall.uuid));
    expect(await followedLiveSessions(VIEWER)).toEqual([]);

    const [forOwner] = await followedLiveSessions(BOARD_OWNER);
    expect(forOwner.sessionId).toBe(sessionId);
    expect(forOwner.board?.name).toBe('Shed Spray Wall');
  });

  it('refuses an admin-hidden spray wall as the selected board, even an unlisted one', async () => {
    const wall = await makeSprayWall({ isUnlisted: true });
    const sessionId = await makeSession({ boardPath: wall.path });
    await goLive(sessionId, BOARD_OWNER, wall.path);
    await addTick({ sessionId, boardId: wall.id });
    await db
      .update(dbSchema.sprayWalls)
      .set({ hiddenAt: new Date() })
      .where(eq(dbSchema.sprayWalls.boardUuid, wall.uuid));

    expect(await followedLiveSessions(VIEWER, { boardUuid: wall.uuid })).toEqual([]);
  });

  it('lists a followed climber’s session on a hidden spray wall without naming the wall', async () => {
    await follow(VIEWER, FRIEND);
    const wall = await makeSprayWall({ name: 'Hidden Spray Wall' });
    const sessionId = await makeSession({ createdBy: FRIEND, boardPath: wall.path });
    await goLive(sessionId, FRIEND, wall.path);
    await addTick({ sessionId, userId: FRIEND, boardId: wall.id });
    const current = makeQueueItem('Hidden Spray Problem');
    await roomManager.updateQueueStateImmediate(sessionId, [current], current);
    await db
      .update(dbSchema.sprayWalls)
      .set({ hiddenAt: new Date() })
      .where(eq(dbSchema.sprayWalls.boardUuid, wall.uuid));

    // The session follows its host; the hidden wall only loses its name.
    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.reasons).toEqual(['FOLLOWING_USER']);
    expect(session.board).toBeNull();
    expect(session.currentClimb).toBeNull();
    expect(JSON.stringify(session)).not.toContain('Hidden Spray Wall');
    expect(JSON.stringify(session)).not.toContain(wall.uuid);
    expect(JSON.stringify(session)).not.toContain('Hidden Spray Problem');
  });
});

describe('followedLiveSessions — staying anonymous on boards they don’t own', () => {
  const stayAnonymous = (userId: string) =>
    db
      .update(dbSchema.userProfiles)
      .set({ anonymousOnForeignBoards: true })
      .where(eq(dbSchema.userProfiles.userId, userId));
  const boardLiveSessionsFor = (boardId: number, ctx: ConnectionContext) =>
    liveSessionQueries.boardLiveSessions(undefined, { boardId }, ctx);

  it('keeps a followed climber anonymous on a board they don’t own: the preference beats the follow', async () => {
    await follow(VIEWER, FRIEND);
    await stayAnonymous(FRIEND);
    const gymWall = await makeBoard({ name: 'Gym Wall' });
    const sessionId = await makeSession({ createdBy: FRIEND, boardId: gymWall.id });
    await goLive(sessionId, FRIEND);

    // Following them is no reason to list it: that alone would say where they are.
    expect(await followedLiveSessions(VIEWER)).toEqual([]);

    // Listed for the board instead, they still count, without a name.
    await followBoard(VIEWER, gymWall.uuid);
    const [session, ...rest] = await followedLiveSessions(VIEWER);
    expect(rest).toEqual([]);
    expect(session.sessionId).toBe(sessionId);
    expect(session.reasons).toEqual(['FOLLOWED_BOARD']);
    expect(session.host).toBeNull();
    expect(session.participants).toEqual([]);
    expect(session.followedParticipantIds).toEqual([]);
    expect(session.participantCount).toBe(1);
    expect(JSON.stringify(session)).not.toContain(FRIEND);
    expect(JSON.stringify(session)).not.toContain('Friend Profile');

    // The same for a viewer who doesn't follow them, and on the board's own list.
    const [forStranger] = await boardLiveSessionsFor(gymWall.id, authCtx(OTHER_STRANGER));
    expect(forStranger.host).toBeNull();
    expect(forStranger.participants).toEqual([]);
    const [forFollower] = await boardLiveSessionsFor(gymWall.id, authCtx(VIEWER));
    expect(forFollower.reasons).toEqual(['SELECTED_BOARD']);
    expect(forFollower.host).toBeNull();

    // They see their own name.
    const [own] = await followedLiveSessions(FRIEND);
    expect(own.host?.userId).toBe(FRIEND);
    expect(own.participants.map((participant) => participant.userId)).toEqual([FRIEND]);
  });

  it('keeps them anonymous on Climbing now to a viewer who joined their session (#6582)', async () => {
    await stayAnonymous(FRIEND);
    const gymWall = await makeBoard({ name: 'Gym Wall' });
    const sessionId = await makeSession({ createdBy: FRIEND, boardId: gymWall.id });
    await goLive(sessionId, FRIEND);
    await goLive(sessionId, VIEWER);
    // A fellow member: the session itself names them to the viewer…
    expect(await sessionVisibleUserIds([FRIEND], VIEWER, sessionId)).toEqual(new Set([FRIEND]));
    // …while the rail, a listing, does not.
    const [card] = await boardLiveSessionsFor(gymWall.id, authCtx(VIEWER));
    expect(card.sessionId).toBe(sessionId);
    expect(card.host).toBeNull();
    expect(card.participants.map((participant) => participant.userId)).not.toContain(FRIEND);
    expect(JSON.stringify(card)).not.toContain(FRIEND);
    expect(JSON.stringify(card)).not.toContain('Friend Profile');
  });

  it('names them on their own board, even with another climber’s wall attached to the session', async () => {
    await follow(VIEWER, FRIEND);
    await stayAnonymous(FRIEND);
    const garage = await makeBoard({ ownerId: FRIEND, name: 'Friend Garage' });
    const gymWall = await makeBoard({ name: 'Gym Wall' });
    const sessionId = await makeSession({ createdBy: FRIEND, boardId: garage.id });
    await db.insert(dbSchema.sessionBoards).values({ sessionId, boardId: gymWall.id });
    await goLive(sessionId, FRIEND);
    // Owning the session's board names them only after their own action on it
    // in this session: any member can move a session onto someone's board.
    expect(await followedLiveSessions(VIEWER)).toEqual([]);
    await addTick({ sessionId, userId: FRIEND, boardId: garage.id });

    const [session] = await followedLiveSessions(VIEWER);
    expect(session.sessionId).toBe(sessionId);
    expect(session.reasons).toEqual(['FOLLOWING_USER']);
    expect(session.host?.userId).toBe(FRIEND);
    expect(session.followedParticipantIds).toEqual([FRIEND]);
    const [forStranger] = await boardLiveSessionsFor(garage.id, authCtx(OTHER_STRANGER));
    expect(forStranger.host?.userId).toBe(FRIEND);
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

  it('HTTP createSession fails outright when the private pre-insert fails, so no join can create it public', async () => {
    // A creator id with no users row makes the insert hit the created_by_user_id
    // foreign key: a real database failure, not a mock.
    const ghostCtx = authCtx(`${USER_PREFIX}ghost`);
    const sessionsBefore = await db.select({ id: dbSchema.boardSessions.id }).from(dbSchema.boardSessions);

    await expect(
      sessionMutations.createSession(
        undefined,
        { input: createInput({ isPublic: false, name: 'Ghost sesh' }) },
        ghostCtx,
      ),
    ).rejects.toThrow();

    const sessionsAfter = await db.select({ id: dbSchema.boardSessions.id }).from(dbSchema.boardSessions);
    expect(sessionsAfter).toHaveLength(sessionsBefore.length);
  });

  it('HTTP createSession persists its public policy before the WebSocket join', async () => {
    const result = await sessionMutations.createSession(undefined, { input: createInput() }, authCtx(VIEWER));

    expect(result.isPublic).toBe(true);
    expect(await readIsPublic(result.id)).toBe(true);

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

  it('keeps a legacy private session off the listings while its link still joins and reads', async () => {
    const board = await makeBoard({ ownerId: VIEWER, name: 'Legacy Private Wall' });
    await follow(STRANGER, VIEWER);
    await followBoard(STRANGER, board.uuid);
    const result = await sessionMutations.createSession(
      undefined,
      { input: createInput({ isPublic: false }) },
      authCtx(VIEWER),
    );
    await db.update(dbSchema.boardSessions).set({ boardId: board.id }).where(eq(dbSchema.boardSessions.id, result.id));
    await goLive(result.id, VIEWER, result.boardPath);
    await addTick({ sessionId: result.id, userId: VIEWER, boardId: board.id });

    // No policy row: the legacy switch reads as unlisted, not invite-only.
    const policies = await db
      .select()
      .from(dbSchema.resourcePrivacy)
      .where(eq(dbSchema.resourcePrivacy.resourceId, result.id));
    expect(policies).toEqual([]);

    // Not listed: Home's rail, the board sheet and the wall kiosk all skip it.
    expect(ids(await followedLiveSessions(STRANGER))).not.toContain(result.id);
    expect(
      ids(await liveSessionQueries.boardLiveSessions(undefined, { boardId: board.id }, authCtx(STRANGER))),
    ).not.toContain(result.id);
    expect(await resolvePublicPreviewSessionForBoard(board.id)).toBeNull();

    // The link still reads and joins, with no host approval.
    const preview = await sessionQueries.session(undefined, { sessionId: result.id }, authCtx(STRANGER));
    expect(preview?.id).toBe(result.id);
    expect(preview?.isPublic).toBe(false);
    await goLive(result.id, STRANGER, result.boardPath);
    const users = await roomManager.getSessionUsers(result.id);
    expect(new Set(users.map((user) => user.userId))).toEqual(new Set([STRANGER, VIEWER]));
    // Once on the roster, the joiner sees it on their own rail.
    expect(ids(await followedLiveSessions(STRANGER))).toContain(result.id);
  });

  it('requires host approval before an invite-only link permits joining or reading', async () => {
    const result = await sessionMutations.createSession(
      undefined,
      { input: createInput({ isPublic: false, audience: 'invite_only' }) },
      authCtx(VIEWER),
    );
    await goLive(result.id, VIEWER, result.boardPath);
    expect(await sessionQueries.session(undefined, { sessionId: result.id }, authCtx(STRANGER))).toBeNull();
    await expect(goLive(result.id, STRANGER, result.boardPath)).rejects.toThrow('Not found');
    await approveSessionGuest(result.id, STRANGER);
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

  it('does not touch lastActivity for a visibility-only edit, so a dormant session is not re-advertised', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const sessionId = await makeSession({ createdBy: VIEWER, lastActivity: hourAgo });
    const readLastActivity = async () => {
      const [row] = await db
        .select({ lastActivity: dbSchema.boardSessions.lastActivity })
        .from(dbSchema.boardSessions)
        .where(eq(dbSchema.boardSessions.id, sessionId));
      return row.lastActivity.getTime();
    };

    await sessionEditMutations.updateSession(undefined, { input: { sessionId, isPublic: false } }, authCtx(VIEWER));
    expect(await readLastActivity()).toBe(hourAgo.getTime());

    await sessionEditMutations.updateSession(undefined, { input: { sessionId, name: 'Renamed' } }, authCtx(VIEWER));
    expect(await readLastActivity()).toBeGreaterThan(hourAgo.getTime());
  });

  it('clears and re-seeds a kiosk that shows the session through the durable board_id fallback', async () => {
    const board = await makeBoard();
    const sessionId = await makeSession({ createdBy: VIEWER, boardId: board.id });
    const current = makeQueueItem('Kiosk Climb');
    await db.insert(dbSchema.boardClimbs).values({
      uuid: current.climb.uuid,
      boardType: 'kilter',
      layoutId: 1,
      name: current.climb.name,
      frames: current.climb.frames,
      isDraft: false,
      isListed: true,
    });
    await roomManager.updateQueueStateImmediate(sessionId, [current], current);
    const publishSpy = vi.spyOn(pubsub, 'publishBoardQueuePreview').mockImplementation(() => {});
    const lastPreviewFor = (boardId: number) =>
      publishSpy.mock.calls.filter(([channelBoardId]) => channelBoardId === String(boardId)).at(-1)?.[1];

    await sessionEditMutations.updateSession(undefined, { input: { sessionId, isPublic: false } }, authCtx(VIEWER));
    expect(lastPreviewFor(board.id)).toMatchObject({ boardId: board.id, current: null, upNext: [], queueLength: 0 });

    await sessionEditMutations.updateSession(undefined, { input: { sessionId, isPublic: true } }, authCtx(VIEWER));
    expect(lastPreviewFor(board.id)).toMatchObject({
      boardId: board.id,
      current: { queueItemUuid: current.uuid, name: 'Kiosk Climb' },
      queueLength: 1,
    });
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
