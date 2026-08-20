// Server-side data assembly for one BoardSlot: resolve the board's render
// details, seed the latest climb from boardRecentClimbs (anonymous HTTP,
// uncached — this is "what's lit right now"), and pre-build the raster
// placeholder URLs the slot paints before its live subscription attaches.
// Shared by the kiosk page renderer and the /embed/board/[board_uuid] widget.

import 'server-only';
import { BOARD_RECENT_CLIMBS } from '@boardsesh/graphql/operations';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import type { BoardDetails } from '@/app/lib/types';
import { buildBoardRenderUrl, toFlatFrames } from '../board-renderer/util';

/** The board-config subset a slot needs; satisfied by both `GymKioskBoard` and `UserBoard`. */
export type BoardSlotSource = {
  /** Numeric board-presence channel id (userBoards.id). */
  boardId: number;
  /** For diagnostics only — never rendered. */
  boardUuid: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

export type BoardSlotData = {
  boardDetails: BoardDetails;
  /** Latest climb seen on the wall (boardRecentClimbs[0]) or null. */
  initialClimb: BoardPresenceClimb | null;
  /** Raster URL for the initial climb's frames (null when no initial climb). */
  initialClimbImageUrl: string | null;
  /** Raster URL for the bare board (idle placeholder). */
  bareBoardImageUrl: string;
};

function resolveBoardDetails(board: BoardSlotSource): BoardDetails | null {
  try {
    return getBoardDetailsForBoard({
      board_name: board.boardType,
      layout_id: board.layoutId,
      size_id: board.sizeId,
      set_ids: board.setIds.split(',').map(Number),
    });
  } catch (error) {
    // An unknown layout/size/set combination (e.g. stale board config) drops
    // the slot instead of crashing the surface; callers degrade gracefully.
    console.warn(`[kiosk] Skipping board ${board.boardUuid}: no board details`, error);
    return null;
  }
}

/** Latest climbs for a board (newest first; index 0 = current). Anonymous,
 * uncached — this is the SSR seed for what's lit right now.
 *
 * `cache: 'no-store'` means every kiosk/embed render pays this call for real,
 * so it is the one with the least excuse to be unbounded. It already degrades
 * to `[]` (the slot paints the bare board and the live subscription fills it in
 * a moment later), which is a far better answer than a render that never ends. */
async function fetchInitialClimbs(boardId: number): Promise<BoardPresenceClimb[]> {
  try {
    const response = await fetch(getGraphQLHttpUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: BOARD_RECENT_CLIMBS, variables: { boardId } }),
      signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: { boardRecentClimbs?: BoardPresenceClimb[] | null } };
    return payload.data?.boardRecentClimbs ?? [];
  } catch {
    return [];
  }
}

/**
 * Everything a `BoardSlot` needs beyond its identity props. Returns null when
 * the board's config can't be resolved to render details — the caller drops
 * the slot (kiosk presets degrade; the embed 404s).
 */
export async function buildBoardSlotData(board: BoardSlotSource): Promise<BoardSlotData | null> {
  const boardDetails = resolveBoardDetails(board);
  if (boardDetails === null) return null;

  const recentClimbs = await fetchInitialClimbs(board.boardId);
  const initialClimb = recentClimbs[0] ?? null;
  const flatFrames = toFlatFrames(initialClimb?.frames, boardDetails.board_name);
  return {
    boardDetails,
    initialClimb,
    initialClimbImageUrl:
      initialClimb === null || flatFrames.length === 0
        ? null
        : buildBoardRenderUrl(boardDetails, flatFrames, { includeBackground: true }),
    bareBoardImageUrl: buildBoardRenderUrl(boardDetails, '', { includeBackground: true }),
  };
}
