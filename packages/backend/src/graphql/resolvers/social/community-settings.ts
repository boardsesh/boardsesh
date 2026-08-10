import { eq, and } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { SetCommunitySettingInputSchema } from '../../../validation/schemas';
import { requireAdmin, requireAdminOrLeader, hasAdmin } from './roles';

/**
 * Settings under this prefix configure gym operations rather than climb-grade
 * moderation, and they gate actions (`requireAdmin`) that community leaders
 * cannot perform themselves. They are therefore admin-only to write and hidden
 * from non-admin reads — otherwise a leader could flip `gym_claim_auto_approve`
 * on and then claim a gym, escalating straight past the gym-claim admin gate.
 */
export const GYM_SETTING_PREFIX = 'gym_';

export const GYM_CLAIM_AUTO_APPROVE_KEY = 'gym_claim_auto_approve';

export function isGymSettingKey(key: string): boolean {
  return key.startsWith(GYM_SETTING_PREFIX);
}

// Default community settings
export const DEFAULTS: Record<string, string> = {
  approval_threshold: '5',
  outlier_min_ascents: '10',
  outlier_grade_diff: '2',
  admin_vote_weight: '3',
  leader_vote_weight: '2',
  // Off until an admin turns it on — auto-approval transfers gym ownership.
  [GYM_CLAIM_AUTO_APPROVE_KEY]: '0',
};

/**
 * Resolve a community setting with cascade: climb -> board -> global -> default.
 */
export async function resolveCommunitySetting(
  key: string,
  climbUuid?: string,
  angle?: number | null,
  boardType?: string,
): Promise<string> {
  // 1. Try climb-level
  if (climbUuid) {
    const [climbSetting] = await db
      .select({ value: dbSchema.communitySettings.value })
      .from(dbSchema.communitySettings)
      .where(
        and(
          eq(dbSchema.communitySettings.scope, 'climb'),
          eq(dbSchema.communitySettings.scopeKey, climbUuid),
          eq(dbSchema.communitySettings.key, key),
        ),
      )
      .limit(1);
    if (climbSetting) return climbSetting.value;
  }

  // 2. Try board-level
  if (boardType) {
    const [boardSetting] = await db
      .select({ value: dbSchema.communitySettings.value })
      .from(dbSchema.communitySettings)
      .where(
        and(
          eq(dbSchema.communitySettings.scope, 'board'),
          eq(dbSchema.communitySettings.scopeKey, boardType),
          eq(dbSchema.communitySettings.key, key),
        ),
      )
      .limit(1);
    if (boardSetting) return boardSetting.value;
  }

  // 3. Try global
  const [globalSetting] = await db
    .select({ value: dbSchema.communitySettings.value })
    .from(dbSchema.communitySettings)
    .where(
      and(
        eq(dbSchema.communitySettings.scope, 'global'),
        eq(dbSchema.communitySettings.scopeKey, ''),
        eq(dbSchema.communitySettings.key, key),
      ),
    )
    .limit(1);
  if (globalSetting) return globalSetting.value;

  // 4. Default
  return DEFAULTS[key] || '0';
}

/**
 * Is auto-approval of gym ownership claims turned on? Global-scope only — a gym
 * claim isn't tied to a climb or a board type, so the cascade falls straight
 * through to the global row and then the (off) default.
 */
export async function gymClaimAutoApproveEnabled(): Promise<boolean> {
  const value = await resolveCommunitySetting(GYM_CLAIM_AUTO_APPROVE_KEY);
  return value === '1' || value === 'true';
}

export const socialCommunitySettingsQueries = {
  communitySettings: async (
    _: unknown,
    { scope, scopeKey }: { scope: string; scopeKey: string },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);

    const settings = await db
      .select()
      .from(dbSchema.communitySettings)
      .where(and(eq(dbSchema.communitySettings.scope, scope), eq(dbSchema.communitySettings.scopeKey, scopeKey)));

    // Gym settings are admin-only config; don't leak them (e.g. whether claim
    // auto-approval is live) to every signed-in user reading this query.
    const visible = (await hasAdmin(ctx.userId!)) ? settings : settings.filter((row) => !isGymSettingKey(row.key));

    return visible.map((s) => ({
      id: s.id,
      scope: s.scope,
      scopeKey: s.scopeKey,
      key: s.key,
      value: s.value,
      setBy: s.setBy,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));
  },
};

export const socialCommunitySettingsMutations = {
  setCommunitySettings: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);

    // Validate before the role check so the gate can branch on the key. Gym
    // settings need full admin: they gate actions a community leader can't
    // perform, so letting a leader write them would be an escalation.
    const validated = validateInput(SetCommunitySettingInputSchema, input, 'input');
    const { scope, scopeKey, key, value } = validated;

    if (isGymSettingKey(key)) {
      await requireAdmin(ctx);
    } else {
      await requireAdminOrLeader(ctx);
    }
    await applyRateLimit(ctx, 10, 'setCommunitySettings');

    const userId = ctx.userId!;

    // Single-statement upsert against the (scope, scope_key, key) unique index.
    // A SELECT-then-INSERT/UPDATE would let two concurrent admin writes to the
    // same key race, with the loser hitting the unique constraint and erroring.
    const [result] = await db
      .insert(dbSchema.communitySettings)
      .values({ scope, scopeKey, key, value, setBy: userId })
      .onConflictDoUpdate({
        target: [dbSchema.communitySettings.scope, dbSchema.communitySettings.scopeKey, dbSchema.communitySettings.key],
        set: { value, setBy: userId, updatedAt: new Date() },
      })
      .returning();

    return {
      id: result.id,
      scope: result.scope,
      scopeKey: result.scopeKey,
      key: result.key,
      value: result.value,
      setBy: result.setBy,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    };
  },
};
