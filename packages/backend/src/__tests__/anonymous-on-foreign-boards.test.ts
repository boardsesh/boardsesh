/**
 * Real-DB coverage for "Stay anonymous on boards I don't own" (#4189). The
 * preference is a read-time projection: every board-facing surface shows the
 * climber as the anonymous climber on a board they don't own, while ticks,
 * history rows and every total stay exactly as stored.
 */
import { randomUUID } from 'node:crypto';
import { buildSchema, graphql, isObjectType } from 'graphql';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import {
  typeDefs,
  type BoardPresenceStats,
  type ClimbQueueItem,
  type ConnectionContext,
  type SessionUser,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import { roomManager } from '../services/room-manager';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { boardSessionPrivacyResolvers } from '../graphql/resolvers/shared/board-session-privacy';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { privacyMutations, privacyQueries } from '../graphql/resolvers/privacy';
import { buildSessionPayload } from '../graphql/resolvers/sessions/helpers';
import { buildSessionStatsUpdatedEvent } from '../graphql/resolvers/sessions/live-session-stats';
import { generateSessionSummary } from '../graphql/resolvers/sessions/session-summary';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';
import { climbLogsQueries } from '../graphql/resolvers/social/climb-logs';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';
import {
  redactBoardHolder,
  redactQueueItem,
  redactSessionUsers,
  sessionParticipantId,
} from '../services/board-session-privacy';
import { projectLiveActivityContent } from '../services/apns/privacy';
import { emptyLiveActivityContentState } from '../services/apns/content-state';
import { canViewUserActivity, isAnonymousOnBoard, visibleActivityUserIds } from '../services/privacy';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';
import { resetAllRateLimits } from '../utils/rate-limiter';

function recentSenderGraphSchema(resolve = boardPresenceQueries.boardClimbRecentSenders) {
  const schema = buildSchema(typeDefs.join('\n'));
  const query = schema.getQueryType();
  const sender = schema.getType('BoardClimbRecentSender');
  if (!query || !isObjectType(sender)) throw new Error('Recent sender GraphQL types missing');
  query.getFields().boardClimbRecentSenders.resolve = resolve;
  for (const [fieldName, resolver] of Object.entries(boardSessionPrivacyResolvers.BoardClimbRecentSender)) {
    sender.getFields()[fieldName].resolve = resolver;
  }
  return schema;
}

const CLIMBER = 'anon-boards-climber';
const GYM_OWNER = 'anon-boards-gym-owner';
const FRIEND = 'anon-boards-friend';
const FOLLOWER = 'anon-boards-follower';
const STRANGER = 'anon-boards-stranger';
const OTHER_CLIMBER = 'anon-boards-other';
const CLIMB_UUID = 'anon-boards-climb';
const SESSION_CLIMB_UUID = 'anon-boards-session-climb';
const SPRAY_LAYOUT_ID = 987_654;
const SPRAY_CLIMB_UUID = 'anon-boards-spray-climb';

type TestBoard = { id: number; uuid: string; slug: string };
let gymBoard: TestBoard;
let friendBoard: TestBoard;
let ownBoard: TestBoard;

const viewer = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `anon-boards-${userId ?? 'anon'}-${randomUUID()}`,
    isAuthenticated: !!userId,
    userId,
  }) as ConnectionContext;

async function setPreference(enabled: boolean): Promise<void> {
  await privacyMutations.setAnonymousOnForeignBoards(null, { enabled }, viewer(CLIMBER));
}

async function insertBoard(
  ownerId: string,
  name: string,
  options: { gymId?: number; boardType?: string; layoutId?: number; sizeId?: number } = {},
): Promise<TestBoard> {
  const uuid = randomUUID();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: `anon-boards-${uuid}`,
      ownerId,
      name,
      boardType: options.boardType ?? 'kilter',
      layoutId: options.layoutId ?? 1,
      sizeId: options.sizeId ?? 10,
      setIds: '1',
      gymId: options.gymId ?? null,
      isPublic: true,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid, slug: dbSchema.userBoards.slug });
  return { id: Number(board.id), uuid: board.uuid, slug: board.slug };
}

/** The climber and one other climber each displayed the climb on this board. */
async function seedBoardHistory(boardId: number, seqBase: number): Promise<void> {
  await db.insert(dbSchema.boardClimbEvents).values(
    [CLIMBER, OTHER_CLIMBER].map((userId, index) => ({
      boardId,
      boardType: 'kilter',
      climbUuid: CLIMB_UUID,
      angle: 40,
      userId,
      identityPolicyVersion: 1,
      seq: seqBase + index,
      name: 'Anonymous boards climb',
      confirmedAt: `2026-10-0${index + 1}T10:00:00Z`,
    })),
  );
}

/** The climber and one other climber each sent the climb on this board. */
async function seedBoardTicks(boardId: number): Promise<void> {
  await db.insert(dbSchema.boardseshTicks).values(
    [CLIMBER, OTHER_CLIMBER].map((userId, index) => ({
      uuid: `anon-boards-tick-${boardId}-${userId}`,
      userId,
      climbUuid: CLIMB_UUID,
      boardType: 'kilter',
      angle: 40,
      status: 'send' as const,
      // The climber holds the board's hardest send.
      difficulty: userId === CLIMBER ? 20 : 16,
      climbedAt: `2026-10-0${index + 1}T10:00:00Z`,
      boardId,
    })),
  );
}

/** A config path no board of the climber's has: nothing but a binding or a tick places it. */
const UNOWNED_CONFIG_PATH = 'kilter/1/12/1/40';

async function insertSession(id: string, boardId: number | null, boardPath = 'kilter/1/10/1/40'): Promise<void> {
  await db.insert(dbSchema.boardSessions).values({
    id,
    boardPath,
    createdByUserId: CLIMBER,
    boardId,
    isPublic: true,
    status: 'active',
  });
}

/** The climber's and another climber's sends in a session, logged on `boardId`. */
async function seedSessionTicks(
  sessionId: string,
  boardId: number,
  boardType = 'kilter',
  climbUuid = SESSION_CLIMB_UUID,
) {
  await db.insert(dbSchema.boardseshTicks).values(
    [CLIMBER, OTHER_CLIMBER].map((userId, index) => ({
      uuid: `anon-boards-session-tick-${sessionId}-${index}`,
      userId,
      climbUuid,
      boardType,
      angle: 40,
      status: 'send' as const,
      difficulty: userId === CLIMBER ? 20 : 16,
      comment: `${userId} note`,
      climbedAt: `2026-10-0${index + 2}T10:00:00Z`,
      boardId,
      sessionId,
    })),
  );
}

/** The climber's own send in a session on `boardId`: what names them on their own board there. */
async function seedClimberSessionTick(sessionId: string, boardId: number): Promise<void> {
  await db.insert(dbSchema.boardseshTicks).values({
    uuid: `anon-boards-own-action-${sessionId}-${boardId}`,
    userId: CLIMBER,
    climbUuid: SESSION_CLIMB_UUID,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    difficulty: 20,
    climbedAt: '2026-10-04T10:00:00Z',
    boardId,
    sessionId,
  });
}

const historySender = async (boardId: number, reader: string | null) => {
  const history = await boardPresenceQueries.boardHistory(undefined, { boardId }, viewer(reader));
  expect(history).toHaveLength(2);
  return history.find((row) => row.name === 'Anonymous boards climb' && row.sentAt.startsWith('2026-10-01'));
};

beforeAll(async () => {
  await db.insert(dbSchema.users).values(
    [CLIMBER, GYM_OWNER, FRIEND, FOLLOWER, STRANGER, OTHER_CLIMBER, SYSTEM_BOARD_OWNER_ID].map((id) => ({
      id,
      email: `${id}@test.com`,
      name: id,
    })),
  );
  await db.insert(dbSchema.userProfiles).values({ userId: CLIMBER, displayName: 'Climber Name' });
  await db.insert(dbSchema.userFollows).values({ followerId: FOLLOWER, followingId: CLIMBER });
  await db.insert(dbSchema.boardClimbs).values({
    uuid: CLIMB_UUID,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Anonymous boards climb',
    isListed: true,
    isDraft: false,
    frames: 'p1r1',
  });
  await db.insert(dbSchema.boardClimbs).values([
    {
      uuid: SESSION_CLIMB_UUID,
      boardType: 'kilter',
      layoutId: 1,
      name: 'Anonymous boards session climb',
      isListed: true,
      isDraft: false,
      frames: 'p1r1',
    },
    {
      uuid: SPRAY_CLIMB_UUID,
      boardType: 'spray',
      layoutId: SPRAY_LAYOUT_ID,
      name: 'Anonymous boards spray climb',
      isListed: true,
      isDraft: false,
      frames: 'p1r1',
    },
  ]);
  // A gym wall as the gym sync writes it: owned by the system account, listed under a gym.
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid: randomUUID(), name: 'Anonymous boards gym', ownerId: GYM_OWNER })
    .returning({ id: dbSchema.gyms.id });
  gymBoard = await insertBoard(SYSTEM_BOARD_OWNER_ID, 'Gym wall', { gymId: Number(gym.id) });
  friendBoard = await insertBoard(FRIEND, 'Friend garage');
  ownBoard = await insertBoard(CLIMBER, 'My garage');
  for (const board of [gymBoard, friendBoard, ownBoard]) await seedBoardTicks(board.id);
});

// The shared setup truncates board_sessions CASCADE before every test, which
// empties board_climb_events (it references board_sessions), so reseed it here.
beforeEach(async () => {
  for (const board of [gymBoard, friendBoard, ownBoard]) await seedBoardHistory(board.id, 1);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setPreference(false);
});

describe('privacy settings round trip', () => {
  it('saves without account privacy controls and reads back, without a fleet-wide privacyChanged', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '');
    const published = vi.spyOn(pubsub, 'publishPrivacyChanged');
    const save = (enabled: boolean) => privacyMutations.setAnonymousOnForeignBoards(null, { enabled }, viewer(CLIMBER));
    try {
      expect((await privacyQueries.privacySettings(null, null, viewer(CLIMBER))).anonymousOnForeignBoards).toBe(false);
      // Reads apply the preference, so no save tells every app to refetch.
      await save(false);
      const saved = await save(true);
      expect(saved).toMatchObject({ anonymousOnForeignBoards: true, enabled: false });
      await save(true);
      expect((await privacyQueries.privacySettings(null, null, viewer(CLIMBER))).anonymousOnForeignBoards).toBe(true);
      await save(false);
      expect((await privacyQueries.privacySettings(null, null, viewer(CLIMBER))).anonymousOnForeignBoards).toBe(false);
      expect(published).not.toHaveBeenCalled();
      // The account Public/Private switch is still behind the flag.
      await expect(
        privacyMutations.updatePrivacySettings(null, { input: { isPrivate: true } }, viewer(CLIMBER)),
      ).rejects.toThrow('Privacy controls are not available yet');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('limits preference saves across connections without spending ordinary privacy mutation allowance', async () => {
    try {
      for (let count = 0; count < 5; count++) {
        await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: false }, viewer(CLIMBER));
      }
      await expect(
        privacyMutations.setAnonymousOnForeignBoards(null, { enabled: true }, viewer(CLIMBER)),
      ).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
      expect((await privacyQueries.privacySettings(null, null, viewer(CLIMBER))).anonymousOnForeignBoards).toBe(false);
      // Saving this preference must not exhaust account privacy or session operations.
      await expect(applyRateLimit(viewer(CLIMBER), 30, 'privacyMutation')).resolves.toBeUndefined();
      await expect(applyRateLimit(viewer(CLIMBER), 60, 'session')).resolves.toBeUndefined();
    } finally {
      resetAllRateLimits();
    }
  });

  it('creates the profile row for a climber who never had one, and rejects a non-boolean', async () => {
    const published = vi.spyOn(pubsub, 'publishPrivacyChanged');
    await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: false }, viewer(GYM_OWNER));
    await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: true }, viewer(STRANGER));
    expect(published).not.toHaveBeenCalled();
    const [profile] = await db
      .select({ value: dbSchema.userProfiles.anonymousOnForeignBoards })
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, STRANGER));
    expect(profile.value).toBe(true);
    await privacyMutations.setAnonymousOnForeignBoards(null, { enabled: false }, viewer(STRANGER));
    await expect(
      privacyMutations.setAnonymousOnForeignBoards(null, { enabled: 'yes' }, viewer(STRANGER)),
    ).rejects.toThrow();
    await expect(privacyMutations.setAnonymousOnForeignBoards(null, { enabled: true }, viewer(null))).rejects.toThrow();
  });
});

describe('the predicate', () => {
  it('holds on a gym or friend board, never on their own board, never to themselves, never when off', async () => {
    await setPreference(true);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: gymBoard.id }, STRANGER)).toBe(true);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: friendBoard.id }, FRIEND)).toBe(true);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: gymBoard.id }, null)).toBe(true);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: ownBoard.id }, STRANGER)).toBe(false);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: gymBoard.id }, CLIMBER)).toBe(false);
    // A board the app made only to climb on someone else's wall is not theirs.
    const minted = await insertBoard(CLIMBER, 'Kilter');
    await db.update(dbSchema.userBoards).set({ isOwned: false }).where(eq(dbSchema.userBoards.id, minted.id));
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: minted.id }, STRANGER)).toBe(true);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: minted.id }, CLIMBER)).toBe(false);
    await setPreference(false);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: gymBoard.id }, STRANGER)).toBe(false);
  });
});

describe('wall feed', () => {
  it('keeps the row but drops the name on a gym board and a friend board, to strangers, owners and followers', async () => {
    await setPreference(true);
    for (const [board, reader] of [
      [gymBoard, STRANGER],
      [gymBoard, GYM_OWNER],
      [gymBoard, FOLLOWER],
      [gymBoard, null],
      [friendBoard, FRIEND],
    ] as const) {
      const row = await historySender(board.id, reader);
      expect(row).toMatchObject({ climbUuid: CLIMB_UUID, sentByUserId: null, sentByDisplayName: null });
      expect(row?.sentByAvatarUrl ?? null).toBeNull();
    }
  });

  it('names the climber on their own board, to themselves, and again once switched off', async () => {
    await setPreference(true);
    expect(await historySender(ownBoard.id, STRANGER)).toMatchObject({
      sentByUserId: CLIMBER,
      sentByDisplayName: 'Climber Name',
    });
    expect(await historySender(gymBoard.id, CLIMBER)).toMatchObject({ sentByUserId: CLIMBER });
    await setPreference(false);
    expect(await historySender(gymBoard.id, STRANGER)).toMatchObject({ sentByUserId: CLIMBER });
  });

  it('drops the name from recent senders of a climb on the gym board', async () => {
    await setPreference(true);
    const senders = await boardPresenceQueries.boardClimbRecentSenders(
      undefined,
      { boardId: gymBoard.id, climbUuid: CLIMB_UUID, angle: 40 },
      viewer(STRANGER),
    );
    expect(senders).toHaveLength(2);
    expect(senders.map((sender) => sender.userId)).not.toContain(CLIMBER);
    expect(senders.map((sender) => sender.userId)).toContain(OTHER_CLIMBER);
  });
});

describe('board stats and leaderboard', () => {
  const stats = (boardId: number, reader: string): Promise<BoardPresenceStats> =>
    boardPresenceQueries.boardPresenceStats(undefined, { boardId }, viewer(reader));

  it('keeps every total and unnames the hardest send on a gym board', async () => {
    const before = await stats(gymBoard.id, STRANGER);
    expect(before.hardestSend?.sentByUserId).toBe(CLIMBER);
    await setPreference(true);
    const after = await stats(gymBoard.id, STRANGER);
    expect(after).toMatchObject({
      climbsSentCount: before.climbsSentCount,
      distinctClimbersCount: before.distinctClimbersCount,
      hardestGrade: before.hardestGrade,
    });
    expect(after.distinctClimbersCount).toBe(2);
    expect(after.hardestSend).toMatchObject({ climbUuid: CLIMB_UUID, sentByUserId: null, sentByDisplayName: null });
    expect((await stats(gymBoard.id, CLIMBER)).hardestSend?.sentByUserId).toBe(CLIMBER);
    expect((await stats(ownBoard.id, STRANGER)).hardestSend?.sentByUserId).toBe(CLIMBER);
  });

  it('keeps the rank and sends on the leaderboard without a name', async () => {
    const leaderboard = (board: { uuid: string }, reader: string) =>
      socialBoardQueries.boardLeaderboard(null, { input: { boardUuid: board.uuid } }, viewer(reader));
    const before = await leaderboard(gymBoard, STRANGER);
    await setPreference(true);
    const after = await leaderboard(gymBoard, STRANGER);
    expect(after.totalCount).toBe(before.totalCount);
    const sends = (entries: { totalSends: number }[]) =>
      entries.map((entry) => entry.totalSends).sort((first, second) => first - second);
    expect(sends(after.entries)).toEqual(sends(before.entries));
    expect(after.entries.map((entry) => entry.userId)).toEqual(expect.arrayContaining([null, OTHER_CLIMBER]));
    expect(JSON.stringify(after)).not.toContain('Climber Name');
    expect((await leaderboard(friendBoard, FRIEND)).entries.map((entry) => entry.userId)).not.toContain(CLIMBER);
    expect((await leaderboard(ownBoard, STRANGER)).entries.map((entry) => entry.userId)).toContain(CLIMBER);
    expect((await leaderboard(gymBoard, CLIMBER)).entries.map((entry) => entry.userId)).toContain(CLIMBER);
  });
});

const holder = { userId: CLIMBER, displayName: 'Climber Name', avatarUrl: 'https://example.test/a' };
const rosterUser: SessionUser = {
  id: CLIMBER,
  userId: CLIMBER,
  username: 'Climber Name',
  avatarUrl: 'https://example.test/a',
  isLeader: true,
  connectionState: 'CONNECTED',
} as SessionUser;
/** Added by the climber, ticked by the climber and another climber. */
const queueItem = {
  uuid: 'anon-boards-queue-item',
  addedBy: CLIMBER,
  addedByUser: { id: CLIMBER, username: 'Climber Name' },
  tickedBy: [CLIMBER, OTHER_CLIMBER],
  suggested: false,
  climb: {
    uuid: CLIMB_UUID,
    name: 'Anonymous boards climb',
    frames: 'p1r1',
    setter_username: '',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '',
    quality_average: '',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  },
} as ClimbQueueItem;
const rosterName = async (reader: string, sessionId: string) =>
  (await redactSessionUsers([rosterUser], reader, sessionId))[0].userId;

describe('approved members of an identified restricted board', () => {
  it('names a private climber to approved members without widening account privacy, and revokes immediately', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(FRIEND, 'Restricted garage');
      const sessionId = 'anon-boards-restricted-member';
      await insertSession(sessionId, board.id);
      await seedSessionTicks(sessionId, board.id);
      await seedBoardHistory(board.id, 1);
      await db.insert(dbSchema.resourcePrivacy).values({
        kind: 'board',
        resourceId: board.uuid,
        audience: 'invite_only',
        locationAudience: 'only_me',
      });
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      expect(await rosterName(FRIEND, sessionId)).toBe(CLIMBER);
      await db.insert(dbSchema.resourceGrants).values({
        kind: 'board',
        resourceId: board.uuid,
        userId: STRANGER,
        status: 'approved',
      });
      expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
      expect((await redactQueueItem(queueItem, STRANGER, sessionId)).addedBy).toBe(CLIMBER);
      expect(await redactBoardHolder(holder, STRANGER, board.id)).toEqual(holder);
      expect((await historySender(board.id, STRANGER))?.sentByUserId).toBe(CLIMBER);
      expect((await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(STRANGER)))?.ownerUserId).toBe(
        CLIMBER,
      );
      expect(
        (
          await sessionFeedQueries.sessionGroupedFeed(null, { input: { boardUuid: board.uuid } }, viewer(STRANGER))
        ).sessions.find((session) => session.sessionId === sessionId)?.ownerUserId,
      ).toBe(CLIMBER);
      expect(await canViewUserActivity(STRANGER, CLIMBER)).toBe(false);
      expect(await visibleActivityUserIds([CLIMBER], STRANGER)).toEqual(new Set());
      await db
        .update(dbSchema.resourceGrants)
        .set({ status: 'revoked' })
        .where(eq(dbSchema.resourceGrants.resourceId, board.uuid));
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      expect((await redactQueueItem(queueItem, STRANGER, sessionId)).addedBy).toBeUndefined();
      expect(await redactBoardHolder(holder, STRANGER, board.id)).toMatchObject({ userId: null, displayName: null });
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });

  it('keeps restricted-member recent-sender identities through actual GraphQL fields and rechecks revocation', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(FRIEND, 'GraphQL private crew');
      await seedBoardTicks(board.id);
      await db.insert(dbSchema.resourcePrivacy).values({
        kind: 'board',
        resourceId: board.uuid,
        audience: 'invite_only',
        locationAudience: 'only_me',
      });
      await db.insert(dbSchema.resourceGrants).values({
        kind: 'board',
        resourceId: board.uuid,
        userId: STRANGER,
        status: 'approved',
      });
      // Item privacy remains separate; explicitly public requires consent at
      // the account's current revision, not merely the public audience label.
      const [profile] = await db
        .select({ revision: dbSchema.userProfiles.privacyRevision })
        .from(dbSchema.userProfiles)
        .where(eq(dbSchema.userProfiles.userId, CLIMBER));
      expect(profile).toBeDefined();
      await db.insert(dbSchema.contentPrivacy).values({
        entityType: 'tick',
        entityId: `anon-boards-tick-${board.id}-${CLIMBER}`,
        ownerId: CLIMBER,
        audience: 'public',
        publicConsentRevision: profile.revision,
      });
      const context = viewer(STRANGER);
      const query =
        'query($boardId:Int!, $climbUuid:String!, $angle:Int!) { senders:boardClimbRecentSenders(boardId:$boardId, climbUuid:$climbUuid, angle:$angle) { userId displayName avatarUrl lastSentAt } }';
      const args = { boardId: board.id, climbUuid: CLIMB_UUID, angle: 40 };
      const schema = recentSenderGraphSchema();
      const response = await graphql({ schema, source: query, variableValues: args, contextValue: context });
      expect(response.errors).toBeUndefined();
      expect(response.data?.senders).toContainEqual(
        expect.objectContaining({ userId: CLIMBER, displayName: 'Climber Name' }),
      );
      expect(await canViewUserActivity(STRANGER, CLIMBER)).toBe(false);
      const retained = await boardPresenceQueries.boardClimbRecentSenders(null, args, context);
      const retainedSchema = recentSenderGraphSchema(async () => retained);
      await db
        .update(dbSchema.resourceGrants)
        .set({ status: 'revoked' })
        .where(eq(dbSchema.resourceGrants.resourceId, board.uuid));
      const revoked = await graphql({
        schema: retainedSchema,
        source: query,
        variableValues: args,
        contextValue: context,
      });
      expect(revoked.errors).toBeUndefined();
      expect(revoked.data?.senders).toContainEqual(
        expect.objectContaining({
          lastSentAt: '2026-10-01T10:00:00.000Z',
          userId: null,
          displayName: null,
          avatarUrl: null,
        }),
      );
      await db
        .update(dbSchema.resourceGrants)
        .set({ status: 'approved' })
        .where(eq(dbSchema.resourceGrants.resourceId, board.uuid));
      await db
        .update(dbSchema.resourcePrivacy)
        .set({ audience: 'unlisted' })
        .where(eq(dbSchema.resourcePrivacy.resourceId, board.uuid));
      const unlisted = await graphql({ schema, source: query, variableValues: args, contextValue: context });
      expect(unlisted.errors).toBeUndefined();
      expect(unlisted.data?.senders).toContainEqual(
        expect.objectContaining({
          lastSentAt: '2026-10-01T10:00:00.000Z',
          userId: null,
          displayName: null,
          avatarUrl: null,
        }),
      );
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });

  it('keeps private crew names through HTTP and unrelated-session GraphQL fields, then revokes retained payloads', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(FRIEND, 'HTTP private crew');
      const sessionId = 'anon-boards-http-private-crew';
      await insertSession(sessionId, board.id);
      await insertSession('anon-boards-unrelated-joined-session', gymBoard.id);
      await seedSessionTicks(sessionId, board.id);
      await db
        .insert(dbSchema.resourcePrivacy)
        .values({ kind: 'board', resourceId: board.uuid, audience: 'invite_only', locationAudience: 'only_me' });
      await db
        .insert(dbSchema.resourceGrants)
        .values({ kind: 'board', resourceId: board.uuid, userId: STRANGER, status: 'approved' });
      const context = viewer(STRANGER);
      const payload = await buildSessionPayload(sessionId, context, {
        users: [rosterUser],
        queueState: { sequence: 1, stateHash: 'crew', queue: [queueItem], currentClimbQueueItem: null },
        sessionData: null,
        lastConnectedBoardSerial: null,
        isLeader: false,
        boardPath: `b/${board.slug}/40`,
      });
      const schema = buildSchema(typeDefs.join('\n'));
      const query = schema.getQueryType();
      if (!query) throw new Error('Query type missing');
      query.getFields().session.resolve = () => payload;
      for (const typeName of ['SessionUser', 'ClimbQueueItem'] as const) {
        const object = schema.getType(typeName);
        if (!isObjectType(object)) throw new Error(`${typeName} missing`);
        for (const [fieldName, resolver] of Object.entries(boardSessionPrivacyResolvers[typeName]))
          object.getFields()[fieldName].resolve = resolver;
      }
      const source =
        'query($sessionId:ID!) { session(sessionId:$sessionId) { users { id userId username } queueState { queue { addedBy addedByUser { id username } } } } }';
      type Projected = {
        session: {
          users: { id: string; userId: string | null; username: string }[];
          queueState: { queue: { addedBy: string | null; addedByUser: { id: string; username: string } | null }[] };
        };
      };
      // The roster and the queue each keep the session they were projected for,
      // over HTTP (no joined session) and on a socket joined to a gym session
      // where the climber is anonymous. Checked one field at a time: either half
      // alone carries the same name.
      for (const current of [context, { ...context, sessionId: 'anon-boards-unrelated-joined-session' }]) {
        const response = await graphql({ schema, source, variableValues: { sessionId }, contextValue: current });
        expect(response.errors).toBeUndefined();
        const { users, queueState } = (response.data as Projected).session;
        expect(users[0]).toEqual({
          id: sessionParticipantId(sessionId, CLIMBER),
          userId: CLIMBER,
          username: 'Climber Name',
        });
        expect(users[0].id).not.toBe(sessionParticipantId('anon-boards-unrelated-joined-session', CLIMBER));
        expect(queueState.queue[0].addedBy).toBe(CLIMBER);
        expect(queueState.queue[0].addedByUser).toEqual({ id: CLIMBER, username: 'Climber Name' });
      }
      await db
        .update(dbSchema.resourceGrants)
        .set({ status: 'revoked' })
        .where(eq(dbSchema.resourceGrants.resourceId, board.uuid));
      const revoked = await graphql({ schema, source, variableValues: { sessionId }, contextValue: context });
      expect(revoked.errors).toBeUndefined();
      expect(JSON.stringify(revoked.data)).not.toContain('Climber Name');
      expect(JSON.stringify(revoked.data)).not.toContain(CLIMBER);
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });

  it('preserves private crew hardest-send fields and highlights without releasing explicit private ticks', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(FRIEND, 'Private crew highlights');
      const sessionId = 'anon-boards-private-highlights';
      await insertSession(sessionId, board.id);
      await seedSessionTicks(sessionId, board.id);
      await seedBoardTicks(board.id);
      await db
        .insert(dbSchema.resourcePrivacy)
        .values({ kind: 'board', resourceId: board.uuid, audience: 'invite_only', locationAudience: 'only_me' });
      await db
        .insert(dbSchema.resourceGrants)
        .values({ kind: 'board', resourceId: board.uuid, userId: STRANGER, status: 'approved' });
      const context = viewer(STRANGER);
      const retained = await boardPresenceQueries.boardPresenceStats(null, { boardId: board.id }, context);
      const schema = buildSchema(typeDefs.join('\n'));
      const query = schema.getQueryType();
      const hardest = schema.getType('BoardPresenceHardestSend');
      if (!query || !isObjectType(hardest)) throw new Error('Board stats types missing');
      query.getFields().boardPresenceStats.resolve = () => retained;
      for (const [fieldName, resolver] of Object.entries(boardSessionPrivacyResolvers.BoardPresenceHardestSend))
        hardest.getFields()[fieldName].resolve = resolver;
      const source =
        'query($boardId:Int!) { boardPresenceStats(boardId:$boardId) { hardestSend { sentByUserId sentByDisplayName sentByAvatarUrl } } }';
      const response = await graphql({ schema, source, variableValues: { boardId: board.id }, contextValue: context });
      expect(response.errors).toBeUndefined();
      expect(JSON.stringify(response.data)).toContain('Climber Name');
      const card = async () =>
        (
          await sessionFeedQueries.sessionGroupedFeed(null, { input: { boardUuid: board.uuid } }, context)
        ).sessions.find((session) => session.sessionId === sessionId);
      expect((await card())?.hardestSend).toMatchObject({ userId: CLIMBER, comment: null });
      const sessionTickUuid = `anon-boards-session-tick-${sessionId}-0`;
      await db.insert(dbSchema.boardBetaLinks).values({
        boardType: 'kilter',
        climbUuid: SESSION_CLIMB_UUID,
        tickUuid: sessionTickUuid,
        boardId: board.id,
        link: 'https://example.test/private-crew-beta',
        isListed: true,
        createdByUserId: CLIMBER,
      });
      expect((await card())?.featuredBeta).toBeNull();
      const [profile] = await db
        .select({ revision: dbSchema.userProfiles.privacyRevision })
        .from(dbSchema.userProfiles)
        .where(eq(dbSchema.userProfiles.userId, CLIMBER));
      await db.insert(dbSchema.contentPrivacy).values({
        entityType: 'tick',
        entityId: sessionTickUuid,
        ownerId: CLIMBER,
        audience: 'public',
        publicConsentRevision: profile.revision,
      });
      expect((await card())?.featuredBeta?.tick.userId).toBe(CLIMBER);
      expect((await card())?.hardestSend?.comment).toBe(`${CLIMBER} note`);
      await db.delete(dbSchema.contentPrivacy).where(eq(dbSchema.contentPrivacy.entityId, sessionTickUuid));
      await db
        .insert(dbSchema.contentPrivacy)
        .values({ entityType: 'tick', entityId: sessionTickUuid, ownerId: CLIMBER, audience: 'only_me' });
      expect((await card())?.hardestSend).toBeNull();
      expect((await card())?.featuredBeta).toBeNull();
      expect(retained.hardestSend?.tickUuid).toBeTruthy();
      if (retained.hardestSend?.tickUuid !== sessionTickUuid) {
        await db.insert(dbSchema.contentPrivacy).values({
          entityType: 'tick',
          entityId: retained.hardestSend!.tickUuid!,
          ownerId: CLIMBER,
          audience: 'only_me',
        });
      }
      const restricted = await graphql({
        schema,
        source,
        variableValues: { boardId: board.id },
        contextValue: context,
      });
      expect(restricted.errors).toBeUndefined();
      expect(JSON.stringify(restricted.data)).not.toContain('Climber Name');
      expect(JSON.stringify(restricted.data)).not.toContain(CLIMBER);
      await db.delete(dbSchema.boardBetaLinks).where(eq(dbSchema.boardBetaLinks.tickUuid, sessionTickUuid));
      await db
        .update(dbSchema.resourceGrants)
        .set({ status: 'revoked' })
        .where(eq(dbSchema.resourceGrants.resourceId, board.uuid));
      const revoked = await graphql({ schema, source, variableValues: { boardId: board.id }, contextValue: context });
      expect(revoked.errors).toBeUndefined();
      expect(JSON.stringify(revoked.data)).not.toContain('Climber Name');
      expect(JSON.stringify(revoked.data)).not.toContain(CLIMBER);
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });

  it('treats a deleted owned board as foreign while keeping the self exception', async () => {
    await setPreference(true);
    const board = await insertBoard(CLIMBER, 'Deleted owned garage');
    const sessionId = 'anon-boards-deleted-own-session';
    await insertSession(sessionId, board.id);
    await seedClimberSessionTick(sessionId, board.id);
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: board.id }, STRANGER)).toBe(false);
    expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
    await db.update(dbSchema.userBoards).set({ deletedAt: new Date() }).where(eq(dbSchema.userBoards.id, board.id));
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: board.id }, STRANGER)).toBe(true);
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    expect(await isAnonymousOnBoard(CLIMBER, { boardId: board.id }, CLIMBER)).toBe(false);
    expect(await rosterName(CLIMBER, sessionId)).toBe(CLIMBER);
  });

  // The stranger never joined (no participant row), so they are not a fellow
  // member of the session (#6582) and only the board rules apply.
  it('does not reveal a private account to a viewer outside the session who rebinds it to their board and fabricates a grant', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(STRANGER, 'Rebound garage');
      const sessionId = 'anon-boards-unilateral-rebind';
      await insertSession(sessionId, ownBoard.id);
      await seedSessionTicks(sessionId, ownBoard.id);
      await db.insert(dbSchema.resourcePrivacy).values({
        kind: 'board',
        resourceId: board.uuid,
        audience: 'invite_only',
        locationAudience: 'only_me',
      });
      // The inviter can grant membership without the named account accepting it.
      await db.insert(dbSchema.resourceGrants).values({
        kind: 'board',
        resourceId: board.uuid,
        userId: CLIMBER,
        status: 'approved',
        invitedBy: STRANGER,
      });
      await db
        .update(dbSchema.boardSessions)
        .set({ boardId: board.id, boardPath: `/b/${board.slug}/40` })
        .where(eq(dbSchema.boardSessions.id, sessionId));
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      expect((await redactQueueItem(queueItem, STRANGER, sessionId)).addedBy).toBeUndefined();
      expect((await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(STRANGER)))?.ownerUserId).toBeNull();
      // Activity in an earlier session cannot place this climber on this session's wall.
      const previousSession = 'anon-boards-previous-private-wall';
      await insertSession(previousSession, board.id);
      await seedSessionTicks(previousSession, board.id);
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      // Only their own action in this session releases the private-board name.
      await db.insert(dbSchema.boardClimbEvents).values({
        boardId: board.id,
        sessionId,
        boardType: 'kilter',
        climbUuid: CLIMB_UUID,
        angle: 40,
        userId: CLIMBER,
        seq: 1,
        identityPolicyVersion: 1,
        name: 'Climber chose this wall',
        confirmedAt: '2026-10-03T10:00:00Z',
      });
      expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });

  it('names that climber once the viewer joins the session, while the board itself stays anonymous (#6582)', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(STRANGER, 'Rebound garage');
      const sessionId = 'anon-boards-joined-rebind';
      await insertSession(sessionId, ownBoard.id);
      await seedSessionTicks(sessionId, ownBoard.id);
      await db.insert(dbSchema.resourcePrivacy).values({
        kind: 'board',
        resourceId: board.uuid,
        audience: 'invite_only',
        locationAudience: 'only_me',
      });
      await db.insert(dbSchema.resourceGrants).values({
        kind: 'board',
        resourceId: board.uuid,
        userId: CLIMBER,
        status: 'approved',
        invitedBy: STRANGER,
      });
      await db
        .update(dbSchema.boardSessions)
        .set({ boardId: board.id, boardPath: `/b/${board.slug}/40` })
        .where(eq(dbSchema.boardSessions.id, sessionId));
      expect(await rosterName(STRANGER, sessionId)).toBeNull();

      await db.insert(dbSchema.boardSessionParticipants).values({ sessionId, userId: STRANGER });
      expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
      expect((await redactQueueItem(queueItem, STRANGER, sessionId)).addedBy).toBe(CLIMBER);
      expect((await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(STRANGER)))?.ownerUserId).toBe(
        CLIMBER,
      );
      // The board's own Bluetooth holder is not a surface of the session.
      expect(await redactBoardHolder(holder, STRANGER, board.id)).toMatchObject({ userId: null, displayName: null });
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });

  it('requires explicit membership and current access for Followers and Only me boards', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(FRIEND, 'Members garage');
      const sessionId = 'anon-boards-followers-member';
      await insertSession(sessionId, board.id);
      await seedSessionTicks(sessionId, board.id);
      await db.insert(dbSchema.resourcePrivacy).values({
        kind: 'board',
        resourceId: board.uuid,
        audience: 'followers',
        locationAudience: 'only_me',
      });
      // Following the climber alone cannot restore the board-facing name.
      expect(await rosterName(FOLLOWER, sessionId)).toBeNull();
      await db.insert(dbSchema.resourceGrants).values({
        kind: 'board',
        resourceId: board.uuid,
        userId: STRANGER,
        status: 'approved',
      });
      expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
      await db
        .update(dbSchema.resourcePrivacy)
        .set({ audience: 'only_me' })
        .where(eq(dbSchema.resourcePrivacy.resourceId, board.uuid));
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      expect(await rosterName(FRIEND, sessionId)).toBe(CLIMBER);
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });

  it('never treats Public, Unlisted, deleted or config-only boards as private member spaces', async () => {
    await setPreference(true);
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    try {
      const board = await insertBoard(FRIEND, 'Link garage');
      const sessionId = 'anon-boards-unlisted-member';
      await insertSession(sessionId, board.id);
      await seedSessionTicks(sessionId, board.id);
      await db.insert(dbSchema.resourcePrivacy).values({
        kind: 'board',
        resourceId: board.uuid,
        audience: 'unlisted',
        locationAudience: 'only_me',
      });
      await db.insert(dbSchema.resourceGrants).values({
        kind: 'board',
        resourceId: board.uuid,
        userId: STRANGER,
        status: 'approved',
      });
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      expect(await rosterName(FRIEND, sessionId)).toBeNull();
      await db
        .update(dbSchema.resourcePrivacy)
        .set({ audience: 'public' })
        .where(eq(dbSchema.resourcePrivacy.resourceId, board.uuid));
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      await db
        .update(dbSchema.resourcePrivacy)
        .set({ audience: 'invite_only' })
        .where(eq(dbSchema.resourcePrivacy.resourceId, board.uuid));
      expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
      await db.update(dbSchema.userBoards).set({ deletedAt: new Date() }).where(eq(dbSchema.userBoards.id, board.id));
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      await db.update(dbSchema.boardSessions).set({ boardId: null }).where(eq(dbSchema.boardSessions.id, sessionId));
      expect(await rosterName(STRANGER, sessionId)).toBeNull();
      expect(await rosterName(CLIMBER, sessionId)).toBe(CLIMBER);
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });
});

describe('live surfaces', () => {
  it('unnames the Bluetooth holder on a board they do not own', async () => {
    await setPreference(true);
    expect(await redactBoardHolder(holder, STRANGER, gymBoard.id)).toMatchObject({ userId: null, displayName: null });
    expect(await redactBoardHolder(holder, STRANGER, ownBoard.id)).toEqual(holder);
    expect(await redactBoardHolder(holder, CLIMBER, gymBoard.id)).toEqual(holder);
  });

  it('keeps the opaque id in the roster of a session on the gym board, and on a config session bound live', async () => {
    await setPreference(true);
    await insertSession('anon-boards-gym-session', gymBoard.id);
    const [onGym] = await redactSessionUsers([rosterUser], STRANGER, 'anon-boards-gym-session');
    expect(onGym).toMatchObject({ userId: null, username: '', isLeader: true });
    expect(onGym.id).not.toBe(CLIMBER);
    expect((await redactSessionUsers([rosterUser], CLIMBER, 'anon-boards-gym-session'))[0].userId).toBe(CLIMBER);

    await insertSession('anon-boards-own-session', ownBoard.id);
    // Their own board names them once they act on it in this session.
    expect((await redactSessionUsers([rosterUser], STRANGER, 'anon-boards-own-session'))[0].userId).toBeNull();
    await seedClimberSessionTick('anon-boards-own-session', ownBoard.id);
    expect((await redactSessionUsers([rosterUser], STRANGER, 'anon-boards-own-session'))[0].userId).toBe(CLIMBER);

    // The gym and their own garage share this config. It cannot identify the
    // physical wall, so they remain anonymous until a concrete board places it.
    await insertSession('anon-boards-config-session', null);
    expect(await rosterName(STRANGER, 'anon-boards-config-session')).toBeNull();
    vi.spyOn(pubsub, 'getSessionBoard').mockResolvedValue(String(gymBoard.id));
    expect(await rosterName(STRANGER, 'anon-boards-config-session')).toBeNull();
  });

  it('keeps same-config foreign-wall sessions anonymous until an exact owned board identifies them', async () => {
    await setPreference(true);
    const sessionId = 'anon-boards-same-config-foreign';
    await insertSession(sessionId, null);
    for (const reader of [STRANGER, FOLLOWER]) {
      expect(await rosterName(reader, sessionId)).toBeNull();
      const projectedQueue = await redactQueueItem(queueItem, reader, sessionId);
      expect(projectedQueue.addedBy).toBeUndefined();
      expect(JSON.stringify(projectedQueue)).not.toContain('Climber Name');
    }
    expect(await rosterName(CLIMBER, sessionId)).toBe(CLIMBER);
    // Their send filed under their own board of this config does not place it.
    await seedClimberSessionTick(sessionId, ownBoard.id);
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    await db
      .update(dbSchema.boardSessions)
      .set({ boardId: ownBoard.id })
      .where(eq(dbSchema.boardSessions.id, sessionId));
    expect(await rosterName(STRANGER, sessionId)).toBe(CLIMBER);
    await db
      .update(dbSchema.boardSessions)
      .set({ boardId: gymBoard.id })
      .where(eq(dbSchema.boardSessions.id, sessionId));
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
  });

  it('fails closed on a session nothing places on a board, or whose binding cannot be read', async () => {
    await setPreference(true);
    // A config no board of theirs has, no binding, no tick: anonymous.
    await insertSession('anon-boards-unplaced', null, UNOWNED_CONFIG_PATH);
    expect(await rosterName(STRANGER, 'anon-boards-unplaced')).toBeNull();
    expect(await rosterName(CLIMBER, 'anon-boards-unplaced')).toBe(CLIMBER);
    await setPreference(false);
    expect(await rosterName(STRANGER, 'anon-boards-unplaced')).toBe(CLIMBER);
    await setPreference(true);

    // Redis down: no guessing from ticks.
    await insertSession('anon-boards-redis-down', null, UNOWNED_CONFIG_PATH);
    await seedClimberSessionTick('anon-boards-redis-down', gymBoard.id);
    vi.spyOn(pubsub, 'getSessionBoard').mockRejectedValue(new Error('redis down'));
    expect(await rosterName(STRANGER, 'anon-boards-redis-down')).toBeNull();
    vi.restoreAllMocks();
    // Redis back: the binding is empty and their newest send is on the gym wall.
    expect(await rosterName(STRANGER, 'anon-boards-redis-down')).toBeNull();
    // A newer send filed under their own garage says which config they hold, not
    // which wall they are at (saveTick files config-path sends there), so the
    // session stays on the gym wall and they stay anonymous.
    await db.insert(dbSchema.boardseshTicks).values({
      uuid: 'anon-boards-redis-down-own-garage',
      userId: CLIMBER,
      climbUuid: SESSION_CLIMB_UUID,
      boardType: 'kilter',
      angle: 40,
      status: 'send',
      difficulty: 20,
      climbedAt: '2026-10-05T10:00:00Z',
      boardId: ownBoard.id,
      sessionId: 'anon-boards-redis-down',
    });
    expect(await rosterName(STRANGER, 'anon-boards-redis-down')).toBeNull();
    await db.delete(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.sessionId, 'anon-boards-redis-down'));
    await seedClimberSessionTick('anon-boards-redis-down', ownBoard.id);
    expect(await rosterName(STRANGER, 'anon-boards-redis-down')).toBeNull();
  });

  it('judges a session on a spray wall they don’t own by its path', async () => {
    await setPreference(true);
    const wall = await insertBoard(FRIEND, 'Friend spray wall', {
      boardType: 'spray',
      layoutId: SPRAY_LAYOUT_ID,
      sizeId: SPRAY_LAYOUT_ID,
    });
    await db.insert(dbSchema.sprayWalls).values({ boardUuid: wall.uuid, layoutId: SPRAY_LAYOUT_ID });
    try {
      await insertSession('anon-boards-spray-session', null, `spray/${SPRAY_LAYOUT_ID}/${SPRAY_LAYOUT_ID}/1/40`);
      expect(await rosterName(STRANGER, 'anon-boards-spray-session')).toBeNull();
      expect(await rosterName(FRIEND, 'anon-boards-spray-session')).toBeNull();

      // A spray climb's logs are the wall's: unnamed there, with no note.
      await seedSessionTicks('anon-boards-spray-session', wall.id, 'spray', SPRAY_CLIMB_UUID);
      const logs = (reader: string) =>
        climbLogsQueries.climbLogs(
          undefined,
          { input: { boardType: 'spray', climbUuid: SPRAY_CLIMB_UUID } },
          viewer(reader),
        );
      const forStranger = await logs(STRANGER);
      expect(forStranger.items).toHaveLength(2);
      expect(forStranger.items.map((item) => item.userId)).not.toContain(CLIMBER);
      expect(forStranger.items.map((item) => item.userId)).toContain(OTHER_CLIMBER);
      expect(JSON.stringify(forStranger)).not.toContain('Climber Name');
      expect(JSON.stringify(forStranger)).not.toContain(`${CLIMBER} note`);
      expect((await logs(CLIMBER)).items.map((item) => item.userId)).toContain(CLIMBER);
    } finally {
      await db.delete(dbSchema.boardseshTicks).where(eq(dbSchema.boardseshTicks.climbUuid, SPRAY_CLIMB_UUID));
      await db.delete(dbSchema.sprayWalls).where(eq(dbSchema.sprayWalls.boardUuid, wall.uuid));
    }
  });

  it('drops who added and ticked a queue item in a session on the gym board', async () => {
    await setPreference(true);
    await insertSession('anon-boards-queue-session', gymBoard.id);
    const redacted = await redactQueueItem(queueItem, STRANGER, 'anon-boards-queue-session');
    expect(redacted.addedBy).toBeUndefined();
    expect(redacted.addedByUser).toBeUndefined();
    expect(redacted.tickedBy).toEqual([OTHER_CLIMBER]);
    expect((await redactQueueItem(queueItem, CLIMBER, 'anon-boards-queue-session')).addedBy).toBe(CLIMBER);
  });

  it('keeps the holder name off other phones’ Live Activity on the gym board', async () => {
    await setPreference(true);
    await insertSession('anon-boards-apns-session', gymBoard.id);
    const content = emptyLiveActivityContentState();
    const liveHolder = { holderUserId: CLIMBER, holderDisplayName: 'Climber Name' };

    const forPeer = await projectLiveActivityContent('anon-boards-apns-session', STRANGER, content, liveHolder);
    expect(forPeer.contentState.boardConnection).toBe('heldByPeer');
    expect(forPeer.contentState.holderDisplayName ?? '').toBe('');

    const forClimber = await projectLiveActivityContent('anon-boards-apns-session', CLIMBER, content, liveHolder);
    expect(forClimber.contentState.boardConnection).toBe('connectedByMe');

    // The session's board decides, as for its roster.
    await insertSession('anon-boards-apns-own', ownBoard.id);
    await seedClimberSessionTick('anon-boards-apns-own', ownBoard.id);
    const onOwnBoard = await projectLiveActivityContent('anon-boards-apns-own', STRANGER, content, liveHolder);
    expect(onOwnBoard.contentState.holderDisplayName).toBe('Climber Name');
  });
});

describe('a session on more than one board', () => {
  it('judges the board the session is on, never a board attached to it', async () => {
    await setPreference(true);
    // Their own garage, with the gym wall attached (a multi-board session, or a
    // wall the party moved off): named, on every surface of their own board.
    await insertSession('anon-boards-own-primary', ownBoard.id);
    await seedClimberSessionTick('anon-boards-own-primary', ownBoard.id);
    await db.insert(dbSchema.sessionBoards).values({ sessionId: 'anon-boards-own-primary', boardId: gymBoard.id });
    // The reverse: a session on the gym wall with their garage attached.
    await insertSession('anon-boards-gym-primary', gymBoard.id);
    await db.insert(dbSchema.sessionBoards).values({ sessionId: 'anon-boards-gym-primary', boardId: ownBoard.id });

    expect(await rosterName(STRANGER, 'anon-boards-own-primary')).toBe(CLIMBER);
    expect(await rosterName(STRANGER, 'anon-boards-gym-primary')).toBeNull();
    expect((await redactQueueItem(queueItem, STRANGER, 'anon-boards-own-primary')).addedBy).toBe(CLIMBER);
    expect((await redactQueueItem(queueItem, STRANGER, 'anon-boards-gym-primary')).addedBy).toBeUndefined();
    expect(await historySender(ownBoard.id, STRANGER)).toMatchObject({ sentByUserId: CLIMBER });
    expect(await historySender(gymBoard.id, STRANGER)).toMatchObject({ sentByUserId: null });

    // The session's own board decides even when a Bluetooth binding points at
    // the attached gym wall; the binding only places a session that names none.
    vi.spyOn(pubsub, 'getSessionBoard').mockResolvedValue(String(gymBoard.id));
    expect(await rosterName(STRANGER, 'anon-boards-own-primary')).toBe(CLIMBER);
  });
});

describe('the session payload', () => {
  it('places the session once and names nobody it shouldn’t: roster, queue and host', async () => {
    await setPreference(true);
    // Placed only by a binding, so each payload reads it, exactly once.
    await insertSession('anon-boards-payload', null, UNOWNED_CONFIG_PATH);
    const [sessionData] = await db
      .select()
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, 'anon-boards-payload'));
    const payloadFor = (reader: string) =>
      buildSessionPayload('anon-boards-payload', viewer(reader), {
        users: [rosterUser],
        queueState: { sequence: 1, stateHash: 'hash', queue: [queueItem], currentClimbQueueItem: queueItem },
        sessionData,
        lastConnectedBoardSerial: null,
        isLeader: false,
      });
    const sessionBoard = vi.spyOn(pubsub, 'getSessionBoard').mockResolvedValue(String(gymBoard.id));

    const forStranger = await payloadFor(STRANGER);
    expect(sessionBoard).toHaveBeenCalledTimes(1);
    expect(forStranger.createdByUserId).toBeNull();
    expect(forStranger.users[0]).toMatchObject({ userId: null, username: '' });
    expect(forStranger.queueState?.queue[0]).toMatchObject({ addedBy: undefined, tickedBy: [OTHER_CLIMBER] });
    expect(forStranger.queueState?.currentClimbQueueItem?.addedByUser).toBeUndefined();

    const forClimber = await payloadFor(CLIMBER);
    expect(forClimber.createdByUserId).toBe(CLIMBER);
    expect(forClimber.users[0].userId).toBe(CLIMBER);
    expect(forClimber.queueState?.queue[0].addedBy).toBe(CLIMBER);
    expect(sessionBoard).toHaveBeenCalledTimes(2);
  });
});

describe('a follower', () => {
  it('still sees the climber as anonymous on a board they don’t own: the preference beats the follow', async () => {
    await setPreference(true);
    await insertSession('anon-boards-follower-session', gymBoard.id);
    // Wall feed, recent senders, leaderboard and the Bluetooth holder.
    expect(await historySender(gymBoard.id, FOLLOWER)).toMatchObject({ sentByUserId: null, sentByDisplayName: null });
    const senders = await boardPresenceQueries.boardClimbRecentSenders(
      undefined,
      { boardId: gymBoard.id, climbUuid: CLIMB_UUID, angle: 40 },
      viewer(FOLLOWER),
    );
    expect(senders.map((sender) => sender.userId)).not.toContain(CLIMBER);
    const leaderboard = await socialBoardQueries.boardLeaderboard(
      null,
      { input: { boardUuid: gymBoard.uuid } },
      viewer(FOLLOWER),
    );
    expect(leaderboard.entries.map((entry) => entry.userId)).not.toContain(CLIMBER);
    expect(await redactBoardHolder(holder, FOLLOWER, gymBoard.id)).toMatchObject({ userId: null });
    // The live session: roster, queue and the Live Activity holder name.
    expect(await rosterName(FOLLOWER, 'anon-boards-follower-session')).toBeNull();
    expect((await redactQueueItem(queueItem, FOLLOWER, 'anon-boards-follower-session')).addedBy).toBeUndefined();
    const liveActivity = await projectLiveActivityContent(
      'anon-boards-follower-session',
      FOLLOWER,
      emptyLiveActivityContentState(),
      { holderUserId: CLIMBER, holderDisplayName: 'Climber Name' },
    );
    expect(liveActivity.contentState.holderDisplayName ?? '').toBe('');

    // On the climber's own board the follower sees their name, as everyone does.
    expect(await historySender(ownBoard.id, FOLLOWER)).toMatchObject({ sentByUserId: CLIMBER });
    expect(await redactBoardHolder(holder, FOLLOWER, ownBoard.id)).toEqual(holder);
  });
});

describe('nearby discovery', () => {
  const LATITUDE = 51.5;
  const LONGITUDE = -0.12;
  const nearbyHost = async (sessionId: string, reader: string) => {
    const nearby = await roomManager.findNearbySessions(LATITUDE, LONGITUDE, 10_000, reader);
    const session = nearby.find((candidate) => candidate.id === sessionId);
    expect(session).toBeDefined();
    return session?.createdByUserId ?? null;
  };
  /** A discoverable session the climber hosts on this path, with their phone connected. */
  const hostNearby = async (sessionId: string, boardPath: string) => {
    await roomManager.createDiscoverableSession(sessionId, boardPath, CLIMBER, LATITUDE, LONGITUDE, 'Board night');
    const connectionId = `anon-boards-nearby-${randomUUID()}`;
    await roomManager.registerClient(connectionId, 'Climber Name', CLIMBER);
    await roomManager.joinSession(connectionId, sessionId, boardPath);
  };

  it('unnames a host on a board they don’t own, to strangers and followers, and names them on their own', async () => {
    await setPreference(true);
    const onGym = randomUUID();
    const onOwn = randomUUID();
    const onConfig = randomUUID();
    await hostNearby(onGym, `/b/${gymBoard.slug}/40`);
    await hostNearby(onOwn, `/b/${ownBoard.slug}/40`);
    await hostNearby(onConfig, 'kilter/1/10/1/40');
    await seedClimberSessionTick(onOwn, ownBoard.id);

    expect(await nearbyHost(onGym, STRANGER)).toBeNull();
    expect(await nearbyHost(onGym, FOLLOWER)).toBeNull();
    expect(await nearbyHost(onGym, CLIMBER)).toBe(CLIMBER);
    expect(await nearbyHost(onOwn, STRANGER)).toBe(CLIMBER);
    // An owned matching layout still cannot identify the session's actual wall.
    expect(await nearbyHost(onConfig, STRANGER)).toBeNull();
    vi.spyOn(pubsub, 'getSessionBoard').mockImplementation(async (sessionId) =>
      sessionId === onConfig ? String(gymBoard.id) : null,
    );
    expect(await nearbyHost(onConfig, STRANGER)).toBeNull();

    // Joining makes the stranger a fellow member: the session names the host to
    // them, and nearby discovery, a listing, still does not.
    await db.insert(dbSchema.boardSessionParticipants).values({ sessionId: onGym, userId: STRANGER });
    expect(await rosterName(STRANGER, onGym)).toBe(CLIMBER);
    expect(await nearbyHost(onGym, STRANGER)).toBeNull();

    await setPreference(false);
    expect(await nearbyHost(onGym, STRANGER)).toBe(CLIMBER);
  });
});

describe('a board’s own feeds', () => {
  it('unnames the climber on the gym’s session cards (Home’s gym mode), to strangers and followers', async () => {
    await setPreference(true);
    await insertSession('anon-boards-gym-feed', gymBoard.id);
    await seedSessionTicks('anon-boards-gym-feed', gymBoard.id);
    await insertSession('anon-boards-own-feed', ownBoard.id);
    await seedSessionTicks('anon-boards-own-feed', ownBoard.id);
    const card = async (board: TestBoard, sessionId: string, reader: string) => {
      const feed = await sessionFeedQueries.sessionGroupedFeed(
        undefined,
        { input: { boardUuid: board.uuid } },
        viewer(reader),
      );
      return feed.sessions.find((session) => session.sessionId === sessionId);
    };

    for (const reader of [STRANGER, FOLLOWER]) {
      const onGym = await card(gymBoard, 'anon-boards-gym-feed', reader);
      expect(onGym).toMatchObject({ ownerUserId: null, totalSends: 2 });
      expect(onGym?.participants.map((participant) => participant.userId)).toEqual([OTHER_CLIMBER]);
      expect(onGym?.hardestSend?.userId ?? null).not.toBe(CLIMBER);
      expect(JSON.stringify(onGym)).not.toContain('Climber Name');
    }
    expect((await card(gymBoard, 'anon-boards-gym-feed', CLIMBER))?.ownerUserId).toBe(CLIMBER);
    const onOwn = await card(ownBoard, 'anon-boards-own-feed', STRANGER);
    expect(onOwn?.ownerUserId).toBe(CLIMBER);
    expect(onOwn?.participants.map((participant) => participant.userId)).toContain(CLIMBER);
  });

  it('unnames the climber on the gym’s trending sends', async () => {
    await setPreference(true);
    await insertSession('anon-boards-trending', gymBoard.id);
    await seedSessionTicks('anon-boards-trending', gymBoard.id);
    const trending = async (board: TestBoard, reader: string | null) =>
      (await activityFeedQueries.trendingFeed(undefined, { input: { boardUuid: board.uuid } }, viewer(reader))).items;

    const forStranger = await trending(gymBoard, STRANGER);
    expect(forStranger.map((item) => item.actorId)).toContain(OTHER_CLIMBER);
    expect(forStranger.map((item) => item.actorId)).not.toContain(CLIMBER);
    expect(JSON.stringify(forStranger)).not.toContain('Climber Name');
    expect(JSON.stringify(forStranger)).not.toContain(`${CLIMBER} note`);
    expect((await trending(gymBoard, FOLLOWER)).map((item) => item.actorId)).not.toContain(CLIMBER);
    expect((await trending(gymBoard, CLIMBER)).map((item) => item.actorId)).toContain(CLIMBER);
  });
});

describe('a live session’s detail, stats and summary', () => {
  it('keep the climber’s rows and counts under an opaque id on a board they don’t own', async () => {
    await setPreference(true);
    await insertSession('anon-boards-detail', gymBoard.id);
    await seedSessionTicks('anon-boards-detail', gymBoard.id);

    for (const reader of [STRANGER, FOLLOWER, null]) {
      const detail = await sessionFeedQueries.sessionDetail(
        undefined,
        { sessionId: 'anon-boards-detail' },
        viewer(reader),
      );
      expect(detail).toMatchObject({ ownerUserId: null, totalSends: 2, tickCount: 2 });
      expect(detail?.participants).toHaveLength(2);
      expect(detail?.ticks).toHaveLength(2);
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain(CLIMBER);
      expect(serialized).not.toContain('Climber Name');
      expect(detail?.participants.map((participant) => participant.userId)).toContain(OTHER_CLIMBER);

      const stats = await buildSessionStatsUpdatedEvent('anon-boards-detail', viewer(reader));
      expect(stats?.participants).toHaveLength(2);
      expect(JSON.stringify(stats)).not.toContain(CLIMBER);

      const summary = await generateSessionSummary('anon-boards-detail', reader);
      expect(summary?.totalSends).toBe(2);
      expect(summary?.participants.map((participant) => participant.userId)).toEqual(
        expect.arrayContaining([null, OTHER_CLIMBER]),
      );
      expect(JSON.stringify(summary)).not.toContain('Climber Name');
    }

    const own = await sessionFeedQueries.sessionDetail(undefined, { sessionId: 'anon-boards-detail' }, viewer(CLIMBER));
    expect(own?.ownerUserId).toBe(CLIMBER);
    expect(own?.ticks.map((tick) => tick.userId)).toContain(CLIMBER);
    expect(own?.ticks.find((tick) => tick.userId === CLIMBER)?.comment).toBe(`${CLIMBER} note`);
  });
});
