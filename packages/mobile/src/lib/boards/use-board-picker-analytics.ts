import { useCallback, useEffect, useRef } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { normalizeSetIdsForCompare, type UserBoard } from '@boardsesh/shared-schema';
import { track } from '../analytics';
import type { BoardReturnTo } from './board-return-to';

type PickerAnalyticsOptions = {
  activeBoard: UserBoard | null | undefined;
  restoreFailed: boolean;
  returnTo: BoardReturnTo;
  fromOnboarding: boolean;
};

/** Measures the picker itself, including same-board reselection. A read failure
 * is unknown state, never evidence that the person had no saved board. */
export function useBoardPickerAnalytics({
  activeBoard,
  restoreFailed,
  returnTo,
  fromOnboarding,
}: PickerAnalyticsOptions) {
  const opened = useRef(false);
  const source = fromOnboarding ? 'onboarding' : returnTo === '/(tabs)/record' ? 'session' : 'board_picker';
  const analyticsReturnTo = returnTo.startsWith('/(tabs)/climbs/setter/')
    ? '/(tabs)/climbs/setter/[username]'
    : returnTo;

  useEffect(() => {
    if (opened.current || (activeBoard === undefined && !restoreFailed)) return;
    opened.current = true;
    track(SHARED_EVENTS.BoardPickerOpened, {
      source,
      returnTo: analyticsReturnTo,
      hadActiveBoard: activeBoard === undefined ? null : activeBoard !== null,
      restoreFailed,
    });
  }, [activeBoard, restoreFailed, analyticsReturnTo, source]);

  // Supplied as useActivateBoard.onBound: called only after persistence succeeds,
  // with the previous board captured before the write updates the query cache.
  return useCallback(
    async (board: UserBoard): Promise<void> => {
      track(SHARED_EVENTS.BoardPickerSelectionCompleted, {
        source,
        returnTo: analyticsReturnTo,
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
