'use client';

import { useQuery } from '@tanstack/react-query';
import { GET_CLIMB } from '@boardsesh/graphql/operations/climb-search';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import type { Climb, ParsedBoardRouteParameters } from '@/app/lib/types';

type GetClimbVariables = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  climbUuid: string;
};

type GetClimbResponse = {
  climb: Climb | null;
};

/** Single-climb-by-uuid fetch for the climb view screen. Mirrors mobile's
 * `useClimb` (packages/mobile/src/lib/graphql/hooks/index.ts) — same
 * shared `GET_CLIMB` query, web's own GraphQL HTTP client. */
export function useSpaClimb(parsedParams: ParsedBoardRouteParameters, climbUuid: string) {
  const { token } = useWsAuthToken();

  return useQuery({
    queryKey: [
      'spaClimb',
      parsedParams.board_name,
      parsedParams.layout_id,
      parsedParams.size_id,
      parsedParams.set_ids.join(','),
      parsedParams.angle,
      climbUuid,
    ],
    queryFn: async () => {
      const variables: GetClimbVariables = {
        boardName: parsedParams.board_name,
        layoutId: parsedParams.layout_id,
        sizeId: parsedParams.size_id,
        setIds: parsedParams.set_ids.join(','),
        angle: parsedParams.angle,
        climbUuid,
      };
      const client = createGraphQLHttpClient(token);
      const result = await client.request<GetClimbResponse>(GET_CLIMB, variables);
      return result.climb;
    },
    staleTime: 5 * 60 * 1000,
  });
}
