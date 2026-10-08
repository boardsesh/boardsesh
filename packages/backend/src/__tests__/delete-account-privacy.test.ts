import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { contentVisibilityCondition, privateSafeFirstAscentName } from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { retryAccountDeletion, withdrawDeletedAccountContent } from '../graphql/resolvers/users/delete-account-privacy';
import { betaPrivacyCondition } from '../graphql/resolvers/shared/activity-privacy';
import { canAccessResource, canViewContent, setContentPrivacy } from '../services/privacy';
import { pubsub } from '../pubsub';

const context = (userId: string) => ({ isAuthenticated: true, userId, connectionId: userId }) as ConnectionContext;

beforeAll(async () => {
  // Production migration 0093 owns this FK; the general test fixture omits it.
  await db.execute(sql`ALTER TABLE board_beta_links ADD CONSTRAINT privacy_delete_test_beta_creator_fk
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL`);
});
afterAll(async () => {
  await db.execute(sql`ALTER TABLE board_beta_links DROP CONSTRAINT IF EXISTS privacy_delete_test_beta_creator_fk`);
});

async function seedAccount(isPrivate: boolean) {
  const userId = randomUUID();
  const climbUuid = randomUUID();
  await db.insert(schema.users).values({ id: userId, name: 'Personal name', email: `${userId}@test.invalid` });
  await db.insert(schema.userProfiles).values({ userId, isPrivate });
  await db.insert(schema.boardClimbs).values({
    uuid: climbUuid,
    userId,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Personal climb',
    setterUsername: 'personal-setter',
    isDraft: false,
    isListed: true,
  });
  return { userId, climbUuid };
}

describe('account deletion preserves privacy', () => {
  it('retries only rolled-back deadlocks, with a bounded client-safe failure', async () => {
    const deadlock = Object.assign(new Error('driver deadlock'), { code: '40P01' });
    const succeeds = vi
      .fn()
      .mockRejectedValueOnce(new Error('wrapped', { cause: deadlock }))
      .mockResolvedValue(true);
    expect(await retryAccountDeletion(succeeds)).toBe(true);
    expect(succeeds).toHaveBeenCalledTimes(2);
    const fails = vi.fn().mockRejectedValue(new Error('ordinary failure'));
    await expect(retryAccountDeletion(fails)).rejects.toThrow('ordinary failure');
    expect(fails).toHaveBeenCalledOnce();
    const exhausted = vi.fn().mockRejectedValue(deadlock);
    await expect(retryAccountDeletion(exhausted)).rejects.toMatchObject({
      extensions: { code: 'ACCOUNT_DELETE_RETRY_REQUIRED' },
    });
    expect(exhausted).toHaveBeenCalledTimes(3);
  });

  it('serializes concurrent publication after both writers hold creator foreign-key locks', async () => {
    const { userId } = await seedAccount(true);
    const uuids = [randomUUID(), randomUUID()];
    let inserted = 0;
    let release: () => void = () => undefined;
    const bothInserted = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    try {
      await Promise.all(
        uuids.map((uuid) =>
          db.transaction(async (transaction) => {
            await transaction.insert(schema.boardClimbs).values({ uuid, userId, boardType: 'kilter', layoutId: 1 });
            inserted += 1;
            if (inserted === uuids.length) release();
            await bothInserted;
            await setContentPrivacy(transaction, userId, 'climb', uuid, 'public', 0);
          }),
        ),
      );
      for (const uuid of uuids) expect(await canViewContent(null, 'climb', uuid, userId)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('retains private climb restrictions and numeric aggregates after author FKs become NULL', async () => {
    const { userId, climbUuid } = await seedAccount(true);
    await db.insert(schema.boardClimbStats).values({ boardType: 'kilter', climbUuid, angle: 40, ascensionistCount: 7 });
    const publish = vi.spyOn(pubsub, 'publishPrivacyChanged');
    try {
      await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(userId));
      const [climb] = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, climbUuid));
      expect(climb.userId).toBeNull();
      const [policy] = await db
        .select()
        .from(schema.contentPrivacy)
        .where(and(eq(schema.contentPrivacy.entityType, 'climb'), eq(schema.contentPrivacy.entityId, climbUuid)));
      expect(policy).toMatchObject({ ownerId: null, audience: 'only_me' });
      const visible = await db
        .select({ uuid: schema.boardClimbs.uuid })
        .from(schema.boardClimbs)
        .where(
          and(
            eq(schema.boardClimbs.uuid, climbUuid),
            contentVisibilityCondition('climb', schema.boardClimbs.uuid, schema.boardClimbs.userId, null),
          ),
        );
      expect(visible).toEqual([]);
      expect(await canViewContent(null, 'climb', climbUuid, null)).toBe(false);
      const [stats] = await db
        .select()
        .from(schema.boardClimbStats)
        .where(eq(schema.boardClimbStats.climbUuid, climbUuid));
      expect(stats.ascensionistCount).toBe(7);
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      publish.mockRestore();
    }
  });

  it('withdraws personal beta but retains external vendor beta on the same public climb', async () => {
    const { userId, climbUuid } = await seedAccount(false);
    const personalLink = `https://example.test/personal/${userId}`;
    const vendorLink = `https://example.test/vendor/${climbUuid}`;
    await db.insert(schema.boardBetaLinks).values([
      { boardType: 'kilter', climbUuid, link: personalLink, createdByUserId: userId, foreignUsername: 'private-name' },
      { boardType: 'kilter', climbUuid, link: vendorLink, foreignUsername: 'Vendor athlete' },
    ]);
    await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(userId));
    const [personal] = await db
      .select()
      .from(schema.boardBetaLinks)
      .where(eq(schema.boardBetaLinks.link, personalLink));
    expect(personal.createdByUserId).toBeNull();
    const visible = await db
      .select({ link: schema.boardBetaLinks.link })
      .from(schema.boardBetaLinks)
      .where(and(eq(schema.boardBetaLinks.climbUuid, climbUuid), betaPrivacyCondition(null)));
    expect(visible).toEqual([{ link: vendorLink }]);
    const [climb] = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, climbUuid));
    expect(climb).toMatchObject({ userId: null, isBoardseshAuthored: true });
    expect(await canViewContent(null, 'climb', climbUuid, null)).toBe(true);
    await db.insert(schema.boardClimbStats).values({
      boardType: 'kilter',
      climbUuid,
      angle: 40,
      ascensionistCount: 3,
      faUsername: 'Stale personal attribution',
    });
    const [stats] = await db
      .select({
        firstAscent: privateSafeFirstAscentName(
          {
            boardType: schema.boardClimbStats.boardType,
            climbUuid: schema.boardClimbStats.climbUuid,
            angle: schema.boardClimbStats.angle,
            username: schema.boardClimbStats.faUsername,
          },
          null,
        ),
      })
      .from(schema.boardClimbStats)
      .where(eq(schema.boardClimbStats.climbUuid, climbUuid));
    expect(stats.firstAscent).toBeNull();
  });

  it('preserves explicit session denial instead of restoring legacy participant access', async () => {
    const { userId } = await seedAccount(false);
    const participant = randomUUID();
    const sessionId = randomUUID();
    await db.insert(schema.users).values({ id: participant, email: `${participant}@test.invalid` });
    await db.insert(schema.boardSessions).values({
      id: sessionId,
      createdByUserId: userId,
      isPublic: false,
      boardPath: 'kilter/1/1/1/40',
    });
    await db.insert(schema.boardSessionParticipants).values({ sessionId, userId: participant });
    await db.insert(schema.resourcePrivacy).values({
      kind: 'session',
      resourceId: sessionId,
      ownerId: userId,
      audience: 'only_me',
    });
    await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(userId));
    expect(await canAccessResource('session', sessionId, participant)).toBe(false);
    const [policy] = await db
      .select()
      .from(schema.resourcePrivacy)
      .where(eq(schema.resourcePrivacy.resourceId, sessionId));
    expect(policy).toMatchObject({ ownerId: null, audience: 'only_me' });
  });

  it('retains current explicit Public climbs but preserves stale-public and followers restrictions', async () => {
    const { userId, climbUuid } = await seedAccount(true);
    const staleUuid = randomUUID();
    const followersUuid = randomUUID();
    await db.insert(schema.boardClimbs).values(
      [staleUuid, followersUuid].map((uuid) => ({
        uuid,
        userId,
        boardType: 'kilter',
        layoutId: 1,
        isDraft: false,
        isListed: true,
      })),
    );
    await db.update(schema.userProfiles).set({ privacyRevision: 1 }).where(eq(schema.userProfiles.userId, userId));
    await db.insert(schema.contentPrivacy).values([
      { entityType: 'climb', entityId: climbUuid, ownerId: userId, audience: 'public', publicConsentRevision: 1 },
      { entityType: 'climb', entityId: staleUuid, ownerId: userId, audience: 'public', publicConsentRevision: 0 },
      { entityType: 'climb', entityId: followersUuid, ownerId: userId, audience: 'followers' },
    ]);
    await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(userId));
    expect(await canViewContent(null, 'climb', climbUuid, null)).toBe(true);
    expect(await canViewContent(null, 'climb', staleUuid, null)).toBe(false);
    expect(await canViewContent(null, 'climb', followersUuid, null)).toBe(false);
  });

  it('rolls withdrawal back if the enclosing account deletion fails', async () => {
    const { userId, climbUuid } = await seedAccount(true);
    await expect(
      db.transaction(async (transaction) => {
        await withdrawDeletedAccountContent(transaction, userId);
        throw new Error('synthetic deletion failure');
      }),
    ).rejects.toThrow('synthetic deletion failure');
    expect(await db.select().from(schema.contentPrivacy).where(eq(schema.contentPrivacy.entityId, climbUuid))).toEqual(
      [],
    );
    expect(await db.select().from(schema.users).where(eq(schema.users.id, userId))).toHaveLength(1);
  });
});
