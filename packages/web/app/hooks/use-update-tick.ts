'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  UPDATE_TICK,
  type UpdateTickResponse,
  type UpdateTickVariables,
  type UpdateTickInput,
} from '@/app/lib/graphql/operations';
import type { AscentFeedItem } from '@/app/lib/graphql/operations/ticks';
import { mergeIntoAscentsFeed, mergeIntoLogbookFeed } from './use-tick-feed-cache';

export type UpdateTickOptions = {
  uuid: string;
  input: UpdateTickInput;
};

/**
 * Hook to update a tick (logbook entry) via GraphQL mutation.
 * Refreshes feed/logbook-related caches after a successful edit.
 */
export function useUpdateTick() {
  const { token } = useWsAuthToken();
  const { status: sessionStatus } = useSession();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ uuid, input }: UpdateTickOptions) => {
      if (sessionStatus !== 'authenticated') {
        throw new Error('Not authenticated');
      }
      if (!token) {
        throw new Error('Auth token not available');
      }

      const client = createGraphQLHttpClient(token);
      const variables: UpdateTickVariables = { uuid, input };
      const response = await client.request<UpdateTickResponse, UpdateTickVariables>(UPDATE_TICK, variables);
      return response.updateTick;
    },
    onSuccess: (updatedTick) => {
      // Merge the edited fields directly into every cached feed row that holds
      // this tick uuid. The persister picks up the new shape on its next throttled
      // dehydrate, so the change survives a reload without a refetch.
      const patch: Partial<AscentFeedItem> = {
        status: updatedTick.status as AscentFeedItem['status'],
        attemptCount: updatedTick.attemptCount,
        quality: updatedTick.quality,
        difficulty: updatedTick.difficulty,
        isBenchmark: updatedTick.isBenchmark,
        comment: updatedTick.comment,
      };
      mergeIntoLogbookFeed(queryClient, updatedTick.uuid, patch);
      mergeIntoAscentsFeed(queryClient, updatedTick.uuid, patch);

      // Aggregates we can't recompute locally — let them refetch.
      void queryClient.invalidateQueries({ queryKey: ['sessionDetail'] });
      void queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
      void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
      void queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });
      queryClient.removeQueries({ queryKey: ['logbook'] });
      showMessage('Tick updated', 'success');
    },
    onError: (err) => {
      let errorMessage = 'Failed to update tick';
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
