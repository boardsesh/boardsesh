'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  UPDATE_TICK,
  type UpdateTickMutationVariables,
  type UpdateTickMutationResponse,
} from '@/app/lib/graphql/operations';
import type { BoardName } from '@/app/lib/types';
import type { TickStatus, LogbookEntry } from './use-logbook';

export interface UpdateTickOptions {
  uuid: string;
  status?: TickStatus;
  attemptCount?: number;
  quality?: number | null;
  comment?: string;
}

/**
 * Hook to update an existing tick via GraphQL mutation.
 * Provides optimistic updates to the logbook cache.
 */
export function useUpdateTick(boardName: BoardName) {
  const { token } = useWsAuthToken();
  const { status: sessionStatus } = useSession();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: UpdateTickOptions) => {
      if (sessionStatus !== 'authenticated') {
        throw new Error('Not authenticated');
      }
      if (!token) {
        throw new Error('Auth token not available');
      }

      const client = createGraphQLHttpClient(token);
      const variables: UpdateTickMutationVariables = {
        input: {
          uuid: options.uuid,
          status: options.status,
          attemptCount: options.attemptCount,
          quality: options.quality,
          comment: options.comment,
        },
      };

      const response = await client.request<UpdateTickMutationResponse>(UPDATE_TICK, variables);
      return response.updateTick;
    },
    onMutate: async (options) => {
      await queryClient.cancelQueries({ queryKey: ['logbook', boardName] });

      // Snapshot current cache for rollback
      const previousData = queryClient.getQueriesData<LogbookEntry[]>({ queryKey: ['logbook', boardName] });

      // Optimistically update the entry
      queryClient.setQueriesData<LogbookEntry[]>(
        { queryKey: ['logbook', boardName] },
        (old) =>
          old?.map((entry) => {
            if (entry.uuid !== options.uuid) return entry;
            const newStatus = options.status ?? entry.status;
            return {
              ...entry,
              status: newStatus,
              tries: options.attemptCount ?? entry.tries,
              quality: options.quality !== undefined ? options.quality : entry.quality,
              comment: options.comment !== undefined ? options.comment : entry.comment,
              is_ascent: newStatus === 'flash' || newStatus === 'send',
            };
          }),
      );

      return { previousData };
    },
    onError: (err, _options, context) => {
      // Rollback optimistic update
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          if (data) queryClient.setQueryData(key, data);
        }
      }

      let errorMessage = 'Failed to update ascent';
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
      showMessage('Ascent updated', 'success');
    },
  });
}
