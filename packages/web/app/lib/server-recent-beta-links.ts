import 'server-only';
import { GET_RECENT_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import type { BetaLinksGqlRow } from '@/app/lib/beta-video-url';
export type RecentBetaLinkRow = {
  climbName: string | null;
  boardType: string;
  layoutId: number | null;
  betaLink: BetaLinksGqlRow;
};

// Reauthorize on every request. The backend still caches candidate rows.
export async function getRecentBetaLinks(limit = 20): Promise<RecentBetaLinkRow[]> {
  try {
    const result = await executeAuthenticatedGraphQL<{ recentBetaLinks: RecentBetaLinkRow[] }>(
      GET_RECENT_BETA_LINKS,
      { limit },
      await getServerAuthToken(),
      // Stricter than the 5 s authenticated default on purpose: the homepage
      // must render within its page-load budget (#4461, #6254).
      AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
    );
    return result.recentBetaLinks;
  } catch {
    return [];
  }
}
