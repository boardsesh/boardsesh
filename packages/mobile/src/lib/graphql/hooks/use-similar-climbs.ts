import { useQuery } from '@tanstack/react-query';
import {
  SIMILAR_CLIMBS_QUERY,
  type SimilarClimbsResponse,
  type SimilarClimbsVariables,
} from '@boardsesh/graphql/operations';
import { getHttpClient } from '../client';
import { offlineAwareRequest } from '../offline-request';
import { useCatalogQuerySourceState } from '../../offline/use-catalog-query-source';

/**
 * Position-only Jaccard similar climbs for a saved climb. `climbUuid` null
 * disables the query (e.g. before a climb is selected).
 *
 * Where the answer comes from is `useCatalogQuerySource`'s call: the
 * downloaded board (`local`, through the local-only `offlineAwareRequest`
 * registration), the server for an admin whose board is not downloaded
 * (`network`), or nowhere (`download` — the section offers the download
 * instead). `source` is returned so the section can render that offer.
 *
 * The key keeps its `['similarClimbs', ...]` prefix: the sync engine
 * invalidates it when the holds index changes (TABLE_INVALIDATE_KEYS).
 */
export function useSimilarClimbs(
  scope: { boardName: string; layoutId: number; sizeId: number },
  climbUuid: string | null,
  angle: number,
  limit = 12,
) {
  const { boardName, layoutId, sizeId } = scope;
  const { source, isResolving } = useCatalogQuerySourceState(scope);
  const query = useQuery({
    queryKey: ['similarClimbs', boardName, climbUuid, layoutId, sizeId, angle, limit, source],
    queryFn: () => {
      const variables: SimilarClimbsVariables = {
        input: { boardType: boardName, layoutId, sizeId, climbUuid: climbUuid!, angle, limit },
      };
      return source === 'network'
        ? getHttpClient().request<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, variables)
        : offlineAwareRequest<SimilarClimbsResponse>(SIMILAR_CLIMBS_QUERY, variables);
    },
    select: (data) => data.similarClimbs,
    enabled: !!climbUuid && source !== 'download',
    staleTime: 5 * 60 * 1000,
  });
  return { ...query, source, isResolvingSource: isResolving };
}
