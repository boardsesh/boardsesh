import { useMemo, useRef } from 'react';
import { Gesture, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, type SharedValue } from 'react-native-reanimated';
import { resolveHoldAtPoint, type HoldHitTarget } from './holdLayout';

// Match the per-hold detectors in HoldTarget.tsx so a tap while zoomed behaves
// identically to a tap at rest. Keep in sync. As in HoldTarget, a release in the
// 300–400ms gap between maxDuration and minDuration fires neither tap nor
// long-press — intentional parity with the at-rest behaviour, not a new dead zone.
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_DISTANCE_PX = 15;
const LONG_PRESS_MIN_DURATION_MS = 400;

// Tap/LongPress default to a single pointer, so a 2-finger pinch fails them and
// falls through to the ancestor pinch — same as HoldTarget.tsx at rest.

/** Default drag distance (px) before the zoom-pan activates. Boards that compose
 *  this hook pass it to useZoomPanGesture's `panActivationOffset`, so a stationary
 *  tap stays under the tap detector instead of being eaten by the pan. */
export const PAN_ACTIVATION_OFFSET = 8;

type UseZoomedHoldTapGestureOptions = {
  /** The board's 1-finger zoom-pan, built with `panActivationOffset` so a
   *  stationary tap never crosses its activation threshold. */
  zoomPanGesture: GestureType;
  scaleSV: SharedValue<number>;
  translateXSV: SharedValue<number>;
  translateYSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  /** Hold hit circles in board-local render px (from buildHoldHitTargets). */
  hitTargets: HoldHitTarget[];
  /** Tap handler (paint / open picker). When omitted, the hook returns the bare
   *  pan unchanged — used by zone mode, which has no per-hold taps. */
  onTap?: (holdId: number) => void;
  /** Long-press handler (role sheet). Falls back to onTap when omitted, matching
   *  HoldTargetLayer which wires both. */
  onLongPress?: (holdId: number) => void;
};

/**
 * Compose per-hold tap + long-press into the zoomed pan overlay so painting and
 * the role sheet work while zoomed.
 *
 * Why this hook exists: while zoomed an absoluteFill pan overlay sits above the
 * transformed board, so RNGH never offers the touch to the per-hold detectors
 * underneath (#2687). Here the overlay itself resolves taps: the worklet inverts
 * the board's zoom transform to map the screen point into board-local px, then
 * `resolveHoldAtPoint` (on the JS thread) finds the hold under it.
 *
 * Composition is `Gesture.Race(pan, longPress, tap)`, NOT `Exclusive`. Exclusive
 * would make longPress/tap wait for the pan to fail, but the pan only fails on
 * touch-up — so the 400ms long-press could never fire mid-hold. With Race the
 * first gesture to activate wins: a stationary touch never crosses the pan's
 * activeOffset, so tap (quick release) or longPress (≥400ms) wins; any real drag
 * activates the pan first and cancels the others. The pan's `panActivationOffset`
 * (set by the board via useZoomPanGesture) is what keeps a slightly-sloppy
 * stationary tap from being stolen by the pan.
 *
 * The composed gesture is built ONCE per overlay mount: its deps are only stable
 * shared values + the pan, and the JS handlers read render-scoped values
 * (hitTargets, callbacks) through a ref. Rebuilding a live gesture mid-session
 * has wedged iOS RNGH before (see use-carousel-gesture / use-zoom-pan-gesture
 * comments); the overlay is mounted/unmounted wholesale on isZoomed instead.
 */
export function useZoomedHoldTapGesture({
  zoomPanGesture,
  scaleSV,
  translateXSV,
  translateYSV,
  containerWidthSV,
  containerHeightSV,
  hitTargets,
  onTap,
  onLongPress,
}: UseZoomedHoldTapGestureOptions): ComposedGesture | GestureType {
  const hasTap = onTap != null;

  const callbacksRef = useRef({ hitTargets, onTap, onLongPress });
  callbacksRef.current = { hitTargets, onTap, onLongPress };

  // Captured once by the gesture memo — only closes over the ref (stable).
  const handleTap = (boardX: number, boardY: number) => {
    const current = callbacksRef.current;
    if (!current.onTap) return;
    const holdId = resolveHoldAtPoint(boardX, boardY, current.hitTargets);
    if (holdId != null) current.onTap(holdId);
  };
  const handleLongPress = (boardX: number, boardY: number) => {
    const current = callbacksRef.current;
    const handler = current.onLongPress ?? current.onTap;
    if (!handler) return;
    const holdId = resolveHoldAtPoint(boardX, boardY, current.hitTargets);
    if (holdId != null) handler(holdId);
  };

  return useMemo(() => {
    if (!hasTap) return zoomPanGesture;

    const tap = Gesture.Tap()
      .maxDuration(TAP_MAX_DURATION_MS)
      .maxDistance(TAP_MAX_DISTANCE_PX)
      .onStart((event) => {
        'worklet';
        // Inverse of animatedZoomStyle ([translate, scale], center origin). The
        // tested twin is inverseTransformPoint in holdLayout.ts — keep in sync.
        const cx = containerWidthSV.value / 2;
        const cy = containerHeightSV.value / 2;
        const boardX = (event.x - translateXSV.value - cx) / scaleSV.value + cx;
        const boardY = (event.y - translateYSV.value - cy) / scaleSV.value + cy;
        runOnJS(handleTap)(boardX, boardY);
      });

    const longPress = Gesture.LongPress()
      .minDuration(LONG_PRESS_MIN_DURATION_MS)
      .onStart((event) => {
        'worklet';
        const cx = containerWidthSV.value / 2;
        const cy = containerHeightSV.value / 2;
        const boardX = (event.x - translateXSV.value - cx) / scaleSV.value + cx;
        const boardY = (event.y - translateYSV.value - cy) / scaleSV.value + cy;
        runOnJS(handleLongPress)(boardX, boardY);
      });

    // handleTap/handleLongPress are intentionally not deps — captured once and
    // read render-scoped values through callbacksRef (see use-carousel-gesture).
    return Gesture.Race(zoomPanGesture, longPress, tap);
  }, [hasTap, zoomPanGesture, scaleSV, translateXSV, translateYSV, containerWidthSV, containerHeightSV]);
}
