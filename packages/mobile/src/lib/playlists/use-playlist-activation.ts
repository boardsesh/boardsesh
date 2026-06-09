// Bridges the shared `usePlaylistClimbActivation` hook to mobile's queue
// provider + drawer host. Both the playlist-detail and smart-playlist-detail
// screens call this with their own source id and per-page climb fetcher; the
// only difference between them is which GraphQL query backs the suggestion
// refresh, so that fetcher is injected.
//
// Activation is two-phase (see the shared hook): it synchronously activates the
// tapped climb with a suggestion source built from the loaded climbs, opens the
// play drawer, then asynchronously fetches the full ordered board climb list and
// swaps in a richer suggestion source so swiping through the play drawer walks
// the whole playlist.

import { useCallback, useMemo, startTransition } from 'react';
import { usePlaylistClimbActivation, fetchPlaylistSuggestionClimbs } from '@boardsesh/playlists-react';
import { getQueueBoardKey, type Climb } from '@boardsesh/queue';
import { useQueueActions } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useActiveBoard } from '../graphql/use-active-board';
import { climbToQueueItem } from '../climb-to-queue-item';
import { toSchemaClimb } from '../climb-types';

/** A single page of the suggestion-refresh fetch. */
export type PlaylistActivationPage = {
  climbs: Climb[];
  hasMore: boolean;
};

export type UsePlaylistActivationOptions = {
  /** Stable suggestion-source id (e.g. `playlist:<uuid>` or `smart:<type>:<userId>`). */
  sourceId: string;
  /** All currently-loaded climbs, used to seed the initial suggestion source. */
  allClimbs: Climb[];
  /**
   * Fetch one page of the ordered board climb list for the suggestion refresh.
   * Receives the activated board (boardName/layoutId/sizeId/setIds/angle so the
   * caller can build the right query input) plus the page cursor.
   */
  fetchPage: (args: {
    page: number;
    pageSize: number;
    board: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number };
    signal: AbortSignal;
  }) => Promise<PlaylistActivationPage>;
  /** Logged when the async suggestion refresh fails (non-abort). */
  refreshErrorMessage: string;
};

/** Returns an `activate(climb)` callback to wire onto a climb row tap. */
export function usePlaylistActivation({
  sourceId,
  allClimbs,
  fetchPage,
  refreshErrorMessage,
}: UsePlaylistActivationOptions): (climb: Climb) => Promise<void> {
  const { setCurrentClimb, refreshPlaylistSuggestionSource } = useQueueActions();
  const { openPlayDrawer } = useDrawerHost();
  const activeBoard = useActiveBoard().data ?? null;

  // The shared hook expects setCurrentClimb to return the activated item (so it
  // knows activation succeeded and can fire onActivated). Mobile's provider
  // method returns void, so wrap it: build the queue item, dispatch, and return
  // the item.
  const queueApi = useMemo(
    () => ({
      setCurrentClimb: async (climb: Climb, options: Parameters<typeof setCurrentClimb>[1]) => {
        const item = climbToQueueItem(toSchemaClimb(climb));
        // Mark as a non-urgent transition so React can flush the drawer's
        // opening animation frame before processing the queue re-renders.
        startTransition(() => {
          setCurrentClimb(item, options);
        });
        return item;
      },
      refreshPlaylistSuggestionSource,
    }),
    [setCurrentClimb, refreshPlaylistSuggestionSource],
  );

  const resolveTarget = useCallback(
    (climb: Climb) => {
      void climb;
      if (!activeBoard) return null;
      return {
        boardKey: getQueueBoardKey({
          board_name: activeBoard.boardType,
          layout_id: activeBoard.layoutId,
          size_id: activeBoard.sizeId,
          set_ids: activeBoard.setIds,
        }),
        boardName: activeBoard.boardType,
        angle: activeBoard.angle,
        // Single active board on mobile — every loaded climb is climbable.
        isClimbable: () => true,
      };
    },
    [activeBoard],
  );

  const fetchClimbsForBoard = useCallback(
    async ({ activatedClimbUuid, signal }: { activatedClimbUuid: string; signal: AbortSignal }) => {
      if (!activeBoard) return [];
      const board = {
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        angle: activeBoard.angle,
      };
      return fetchPlaylistSuggestionClimbs({
        activatedClimbUuid,
        signal,
        fetchPage: ({ page, pageSize, signal: pageSignal }) => fetchPage({ page, pageSize, board, signal: pageSignal }),
      });
    },
    [activeBoard, fetchPage],
  );

  const activate = usePlaylistClimbActivation({
    queueApi,
    sourceId,
    allClimbs,
    resolveTarget,
    fetchClimbsForBoard,
    // onActivated is intentionally omitted — the drawer is opened in the
    // returned callback BEFORE activate() runs, so the BottomSheet animation
    // starts on the same frame as the tap with no state-update work in between.
    refreshErrorMessage,
  });

  // Open the drawer immediately, then let the shared hook do its state work.
  // The drawer receives the climb directly via open() and renders correctly
  // before DELTA_UPDATE_CURRENT_CLIMB propagates (setAsCurrent:false prevents
  // the drawer from re-dispatching and wiping the suggestion source).
  // The queue dispatch inside queueApi.setCurrentClimb is wrapped in
  // startTransition so React processes those re-renders at low priority after
  // the animation frame runs.
  return useCallback(
    (climb: Climb) => {
      openPlayDrawer(toSchemaClimb(climb), { setAsCurrent: false });
      return activate(climb).catch((error: unknown) => {
        console.error('Playlist climb activation failed:', error);
      });
    },
    [activate, openPlayDrawer],
  );
}
