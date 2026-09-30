import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardName, SaveTickInput } from '@boardsesh/shared-schema';
import {
  DELETE_TICK,
  GET_TICKS,
  SAVE_TICK,
  type DeleteTickMutationResponse,
  type GetTicksQueryResponse,
  type SaveTickMutationResponse,
} from '@boardsesh/graphql/operations/ticks';
import { graphqlRequest } from '../api/graphql-client';
import { useAuth } from '../auth/auth-provider';

/** The signed-in climber's own ticks on one climb, at every angle. */
export function useClimbTicks(boardName: BoardName | undefined, climbUuid: string | undefined) {
  const { status } = useAuth();
  return useQuery({
    queryKey: ['climbTicks', boardName, climbUuid],
    queryFn: async () =>
      (
        await graphqlRequest<GetTicksQueryResponse>(GET_TICKS, {
          input: { boardType: boardName, climbUuids: [climbUuid] },
        })
      ).ticks,
    enabled: status === 'signedIn' && boardName !== undefined && climbUuid !== undefined,
  });
}

function useRefreshTickViews() {
  const queryClient = useQueryClient();
  return (boardType: string, climbUuid: string) => {
    // Profile stats and the logbook both read the climber's ticks.
    void queryClient.invalidateQueries({ queryKey: ['userTickCountsByBoard'] });
    void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
    void queryClient.invalidateQueries({ queryKey: ['profileStats'] });
    void queryClient.invalidateQueries({ queryKey: ['logbook'] });
    // Returned so the mutation waits for it: the climb's history decides Flash
    // vs Send, and a stale one would offer a second Flash right after a log.
    return queryClient.invalidateQueries({ queryKey: ['climbTicks', boardType, climbUuid] });
  };
}

export function useSaveTick() {
  const refresh = useRefreshTickViews();
  return useMutation({
    mutationFn: async (input: SaveTickInput) =>
      (await graphqlRequest<SaveTickMutationResponse>(SAVE_TICK, { input })).saveTick,
    onSuccess: (_tick, input) => refresh(input.boardType, input.climbUuid),
  });
}

export function useDeleteTick() {
  const refresh = useRefreshTickViews();
  return useMutation({
    mutationFn: async (input: { uuid: string; boardType: string; climbUuid: string }) =>
      (await graphqlRequest<DeleteTickMutationResponse>(DELETE_TICK, { uuid: input.uuid })).deleteTick,
    onSuccess: (_deleted, input) => refresh(input.boardType, input.climbUuid),
  });
}
