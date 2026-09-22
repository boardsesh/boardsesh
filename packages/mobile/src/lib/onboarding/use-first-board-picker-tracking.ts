import { useCallback, useEffect, useRef } from 'react';
import { getStoredActiveBoard } from '../active-board-store';
import type { FirstBoardEntry } from '../boards/first-board-mode';
import {
  consumeFirstBoardCloseTapped,
  trackFirstBoardPathChosen,
  trackFirstBoardPickerSkipped,
  type FirstBoardPath,
} from './first-board-picker-analytics';

/**
 * The first-board picker's own analytics (#5654): every choice tapped, and a
 * skip when the picker goes away with no board bound. Returns the callback the
 * choices report through. `entry` is how the climber got here; `null` is the
 * ordinary picker, which reports nothing.
 *
 * Lives on the picker SCREEN rather than on the choice block, because the
 * screen swaps whole branches (the loading spinner, the offline list, the error
 * state) and the block would unmount with each swap. The screen unmounts once,
 * when the modal closes.
 *
 * "No board bound" is read from storage at that moment, not from the render:
 * every bind path writes the board before it navigates (`useActivateBoard`
 * awaits the write), so a pick from the list, the builder, the gym map or the
 * Bluetooth scan all read as bound, and only a real skip reports. A read that
 * fails says nothing rather than guess.
 */
export function useFirstBoardPickerTracking(entry: FirstBoardEntry | null): (path: FirstBoardPath) => void {
  const lastPathRef = useRef<FirstBoardPath | null>(null);

  useEffect(() => {
    if (!entry) return;
    const openedAtMs = Date.now();
    // Drop a note a previous picker's X left behind, if its unmount never ran.
    consumeFirstBoardCloseTapped();
    return () => {
      const method = consumeFirstBoardCloseTapped() ? 'close_button' : 'dismissed';
      const secondsOpen = Math.round((Date.now() - openedAtMs) / 1000);
      const lastPath = lastPathRef.current;
      void getStoredActiveBoard()
        .then((board) => {
          if (board) return;
          trackFirstBoardPickerSkipped({ method, secondsOpen, lastPath, entry });
        })
        .catch(() => undefined);
    };
  }, [entry]);

  return useCallback(
    (path: FirstBoardPath) => {
      lastPathRef.current = path;
      // The choices only render while an entry is set; the guard keeps a stray
      // call from the ordinary picker from reporting a showing that never was.
      if (entry) trackFirstBoardPathChosen(path, entry);
    },
    [entry],
  );
}
