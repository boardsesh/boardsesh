'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_BOARD_LINK_MODE, type GetBoardLinkModeQueryResponse } from '@boardsesh/graphql/operations';

export type BoardLinkMode = {
  moonboardLinkMode: 'relay' | 'multi' | null;
  moonboardLinkDetected: 'relay' | 'multi' | null;
};

/**
 * A MoonBoard's link mode (#7220), fetched on its own so the shared board
 * documents stay unchanged. `settled` is true once the answer is known, or once
 * the request failed (treated as "no choice stored"), so a form can wait for it
 * without hanging on an old backend.
 */
export function useBoardLinkMode(boardUuid: string, enabled: boolean): { linkMode: BoardLinkMode; settled: boolean } {
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const viewerUserId = session?.user?.id ?? 'anonymous';
  const query = useQuery({
    queryKey: ['boardLinkMode', viewerUserId, boardUuid] as const,
    queryFn: async (): Promise<BoardLinkMode> => {
      if (!token) throw new Error('useBoardLinkMode: queryFn ran without a token');
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetBoardLinkModeQueryResponse, { boardUuid: string }>(GET_BOARD_LINK_MODE, {
        boardUuid,
      });
      return {
        moonboardLinkMode: response.board?.moonboardLinkMode ?? null,
        moonboardLinkDetected: response.board?.moonboardLinkDetected ?? null,
      };
    },
    enabled: enabled && !!token,
    retry: false,
  });
  return {
    linkMode: query.data ?? { moonboardLinkMode: null, moonboardLinkDetected: null },
    settled: !enabled || query.isSuccess || query.isError,
  };
}
