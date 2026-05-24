import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';
import { pullSync } from './pull-client';

const FOREGROUND_DEBOUNCE_MS = 2000;

let isSyncing = false;
let pendingTrigger = false;

async function runSync(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  getEnabledBoards: () => string[],
): Promise<void> {
  if (isSyncing) {
    pendingTrigger = true;
    return;
  }

  isSyncing = true;
  try {
    await pullSync(db, queryClient, graphqlFetch, {
      enabledBoards: getEnabledBoards(),
    });
  } catch (error) {
    console.warn('[Sync] Pull sync failed:', error instanceof Error ? error.message : 'unknown');
  } finally {
    isSyncing = false;
    if (pendingTrigger) {
      pendingTrigger = false;
      runSync(db, queryClient, graphqlFetch, getEnabledBoards);
    }
  }
}

export function triggerSync(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  getEnabledBoards: () => string[],
): void {
  runSync(db, queryClient, graphqlFetch, getEnabledBoards);
}

export function startSyncScheduler(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  getEnabledBoards: () => string[],
): () => void {
  let foregroundTimeout: ReturnType<typeof setTimeout> | null = null;
  let wasConnected = true;

  const appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      if (foregroundTimeout) clearTimeout(foregroundTimeout);
      foregroundTimeout = setTimeout(() => {
        foregroundTimeout = null;
        runSync(db, queryClient, graphqlFetch, getEnabledBoards);
      }, FOREGROUND_DEBOUNCE_MS);
    }
  });

  const netInfoUnsubscribe = NetInfo.addEventListener((state) => {
    const isConnected = state.isConnected ?? false;
    if (!wasConnected && isConnected) {
      runSync(db, queryClient, graphqlFetch, getEnabledBoards);
    }
    wasConnected = isConnected;
  });

  // Run initial sync immediately
  runSync(db, queryClient, graphqlFetch, getEnabledBoards);

  return () => {
    if (foregroundTimeout) clearTimeout(foregroundTimeout);
    appStateSubscription.remove();
    netInfoUnsubscribe();
  };
}
