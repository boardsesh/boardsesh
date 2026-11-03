import { useQuery } from '@tanstack/react-query';
import { GET_BOARD_LINK_MODE, type GetBoardLinkModeQueryResponse } from '@boardsesh/graphql/operations/boards';
import { getHttpClient } from './client';

export type BoardLinkModeFields = {
  moonboardLinkMode: 'relay' | 'multi' | null;
  moonboardLinkDetected: 'relay' | 'multi' | null;
};

const NO_LINK_MODE: BoardLinkModeFields = { moonboardLinkMode: null, moonboardLinkDetected: null };

/**
 * A MoonBoard's link mode (#7220), on its own query so the recorded board
 * documents (screenshot fixtures) stay as they are. Screenshot mode never asks:
 * replay would miss. `settled` is true once the answer is in, or once the
 * request failed (an old backend), which reads as "no choice stored".
 */
export function useBoardLinkMode(
  boardUuid: string | null | undefined,
  enabled: boolean,
): { linkMode: BoardLinkModeFields; settled: boolean } {
  const active = enabled && !!boardUuid && process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1';
  const query = useQuery({
    queryKey: ['boardLinkMode', boardUuid] as const,
    queryFn: async (): Promise<BoardLinkModeFields> => {
      const response = await getHttpClient().request<GetBoardLinkModeQueryResponse>(GET_BOARD_LINK_MODE, {
        boardUuid,
      });
      return {
        moonboardLinkMode: response.board?.moonboardLinkMode ?? null,
        moonboardLinkDetected: response.board?.moonboardLinkDetected ?? null,
      };
    },
    enabled: active,
    retry: false,
    // A person's choice changes rarely; the edit screen invalidates on save.
    staleTime: 5 * 60_000,
  });
  return { linkMode: query.data ?? NO_LINK_MODE, settled: !active || query.isSuccess || query.isError };
}
