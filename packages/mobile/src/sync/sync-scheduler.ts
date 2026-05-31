import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';
import { pullSync, type SyncProgress } from './pull-client';

/**
 * Optional progress sink for the pull phase. The bridge passes the sync-status
 * store's `setSyncProgress` so the Settings screen can show live progress; when
 * omitted (tests, headless callers) the pull just runs silently.
 */
export type SyncProgressSink = (progress: SyncProgress) => void;

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
  onProgress?: SyncProgressSink,
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
      onProgress,
    });
  } catch (error) {
    console.warn('[Sync] Sync cycle failed:', error instanceof Error ? error.message : 'unknown');
    // pullSync only emits its terminal `idle` frame on success, so a throw mid-pull
    // would leave the Settings status row stuck on "Downloading…". Emit idle here so
    // the in-flight flag always clears (user-data tables sync before board tables, so
    // a typical mid-pull failure is past the user data — "last synced" is still apt).
    onProgress?.({ phase: 'idle', currentTable: null, documentsProcessed: 0 });
  } finally {
    isSyncing = false;
    // I1: a trigger that arrived mid-run must still produce exactly one
    // follow-up run, even if the cycle above threw. The try/catch above
    // swallows cycle errors so we always reach here; consume the flag and
    // re-run once. (runSync is async, so it can't throw synchronously here.)
    if (pendingTrigger) {
      pendingTrigger = false;
      void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, onProgress);
    }
  }
}

export function triggerSync(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
  onProgress?: SyncProgressSink,
): void {
  void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, onProgress);
}

export function startSyncScheduler(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
  onProgress?: SyncProgressSink,
): () => void {
  let foregroundTimeout: ReturnType<typeof setTimeout> | null = null;
  let wasConnected = true;

  const appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      if (foregroundTimeout) clearTimeout(foregroundTimeout);
      foregroundTimeout = setTimeout(() => {
        foregroundTimeout = null;
        void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, onProgress);
      }, FOREGROUND_DEBOUNCE_MS);
    }
  });

  const netInfoUnsubscribe = NetInfo.addEventListener((state) => {
    const isConnected = state.isConnected ?? false;
    if (!wasConnected && isConnected) {
      void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, onProgress);
    }
    wasConnected = isConnected;
  });

  // Run initial sync immediately
  void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, onProgress);

  return () => {
    if (foregroundTimeout) clearTimeout(foregroundTimeout);
    appStateSubscription.remove();
    netInfoUnsubscribe();
  };
}
