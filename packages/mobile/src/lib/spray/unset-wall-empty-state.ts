// "No one's set on this wall yet" — when the Climbs tab says that instead of
// "No climbs found".
//
// Pulled out of the screen because the interesting part is the three things that
// must ALL hold, and a `&&` chain buried in a 1,900-line component's JSX is a
// rule nothing can test. The Climbs tab is the wall's home once it is the active
// board (there is no separate wall route), so this empty state is the first thing
// an owner sees after photographing a wall — it has to offer the door forward
// rather than blame a filter nobody set.

export type UnsetWallEmptyStateInput = {
  /** The active board's type. Anything but `spray` answers false. */
  boardType: string;
  /** The list settled with no rows (not loading, not a placeholder). */
  isEmpty: boolean;
  /** The search text. Non-empty means the climber is looking for something. */
  query: string;
  /** How many filters are on — grade range, setter, holds, sort, and friends. */
  activeFilterCount: number;
};

/**
 * Whether to show the wall's own empty state rather than the generic one.
 *
 * The query and filter gates are not politeness, they are honesty: a wall with
 * forty climbs on it, filtered to V8+, is empty for a reason that has nothing to
 * do with the wall being new. Telling its owner "no one's set on this wall yet"
 * there would be false, and offering to set the first climb would be absurd.
 */
export function shouldShowUnsetWallEmptyState({
  boardType,
  isEmpty,
  query,
  activeFilterCount,
}: UnsetWallEmptyStateInput): boolean {
  if (!isEmpty) return false;
  if (boardType !== 'spray') return false;
  if (query.length > 0) return false;
  return activeFilterCount === 0;
}
