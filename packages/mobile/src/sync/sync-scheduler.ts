import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';
import { pullSync } from './pull-client';

const FOREGROUND_DEBOUNCE_MS = 2000;

type GraphqlFetch = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/**
 * Pushes any locally-queued mutations to the server. Threaded in by the caller
 * (typically `drainMutationQueue` bound to the live db/queryClient/fetch) so the
 * scheduler can flush local writes before pulling server state. Returns a
 * promise that resolves when the drain attempt finishes; rejection is tolerated
 * (the next trigger retries).
 */
export type DrainQueue = () => Promise<void>;

let isSyncing = false;
let pendingTrigger = false;

export function __resetSyncSchedulerStateForTests(): void {
  isSyncing = false;
  pendingTrigger = false;
}

// Each cycle does drain-first (push local mutations) then pull (fetch server
// state), so a write that failed to send is reattempted on every sync trigger
// — not just on the next user write (B12). Single-flight: concurrent triggers
// collapse into one in-flight run plus at most one queued follow-up.
async function runSync(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
): Promise<void> {
  if (isSyncing) {
    pendingTrigger = true;
    return;
  }

  isSyncing = true;
  try {
    // Push first so the subsequent pull reflects our own just-flushed writes.
    await drainQueue();
    await pullSync(db, queryClient, graphqlFetch, {
      enabledBoards: getEnabledBoards(),
    });
  } catch (error) {
    console.warn('[Sync] Sync cycle failed:', error instanceof Error ? error.message : 'unknown');
  } finally {
    isSyncing = false;
    // I1: a trigger that arrived mid-run must still produce exactly one
    // follow-up run, even if the cycle above threw. The try/catch above
    // swallows cycle errors so we always reach here; consume the flag and
    // re-run once. (runSync is async, so it can't throw synchronously here.)
    if (pendingTrigger) {
      pendingTrigger = false;
      void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue);
    }
  }
}

export function triggerSync(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
): void {
  void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue);
}

export function startSyncScheduler(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
): () => void {
  let foregroundTimeout: ReturnType<typeof setTimeout> | null = null;
  let wasConnected = true;

  const appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      if (foregroundTimeout) clearTimeout(foregroundTimeout);
      foregroundTimeout = setTimeout(() => {
        foregroundTimeout = null;
        void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue);
      }, FOREGROUND_DEBOUNCE_MS);
    }
  });

  const netInfoUnsubscribe = NetInfo.addEventListener((state) => {
    const isConnected = state.isConnected ?? false;
    if (!wasConnected && isConnected) {
      void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue);
    }
    wasConnected = isConnected;
  });

  // Run initial sync immediately
  void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue);

  return () => {
    if (foregroundTimeout) clearTimeout(foregroundTimeout);
    appStateSubscription.remove();
    netInfoUnsubscribe();
  };
}
