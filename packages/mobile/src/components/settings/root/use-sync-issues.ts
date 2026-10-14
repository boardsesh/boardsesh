import { useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getDeadLetterCount, getDeadLetters, retryDeadLetter, type GraphQLFetch } from '@boardsesh/offline-sync';
import { useOfflineDatabase } from '../../../db/use-offline-database';
import { useOfflineSchemaReady } from '../../../db/use-offline-schema-ready';
import { useConnectivity } from '../../../lib/connectivity/use-connectivity';
import { reportError } from '../../../lib/error-reporting';
import { getHttpClient } from '../../../lib/graphql/client';
import { hapticLight } from '../../../lib/haptics';
import { drainMutationQueue } from '../../../offline/offline-sync-adapter';
import { notifyOutboxChanged } from '../../../offline/outbox-store';
import { useOfflineDownloadsEnabled } from '../../../providers/feature-flags-provider';
import type { SyncIssuesSectionInput } from './sync-issues-section';

export type SyncIssues = { count: number; retry: () => Promise<void> };

/**
 * Writes that are stuck failing, for the "Sync issues" alert on the Settings
 * root and the Account page.
 *
 * Polls the dead-letter count only while online: offline, a pending write is
 * expected, not a stuck one. A dead-lettered write is one the server rejected,
 * or one that failed past its retry budget while reachable, so it is worth
 * surfacing with a retry (never a discard).
 *
 * Returns `null` when there is nothing to say.
 */
export function useSyncIssues(): SyncIssues | null {
  const offlineEnabled = useOfflineDownloadsEnabled();
  // Not `useSQLiteContext()` directly: the retry below DRAINS the outbox, and on
  // a database a newer bundle migrated that must be refused, not attempted
  // (src/db/refused-database).
  const db = useOfflineDatabase();
  // Handed out as soon as the launch gate opens, after the first init attempt
  // whatever it did, so on a contended launch it has no tables yet. The read
  // folds readiness into its KEY rather than gating on it: a failed read shows
  // nothing (the right answer), and a late flip refetches, whereas gating would
  // spin forever whenever init genuinely fails.
  const schemaReady = useOfflineSchemaReady();
  const queryClient = useQueryClient();
  // `effectiveOffline` covers no signal, our backend being unreachable, and
  // Offline mode alike: "nothing is going out right now".
  const { effectiveOffline } = useConnectivity();
  const { data: deadLetterCount = 0, refetch: refetchDeadLetters } = useQuery({
    queryKey: ['deadLetters', 'count', schemaReady],
    queryFn: () => getDeadLetterCount(db),
    enabled: !effectiveOffline,
    // Dead letters are sticky (they don't resolve without a Retry), so a slow
    // poll is plenty. With the offline flag off there is still ONE initial fetch
    // (never a recurring poll): legacy dead letters queued while the flag was on
    // must stay reachable through Retry.
    refetchInterval: offlineEnabled ? 30000 : false,
  });

  // Guard against a rapid double tap spawning overlapping retries (the drain is
  // single-flight internally, but this avoids the wasted re-entrant work).
  const retryingRef = useRef(false);
  const retry = useCallback(async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    try {
      const deadLetters = await getDeadLetters(db);
      // Reset each dead letter on its own: one bad entry must not stop the rest
      // from being retried (a shared try would abort the loop on the first throw).
      for (const deadLetter of deadLetters) {
        try {
          await retryDeadLetter(db, deadLetter.id);
        } catch (error) {
          reportError(error);
        }
      }
      const graphqlFetch: GraphQLFetch = (query, variables) => getHttpClient().request(query, variables);
      await drainMutationQueue(db, queryClient, graphqlFetch);
      // The drain just changed what is in the outbox, and nothing else tells the
      // pending summary that; without this its footer keeps quoting the count
      // from before the retry.
      notifyOutboxChanged();
    } catch (error) {
      reportError(error);
    } finally {
      retryingRef.current = false;
      void refetchDeadLetters();
    }
  }, [db, queryClient, refetchDeadLetters]);

  return useMemo(
    () => (effectiveOffline || deadLetterCount === 0 ? null : { count: deadLetterCount, retry }),
    [effectiveOffline, deadLetterCount, retry],
  );
}

/**
 * `useSyncIssues`, shaped for `buildSyncIssuesSection`: the Retry row's tap, with
 * its haptic. Shared by every page that shows the alert, so they can't drift.
 */
export function useSyncIssuesSection(): SyncIssuesSectionInput | null {
  const syncIssues = useSyncIssues();
  return useMemo(
    () =>
      syncIssues
        ? {
            count: syncIssues.count,
            onRetry: () => {
              hapticLight();
              void syncIssues.retry();
            },
          }
        : null,
    [syncIssues],
  );
}
