import 'server-only';
import { getServerSession } from 'next-auth/next';
import { eq, and } from 'drizzle-orm';
import { authOptions } from '@/app/lib/auth/auth-options';
import { getDb } from '@/app/lib/db/db';
import { communityRoles } from '@/app/lib/db/schema';
import { rolesGrantAdmin } from '@boardsesh/community-roles';
import { rolesGrantGlobalAdmin, rolesGrantScopedAdmin } from './admin-scope';

export type AdminCheck =
  | { authenticated: false }
  | { authenticated: true; userId: string; isAdmin: boolean; boardScopedOnly: boolean; hasGlobalAdmin: boolean };

export type CheckAdminOptions = {
  /**
   * Also accept an admin scoped to this board type (`spray` for the spray wall
   * training queue). Omitted, only a global admin passes, as /admin always did.
   */
  boardType?: string;
};

export async function checkAdmin(options: CheckAdminOptions = {}): Promise<AdminCheck> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return { authenticated: false };

  // Every admin row, not just the first: a board-scoped row and a global row
  // are both `role = 'admin'`, and only the scope tells them apart.
  const adminRoles = await getDb()
    .select({ role: communityRoles.role, boardType: communityRoles.boardType })
    .from(communityRoles)
    .where(and(eq(communityRoles.userId, userId), eq(communityRoles.role, 'admin')));

  const { boardType } = options;
  const isAdmin = boardType ? rolesGrantAdmin(adminRoles, boardType) : rolesGrantGlobalAdmin(adminRoles);

  return {
    authenticated: true,
    userId,
    isAdmin,
    hasGlobalAdmin: rolesGrantGlobalAdmin(adminRoles),
    boardScopedOnly: !isAdmin && rolesGrantScopedAdmin(adminRoles),
  };
}
