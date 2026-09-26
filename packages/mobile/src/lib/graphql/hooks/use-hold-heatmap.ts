import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClimbSearchInput, HoldStat } from '@boardsesh/shared-schema';
import {
  HOLD_HEATMAP_QUERY,
  type HoldHeatmapQueryResponse,
  type HoldHeatmapQueryVariables,
} from '@boardsesh/graphql/operations';
import type { CatalogQuerySource } from '../../offline/use-catalog-query-source';
import { getHttpClient } from '../client';
import { offlineAwareRequest, type LocalHoldHeatmapResponse, type LocalHoldHeatmapVariables } from '../offline-request';

const HOLD_HEATMAP_STALE_TIME_MS = 5 * 60 * 1000;
const EMPTY_STATS: HoldStat[] = [];

/**
 * Per-hold usage over the climbs `input` matches, for the heatmap overlay.
 *
 * `source` comes from `useCatalogQuerySource` for the input's board scope:
 * - `local` — the downloaded board answers through `offlineAwareRequest`, where
 *   the op is registered local-only (it never reaches the network from there);
 * - `network` — an admin on a board that is not downloaded asks the admin-gated
 *   resolver directly;
 * - `download` — nothing runs; the caller shows the download offer.
 *
 * The source is part of the key so an admin's network answer and the local one
 * never share a cache entry.
 *
 * `withStats` asks the phone for each climb's grade as well; only the grade mode
 * needs it, so the count modes read the packed hold sets alone. It is part of the
 * key for the same reason. The server always answers with everything.
 */
export function useHoldHeatmap(
  input: ClimbSearchInput,
  source: CatalogQuerySource,
  enabled: boolean,
  { withStats = false }: { withStats?: boolean } = {},
) {
  const query = useQuery({
    // The server always answers with everything, so only the phone's answer
    // splits by mode; an admin switching mode reuses the one network entry.
    queryKey: ['holdHeatmap', source, input, source === 'local' ? (withStats ? 'stats' : 'holds') : 'all'],
    queryFn: () => {
      if (source === 'local') {
        // Always explicit: the local resolver reads the grade column when told nothing.
        const variables: LocalHoldHeatmapVariables = { input, withStats };
        return offlineAwareRequest<LocalHoldHeatmapResponse>(HOLD_HEATMAP_QUERY, variables);
      }
      return getHttpClient().request<HoldHeatmapQueryResponse, HoldHeatmapQueryVariables>(HOLD_HEATMAP_QUERY, {
        input,
      });
    },
    enabled: enabled && source !== 'download',
    staleTime: HOLD_HEATMAP_STALE_TIME_MS,
    // One retry: an interrupted holds-index build throws and recovers on the
    // next pass; a real failure still surfaces quickly.
    retry: 1,
  });

  const holdStats = query.data?.holdHeatmap ?? EMPTY_STATS;
  // The local fallback: the phone could not answer, which is not "no climbs".
  const isUnavailable = query.data !== undefined && 'unavailable' in query.data && query.data.unavailable === true;
  const statsByHoldId = useMemo(() => {
    const stats = new Map<number, HoldStat>();
    for (const holdStat of holdStats) stats.set(holdStat.holdId, holdStat);
    return stats;
  }, [holdStats]);

  // The phone counts the climbs it folded; the admin network answer does not.
  const climbCount =
    query.data !== undefined && 'climbCount' in query.data && typeof query.data.climbCount === 'number'
      ? query.data.climbCount
      : null;

  return {
    holdStats,
    statsByHoldId,
    climbCount,
    isFetching: query.isFetching,
    isSuccess: query.isSuccess,
    isUnavailable,
    isError: query.isError,
    errorUpdatedAt: query.errorUpdatedAt,
  };
}
