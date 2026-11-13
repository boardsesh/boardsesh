import {
  getBoardImageDetailsForBoard,
  getBoardImageDetailsForPlaylist,
  toBoardImageDetails,
  type BoardImageDetails,
} from '@/app/lib/board-image-details';
import { useMemo } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { Climb, BoardName } from '@/app/lib/types';
import { resolveBoardDetailsForClimb, type SessionBoardConfig } from '@/app/lib/board-config-for-playlist';

function getUserBoardImageDetails(board: UserBoard): BoardImageDetails | null {
  try {
    return getBoardImageDetailsForBoard({
      board_name: board.boardType,
      layout_id: board.layoutId,
      size_id: board.sizeId,
      set_ids: board.setIds.split(',').map(Number),
    });
  } catch {
    return null;
  }
}

type UseBoardDetailsMapResult = {
  /** BoardDetails keyed by climb uuid — resolved per climb. */
  boardDetailsByClimb: Record<string, BoardImageDetails>;
  /** Fallback BoardDetails for the list as a whole (hydration fallback). */
  defaultBoardDetails: BoardImageDetails | null;
  /** Climbs that the user doesn't own a matching board type/layout for. */
  unsupportedClimbs: Set<string>;
  /** Climbs that fit only on a larger size than the user's current session board. */
  upsizedClimbs: Set<string>;
};

/**
 * Builds per-climb BoardDetails for multi-board climb rendering. When the
 * caller passes a `sessionBoard`, each climb is resolved against it:
 *  - Climbs that fit exactly render at the session's size/sets.
 *  - Climbs that don't fit render on the smallest larger size that does
 *    (same layout), and are marked as upsized so the UI can grey them out.
 *  - Climbs from a different board/layout fall back to the generic preview
 *    and are marked as unsupported (existing behavior).
 *
 * Used by: SetterClimbList, PlaylistDetailContent, SessionDetailContent
 */
export function useBoardDetailsMap(
  climbs: Climb[],
  myBoards: UserBoard[],
  selectedBoard?: UserBoard | null,
  sessionBoard?: SessionBoardConfig | null,
  fallbackBoardTypes?: string[],
): UseBoardDetailsMapResult {
  return useMemo(() => {
    const byClimb: Record<string, BoardImageDetails> = {};
    const unsupported = new Set<string>();
    const upsized = new Set<string>();

    // Use the active session when provided; otherwise synthesize one from the
    // selected board so the playlist board filter still drives the preview.
    let effectiveSession: SessionBoardConfig | null;
    if (sessionBoard) {
      effectiveSession = sessionBoard;
    } else if (selectedBoard) {
      effectiveSession = {
        boardType: selectedBoard.boardType as BoardName,
        layoutId: selectedBoard.layoutId,
        sizeId: selectedBoard.sizeId,
        setIds: selectedBoard.setIds
          .split(',')
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0),
      };
    } else {
      effectiveSession = null;
    }

    // Only filter by ownership when the user actually owns at least one board.
    // When myBoards is empty we render every climb normally and let selection
    // auto-activate the climb's own board config downstream.
    const userBoardTypes = myBoards.length > 0 ? new Set(myBoards.map((b) => b.boardType)) : null;

    for (const climb of climbs) {
      // Mark climbs whose board type the user simply doesn't own at all.
      if (userBoardTypes && climb.boardType && !userBoardTypes.has(climb.boardType)) {
        unsupported.add(climb.uuid);
      }

      // Without a selected board there is no containment question: draw the catalog default directly.
      if (!effectiveSession) {
        const details = getBoardImageDetailsForPlaylist(climb.boardType ?? '', climb.layoutId ?? null);
        if (details) byClimb[climb.uuid] = details;
        continue;
      }

      const resolved = resolveBoardDetailsForClimb(climb, effectiveSession);
      if (!resolved) continue;
      byClimb[climb.uuid] = toBoardImageDetails(resolved.details);
      if (resolved.status === 'upsized') {
        upsized.add(climb.uuid);
      } else if (resolved.status === 'incompatible' && userBoardTypes) {
        unsupported.add(climb.uuid);
      }
    }

    // Determine default board details (used as a hydration fallback by ClimbsList).
    let defaultDetails: BoardImageDetails | null = null;
    if (selectedBoard) {
      defaultDetails = getUserBoardImageDetails(selectedBoard);
    }
    if (!defaultDetails && myBoards.length > 0) {
      defaultDetails = getUserBoardImageDetails(myBoards[0]);
    }
    if (!defaultDetails) {
      const fallbackBoardType = fallbackBoardTypes?.[0] || climbs[0]?.boardType || 'kilter';
      const fallbackLayoutId = climbs[0]?.layoutId ?? null;
      defaultDetails = getBoardImageDetailsForPlaylist(fallbackBoardType, fallbackLayoutId);
    }

    return {
      boardDetailsByClimb: byClimb,
      defaultBoardDetails: defaultDetails,
      unsupportedClimbs: unsupported,
      upsizedClimbs: upsized,
    };
  }, [climbs, myBoards, selectedBoard, sessionBoard, fallbackBoardTypes]);
}
