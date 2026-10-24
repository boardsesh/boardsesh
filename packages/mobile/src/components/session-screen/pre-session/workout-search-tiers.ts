import type { ClimbBias, WorkoutStageFilters } from '@boardsesh/playlist-generator';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

/**
 * The personal flags of one search tier: which climbs of a grade it returns,
 * read from your logbook at this angle. Only the flags a tier sets are sent.
 */
export type ClimbSearchTier = Readonly<
  Pick<
    ClimbSearchInput,
    'hideAttempted' | 'hideCompleted' | 'showOnlyAttempted' | 'showOnlyCompleted' | 'onlyFavorited'
  >
>;

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
// showOnlyCompleted keeps the climbs with a flash or send tick at this angle.
const SENT: SearchTierRule = { flags: { showOnlyCompleted: true }, adds: 'send' };
// A heart belongs to the climb, not an angle: onlyFavorited matches at every angle.
const LIKED: SearchTierRule = { flags: { onlyFavorited: true }, adds: null };
const LIKED_UNSENT: SearchTierRule = { flags: { onlyFavorited: true, hideCompleted: true }, adds: null };
const LIKED_UNTRIED: SearchTierRule = {
  flags: { onlyFavorited: true, hideAttempted: true, hideCompleted: true },
  adds: null,
};

type BiasSearchTiers = Readonly<{
  /** Every search, best first. Each returns every climb the one before it does, and more. */
  all: readonly SearchTierRule[];
  /**
   * Skip what I've sent: only searches that hide every climb you have sent.
   * Null where the bias asks for climbs you have sent, so the switch cannot apply.
   */
  unsent: readonly SearchTierRule[] | null;
  /**
   * Skip what I've tried: only searches that hide every climb you have tried or
   * sent. Null where the bias asks for climbs you have tried or sent, so the
   * switch cannot apply.
   */
  untried: readonly SearchTierRule[] | null;
  /**
   * The bias is a list the climber made by sending or hearting, so the crowd's
   * floors (min ascents, min rating) do not apply: `fetchFilters` drops them and
   * the block's filters hide them. Attempted keeps them, so its request stays
   * the one it always sent.
   */
  dropsFloors: boolean;
}>;

/**
 * The search tiers of each climb bias (#6232, #6739), and what each skip switch
 * leaves of them. One table, so a new bias is one more row here rather than
 * another branch in the fetch.
 *
 * - Unfamiliar (the default) prefers climbs you have not tried, then the ones
 *   you tried but did not send, then the ones you sent, as top-ups.
 * - Attempted and Any send the one search each always sent, floors and all; a
 *   skip switch swaps it for the search that hides what it skips. Tried but not
 *   sent is Attempted with Skip what I've sent, not a bias of its own.
 * - Sent and Liked are one search each too: the climbs you have sent at this
 *   angle, or hearted, with no floors. Neither skip switch fits Sent; both
 *   narrow Liked.
 */
export const SEARCH_TIERS_BY_BIAS: Readonly<Record<ClimbBias, BiasSearchTiers>> = {
  unfamiliar: {
    all: [UNTRIED, TRIED_UNSENT_TOP_UP, SENT_TOP_UP],
    unsent: [UNTRIED, TRIED_UNSENT_TOP_UP],
    untried: [UNTRIED],
    dropsFloors: false,
  },
  attempted: { all: [TRIED], unsent: [TRIED_UNSENT], untried: null, dropsFloors: false },
  sent: { all: [SENT], unsent: null, untried: null, dropsFloors: true },
  liked: { all: [LIKED], unsent: [LIKED_UNSENT], untried: [LIKED_UNTRIED], dropsFloors: true },
  any: { all: [EVERY_CLIMB], unsent: [UNSENT], untried: [UNTRIED], dropsFloors: false },
};

/** Whether Skip what I've sent can apply under a climb bias. Not under Sent, which picks sent climbs. */
export function biasCanSkipSent(climbBias: ClimbBias): boolean {
  return SEARCH_TIERS_BY_BIAS[climbBias].unsent !== null;
}

/** Whether Skip what I've tried can apply under a climb bias. Not under Attempted or Sent, which pick tried or sent climbs. */
export function biasCanSkipTried(climbBias: ClimbBias): boolean {
  return SEARCH_TIERS_BY_BIAS[climbBias].untried !== null;
}

/**
 * Whether a climb bias leaves out min ascents and min rating: Sent and Liked, a
 * list the climber made by sending or hearting. Signed out none does: the
 * search reads no logbook, so the bias falls back to Any (`fetchFilters`).
 */
export function biasDropsFloors(climbBias: ClimbBias): boolean {
  return SEARCH_TIERS_BY_BIAS[climbBias].dropsFloors;
}

/**
 * Whether a climb bias reads your logbook or your hearts, so it needs an
 * account: every bias with a search that sets a personal flag, which is every
 * bias but Any. Signed out `fetchFilters` turns each of them into Any.
 */
export function biasNeedsSignIn(climbBias: ClimbBias): boolean {
  return SEARCH_TIERS_BY_BIAS[climbBias].all.some((rule) => Object.keys(rule.flags).length > 0);
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
  if (filters.skipSent && tiers.unsent) return tiers.unsent;
  return tiers.all;
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
