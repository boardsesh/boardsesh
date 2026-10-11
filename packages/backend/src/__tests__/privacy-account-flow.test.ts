import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { and, count, eq, sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { schema as executableSchema } from '../graphql/index';
import { privacyMutations, privacyQueries } from '../graphql/resolvers/privacy';
import { socialFollowMutations } from '../graphql/resolvers/social/follows';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { canAccessResource, canViewUserActivity, getPrivacySettings, setContentPrivacy } from '../services/privacy';

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
});
