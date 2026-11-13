// Android's answer to dragging the iOS tick sheet up to its larger detent (#7343).
//
// The Material sheet can't do this itself: its first stop is a fixed half of the
// screen, too short for the form and its pinned actions (#4723), and it never
// tells JS when it is dragged. So the content-fitted sheet stays where it is and
// a swipe up on the form opens the fold, which grows the sheet in place. It fires
// past a threshold rather than following the finger.
//
// Claimed on move and in the bubble phase, so a tap still reaches its chip and a
// sideways drag still belongs to the rail. A body with overflow scrolls natively
// instead, and the Details row is still there.
import { useMemo } from 'react';
import { PanResponder, type GestureResponderHandlers } from 'react-native';

/** Far enough to be a deliberate swipe and well past the system touch slop. */
const SWIPE_UP_MIN_DISTANCE = 24;
/** Keeps a diagonal drag along a rail from opening the fold. */
const SWIPE_UP_MIN_DIRECTNESS = 2;

export function isSwipeUp(horizontalDistance: number, verticalDistance: number): boolean {
  return (
    verticalDistance <= -SWIPE_UP_MIN_DISTANCE &&
    Math.abs(verticalDistance) >= Math.abs(horizontalDistance) * SWIPE_UP_MIN_DIRECTNESS
  );
}

/** Handlers to spread on a view, or `undefined` while there is nothing to open. */
export function useSwipeUpToOpen(enabled: boolean, onOpen: () => void): GestureResponderHandlers | undefined {
  const panHandlers = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, { dx, dy }) => isSwipeUp(dx, dy),
        onPanResponderGrant: () => onOpen(),
      }).panHandlers,
    [onOpen],
  );
  return enabled ? panHandlers : undefined;
}
