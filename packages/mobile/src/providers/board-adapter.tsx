// Mobile-side wiring for `@boardsesh/board-react`. Reads platform-specific
// state (auth, queue session id) and forwards GraphQL operations through
// mobile's HTTP / WS clients. Mounted in `app/_layout.tsx` between
// QueueProvider and BoardProvider.

import { useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import { BoardAdapterProvider, type BoardAdapter } from '@boardsesh/board-react';
import { execute } from '@boardsesh/graphql-client';
import {
  CLIMB_STATS_FOR_CLIMBS,
  CLIMB_STATS_UPDATED_SUBSCRIPTION,
  type ClimbStatsForClimbsResponse,
  type ClimbStatsUpdatedSubscriptionResponse,
} from '@boardsesh/graphql/operations';
import { useAuth } from './auth-provider';
import { useOfflineDownloadsEnabled } from './feature-flags-provider';
import { useQueueSessionId } from './queue-provider';
import { useToast } from './toast-provider';
import { getDatabaseHandle } from '../db';
import { getHttpClient } from '../lib/graphql/client';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { reportHandledError } from '../lib/error-reporting';
import { getWsClient } from '../lib/graphql/ws-client';
import { drainMutationQueue, isOnline, subscribeMutationDelivery } from '../offline/offline-sync-adapter';
import { writeTickLocal } from '../hooks/use-offline-mutations';
import { isDatabaseLockedError } from '@boardsesh/offline-sync';
import { SHARED_EVENTS, sanitizeErrorForAnalytics } from '@boardsesh/analytics';
import { track } from '../lib/analytics';

export function BoardAdapterWrapper({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const offlineEnabled = useOfflineDownloadsEnabled();
  const { sessionId } = useQueueSessionId();
  const { showToast } = useToast();
  const { t } = useTranslation('climbs');

  // sessionId lives behind a ref so `resolveActiveSessionId` always returns
  // the latest value at mutation time, without re-rendering the adapter on
  // every queue update (which would churn the context value).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // showToast and t change identity whenever the toast provider or i18n
  // locale re-renders. Reading them at call time via a ref keeps the
  // adapter's context value stable (so subtree consumers don't re-render
  // on every locale flip) while still picking up the latest references.
  const showErrorRef = useRef<BoardAdapter['showError']>(undefined);
  showErrorRef.current = () => {
    // Both reasons share the same fallback copy on mobile today. Switch
    // here if/when reason-specific messages are needed.
    showToast(t('createClimbForm.alerts.saveFailedFallback'), 'error');
  };

  const adapter = useMemo<BoardAdapter>(
    () => ({
      isAuthenticated,
      isAuthLoading: isLoading,
      executeHttp: (query, variables) => getHttpClient().request(query, variables),
      executeWs: ({ query, variables }) => execute(getWsClient(), { query, variables }),
      resolveActiveSessionId: () => sessionIdRef.current,
      captureAuthEpoch: captureAuthCredentialGeneration,
      isAuthEpochCurrent: isAuthCredentialGenerationCurrent,
      supportsClimbStatsOptimism: true,
      fetchClimbStatsForClimbs: async (boardType, climbUuids) => {
        const response = await getHttpClient().request<ClimbStatsForClimbsResponse>(CLIMB_STATS_FOR_CLIMBS, {
          boardName: boardType,
          climbUuids,
        });
        return response.climbStatsForClimbs;
      },
      subscribeClimbStats: (boardType, layoutId, handlers) => {
        const wsClient = getWsClient();
        let disposed = false;
        let retryAttempt = 0;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribeStats: (() => void) | null = null;

        const scheduleRetry = () => {
          if (disposed || retryTimer) return;
          const delayMs = Math.min(30_000, 1_000 * 2 ** retryAttempt);
          retryAttempt += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            startSubscription();
          }, delayMs);
        };
        const startSubscription = () => {
          if (disposed) return;
          unsubscribeStats = wsClient.subscribe<ClimbStatsUpdatedSubscriptionResponse>(
            {
              query: CLIMB_STATS_UPDATED_SUBSCRIPTION,
              variables: { boardType, layoutId },
            },
            {
              next: (result) => {
                retryAttempt = 0;
                const event = result.data?.climbStatsUpdated;
                if (event) handlers.next(event);
              },
              error: (error) => {
                unsubscribeStats = null;
                handlers.error(error);
                scheduleRetry();
              },
              complete: () => {
                unsubscribeStats = null;
                scheduleRetry();
              },
            },
          );
        };
        const unsubscribeConnected = wsClient.on('connected', handlers.connected);
        startSubscription();
        return () => {
          disposed = true;
          if (retryTimer) clearTimeout(retryTimer);
          unsubscribeStats?.();
          unsubscribeConnected();
        };
      },
      subscribeOfflineMutationDelivery: subscribeMutationDelivery,
      scheduleTask: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
      // Undefined when the offline flag is off: useSaveTick optional-chains it
      // and falls through to the direct network save — pre-offline behavior.
      saveTickOffline: !offlineEnabled
        ? undefined
        : async (variables, { queryClient, executeHttp }) => {
            const db = getDatabaseHandle();
            if (!db) return null;

            const tickUuid = randomUUID();
            try {
              await writeTickLocal(db, variables.input, tickUuid);
            } catch (error) {
              // A broken local DB (disk full, corruption) must not block the tick:
              // returning null falls through to the direct network save in
              // useSaveTick. Offline, that network attempt fails visibly — same
              // outcome as today — but online the send still lands.
              //
              // The two dimensions on the report are what the Sentry trend alone
              // could never answer. `wasOffline` splits "fell through and landed"
              // from "fell through and the tick is gone" — the only version of
              // this failure that actually loses data. `isLockError` says whether
              // it was write-lock contention (the snapshot import holding a long
              // EXCLUSIVE, #4314) or a genuinely broken database, which need
              // completely different fixes. The `kind` tag is unchanged on
              // purpose so the existing 90-day trend stays comparable.
              const wasOffline = !isOnline();
              const isLockError = isDatabaseLockedError(error);
              reportHandledError(error, {
                tags: {
                  source: 'offline-sync',
                  kind: 'tick-local-write',
                  was_offline: wasOffline,
                  is_lock_error: isLockError,
                },
                extra: { errorMessage: error instanceof Error ? error.message : String(error) },
              });
              track(SHARED_EVENTS.OfflineTickLocalWriteFailed, {
                isLockError,
                wasOffline,
                error: sanitizeErrorForAnalytics(error),
              });
              return null;
            }
            // Wake the "waiting to sync" badge immediately: its query caches with
            // staleTime Infinity and the drainer (its usual invalidator) no-ops
            // while offline — without this, an offline tick looks lost.
            void queryClient.invalidateQueries({ queryKey: ['localTicks', variables.input.climbUuid] });
            void drainMutationQueue(db, queryClient, executeHttp).catch((error: unknown) => {
              if (__DEV__) {
                console.warn('[BoardAdapter] tick queue drain failed:', error);
              }
            });

            return {
              uuid: tickUuid,
              climbUuid: variables.input.climbUuid,
              angle: variables.input.angle,
              isMirror: variables.input.isMirror,
              status: variables.input.status,
              attemptCount: variables.input.attemptCount,
              quality: variables.input.quality ?? null,
              difficulty: variables.input.difficulty ?? null,
              comment: variables.input.comment,
              climbedAt: variables.input.climbedAt,
            };
          },
      // Mobile has no IndexedDB tick-draft store, so onTickSaved is omitted.
      showError: (reason) => showErrorRef.current?.(reason),
    }),
    [isAuthenticated, isLoading, offlineEnabled],
  );

  return <BoardAdapterProvider value={adapter}>{children}</BoardAdapterProvider>;
}
