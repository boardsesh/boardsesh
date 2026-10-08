import { useCallback, useRef, type RefObject } from 'react';
import { hapticSelection } from '../lib/haptics';

/**
 * The one haptic a sheet plays: a selection tick when the climber drags it from
 * one detent to another.
 *
 * Apple's "Playing haptics" guidance asks for haptics that match an action the
 * person took, used sparingly. A sheet presenting is the result of a tap that
 * already gave its own feedback (or of no tap at all — a connect raising the
 * device picker), so the present stays silent. So does a snap the code asks for
 * (`useProgrammaticSnap`, the keyboard detent) and an `onChange` that re-reports
 * the detent the sheet is already resting on.
 *
 * Returns the detent-change handler; call it with every `onChange` index.
 */
export function useDetentDragHaptic(programmaticSnapRef: RefObject<boolean>): (index: number) => void {
  // -1 while closed, so the first resting detent after a present is told apart
  // from a drag between detents.
  const restingIndexRef = useRef(-1);
  return useCallback(
    (index: number) => {
      const previousIndex = restingIndexRef.current;
      restingIndexRef.current = index < 0 ? -1 : index;
      if (index < 0 || previousIndex < 0) return;
      if (index === previousIndex || programmaticSnapRef.current) return;
      hapticSelection();
    },
    [programmaticSnapRef],
  );
}
