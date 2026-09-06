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
  type SaveTickMutationResponse,
  type SaveTickMutationVariables,
} from '@boardsesh/graphql/operations';
import { useAuth } from './auth-provider';
import { useOfflineDownloadsEnabled } from './feature-flags-provider';
import { useQueueSessionId } from './queue-provider';
import { useToast } from './toast-provider';
import { getDatabaseHandle } from '../db';
import { getConnectivitySnapshot, subscribeConnectivity } from '../lib/connectivity/connectivity-store';
import { getHttpClient } from '../lib/graphql/client';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { reportHandledError } from '../lib/error-reporting';
import { getWsClient } from '../lib/graphql/ws-client';
import { drainMutationQueue, isOnline, subscribeMutationDelivery } from '../offline/offline-sync-adapter';
import { enqueueTickOutboxOnly, writeTickLocal } from '../hooks/use-offline-mutations';
import { isDatabaseLockedError, OFFLINE_LOCAL_WRITE_BUDGET_MS } from '@boardsesh/offline-sync';
import { SHARED_EVENTS, sanitizeErrorForAnalytics } from '@boardsesh/analytics';
import { track } from '../lib/analytics';

/**
 * The saved-tick shape useSaveTick writes into its logbook cache. Identical on
 * the normal offline save and on the degraded (outbox-only) one — the tick is
 * queued either way, so the in-session UI must not be able to tell them apart.
 */
function toSavedTickShape(
  input: SaveTickMutationVariables['input'],
  tickUuid: string,
): SaveTickMutationResponse['saveTick'] {
  return {
    uuid: tickUuid,
    climbUuid: input.climbUuid,
    angle: input.angle,
    isMirror: input.isMirror,
    status: input.status,
    attemptCount: input.attemptCount,
    quality: input.quality ?? null,
    difficulty: input.difficulty ?? null,
    comment: input.comment,
    climbedAt: input.climbedAt,
  };
}

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
        // Live stats need a reachable backend. While the connectivity store
        // says we're effectively offline, a (re)subscribe can only fail, and
        // the exponential ladder below would keep waking the socket against a
        // server we know is down (#4862). Park it on this flag instead and let
        // the store's edge back to reachable restart it.
        let deferredForConnectivity = false;

        const scheduleRetry = () => {
          if (disposed || retryTimer) return;
          // Don't arm a timer during an outage — the connectivity listener
          // below is a better wake-up than a 30s ladder that can only fail.
          if (getConnectivitySnapshot().effectiveOffline) {
            deferredForConnectivity = true;
            return;
          }
          const delayMs = Math.min(30_000, 1_000 * 2 ** retryAttempt);
          retryAttempt += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            startSubscription();
          }, delayMs);
        };
        const startSubscription = () => {
          if (disposed) return;
          if (getConnectivitySnapshot().effectiveOffline) {
            deferredForConnectivity = true;
            return;
          }
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
        // One resubscribe per outage, on the edge back to reachable: the flag
        // gates it, so the store's other snapshot changes can't re-enter here.
        // `retryAttempt` resets so the first post-outage failure retries fast
        // rather than inheriting the pre-outage ladder position.
        const unsubscribeConnectivity = subscribeConnectivity(() => {
          if (deferredForConnectivity && !getConnectivitySnapshot().effectiveOffline) {
            deferredForConnectivity = false;
            retryAttempt = 0;
            startSubscription();
          }
        });
        startSubscription();
        return () => {
          disposed = true;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          unsubscribeStats?.();
          unsubscribeConnected();
          unsubscribeConnectivity();
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
            // Stamp the id EVERY delivery path will carry, before the first
            // write. The server's saveTick dedupes on SaveTickInput.uuid and
            // returns the existing row for a repeat, so the local write, the
            // queued replay and useSaveTick's network fall-through all resolve
            // to one tick. Without it, a transaction that committed its outbox
            // row and still threw (a SQLITE_BUSY surfacing at COMMIT) would
            // queue the send AND post a second, differently-identified one.
            variables.input.uuid = tickUuid;
            // One deadline for both ladders, so the retry and the fallback
            // together can never block the log-ascent sheet past the budget.
            const deadline = Date.now() + OFFLINE_LOCAL_WRITE_BUDGET_MS;
            try {
              await writeTickLocal(db, variables.input, tickUuid, OFFLINE_LOCAL_WRITE_BUDGET_MS);
            } catch (error) {
              // The retry ladder is spent. Try the strictly smaller write: the
              // outbox row alone. A queued mutation replays from its payload, so
              // that row is enough for the send to reach the server — the local
              // `boardsesh_ticks` row only serves LOCAL reads.
              //
              // What the user gives up when this branch wins: no local tick row,
              // so (a) the "waiting to sync" badge does not light on that climb,
              // and (b) if the app is killed while still offline, the tick is
              // missing from the local logbook until the drain lands it and the
              // pull brings the server row back down. Both are strictly better
              // than losing the send, and both self-heal.
              const wasOffline = !isOnline();
              const isLockError = isDatabaseLockedError(error);
              let queued = false;
              let fallbackError: unknown = null;
              try {
                await enqueueTickOutboxOnly(db, variables.input, tickUuid, Math.max(0, deadline - Date.now()));
                queued = true;
              } catch (caught) {
                fallbackError = caught;
                if (__DEV__) {
                  console.warn('[BoardAdapter] outbox-only tick fallback failed:', caught);
                }
              }

              // `wasOffline` splits "fell through and landed" from "fell through
              // and the tick is gone" — the only version that actually loses
              // data. `isLockError` says whether it was write-lock contention
              // (#4314) or a genuinely broken database, which need completely
              // different fixes. The reported error object and the `kind` tag are
              // the ORIGINAL ones on purpose, so the existing 90-day Sentry trend
              // stays comparable and does not fork on this change.
              reportHandledError(error, {
                tags: {
                  source: 'offline-sync',
                  kind: 'tick-local-write',
                  was_offline: wasOffline,
                  is_lock_error: isLockError,
                  outcome: queued ? 'queued' : 'fell_through',
                },
                extra: {
                  errorMessage: error instanceof Error ? error.message : String(error),
                  fallbackErrorMessage:
                    fallbackError === null
                      ? null
                      : fallbackError instanceof Error
                        ? fallbackError.message
                        : String(fallbackError),
                },
              });
              // Exactly one per failed local write, on both exits.
              track(SHARED_EVENTS.OfflineTickLocalWriteFailed, {
                isLockError,
                wasOffline,
                error: sanitizeErrorForAnalytics(error),
                outcome: queued ? 'queued' : 'fell_through',
              });

              // Nothing queued: fall through to the direct network save, which
              // now carries the stamped uuid so it cannot double-deliver.
              if (!queued) return null;

              // Deliberately NO invalidateQueries(['localTicks', …]) here: with no
              // local tick row the badge query's JOIN returns 0 either way, so it
              // would be a no-op that reads as intent.
              void drainMutationQueue(db, queryClient, executeHttp).catch((drainError: unknown) => {
                if (__DEV__) {
                  console.warn('[BoardAdapter] degraded tick queue drain failed:', drainError);
                }
              });
              return toSavedTickShape(variables.input, tickUuid);
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

            return toSavedTickShape(variables.input, tickUuid);
          },
      // Mobile has no IndexedDB tick-draft store, so onTickSaved is omitted.
      showError: (reason) => showErrorRef.current?.(reason),
    }),
    [isAuthenticated, isLoading, offlineEnabled],
  );

  return <BoardAdapterProvider value={adapter}>{children}</BoardAdapterProvider>;
}
