import { useMemo } from 'react';
import { PointerType } from 'react-native-gesture-handler';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { screenToBoard } from './spray-gesture-math';

/**
 * What a gesture overlay tells `SprayLoupe` about the finger, on the UI thread.
 *
 * The loupe is mounted in the screen, outside the board, so it cannot read the
 * board's zoom transform itself: the overlay that owns the touch already has
 * the transform in hand and writes everything the loupe needs, once per touch
 * event, never through JS.
 */
export type SprayLoupeFeed = {
  /**
   * When the finger touched down, in ms (`Date.now()`), or 0 while no gesture
   * wants the loupe. A timestamp rather than a flag so a 400 ms pick-up shows
   * the loupe at once, while a touch that might still be a tap waits out the
   * delay (`loupeGateOpen`).
   */
  touchDownAtSV: SharedValue<number>;
  /** The finger, in the board clip's own points. */
  xSV: SharedValue<number>;
  ySV: SharedValue<number>;
  /** The point under the finger on the unzoomed board, in render px. */
  renderXSV: SharedValue<number>;
  renderYSV: SharedValue<number>;
  /** The board's zoom at that moment. */
  zoomSV: SharedValue<number>;
};

/** The pointer the loupe is for. A Pencil's tip is not covered by anything, so it never gets one. */
const FINGER_POINTER_TYPE: number = PointerType.TOUCH;

/** True for a finger: the only pointer that hides what it is on. Worklet-callable. */
export function pointerWantsLoupe(pointerType: number): boolean {
  'worklet';
  return pointerType === FINGER_POINTER_TYPE;
}

/** One feed, owned by the screen and handed to every overlay that can show the loupe. */
export function useSprayLoupeFeed(): SprayLoupeFeed {
  const touchDownAtSV = useSharedValue(0);
  const xSV = useSharedValue(0);
  const ySV = useSharedValue(0);
  const renderXSV = useSharedValue(0);
  const renderYSV = useSharedValue(0);
  const zoomSV = useSharedValue(1);
  return useMemo(
    () => ({ touchDownAtSV, xSV, ySV, renderXSV, renderYSV, zoomSV }),
    [touchDownAtSV, xSV, ySV, renderXSV, renderYSV, zoomSV],
  );
}

/**
 * Point the loupe at a finger at `(x, y)` in the board clip, under the board's
 * live zoom transform. `touchDownAt` is when that finger landed. A no-op
 * without a feed, so an overlay's loupe stays opt-in.
 */
export function trackLoupe(
  feed: SprayLoupeFeed | undefined,
  touchDownAt: number,
  x: number,
  y: number,
  scale: number,
  translateX: number,
  translateY: number,
  containerWidth: number,
  containerHeight: number,
): void {
  'worklet';
  if (!feed) return;
  // Board scale 1: the render px of the unzoomed board, which is what the
  // loupe's own copy of the board is laid out in.
  const render = screenToBoard(x, y, scale, translateX, translateY, containerWidth, containerHeight, 1);
  feed.xSV.value = x;
  feed.ySV.value = y;
  feed.renderXSV.value = render.x;
  feed.renderYSV.value = render.y;
  feed.zoomSV.value = scale;
  feed.touchDownAtSV.value = touchDownAt;
}

/** True while the loupe is following a touch. */
export function loupeIsTracking(feed: SprayLoupeFeed | undefined): boolean {
  'worklet';
  return feed !== undefined && feed.touchDownAtSV.value !== 0;
}

/** The gesture that wanted the loupe is over. */
export function stopLoupe(feed: SprayLoupeFeed | undefined): void {
  'worklet';
  if (!feed || feed.touchDownAtSV.value === 0) return;
  feed.touchDownAtSV.value = 0;
}
