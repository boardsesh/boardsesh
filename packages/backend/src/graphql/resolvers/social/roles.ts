import { eq, and, isNull, count } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { GrantRoleInputSchema, RevokeRoleInputSchema } from '../../../validation/schemas';

/**
 * Non-throwing check: does the user hold an admin role that is global or scoped
 * to the given board type? Mirrors `requireAdmin` for callers that need a
 * boolean rather than a throw (e.g. deciding whether to redact admin-only rows
 * from a query result).
 */
export async function hasAdmin(userId: string, boardType?: string | null): Promise<boolean> {
  const roles = await db
    .select({ role: dbSchema.communityRoles.role, boardType: dbSchema.communityRoles.boardType })
    .from(dbSchema.communityRoles)
    .where(eq(dbSchema.communityRoles.userId, userId));

  return roles.some((entry) => entry.role === 'admin' && (entry.boardType === null || entry.boardType === boardType));
}

/**
 * Check if a user has admin role (global or for a specific board type).
 */
export async function requireAdmin(ctx: ConnectionContext, boardType?: string | null): Promise<void> {
  requireAuthenticated(ctx);

  if (!(await hasAdmin(ctx.userId!, boardType))) {
    throw new Error('Admin role required for this operation');
  }
}

/**
 * A community role row reduced to what authorization checks need: the role name
 * and its board-type scope (null = global, applies to every board type).
 */
export type CommunityRoleScope = { role: string; boardType: string | null };

/**
 * Fetch a user's community role rows ({ role, boardType }). Batch callers fetch
 * once and compute admin/leader access for many board types in-memory via
 * `rolesGrantAdminOrLeader`, avoiding a per-row query.
 */
export async function getUserCommunityRoles(userId: string): Promise<CommunityRoleScope[]> {
  return db
    .select({ role: dbSchema.communityRoles.role, boardType: dbSchema.communityRoles.boardType })
    .from(dbSchema.communityRoles)
    .where(eq(dbSchema.communityRoles.userId, userId));
}

/**
 * Pure predicate: do the given role rows grant admin/community_leader access for
 * a board type? A role qualifies when it is admin or community_leader AND its
 * scope is global (null) or matches the requested board type.
 */
export function rolesGrantAdminOrLeader(roles: CommunityRoleScope[], boardType?: string | null): boolean {
  return roles.some(
    (entry) =>
      (entry.role === 'admin' || entry.role === 'community_leader') &&
      (entry.boardType === null || entry.boardType === boardType),
  );
}

/**
 * Non-throwing check: does the user hold an admin or community_leader role that
 * is global or scoped to the given board type? Mirrors `requireAdminOrLeader`'s
 * logic for callers (like `canEdit` computation) that need a boolean, not a throw.
 */
export async function hasAdminOrLeader(userId: string, boardType?: string | null): Promise<boolean> {
  const roles = await getUserCommunityRoles(userId);
  return rolesGrantAdminOrLeader(roles, boardType);
}

/**
 * Check if a user has admin or community_leader role.
 */
export async function requireAdminOrLeader(ctx: ConnectionContext, boardType?: string | null): Promise<void> {
  requireAuthenticated(ctx);

  const hasRole = await hasAdminOrLeader(ctx.userId!, boardType);

  if (!hasRole) {
    throw new Error('Admin or community leader role required for this operation');
  }
}

/**
 * Get a user's vote weight based on their role.
 */
export async function getUserVoteWeight(userId: string, boardType?: string | null): Promise<number> {
  const roles = await db
    .select({ role: dbSchema.communityRoles.role, boardType: dbSchema.communityRoles.boardType })
    .from(dbSchema.communityRoles)
    .where(eq(dbSchema.communityRoles.userId, userId));

  let maxWeight = 1;
  for (const r of roles) {
    if (r.boardType !== null && r.boardType !== boardType) continue;
    if (r.role === 'admin') maxWeight = Math.max(maxWeight, 3);
    if (r.role === 'community_leader') maxWeight = Math.max(maxWeight, 2);
  }

  return maxWeight;
}

async function enrichRoleAssignment(role: typeof dbSchema.communityRoles.$inferSelect) {
  const [user] = await db
    .select({
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.userProfiles)
    .where(eq(dbSchema.userProfiles.userId, role.userId))
    .limit(1);

  let grantedByDisplayName: string | undefined;
  if (role.grantedBy) {
    const [granter] = await db
      .select({ displayName: dbSchema.userProfiles.displayName })
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, role.grantedBy))
      .limit(1);
    grantedByDisplayName = granter?.displayName || undefined;
  }

  return {
    id: role.id,
    userId: role.userId,
    userDisplayName: user?.displayName || undefined,
    userAvatarUrl: user?.avatarUrl || undefined,
    role: role.role,
    boardType: role.boardType,
    grantedBy: role.grantedBy,
    grantedByDisplayName,
    createdAt: role.createdAt.toISOString(),
  };
}

export const socialRoleQueries = {
  communityRoles: async (_: unknown, { boardType }: { boardType?: string }, ctx: ConnectionContext) => {
    // Role assignments (including who holds tester) are admin-only — the sole consumer is
    // the admin role-management screen. Don't let unauthenticated callers enumerate them.
    await requireAdmin(ctx);

    const conditions = boardType ? [eq(dbSchema.communityRoles.boardType, boardType)] : [];

    const roles =
      conditions.length > 0
        ? await db.select().from(dbSchema.communityRoles).where(conditions[0])
        : await db.select().from(dbSchema.communityRoles);

    return Promise.all(roles.map(enrichRoleAssignment));
  },

  myRoles: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const roles = await db.select().from(dbSchema.communityRoles).where(eq(dbSchema.communityRoles.userId, userId));

    return Promise.all(roles.map(enrichRoleAssignment));
  },
};

export const socialRoleMutations = {
  grantRole: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 10, 'grantRole');

    const validated = validateInput(GrantRoleInputSchema, input, 'input');
    const { userId, role, boardType } = validated;

    // Check if role already exists
    const existing = boardType
      ? await db
          .select()
          .from(dbSchema.communityRoles)
          .where(
            and(
              eq(dbSchema.communityRoles.userId, userId),
              eq(dbSchema.communityRoles.role, role),
              eq(dbSchema.communityRoles.boardType, boardType),
            ),
          )
          .limit(1)
      : await db
          .select()
          .from(dbSchema.communityRoles)
          .where(
            and(
              eq(dbSchema.communityRoles.userId, userId),
              eq(dbSchema.communityRoles.role, role),
              isNull(dbSchema.communityRoles.boardType),
            ),
          )
          .limit(1);

    if (existing.length > 0) {
      return enrichRoleAssignment(existing[0]);
    }

    const [inserted] = await db
      .insert(dbSchema.communityRoles)
      .values({
        userId,
        role,
        boardType: boardType || null,
        grantedBy: ctx.userId!,
      })
      .returning();

    return enrichRoleAssignment(inserted);
  },

  revokeRole: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 10, 'revokeRole');

    const validated = validateInput(RevokeRoleInputSchema, input, 'input');
    const { userId, role, boardType } = validated;

    // Prevent removing the last admin
    if (role === 'admin') {
      const adminConditions = boardType
        ? and(eq(dbSchema.communityRoles.role, 'admin'), eq(dbSchema.communityRoles.boardType, boardType))
        : and(eq(dbSchema.communityRoles.role, 'admin'), isNull(dbSchema.communityRoles.boardType));

      const [adminCount] = await db.select({ count: count() }).from(dbSchema.communityRoles).where(adminConditions);

      if (Number(adminCount?.count || 0) <= 1) {
        throw new Error('Cannot remove the last admin');
      }
    }

    const conditions = boardType
      ? and(
          eq(dbSchema.communityRoles.userId, userId),
          eq(dbSchema.communityRoles.role, role),
          eq(dbSchema.communityRoles.boardType, boardType),
        )
      : and(
          eq(dbSchema.communityRoles.userId, userId),
          eq(dbSchema.communityRoles.role, role),
          isNull(dbSchema.communityRoles.boardType),
        );

    await db.delete(dbSchema.communityRoles).where(conditions);
    return true;
  },
};
