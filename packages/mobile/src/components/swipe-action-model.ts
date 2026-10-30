/** Same reveal and full-swipe distances on climb, logbook, and queue rows. */
export const SWIPE_ACTION_REVEAL = 88;
export const SWIPE_REVEAL_THRESHOLD = 44;
export const SWIPE_FULL_THRESHOLD = 192;
export const SWIPE_FRICTION = 1;
/** Sideways travel before a row starts to slide. ReanimatedSwipeable's default is
 * 10px with no vertical bail, so the sideways drift of a normal thumb scroll
 * slid rows open mid-scroll. 30px needs a deliberate sideways drag. */
export const SWIPE_ACTIVATION_OFFSET = 30;
/** Travel that decides a touch's direction: vertical first locks the swipe out
 * for the whole touch, sideways first lets it run. See useSwipeDirectionLock. */
export const SWIPE_DIRECTION_LOCK = 10;
export type SwipeDirection = 'left' | 'right';
export function fullSwipeDirection(translationX: number): SwipeDirection | null {
  'worklet';
  if (translationX >= SWIPE_FULL_THRESHOLD) return 'right';
  if (translationX <= -SWIPE_FULL_THRESHOLD) return 'left';
  return null;
}
