'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  DELETE_TICK,
  type DeleteTickMutationVariables,
  type DeleteTickMutationResponse,
} from '@boardsesh/graphql/operations';

/**
 * Hook to delete a tick (logbook entry) via GraphQL mutation.
 * Invalidates relevant caches on success.
 */
export function useDeleteTick() {
  const { token } = useWsAuthToken();
  const { status: sessionStatus } = useSession();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (uuid: string) => {
      if (sessionStatus !== 'authenticated') {
        throw new Error('Not authenticated');
      }
      if (!token) {
        throw new Error('Auth token not available');
      }

      const client = createGraphQLHttpClient(token);
      const variables: DeleteTickMutationVariables = { uuid };
      const response = await client.request<DeleteTickMutationResponse>(DELETE_TICK, variables);
      return response.deleteTick;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ascentsFeed'] });
      queryClient.removeQueries({ queryKey: ['logbook'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionDetail'] });
      // A deleted tick changes what a workout's blocks came to (#6903).
      void queryClient.invalidateQueries({ queryKey: ['sessionWorkouts'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionWorkoutHeadlines'] });
      void queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
      void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
      void queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });
    },
    onError: (err) => {
      let errorMessage = 'Failed to delete tick';
      if (err instanceof Error) {
        if ('response' in err && typeof err.response === 'object' && err.response !== null) {
          const response = err.response as { errors?: Array<{ message: string }> };
          if (response.errors && response.errors.length > 0) {
            errorMessage = response.errors[0].message;
          }
        } else {
          errorMessage = err.message;
        }
      }
      showMessage(errorMessage, 'error');
    },
  });
}
