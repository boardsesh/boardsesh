import { useQuery } from '@tanstack/react-query';
import { GET_RECENT_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import type { BetaLink, BetaLinksGqlRow } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { mapBetaLinks, dedupeBetaLinks } from '../beta-video-url';

/** A single `recentBetaLinks` row — the GQL `betaLink` field is the camelCase
 *  `BetaLinksGqlRow` the shared mapper expects. */
type RecentBetaLinkRow = {
  climbName: string | null;
  boardType: string;
  layoutId: number | null;
  betaLink: BetaLinksGqlRow;
};

type RecentBetaLinksResponse = { recentBetaLinks: RecentBetaLinkRow[] };

const HOME_BETA_LIMIT = 20;

/**
 * Recent community beta videos for the active board, filtered to the active
 * layout. Maps the GQL rows to the `BetaLink` shape `BetaVideoCard` renders and
 * dedupes by link. Returns an empty array when the board has no recent beta —
 * Home hides the row in that case.
 */
export function useHomeBetaLinks(boardType: string | undefined, layoutId: number | undefined) {
  return useQuery<BetaLink[]>({
    queryKey: ['homeBetaLinks', boardType, layoutId],
    enabled: boardType !== undefined,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const response = await getHttpClient().request<RecentBetaLinksResponse>(GET_RECENT_BETA_LINKS, {
        limit: HOME_BETA_LIMIT,
        boardType,
      });
      const rows = response.recentBetaLinks ?? [];
      const scoped = layoutId === undefined ? rows : rows.filter((row) => row.layoutId === layoutId);
      return dedupeBetaLinks(mapBetaLinks(scoped.map((row) => row.betaLink)));
    },
  });
}
