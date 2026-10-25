import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Client } from '@boardsesh/graphql-client';
import { NOTIFICATION_RECEIVED_SUBSCRIPTION } from '@boardsesh/graphql/operations/notifications';
import { getConnectivitySnapshot, subscribeConnectivity } from '../lib/connectivity/connectivity-store';
import { getWsClient } from '../lib/graphql/ws-client';
import { subscribeWsClientDisposed } from '../lib/graphql/ws-client-lifecycle';

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
    // Offline mode disposes the client this stream runs on, and graphql-ws
    // never reconnects a disposed client. So the stream parks while Offline
    // mode is on and binds whatever client `getWsClient()` hands out when it
    // goes off, including on a launch that starts with it on (#6766). Only
    // Offline mode parks it: during a backend outage graphql-ws keeps its own
    // reconnect ladder on the live client.
    let cancelled = false;
    let boundClient: Client | null = null;
    let releaseStream: (() => void) | null = null;
    let deferredForOfflineMode = false;

    const release = () => {
      releaseStream?.();
      releaseStream = null;
      boundClient = null;
    };

    const start = () => {
      if (cancelled) return;
      if (getConnectivitySnapshot().offlineMode) {
        deferredForOfflineMode = true;
        return;
      }
      const client = getWsClient();
      boundClient = client;
      releaseStream = client.subscribe<{ notificationReceived: { notification: { type: string } } }>(
        { query: NOTIFICATION_RECEIVED_SUBSCRIPTION },
        {
          next: ({ data }) => {
            if (data?.notificationReceived.notification.type === 'spray_wall_detection_completed') refreshCompletion();
          },
          error: () => {},
          complete: () => {},
        },
      );
    };

    // Any other dispose (sign-out, a browser credential change) leaves the
    // stream released until this effect re-runs, as it did before.
    const unsubscribeClientDisposed = subscribeWsClientDisposed((disposedClient) => {
      if (cancelled || disposedClient !== boundClient) return;
      release();
      if (getConnectivitySnapshot().offlineMode) deferredForOfflineMode = true;
    });

    const unsubscribeConnectivity = subscribeConnectivity(() => {
      if (deferredForOfflineMode && !getConnectivitySnapshot().offlineMode) {
        deferredForOfflineMode = false;
        start();
      }
    });

    start();
    return () => {
      cancelled = true;
      unsubscribeClientDisposed();
      unsubscribeConnectivity();
      release();
    };
  }, [authenticated, accountId, refreshCompletion]);
  return refreshCompletion;
}
