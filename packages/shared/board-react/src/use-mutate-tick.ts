import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  UPDATE_TICK,
  DELETE_TICK,
  type UpdateTickInput,
  type UpdateTickVariables,
  type UpdateTickResponse,
  type DeleteTickMutationVariables,
  type DeleteTickMutationResponse,
} from '@boardsesh/graphql/operations';
import { useBoardAdapter } from './adapter';

// Stats / feed / climb-state caches that derive from a user's ticks. Editing or
// deleting a tick must refresh all of them. Prefix matching means the bare root
// key invalidates every variant (e.g. ['userTicks', '<any-userId>']).
function invalidateTickDependents(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
  void queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
  void queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });
  void queryClient.invalidateQueries({ queryKey: ['userAscentsFeed'] });
  void queryClient.invalidateQueries({ queryKey: ['logbook'] });
  void queryClient.invalidateQueries({ queryKey: ['climb'] });
  void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
  // The Sessions feed and session-detail screens aggregate sends/flashes/grade
  // pyramids straight from these caches; without busting them, editing or
  // deleting a tick leaves those cards showing stale totals until an unrelated
  // refetch (pull-to-refresh, remount past staleTime, or a comment add).
  void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
  void queryClient.invalidateQueries({ queryKey: ['sessionDetail'] });
}

/** Edit an existing tick (status / date / grade / quality / attempts / comment). */
export function useUpdateTick() {
  const { isAuthenticated, executeHttp } = useBoardAdapter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { uuid: string; input: UpdateTickInput }) => {
      if (!isAuthenticated) throw new Error('Not authenticated');
      const response = await executeHttp<UpdateTickResponse, UpdateTickVariables>(UPDATE_TICK, variables);
      return response.updateTick;
    },
    onSuccess: () => invalidateTickDependents(queryClient),
  });
}

/** Delete a tick by uuid. */
export function useDeleteTick() {
  const { isAuthenticated, executeHttp } = useBoardAdapter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (uuid: string) => {
      if (!isAuthenticated) throw new Error('Not authenticated');
      const response = await executeHttp<DeleteTickMutationResponse, DeleteTickMutationVariables>(DELETE_TICK, {
        uuid,
      });
      return response.deleteTick;
    },
    onSuccess: () => invalidateTickDependents(queryClient),
  });
}
