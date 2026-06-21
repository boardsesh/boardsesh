import type { ActivityFeedInput } from '@boardsesh/shared-schema';

/** The two home-feed axes the toggle switches between. */
export type FeedMode = 'gym' | 'crew';

/**
 * Derive the `ActivityFeedInput` for the home feed from the current scope.
 *
 * - `crew`: ALL activity from people you follow, across every board — never
 *   board-filtered. (Filtering crew by the selected board surfaced an empty feed
 *   when you'd just viewed a board with no followed climbers, e.g. MoonBoard.)
 * - `gym`: everyone on the selected board (`boardUuid`). A `null` `boardUuid` is
 *   "Everyone" — the global discovery feed.
 *
 * `limit`/`cursor` are owned by the paginator (`useSessionGroupedFeed` spreads
 * them in), so they're intentionally absent here.
 */
export function deriveFeedScopeInput(mode: FeedMode, boardUuid: string | null): ActivityFeedInput {
  if (mode === 'crew') {
    return { followingOnly: true, includeDailyHighlights: true };
  }
  return { boardUuid, followingOnly: false, includeDailyHighlights: true };
}
