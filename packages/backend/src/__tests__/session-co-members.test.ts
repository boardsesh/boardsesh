/**
 * Real-DB coverage for #6582 (owner decision, 2026-10-19): sessions are for
 * friends, so a fellow member of a session (its host, or anyone who joined it)
 * sees everyone else in it by name on that session's own surfaces, private
 * accounts and "Stay anonymous on boards I don't own" included. Nothing changes
 * for anyone outside the session, or on the board's own surfaces.
 */
import { randomUUID } from 'node:crypto';
import { buildSchema, graphql, isObjectType } from 'graphql';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { typeDefs, type ClimbQueueItem, type ConnectionContext, type SessionUser } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { SYSTEM_BOARD_OWNER_ID } from '../graphql/resolvers/board-presence/shared';
import { boardSessionPrivacyResolvers } from '../graphql/resolvers/shared/board-session-privacy';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { buildSessionPayload } from '../graphql/resolvers/sessions/helpers';
import { sessionQueries } from '../graphql/resolvers/sessions/queries';
import { buildSessionStatsUpdatedEvent } from '../graphql/resolvers/sessions/live-session-stats';
import { generateSessionSummary } from '../graphql/resolvers/sessions/session-summary';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { redactBoardHolder, redactQueueItem, redactSessionUsers } from '../services/board-session-privacy';
import { projectLiveActivityContent } from '../services/apns/privacy';
import { emptyLiveActivityContentState } from '../services/apns/content-state';

const CLIMBER = 'co-members-climber';
const MEMBER = 'co-members-member';
const STRANGER = 'co-members-stranger';
const OUTSIDER = 'co-members-outsider';
const CLIMB_UUID = 'co-members-climb';
const CLIMBER_NAME = 'Climber Name';
const MEMBER_NAME = 'Member Name';

// One evening: the host starts at 10:00, the member joins at 10:05.
const STARTED_AT = '2026-10-10T10:00:00Z';
const JOINED_AT = '2026-10-10T10:05:00Z';
const IN_SESSION = '2026-10-10T10:30:00Z';

type TestBoard = { id: number; uuid: string; slug: string };
let gymBoard: TestBoard;
let otherWall: TestBoard;
/** Another board model (layout 8): not the config a `kilter/1/...` path names. */
let otherModel: TestBoard;

const viewer = (userId: string | null, sessionId?: string): ConnectionContext =>
  ({
    connectionId: `co-members-${userId ?? 'anon'}-${randomUUID()}`,
    isAuthenticated: !!userId,
    userId,
    sessionId,
  }) as ConnectionContext;

async function insertBoard(
  ownerId: string,
  name: string,
  gymId: number | null = null,
  layoutId = 1,
): Promise<TestBoard> {
  const uuid = randomUUID();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: `co-members-${uuid}`,
      ownerId,
      name,
      boardType: 'kilter',
      layoutId,
      sizeId: 10,
      setIds: '1',
      gymId,
      isPublic: true,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid, slug: dbSchema.userBoards.slug });
  return { id: Number(board.id), uuid: board.uuid, slug: board.slug };
}

async function setAccount(userId: string, settings: { isPrivate?: boolean; anonymous?: boolean }): Promise<void> {
  await db
    .update(dbSchema.userProfiles)
    .set({ isPrivate: settings.isPrivate ?? false, anonymousOnForeignBoards: settings.anonymous ?? false })
    .where(eq(dbSchema.userProfiles.userId, userId));
}

/** A live session the climber hosts on the gym wall. */
async function hostSession(
  options: {
    host?: string;
    boardId?: number | null;
    boardPath?: string;
    isPermanent?: boolean;
    endedAt?: string;
  } = {},
): Promise<string> {
  const sessionId = `co-members-${randomUUID()}`;
  const boardId = options.boardId === undefined ? gymBoard.id : options.boardId;
  await db.insert(dbSchema.boardSessions).values({
    id: sessionId,
    boardPath: options.boardPath ?? (boardId === gymBoard.id ? `/b/${gymBoard.slug}/40` : 'kilter/1/10/1/40'),
    createdByUserId: options.host ?? CLIMBER,
    boardId,
    isPublic: true,
    status: options.endedAt ? 'ended' : 'active',
    startedAt: new Date(STARTED_AT),
    endedAt: options.endedAt ? new Date(options.endedAt) : null,
    isPermanent: options.isPermanent ?? false,
  });
  return sessionId;
}

/** What `joinSession` records for a signed-in climber. */
async function join(sessionId: string, userId = MEMBER, joinedAt = JOINED_AT): Promise<void> {
  await db.insert(dbSchema.boardSessionParticipants).values({ sessionId, userId, joinedAt: new Date(joinedAt) });
}

async function logTick(
  sessionId: string,
  options: { userId?: string; boardId?: number | null; climbedAt?: string; difficulty?: number } = {},
): Promise<string> {
  const userId = options.userId ?? CLIMBER;
  const uuid = `co-members-tick-${randomUUID()}`;
  await db.insert(dbSchema.boardseshTicks).values({
    uuid,
    userId,
    climbUuid: CLIMB_UUID,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    difficulty: options.difficulty ?? (userId === CLIMBER ? 20 : 16),
    comment: `${userId} note`,
    climbedAt: options.climbedAt ?? IN_SESSION,
    boardId: options.boardId === undefined ? gymBoard.id : options.boardId,
    sessionId,
  });
  return uuid;
}

const rosterRow = (userId: string, username: string): SessionUser =>
  ({
    id: userId,
    userId,
    username,
    avatarUrl: `https://example.test/${userId}`,
    isLeader: userId === CLIMBER,
    connectionState: 'CONNECTED',
  }) as SessionUser;
const queueItem = {
  uuid: 'co-members-queue-item',
  addedBy: CLIMBER,
  addedByUser: { id: CLIMBER, username: CLIMBER_NAME },
  tickedBy: [CLIMBER],
  suggested: false,
  climb: {
    uuid: CLIMB_UUID,
    name: 'Co-members climb',
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
} as unknown as ClimbQueueItem;

const rosterName = async (reader: string, sessionId: string, row = rosterRow(CLIMBER, CLIMBER_NAME)) =>
  (await redactSessionUsers([row], reader, sessionId))[0].userId;

/** Every surface of the session, as the names and notes it shows this reader. */
async function sessionSurfaces(reader: string | null, sessionId: string) {
  const ctx = viewer(reader);
  const [sessionData] = await db.select().from(dbSchema.boardSessions).where(eq(dbSchema.boardSessions.id, sessionId));
  // The `session` query's payload, its invite preview included.
  const payload = await buildSessionPayload(sessionId, ctx, {
    users: [rosterRow(CLIMBER, CLIMBER_NAME)],
    queueState: { sequence: 1, stateHash: 'hash', queue: [queueItem], currentClimbQueueItem: null },
    sessionData,
    lastConnectedBoardSerial: null,
    isLeader: false,
  });
  const liveActivity = await projectLiveActivityContent(sessionId, reader, emptyLiveActivityContentState(), {
    holderUserId: CLIMBER,
    holderDisplayName: CLIMBER_NAME,
  });
  const detail = await sessionFeedQueries.sessionDetail(null, { sessionId }, ctx);
  const stats = await buildSessionStatsUpdatedEvent(sessionId, ctx);
  const summary = await generateSessionSummary(sessionId, reader);
  const card = (
    await sessionFeedQueries.sessionGroupedFeed(null, { input: { boardUuid: gymBoard.uuid } }, ctx)
  ).sessions.find((session) => session.sessionId === sessionId);
  return {
    payload,
    liveActivity: liveActivity.contentState,
    detail,
    stats,
    summary,
    card,
    serialized: JSON.stringify({ payload, liveActivity, detail, stats, summary, card }),
  };
}

function expectNamed(surfaces: Awaited<ReturnType<typeof sessionSurfaces>>, notesReadable: boolean): void {
  const { payload, liveActivity, detail, stats, summary, card } = surfaces;
  expect(payload.users[0]).toMatchObject({ userId: CLIMBER, username: CLIMBER_NAME });
  expect(payload.createdByUserId).toBe(CLIMBER);
  expect(payload.queueState?.queue[0]).toMatchObject({ addedBy: CLIMBER, tickedBy: [CLIMBER] });
  expect(liveActivity.holderDisplayName).toBe(CLIMBER_NAME);
  expect(detail?.ownerUserId).toBe(CLIMBER);
  expect(detail?.participants).toContainEqual(expect.objectContaining({ userId: CLIMBER, displayName: CLIMBER_NAME }));
  expect(detail?.ticks.find((tick) => tick.userId === CLIMBER)).toMatchObject({
    comment: notesReadable ? `${CLIMBER} note` : null,
  });
  expect(stats?.participants).toContainEqual(expect.objectContaining({ userId: CLIMBER }));
  expect(summary?.participants).toContainEqual(expect.objectContaining({ userId: CLIMBER, displayName: CLIMBER_NAME }));
  expect(card?.ownerUserId).toBe(CLIMBER);
  expect(card?.participants).toContainEqual(expect.objectContaining({ userId: CLIMBER, displayName: CLIMBER_NAME }));
  expect(card?.hardestSend).toMatchObject({ userId: CLIMBER, comment: notesReadable ? `${CLIMBER} note` : null });
}

function expectUnnamed(surfaces: Awaited<ReturnType<typeof sessionSurfaces>>): void {
  expect(surfaces.payload.users[0].userId).toBeNull();
  expect(surfaces.payload.queueState?.queue[0].addedBy).toBeUndefined();
  expect(surfaces.liveActivity.holderDisplayName ?? '').toBe('');
  expect(surfaces.serialized).not.toContain(CLIMBER);
  expect(surfaces.serialized).not.toContain(CLIMBER_NAME);
}

beforeAll(async () => {
  await db.insert(dbSchema.users).values(
    [CLIMBER, MEMBER, STRANGER, OUTSIDER, SYSTEM_BOARD_OWNER_ID].map((id) => ({
      id,
      email: `${id}@test.com`,
      name: id,
    })),
  );
  await db.insert(dbSchema.userProfiles).values([
    { userId: CLIMBER, displayName: CLIMBER_NAME },
    { userId: MEMBER, displayName: MEMBER_NAME },
    { userId: OUTSIDER, displayName: 'Outsider Name', isPrivate: true },
  ]);
  await db.insert(dbSchema.boardClimbs).values({
    uuid: CLIMB_UUID,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Co-members climb',
    isListed: true,
    isDraft: false,
    frames: 'p1r1',
  });
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid: randomUUID(), name: 'Co-members gym', ownerId: STRANGER })
    .returning({ id: dbSchema.gyms.id });
  gymBoard = await insertBoard(SYSTEM_BOARD_OWNER_ID, 'Gym wall', Number(gym.id));
  otherWall = await insertBoard(STRANGER, 'Another wall');
  otherModel = await insertBoard(STRANGER, 'Another model', null, 8);
});

beforeEach(async () => {
  await setAccount(CLIMBER, {});
  await setAccount(MEMBER, {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a fellow member of the session', () => {
  it.each([
    { account: 'a private account', settings: { isPrivate: true }, notesReadable: false },
    { account: 'an anonymous-on-foreign-boards climber', settings: { anonymous: true }, notesReadable: true },
    { account: 'a private, anonymous climber', settings: { isPrivate: true, anonymous: true }, notesReadable: false },
  ])('sees $account by name on every surface of the session', async ({ settings, notesReadable }) => {
    await setAccount(CLIMBER, settings);
    const sessionId = await hostSession();
    await join(sessionId);
    await logTick(sessionId);
    await logTick(sessionId, { userId: MEMBER, climbedAt: '2026-10-10T10:40:00Z' });

    expectNamed(await sessionSurfaces(MEMBER, sessionId), notesReadable);
    // Nobody outside the session gains a name: a stranger, or a signed-out reader
    // (the web page's server render, its OG card, a kiosk).
    expectUnnamed(await sessionSurfaces(STRANGER, sessionId));
    expectUnnamed(await sessionSurfaces(null, sessionId));
  });

  it('works both ways: the host sees a private member who joined', async () => {
    await setAccount(MEMBER, { isPrivate: true });
    const sessionId = await hostSession();
    await join(sessionId);
    expect(await rosterName(CLIMBER, sessionId, rosterRow(MEMBER, MEMBER_NAME))).toBe(MEMBER);
    expect(await rosterName(STRANGER, sessionId, rosterRow(MEMBER, MEMBER_NAME))).toBeNull();
  });

  it('keeps a private climber’s notes and clips to the tick’s own audience, and an Only me tick to themselves', async () => {
    await setAccount(CLIMBER, { isPrivate: true });
    const sessionId = await hostSession();
    await join(sessionId);
    const shown = await logTick(sessionId);
    await db.insert(dbSchema.boardBetaLinks).values({
      boardType: 'kilter',
      climbUuid: CLIMB_UUID,
      link: `https://www.instagram.com/p/${randomUUID()}`,
      isListed: true,
      tickUuid: shown,
      angle: 40,
    });
    const kept = await logTick(sessionId, { difficulty: 25, climbedAt: '2026-10-10T10:45:00Z' });
    await db
      .insert(dbSchema.contentPrivacy)
      .values({ entityType: 'tick', entityId: kept, ownerId: CLIMBER, audience: 'only_me' });

    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(MEMBER));
    expect(detail?.ticks.map((tick) => tick.uuid)).toEqual([shown]);
    expect(detail?.ticks[0]).toMatchObject({ userId: CLIMBER, comment: null, betaLinks: [] });
    const summary = await generateSessionSummary(sessionId, MEMBER);
    expect(summary?.participants).toEqual([expect.objectContaining({ userId: CLIMBER, attempts: 1, sends: 1 })]);
    // The Only me send is the session's hardest, so the card shows none.
    const card = (
      await sessionFeedQueries.sessionGroupedFeed(null, { input: { boardUuid: gymBoard.uuid } }, viewer(MEMBER))
    ).sessions.find((session) => session.sessionId === sessionId);
    expect(card?.hardestSend).toBeNull();
    expect(JSON.stringify({ detail, summary, card })).not.toContain(`${CLIMBER} note`);

    // A climber whose ticks the member may read keeps the note and the clip there.
    await setAccount(CLIMBER, { anonymous: true });
    const readable = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(MEMBER));
    expect(readable?.ticks.find((tick) => tick.uuid === shown)).toMatchObject({
      userId: CLIMBER,
      comment: `${CLIMBER} note`,
      betaLinks: [expect.objectContaining({ climbUuid: CLIMB_UUID })],
    });
    expect(readable?.ticks.map((tick) => tick.uuid)).not.toContain(kept);
  });

  it('releases only ticks from the climber’s time in the session, on its boards', async () => {
    await setAccount(CLIMBER, { isPrivate: true });
    await setAccount(MEMBER, { isPrivate: true });
    const sessionId = await hostSession({ endedAt: '2026-10-10T12:00:00Z' });
    await join(sessionId);
    const inSession = await logTick(sessionId);
    // Reconciliation stamps the session id on a climber's whole run of ticks
    // with gaps of 8 h or less: another wall, well before the session started,
    // well after it ended.
    const otherWallTick = await logTick(sessionId, { boardId: otherWall.id });
    const beforeStart = await logTick(sessionId, { climbedAt: '2026-10-10T09:00:00Z', difficulty: 25 });
    const afterEnd = await logTick(sessionId, { climbedAt: '2026-10-10T13:00:00Z' });
    // A member's own time starts when they joined (15 minutes before is beyond any clock drift).
    const beforeJoining = await logTick(sessionId, { userId: MEMBER, climbedAt: '2026-10-10T09:50:00Z' });
    const memberInSession = await logTick(sessionId, { userId: MEMBER, climbedAt: '2026-10-10T10:40:00Z' });

    const forMember = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(MEMBER));
    const climberTicks = forMember?.ticks.filter((tick) => tick.userId === CLIMBER).map((tick) => tick.uuid);
    expect(climberTicks).toEqual([inSession]);
    expect(JSON.stringify(forMember)).not.toContain(otherWallTick);
    expect(JSON.stringify(forMember)).not.toContain(beforeStart);
    expect(JSON.stringify(forMember)).not.toContain(afterEnd);
    expect((await generateSessionSummary(sessionId, MEMBER))?.participants).toContainEqual(
      expect.objectContaining({ userId: CLIMBER, attempts: 1 }),
    );
    // The hardest send on the gym wall is the one from before the session started.
    const card = (
      await sessionFeedQueries.sessionGroupedFeed(null, { input: { boardUuid: gymBoard.uuid } }, viewer(MEMBER))
    ).sessions.find((session) => session.sessionId === sessionId);
    expect(card?.hardestSend).toBeNull();

    const forHost = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(CLIMBER));
    expect(forHost?.ticks.filter((tick) => tick.userId === MEMBER).map((tick) => tick.uuid)).toEqual([memberInSession]);
    expect(JSON.stringify(forHost)).not.toContain(beforeJoining);
  });

  it('allows ten minutes of clock drift on the session’s boards, and none anywhere else', async () => {
    await setAccount(CLIMBER, { isPrivate: true });
    await setAccount(MEMBER, { isPrivate: true });
    const sessionId = await hostSession({ endedAt: '2026-10-10T12:00:00Z' });
    await join(sessionId);
    // Five minutes before the member joined, five minutes after the session ended.
    const earlyOnWall = await logTick(sessionId, { userId: MEMBER, climbedAt: '2026-10-10T10:00:00Z' });
    const lateOnWall = await logTick(sessionId, { climbedAt: '2026-10-10T12:05:00Z' });
    const earlyElsewhere = await logTick(sessionId, {
      userId: MEMBER,
      boardId: otherWall.id,
      climbedAt: '2026-10-10T10:00:00Z',
    });
    const lateElsewhere = await logTick(sessionId, { boardId: otherWall.id, climbedAt: '2026-10-10T12:05:00Z' });

    const forMember = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(MEMBER));
    expect(forMember?.ticks.filter((tick) => tick.userId === CLIMBER).map((tick) => tick.uuid)).toEqual([lateOnWall]);
    expect(JSON.stringify(forMember)).not.toContain(lateElsewhere);
    const forHost = await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(CLIMBER));
    expect(forHost?.ticks.filter((tick) => tick.userId === MEMBER).map((tick) => tick.uuid)).toEqual([earlyOnWall]);
    expect(JSON.stringify(forHost)).not.toContain(earlyElsewhere);

    // A config path names no wall, so its window gets no grace.
    const configPath = await hostSession({ boardId: null, endedAt: '2026-10-10T12:00:00Z' });
    await join(configPath);
    const inWindow = await logTick(configPath, { boardId: otherWall.id });
    await logTick(configPath, { boardId: otherWall.id, climbedAt: '2026-10-10T09:55:00Z' });
    await logTick(configPath, { boardId: otherWall.id, climbedAt: '2026-10-10T12:05:00Z' });
    expect(
      (await sessionFeedQueries.sessionDetail(null, { sessionId: configPath }, viewer(MEMBER)))?.ticks.map(
        (tick) => tick.uuid,
      ),
    ).toEqual([inWindow]);
  });

  it('releases a config-path session’s ticks only from a board of that config', async () => {
    await setAccount(CLIMBER, { isPrivate: true });
    const configPath = await hostSession({ boardId: null });
    await join(configPath);
    const onThatConfig = await logTick(configPath, { boardId: otherWall.id });
    // Reconciliation can stamp the session id on a boardless or imported tick,
    // and on a send from another board model, inside the same window.
    const boardless = await logTick(configPath, { boardId: null });
    const otherConfig = await logTick(configPath, { boardId: otherModel.id });

    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: configPath }, viewer(MEMBER));
    expect(detail?.ticks.map((tick) => tick.uuid)).toEqual([onThatConfig]);
    expect(JSON.stringify(detail)).not.toContain(boardless);
    expect(JSON.stringify(detail)).not.toContain(otherConfig);
    expect((await generateSessionSummary(configPath, MEMBER))?.participants).toEqual([
      expect.objectContaining({ userId: CLIMBER, attempts: 1 }),
    ]);
  });

  it('counts every board the session was on, and only the time window on a config path with no board', async () => {
    await setAccount(CLIMBER, { isPrivate: true });
    const moved = await hostSession();
    await db.insert(dbSchema.sessionBoards).values({ sessionId: moved, boardId: otherWall.id });
    await join(moved);
    const onAttachedWall = await logTick(moved, { boardId: otherWall.id });
    expect(
      (await sessionFeedQueries.sessionDetail(null, { sessionId: moved }, viewer(MEMBER)))?.ticks.map(
        (tick) => tick.uuid,
      ),
    ).toEqual([onAttachedWall]);

    const configPath = await hostSession({ boardId: null });
    await join(configPath);
    const anyWall = await logTick(configPath, { boardId: otherWall.id });
    await logTick(configPath, { boardId: otherWall.id, climbedAt: '2026-10-10T09:00:00Z' });
    expect(
      (await sessionFeedQueries.sessionDetail(null, { sessionId: configPath }, viewer(MEMBER)))?.ticks.map(
        (tick) => tick.uuid,
      ),
    ).toEqual([anyWall]);
  });

  it('names the Live Activity holder only when the holder is a member too', async () => {
    const sessionId = await hostSession();
    await join(sessionId);
    await setAccount(CLIMBER, { isPrivate: true });
    const holderName = async (holderUserId: string, holderDisplayName: string) =>
      (
        await projectLiveActivityContent(sessionId, MEMBER, emptyLiveActivityContentState(), {
          holderUserId,
          holderDisplayName,
        })
      ).contentState.holderDisplayName ?? '';
    expect(await holderName(CLIMBER, CLIMBER_NAME)).toBe(CLIMBER_NAME);
    expect(await holderName(OUTSIDER, 'Outsider Name')).toBe('');
  });

  it('keeps the board’s own surfaces anonymous', async () => {
    await setAccount(CLIMBER, { anonymous: true });
    const sessionId = await hostSession();
    await join(sessionId);
    await logTick(sessionId);
    await db.insert(dbSchema.boardClimbEvents).values({
      boardId: gymBoard.id,
      sessionId,
      boardType: 'kilter',
      climbUuid: CLIMB_UUID,
      angle: 40,
      userId: CLIMBER,
      identityPolicyVersion: 1,
      seq: 1,
      name: 'Co-members climb',
      confirmedAt: IN_SESSION,
    });
    // A fellow member, so the session itself names the climber to them…
    expect(await rosterName(MEMBER, sessionId)).toBe(CLIMBER);
    // …while the wall's history, recent senders, leaderboard and Bluetooth holder do not.
    const history = await boardPresenceQueries.boardHistory(undefined, { boardId: gymBoard.id }, viewer(MEMBER));
    expect(history.length).toBeGreaterThan(0);
    expect(history.map((row) => row.sentByUserId)).not.toContain(CLIMBER);
    const senders = await boardPresenceQueries.boardClimbRecentSenders(
      undefined,
      { boardId: gymBoard.id, climbUuid: CLIMB_UUID, angle: 40 },
      viewer(MEMBER),
    );
    expect(senders.map((sender) => sender.userId)).not.toContain(CLIMBER);
    const leaderboard = await socialBoardQueries.boardLeaderboard(
      null,
      { input: { boardUuid: gymBoard.uuid } },
      viewer(MEMBER),
    );
    expect(leaderboard.entries.map((entry) => entry.userId)).not.toContain(CLIMBER);
    expect(JSON.stringify({ history, senders, leaderboard })).not.toContain(CLIMBER_NAME);
    expect(
      await redactBoardHolder({ userId: CLIMBER, displayName: CLIMBER_NAME, avatarUrl: null }, MEMBER, gymBoard.id),
    ).toMatchObject({ userId: null, displayName: null });
  });
});

describe('who counts as a member', () => {
  it('keeps names through a narrowing to Followers, and drops them with access', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    await setAccount(CLIMBER, { isPrivate: true });
    const sessionId = await hostSession();
    await join(sessionId);
    const narrow = (audience: 'followers' | 'only_me') =>
      privacyMutations.updateResourcePrivacy(
        null,
        { input: { kind: 'session', resourceId: sessionId, audience } },
        viewer(CLIMBER),
      );

    // Followers keeps everyone who already joined: they get approved grants.
    await narrow('followers');
    expect(await rosterName(MEMBER, sessionId)).toBe(CLIMBER);
    // Only me takes the session away from them, and its invite preview names nobody.
    await narrow('only_me');
    expect(await rosterName(MEMBER, sessionId)).toBeNull();
    expect((await sessionSurfaces(MEMBER, sessionId)).payload.users[0].userId).toBeNull();
  });

  it('drops a member the host removes, both ways', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    await setAccount(CLIMBER, { isPrivate: true });
    await setAccount(MEMBER, { isPrivate: true });
    const sessionId = await hostSession();
    await join(sessionId);
    const memberRow = rosterRow(MEMBER, MEMBER_NAME);
    expect(await rosterName(MEMBER, sessionId)).toBe(CLIMBER);
    expect(await rosterName(CLIMBER, sessionId, memberRow)).toBe(MEMBER);

    await privacyMutations.revokeResourceAccess(
      null,
      { kind: 'session', resourceId: sessionId, userId: MEMBER },
      viewer(CLIMBER),
    );
    expect(await rosterName(MEMBER, sessionId)).toBeNull();
    // The host can still open the session, and no longer sees the removed member's name.
    expect(await rosterName(CLIMBER, sessionId, memberRow)).toBeNull();
  });

  it('never counts a stranger who only logged a tick against the session, a permanent session or a signed-out reader', async () => {
    await setAccount(CLIMBER, { isPrivate: true });
    const sessionId = await hostSession();
    await logTick(sessionId, { userId: STRANGER });
    expect(await rosterName(STRANGER, sessionId)).toBeNull();
    expect(JSON.stringify(await sessionFeedQueries.sessionDetail(null, { sessionId }, viewer(STRANGER)))).not.toContain(
      CLIMBER,
    );

    const permanent = await hostSession({ isPermanent: true });
    await join(permanent);
    expect(await rosterName(MEMBER, permanent)).toBeNull();

    const open = await hostSession();
    await join(open);
    expect((await redactSessionUsers([rosterRow(CLIMBER, CLIMBER_NAME)], null, open))[0].userId).toBeNull();
  });

  it('names nobody through another session they share', async () => {
    await setAccount(CLIMBER, { anonymous: true });
    // Fellow members in one session…
    const shared = await hostSession();
    await join(shared);
    expect(await rosterName(MEMBER, shared)).toBe(CLIMBER);
    // …and the climber, anonymous, in a stranger's session on the gym wall.
    const elsewhere = await hostSession({ host: STRANGER });
    await join(elsewhere, CLIMBER);
    await logTick(elsewhere);

    // The member's connection is joined to the shared session.
    const onShared = viewer(MEMBER, shared);
    const [sessionData] = await db
      .select()
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, elsewhere));
    const preview = await buildSessionPayload(elsewhere, onShared, {
      users: [rosterRow(CLIMBER, CLIMBER_NAME)],
      queueState: { sequence: 1, stateHash: 'hash', queue: [queueItem], currentClimbQueueItem: null },
      sessionData,
      lastConnectedBoardSerial: null,
      isLeader: false,
    });
    expect(preview.users[0].userId).toBeNull();
    expect(preview.queueState?.queue[0].addedBy).toBeUndefined();
    // Its GraphQL fields judge each object by the session it came from, not the connection's.
    const fields = boardSessionPrivacyResolvers;
    expect(await fields.SessionUser.userId(preview.users[0], undefined, onShared)).toBeNull();
    expect(await fields.SessionUser.username(preview.users[0], undefined, onShared)).toBe('');
    expect(await fields.ClimbQueueItem.addedBy(preview.queueState!.queue[0], undefined, onShared)).toBeUndefined();
    // Objects projected for someone who may name the climber there (the climber
    // themselves) are rechecked for this reader against that same session.
    const [retainedRow] = await redactSessionUsers([rosterRow(CLIMBER, CLIMBER_NAME)], CLIMBER, elsewhere);
    expect(retainedRow.userId).toBe(CLIMBER);
    expect(await fields.SessionUser.userId(retainedRow, undefined, onShared)).toBeNull();
    const retainedItem = await redactQueueItem(queueItem, CLIMBER, elsewhere);
    expect(retainedItem.addedBy).toBe(CLIMBER);
    expect(await fields.ClimbQueueItem.addedBy(retainedItem, undefined, onShared)).toBeUndefined();
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: elsewhere }, viewer(MEMBER));
    expect(JSON.stringify(detail)).not.toContain(CLIMBER);
  });
});

/** The real `sessionSummary` resolver and `SessionParticipant` field resolvers on the shipped schema. */
function summaryGraphSchema() {
  const graphSchema = buildSchema(typeDefs.join('\n'));
  const query = graphSchema.getQueryType();
  const participant = graphSchema.getType('SessionParticipant');
  if (!query || !isObjectType(participant)) throw new Error('Session summary GraphQL types missing');
  query.getFields().sessionSummary.resolve = sessionQueries.sessionSummary;
  for (const [fieldName, resolver] of Object.entries(boardSessionPrivacyResolvers.SessionParticipant)) {
    participant.getFields()[fieldName].resolve = resolver;
  }
  return graphSchema;
}

describe('the session summary through GraphQL', () => {
  const summaryQuery = `query Summary($sessionId: ID!) {
    sessionSummary(sessionId: $sessionId) { participants { userId displayName avatarUrl sends } }
  }`;
  const summaryFor = async (reader: string, sessionId: string) => {
    const result = await graphql({
      schema: summaryGraphSchema(),
      source: summaryQuery,
      variableValues: { sessionId },
      contextValue: viewer(reader),
    });
    expect(result.errors).toBeUndefined();
    return (
      result.data as { sessionSummary: { participants: { userId: string | null; displayName: string | null }[] } }
    ).sessionSummary.participants;
  };

  it('keeps a private member’s name for a fellow member, and blanks it for a stranger', async () => {
    await setAccount(CLIMBER, { isPrivate: true });
    const sessionId = await hostSession();
    await join(sessionId);
    await logTick(sessionId);
    await logTick(sessionId, { userId: MEMBER, climbedAt: '2026-10-10T10:40:00Z' });

    expect(await summaryFor(MEMBER, sessionId)).toContainEqual(
      expect.objectContaining({ userId: CLIMBER, displayName: CLIMBER_NAME }),
    );
    const forStranger = await summaryFor(STRANGER, sessionId);
    expect(JSON.stringify(forStranger)).not.toContain(CLIMBER);
    expect(JSON.stringify(forStranger)).not.toContain(CLIMBER_NAME);
  });
});
