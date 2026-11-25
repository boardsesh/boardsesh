import { useCallback, useEffect, useRef } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { normalizeSetIdsForCompare, type UserBoard } from '@boardsesh/shared-schema';
import { track } from '../analytics';
import type { LocationPermission, LocationStatus } from '../use-device-location';
import { boardReturnToRoute, type BoardReturnTo } from './board-return-to';
import type { FirstBoardGymState } from './first-board-gym-state';
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

/**
 * How many boards the Near you search returned, as the picker's events report
 * it: a count once the search has answered (0 for "Nothing within 20 km"), and
 * null when it has not searched, is still searching, or failed.
 *
 * `outcome` is the search read as the "At a gym" choice reads it, with the
 * choice counted as made once location was asked for at all, so it holds the
 * same answer in every layout. `resultCount` is what the search returned, after
 * a board-type filter and before boards already shown above are left out.
 */
export function pickerNearbyResultCount({
  outcome,
  resultCount,
}: {
  outcome: FirstBoardGymState;
  resultCount: number;
}): number | null {
  if (outcome === 'found') return resultCount;
  if (outcome === 'none_nearby') return 0;
  return null;
}

type PickerAnalyticsOptions = {
  activeBoard: UserBoard | null | undefined;
  restoreFailed: boolean;
  returnTo: BoardReturnTo;
  fromOnboarding: boolean;
  /** Defaults to `'picker'`. */
  surface?: PickerSurface;
  /** Opened from Climbs' "Pick your board" empty state (`source=no_board`). */
  fromNoBoard?: boolean;
  /**
   * Location as the picker knows it, reported on the opening as it stands
   * then. Absent where there is no Near you (the gym finder).
   */
  locationStatus?: LocationStatus;
  /** The permission read behind `locationStatus`, reported with it. */
  locationPermission?: LocationPermission;
  /**
   * Hold the opening while the picker's "already allowed?" read is out. It
   * used to fire first, so `locationStatus` always said `idle` (an allowed
   * climber's search had not started yet). The read takes milliseconds.
   */
  locationPending?: boolean;
  /**
   * Near you's answer (`pickerNearbyResultCount`), reported on each pick as it
   * stands then. Absent where there is no Near you (the gym finder).
   */
  nearbyResultCount?: number | null;
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
  locationStatus,
  locationPermission,
  locationPending = false,
  nearbyResultCount,
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
  const analyticsReturnTo = boardReturnToRoute(returnTo);

  useEffect(() => {
    if (!trackOpened || opened.current || locationPending || (activeBoard === undefined && !restoreFailed)) return;
    opened.current = true;
    track(SHARED_EVENTS.BoardPickerOpened, {
      source,
      returnTo: analyticsReturnTo,
      hadActiveBoard: activeBoard === undefined ? null : activeBoard !== null,
      restoreFailed,
      // As known at the opening, once the "already allowed?" read is back.
      locationStatus,
      locationPermission,
    });
  }, [
    activeBoard,
    restoreFailed,
    analyticsReturnTo,
    source,
    trackOpened,
    locationStatus,
    locationPermission,
    locationPending,
  ]);

  // Read at the pick, through a ref, so the bind callback (and every memo that
  // closes over it) keeps one identity while the search answers.
  const latestNearbyResultCount = useRef(nearbyResultCount);
  useEffect(() => {
    latestNearbyResultCount.current = nearbyResultCount;
  });

  // Supplied as useActivateBoard.onBound: called only after persistence succeeds,
  // with the previous board captured before the write updates the query cache.
  return useCallback(
    async (board: UserBoard, { pickSource, followed, section, position }: BoundBoard): Promise<void> => {
      track(SHARED_EVENTS.BoardPickerSelectionCompleted, {
        source,
        returnTo: analyticsReturnTo,
        // Which list the board was tapped in; null when the caller didn't say.
        pickSource: pickSource ?? null,
        // The section it was drawn in and its 0-based place there; null when the caller didn't say.
        section: section ?? null,
        position: position ?? null,
        // What Near you had found by the pick; absent where there is no Near you.
        nearbyResultCount: latestNearbyResultCount.current,
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
