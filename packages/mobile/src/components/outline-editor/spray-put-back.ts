// Putting a removed hold back on the wall from a climb (#5493): what the hold
// editor does once its draft is on screen. Pure, so the decision is testable
// without mounting the editor.

import { mapCanonicalHoldsToPhoto } from '../../lib/spray/spray-hold-geometry';
import { allHolds, type SprayEditorAction, type SprayEditorState } from './spray-hold-editor-reducer';

/** A removed hold to put back: its canonical geometry and its id. */
export type SprayPutBackHold = {
  removedHoldId: number;
  /**
   * Holds already linked to the removed one before this trip (a reset review's
   * successor). Never reused as the put-back hold: the climb editor looks for a
   * hold linked AFTER the trip, and nudging an inherited hold replaces it.
   */
  knownSuccessorIds: readonly number[];
  cx: number;
  cy: number;
  r: number;
  outline: readonly number[] | null;
};

export type SprayPutBackPlan = {
  /** `SELECT` a hold this draft already put back, or `ADD_HOLD` a new one, selected. */
  action: SprayEditorAction;
  /** Where to frame the board, in the draft photo's pixels. */
  focus: { cx: number; cy: number; r: number };
};

/**
 * Select the hold a previous, unpublished trip already put back (a draft hold
 * linked to the removed one that was not linked before), or add a NEW hold at
 * the removed one's geometry, mapped canonical → this draft's photo through the
 * draft's own homography, linked by `movedFromHoldId` and selected in the same
 * step. Null when the homography sends the hold nowhere.
 */
export function planSprayPutBack(
  state: SprayEditorState,
  putBack: SprayPutBackHold,
  homography: readonly number[],
): SprayPutBackPlan | null {
  const knownSuccessors = new Set(putBack.knownSuccessorIds);
  const linked = allHolds(state).find(
    (hold) =>
      hold.movedFromHoldId === putBack.removedHoldId && hold.review !== 'rejected' && !knownSuccessors.has(hold.id),
  );
  if (linked) {
    return { action: { type: 'SELECT', id: linked.id }, focus: { cx: linked.cx, cy: linked.cy, r: linked.r } };
  }
  const [mapped] =
    mapCanonicalHoldsToPhoto(homography, [
      { id: putBack.removedHoldId, cx: putBack.cx, cy: putBack.cy, r: putBack.r, outline: putBack.outline },
    ]) ?? [];
  if (!mapped) return null;
  const geometry = { cx: mapped.cx, cy: mapped.cy, r: mapped.r, outline: mapped.outline ?? null };
  return {
    action: { type: 'ADD_HOLD', geometry, movedFromHoldId: putBack.removedHoldId, select: true },
    focus: { cx: geometry.cx, cy: geometry.cy, r: geometry.r },
  };
}
