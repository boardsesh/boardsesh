import { useQuery } from '@tanstack/react-query';
import {
  GET_BETA_LINKS,
  type GetBetaLinksQueryResponse,
  type GetBetaLinksQueryVariables,
} from '@boardsesh/graphql/operations/beta-links';
import { dedupeBetaLinks } from '@boardsesh/shared-schema';
import { mapBetaLinks } from '../../beta-video-url';
import { getHttpClient } from '../client';

/** A climb's beta videos. `enabled: false` still hands back a cached answer, without asking for one. */
export function useBetaLinks(boardType: string, climbUuid: string, enabled = true) {
  return useQuery({
    queryKey: ['betaLinks', boardType, climbUuid],
    queryFn: () =>
      getHttpClient().request<GetBetaLinksQueryResponse, GetBetaLinksQueryVariables>(GET_BETA_LINKS, {
        boardType,
        climbUuid,
      }),
    select: (data) => dedupeBetaLinks(mapBetaLinks(data.betaLinks)),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
