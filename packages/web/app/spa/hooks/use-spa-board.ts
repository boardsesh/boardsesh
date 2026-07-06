'use client';

import { useQuery } from '@tanstack/react-query';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import type { BoardDetails, ParsedBoardRouteParameters } from '@/app/lib/types';

export type SpaBoard = {
  parsedParams: ParsedBoardRouteParameters;
  boardDetails: BoardDetails;
};

async function fetchSpaBoard(boardSlug: string, angle: number): Promise<SpaBoard | null> {
  const board = await resolveBoardBySlug(boardSlug);
  if (!board) return null;
  const parsedParams = boardToRouteParams(board, angle);
  return { parsedParams, boardDetails: getBoardDetailsForBoard(parsedParams) };
}

/** Resolves a `/spa/b/{boardSlug}/{angle}` route into board config. Static
 * hold/layout data is computed client-side (no server round trip); only the
 * slug -> board identity lookup hits the network. */
export function useSpaBoard(boardSlug: string, angle: number) {
  return useQuery({
    queryKey: ['spaBoard', boardSlug, angle],
    queryFn: () => fetchSpaBoard(boardSlug, angle),
    staleTime: 5 * 60 * 1000,
  });
}
