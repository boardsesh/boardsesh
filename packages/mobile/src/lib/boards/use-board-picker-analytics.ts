import { useCallback, useEffect, useRef } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { normalizeSetIdsForCompare, type UserBoard } from '@boardsesh/shared-schema';
import { track } from '../analytics';
import type { LocationStatus } from '../use-device-location';
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
 * What Near you came to, for `Board Picker Opened` (`pickerNearbyOpenedState`).
 */
export type PickerNearbyOpenedState = {
  /** Near you has its answer, or will not search by itself. The opening waits for this. */
  settled: boolean;
  /** Boards the search returned; null when it did not search or the search failed. */
  resultCount: number | null;
  locationStatus: LocationStatus;
};

/**
 * Longest the opening waits for Near you before it reports without its answer.
 * The event is backdated to when the picker opened either way, so time to pick
 * still counts from the opening.
 */
export const OPENED_NEARBY_WAIT_MS = 5_000;

/**
 * Near you's answer as `Board Picker Opened` reports it.
 *
 * `outcome` is the search read as the "At a gym" choice reads it, with the
 * choice counted as made once location was asked for at all, so it holds the
 * same answer in every layout. `checkedOnOpen` is false only while the
 * picker's on-open "is location already allowed?" read is out: until it
 * answers, an idle location could be one about to search.
 */
export function pickerNearbyOpenedState({
  checkedOnOpen,
  outcome,
  resultCount,
  locationStatus,
}: {
  checkedOnOpen: boolean;
  outcome: FirstBoardGymState;
  /** Boards the search returned (after a board-type filter, before anything is left out as shown above). */
  resultCount: number;
  locationStatus: LocationStatus;
}): PickerNearbyOpenedState {
  return {
    settled: checkedOnOpen && outcome !== 'searching',
    resultCount: outcome === 'found' ? resultCount : outcome === 'none_nearby' ? 0 : null,
    locationStatus,
  };
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
   * Near you's answer, which the opening reports. Absent where there is no Near
   * you (the gym finder): the opening then reports at once, without it.
   */
  nearby?: PickerNearbyOpenedState;
};

/** Measures the picker itself, including same-board reselection. A read failure
 * is unknown state, never evidence that the person had no saved board.
 *
 * `Board Picker Opened` goes once per presentation. It waits for the saved-board
 * read and then for Near you's answer (at most OPENED_NEARBY_WAIT_MS), and is
 * backdated to when the read settled. A pick or leaving the picker sends it
 * first if it is still waiting, so it always precedes the pick. */
export function useBoardPickerAnalytics({
  activeBoard,
  restoreFailed,
  returnTo,
  fromOnboarding,
  surface = 'picker',
  fromNoBoard = false,
  nearby,
}: PickerAnalyticsOptions) {
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

  // The opening as it stood when the saved-board read settled, and when that was.
  const openedSnapshot = useRef<{
    at: Date;
    hadActiveBoard: boolean | null;
    restoreFailed: boolean;
  } | null>(null);
  const openedSent = useRef(false);
  // Read when the opening goes, which can be a timer or a pick after the render
  // that last saw it.
  const latestNearby = useRef(nearby);
  useEffect(() => {
    latestNearby.current = nearby;
  });

  const sendOpened = useCallback(() => {
    const snapshot = openedSnapshot.current;
    if (openedSent.current || snapshot === null) return;
    openedSent.current = true;
    const nearbyNow = latestNearby.current;
    track(
      SHARED_EVENTS.BoardPickerOpened,
      {
        source,
        returnTo: analyticsReturnTo,
        hadActiveBoard: snapshot.hadActiveBoard,
        restoreFailed: snapshot.restoreFailed,
        // Absent where there is no Near you; null until it has an answer.
        nearbyResultCount: nearbyNow === undefined ? undefined : nearbyNow.settled ? nearbyNow.resultCount : null,
        locationStatus: nearbyNow?.locationStatus,
      },
      { timestamp: snapshot.at },
    );
  }, [source, analyticsReturnTo]);

  const readSettled = activeBoard !== undefined || restoreFailed;
  const nearbySettled = nearby === undefined || nearby.settled;
  useEffect(() => {
    if (!trackOpened || openedSent.current || !readSettled) return undefined;
    if (openedSnapshot.current === null) {
      openedSnapshot.current = {
        at: new Date(),
        hadActiveBoard: activeBoard === undefined ? null : activeBoard !== null,
        restoreFailed,
      };
    }
    if (nearbySettled) {
      sendOpened();
      return undefined;
    }
    const waitedMs = Date.now() - openedSnapshot.current.at.getTime();
    const timer = setTimeout(sendOpened, Math.max(0, OPENED_NEARBY_WAIT_MS - waitedMs));
    return () => clearTimeout(timer);
  }, [trackOpened, readSettled, nearbySettled, activeBoard, restoreFailed, sendOpened]);
  // Leaving the picker before Near you answered still counts the opening.
  useEffect(() => sendOpened, [sendOpened]);

  // Supplied as useActivateBoard.onBound: called only after persistence succeeds,
  // with the previous board captured before the write updates the query cache.
  return useCallback(
    async (board: UserBoard, { pickSource, followed, section, position }: BoundBoard): Promise<void> => {
      // The opening first, if it is still waiting on Near you.
      sendOpened();
      track(SHARED_EVENTS.BoardPickerSelectionCompleted, {
        source,
        returnTo: analyticsReturnTo,
        // Which list the board was tapped in; null when the caller didn't say.
        pickSource: pickSource ?? null,
        // The section it was drawn in and its 0-based place there; null when the caller didn't say.
        section: section ?? null,
        position: position ?? null,
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
    [activeBoard, analyticsReturnTo, source, sendOpened],
  );
}
