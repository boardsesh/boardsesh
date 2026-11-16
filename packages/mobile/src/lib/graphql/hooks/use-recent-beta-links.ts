import { useQuery } from '@tanstack/react-query';
import {
  GET_RECENT_BETA_LINKS,
  type GetRecentBetaLinksQueryResponse,
  type GetRecentBetaLinksQueryVariables,
  type RecentBetaLinkGqlRow,
} from '@boardsesh/graphql/operations/beta-links';
import { betaLinkIdentity, isBetaVideoUrl } from '@boardsesh/shared-schema';
import { mapBetaLink } from '../../beta-video-url';
import { getHttpClient } from '../client';
import { recentBetaLinksQueryKey } from '../query-keys';
import type { RecentBetaVideo } from './index';

/** Video-only, deduped by link identity, capped at `limit`. */
export function selectRecentBetaVideos(rows: RecentBetaLinkGqlRow[], limit: number): RecentBetaVideo[] {
  const seenIdentities = new Set<string>();
  const videos: RecentBetaVideo[] = [];
  for (const row of rows) {
    const betaLink = mapBetaLink(row.betaLink);
    if (!isBetaVideoUrl(betaLink.link)) continue;
    const identity = betaLinkIdentity(betaLink.link);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    videos.push({ ...row, betaLink });
    if (videos.length >= limit) break;
  }
  return videos;
}

/**
 * The newest community beta videos, for Home's Fresh beta shelf (#6289). With a
 * board type and layout the server keeps only beta for that layout (a Kilter
 * Original clip is no use on a Kilter Homewall); with neither it is global.
 * Network only, never persisted (`docs/offline-reads.md`, bucket 3).
 */
export function useRecentBetaLinks(limit: number, boardType: string | null, layoutId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: recentBetaLinksQueryKey(limit, boardType, layoutId),
    queryFn: () =>
      getHttpClient().request<GetRecentBetaLinksQueryResponse, GetRecentBetaLinksQueryVariables>(
        GET_RECENT_BETA_LINKS,
        { limit, boardType, layoutId },
      ),
    select: (data) => selectRecentBetaVideos(data.recentBetaLinks, limit),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
