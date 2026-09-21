/**
 * Whether a climb is a multi-frame route rather than a single-frame boulder.
 *
 * Exported so the row can gate MOUNTING the badge on it: `ClimbFramesBadge` calls
 * `useTranslation`, and a hook can't be skipped from inside the component, so a
 * badge mounted on every row would add an i18n listener to every row in the list
 * for the sake of the handful that are routes (docs/react-native-performance.md —
 * no per-row subscriptions). The badge keeps its own guard as well, so mounting it
 * unconditionally is merely wasteful, never wrong.
 *
 * Boards whose `multiFrameClimbs` capability is false (Woods) can never produce a
 * count above 1, so this is false for every climb on such a board.
 */
export function isMultiFrameClimb(framesCount: number | null | undefined): framesCount is number {
  return typeof framesCount === 'number' && framesCount > 1;
}
