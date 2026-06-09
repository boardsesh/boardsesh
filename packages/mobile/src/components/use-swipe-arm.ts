import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lazy-mount state machine for a swipeable row's animated action panels.
 *
 * The heavy animated swipe inners (icon interpolation + haptic-detent reaction)
 * only mount once a drag actually starts on the row: `arm()` flips the machine
 * on at the first horizontal drag and gates the inner's mount. It resets when
 * the row recycles onto a new climb (`resetKey` change) and when a swipe settles
 * the row back shut (`disarm()`), so an idle row always sits in the cheap
 * shell-only state — even after its first swipe.
 *
 * Two views of the same flag are returned on purpose:
 *
 * - `armed` (state) re-renders the row so the `renderLeftActions` /
 *   `renderRightActions` callbacks run again and pick up the new value.
 * - `armedRef` mirrors it so those callbacks can read the live value while
 *   keeping a stable (dep-free) identity. A changed render-callback reference
 *   makes ReanimatedSwipeable tear down and re-create the action-panel subtree,
 *   which would unmount and re-mount the heavy inner on the very frame it first
 *   becomes visible (restarting its animated values from zero). Reading the ref
 *   keeps the callbacks dep-free while the `armed` state change drives the
 *   re-render, so the shell→inner swap happens in place.
 */
export function useSwipeArm(resetKey: string) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);

  const arm = useCallback(() => {
    if (armedRef.current) return;
    armedRef.current = true;
    setArmed(true);
  }, []);

  const disarm = useCallback(() => {
    if (!armedRef.current) return;
    armedRef.current = false;
    setArmed(false);
  }, []);

  // Recycle: FlashList reuses the row instance for a new climb. Drop back to the
  // cheap shell so the recycled row isn't carrying the previous climb's inner.
  useEffect(() => {
    disarm();
  }, [resetKey, disarm]);

  return { armed, armedRef, arm, disarm };
}
