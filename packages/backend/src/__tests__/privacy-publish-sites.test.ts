import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub';
import { logger } from '../utils/logger';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { socialFollowMutations } from '../graphql/resolvers/social/follows';
import { setterFollowMutations } from '../graphql/resolvers/social/setter-follows';
import { socialCommentMutations } from '../graphql/resolvers/social/comments';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { reconcileInferredSessions } from '../services/inferred-sessions/reconcile';
import { ensureSessionRecordExists } from '../services/room-manager/client-lifecycle';
import { updateSessionBoardPathIfChanged } from '../services/room-manager/session-discovery';
import { getPrivacySettings } from '../services/privacy';
import { resetAllRateLimits } from '../utils/rate-limiter';

vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => undefined),
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));

/**
 * Every privacyChanged event makes every connected app withdraw and refetch its
 * protected queries, so only a change in who may read something publishes.
 * Follows, renames and session regrouping must stay silent.
 */
const owner = 'privacy-publish-owner';
const privateOwner = 'privacy-publish-private';
const follower = 'privacy-publish-follower';
const member = 'privacy-publish-member';
const settingsUser = 'privacy-publish-settings';
const climber = 'privacy-publish-climber';
const setter = 'privacy-publish-setter';
const leaver = 'privacy-publish-leaver';
const users = [owner, privateOwner, follower, member, settingsUser, climber, setter, leaver];
const climbUuid = 'privacy-publish-climb';
const setterName = 'privacy-publish-setter-name';

const HOUR = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 4, 12, 9, 0, 0);
const iso = (epochMs: number) => new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');

const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `privacy-publish-${userId}` }) as ConnectionContext;

/** The sources published while `action` ran, in order. */
async function publishesDuring(action: () => Promise<unknown>): Promise<Array<string | undefined>> {
  const publish = vi.spyOn(pubsub, 'publishPrivacyChanged');
  try {
    await action();
    return publish.mock.calls.map(([source]) => source);
  } finally {
    publish.mockRestore();
  }
}

async function insertBoard(isPublic: boolean): Promise<{ id: number; uuid: string; slug: string }> {
  const uuid = randomUUID();
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid,
      slug: `privacy-publish-${uuid}`,
      ownerId: owner,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      name: 'Publish test wall',
      isPublic,
    })
    .returning({ id: schema.userBoards.id, uuid: schema.userBoards.uuid, slug: schema.userBoards.slug });
  return { id: Number(board.id), uuid: board.uuid, slug: board.slug };
}

async function insertTick(climbedAtMs: number): Promise<string> {
  const uuid = randomUUID();
  await db.insert(schema.boardseshTicks).values({
    uuid,
    userId: climber,
    boardType: 'kilter',
    climbUuid,
    angle: 40,
    status: 'send',
    attemptCount: 1,
    climbedAt: iso(climbedAtMs),
  });
  await db.transaction((tx) => reconcileInferredSessions(tx, climber, new Date(climbedAtMs)));
  return uuid;
}

async function climberSessionIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sessionId: schema.boardseshTicks.sessionId })
    .from(schema.boardseshTicks)
    .where(and(eq(schema.boardseshTicks.userId, climber), isNotNull(schema.boardseshTicks.sessionId)));
  return rows.map((row) => row.sessionId!);
}

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values(users.map((id) => ({ id, email: `${id}@test.com` })));
  await db.insert(schema.userProfiles).values({ userId: privateOwner, isPrivate: true });
  await db.insert(schema.boardClimbs).values({
    uuid: climbUuid,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Publish test climb',
    setterUsername: setterName,
    frames: 'p1r1',
    framesCount: 1,
    isDraft: false,
    isListed: true,
    edgeLeft: 0,
    edgeRight: 100,
    edgeBottom: 0,
    edgeTop: 150,
  });
  await db.insert(schema.userBoardMappings).values({ userId: setter, boardType: 'kilter', boardUsername: setterName });
});
beforeEach(() => resetAllRateLimits());
afterEach(() => {
  delete process.env.INFERRED_SESSIONS_ENABLED;
});
afterAll(() => vi.unstubAllEnvs());

describe('privacyChanged publish sites', () => {
  it('stays silent for follows, unfollows and follow requests', async () => {
    expect(
      await publishesDuring(() =>
        socialFollowMutations.followUser(null, { input: { userId: owner } }, context(follower)),
      ),
    ).toEqual([]);
    const [follow] = await db
      .select()
      .from(schema.userFollows)
      .where(and(eq(schema.userFollows.followerId, follower), eq(schema.userFollows.followingId, owner)));
    expect(follow).toBeDefined();
    expect(
      await publishesDuring(() =>
        socialFollowMutations.unfollowUser(null, { input: { userId: owner } }, context(follower)),
      ),
    ).toEqual([]);
    expect(
      await publishesDuring(() => privacyMutations.requestFollow(null, { userId: privateOwner }, context(follower))),
    ).toEqual([]);
    expect(
      await publishesDuring(() =>
        privacyMutations.cancelFollowRequest(null, { userId: privateOwner }, context(follower)),
      ),
    ).toEqual([]);
    await privacyMutations.requestFollow(null, { userId: privateOwner }, context(member));
    expect(
      await publishesDuring(() =>
        privacyMutations.declineFollowRequest(null, { userId: member }, context(privateOwner)),
      ),
    ).toEqual([]);
  });

  it('publishes once when access to an account is granted or withdrawn, never for a no-op', async () => {
    await privacyMutations.requestFollow(null, { userId: privateOwner }, context(follower));
    expect(
      await publishesDuring(() =>
        privacyMutations.approveFollowRequest(null, { userId: follower }, context(privateOwner)),
      ),
    ).toEqual(['approveFollowRequest']);
    expect(
      await publishesDuring(() =>
        privacyMutations.approveFollowRequest(null, { userId: follower }, context(privateOwner)),
      ),
    ).toEqual([]);
    expect(
      await publishesDuring(() => privacyMutations.removeFollower(null, { userId: follower }, context(privateOwner))),
    ).toEqual(['removeFollower']);
    expect(
      await publishesDuring(() => privacyMutations.removeFollower(null, { userId: follower }, context(privateOwner))),
    ).toEqual([]);
  });

  it('publishes account settings only when the account switch flips', async () => {
    // The settings and onboarding screens always send all three fields. A
    // pre-privacy account has no stored session default, so the first save
    // changes it from NULL; that alone must not publish.
    const save = (isPrivate: boolean, defaultSessionAudience: string) =>
      publishesDuring(() =>
        privacyMutations.updatePrivacySettings(
          null,
          { input: { isPrivate, defaultSessionAudience, privacyOnboardingVersion: 1 } },
          context(settingsUser),
        ),
      );
    expect(await save(false, 'public')).toEqual([]);
    expect(
      await publishesDuring(() =>
        privacyMutations.updatePrivacySettings(
          null,
          { input: { defaultSessionAudience: 'only_me' } },
          context(settingsUser),
        ),
      ),
    ).toEqual([]);
    const info = vi.spyOn(logger, 'info');
    try {
      expect(await save(true, 'followers')).toEqual(['updatePrivacySettings']);
      expect(info).toHaveBeenCalledWith(
        '[Privacy] privacyChanged published',
        expect.objectContaining({ source: 'updatePrivacySettings', count: expect.any(Number) }),
      );
    } finally {
      info.mockRestore();
    }
    expect(await save(true, 'followers')).toEqual([]);
    expect(await save(false, 'public')).toEqual(['updatePrivacySettings']);
  });

  it('publishes a board edit only when its audience or location changes', async () => {
    const board = await insertBoard(true);
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        socialBoardMutations.updateBoard(null, { input: { boardUuid: board.uuid, ...input } }, context(owner)),
      );
    expect(await edit({ name: 'Renamed wall' })).toEqual([]);
    // Old edit screens resend every visibility boolean with a rename.
    expect(await edit({ name: 'Renamed again', isPublic: true, hideLocation: false })).toEqual([]);
    expect(await edit({ description: 'New description' })).toEqual([]);
    expect(await edit({ isPublic: false })).toEqual(['updateBoard']);
    expect(await edit({ hideLocation: true })).toEqual(['updateBoard']);
  });

  it('publishes a session edit only when its visibility flips', async () => {
    const sessionId = randomUUID();
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, createdByUserId: owner, boardPath: 'kilter/1/1/1/40', isPublic: true });
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        sessionEditMutations.updateSession(null, { input: { sessionId, ...input } }, context(owner)),
      );
    expect(await edit({ notes: 'Warm-up felt good' })).toEqual([]);
    expect(await edit({ name: 'Tuesday', notes: 'Edited', isPublic: true })).toEqual([]);
    expect(await edit({ isPublic: false })).toEqual(['updateSession']);
  });

  it('publishes a wall switch only when the new wall restricts who can read the session', async () => {
    const first = await insertBoard(true);
    const second = await insertBoard(true);
    const home = await insertBoard(false);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, `/b/${first.slug}/40`, owner);
    const switchTo = (board: { slug: string }) =>
      publishesDuring(() => updateSessionBoardPathIfChanged(sessionId, `/b/${board.slug}/40`, owner));
    // Everyone can read a public wall, so moving there takes nothing away.
    expect(await switchTo(second)).toEqual([]);
    const [session] = await db
      .select({ boardId: schema.boardSessions.boardId })
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, sessionId));
    expect(session.boardId).toBe(second.id);
    // A private wall becomes a cap: viewers who cannot read it lose the session.
    expect(await switchTo(home)).toEqual(['switchSessionWall']);
    // Back onto a wall the session already references: no new cap.
    expect(await switchTo(first)).toEqual([]);
  });

  it('still publishes a restrictive wall switch and a revoke when the preview refresh fails', async () => {
    const first = await insertBoard(true);
    const home = await insertBoard(false);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, `/b/${first.slug}/40`, owner);
    // The move and the revoke have committed before the public-preview refresh
    // runs, so the publish must already be out when the refresh fails.
    const publishedDespite = async (fault: { mockRestore: () => void }, action: () => Promise<unknown>) => {
      let failure: unknown = null;
      try {
        const sources = await publishesDuring(() =>
          action().catch((error: unknown) => {
            failure = error;
          }),
        );
        expect(failure).toBeInstanceOf(Error);
        return sources;
      } finally {
        fault.mockRestore();
      }
    };
    // The session preview refresh starts with a Redis read of the session's wall.
    const redisDown = vi.spyOn(pubsub, 'getSessionBoard').mockRejectedValue(new Error('redis down'));
    expect(
      await publishedDespite(redisDown, () => updateSessionBoardPathIfChanged(sessionId, `/b/${home.slug}/40`, owner)),
    ).toEqual(['switchSessionWall']);
    // A board's preview refresh publishes a tombstone to the kiosks.
    const tombstoneFails = vi.spyOn(pubsub, 'publishBoardQueuePreview').mockImplementation(() => {
      throw new Error('preview publish failed');
    });
    expect(
      await publishedDespite(tombstoneFails, () =>
        privacyMutations.revokeResourceAccess(
          null,
          { kind: 'board', resourceId: first.uuid, userId: member },
          context(owner),
        ),
      ),
    ).toEqual(['revokeResourceAccess']);
  });

  it('decides a wall switch after an edit to that wall that was still in flight', async () => {
    const start = await insertBoard(true);
    const target = await insertBoard(true);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, `/b/${start.slug}/40`, owner);

    // A board edit making the target private, written but not yet committed.
    let commitEdit = () => {};
    const editMayCommit = new Promise<void>((resolve) => {
      commitEdit = resolve;
    });
    let markEditWritten = () => {};
    const editWritten = new Promise<void>((resolve) => {
      markEditWritten = resolve;
    });
    const edit = db.transaction(async (transaction) => {
      await transaction.update(schema.userBoards).set({ isPublic: false }).where(eq(schema.userBoards.id, target.id));
      markEditWritten();
      await editMayCommit;
    });
    await editWritten;

    let switched = false;
    const publishes = publishesDuring(async () => {
      await updateSessionBoardPathIfChanged(sessionId, `/b/${target.slug}/40`, owner);
      switched = true;
    });
    // The switch reads the wall under its row lock, so it waits for the edit
    // instead of deciding on the public row the edit is about to replace.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(switched).toBe(false);
    commitEdit();
    await edit;
    expect(await publishes).toEqual(['switchSessionWall']);
  });

  it('publishes a playlist edit only when its visibility flips', async () => {
    const uuid = randomUUID();
    const [playlist] = await db
      .insert(schema.playlists)
      .values({ uuid, boardType: 'kilter', name: 'Projects', isPublic: true })
      .returning();
    await db.insert(schema.playlistOwnership).values({ playlistId: playlist.id, userId: owner, role: 'owner' });
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        playlistMutations.updatePlaylist(null, { input: { playlistId: uuid, ...input } }, context(owner)),
      );
    expect(await edit({ name: 'Summer projects', isPublic: true })).toEqual([]);
    expect(await edit({ isPublic: false })).toEqual(['updatePlaylist']);
  });

  it('publishes resource access decisions, not access requests', async () => {
    const board = await insertBoard(false);
    const resource = { kind: 'board' as const, resourceId: board.uuid };
    expect(
      await publishesDuring(() =>
        privacyMutations.updateResourcePrivacy(
          null,
          { input: { ...resource, audience: 'invite_only' } },
          context(owner),
        ),
      ),
    ).toEqual(['updateResourcePrivacy']);
    expect(
      await publishesDuring(() => privacyMutations.requestResourceAccess(null, resource, context(member))),
    ).toEqual([]);
    const access = { ...resource, userId: member };
    expect(await publishesDuring(() => privacyMutations.approveResourceAccess(null, access, context(owner)))).toEqual([
      'approveResourceAccess',
    ]);
    expect(await publishesDuring(() => privacyMutations.approveResourceAccess(null, access, context(owner)))).toEqual(
      [],
    );
    const revoke = (userId: string) =>
      publishesDuring(() => privacyMutations.revokeResourceAccess(null, { ...resource, userId }, context(owner)));
    const invite = (userId: string) =>
      publishesDuring(() => privacyMutations.inviteResourceMember(null, { ...resource, userId }, context(owner)));
    expect(await revoke(member)).toEqual(['revokeResourceAccess']);
    expect(await revoke(member)).toEqual([]);
    expect(await invite(member)).toEqual(['inviteResourceMember']);
    expect(await invite(member)).toEqual([]);
    // Revoking someone with no grant still writes a revocation that outranks
    // inherited follower access, so it publishes.
    expect(await revoke(follower)).toEqual(['revokeResourceAccess']);
  });

  it('publishes an explicit tick audience choice, not tick edits that regroup sessions', async () => {
    process.env.INFERRED_SESSIONS_ENABLED = 'true';
    await insertTick(BASE);
    const evening = await insertTick(BASE + 10 * HOUR);
    const late = await insertTick(BASE + 40 * HOUR);
    expect(await climberSessionIds()).toHaveLength(3);

    // Moving the late climb into the gap welds the morning and evening runs
    // together and empties the late session. Both are public, so the merge
    // takes access from nobody.
    expect(
      await publishesDuring(() =>
        tickMutations.updateTick(
          null,
          { uuid: late, input: { climbedAt: new Date(BASE + 5 * HOUR).toISOString() } },
          context(climber),
        ),
      ),
    ).toEqual([]);
    expect(await climberSessionIds()).toHaveLength(1);
    expect(await publishesDuring(() => tickMutations.deleteTick(null, { uuid: evening }, context(climber)))).toEqual(
      [],
    );

    const { privacyRevision } = await getPrivacySettings(climber);
    expect(
      await publishesDuring(() =>
        tickMutations.updateTick(
          null,
          { uuid: late, input: { privacy: { audience: 'followers', privacyRevision } } },
          context(climber),
        ),
      ),
    ).toEqual(['updateTick']);
    expect(
      await publishesDuring(() =>
        privacyMutations.setContentAudience(
          null,
          { input: { entityType: 'tick', entityId: late, audience: 'only_me', privacyRevision } },
          context(climber),
        ),
      ),
    ).toEqual(['setContentAudience']);
  });

  it('stays silent when a saved tick merges inferred sessions', async () => {
    process.env.INFERRED_SESSIONS_ENABLED = 'true';
    const day = BASE + 5 * 24 * HOUR;
    await insertTick(day);
    await insertTick(day + 10 * HOUR);
    const before = (await climberSessionIds()).length;
    expect(
      await publishesDuring(() =>
        tickMutations.saveTick(
          null,
          {
            input: {
              boardType: 'kilter',
              climbUuid,
              angle: 40,
              isMirror: false,
              status: 'send',
              attemptCount: 1,
              isBenchmark: false,
              comment: '',
              climbedAt: new Date(day + 5 * HOUR).toISOString(),
            },
          },
          context(climber),
        ),
      ),
    ).toEqual([]);
    expect(await climberSessionIds()).toHaveLength(before - 1);
  });

  it('publishes a saved tick that merges a restricted session into a wider one', async () => {
    process.env.INFERRED_SESSIONS_ENABLED = 'true';
    const day = BASE + 10 * 24 * HOUR;
    const morningTick = await insertTick(day);
    await insertTick(day + 10 * HOUR);
    const [morning] = await db
      .select({ sessionId: schema.boardseshTicks.sessionId })
      .from(schema.boardseshTicks)
      .where(eq(schema.boardseshTicks.uuid, morningTick));
    await db
      .update(schema.resourcePrivacy)
      .set({ audience: 'only_me' })
      .where(
        and(eq(schema.resourcePrivacy.kind, 'session'), eq(schema.resourcePrivacy.resourceId, morning.sessionId!)),
      );
    const before = (await climberSessionIds()).length;
    // The merged session takes the intersection, so the evening session's
    // public readers lose it.
    expect(
      await publishesDuring(() =>
        tickMutations.saveTick(
          null,
          {
            input: {
              boardType: 'kilter',
              climbUuid,
              angle: 40,
              isMirror: false,
              status: 'send',
              attemptCount: 1,
              isBenchmark: false,
              comment: '',
              climbedAt: new Date(day + 5 * HOUR).toISOString(),
            },
          },
          context(climber),
        ),
      ),
    ).toEqual(['saveTick']);
    expect(await climberSessionIds()).toHaveLength(before - 1);
  });

  it('publishes a merge that hides comments on a non-public session from their readers', async () => {
    process.env.INFERRED_SESSIONS_ENABLED = 'true';
    const followersOnly = async (tickUuids: string[]) => {
      const sessions = await db
        .selectDistinct({ sessionId: schema.boardseshTicks.sessionId })
        .from(schema.boardseshTicks)
        .where(inArray(schema.boardseshTicks.uuid, tickUuids));
      for (const { sessionId } of sessions)
        await db
          .update(schema.resourcePrivacy)
          .set({ audience: 'followers' })
          .where(and(eq(schema.resourcePrivacy.kind, 'session'), eq(schema.resourcePrivacy.resourceId, sessionId!)));
      return sessions.map(({ sessionId }) => sessionId!);
    };
    const bridgeTheGap = (day: number) =>
      publishesDuring(() =>
        tickMutations.saveTick(
          null,
          {
            input: {
              boardType: 'kilter',
              climbUuid,
              angle: 40,
              isMirror: false,
              status: 'send',
              attemptCount: 1,
              isBenchmark: false,
              comment: '',
              climbedAt: new Date(day + 5 * HOUR).toISOString(),
            },
          },
          context(climber),
        ),
      );

    // Two followers-only sessions merge into a followers-only session: the
    // policy is unchanged and there is nothing else to hide, so no publish.
    const quietDay = BASE + 15 * 24 * HOUR;
    await followersOnly([await insertTick(quietDay), await insertTick(quietDay + 10 * HOUR)]);
    const before = (await climberSessionIds()).length;
    expect(await bridgeTheGap(quietDay)).toEqual([]);
    expect(await climberSessionIds()).toHaveLength(before - 1);

    // The same merge with a follower's comment on each session. The merged-away
    // session's comment is limited to its author, so other readers lose it.
    const commentedDay = BASE + 20 * 24 * HOUR;
    const sessionIds = await followersOnly([
      await insertTick(commentedDay),
      await insertTick(commentedDay + 10 * HOUR),
    ]);
    await db.insert(schema.comments).values(
      sessionIds.map((sessionId) => ({
        uuid: randomUUID(),
        userId: follower,
        entityType: 'session' as const,
        entityId: sessionId,
        body: 'Strong session',
      })),
    );
    expect(await bridgeTheGap(commentedDay)).toEqual(['saveTick']);
    const restricted = await db
      .select({ audience: schema.contentPrivacy.audience })
      .from(schema.contentPrivacy)
      .innerJoin(schema.comments, eq(schema.comments.uuid, schema.contentPrivacy.entityId))
      .where(and(eq(schema.contentPrivacy.entityType, 'comment'), inArray(schema.comments.entityId, sessionIds)));
    expect(restricted).toEqual([{ audience: 'only_me' }]);
  });

  it('stays silent when a setter with a linked account is followed or unfollowed', async () => {
    const input = { input: { setterUsername: setterName } };
    expect(await publishesDuring(() => setterFollowMutations.followSetter(null, input, context(follower)))).toEqual([]);
    const linkedFollow = () =>
      db
        .select()
        .from(schema.userFollows)
        .where(and(eq(schema.userFollows.followerId, follower), eq(schema.userFollows.followingId, setter)));
    expect(await linkedFollow()).toHaveLength(1);
    expect(await publishesDuring(() => setterFollowMutations.unfollowSetter(null, input, context(follower)))).toEqual(
      [],
    );
    expect(await linkedFollow()).toHaveLength(0);
  });

  it('publishes a policy-backed board edit only when its audience changes', async () => {
    const board = await insertBoard(true);
    await db.insert(schema.resourcePrivacy).values({
      kind: 'board',
      resourceId: board.uuid,
      ownerId: owner,
      audience: 'public',
      locationAudience: 'public',
    });
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        socialBoardMutations.updateBoard(null, { input: { boardUuid: board.uuid, ...input } }, context(owner)),
      );
    expect(await edit({ name: 'Policy wall', isPublic: true, isUnlisted: false, hideLocation: false })).toEqual([]);
    expect(await edit({ isUnlisted: true })).toEqual(['updateBoard']);
  });

  it('publishes a policy-backed session edit only when its visibility flips', async () => {
    const sessionId = randomUUID();
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, createdByUserId: owner, boardPath: 'kilter/1/1/1/40', isPublic: true });
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'session', resourceId: sessionId, ownerId: owner, audience: 'public' });
    const hide = () =>
      publishesDuring(() =>
        sessionEditMutations.updateSession(null, { input: { sessionId, isPublic: false } }, context(owner)),
      );
    expect(await hide()).toEqual(['updateSession']);
    expect(await hide()).toEqual([]);
  });

  it('publishes a comment edit only with an explicit audience', async () => {
    const commentUuid = randomUUID();
    await db
      .insert(schema.comments)
      .values({ uuid: commentUuid, userId: owner, entityType: 'tick', entityId: 'privacy-publish-tick', body: 'Nice' });
    const edit = (input: Record<string, unknown>) =>
      publishesDuring(() =>
        socialCommentMutations.updateComment(null, { input: { commentUuid, ...input } }, context(owner)),
      );
    expect(await edit({ body: 'Nice send' })).toEqual([]);
    const { privacyRevision } = await getPrivacySettings(owner);
    expect(await edit({ body: 'Nice send!', privacy: { audience: 'followers', privacyRevision } })).toEqual([
      'updateComment',
    ]);
  });

  it('publishes once when an account is deleted', async () => {
    expect(
      await publishesDuring(() =>
        userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(leaver)),
      ),
    ).toEqual(['deleteAccount']);
  });
});
