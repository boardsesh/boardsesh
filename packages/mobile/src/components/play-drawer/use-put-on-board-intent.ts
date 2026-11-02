import { useEffect } from 'react';

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
