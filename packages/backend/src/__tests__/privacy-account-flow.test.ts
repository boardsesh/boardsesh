import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { and, count, eq, sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { lockFollowRequestPair } from '../events/follow-request-notifications';
import { schema as executableSchema } from '../graphql/index';
import { privacyMutations, privacyQueries } from '../graphql/resolvers/privacy';
import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { socialFollowMutations } from '../graphql/resolvers/social/follows';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { canAccessResource, canViewUserActivity, getPrivacySettings, setContentPrivacy } from '../services/privacy';
import { pubsub } from '../pubsub';
import { logger } from '../utils/logger';
import { ensureSessionRecordExists } from '../services/room-manager/client-lifecycle';
import { updateSessionBoardPathIfChanged } from '../services/room-manager/session-discovery';

const owner = 'privacy-flow-owner';
const requester = 'privacy-flow-requester';
const unrelated = 'privacy-flow-unrelated';
const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `privacy-${userId}` }) as ConnectionContext;

// `graphql` resolves to two module instances under the test transform; the
// schema was built with the CJS copy, so `execute` comes from the same one.
const { execute, parse } = createRequire(import.meta.url)('graphql') as typeof GraphQLModule;

// The documents the 2026-10-10 OTA bundles send. They still select and write
// the retired setup flag, and open the setup screen while it reads below 1.
const SHIPPED_SETTINGS_FIELDS = 'isPrivate privacyRevision privacyOnboardingVersion defaultSessionAudience enabled';
const SHIPPED_PRIVACY_SETTINGS = `query PrivacySettings { privacySettings { ${SHIPPED_SETTINGS_FIELDS} } }`;
const SHIPPED_UPDATE_PRIVACY_SETTINGS = `mutation UpdatePrivacySettings($input: UpdatePrivacySettingsInput!) {
  updatePrivacySettings(input: $input) { ${SHIPPED_SETTINGS_FIELDS} }
}`;

async function runShipped(document: string, userId: string, variableValues?: Record<string, unknown>) {
  const result = await execute({
    schema: executableSchema,
    document: parse(document),
    variableValues,
    contextValue: context(userId),
  });
  expect(result.errors ?? []).toEqual([]);
  return result.data;
}

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values([owner, requester, unrelated].map((id) => ({ id, email: `${id}@test.com` })));
  await db.insert(schema.userProfiles).values({ userId: owner, isPrivate: true });
});
afterAll(() => vi.unstubAllEnvs());

async function followRequestNotifications(recipientId: string, requesterId: string) {
  return db
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.recipientId, recipientId),
        eq(schema.notifications.actorId, requesterId),
        eq(schema.notifications.type, 'follow_request'),
      ),
    );
}

async function inboxTypes(userId: string) {
  const inbox = await socialNotificationQueries.groupedNotifications(null, {}, context(userId));
  return inbox.groups.map((group) => ({ type: group.type, entityId: group.entityId, actors: group.actors }));
}

describe('privacy controls against Postgres', () => {
  it('requires the target account to approve a follow and supports immediate removal', async () => {
    const pending = await privacyMutations.requestFollow(null, { userId: owner }, context(requester));
    expect(pending).toMatchObject({ requestPending: true, isFollowing: false });
    await privacyMutations.requestFollow(null, { userId: owner }, context(requester));
    const [requests] = await db
      .select({ count: count() })
      .from(schema.userFollowRequests)
      .where(
        and(eq(schema.userFollowRequests.requesterId, requester), eq(schema.userFollowRequests.recipientId, owner)),
      );
    expect(requests.count).toBe(1);
    await privacyMutations.approveFollowRequest(null, { userId: owner }, context(requester));
    await privacyMutations.approveFollowRequest(null, { userId: requester }, context(unrelated));
    expect(await canViewUserActivity(requester, owner)).toBe(false);
    await privacyMutations.approveFollowRequest(null, { userId: requester }, context(owner));
    expect(await canViewUserActivity(requester, owner)).toBe(true);
    await privacyMutations.removeFollower(null, { userId: requester }, context(owner));
    expect(await canViewUserActivity(requester, owner)).toBe(false);
  });

  it('tells a private account about a follow request, and never shows the requester as following', async () => {
    const recipient = 'privacy-flow-request-recipient';
    const asker = 'privacy-flow-request-asker';
    await db.insert(schema.users).values([
      { id: recipient, email: `${recipient}@test.com` },
      { id: asker, email: `${asker}@test.com`, name: 'Asker' },
    ]);
    await db.insert(schema.userProfiles).values({ userId: recipient, isPrivate: true });

    // The legacy mutation an installed client calls: only a request exists.
    expect(await socialFollowMutations.followUser(null, { input: { userId: recipient } }, context(asker))).toBe(false);
    expect(await canViewUserActivity(asker, recipient)).toBe(false);
    const [notification] = await followRequestNotifications(recipient, asker);
    expect(notification).toMatchObject({ type: 'follow_request', entityId: asker, entityType: null, readAt: null });
    expect(await inboxTypes(recipient)).toEqual([
      { type: 'follow_request', entityId: asker, actors: [expect.objectContaining({ id: asker })] },
    ]);
    expect(await socialNotificationQueries.unreadNotificationCount(null, null, context(recipient))).toBe(1);

    // Asking again while the request is pending adds no second row.
    expect(await socialFollowMutations.followUser(null, { input: { userId: recipient } }, context(asker))).toBe(false);
    expect(await followRequestNotifications(recipient, asker)).toHaveLength(1);

    // A cancelled request leaves nothing to answer, so the row drops out of the inbox.
    await privacyMutations.cancelFollowRequest(null, { userId: recipient }, context(asker));
    expect(await inboxTypes(recipient)).toEqual([]);
    expect(await socialNotificationQueries.unreadNotificationCount(null, null, context(recipient))).toBe(0);

    // Asked again inside the window: the same row shows again, not a second one.
    await privacyMutations.requestFollow(null, { userId: recipient }, context(asker));
    expect((await inboxTypes(recipient)).map((group) => group.type)).toEqual(['follow_request']);
    expect(await followRequestNotifications(recipient, asker)).toHaveLength(1);

    // Cancelled, then asked again days later: still one row, one unread.
    await privacyMutations.cancelFollowRequest(null, { userId: recipient }, context(asker));
    await db.execute(sql`
      UPDATE notifications SET created_at = now() - interval '2 days'
       WHERE type = 'follow_request' AND actor_id = ${asker}
    `);
    await privacyMutations.requestFollow(null, { userId: recipient }, context(asker));
    expect(await followRequestNotifications(recipient, asker)).toHaveLength(1);
    expect(await socialNotificationQueries.unreadNotificationCount(null, null, context(recipient))).toBe(1);

    // Approved: the request row is gone, a follow exists, and the owner gets no
    // "started following you" echo of their own tap.
    await privacyMutations.approveFollowRequest(null, { userId: asker }, context(recipient));
    expect(await followRequestNotifications(recipient, asker)).toEqual([]);
    expect(await inboxTypes(recipient)).toEqual([]);
    expect(await canViewUserActivity(asker, recipient)).toBe(true);
    expect(await socialFollowMutations.followUser(null, { input: { userId: recipient } }, context(asker))).toBe(true);
  });

  it('keeps one hidden row after a cancel or an unfollow, so the dedup still holds', async () => {
    const recipient = 'privacy-flow-hidden-recipient';
    const asker = 'privacy-flow-hidden-asker';
    await db.insert(schema.users).values([
      { id: recipient, email: `${recipient}@test.com` },
      { id: asker, email: `${asker}@test.com` },
    ]);
    await db.insert(schema.userProfiles).values({ userId: recipient, isPrivate: true });

    for (const withdraw of [
      () => privacyMutations.cancelFollowRequest(null, { userId: recipient }, context(asker)),
      () => socialFollowMutations.unfollowUser(null, { input: { userId: recipient } }, context(asker)),
      () => privacyMutations.removeFollower(null, { userId: asker }, context(recipient)),
    ]) {
      await privacyMutations.requestFollow(null, { userId: recipient }, context(asker));
      await withdraw();
      // Nothing to answer: out of the inbox and the badge, and never a second row.
      expect(await inboxTypes(recipient)).toEqual([]);
      expect(await socialNotificationQueries.unreadNotificationCount(null, null, context(recipient))).toBe(0);
      expect(await followRequestNotifications(recipient, asker)).toHaveLength(1);
    }
  });

  it('removes the follow request row when the request is declined', async () => {
    const recipient = 'privacy-flow-decline-recipient';
    const asker = 'privacy-flow-decline-asker';
    await db.insert(schema.users).values([
      { id: recipient, email: `${recipient}@test.com` },
      { id: asker, email: `${asker}@test.com` },
    ]);
    await db.insert(schema.userProfiles).values({ userId: recipient, isPrivate: true });

    await privacyMutations.requestFollow(null, { userId: recipient }, context(asker));
    expect(await followRequestNotifications(recipient, asker)).toHaveLength(1);
    await privacyMutations.declineFollowRequest(null, { userId: asker }, context(recipient));
    expect(await followRequestNotifications(recipient, asker)).toEqual([]);
    expect(await inboxTypes(recipient)).toEqual([]);
    expect(await canViewUserActivity(asker, recipient)).toBe(false);

    // Unlike a cancel, a decline leaves no row behind to hold the day-long
    // window, so asking again at once is a fresh request with one unread row.
    await privacyMutations.requestFollow(null, { userId: recipient }, context(asker));
    const [again] = await followRequestNotifications(recipient, asker);
    expect(again).toMatchObject({ type: 'follow_request', entityId: asker, readAt: null });
    expect(await followRequestNotifications(recipient, asker)).toHaveLength(1);
    expect(await inboxTypes(recipient)).toEqual([
      { type: 'follow_request', entityId: asker, actors: [expect.objectContaining({ id: asker })] },
    ]);
    expect(await socialNotificationQueries.unreadNotificationCount(null, null, context(recipient))).toBe(1);
  });

  it('makes approve and decline wait for a follow request write on the same pair', async () => {
    const recipient = 'privacy-flow-lock-recipient';
    const asker = 'privacy-flow-lock-asker';
    await db.insert(schema.users).values([
      { id: recipient, email: `${recipient}@test.com` },
      { id: asker, email: `${asker}@test.com` },
    ]);
    await db.insert(schema.userProfiles).values({ userId: recipient, isPrivate: true });

    for (const answer of [privacyMutations.approveFollowRequest, privacyMutations.declineFollowRequest]) {
      await db
        .delete(schema.userFollows)
        .where(and(eq(schema.userFollows.followerId, asker), eq(schema.userFollows.followingId, recipient)));
      await privacyMutations.requestFollow(null, { userId: recipient }, context(asker));

      // Stand in for a worker or the inline fallback mid-write: hold the pair lock.
      let releaseWriter = () => {};
      const writerReleased = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let markLockHeld = () => {};
      const lockHeld = new Promise<void>((resolve) => {
        markLockHeld = resolve;
      });
      const writer = db.transaction(async (transaction) => {
        await lockFollowRequestPair(transaction, asker, recipient);
        markLockHeld();
        await writerReleased;
      });
      await lockHeld;

      let answered = false;
      const answering = answer(null, { userId: asker }, context(recipient)).then(() => {
        answered = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(answered).toBe(false);

      releaseWriter();
      await writer;
      await answering;
      expect(answered).toBe(true);
      expect(await followRequestNotifications(recipient, asker)).toEqual([]);
    }
  });

  it('lets the owner answer a pending request while the privacy controls are switched off', async () => {
    const recipient = 'privacy-flow-rollback-recipient';
    const asker = 'privacy-flow-rollback-asker';
    const decliner = 'privacy-flow-rollback-decliner';
    await db.insert(schema.users).values([recipient, asker, decliner].map((id) => ({ id, email: `${id}@test.com` })));
    await db.insert(schema.userProfiles).values({ userId: recipient, isPrivate: true });
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
    try {
      // An installed client's followUser still leaves requests during a rollback.
      expect(await socialFollowMutations.followUser(null, { input: { userId: recipient } }, context(asker))).toBe(
        false,
      );
      expect(await socialFollowMutations.followUser(null, { input: { userId: recipient } }, context(decliner))).toBe(
        false,
      );
      await privacyMutations.approveFollowRequest(null, { userId: asker }, context(recipient));
      await privacyMutations.declineFollowRequest(null, { userId: decliner }, context(recipient));
      expect(await canViewUserActivity(asker, recipient)).toBe(true);
      expect(await canViewUserActivity(decliner, recipient)).toBe(false);
      expect(await inboxTypes(recipient)).toEqual([]);
      // Everything else stays behind the switch.
      await expect(
        privacyMutations.requestFollow(null, { userId: recipient }, context(decliner)),
      ).rejects.toMatchObject({ extensions: { code: 'PRIVACY_UNAVAILABLE' } });
    } finally {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    }
  });

  it('follows a public account straight away', async () => {
    const recipient = 'privacy-flow-public-recipient';
    const follower = 'privacy-flow-public-follower';
    await db.insert(schema.users).values([
      { id: recipient, email: `${recipient}@test.com` },
      { id: follower, email: `${follower}@test.com` },
    ]);

    expect(await socialFollowMutations.followUser(null, { input: { userId: recipient } }, context(follower))).toBe(
      true,
    );
    expect(await followRequestNotifications(recipient, follower)).toEqual([]);
    expect((await inboxTypes(recipient)).map((group) => group.type)).toEqual(['new_follower']);
  });

  it('ignores the retired setup flag and rejects a public write with an old account revision atomically', async () => {
    await privacyMutations.updatePrivacySettings(null, { input: { isPrivate: false } }, context(owner));
    const publicSettings = await getPrivacySettings(owner);
    // Through the executable schema, so the deprecated input field and the
    // `PrivacySettings` resolver hookup are both exercised: without the hookup
    // the non-null field resolves to undefined and the whole query errors.
    const written = await runShipped(SHIPPED_UPDATE_PRIVACY_SETTINGS, owner, {
      input: { isPrivate: true, privacyOnboardingVersion: 1, defaultSessionAudience: 'followers' },
    });
    expect(written).toMatchObject({ updatePrivacySettings: { privacyOnboardingVersion: 1 } });
    const settings = await privacyQueries.privacySettings(null, null, context(owner));
    expect(settings).toMatchObject({
      defaultSessionAudience: 'followers',
      privacyRevision: publicSettings.privacyRevision + 1,
    });
    expect(settings).not.toHaveProperty('privacyOnboardingVersion');
    expect(await runShipped(SHIPPED_PRIVACY_SETTINGS, owner)).toMatchObject({
      privacySettings: { isPrivate: true, privacyOnboardingVersion: 1, defaultSessionAudience: 'followers' },
    });
    await expect(
      db.transaction(async (transaction) => {
        await transaction.insert(schema.boardseshTicks).values({
          uuid: 'privacy-stale-atomic',
          userId: owner,
          climbUuid: 'catalog-climb',
          boardType: 'kilter',
          angle: 40,
          status: 'send',
          climbedAt: '2026-01-01T10:00:00Z',
        });
        await setContentPrivacy(
          transaction,
          owner,
          'tick',
          'privacy-stale-atomic',
          'public',
          publicSettings.privacyRevision,
        );
      }),
    ).rejects.toMatchObject({ extensions: { code: 'PRIVACY_REVISION_CONFLICT' } });
    expect(
      await db.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.uuid, 'privacy-stale-atomic')),
    ).toEqual([]);
  });

  it('grants immediate board and presence access independently of a public session', async () => {
    const boardOwner = 'privacy-flow-invite-owner';
    const friend = 'privacy-flow-invite-friend';
    const stranger = 'privacy-flow-invite-stranger';
    await db.insert(schema.users).values([boardOwner, friend, stranger].map((id) => ({ id, email: `${id}@test.com` })));
    const [board] = await db
      .insert(schema.userBoards)
      .values({
        uuid: '7f1c6a52-5d0e-4c55-9a43-2b6f0e8d1a11',
        slug: 'privacy-flow-invite-board',
        ownerId: boardOwner,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Garage wall',
        isPublic: false,
      })
      .returning();
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'board', resourceId: board.uuid, ownerId: boardOwner, audience: 'invite_only' });
    const sessionId = 'privacy-flow-invite-session';
    await db.insert(schema.boardSessions).values({
      id: sessionId,
      createdByUserId: boardOwner,
      boardPath: 'kilter/1/1/1/40',
      boardId: board.id,
      isPublic: true,
    });
    await db.insert(schema.sessionBoards).values({ sessionId, boardId: board.id });
    // A session page needs something climbed in it to show.
    await db.insert(schema.boardseshTicks).values({
      uuid: 'privacy-flow-invite-tick',
      userId: boardOwner,
      climbUuid: 'catalog-climb',
      boardType: 'kilter',
      angle: 40,
      status: 'send',
      climbedAt: '2026-10-01 10:00:00',
      sessionId,
      boardId: board.id,
    });

    const reads = async (viewer: string) => ({
      board: (await socialBoardQueries.board(null, { boardUuid: board.uuid }, context(viewer)))?.uuid ?? null,
      presence: await boardPresenceQueries.boardConnection({}, { boardId: board.id }, context(viewer)).then(
        () => 'readable',
        (error: Error) => error.message,
      ),
      session: (await sessionFeedQueries.sessionDetail(null, { sessionId }, context(viewer)))?.sessionId ?? null,
    });
    // The merged author-decides policy keeps this Public session readable.
    const shut = { board: null, presence: 'Board not found', session: sessionId };
    expect(await reads(friend)).toEqual(shut);

    // The owner adds the friend by name. That is the whole flow: no request
    // from the friend and no approval. The next read is authorized on the server.
    await privacyMutations.inviteResourceMember(
      null,
      { kind: 'board', resourceId: board.uuid, userId: friend },
      context(boardOwner),
    );
    const [grant] = await db
      .select()
      .from(schema.resourceGrants)
      .where(and(eq(schema.resourceGrants.resourceId, board.uuid), eq(schema.resourceGrants.userId, friend)));
    expect(grant).toMatchObject({ kind: 'board', status: 'approved', invitedBy: boardOwner });

    expect(await reads(friend)).toEqual({ board: board.uuid, presence: 'readable', session: sessionId });
    expect(await reads(stranger)).toEqual(shut);
    // There is no notification type for a board invite yet, so nothing lands
    // in the friend's inbox; they find the board when they next open it.
    expect(await db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, friend))).toEqual(
      [],
    );
  });

  it('treats a forwarded private session link as a request, not a grant', async () => {
    const sessionId = 'privacy-flow-session';
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, createdByUserId: owner, boardPath: 'kilter/1/1/1/40', isPublic: false });
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'session', resourceId: sessionId, ownerId: owner, audience: 'invite_only' });
    const resource = { kind: 'session' as const, resourceId: sessionId };
    await privacyMutations.requestResourceAccess(null, resource, context(requester));
    expect(await canAccessResource('session', sessionId, requester)).toBe(false);
    await expect(
      privacyMutations.approveResourceAccess(null, { ...resource, userId: requester }, context(requester)),
    ).rejects.toThrow();
    await privacyMutations.approveResourceAccess(null, { ...resource, userId: requester }, context(owner));
    expect(await canAccessResource('session', sessionId, requester)).toBe(true);
    expect(await canViewUserActivity(requester, owner)).toBe(false);
    await privacyMutations.revokeResourceAccess(null, { ...resource, userId: requester }, context(owner));
    expect(await canAccessResource('session', sessionId, requester)).toBe(false);
  });

  it('commits a wall move and a board revoke even when the kiosk refresh after them fails', async () => {
    const insertBoard = async (isPublic: boolean) => {
      const uuid = randomUUID();
      const [board] = await db
        .insert(schema.userBoards)
        .values({
          uuid,
          slug: `privacy-flow-refresh-${uuid}`,
          ownerId: owner,
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 1,
          setIds: '1',
          name: 'Refresh test wall',
          isPublic,
        })
        .returning();
      return board;
    };
    const first = await insertBoard(true);
    const home = await insertBoard(false);
    const sessionId = randomUUID();
    await ensureSessionRecordExists(sessionId, `/b/${first.slug}/40`, owner);
    const loggedError = vi.spyOn(logger, 'error');

    // The session preview refresh starts with a Redis read of the session's wall.
    // The move has committed by then, so it resolves and the failure is logged.
    const redisDown = vi.spyOn(pubsub, 'getSessionBoard').mockRejectedValue(new Error('redis down'));
    try {
      await expect(updateSessionBoardPathIfChanged(sessionId, `/b/${home.slug}/40`, owner)).resolves.toBe(
        `/b/${first.slug}/40`,
      );
    } finally {
      redisDown.mockRestore();
    }
    const [session] = await db
      .select({ boardId: schema.boardSessions.boardId })
      .from(schema.boardSessions)
      .where(eq(schema.boardSessions.id, sessionId));
    expect(session.boardId).toBe(home.id);
    expect(loggedError).toHaveBeenCalledWith(
      '[SessionDiscovery] kiosk preview refresh failed after a committed wall move',
      expect.objectContaining({ sessionId, error: 'redis down' }),
    );

    // A board's preview refresh publishes a tombstone to its kiosks. The revoke
    // has committed by then, so the mutation succeeds and the failure is logged.
    const tombstoneFails = vi.spyOn(pubsub, 'publishBoardQueuePreview').mockImplementation(() => {
      throw new Error('preview publish failed');
    });
    try {
      await expect(
        privacyMutations.revokeResourceAccess(
          null,
          { kind: 'board', resourceId: first.uuid, userId: requester },
          context(owner),
        ),
      ).resolves.toBe(true);
    } finally {
      tombstoneFails.mockRestore();
    }
    const [grant] = await db
      .select({ status: schema.resourceGrants.status })
      .from(schema.resourceGrants)
      .where(and(eq(schema.resourceGrants.resourceId, first.uuid), eq(schema.resourceGrants.userId, requester)));
    expect(grant).toEqual({ status: 'revoked' });
    expect(loggedError).toHaveBeenCalledWith(
      '[Privacy] kiosk preview refresh failed after a committed privacy change',
      expect.objectContaining({ kind: 'board', resourceId: first.uuid, error: 'preview publish failed' }),
    );
    loggedError.mockRestore();
  });
});
