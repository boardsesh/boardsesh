import type { ClimbBias, WorkoutStageFilters } from '@boardsesh/playlist-generator';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

/**
 * The personal flags of one search tier: which climbs of a grade it returns,
 * read from your logbook at this angle. Only the flags a tier sets are sent.
 */
export type ClimbSearchTier = Readonly<Pick<ClimbSearchInput, 'hideAttempted' | 'hideCompleted' | 'showOnlyAttempted'>>;

/** The ascent mark a search tier proves: tried and not sent, or sent. */
export type TierAscentStatus = 'attempt' | 'send';

/**
 * One search of a pool. `adds` is what every climb this search finds, and no
 * search before it did, is known to be: the mark its row can draw before the
 * logbook for that climb has loaded. Null when the flags do not pin it down
 * (a climb you tried may also be one you sent).
 */
export type SearchTierRule = Readonly<{ flags: ClimbSearchTier; adds: TierAscentStatus | null }>;

// hideAttempted drops climbs with an attempt tick and hideCompleted those with
// a flash or send tick, so the pair leaves the climbs you have never touched.
const UNTRIED: SearchTierRule = { flags: { hideAttempted: true, hideCompleted: true }, adds: null };
// After UNTRIED: not sent, and not untouched either, so tried.
const TRIED_UNSENT_TOP_UP: SearchTierRule = { flags: { hideCompleted: true }, adds: 'attempt' };
// After TRIED_UNSENT_TOP_UP: everything left is a climb you sent.
const SENT_TOP_UP: SearchTierRule = { flags: {}, adds: 'send' };
const TRIED: SearchTierRule = { flags: { showOnlyAttempted: true }, adds: null };
const TRIED_UNSENT: SearchTierRule = { flags: { showOnlyAttempted: true, hideCompleted: true }, adds: 'attempt' };
const UNSENT: SearchTierRule = { flags: { hideCompleted: true }, adds: null };
const EVERY_CLIMB: SearchTierRule = { flags: {}, adds: null };

type BiasSearchTiers = Readonly<{
  /** Every search, best first. Each returns every climb the one before it does, and more. */
  all: readonly SearchTierRule[];
  /** Skip what I've sent: only searches that hide every climb you have sent. */
  unsent: readonly SearchTierRule[];
  /**
   * Skip what I've tried: only searches that hide every climb you have tried or
   * sent. Null where the bias asks for climbs you have tried, so the switch
   * cannot apply.
   */
  untried: readonly SearchTierRule[] | null;
}>;

/**
 * The search tiers of each climb bias (#6232), and what each skip switch leaves
 * of them. One table, so a later preference (liked climbs, say) is one more
 * column or row here rather than another branch in the fetch.
 *
 * - Unfamiliar (the default) prefers climbs you have not tried, then the ones
 *   you tried but did not send, then the ones you sent, as top-ups.
 * - Attempted and Any send the one search each always sent; a skip switch swaps
 *   it for the search that hides what it skips.
 */
export const SEARCH_TIERS_BY_BIAS: Readonly<Record<ClimbBias, BiasSearchTiers>> = {
  unfamiliar: {
    all: [UNTRIED, TRIED_UNSENT_TOP_UP, SENT_TOP_UP],
    unsent: [UNTRIED, TRIED_UNSENT_TOP_UP],
    untried: [UNTRIED],
  },
  attempted: { all: [TRIED], unsent: [TRIED_UNSENT], untried: null },
  any: { all: [EVERY_CLIMB], unsent: [UNSENT], untried: [UNTRIED] },
};

/** Whether Skip what I've tried can apply under a climb bias. Not under Attempted, which picks tried climbs. */
export function biasCanSkipTried(climbBias: ClimbBias): boolean {
  return SEARCH_TIERS_BY_BIAS[climbBias].untried !== null;
}

/**
 * The search tiers of one set of filters, best first. Skip what I've tried wins
 * over Skip what I've sent: it leaves out sent climbs too. Signed out there is
 * no logbook to read: one search, no personal flags.
 */
export function searchTierRules(
  filters: WorkoutStageFilters | undefined,
  isAuthenticated: boolean,
): readonly SearchTierRule[] {
  if (!isAuthenticated || !filters) return [EVERY_CLIMB];
  const tiers = SEARCH_TIERS_BY_BIAS[filters.climbBias];
  if (filters.skipTried && tiers.untried) return tiers.untried;
  return filters.skipSent ? tiers.unsent : tiers.all;
}

/**
 * Just the flags of `searchTierRules`, the requests `fetchGradePool` sends in
 * order. Each tier returns every climb the one before it does and more, so the
 * later tiers only top the pool up.
 */
export function searchTiers(filters: WorkoutStageFilters | undefined, isAuthenticated: boolean): ClimbSearchTier[] {
  return searchTierRules(filters, isAuthenticated).map((rule) => rule.flags);
}

/**
 * The mark the search that found a pool climb proves, by that search's index in
 * the pool's tiers (`GradePool.topUpTiers`, 0 when absent).
 *
 * Takes the filters as `fetchFilters` returned them, the ones the pool was
 * fetched with: signed out those are already one search with no personal
 * flags, so they are read as signed in here. Raw stored block filters would
 * give a signed-out pool a mark its search never proved.
 */
export function tierAscentStatus(
  fetchNormalizedFilters: WorkoutStageFilters | undefined,
  tierIndex: number,
): TierAscentStatus | null {
  return searchTierRules(fetchNormalizedFilters, true)[tierIndex]?.adds ?? null;
}
