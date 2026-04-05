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
} from '@/app/lib/graphql/operations';
import type { BoardName } from '@/app/lib/types';
import type { LogbookEntry } from './use-logbook';

export interface DeleteTickOptions {
  uuid: string;
}

/**
 * Hook to delete a tick via GraphQL mutation.
 * Provides optimistic updates to the logbook cache.
 */
export function useDeleteTick(boardName: BoardName) {
  const { token } = useWsAuthToken();
  const { status: sessionStatus } = useSession();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: DeleteTickOptions) => {
      if (sessionStatus !== 'authenticated') {
        throw new Error('Not authenticated');
      }
      if (!token) {
        throw new Error('Auth token not available');
      }

      const client = createGraphQLHttpClient(token);
      const variables: DeleteTickMutationVariables = {
        input: { uuid: options.uuid },
      };

      const response = await client.request<DeleteTickMutationResponse>(DELETE_TICK, variables);
      return response.deleteTick;
    },
    onMutate: async (options) => {
      await queryClient.cancelQueries({ queryKey: ['logbook', boardName] });

      // Snapshot for rollback
      const previousData = queryClient.getQueriesData<LogbookEntry[]>({ queryKey: ['logbook', boardName] });

      // Optimistically remove the entry
      queryClient.setQueriesData<LogbookEntry[]>(
        { queryKey: ['logbook', boardName] },
        (old) => old?.filter((entry) => entry.uuid !== options.uuid),
      );

      return { previousData };
    },
    onError: (err, _options, context) => {
      // Rollback
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          if (data) queryClient.setQueryData(key, data);
        }
      }

      let errorMessage = 'Failed to delete ascent';
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
    onSuccess: () => {
      showMessage('Ascent deleted', 'success');
    },
  });
}
