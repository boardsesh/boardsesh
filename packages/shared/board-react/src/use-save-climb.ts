import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SAVE_CLIMB_MUTATION,
  SAVE_MOONBOARD_CLIMB_MUTATION,
  UPDATE_CLIMB_MUTATION,
  UPDATE_MOONBOARD_CLIMB_MUTATION,
  type SaveClimbMutationVariables,
  type SaveClimbMutationResponse,
  type SaveMoonBoardClimbMutationVariables,
  type SaveMoonBoardClimbMutationResponse,
  type UpdateClimbMutationVariables,
  type UpdateClimbMutationResponse,
  type UpdateMoonBoardClimbMutationVariables,
  type UpdateMoonBoardClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import type {
  BoardName,
  SaveMoonBoardClimbInput,
  UpdateClimbInput,
  UpdateMoonBoardClimbInput,
} from '@boardsesh/shared-schema';
import { useBoardAdapter } from './adapter';
import {
  isDuplicateClimbError,
  toSaveClimbInput,
  type SaveClimbOptions,
  type SaveClimbResponse,
  type UpdateClimbResponse,
} from './climb-helpers';

/**
 * Save a new climb via GraphQL WS mutation. Auth-gated; throws on
 * unauthenticated or no-board callers (kept as plain `Error` because
 * shared code can't reach platform i18n). Caller-side `onError` is
 * recommended for user-facing feedback; the adapter's `showError` is the
 * generic fallback toast.
 */
export function useSaveClimb(boardName: BoardName | null) {
  const { isAuthenticated, executeWs, showError } = useBoardAdapter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: SaveClimbOptions): Promise<SaveClimbResponse> => {
      if (!isAuthenticated) {
        throw new Error('Authentication required to create climbs');
      }
      if (!boardName) {
        throw new Error('No board selected');
      }

      const variables: SaveClimbMutationVariables = { input: toSaveClimbInput(boardName, options) };
      const result = await executeWs<SaveClimbMutationResponse, SaveClimbMutationVariables>({
        query: SAVE_CLIMB_MUTATION,
        variables,
      });
      return result.saveClimb;
    },
    onSuccess: () => {
      // A new climb may appear in search results and "my climbs" lists.
      // Bust those so the freshly published climb shows up without a manual
      // reload. Climb-detail caches are also touched in case a user
      // pre-fetched the detail page (e.g. via deep link) before publishing.
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['climb'] });
      void queryClient.invalidateQueries({ queryKey: ['myClimbs'] });
    },
    onError: (err) => {
      // Duplicate-publish rejections render a richer inline UX at the form
      // level, so suppress the generic toast and let the caller handle it.
      if (isDuplicateClimbError(err)) return;
      showError?.('saveClimbFailed');
    },
  });
}

/**
 * Update an existing climb. Only the owner may call this, and only while
 * the climb is still a draft or within 24h of first publish — backend
 * enforces both rules.
 */
export function useUpdateClimb() {
  const { isAuthenticated, executeWs, showError } = useBoardAdapter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateClimbInput): Promise<UpdateClimbResponse> => {
      if (!isAuthenticated) {
        throw new Error('Authentication required to update climbs');
      }

      const variables: UpdateClimbMutationVariables = { input };
      const result = await executeWs<UpdateClimbMutationResponse, UpdateClimbMutationVariables>({
        query: UPDATE_CLIMB_MUTATION,
        variables,
      });
      return result.updateClimb;
    },
    onSuccess: (result) => {
      // Refresh the climb's detail cache and any list it appears in.
      void queryClient.invalidateQueries({ queryKey: ['climb', result.uuid] });
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['myClimbs'] });
    },
    onError: () => {
      showError?.('updateClimbFailed');
    },
  });
}

export function useSaveMoonBoardClimb() {
  const { isAuthenticated, executeWs, showError } = useBoardAdapter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveMoonBoardClimbInput): Promise<SaveClimbResponse> => {
      if (!isAuthenticated) throw new Error('Authentication required to create climbs');
      const variables: SaveMoonBoardClimbMutationVariables = { input };
      const result = await executeWs<SaveMoonBoardClimbMutationResponse, SaveMoonBoardClimbMutationVariables>({
        query: SAVE_MOONBOARD_CLIMB_MUTATION,
        variables,
      });
      return result.saveMoonBoardClimb;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['climb'] });
      void queryClient.invalidateQueries({ queryKey: ['myClimbs'] });
    },
    onError: (error) => {
      if (!isDuplicateClimbError(error)) showError?.('saveClimbFailed');
    },
  });
}

export function useUpdateMoonBoardClimb() {
  const { isAuthenticated, executeWs, showError } = useBoardAdapter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateMoonBoardClimbInput): Promise<UpdateClimbResponse> => {
      if (!isAuthenticated) throw new Error('Authentication required to update climbs');
      const variables: UpdateMoonBoardClimbMutationVariables = { input };
      const result = await executeWs<UpdateMoonBoardClimbMutationResponse, UpdateMoonBoardClimbMutationVariables>({
        query: UPDATE_MOONBOARD_CLIMB_MUTATION,
        variables,
      });
      return result.updateMoonBoardClimb;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['climb', result.uuid] });
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['myClimbs'] });
    },
    onError: (error) => {
      if (!isDuplicateClimbError(error)) showError?.('updateClimbFailed');
    },
  });
}
