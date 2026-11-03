import { useCallback, useEffect, useRef } from 'react';
import type { WallControlSurface } from '../../lib/analytics-wall-control';
import type { WallControlAction } from './wall-control';

/**
 * Whether the bar's Put on board request presses the wall control's tap
 * (`mini_bar`, the button's `tapAction`), given what that tap would do now.
 * Never a `noop` (a climb this wall can't light, with no board at this gym to
 * walk to: nothing to press, and no bar tap to count), and never a stop: the
 * request asked to put the pick up, and a control that reads You are driving
 * the wall has the climb on screen lit already, so a stop would end the drive
 * the climber never asked to end.
 */
export function putOnBoardIntentPresses(action: WallControlAction): boolean {
  return action !== 'noop' && action !== 'stop_driving' && action !== 'stop_window';
}

/**
 * The press behind the bar's Put on board request (`usePutOnBoardIntent`'s
 * `press`): the wall control's own handler as the bar's control (`mini_bar`,
 * the button's `tapAction`), skipped where that tap would do nothing or stop a
 * drive (`putOnBoardIntentPresses`). It reads `tapAction` as it is at the
 * press, and keeps its identity across renders so the request's effect doesn't
 * re-run for it.
 */
export function usePutOnBoardIntentPress(
  tapAction: WallControlAction,
  press: (control: WallControlSurface) => void,
): () => void {
  const tapActionRef = useRef(tapAction);
  tapActionRef.current = tapAction;
  return useCallback(() => {
    if (!putOnBoardIntentPresses(tapActionRef.current)) return;
    press('mini_bar');
  }, [press]);
}

export type PutOnBoardIntentInputs = {
  /** The preview item the MiniPlayer's bulb asked to put up (`putOnBoard`), or null. */
  intendedFor: string | null;
  /** Drop the request: it ran, or it no longer applies. */
  clear: () => void;
  /** The preview the player shows now. */
  previewItemUuid: string | null;
  /**
   * Whether the press can run yet. In a crew it waits for the browse latch,
   * so the busy-wall question compares against the wall as it was when the
   * climber started looking; a drive never asks, so it doesn't wait.
   */
  ready: boolean;
  /** The wall control's own press, for the bar's control (`mini_bar`). */
  press: () => void;
};

/**
 * The MiniPlayer's bulb on an unlit last pick (owner decision A): the player
 * opened on the pick, and once that preview has landed this presses Put on
 * board for it through the wall button's own handler (`useWallControl`), so
 * the busy-wall question in a crew, the connect, the #4979 hold and the timed
 * drive per Stop driving after all apply exactly as for a tap on the button.
 * Once only. A preview that is no longer the one asked about drops it.
 */
export function usePutOnBoardIntent({ intendedFor, clear, previewItemUuid, ready, press }: PutOnBoardIntentInputs) {
  useEffect(() => {
    if (intendedFor === null) return;
    if (previewItemUuid !== intendedFor) {
      clear();
      return;
    }
    if (!ready) return;
    clear();
    press();
  }, [intendedFor, previewItemUuid, ready, press, clear]);
}
