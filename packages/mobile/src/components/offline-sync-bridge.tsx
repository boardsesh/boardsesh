import { useEffect, useMemo } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { startSyncScheduler } from '../sync';
import { drainMutationQueue } from '../mutation-queue';
import type { GraphQLFetch } from '../mutation-queue/handlers';
import { getSetting } from '../settings';
import { setupNotificationHandlers } from '../notifications';
import { getHttpClient } from '../lib/graphql/client';

/**
 * Headless bridge that turns the offline machinery on while the user is signed
 * in. It lives in the authenticated subtree (next to PersistentQueueBar), so it
 * mounts only after auth + the SQLiteProvider are ready and unmounts on
 * sign-out, which tears the scheduler and notification listeners back down.
 *
 * Renders nothing. Every effect is wrapped so a failure here (a bad sync
 * trigger, a listener that can't attach) is logged in dev but never crashes the
 * host app — offline sync is best-effort and must not take the UI down with it.
 */
export function OfflineSyncBridge() {
  const db = useSQLiteContext();
  const queryClient = useQueryClient();

  // getHttpClient() already carries auth + endpoint; binding .request keeps the
  // GraphQLFetch shape the scheduler and drainer expect.
  const graphqlFetch = useMemo<GraphQLFetch>(() => (query, variables) => getHttpClient().request(query, variables), []);

  // Push-then-pull sync loop (foreground + reconnect triggers). Returns its own
  // teardown, so React calls it on unmount / dependency change.
  useEffect(() => {
    try {
      const stop = startSyncScheduler(
        db,
        queryClient,
        graphqlFetch,
        () => getSetting('syncEnabledBoards'),
        () => drainMutationQueue(db, queryClient, graphqlFetch),
      );
      return stop;
    } catch (error) {
      if (__DEV__) {
        console.warn('[OfflineSyncBridge] failed to start sync scheduler:', error);
      }
      return undefined;
    }
  }, [db, queryClient, graphqlFetch]);

  // Deep-link routing for tapped push notifications.
  useEffect(() => {
    try {
      const cleanup = setupNotificationHandlers(router);
      return cleanup;
    } catch (error) {
      if (__DEV__) {
        console.warn('[OfflineSyncBridge] failed to set up notification handlers:', error);
      }
      return undefined;
    }
  }, []);

  return null;
}
