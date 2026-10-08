import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, count, eq } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { privacyMutations, privacyQueries } from '../graphql/resolvers/privacy';
import { canAccessResource, canViewUserActivity, getPrivacySettings, setContentPrivacy } from '../services/privacy';

const owner = 'privacy-flow-owner';
const requester = 'privacy-flow-requester';
const unrelated = 'privacy-flow-unrelated';
const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `privacy-${userId}` }) as ConnectionContext;

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values([owner, requester, unrelated].map((id) => ({ id, email: `${id}@test.com` })));
  await db.insert(schema.userProfiles).values({ userId: owner, isPrivate: true });
});
afterAll(() => vi.unstubAllEnvs());

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

  it('stores onboarding across clients and rejects a public write with an old account revision atomically', async () => {
    await privacyMutations.updatePrivacySettings(null, { input: { isPrivate: false } }, context(owner));
    const publicSettings = await getPrivacySettings(owner);
    await privacyMutations.updatePrivacySettings(
      null,
      {
        input: { isPrivate: true, privacyOnboardingVersion: 1, defaultSessionAudience: 'followers' },
      },
      context(owner),
    );
    const settings = await privacyQueries.privacySettings(null, null, context(owner));
    expect(settings).toMatchObject({
      privacyOnboardingVersion: 1,
      defaultSessionAudience: 'followers',
      privacyRevision: publicSettings.privacyRevision + 1,
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
