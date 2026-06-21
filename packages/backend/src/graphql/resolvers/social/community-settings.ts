import { eq, and } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { SetCommunitySettingInputSchema } from '../../../validation/schemas';
import { requireAdminOrLeader } from './roles';

// Default community settings
export const DEFAULTS: Record<string, string> = {
  approval_threshold: '5',
  outlier_min_ascents: '10',
  outlier_grade_diff: '2',
  admin_vote_weight: '3',
  leader_vote_weight: '2',
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

    return settings.map((s) => ({
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
    await requireAdminOrLeader(ctx);
    await applyRateLimit(ctx, 10, 'setCommunitySettings');

    const validated = validateInput(SetCommunitySettingInputSchema, input, 'input');
    const { scope, scopeKey, key, value } = validated;
    const userId = ctx.userId!;

    // UPSERT
    const [existing] = await db
      .select()
      .from(dbSchema.communitySettings)
      .where(
        and(
          eq(dbSchema.communitySettings.scope, scope),
          eq(dbSchema.communitySettings.scopeKey, scopeKey),
          eq(dbSchema.communitySettings.key, key),
        ),
      )
      .limit(1);

    let result;
    if (existing) {
      [result] = await db
        .update(dbSchema.communitySettings)
        .set({ value, setBy: userId, updatedAt: new Date() })
        .where(eq(dbSchema.communitySettings.id, existing.id))
        .returning();
    } else {
      [result] = await db
        .insert(dbSchema.communitySettings)
        .values({ scope, scopeKey, key, value, setBy: userId })
        .returning();
    }

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
