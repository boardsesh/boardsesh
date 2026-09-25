import { useCallback, useEffect, useRef } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { normalizeSetIdsForCompare, type UserBoard } from '@boardsesh/shared-schema';
import { track } from '../analytics';
import type { BoardReturnTo } from './board-return-to';
import type { BoundBoard } from './use-activate-board';

/**
 * Which screen is measuring.
 *
 * - `'picker'`: `/boards`. Reports its own opening.
 * - `'gym_finder_from_picker'`: `/gyms` pushed from the picker's "Find gym". The
 *   picker already counted the opening, and a second one would double every
 *   picker session that went through the map, so this reports picks only, under
 *   the picker's `source`.
 * - `'gym_finder'`: `/gyms` opened on its own, from Home or My gyms. Nothing
 *   counted that opening, so it reports its own, and both events say
 *   `source: 'gym_finder'`. Filed under the picker's source, its picks would
 *   push the picker's opened-to-picked rate past 100%.
 */
export type PickerSurface = 'picker' | 'gym_finder_from_picker' | 'gym_finder';

type PickerAnalyticsOptions = {
  activeBoard: UserBoard | null | undefined;
  restoreFailed: boolean;
  returnTo: BoardReturnTo;
  fromOnboarding: boolean;
  /** Defaults to `'picker'`. */
  surface?: PickerSurface;
  /** Opened from Climbs' "Pick your board" empty state (`source=no_board`). */
  fromNoBoard?: boolean;
};

/** Measures the picker itself, including same-board reselection. A read failure
 * is unknown state, never evidence that the person had no saved board. */
export function useBoardPickerAnalytics({
  activeBoard,
  restoreFailed,
  returnTo,
  fromOnboarding,
  surface = 'picker',
  fromNoBoard = false,
}: PickerAnalyticsOptions) {
  const opened = useRef(false);
  const trackOpened = surface !== 'gym_finder_from_picker';
  const source =
    surface === 'gym_finder'
      ? 'gym_finder'
      : fromOnboarding
        ? 'onboarding'
        : fromNoBoard
          ? 'no_board'
          : returnTo === '/(tabs)/record'
            ? 'session'
            : 'board_picker';
  const analyticsReturnTo = returnTo.startsWith('/(tabs)/climbs/setter/')
    ? '/(tabs)/climbs/setter/[username]'
    : returnTo;

  useEffect(() => {
    if (!trackOpened || opened.current || (activeBoard === undefined && !restoreFailed)) return;
    opened.current = true;
    track(SHARED_EVENTS.BoardPickerOpened, {
      source,
      returnTo: analyticsReturnTo,
      hadActiveBoard: activeBoard === undefined ? null : activeBoard !== null,
      restoreFailed,
    });
  }, [activeBoard, restoreFailed, analyticsReturnTo, source, trackOpened]);

  // Supplied as useActivateBoard.onBound: called only after persistence succeeds,
  // with the previous board captured before the write updates the query cache.
  return useCallback(
    async (board: UserBoard, { pickSource, followed }: BoundBoard): Promise<void> => {
      track(SHARED_EVENTS.BoardPickerSelectionCompleted, {
        source,
        returnTo: analyticsReturnTo,
        // Which list the board was tapped in; null when the caller didn't say.
        pickSource: pickSource ?? null,
        // Whether this pick added the board to Your boards (#5654).
        followed,
        hadActiveBoard: activeBoard === undefined ? null : activeBoard !== null,
        sameBoard: activeBoard === undefined ? null : activeBoard?.uuid === board.uuid,
        sameConfig:
          activeBoard === undefined
            ? null
            : activeBoard != null &&
              activeBoard.boardType === board.boardType &&
              activeBoard.layoutId === board.layoutId &&
              activeBoard.sizeId === board.sizeId &&
              normalizeSetIdsForCompare(activeBoard.setIds) === normalizeSetIdsForCompare(board.setIds),
      });
    },
    [activeBoard, analyticsReturnTo, source],
  );
}
