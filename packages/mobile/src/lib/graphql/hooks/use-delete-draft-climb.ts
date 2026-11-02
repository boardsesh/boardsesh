import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DELETE_DRAFT_CLIMB_MUTATION,
  type DeleteDraftClimbMutationVariables,
  type DeleteDraftClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import { getHttpClient } from '../client';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { assertClimbDeleteReady } from '../../../offline/assert-climb-delete-ready';
import { removeDeletedClimbFromDevice } from '../../../offline/remove-deleted-climb';
import {
  CLIMB_QUERY_KEY,
  SEARCH_CLIMBS_QUERY_KEY,
  INFINITE_SEARCH_CLIMBS_QUERY_KEY,
  SEARCH_CLIMBS_COUNT_QUERY_KEY,
} from '../query-keys';

/** Delete a server draft and reconcile its downloaded copy before the final refetch. */
export function useDeleteDraftClimb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: DeleteDraftClimbMutationVariables) => {
      const authGeneration = captureAuthCredentialGeneration();
      await assertClimbDeleteReady(variables);
      if (!isAuthCredentialGenerationCurrent(authGeneration)) throw new Error('Account changed before deleting climb');
      const response = await getHttpClient().request<DeleteDraftClimbMutationResponse>(
        DELETE_DRAFT_CLIMB_MUTATION,
        variables,
      );
      return { deleted: response.deleteDraftClimb, authGeneration };
    },
    onSuccess: ({ authGeneration }, variables) => {
      const invalidateClimbLists = () => {
        void queryClient.invalidateQueries({ queryKey: SEARCH_CLIMBS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: INFINITE_SEARCH_CLIMBS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: SEARCH_CLIMBS_COUNT_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: CLIMB_QUERY_KEY });
      };
      invalidateClimbLists();
      void removeDeletedClimbFromDevice(variables, authGeneration).then(invalidateClimbLists);
    },
  });
}
