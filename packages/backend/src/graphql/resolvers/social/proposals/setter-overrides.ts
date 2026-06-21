import { eq, and } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../../shared/helpers';
import { SetterOverrideInputSchema, FreezeClimbInputSchema } from '../../../../validation/schemas';
import { requireAdminOrLeader } from '../roles';
import { notifyClimbRevalidated } from '../../../../lib/web-revalidate';

/**
 * Setter override: directly set community grade/benchmark status on a climb.
 */
export async function setterOverrideCommunityStatus(_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) {
  requireAuthenticated(ctx);
  await applyRateLimit(ctx, 10, 'setterOverrideCommunityStatus');

  const validated = validateInput(SetterOverrideInputSchema, input, 'input');
  const { climbUuid, boardType, angle, communityGrade, isBenchmark } = validated;
  const userId = ctx.userId!;

  // Verify caller is setter or admin/leader
  const [climb] = await db
    .select({
      uuid: dbSchema.boardClimbs.uuid,
      setterId: dbSchema.boardClimbs.setterId,
      userId: dbSchema.boardClimbs.userId,
      climbBoardType: dbSchema.boardClimbs.boardType,
    })
    .from(dbSchema.boardClimbs)
    .where(eq(dbSchema.boardClimbs.uuid, climbUuid))
    .limit(1);

  if (!climb) {
    throw new Error('Climb not found');
  }

  // Check if caller is the setter
  let isSetter = false;

  // For locally-created climbs, userId directly stores the Boardsesh user ID
  if (climb.userId && climb.userId === userId) {
    isSetter = true;
  }

  // For Aurora-synced climbs, match setterId via aurora credentials
  if (!isSetter && climb.setterId) {
    const [cred] = await db
      .select({ auroraUserId: dbSchema.auroraCredentials.auroraUserId })
      .from(dbSchema.auroraCredentials)
      .where(and(eq(dbSchema.auroraCredentials.userId, userId), eq(dbSchema.auroraCredentials.boardType, boardType)))
      .limit(1);

    if (cred?.auroraUserId === climb.setterId) {
      isSetter = true;
    }
  }

  // If not the setter, require admin or leader role (throws if unauthorized)
  if (!isSetter) {
    await requireAdminOrLeader(ctx, boardType);
  }

  // UPSERT climbCommunityStatus
  const [existing] = await db
    .select()
    .from(dbSchema.climbCommunityStatus)
    .where(
      and(
        eq(dbSchema.climbCommunityStatus.climbUuid, climbUuid),
        eq(dbSchema.climbCommunityStatus.boardType, boardType),
        eq(dbSchema.climbCommunityStatus.angle, angle),
      ),
    )
    .limit(1);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (communityGrade !== undefined) updates.communityGrade = communityGrade;
  if (isBenchmark !== undefined && isBenchmark !== null) updates.isBenchmark = isBenchmark;

  let result;
  if (existing) {
    [result] = await db
      .update(dbSchema.climbCommunityStatus)
      .set(updates)
      .where(eq(dbSchema.climbCommunityStatus.id, existing.id))
      .returning();
  } else {
    [result] = await db
      .insert(dbSchema.climbCommunityStatus)
      .values({
        climbUuid,
        boardType,
        angle,
        communityGrade: communityGrade || null,
        isBenchmark: isBenchmark || false,
      })
      .returning();
  }

  void notifyClimbRevalidated(climbUuid);

  return {
    climbUuid: result.climbUuid,
    boardType: result.boardType,
    angle: result.angle,
    communityGrade: result.communityGrade || null,
    isBenchmark: result.isBenchmark,
    isClassic: false,
    isFrozen: false,
    freezeReason: null,
    openProposalCount: 0,
    outlierAnalysis: null,
    updatedAt: result.updatedAt.toISOString(),
  };
}

/**
 * Freeze/unfreeze a climb to prevent new proposals.
 */
export async function freezeClimb(_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) {
  const validated = validateInput(FreezeClimbInputSchema, input, 'input');
  const { climbUuid, boardType, frozen, reason } = validated;

  await requireAdminOrLeader(ctx, boardType);
  const userId = ctx.userId!;

  // UPSERT community setting for freeze
  const freezeKey = 'climb_frozen';
  const [existing] = await db
    .select()
    .from(dbSchema.communitySettings)
    .where(
      and(
        eq(dbSchema.communitySettings.scope, 'climb'),
        eq(dbSchema.communitySettings.scopeKey, climbUuid),
        eq(dbSchema.communitySettings.key, freezeKey),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(dbSchema.communitySettings)
      .set({ value: String(frozen), setBy: userId, updatedAt: new Date() })
      .where(eq(dbSchema.communitySettings.id, existing.id));
  } else {
    await db.insert(dbSchema.communitySettings).values({
      scope: 'climb',
      scopeKey: climbUuid,
      key: freezeKey,
      value: String(frozen),
      setBy: userId,
    });
  }

  // Also save freeze reason
  if (reason) {
    const reasonKey = 'climb_freeze_reason';
    const [existingReason] = await db
      .select()
      .from(dbSchema.communitySettings)
      .where(
        and(
          eq(dbSchema.communitySettings.scope, 'climb'),
          eq(dbSchema.communitySettings.scopeKey, climbUuid),
          eq(dbSchema.communitySettings.key, reasonKey),
        ),
      )
      .limit(1);

    if (existingReason) {
      await db
        .update(dbSchema.communitySettings)
        .set({ value: reason, setBy: userId, updatedAt: new Date() })
        .where(eq(dbSchema.communitySettings.id, existingReason.id));
    } else {
      await db.insert(dbSchema.communitySettings).values({
        scope: 'climb',
        scopeKey: climbUuid,
        key: reasonKey,
        value: reason,
        setBy: userId,
      });
    }
  }

  return true;
}
