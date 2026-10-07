// Delete one of the caller's own spray climbs (#5960). The server refuses with
// `CLIMB_HAS_TICKS` once anybody has logged it; `deleteClimbRefusal` in
// `components/climb-actions/delete-climb-rules.ts` maps the codes to copy.
//
// Online only, never queued: a delete that waited in the outbox could land after
// somebody ticked the climb. Errors are not toasted here; the caller does that.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DELETE_CLIMB_MUTATION,
  type DeleteClimbMutationVariables,
  type DeleteClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import { getHttpClient } from '../client';
import { captureAuthCredentialGeneration } from '../../auth-store';
import { removeDeletedClimbFromDevice } from '../../../offline/remove-deleted-climb';
import {
  CLIMB_QUERY_KEY,
  INFINITE_SEARCH_CLIMBS_QUERY_KEY,
  SEARCH_CLIMBS_COUNT_QUERY_KEY,
  SEARCH_CLIMBS_QUERY_KEY,
} from '../query-keys';

/**
 * On success the climb comes off this phone's downloaded copy first, then the
 * search and climb caches refetch, so no list (online or downloaded) shows it.
 */
export function useDeleteClimb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: DeleteClimbMutationVariables) => {
      // Captured before the request, so a sign-out during it stops the local write.
      const authGeneration = captureAuthCredentialGeneration();
      const response = await getHttpClient().request<DeleteClimbMutationResponse>(DELETE_CLIMB_MUTATION, variables);
      await removeDeletedClimbFromDevice({ uuid: variables.uuid, boardType: variables.boardType }, authGeneration);
      return response.deleteClimb;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SEARCH_CLIMBS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: INFINITE_SEARCH_CLIMBS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SEARCH_CLIMBS_COUNT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: CLIMB_QUERY_KEY });
    },
  });
}
