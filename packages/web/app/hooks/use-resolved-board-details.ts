'use client';

import { useParams, usePathname, useSearchParams } from 'next/navigation';
import { parseBoardRouteParams, isNumericId } from '@/app/lib/url-utils';
import type { BoardRouteParametersWithUuid, BoardRouteIdentity } from '@/app/lib/types';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';

/**
 * Resolves board details for URL construction in queue navigation buttons.
 *
 * Prefers passed `boardDetails`; falls back to static data lookup when
 * route params are numeric IDs (not slugs). Returns the raw route identity
 * when neither source is available.
 */
export function useResolvedBoardDetails(boardDetails?: BoardRouteIdentity) {
  const rawParams = useParams<BoardRouteParametersWithUuid>();
  const { board_name, layout_id, size_id, set_ids, angle } = parseBoardRouteParams(rawParams);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  let resolvedDetails: BoardRouteIdentity;
  if (boardDetails) {
    resolvedDetails = boardDetails;
  } else if (isNumericId(rawParams.layout_id)) {
    try {
      resolvedDetails = getBoardImageDetailsForBoard({ board_name, layout_id, size_id, set_ids });
    } catch (error) {
      console.warn('[useResolvedBoardDetails] Failed to resolve board details from static data:', error);
      resolvedDetails = { board_name, layout_id, size_id, set_ids };
    }
  } else {
    resolvedDetails = { board_name, layout_id, size_id, set_ids };
  }

  return {
    rawParams,
    board_name,
    layout_id,
    size_id,
    set_ids,
    angle,
    pathname,
    searchParams,
    resolvedDetails,
  };
}
