import { logger } from '../../../utils/logger';

// searchClimbs is the app's hottest query and the React Native app fires it on every page
// of infinite scroll. Reads run heavier than the 200ms mutation bar, so use a slightly
// higher slow threshold before surfacing a warning in production logs.
const SLOW_SEARCH_CLIMBS_THRESHOLD_MS = 300;

/** Where a resolved field came from, so we can read cache-hit rate from the logs. */
export type SearchClimbsMetricSource = 'db' | 'redis' | 'precomputed';

export type SearchClimbsMetricDimensions = {
  boardName: string;
  angle: number;
  page: number;
  pageSize: number;
  sortBy: string;
  cacheable: boolean;
  /** Number of climbs returned — only set for the climbs field. */
  resultCount?: number;
};

/**
 * Emit a structured latency line for a searchClimbs field resolver.
 *
 * Mirrors logMutationMetrics: slow calls warn (and reach production logs/Sentry forwarding
 * rules), everything else logs at info only in development. The JSON payload is queryable
 * by `type: 'search_climbs_metrics'` alongside `mutation_metrics`.
 */
export function logSearchClimbsMetrics(
  operation: 'searchClimbs.climbs' | 'searchClimbs.totalCount',
  durationMs: number,
  source: SearchClimbsMetricSource,
  dimensions: SearchClimbsMetricDimensions,
) {
  const rounded = Math.round(durationMs);
  const payload = {
    type: 'search_climbs_metrics',
    operation,
    durationMs: rounded,
    source,
    slow: rounded > SLOW_SEARCH_CLIMBS_THRESHOLD_MS,
    ...dimensions,
  };

  if (rounded > SLOW_SEARCH_CLIMBS_THRESHOLD_MS) {
    logger.warn(`[SearchClimbsMetrics] SLOW ${operation}: ${rounded}ms`, JSON.stringify(payload));
  } else if (process.env.NODE_ENV === 'development') {
    logger.info(`[SearchClimbsMetrics] ${operation}: ${rounded}ms`, JSON.stringify(payload));
  }
}
