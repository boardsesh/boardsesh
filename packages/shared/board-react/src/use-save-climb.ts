import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SAVE_CLIMB_MUTATION,
  SAVE_MOONBOARD_CLIMB_MUTATION,
  UPDATE_CLIMB_MUTATION,
  type SaveClimbMutationVariables,
  type SaveClimbMutationResponse,
  type SaveMoonBoardClimbMutationVariables,
  type SaveMoonBoardClimbMutationResponse,
  type UpdateClimbMutationVariables,
  type UpdateClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import type { BoardName, UpdateClimbInput } from '@boardsesh/shared-schema';
import { useBoardAdapter } from './adapter';
import {
  isDuplicateClimbError,
  toSaveClimbInput,
  toSaveMoonBoardClimbInput,
  type SaveClimbOptions,
  type SaveClimbResponse,
  type SaveMoonBoardClimbOptions,
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
 * Save a new MoonBoard climb via GraphQL WS mutation. Create-only: MoonBoard
 * has no in-place update path (holds are grid coordinates, not a frames string
 * `updateClimb` can re-encode), so re-saving always creates a new row — the
 * backend duplicate check catches genuine collisions. Auth-gated; throws on
 * unauthenticated callers (plain `Error`; shared code can't reach platform
 * i18n). Duplicate-publish rejections are left for the caller's inline UX.
 */
export function useSaveMoonBoardClimb() {
  const { isAuthenticated, executeWs, showError } = useBoardAdapter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: SaveMoonBoardClimbOptions): Promise<SaveClimbResponse> => {
      if (!isAuthenticated) {
        throw new Error('Authentication required to create climbs');
      }

      const variables: SaveMoonBoardClimbMutationVariables = { input: toSaveMoonBoardClimbInput(options) };
      const result = await executeWs<SaveMoonBoardClimbMutationResponse, SaveMoonBoardClimbMutationVariables>({
        query: SAVE_MOONBOARD_CLIMB_MUTATION,
        variables,
      });
      return result.saveMoonBoardClimb;
    },
    onSuccess: () => {
      // A new MoonBoard climb may appear in search and "my climbs" lists.
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['climb'] });
      void queryClient.invalidateQueries({ queryKey: ['myClimbs'] });
    },
    onError: (err) => {
      // The form-level UI renders inline guidance for duplicates, so suppress
      // the generic toast and let the caller handle it.
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
