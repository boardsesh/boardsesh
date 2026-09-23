// What a newcomer does with the first-board picker (#5654). The picker itself
// also fires `Board Picker Opened` and `Board Picker Selection Completed` like
// any picker; these two add the choice they tapped and the skip, which is the
// guardrail the launch reads against (pick-a-board ships with no control).
// `entry` splits the launch gate's showings from the ones a climber opened from
// Climbs' "Pick your board", so the skip rate reads against the right count.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import type { FirstBoardEntry } from '../boards/first-board-mode';

export type FirstBoardPath = 'gym' | 'own' | 'scan' | 'gym_map' | 'spray_wall';

export type FirstBoardSkipMethod = 'close_button' | 'dismissed';

export function trackFirstBoardPathChosen(path: FirstBoardPath, entry: FirstBoardEntry): void {
  track(SHARED_EVENTS.FirstBoardPathChosen, { path, entry });
}

export function trackFirstBoardPickerSkipped({
  method,
  secondsOpen,
  lastPath,
  entry,
}: {
  method: FirstBoardSkipMethod;
  secondsOpen: number;
  lastPath: FirstBoardPath | null;
  entry: FirstBoardEntry;
}): void {
  track(SHARED_EVENTS.FirstBoardPickerSkipped, { method, secondsOpen, lastPath, entry });
}

// The header X ("Not now", or Close when Climbs opened the picker) lives in the
// boards stack's layout, and the skip is reported by the picker when it
// unmounts. This is how the unmount tells the X from a swipe down or Android
// back: the X notes itself here on the way out.
let closeButtonTapped = false;

/** Called by the header X, in either entry, just before it dismisses. */
export function noteFirstBoardCloseTapped(): void {
  closeButtonTapped = true;
}

/** Read once, by the picker on unmount (and on mount, to drop a stale note). */
export function consumeFirstBoardCloseTapped(): boolean {
  const tapped = closeButtonTapped;
  closeButtonTapped = false;
  return tapped;
}
