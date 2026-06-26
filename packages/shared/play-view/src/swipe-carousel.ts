// Web (useCardSwipeNavigation) and mobile (useCarouselGesture) own the gesture
// plumbing; timings + decision rules live here so both stay in lockstep.

export const SWIPE_THRESHOLD = 80;
export const DIRECTION_THRESHOLD = 10;
// Direction-lock horizontal bias (mobile play drawer). The lock picks vertical
// only when the motion is clearly vertical — absY at least this multiple of absX.
// >1 favours horizontal so a horizontal-intended climb swipe that drifts slightly
// down still locks horizontal, and the drawer's pull-to-dismiss can't grab it.
// Genuine scroll/dismiss gestures are near-vertical (absX ≈ 0), so they clear this
// easily and still lock vertical. Web keeps the symmetric default (1).
export const VERTICAL_LOCK_RATIO = 1.5;
export const EXIT_DURATION = 300;
export const SNAP_BACK_DURATION = 200;
// New climb swaps in this many ms after the slide-off begins.
export const CLIP_EXIT_DURATION = 100;
export const ENTER_ANIMATION_DURATION = 170;

// Zoom constants shared between web (useZoomPan) and mobile (useZoomPanGesture).
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const ZOOM_THRESHOLD = 1.02;

// Pinch-zoom focal-point math: keep the point under the focal stationary
// across a scale change. The savedTranslate term must be multiplied by
// scaleDelta — pinching from an already-zoomed state with the wrong formula
// drifts the focal point off the user's fingers. Mobile inlines this formula
// inside a reanimated worklet (cross-module worklet calls aren't reliable);
// the shared definition exists as the canonical spec and for unit tests.
export function computeFocalPinchTranslation({
  focalOffset,
  scaleDelta,
  savedTranslate,
}: {
  focalOffset: number;
  scaleDelta: number;
  savedTranslate: number;
}): number {
  return focalOffset * (1 - scaleDelta) + scaleDelta * savedTranslate;
}

// Clamp translation so zoomed content stays within the visible container —
// at scale s the content overflows by (container * (s - 1)) / 2 on each
// side, so the translation can move up to that much before exposing empty
// space. Same inline / shared split as computeFocalPinchTranslation.
export function clampTranslation(
  translationX: number,
  translationY: number,
  currentScale: number,
  containerWidth: number,
  containerHeight: number,
): { x: number; y: number } {
  if (currentScale <= 1) return { x: 0, y: 0 };

  const maxX = (containerWidth * (currentScale - 1)) / 2;
  const maxY = (containerHeight * (currentScale - 1)) / 2;

  return {
    x: Math.max(-maxX, Math.min(maxX, translationX)),
    y: Math.max(-maxY, Math.min(maxY, translationY)),
  };
}

export type SwipeDirection = 'left' | 'right';
export type AnimationDirection = SwipeDirection | null;
export type EnterDirection = 'from-left' | 'from-right';
export type SwipeOutcome = 'next' | 'previous' | 'cancel';
export type PeekDirection = 'next' | 'prev';

// 'worklet' so this is callable from reanimated UI-thread closures on mobile.
// In non-worklet contexts (web, tests) the directive is a harmless no-op.
export function computePeekOffset({
  direction,
  swipeOffset,
  viewportWidth,
}: {
  direction: PeekDirection;
  swipeOffset: number;
  viewportWidth: number;
}): number {
  'worklet';
  if (direction === 'next') {
    return Math.max(0, viewportWidth + swipeOffset);
  }
  return Math.min(0, -viewportWidth + swipeOffset);
}

export function decideSwipeDirection(
  deltaX: number,
  deltaY: number,
  threshold: number = DIRECTION_THRESHOLD,
  verticalBiasRatio = 1,
): 'horizontal' | 'vertical' | null {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX <= threshold && absY <= threshold) return null;
  // Lock vertical only when absY is at least `verticalBiasRatio`× the horizontal
  // travel. Ratio 1 is the original symmetric rule (ties → vertical); a higher
  // ratio biases toward horizontal (see VERTICAL_LOCK_RATIO).
  return absY >= absX * verticalBiasRatio ? 'vertical' : 'horizontal';
}

export function evaluateSwipeOutcome({
  deltaX,
  threshold,
  canNext,
  canPrev,
}: {
  deltaX: number;
  threshold?: number;
  canNext: boolean;
  canPrev: boolean;
}): SwipeOutcome {
  const t = threshold ?? SWIPE_THRESHOLD;
  if (deltaX <= -t && canNext) return 'next';
  if (deltaX >= t && canPrev) return 'previous';
  return 'cancel';
}

export function selectPeekDirection({
  animationDirection,
  swipeOffset,
}: {
  animationDirection: AnimationDirection;
  swipeOffset: number;
}): PeekDirection {
  if (animationDirection === 'left') return 'next';
  if (animationDirection === 'right') return 'prev';
  return swipeOffset < 0 ? 'next' : 'prev';
}

export function getEnterDirection(navigation: 'next' | 'previous'): EnterDirection {
  return navigation === 'next' ? 'from-right' : 'from-left';
}

// ── Mobile swipe-between-climbs animation ───────────────────────────────────
// Mobile-only tuning + helper for the play-drawer's horizontal swipe: the current
// board + climb name slide with the finger and, on release past the threshold,
// fling off-screen while the next climb slides in edge-adjacent (computePeekOffset
// above). A flat horizontal slide — no tilt, no droop. Web's swipe matches.

/** Extra px past the screen edge the fling targets so the card fully clears. */
export const SWIPE_OFFSCREEN_PAD = 80;

// Where the fling animates translateX to so the card fully clears the screen,
// margins included. The mobile gesture inlines `screenWidth + SWIPE_OFFSCREEN_PAD`
// (cross-module worklet CALLS aren't reliable in gesture callbacks); this is the
// canonical spec / test target.
export function computeSwipeExitTarget(screenWidth: number): number {
  'worklet';
  return screenWidth + SWIPE_OFFSCREEN_PAD;
}
