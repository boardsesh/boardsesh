/**
 * Real-DB coverage for how a live session's wall decides whether a climber who
 * stays anonymous on boards they don't own is named (#4189), and how connected
 * peers learn about a wall change:
 *
 * - a send filed under the climber's own board of a config never places a
 *   friend's config-path session on it (`resolveSessionBoards` step 4);
 * - owning the session's wall names the owner only after their own action on it
 *   in that session, so another member moving the session onto their public
 *   board names nobody: not in the mover's response, a fresh read, or the
 *   events already-connected peers receive;
 * - an angle change keeps the wall and re-projects nothing;
 * - a wall that moves under an unchanged path (a lit climb's binding, a newer
 *   send) re-projects every connected peer's roster and queue.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type {
  ClimbQueueItem,
  ConnectionContext,
  QueueEvent,
  QueueState,
  SessionEvent,
  SessionUser,
} from '@boardsesh/shared-schema';

vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => {}),
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: vi.fn(() => true) }));
// The peer is the session's creator; membership is not what these tests are about.
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireSessionMember: async () => {},
}));

import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import { roomManager } from '../services/room-manager';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { sessionSubscriptions } from '../graphql/resolvers/sessions/subscriptions';
import { queueSubscriptions } from '../graphql/resolvers/queue/subscriptions';
import { boardSessionPrivacyResolvers } from '../graphql/resolvers/shared/board-session-privacy';
import { redactSessionUsers, sessionParticipantId } from '../services/board-session-privacy';
import { updateSessionBoardPathIfChanged } from '../services/room-manager/session-discovery';
import { publishSessionWallChanged } from '../services/session-wall-refresh';

const CLIMBER = 'wall-moves-climber';
const FRIEND = 'wall-moves-friend';
const STRANGER = 'wall-moves-stranger';
const OTHER = 'wall-moves-other';
const CLIMB_UUID = 'wall-moves-climb';
const CONFIG_PATH = 'kilter/1/10/1/40';

type TestBoard = { id: number; uuid: string; slug: string };
let ownBoard: TestBoard;
let friendBoard: TestBoard;

const viewer = (userId: string, sessionId?: string): ConnectionContext =>
  ({
    connectionId: `wall-moves-${userId}-${randomUUID()}`,
    isAuthenticated: true,
    userId,
    sessionId,
  }) as ConnectionContext;

async function insertBoard(ownerId: string, name: string, isOwned = true): Promise<TestBoard> {
  const uuid = randomUUID();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: `wall-moves-${uuid}`,
      ownerId,
      name,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      isPublic: true,
      isOwned,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid, slug: dbSchema.userBoards.slug });
  return { id: Number(board.id), uuid: board.uuid, slug: board.slug };
}

async function insertSession(boardId: number | null, boardPath: string): Promise<string> {
  const sessionId = `wall-moves-${randomUUID()}`;
  await db.insert(dbSchema.boardSessions).values({
    id: sessionId,
    boardPath,
    createdByUserId: FRIEND,
    boardId,
    isPublic: true,
    status: 'active',
  });
  return sessionId;
}

/** A send seeded straight into the table (the setup a test starts from). */
async function seedTick(userId: string, sessionId: string, boardId: number, climbedAt: string): Promise<void> {
  await db.insert(dbSchema.boardseshTicks).values({
    uuid: `wall-moves-tick-${randomUUID()}`,
    userId,
    climbUuid: CLIMB_UUID,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    difficulty: 17,
    climbedAt,
    boardId,
    sessionId,
  });
}

/** A send logged through `saveTick`, the way the app logs one in a session. */
async function logSend(userId: string, sessionId: string, boardUuid?: string): Promise<number | null> {
  const uuid = randomUUID();
  await tickMutations.saveTick(
    undefined,
    {
      input: {
        uuid,
        boardType: 'kilter',
        climbUuid: CLIMB_UUID,
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 1,
        quality: null,
        difficulty: 17,
        isBenchmark: false,
        comment: '',
        climbedAt: new Date().toISOString(),
        layoutId: 1,
        sizeId: 10,
        setIds: '1',
        sessionId,
        ...(boardUuid ? { boardUuid } : {}),
      },
    },
    viewer(userId),
  );
  const [tick] = await db
    .select({ boardId: dbSchema.boardseshTicks.boardId })
    .from(dbSchema.boardseshTicks)
    .where(eq(dbSchema.boardseshTicks.uuid, uuid));
  return tick?.boardId == null ? null : Number(tick.boardId);
}

// The roster is mocked and CLIMBER holds no `board_session_participants` row,
// so neither FRIEND (the host) nor STRANGER counts as a fellow member of theirs
// (#6582): these tests cover the board-facing projection a viewer outside the
// session gets. 'a fellow member' at the end covers the other case.
const climberRow = (sessionId: string): SessionUser =>
  ({
    id: sessionParticipantId(sessionId, CLIMBER),
    userId: CLIMBER,
    username: 'Climber Name',
    avatarUrl: undefined,
    isLeader: false,
    connectionState: 'CONNECTED',
  }) as SessionUser;
const rosterName = async (reader: string, sessionId: string) =>
  (await redactSessionUsers([climberRow(sessionId)], reader, sessionId))[0].userId;
const queueItem = {
  uuid: 'wall-moves-item',
  addedBy: CLIMBER,
  tickedBy: [CLIMBER],
  climb: {
    uuid: CLIMB_UUID,
    name: 'Wall moves climb',
    setter_username: 'Setter',
    frames: 'p1r1',
    angle: 40,
    ascensionist_count: 1,
    difficulty: '6c/V5',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
} as unknown as ClimbQueueItem;

type SessionStream = AsyncGenerator<{ sessionUpdates: SessionEvent }>;
type QueueStream = AsyncGenerator<{ queueUpdates: QueueEvent }>;
async function nextSession(stream: SessionStream): Promise<SessionEvent> {
  const result = await stream.next();
  if (result.done) throw new Error('sessionUpdates ended early');
  return result.value.sessionUpdates;
}
async function nextQueue(stream: QueueStream): Promise<QueueEvent> {
  const result = await stream.next();
  if (result.done) throw new Error('queueUpdates ended early');
  return result.value.queueUpdates;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/** FRIEND (the session's creator, a durable member) connected to both streams. */
async function connectPeer(sessionId: string) {
  const getSessionUsers = vi.spyOn(roomManager, 'getSessionUsers').mockResolvedValue([climberRow(sessionId)]);
  const state = { sequence: 3, stateHash: 'h', queue: [queueItem], currentClimbQueueItem: null } as QueueState;
  const getQueueState = vi.spyOn(roomManager, 'getQueueState').mockResolvedValue(state as never);
  const peer = viewer(FRIEND, sessionId);
  const sessionStream = sessionSubscriptions.sessionUpdates.subscribe(undefined, { sessionId }, peer) as SessionStream;
  const queueStream = queueSubscriptions.queueUpdates.subscribe(undefined, { sessionId }, peer) as QueueStream;
  const seed = await nextSession(sessionStream);
  // The crew rest clock seed always follows the roster seed (#5382).
  const restCadenceSeed = await nextSession(sessionStream);
  const queueSeed = await nextQueue(queueStream);
  if (
    seed.__typename !== 'SessionRosterSnapshot' ||
    restCadenceSeed.__typename !== 'SessionRestCadenceChanged' ||
    queueSeed.__typename !== 'FullSync'
  ) {
    throw new Error('Expected the roster, rest clock and queue seeds');
  }
  return {
    sessionStream,
    queueStream,
    seedName: seed.users[0]?.userId ?? null,
    seedAddedBy: queueSeed.state.queue[0]?.addedBy,
    getSessionUsers,
    getQueueState,
    close: async () => {
      await sessionStream.return(undefined as never);
      await queueStream.return(undefined as never);
    },
  };
}

/** The roster and queue events a wall move sends a peer, as the names they carry. */
async function wallMoveNames(peer: Awaited<ReturnType<typeof connectPeer>>, withPathEvent: boolean) {
  const presence = await nextSession(peer.sessionStream);
  if (presence.__typename !== 'UserPresenceChanged') throw new Error(`Expected presence, got ${presence.__typename}`);
  if (withPathEvent) expect((await nextSession(peer.sessionStream)).__typename).toBe('SessionBoardPathChanged');
  const snapshot = await nextSession(peer.sessionStream);
  if (snapshot.__typename !== 'SessionRosterSnapshot') throw new Error(`Expected snapshot, got ${snapshot.__typename}`);
  const fullSync = await nextQueue(peer.queueStream);
  if (fullSync.__typename !== 'FullSync') throw new Error(`Expected FullSync, got ${fullSync.__typename}`);
  return {
    presence: presence.user.userId ?? null,
    presenceName: presence.user.username,
    snapshot: snapshot.users[0]?.userId ?? null,
    addedBy: fullSync.state.queue[0]?.addedBy,
    tickedBy: fullSync.state.queue[0]?.tickedBy,
  };
}

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values([CLIMBER, FRIEND, STRANGER, OTHER].map((id) => ({ id, email: `${id}@test.com`, name: id })));
  await db.insert(dbSchema.userProfiles).values({ userId: CLIMBER, displayName: 'Climber Name' });
  await db.insert(dbSchema.boardClimbs).values({
    uuid: CLIMB_UUID,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Wall moves climb',
    isListed: true,
    isDraft: false,
    frames: 'p1r1',
  });
  ownBoard = await insertBoard(CLIMBER, 'My garage');
  friendBoard = await insertBoard(FRIEND, 'Friend garage');
  await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: true }, viewer(CLIMBER));
});

beforeEach(() => {
  // No lit climb has bound any session to a wall unless a test says so.
  vi.spyOn(pubsub, 'getSessionBoard').mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("a send at a friend's config-path wall", () => {
  it.each([
    ['with no board, filed under their own garage by its config', 'none'],
    ['with their own garage as the active board', 'own'],
    ['with the board the app made for them on joining', 'minted'],
  ] as const)('never places the session on the climber’s board: %s', async (_label, variant) => {
    const sessionId = await insertSession(null, CONFIG_PATH);
    const minted = variant === 'minted' ? await insertBoard(CLIMBER, 'Kilter', false) : null;
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    const boardUuid = variant === 'own' ? ownBoard.uuid : minted?.uuid;
    const filedOn = await logSend(CLIMBER, sessionId, boardUuid);
    expect(filedOn).toBe(minted ? minted.id : ownBoard.id);

    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(STRANGER));
    expect(detail?.participants.map((participant) => participant.userId)).not.toContain(CLIMBER);
    expect(JSON.stringify(detail)).not.toContain('Climber Name');
    expect(JSON.stringify(detail)).not.toContain(CLIMBER);
    // They still see themselves.
    expect(await rosterName(CLIMBER, sessionId)).toBe(CLIMBER);
  });

  it('a board the app made for them never counts as theirs, even as the session’s own board', async () => {
    const minted = await insertBoard(CLIMBER, 'Kilter', false);
    const sessionId = await insertSession(minted.id, `/b/${minted.slug}/40`);
    await seedTick(CLIMBER, sessionId, minted.id, '2026-10-05T10:00:00Z');
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    expect(await rosterName(CLIMBER, sessionId)).toBe(CLIMBER);
  });

  it('is placed by another climber’s send on a wall that climber does not own', async () => {
    const sessionId = await insertSession(null, CONFIG_PATH);
    expect(await logSend(OTHER, sessionId, friendBoard.uuid)).toBe(friendBoard.id);
    await seedTick(CLIMBER, sessionId, ownBoard.id, '2026-10-05T10:00:00Z');
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    expect((await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(STRANGER)))?.ownerUserId).toBe(FRIEND);
  });
});

describe('another member moving the session onto the climber’s own public board', () => {
  it('names nobody: not the mover’s response, a fresh read, or connected peers', async () => {
    const sessionId = await insertSession(friendBoard.id, `/b/${friendBoard.slug}/40`);
    await seedTick(CLIMBER, sessionId, friendBoard.id, '2026-10-05T10:00:00Z');
    const peer = await connectPeer(sessionId);
    try {
      expect(peer.seedName).toBeNull();
      expect(peer.seedAddedBy).toBeUndefined();

      await updateSessionBoardPathIfChanged(sessionId, `/b/${ownBoard.slug}/40`, STRANGER, 'stranger-pid');
      // Connected peers: presence, roster snapshot and queue FullSync.
      expect(await wallMoveNames(peer, true)).toEqual({
        presence: null,
        presenceName: '',
        snapshot: null,
        addedBy: undefined,
        tickedBy: [],
      });
      // The mover's own response: `SessionUser` fields on their joined connection.
      const mover = viewer(STRANGER, sessionId);
      const row = climberRow(sessionId);
      expect(await boardSessionPrivacyResolvers.SessionUser.userId(row, undefined, mover)).toBeNull();
      expect(await boardSessionPrivacyResolvers.SessionUser.username(row, undefined, mover)).toBe('');
      // A fresh read, and the session detail and its card.
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      const detail = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(STRANGER));
      expect(JSON.stringify(detail)).not.toContain(CLIMBER);

      // Once the climber acts on their own board in this session, they are named
      // there, and a later move back onto it names them to connected peers.
      await seedTick(CLIMBER, sessionId, ownBoard.id, '2026-10-06T10:00:00Z');
      expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
      await updateSessionBoardPathIfChanged(sessionId, `/b/${friendBoard.slug}/40`, STRANGER, 'stranger-pid');
      expect((await wallMoveNames(peer, true)).snapshot).toBeNull();
      await updateSessionBoardPathIfChanged(sessionId, `/b/${ownBoard.slug}/40`, STRANGER, 'stranger-pid');
      expect(await wallMoveNames(peer, true)).toMatchObject({ presence: CLIMBER, snapshot: CLIMBER, addedBy: CLIMBER });
    } finally {
      await peer.close();
    }
  });

  it('an action in an earlier session on that board does not count', async () => {
    const earlier = await insertSession(ownBoard.id, `/b/${ownBoard.slug}/40`);
    await seedTick(CLIMBER, earlier, ownBoard.id, '2026-10-05T10:00:00Z');
    const sessionId = await insertSession(friendBoard.id, `/b/${friendBoard.slug}/40`);
    await updateSessionBoardPathIfChanged(sessionId, `/b/${ownBoard.slug}/40`, STRANGER);
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    expect(await rosterName(STRANGER, earlier)).toBe(CLIMBER);
  });
});

describe('what a connected peer re-projects', () => {
  it('an angle change keeps the wall: only the path event, no roster or queue refresh', async () => {
    const sessionId = await insertSession(ownBoard.id, `/b/${ownBoard.slug}/40`);
    await seedTick(CLIMBER, sessionId, ownBoard.id, '2026-10-05T10:00:00Z');
    const peer = await connectPeer(sessionId);
    try {
      expect(peer.seedName).toBe(CLIMBER);
      const rosterReads = peer.getSessionUsers.mock.calls.length;
      const queueReads = peer.getQueueState.mock.calls.length;

      await updateSessionBoardPathIfChanged(sessionId, `/b/${ownBoard.slug}/45`, CLIMBER, 'climber-pid');
      expect(await nextSession(peer.sessionStream)).toEqual({
        __typename: 'SessionBoardPathChanged',
        boardPath: `/b/${ownBoard.slug}/45`,
        changedByParticipantId: 'climber-pid',
      });
      await settle();
      expect(peer.getSessionUsers.mock.calls.length).toBe(rosterReads);
      expect(peer.getQueueState.mock.calls.length).toBe(queueReads);

      // A move to another wall does refresh, and is the very next roster event.
      await updateSessionBoardPathIfChanged(sessionId, `/b/${friendBoard.slug}/45`, CLIMBER, 'climber-pid');
      expect(await wallMoveNames(peer, true)).toMatchObject({ presence: null, snapshot: null, addedBy: undefined });
    } finally {
      await peer.close();
    }
  });

  it('a lit climb that binds the session to another wall re-projects without a path event', async () => {
    const sessionId = await insertSession(null, CONFIG_PATH);
    const binding = vi.mocked(pubsub.getSessionBoard).mockResolvedValue(String(ownBoard.id));
    await seedTick(CLIMBER, sessionId, ownBoard.id, '2026-10-05T10:00:00Z');
    const peer = await connectPeer(sessionId);
    try {
      expect(peer.seedName).toBe(CLIMBER);
      expect(peer.seedAddedBy).toBe(CLIMBER);
      // reportBoardClimb rebinds the session to the friend's wall, then publishes.
      binding.mockResolvedValue(String(friendBoard.id));
      await publishSessionWallChanged(sessionId);
      expect(await wallMoveNames(peer, false)).toEqual({
        presence: null,
        presenceName: '',
        snapshot: null,
        addedBy: undefined,
        tickedBy: [],
      });
    } finally {
      await peer.close();
    }
  });

  it('a newer send that moves the session to another wall re-projects; one that does not publishes nothing', async () => {
    const sessionId = await insertSession(null, CONFIG_PATH);
    // Another climber's send on the climber's public garage placed the session
    // there, and the climber sent there too.
    await seedTick(OTHER, sessionId, ownBoard.id, '2026-10-05T10:00:00Z');
    await seedTick(CLIMBER, sessionId, ownBoard.id, '2026-10-05T11:00:00Z');
    const peer = await connectPeer(sessionId);
    const published = vi.spyOn(pubsub, 'publishSessionEvent');
    try {
      expect(peer.seedName).toBe(CLIMBER);
      // Their own send on their own garage does not move the session.
      await logSend(CLIMBER, sessionId, ownBoard.uuid);
      await settle();
      expect(published).not.toHaveBeenCalled();
      // A send on the friend's wall does, and peers drop the name.
      expect(await logSend(OTHER, sessionId, friendBoard.uuid)).toBe(friendBoard.id);
      expect(await wallMoveNames(peer, false)).toMatchObject({ presence: null, snapshot: null, addedBy: undefined });
      expect(published).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ __typename: 'SessionBoardPathChanged', wallChanged: true, pathUnchanged: true }),
      );
    } finally {
      await peer.close();
    }
  });
});

describe('a fellow member', () => {
  it('keeps the climber’s name through a move onto a wall they don’t own', async () => {
    const sessionId = await insertSession(ownBoard.id, `/b/${ownBoard.slug}/40`);
    await db.insert(dbSchema.boardSessionParticipants).values({ sessionId, userId: CLIMBER });
    const peer = await connectPeer(sessionId);
    try {
      expect(peer.seedName).toBe(CLIMBER);
      expect(peer.seedAddedBy).toBe(CLIMBER);
      await updateSessionBoardPathIfChanged(sessionId, `/b/${friendBoard.slug}/40`, FRIEND, 'friend-pid');
      expect(await wallMoveNames(peer, true)).toMatchObject({
        presence: CLIMBER,
        presenceName: 'Climber Name',
        snapshot: CLIMBER,
        addedBy: CLIMBER,
        tickedBy: [CLIMBER],
      });
      // The stranger, who never joined, still gets the anonymous rows.
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
    } finally {
      await peer.close();
    }
  });
});
