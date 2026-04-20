import type { Climb, BoardConfig, BoardConfigInput, ClimbQueueItem } from '@boardsesh/shared-schema';
import type { ParsedBoardRouteParameters, ClimbSearchParams } from '../../../db/queries/climbs/index';

/**
 * Context object passed from searchClimbs query to ClimbSearchResult field resolvers.
 * This allows each field (climbs, totalCount, hasMore) to be resolved independently.
 */
export type ClimbSearchContext = {
  params: ParsedBoardRouteParameters;
  searchParams: ClimbSearchParams;
  userId: string | undefined;
  // Cached results to avoid duplicate queries when multiple fields are requested
  _cachedClimbs?: Climb[];
  _cachedHasMore?: boolean;
  _cachedTotalCount?: number;
  /** True when the query has no user-specific filters and results can be cached in Redis */
  _isCacheable?: boolean;
};

/**
 * Input type for createSession mutation
 */
export type CreateSessionInput = {
  boardPath: string;
  latitude: number;
  longitude: number;
  name?: string;
  discoverable: boolean;
  goal?: string;
  isPermanent?: boolean;
  boardIds?: number[];
  color?: string;
  /**
   * Extra board configs to attach beyond the primary board encoded in
   * `boardPath`. Persisted with the session so multi-board queues can
   * carry the full roster across clients.
   */
  boards?: BoardConfigInput[];
};

/**
 * Maximum retries for version conflicts in queue operations
 */
export const MAX_RETRIES = 3;

/**
 * Stable dedupe key for a board config. Excludes angle — per-climb
 * angle variants are still the same physical board.
 */
function boardConfigKey(cfg: BoardConfig): string {
  const setIds = [...cfg.setIds].sort((a, b) => a - b).join(',');
  return `${cfg.boardName}|${cfg.layoutId}|${cfg.sizeId}|${setIds}`;
}

/**
 * Compute the session's board roster for GraphQL `Session.boards`.
 *
 * Precedence:
 * 1. Explicit `boards` supplied on createSession (primary is the first entry
 *    or — when back-compat callers pass only extras — the queue's first
 *    boardConfig / the caller-provided primary).
 * 2. Derived from the queue's `boardConfig` entries (for sessions created
 *    before this field existed or joined by older clients).
 * 3. Empty list when neither source has anything.
 *
 * The returned list is deduped by physical board (name/layout/size/sets).
 * The first entry should match `boardPath` when possible.
 */
export function computeSessionBoards(
  queue: ClimbQueueItem[],
  explicit?: BoardConfigInput[] | null,
  primary?: BoardConfig | null,
): BoardConfig[] {
  const seen = new Set<string>();
  const out: BoardConfig[] = [];
  const pushUnique = (cfg: BoardConfig) => {
    const key = boardConfigKey(cfg);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cfg);
  };
  if (primary) pushUnique(primary);
  if (explicit && explicit.length > 0) {
    for (const cfg of explicit) pushUnique(cfg);
  }
  for (const item of queue) {
    if (item.boardConfig) pushUnique(item.boardConfig);
  }
  return out;
}
