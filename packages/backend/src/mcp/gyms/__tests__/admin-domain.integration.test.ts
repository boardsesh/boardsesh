import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db, runWithDatabaseTransaction } from '../../../db/client';
import { boardRepairStateHash } from '../../../services/board-repair-state';
import {
  generateUniqueGymSlug,
  resolveCanonicalGymBySlug,
  resolveCanonicalGymByUuid,
  socialGymMutations,
} from '../../../graphql/resolvers/social/gyms';
import * as transactions from '../../../db/after-commit';
import { socialBoardMutations } from '../../../graphql/resolvers/social/boards';
import { gymMcpAdminTools } from '../admin-tools';
import { mergeDuplicateBoards } from '../../../services/merge-duplicate-boards';
import * as moderation from '../../../graphql/resolvers/social/board-moderation-events';
import {
  assertGymMcpGlobalAdmin,
  authorizeAdminMergeReplay,
  correctBoardLocationVisibility,
  correctBoardSetup,
  inspectGymDuplicates,
  mergeAdminGyms,
  repairGymCanonicalSlug,
  authorizeCanonicalSlugReplay,
} from '../admin-domain';

const effects = vi.hoisted(() => ({ privacyChanged: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../services/board-session-privacy', async (original) => ({
  ...(await original<typeof import('../../../services/board-session-privacy')>()),
  notifyResourcePrivacyChanged: effects.privacyChanged,
}));

function context(userId: string): ConnectionContext {
  return { connectionId: randomUUID(), transport: 'http', userId, isAuthenticated: true };
}

let adminId: string;
let ownerId: string;
let scopedAdminId: string;
let gym: typeof tables.gyms.$inferSelect;
let duplicateGym: typeof tables.gyms.$inferSelect;
let board: typeof tables.userBoards.$inferSelect;

beforeEach(async () => {
  effects.privacyChanged.mockClear();
  const suffix = randomUUID();
  adminId = `repair-admin-${suffix}`;
  ownerId = `repair-owner-${suffix}`;
  scopedAdminId = `repair-scoped-${suffix}`;
  await db
    .insert(tables.users)
    .values([adminId, ownerId, scopedAdminId].map((id) => ({ id, email: `${id}@example.test`, name: id })));
  await db.insert(tables.communityRoles).values([
    { userId: adminId, role: 'admin', boardType: null },
    { userId: scopedAdminId, role: 'admin', boardType: 'moonboard' },
  ]);
  const gyms = await db
    .insert(tables.gyms)
    .values([
      {
        uuid: randomUUID(),
        slug: `repair-main-${suffix}`,
        name: 'Telefonplan',
        ownerId,
        latitude: 59.2991228,
        longitude: 17.9915755,
      },
      {
        uuid: randomUUID(),
        slug: `repair-duplicate-${suffix}`,
        name: 'Klättercentret Telefonplan',
        ownerId,
        latitude: 59.2990894,
        longitude: 17.9915352,
      },
    ])
    .returning();
  [gym, duplicateGym] = [gyms[0]!, gyms[1]!];
  [board] = await db
    .insert(tables.userBoards)
    .values({
      uuid: randomUUID(),
      slug: `repair-board-${suffix}`,
      name: 'K2 MoonBoard',
      ownerId,
      gymId: gym.id,
      boardType: 'moonboard',
      layoutId: 5,
      sizeId: 1,
      setIds: '17,18,19,20,21,22,23',
      isPublic: true,
      hideLocation: true,
    })
    .returning();
});

afterEach(async () => {
  await db.delete(tables.gymDirectoryRepairAudit).where(eq(tables.gymDirectoryRepairAudit.actorUserId, adminId));
  await db.delete(tables.users).where(inArray(tables.users.id, [adminId, ownerId, scopedAdminId]));
});

async function canonicalRepairInput() {
  const inspection = await inspectGymDuplicates([gym.uuid, duplicateGym.uuid], context(adminId));
  return {
    gymUuid: gym.uuid,
    aliasGymUuid: duplicateGym.uuid,
    slug: duplicateGym.slug!,
    expectedStateHash: inspection.gyms.find((entry) => entry.gymUuid === gym.uuid)!.stateHash,
    expectedAliasStateHash: inspection.gyms.find((entry) => entry.gymUuid === duplicateGym.uuid)!.stateHash,
    reason: 'The gym approved its original public URL after the duplicate merge.',
  };
}

async function makeMergedAlias() {
  await db
    .update(tables.gyms)
    .set({ deletedAt: new Date(), mergedIntoGymId: gym.id })
    .where(eq(tables.gyms.id, duplicateGym.id));
}

describe('canonical URL repair after a gym merge', () => {
  it('reserves the survivor’s previous URL from generated and explicit slug allocation', async () => {
    await makeMergedAlias();
    await repairGymCanonicalSlug(await canonicalRepairInput(), context(adminId));
    expect(await generateUniqueGymSlug(gym.slug!)).toBe(`${gym.slug}-2`);
    const created = await socialGymMutations.createGym({}, { input: { name: gym.slug! } }, context(scopedAdminId));
    expect(created.slug).toBe(`${gym.slug}-2`);
    await expect(
      socialGymMutations.updateGym({}, { input: { gymUuid: created.uuid, slug: gym.slug! } }, context(scopedAdminId)),
    ).rejects.toThrow('Slug is already taken');
    expect((await resolveCanonicalGymBySlug(gym.slug!))?.uuid).toBe(gym.uuid);
  });

  it('permits unchanged current slugs even when the same merge graph shares the slug', async () => {
    await makeMergedAlias();
    await db.update(tables.gyms).set({ slug: gym.slug }).where(eq(tables.gyms.id, duplicateGym.id));
    const result = await socialGymMutations.updateGym(
      {},
      { input: { gymUuid: gym.uuid, slug: gym.slug!, description: 'The current gym description' } },
      context(ownerId),
    );
    expect(result).toMatchObject({ slug: gym.slug, description: 'The current gym description' });
  });

  it('does not let an initially unchanged form slug undo a concurrent URL repair', async () => {
    await makeMergedAlias();
    const repairInput = await canonicalRepairInput();
    const originalTransaction = transactions.transactionWithAfterCommit;
    const intercepted = vi
      .spyOn(transactions, 'transactionWithAfterCommit')
      .mockImplementationOnce(async (work, config) => {
        await repairGymCanonicalSlug(repairInput, context(adminId));
        return originalTransaction(work, config);
      });
    try {
      await expect(
        socialGymMutations.updateGym(
          {},
          { input: { gymUuid: gym.uuid, slug: gym.slug!, description: 'Stale form description' } },
          context(ownerId),
        ),
      ).rejects.toThrow('Slug is already taken');
      expect(intercepted).toHaveBeenCalledOnce();
      expect((await resolveCanonicalGymByUuid(gym.uuid))?.slug).toBe(duplicateGym.slug);
      expect((await resolveCanonicalGymBySlug(gym.slug!))?.uuid).toBe(gym.uuid);
    } finally {
      intercepted.mockRestore();
    }
  });

  it('does not rename a gym merged after the initial permission check', async () => {
    const originalTransaction = transactions.transactionWithAfterCommit;
    const intercepted = vi
      .spyOn(transactions, 'transactionWithAfterCommit')
      .mockImplementationOnce(async (work, config) => {
        await makeMergedAlias();
        return originalTransaction(work, config);
      });
    try {
      await expect(
        socialGymMutations.updateGym(
          {},
          { input: { gymUuid: duplicateGym.uuid, slug: `unused-${randomUUID()}` } },
          context(ownerId),
        ),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
      expect(intercepted).toHaveBeenCalledOnce();
      const [alias] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, duplicateGym.id));
      expect(alias).toMatchObject({ slug: duplicateGym.slug, mergedIntoGymId: gym.id });
      expect((await resolveCanonicalGymBySlug(duplicateGym.slug!))?.uuid).toBe(gym.uuid);
    } finally {
      intercepted.mockRestore();
    }
  });
  it('exchanges aliases while retaining owner, social records, boards and both UUIDs', async () => {
    await makeMergedAlias();
    await db.insert(tables.gymMembers).values({ gymId: gym.id, userId: scopedAdminId, role: 'editor' });
    await db.insert(tables.gymFollows).values({ gymId: gym.id, userId: scopedAdminId });
    const input = await canonicalRepairInput();
    const result = await repairGymCanonicalSlug(input, context(adminId));
    expect(result).toMatchObject({
      gymUuid: gym.uuid,
      slug: duplicateGym.slug,
      previousSlug: gym.slug,
      url: `https://www.boardsesh.com/gym/${duplicateGym.slug}`,
    });
    const [survivor] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, gym.id));
    const [alias] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, duplicateGym.id));
    expect(survivor).toMatchObject({
      ownerId,
      slug: duplicateGym.slug,
      deletedAt: null,
      mergedIntoGymId: null,
      isPublic: gym.isPublic,
      isListed: gym.isListed,
      name: gym.name,
    });
    expect(alias).toMatchObject({ ownerId, slug: gym.slug, mergedIntoGymId: gym.id });
    expect(alias!.deletedAt).toBeInstanceOf(Date);
    for (const slug of [gym.slug!, duplicateGym.slug!])
      expect((await resolveCanonicalGymBySlug(slug))?.uuid).toBe(gym.uuid);
    for (const gymUuid of [gym.uuid, duplicateGym.uuid])
      expect((await resolveCanonicalGymByUuid(gymUuid))?.uuid).toBe(gym.uuid);
    expect((await currentBoardState()).current).toMatchObject({ gymId: gym.id, ownerId });
    expect(await db.select().from(tables.gymMembers).where(eq(tables.gymMembers.gymId, gym.id))).toMatchObject([
      { userId: scopedAdminId, role: 'editor' },
    ]);
    expect(await db.select().from(tables.gymFollows).where(eq(tables.gymFollows.gymId, gym.id))).toMatchObject([
      { userId: scopedAdminId },
    ]);
    const [audit] = await db
      .select()
      .from(tables.gymDirectoryRepairAudit)
      .where(eq(tables.gymDirectoryRepairAudit.gymUuid, gym.uuid));
    expect(audit).toMatchObject({
      operation: 'repair_gym_canonical_slug',
      actorUserId: adminId,
      reason: input.reason,
      before: { slug: gym.slug, aliasSlug: duplicateGym.slug, ownerId },
      after: { slug: duplicateGym.slug, aliasSlug: gym.slug, ownerId },
    });
    await expect(authorizeCanonicalSlugReplay(input, context(adminId))).resolves.toBeUndefined();
  });

  it.each(['survivor', 'alias'])('rejects stale %s state before updating either slug', async (changed) => {
    await makeMergedAlias();
    const input = await canonicalRepairInput();
    await db
      .update(tables.gyms)
      .set({ description: 'Changed after inspection' })
      .where(eq(tables.gyms.id, changed === 'survivor' ? gym.id : duplicateGym.id));
    await expect(repairGymCanonicalSlug(input, context(adminId))).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
    expect((await resolveCanonicalGymBySlug(gym.slug!))?.slug).toBe(gym.slug);
    expect(
      await db
        .select()
        .from(tables.gymDirectoryRepairAudit)
        .where(eq(tables.gymDirectoryRepairAudit.gymUuid, gym.uuid)),
    ).toHaveLength(0);
  });

  it('refuses an alias URL claimed by another live gym', async () => {
    await makeMergedAlias();
    await db
      .insert(tables.gyms)
      .values({ uuid: randomUUID(), slug: duplicateGym.slug, name: 'Unrelated venue', ownerId });
    await expect(repairGymCanonicalSlug(await canonicalRepairInput(), context(adminId))).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
  });

  it.each(['previous', 'requested'])('ignores an ordinary deleted gym sharing the %s URL', async (slugKind) => {
    await makeMergedAlias();
    const [deletedGym] = await db
      .insert(tables.gyms)
      .values({
        uuid: randomUUID(),
        slug: slugKind === 'previous' ? gym.slug : duplicateGym.slug,
        name: 'Ordinary deleted listing',
        ownerId,
        deletedAt: new Date(),
      })
      .returning();
    await expect(repairGymCanonicalSlug(await canonicalRepairInput(), context(adminId))).resolves.toMatchObject({
      slug: duplicateGym.slug,
    });
    for (const slug of [gym.slug!, duplicateGym.slug!])
      expect((await resolveCanonicalGymBySlug(slug))?.uuid).toBe(gym.uuid);
    const [unchanged] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, deletedGym!.id));
    expect(unchanged).toEqual(deletedGym);
  });

  it('excludes ordinary deleted listings before applying the collider limit', async () => {
    await makeMergedAlias();
    await db.insert(tables.gyms).values(
      Array.from({ length: 101 }, () => ({
        uuid: randomUUID(),
        slug: duplicateGym.slug,
        name: 'Ordinary deleted listing',
        ownerId,
        deletedAt: new Date(),
      })),
    );
    await expect(repairGymCanonicalSlug(await canonicalRepairInput(), context(adminId))).resolves.toMatchObject({
      slug: duplicateGym.slug,
    });
    expect((await resolveCanonicalGymBySlug(gym.slug!))?.uuid).toBe(gym.uuid);
  });

  it.each(['previous', 'requested'])(
    'still refuses an unrelated merged tombstone sharing the %s URL',
    async (slugKind) => {
      await makeMergedAlias();
      const [unrelated] = await db
        .insert(tables.gyms)
        .values({ uuid: randomUUID(), name: 'Unrelated survivor', ownerId })
        .returning();
      await db.insert(tables.gyms).values({
        uuid: randomUUID(),
        slug: slugKind === 'previous' ? gym.slug : duplicateGym.slug,
        name: 'Unrelated merged listing',
        ownerId,
        deletedAt: new Date(),
        mergedIntoGymId: unrelated!.id,
      });
      await expect(repairGymCanonicalSlug(await canonicalRepairInput(), context(adminId))).rejects.toMatchObject({
        extensions: { code: 'CONFLICT' },
      });
      expect((await resolveCanonicalGymByUuid(gym.uuid))?.slug).toBe(gym.slug);
    },
  );

  it('refuses a merged alias that belongs to another survivor', async () => {
    const [unrelated] = await db
      .insert(tables.gyms)
      .values({ uuid: randomUUID(), name: 'Unrelated venue', ownerId })
      .returning();
    await db
      .update(tables.gyms)
      .set({ deletedAt: new Date(), mergedIntoGymId: unrelated!.id })
      .where(eq(tables.gyms.id, duplicateGym.id));
    await expect(repairGymCanonicalSlug(await canonicalRepairInput(), context(adminId))).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
  });

  it('refuses redirect cycles without changing the merge graph', async () => {
    await db
      .update(tables.gyms)
      .set({ deletedAt: new Date(), mergedIntoGymId: duplicateGym.id })
      .where(eq(tables.gyms.id, duplicateGym.id));
    await expect(repairGymCanonicalSlug(await canonicalRepairInput(), context(adminId))).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
    const [alias] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, duplicateGym.id));
    expect(alias).toMatchObject({ slug: duplicateGym.slug, mergedIntoGymId: duplicateGym.id });
  });

  it('preserves a valid multi-hop alias chain and authorizes its retry', async () => {
    const [middle] = await db
      .insert(tables.gyms)
      .values({ uuid: randomUUID(), name: 'Earlier merge', ownerId, deletedAt: new Date(), mergedIntoGymId: gym.id })
      .returning();
    await db
      .update(tables.gyms)
      .set({ deletedAt: new Date(), mergedIntoGymId: middle!.id })
      .where(eq(tables.gyms.id, duplicateGym.id));
    const input = await canonicalRepairInput();
    await repairGymCanonicalSlug(input, context(adminId));
    expect((await resolveCanonicalGymBySlug(gym.slug!))?.uuid).toBe(gym.uuid);
    await expect(authorizeCanonicalSlugReplay(input, context(adminId))).resolves.toBeUndefined();
    const [alias] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, duplicateGym.id));
    expect(alias!.mergedIntoGymId).toBe(middle!.id);
  });

  it('rolls back the slug exchange and audit when the outer receipt transaction fails', async () => {
    await makeMergedAlias();
    const input = await canonicalRepairInput();
    await expect(
      runWithDatabaseTransaction(async () => {
        await repairGymCanonicalSlug(input, context(adminId));
        throw new Error('receipt failed');
      }),
    ).rejects.toThrow('receipt failed');
    expect((await resolveCanonicalGymByUuid(gym.uuid))?.slug).toBe(gym.slug);
    expect(
      await db
        .select()
        .from(tables.gymDirectoryRepairAudit)
        .where(eq(tables.gymDirectoryRepairAudit.gymUuid, gym.uuid)),
    ).toHaveLength(0);
  });

  it('requires current global administrator authority for writes and retries', async () => {
    await makeMergedAlias();
    const input = await canonicalRepairInput();
    for (const userId of [ownerId, scopedAdminId]) {
      await expect(repairGymCanonicalSlug(input, context(userId))).rejects.toMatchObject({
        extensions: { code: 'FORBIDDEN' },
      });
      await expect(authorizeCanonicalSlugReplay(input, context(userId))).rejects.toMatchObject({
        extensions: { code: 'FORBIDDEN' },
      });
    }
  });
});

async function currentBoardState() {
  const [current] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.uuid, board.uuid));
  const [policy] = await db
    .select()
    .from(tables.resourcePrivacy)
    .where(and(eq(tables.resourcePrivacy.kind, 'board'), eq(tables.resourcePrivacy.resourceId, board.uuid)));
  return { current: current!, policy, hash: boardRepairStateHash(current!, policy) };
}

describe('global-admin duplicate inspection and repair', () => {
  it('refuses gym owners and board-scoped admins, then observes role revocation', async () => {
    await expect(inspectGymDuplicates([gym.uuid], context(ownerId))).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    await expect(assertGymMcpGlobalAdmin(context(scopedAdminId))).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    await expect(assertGymMcpGlobalAdmin(context(adminId))).resolves.toBeUndefined();
    await db.delete(tables.communityRoles).where(eq(tables.communityRoles.userId, adminId));
    await expect(inspectGymDuplicates([gym.uuid], context(adminId))).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });

  it('compares differently named gyms with visible owner identities, omitting pairing secrets and emails', async () => {
    await db
      .update(tables.userBoards)
      .set({ serialNumber: 'pairing-secret' })
      .where(eq(tables.userBoards.id, board.id));
    await db.insert(tables.userProfiles).values({ userId: ownerId, displayName: 'Telefonplan crew' });
    const result = await inspectGymDuplicates([gym.uuid, duplicateGym.uuid], context(adminId));
    expect(result.gyms).toHaveLength(2);
    expect(result.distances[0]?.meters).toBeGreaterThan(4);
    expect(result.distances[0]?.meters).toBeLessThan(5);
    expect(result.gyms.find((entry) => entry.gymUuid === gym.uuid)?.boards[0]).toMatchObject({
      boardUuid: board.uuid,
      ownerId,
      ownerDisplayName: 'Telefonplan crew',
      hasSerialNumber: true,
      hideLocation: true,
      ticks: 0,
      climbEvents: 0,
      stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain('pairing-secret');
    expect(result.gyms[0]).toMatchObject({ ownerId, ownerDisplayName: 'Telefonplan crew' });
    expect(JSON.stringify(result)).not.toContain(`${ownerId}@example.test`);
  });

  it('publishes location explicitly while retaining the board owner, audience and access grants', async () => {
    await db.insert(tables.resourcePrivacy).values({
      kind: 'board',
      resourceId: board.uuid,
      ownerId,
      audience: 'followers',
      locationAudience: 'only_me',
      inheritFollowers: true,
      revision: 4,
    });
    await db
      .insert(tables.resourceGrants)
      .values({ kind: 'board', resourceId: board.uuid, userId: scopedAdminId, status: 'revoked' });
    const { hash } = await currentBoardState();
    await correctBoardLocationVisibility(
      {
        gymUuid: gym.uuid,
        boardUuid: board.uuid,
        expectedStateHash: hash,
        hideLocation: false,
        reason: 'Gym operator confirmed this public physical wall.',
      },
      context(adminId),
    );
    const { current, policy } = await currentBoardState();
    expect(current).toMatchObject({ ownerId, hideLocation: false, isPublic: true, isUnlisted: false });
    expect(current.syncFrozenAt).toBeInstanceOf(Date);
    expect(policy).toMatchObject({
      ownerId,
      audience: 'followers',
      locationAudience: 'public',
      inheritFollowers: true,
      revision: 5,
    });
    const grants = await db
      .select()
      .from(tables.resourceGrants)
      .where(eq(tables.resourceGrants.resourceId, board.uuid));
    expect(grants).toMatchObject([{ userId: scopedAdminId, status: 'revoked' }]);
    const audits = await db
      .select()
      .from(tables.boardModerationEvents)
      .where(eq(tables.boardModerationEvents.boardId, board.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: adminId,
      actorRole: 'global_admin',
      reason: 'Gym operator confirmed this public physical wall.',
      details: {
        adminRepair: {
          previousHideLocation: true,
          hideLocation: false,
          previousLocationAudience: 'only_me',
          locationAudience: 'public',
        },
      },
    });
    expect(effects.privacyChanged).toHaveBeenCalledOnce();
  });

  it('rejects a stale policy or board state before making a repair', async () => {
    const { hash } = await currentBoardState();
    await db
      .insert(tables.resourcePrivacy)
      .values({ kind: 'board', resourceId: board.uuid, ownerId, audience: 'public', locationAudience: 'members' });
    await expect(
      correctBoardLocationVisibility(
        {
          gymUuid: gym.uuid,
          boardUuid: board.uuid,
          expectedStateHash: hash,
          hideLocation: false,
          reason: 'Confirmed the public location with gym staff.',
        },
        context(adminId),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    expect((await currentBoardState()).current.hideLocation).toBe(true);
    expect(effects.privacyChanged).not.toHaveBeenCalled();
  });

  it('rolls back the flag, policy, audit and effects when the enclosing receipt transaction fails', async () => {
    const { hash } = await currentBoardState();
    await expect(
      runWithDatabaseTransaction(async () => {
        await correctBoardLocationVisibility(
          {
            gymUuid: gym.uuid,
            boardUuid: board.uuid,
            expectedStateHash: hash,
            hideLocation: false,
            reason: 'Confirmed the public location with gym staff.',
          },
          context(adminId),
        );
        expect(effects.privacyChanged).not.toHaveBeenCalled();
        throw new Error('receipt insert refused');
      }),
    ).rejects.toThrow('receipt insert refused');
    expect((await currentBoardState()).current.hideLocation).toBe(true);
    expect(
      await db.select().from(tables.boardModerationEvents).where(eq(tables.boardModerationEvents.boardId, board.id)),
    ).toHaveLength(0);
    expect(effects.privacyChanged).not.toHaveBeenCalled();
  });

  it('holds the live admin role until a standalone repair and its audit commit', async () => {
    const { hash } = await currentBoardState();
    let release!: () => void;
    let reachedAudit!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auditing = new Promise<void>((resolve) => {
      reachedAudit = resolve;
    });
    const originalAudit = moderation.recordBoardModerationEvent;
    const spy = vi.spyOn(moderation, 'recordBoardModerationEvent').mockImplementation(async (executor, event) => {
      reachedAudit();
      await hold;
      return originalAudit(executor, event);
    });
    const repair = correctBoardLocationVisibility(
      {
        gymUuid: gym.uuid,
        boardUuid: board.uuid,
        expectedStateHash: hash,
        hideLocation: false,
        reason: 'A confirmed public gym wall needs its location shown.',
      },
      context(adminId),
    );
    let revokerPid!: (pid: number) => void;
    const revokerStarted = new Promise<number>((resolve) => {
      revokerPid = resolve;
    });
    let revoked = false;
    let revocation: Promise<unknown> | undefined;
    try {
      await auditing;
      revocation = db.transaction(async (transaction) => {
        const rows = await transaction.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        revokerPid(Array.from(rows)[0]!.pid);
        await transaction.delete(tables.communityRoles).where(eq(tables.communityRoles.userId, adminId));
        revoked = true;
      });
      const pid = await revokerStarted;
      let waitsForRole = false;
      for (let attempt = 0; attempt < 100 && !revoked && !waitsForRole; attempt++) {
        const rows = await db.execute<{ waitType: string | null }>(
          sql`SELECT wait_event_type AS "waitType" FROM pg_stat_activity WHERE pid=${pid}`,
        );
        waitsForRole = Array.from(rows)[0]?.waitType === 'Lock';
        if (!waitsForRole) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(waitsForRole).toBe(true);
      expect(revoked).toBe(false);
      release();
      await repair;
      await revocation;
      expect((await currentBoardState()).current.hideLocation).toBe(false);
      await expect(assertGymMcpGlobalAdmin(context(adminId))).rejects.toMatchObject({
        extensions: { code: 'FORBIDDEN' },
      });
    } finally {
      release();
      await Promise.allSettled([repair, ...(revocation ? [revocation] : [])]);
      spy.mockRestore();
    }
  });

  it('waits for an owner privacy writer before acquiring the board lock', async () => {
    const { hash } = await currentBoardState();
    let ownerLocked!: () => void;
    let probeBoard!: () => void;
    const ready = new Promise<void>((resolve) => {
      ownerLocked = resolve;
    });
    const probe = new Promise<void>((resolve) => {
      probeBoard = resolve;
    });
    const ownerWriter = db.transaction(async (transaction) => {
      await transaction
        .select({ id: tables.users.id })
        .from(tables.users)
        .where(eq(tables.users.id, ownerId))
        .for('update');
      ownerLocked();
      await probe;
      // A repair that took board -> owner would make this NOWAIT acquisition fail.
      await transaction
        .select({ id: tables.userBoards.id })
        .from(tables.userBoards)
        .where(eq(tables.userBoards.id, board.id))
        .for('update', { noWait: true });
    });
    await ready;
    const repair = correctBoardLocationVisibility(
      {
        gymUuid: gym.uuid,
        boardUuid: board.uuid,
        expectedStateHash: hash,
        hideLocation: false,
        reason: 'The operator confirmed this public wall location.',
      },
      context(adminId),
    );
    try {
      let waitingForOwner = false;
      for (let attempt = 0; attempt < 100 && !waitingForOwner; attempt++) {
        const rows = await db.execute<{ waiting: boolean }>(
          sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%users%' AND query ILIKE '%key share%') AS waiting`,
        );
        waitingForOwner = Array.from(rows)[0]?.waiting ?? false;
        if (!waitingForOwner) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingForOwner).toBe(true);
      probeBoard();
      await ownerWriter;
      await repair;
      expect((await currentBoardState()).current.hideLocation).toBe(false);
    } finally {
      probeBoard();
      await Promise.allSettled([ownerWriter, repair]);
    }
  });

  it('corrects setup through the existing writer with exactly one reasoned moderation event', async () => {
    const { hash } = await currentBoardState();
    await correctBoardSetup(
      {
        gymUuid: gym.uuid,
        boardUuid: board.uuid,
        expectedStateHash: hash,
        changes: { isAngleAdjustable: false },
        reason: 'The gym confirmed the physical wall is fixed at forty degrees.',
      },
      context(adminId),
    );
    const { current } = await currentBoardState();
    expect(current.isAngleAdjustable).toBe(false);
    expect(current.hideLocation).toBe(true);
    const audits = await db
      .select()
      .from(tables.boardModerationEvents)
      .where(eq(tables.boardModerationEvents.boardId, board.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: adminId,
      actorRole: 'global_admin',
      reason: 'The gym confirmed the physical wall is fixed at forty degrees.',
      details: { mutation: 'adminUpdateBoard', fields: ['isAngleAdjustable'] },
    });
  });

  it('merges the explicit gym pair, retains its reason, and reauthorizes exact tombstone replay', async () => {
    await db.update(tables.userBoards).set({ gymId: duplicateGym.id }).where(eq(tables.userBoards.id, board.id));
    const inspection = await inspectGymDuplicates([gym.uuid, duplicateGym.uuid], context(adminId));
    await mergeAdminGyms(
      {
        canonicalGymUuid: gym.uuid,
        duplicateGymUuids: [duplicateGym.uuid],
        expectedStates: inspection.gyms.map((entry) => ({ gymUuid: entry.gymUuid, stateHash: entry.stateHash })),
        allowSystemCanonicalOverride: false,
        reason: 'The operator confirmed these two pins identify the same gym.',
      },
      context(adminId),
    );
    expect((await currentBoardState()).current.gymId).toBe(gym.id);
    expect((await resolveCanonicalGymByUuid(duplicateGym.uuid))?.uuid).toBe(gym.uuid);
    const [audit] = await db
      .select()
      .from(tables.gymMergeAudit)
      .where(eq(tables.gymMergeAudit.duplicateGymId, duplicateGym.id));
    expect(audit?.performedBy).toBe(adminId);
    expect(audit?.movedRows).toMatchObject({ reason: 'The operator confirmed these two pins identify the same gym.' });
    await expect(
      authorizeAdminMergeReplay('gym', gym.uuid, [duplicateGym.uuid], context(adminId)),
    ).resolves.toBeUndefined();
    const tombstone = await inspectGymDuplicates([duplicateGym.uuid], context(adminId));
    expect(tombstone.gyms[0]?.isMerged).toBe(true);
    await db.delete(tables.communityRoles).where(eq(tables.communityRoles.userId, adminId));
    await expect(
      authorizeAdminMergeReplay('gym', gym.uuid, [duplicateGym.uuid], context(adminId)),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('repairs and consolidates a five-record, serial-less Telefonplan-shaped fixture through the actual tools', async () => {
    const fullSets = '17,18,19,20,21,22,23';
    const additional = await db
      .insert(tables.userBoards)
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          uuid: randomUUID(),
          slug: randomUUID(),
          name: `Duplicate wall ${index}`,
          ownerId,
          gymId: duplicateGym.id,
          boardType: 'moonboard',
          layoutId: index === 0 ? 2 : 5,
          sizeId: 1,
          setIds: index === 0 ? '2,3,4' : index === 1 ? '17,18,19,21,22,23' : fullSets,
          isPublic: true,
          hideLocation: false,
        })),
      )
      .returning();
    const seedProblemUuid = randomUUID();
    await db.insert(tables.boardClimbEvents).values({
      boardId: additional[0]!.id,
      boardType: 'moonboard',
      climbUuid: seedProblemUuid,
      angle: 40,
      userId: ownerId,
      seq: 1,
      frames: '',
      reportingBoardId: additional[0]!.id,
      reportingGymId: duplicateGym.id,
      confirmedAt: new Date().toISOString(),
    });
    async function callTool(name: string, arguments_: Record<string, unknown>) {
      return runWithDatabaseTransaction(() =>
        gymMcpAdminTools
          .find((tool) => tool.name === name)!
          .run(
            {
              ...arguments_,
              idempotencyKey: randomUUID(),
              confirm: true,
              reason: 'The gym operator confirmed one physical full-set 2019 MoonBoard.',
            },
            context(adminId),
          ),
      );
    }
    let inspection = await inspectGymDuplicates([gym.uuid, duplicateGym.uuid], context(adminId));
    await callTool('merge_duplicate_gyms', {
      canonicalGymUuid: gym.uuid,
      duplicateGymUuids: [duplicateGym.uuid],
      expectedStates: inspection.gyms.map((entry) => ({ gymUuid: entry.gymUuid, stateHash: entry.stateHash })),
    });
    inspection = await inspectGymDuplicates([gym.uuid], context(adminId));
    for (const duplicate of additional.slice(0, 2)) {
      const snapshot = inspection.gyms[0]!.boards.find((entry) => entry.boardUuid === duplicate.uuid)!;
      await callTool('correct_gym_board_setup', {
        gymUuid: gym.uuid,
        boardUuid: duplicate.uuid,
        expectedStateHash: snapshot.stateHash,
        changes: { layoutId: 5, setIds: fullSets },
        allowDuplicateConfig: true,
      });
    }
    const hidden = inspection.gyms[0]!.boards.find((entry) => entry.boardUuid === board.uuid)!;
    await callTool('correct_gym_board_location_visibility', {
      gymUuid: gym.uuid,
      boardUuid: board.uuid,
      expectedStateHash: hidden.stateHash,
      hideLocation: false,
    });
    inspection = await inspectGymDuplicates([gym.uuid], context(adminId));
    await callTool('merge_duplicate_gym_boards', {
      gymUuid: gym.uuid,
      canonicalBoardUuid: board.uuid,
      duplicateBoardUuids: additional.map((entry) => entry.uuid),
      samePhysicalWall: true,
      expectedStates: inspection.gyms[0]!.boards.map((entry) => ({
        boardUuid: entry.boardUuid,
        stateHash: entry.stateHash,
      })),
    });
    const after = await inspectGymDuplicates([gym.uuid], context(adminId));
    expect(after.gyms[0]!.boards.filter((entry) => entry.deletedAt === null)).toMatchObject([
      { boardUuid: board.uuid, layoutId: 5, setIds: fullSets, hideLocation: false },
    ]);
    expect(after.gyms[0]!.boards.filter((entry) => entry.mergedIntoBoardUuid === board.uuid)).toHaveLength(4);
    const [event] = await db
      .select()
      .from(tables.boardClimbEvents)
      .where(eq(tables.boardClimbEvents.climbUuid, seedProblemUuid));
    expect(event).toMatchObject({
      boardId: board.id,
      climbUuid: seedProblemUuid,
      reportingBoardId: additional[0]!.id,
      reportingGymId: duplicateGym.id,
    });
  });

  it.each(['pinBoard', 'recordBoardOpened', 'unpinBoard', 'unfollowBoard'] as const)(
    'serializes %s before a merge so its result survives',
    async (action) => {
      const [duplicate] = await db
        .insert(tables.userBoards)
        .values({
          uuid: randomUUID(),
          slug: randomUUID(),
          name: 'Duplicate full-set wall',
          ownerId,
          gymId: gym.id,
          boardType: 'moonboard',
          layoutId: 5,
          sizeId: 1,
          setIds: board.setIds,
          isPublic: true,
        })
        .returning();
      await db.insert(tables.boardFollows).values({ userId: ownerId, boardUuid: duplicate!.uuid });
      await db
        .insert(tables.userBoardActivity)
        .values({ userId: ownerId, boardUuid: duplicate!.uuid, pinnedAt: action === 'unpinBoard' ? new Date() : null });
      const expectedStates = (await inspectGymDuplicates([gym.uuid], context(adminId))).gyms[0]!.boards.map(
        (entry) => ({ boardUuid: entry.boardUuid, stateHash: entry.stateHash }),
      );
      const merge = () =>
        mergeDuplicateBoards(
          {
            gymUuid: gym.uuid,
            canonicalBoardUuid: board.uuid,
            duplicateBoardUuids: [duplicate!.uuid],
            expectedStates,
            reason: 'The operator confirmed these are one physical wall.',
          },
          context(adminId),
        );
      let release!: () => void;
      let locked!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const preference = runWithDatabaseTransaction(async () => {
        await socialBoardMutations[action]({}, { input: { boardUuid: duplicate!.uuid } }, context(ownerId));
        locked();
        await hold;
      });
      try {
        await ready;
        await expect(merge()).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
        release();
        await preference;
        await merge();
        const [activity] = await db
          .select()
          .from(tables.userBoardActivity)
          .where(and(eq(tables.userBoardActivity.userId, ownerId), eq(tables.userBoardActivity.boardUuid, board.uuid)));
        const follows = await db
          .select()
          .from(tables.boardFollows)
          .where(and(eq(tables.boardFollows.userId, ownerId), eq(tables.boardFollows.boardUuid, board.uuid)));
        if (action === 'pinBoard') expect(activity?.pinnedAt).toBeInstanceOf(Date);
        if (action === 'recordBoardOpened') expect(activity?.lastUsedAt).toBeInstanceOf(Date);
        if (action === 'unpinBoard') expect(activity?.pinnedAt).toBeNull();
        if (action === 'unfollowBoard') expect(follows).toHaveLength(0);
        await expect(
          socialBoardMutations[action]({}, { input: { boardUuid: duplicate!.uuid } }, context(ownerId)),
        ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
      } finally {
        release();
        await preference;
      }
    },
  );
});
