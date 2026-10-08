import 'server-only';
import { GET_USER_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import type { RecentBetaLinkRow } from '@/app/lib/server-recent-beta-links';

// Reauthorize on every request. The backend still caches candidate rows.
export async function getUserBetaLinks(userId: string, limit = 50): Promise<RecentBetaLinkRow[]> {
  try {
    const result = await executeAuthenticatedGraphQL<{ userBetaLinks: RecentBetaLinkRow[] }>(
      GET_USER_BETA_LINKS,
      { userId, limit },
      await getServerAuthToken(),
    );
    return result.userBetaLinks;
  } catch {
    return [];
  }
}
