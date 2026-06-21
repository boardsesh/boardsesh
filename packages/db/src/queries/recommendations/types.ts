/**
 * Shared types for the catalog-based recommendation engine.
 *
 * Unlike smart playlists (computed from a user's own ticks), recommendations are
 * computed from the board catalog (board_climbs × board_climb_stats) for a
 * resolved "board target" and ranked by Aurora popularity × rating × how fully
 * the climb uses the board, boosted by setter popularity and community sends.
 */

export const RECOMMENDATION_TYPES = [
  'RECOMMENDED_CROWD_FAVORITES',
  'RECOMMENDED_HIDDEN_GEMS',
  'RECOMMENDED_AT_LEVEL',
  'RECOMMENDED_FRESH',
] as const;

export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export function isRecommendationType(value: string): value is RecommendationType {
  return (RECOMMENDATION_TYPES as readonly string[]).includes(value);
}

/** The board we are recommending for: type + biggest size + angle + layout. */
export type BoardTarget = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  angle: number;
  /** Sets the owner has; climbs needing other sets are excluded. Null = skip. */
  setIds: number[] | null;
};

export type RecommendationQueryParams = {
  type: RecommendationType;
  target: BoardTarget;
  /** Same-product sizes shorter than the target (fullness "shorter" tier). */
  shorterSizeIds: number[];
  /** Same-product, same-height, narrower sizes (fullness "narrower" tier). */
  narrowerSameHeightSizeIds: number[];
  /** Inclusive display_difficulty band for AT_LEVEL. Required for that type. */
  gradeBand: { minDifficultyId: number; maxDifficultyId: number } | null;
  /** Exclude climbs this user has already sent (flash/send) at the angle. */
  excludeUserId: string | null;
  /** How far back published_at counts as "fresh" (days). */
  freshWindowDays: number;
};
