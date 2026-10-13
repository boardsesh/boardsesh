import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { climbDraftVisibilityCondition, privateSafeFirstAscentName, publicClimbCondition } from '@boardsesh/db/queries';
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

/** The climbs among these that any list may show: published and listed, no viewer. */
async function publicClimbs(uuids: string[]): Promise<string[]> {
  const rows = await db
    .select({ uuid: schema.boardClimbs.uuid })
    .from(schema.boardClimbs)
    .where(and(inArray(schema.boardClimbs.uuid, uuids), publicClimbCondition(schema.boardClimbs)));
  return rows.map((row) => row.uuid);
}

/** The climbs among these that this viewer may read by uuid. */
async function readableByReference(uuids: string[], viewerId: string | null): Promise<string[]> {
  const rows = await db
    .select({ uuid: schema.boardClimbs.uuid })
    .from(schema.boardClimbs)
    .where(and(inArray(schema.boardClimbs.uuid, uuids), climbDraftVisibilityCondition(schema.boardClimbs, viewerId)));
  return rows.map((row) => row.uuid);
}

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
            // A comment policy: climbs have no audience. The climb insert above
            // is what holds the creator foreign-key lock.
            await setContentPrivacy(transaction, userId, 'comment', uuid, 'public', 0);
          }),
        ),
      );
      for (const uuid of uuids) expect(await canViewContent(null, 'comment', uuid, userId)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("leaves a deleted private account's published climbs public, its drafts and unlisted climbs to no one", async () => {
    const { userId, climbUuid } = await seedAccount(true);
    const draftUuid = randomUUID();
    const unlistedUuid = randomUUID();
    await db.insert(schema.boardClimbs).values([
      { uuid: draftUuid, userId, boardType: 'kilter', layoutId: 1, isDraft: true, isListed: false },
      { uuid: unlistedUuid, userId, boardType: 'kilter', layoutId: 1, isDraft: false, isListed: false },
    ]);
    await db.insert(schema.boardClimbStats).values({ boardType: 'kilter', climbUuid, angle: 40, ascensionistCount: 7 });
    const publish = vi.spyOn(pubsub, 'publishPrivacyChanged');
    try {
      await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(userId));
      const rows = await db
        .select({
          uuid: schema.boardClimbs.uuid,
          userId: schema.boardClimbs.userId,
          marked: schema.boardClimbs.isBoardseshAuthored,
        })
        .from(schema.boardClimbs)
        .where(inArray(schema.boardClimbs.uuid, [climbUuid, draftUuid, unlistedUuid]));
      // The author reference is cleared; the marker stays for first-ascent names alone.
      expect(rows.every((row) => row.userId === null && row.marked === true)).toBe(true);
      // No climb policy is written: a published climb has no audience.
      expect(
        await db
          .select()
          .from(schema.contentPrivacy)
          .where(inArray(schema.contentPrivacy.entityId, [climbUuid, draftUuid, unlistedUuid])),
      ).toEqual([]);
      expect(await publicClimbs([climbUuid, draftUuid, unlistedUuid])).toEqual([climbUuid]);
      // By reference: the published climbs resolve, the draft goes to no one.
      expect((await readableByReference([climbUuid, draftUuid, unlistedUuid], null)).sort()).toEqual(
        [climbUuid, unlistedUuid].sort(),
      );
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
    expect(await publicClimbs([climbUuid])).toEqual([climbUuid]);
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
