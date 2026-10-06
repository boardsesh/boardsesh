import {
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * How long the board's zoom must hold still to count as settled, in ms: past a
 * pinch's end and the 150-250 ms zoom animations, short enough that the slider's
 * range is right by the time a hand reaches it.
 */
export const ZOOM_SETTLE_MS = 120;
/** A zoom change smaller than this is the same zoom. */
export const ZOOM_EPSILON = 1e-3;

/**
 * Tells `onSettle` the zoom each time it SETTLES — once it has held still for
 * {@link ZOOM_SETTLE_MS} at a new value — and once after mount. Never per frame.
 *
 * Event-driven, so nothing runs while the board is idle: every zoom change
 * restarts one delayed no-op timing on a shared value (a restarted delay is the
 * debounce), and only the timing that survives its delay reports, with one hop
 * to JS. Without `onSettle` nothing is ever scheduled.
 */
export function useZoomSettle(zoomSV: SharedValue<number>, onSettle: ((zoom: number) => void) | undefined): void {
  const timerSV = useSharedValue(0);
  const settledZoomSV = useSharedValue(-1);
  useAnimatedReaction(
    () => zoomSV.value,
    () => {
      if (!onSettle) return;
      // Assigning cancels the pending delay (its callback gets `finished` false).
      timerSV.value = 0;
      timerSV.value = withDelay(
        ZOOM_SETTLE_MS,
        withTiming(1, { duration: 0 }, (finished) => {
          if (!finished) return;
          const zoom = zoomSV.value;
          if (Math.abs(zoom - settledZoomSV.value) <= ZOOM_EPSILON) return;
          settledZoomSV.value = zoom;
          runOnJS(onSettle)(zoom);
        }),
      );
    },
    [zoomSV, onSettle, timerSV, settledZoomSV],
  );
}
