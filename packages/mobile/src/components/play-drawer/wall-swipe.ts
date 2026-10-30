// Swipe the wall button left to drive the wall (#7113): the numbers and the
// release rule, kept apart from the gesture so they can be tested and run on
// the UI thread (every function here is a worklet).

/**
 * Past this share of the button's width, letting go commits: 189 pt of a 343 pt
 * button, matching the climb rows' full swipe (`SWIPE_FULL_THRESHOLD`, 192).
 * The label says what letting go will do from here on.
 */
export const SWIPE_COMMIT_PROGRESS = 0.55;
/** A fling commits early, once it has covered this share of the width. */
export const SWIPE_FLING_MIN_PROGRESS = 0.25;
/** A fling is a release faster than this, leftward (pt/s). */
export const SWIPE_FLING_VELOCITY = -800;
/** The pan claims a leftward drag past 10 pt, and gives way to a vertical one past 14 pt. */
export const SWIPE_ACTIVE_OFFSET_X = -10;
export const SWIPE_FAIL_OFFSET_Y: [number, number] = [-14, 14];
/** Short of the commit point, the frost springs back with this. */
export const SWIPE_SPRING_BACK = { damping: 20, stiffness: 300 } as const;
/** Past it, the frost fills the rest of the width this fast, then holds. */
export const SWIPE_FILL_MS = 150;
/** The one-time peek: the frost shows in a strip this wide at the trailing edge. */
export const FROST_PEEK_WIDTH = 28;
/** The peek, in and back: about 700 ms in all. */
export const PEEK_IN_MS = 250;
export const PEEK_HOLD_MS = 150;
/** Reduce Motion: the peek fades in and out where it stands, no slide. */
export const PEEK_FADE_MS = 200;
export const PEEK_FADE_HOLD_MS = 300;

/** How far a drag has wiped the frost in: 0 to 1 of the width, leftward only. */
export function wallSwipeProgress(translationX: number, width: number): number {
  'worklet';
  if (width <= 0) return 0;
  return Math.min(Math.max(-translationX / width, 0), 1);
}

/** Letting go here commits: past the commit point, or a leftward fling past a quarter. */
export function wallSwipeCommits(progress: number, velocityX: number): boolean {
  'worklet';
  if (progress >= SWIPE_COMMIT_PROGRESS) return true;
  return velocityX <= SWIPE_FLING_VELOCITY && progress >= SWIPE_FLING_MIN_PROGRESS;
}

/** The peek's strip as a share of the button's width. */
export function peekProgress(width: number): number {
  'worklet';
  return width > 0 ? Math.min(FROST_PEEK_WIDTH / width, 1) : 0;
}
