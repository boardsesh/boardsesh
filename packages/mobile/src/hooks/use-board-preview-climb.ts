import { useMemo } from 'react';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardName, ClimbSearchInput } from '@boardsesh/shared-schema';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { useInfiniteSearchClimbs } from '../lib/graphql/hooks/use-infinite-search-climbs';
import { getBoardRenderData } from '../lib/board-details';

/**
 * A real climb on the climber's own board, for any surface that needs to SHOW
 * what a render setting does rather than describe it.
 *
 * Shared by the Board look accessibility preview, the board-look preset
 * carousel and the onboarding board-look step, so all three hit one React Query
 * entry and one `getBoardRenderData` memo instead of three.
 */

export type BoardPreviewStatus = 'loading' | 'ready' | 'unavailable';

export type BoardPreviewSource = {
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
};

export type BoardPreviewClimb = {
  /**
   * `loading` — the active board or its climb is still resolving, so ask again.
   * `unavailable` — there is nothing to draw and there never will be on this
   * launch (no board bound, no synced climb, no geometry for the config).
   * A caller deciding whether to interrupt someone must treat those two
   * differently: `loading` is "wait", `unavailable` is "don't".
   */
  status: BoardPreviewStatus;
  preview: BoardPreviewSource | null;
};

/**
 * The active board's most-climbed boulder for this exact layout/size/set/angle
 * — so hold ids line up and all four roles light — plus the geometry a board
 * image needs to lay the overlay over the photo.
 *
 * `enabled` is the cost gate. A launch-time caller passes `false` until its own
 * cheap checks have said the surface will actually be shown, so a climber who
 * will never see it pays for no query.
 *
 * `offlineAwareRequest` under `useInfiniteSearchClimbs` is local-first, so a
 * board that has been synced answers from SQLite with no network. A board that
 * never synced, offline, resolves to `unavailable` rather than to an empty
 * wall: five identical unlit boards teach nothing about five drawings.
 */
export function useBoardPreviewClimb(enabled = true): BoardPreviewClimb {
  const { data: activeBoard } = useActiveBoard();

  const climbSearchInput = useMemo<ClimbSearchInput>(
    () => ({
      boardName: toBoardName(activeBoard?.boardType) ?? 'kilter',
      layoutId: activeBoard?.layoutId ?? 0,
      sizeId: activeBoard?.sizeId ?? 0,
      setIds: activeBoard?.setIds ?? '',
      angle: activeBoard?.angle ?? 40,
      sortBy: 'ascents',
      sortOrder: 'desc',
      pageSize: 1,
    }),
    [activeBoard],
  );

  const { data: exampleClimbData, isPending } = useInfiniteSearchClimbs(climbSearchInput, enabled && !!activeBoard, {
    staleTime: 60 * 60 * 1000,
  });
  const exampleClimbFrames = exampleClimbData?.pages?.[0]?.climbs?.[0]?.frames ?? null;

  return useMemo<BoardPreviewClimb>(() => {
    // `undefined` is the AsyncStorage read still in flight; `null` is a climber
    // who has not bound a board at all, which no amount of waiting fixes.
    if (activeBoard === undefined) return { status: 'loading', preview: null };
    if (!activeBoard) return { status: 'unavailable', preview: null };
    if (!enabled) return { status: 'loading', preview: null };

    const boardName = toBoardName(activeBoard.boardType) ?? 'kilter';
    const renderData = getBoardRenderData({
      boardName,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds.split(',').map(Number).filter(Boolean),
    });
    if (!renderData) return { status: 'unavailable', preview: null };

    if (!exampleClimbFrames) {
      // Still fetching is "wait"; a settled query with no climb is a board whose
      // catalogue this device has never seen.
      return { status: isPending ? 'loading' : 'unavailable', preview: null };
    }

    return {
      status: 'ready',
      preview: {
        frames: exampleClimbFrames,
        boardName,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        boardWidth: renderData.boardWidth,
        boardHeight: renderData.boardHeight,
      },
    };
  }, [activeBoard, enabled, exampleClimbFrames, isPending]);
}
