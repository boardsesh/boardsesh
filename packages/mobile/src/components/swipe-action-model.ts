/** Same reveal and full-swipe distances on climb, logbook, and queue rows. */
export const SWIPE_ACTION_REVEAL = 88;
export const SWIPE_REVEAL_THRESHOLD = 44;
export const SWIPE_FULL_THRESHOLD = 192;
export const SWIPE_FRICTION = 1;
export type SwipeDirection = 'left' | 'right';
export function fullSwipeDirection(translationX: number): SwipeDirection | null {
  'worklet';
  if (translationX >= SWIPE_FULL_THRESHOLD) return 'right';
  if (translationX <= -SWIPE_FULL_THRESHOLD) return 'left';
  return null;
}
