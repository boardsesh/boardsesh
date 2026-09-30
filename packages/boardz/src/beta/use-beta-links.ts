import { useQuery } from '@tanstack/react-query';
import type { BoardName } from '@boardsesh/shared-schema';
import { GET_BETA_LINKS, type GetBetaLinksQueryResponse } from '@boardsesh/graphql/operations/beta-links';
import { BACKEND_URL } from '../api/env';
import { graphqlRequest } from '../api/graphql-client';
import { betaForClimb } from './beta-links';

// Beta changes slowly; a climb's videos can be reused for a while.
const BETA_STALE_MS = 10 * 60 * 1000;

/** Beta videos for a climb, filmed at `angle` first. Public: no sign-in needed. */
export function useBetaLinks(boardName: BoardName | undefined, climbUuid: string | undefined, angle: number) {
  const query = useQuery({
    queryKey: ['betaLinks', boardName, climbUuid],
    queryFn: async () =>
      (await graphqlRequest<GetBetaLinksQueryResponse>(GET_BETA_LINKS, { boardType: boardName, climbUuid })).betaLinks,
    enabled: boardName !== undefined && climbUuid !== undefined,
    staleTime: BETA_STALE_MS,
  });
  return { ...query, videos: query.data ? betaForClimb(query.data, angle, BACKEND_URL) : [] };
}
