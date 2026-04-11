'use client';

import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { findMatchingBoard, type BoardConfig } from '@/app/lib/find-matching-board';
import type { BoardDetails } from '@/app/lib/types';
import type { UserBoard } from '@boardsesh/shared-schema';

type Params = {
  /** Board resolved from SSR data – applied immediately without waiting for effects. */
  initialBoard: UserBoard | null;
  myBoards: UserBoard[];
  boardsLoading: boolean;
  boardSlug: string | undefined;
  boardConfig: BoardConfig | undefined;
  /** Board currently active in the user's queue/session. */
  currentBoardDetails: BoardDetails | null;
  /**
   * True once the persistent queue session has finished restoring from
   * IndexedDB (or immediately when a board-route injector is active).
   * Without this guard a fresh direct-load would race the async restore and
   * commit the filter to "All Boards" before the real queue board is known.
   */
  isQueueHydrated: boolean;
};

/**
 * Manages the selected-board filter for the playlist detail page.
 *
 * Priority (highest → lowest):
 * 1. SSR-provided `initialBoard` – set immediately, no effect needed.
 * 2. Route `boardSlug` / `boardConfig` – applied once `myBoards` loads.
 * 3. Active queue board – applied once both `myBoards` AND the persistent
 *    session (`isQueueHydrated`) are ready.
 *
 * The selection is committed exactly once via a ref; subsequent board list
 * refreshes (e.g. SWR re-fetches) will not override a user's manual choice.
 */
export function useDefaultBoardSelection({
  initialBoard,
  myBoards,
  boardsLoading,
  boardSlug,
  boardConfig,
  currentBoardDetails,
  isQueueHydrated,
}: Params): [UserBoard | null, Dispatch<SetStateAction<UserBoard | null>>] {
  const [selectedBoard, setSelectedBoard] = useState<UserBoard | null>(initialBoard);
  const defaultBoardAppliedRef = useRef(!!initialBoard);

  useEffect(() => {
    if (defaultBoardAppliedRef.current || boardsLoading || myBoards.length === 0) return;

    if (boardSlug || boardConfig) {
      const match = findMatchingBoard(myBoards, boardSlug, boardConfig);
      if (match) setSelectedBoard(match);
      defaultBoardAppliedRef.current = true;
      return;
    }

    // Wait until the persistent session has finished restoring from IndexedDB.
    // On a fresh direct load both `currentBoardDetails` and `hasActiveQueue` start
    // as null/false, so without this guard we'd commit to "All Boards" before the
    // real queue board is available and then never re-apply because of the ref.
    if (!isQueueHydrated) return;

    const match = currentBoardDetails
      ? findMatchingBoard(myBoards, undefined, {
          boardType: currentBoardDetails.board_name,
          layoutId: currentBoardDetails.layout_id,
          sizeId: currentBoardDetails.size_id,
        })
      : null;
    if (match) setSelectedBoard(match);
    defaultBoardAppliedRef.current = true;
  }, [myBoards, boardsLoading, boardSlug, boardConfig, currentBoardDetails, isQueueHydrated]);

  return [selectedBoard, setSelectedBoard];
}
