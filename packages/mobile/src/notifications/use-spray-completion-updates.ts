import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NOTIFICATION_RECEIVED_SUBSCRIPTION } from '@boardsesh/graphql/operations/notifications';
import { getWsClient } from '../lib/graphql/ws-client';

/** Native and browser imports share live completion refreshes. */
export function useSprayCompletionUpdates(authenticated: boolean, accountId: string | null | undefined) {
  const queryClient = useQueryClient();
  const refreshCompletion = useCallback(() => {
    for (const key of ['myBoards', 'mySprayWalls', 'sprayImportProgress', 'spray-wall-detection', 'notifications']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);
  useEffect(() => {
    if (!authenticated) return;
    return getWsClient().subscribe<{ notificationReceived: { notification: { type: string } } }>(
      { query: NOTIFICATION_RECEIVED_SUBSCRIPTION },
      {
        next: ({ data }) => {
          if (data?.notificationReceived.notification.type === 'spray_wall_detection_completed') refreshCompletion();
        },
        error: () => {},
        complete: () => {},
      },
    );
  }, [authenticated, accountId, refreshCompletion]);
  return refreshCompletion;
}
