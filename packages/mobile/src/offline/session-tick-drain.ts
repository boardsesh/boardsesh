import type { QueryClient } from '@tanstack/react-query';
import type { GraphQLFetch } from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';
import { drainMutationQueue, isOnline } from './offline-sync-adapter';
import { hasQueuedTicksForSession } from './pending-tick';

/** Longest "End session" waits for the session's queued ticks before ending anyway. */
export const SESSION_TICK_SYNC_TIMEOUT_MS = 3_000;
/** How often the wait re-reads the outbox. */
export const SESSION_TICK_SYNC_POLL_MS = 150;

/**
 * - `none`: nothing of this session was queued, END_SESSION can go now.
 * - `synced`: the session had queued ticks and every one has reached the server.
 * - `offline`: no connection, so no wait; queued ticks stay queued.
 * - `timedOut`: ticks were still queued when the cap ran out.
 */
export type SessionTickSyncResult = 'none' | 'synced' | 'offline' | 'timedOut';

/**
 * Give the session's queued ticks a short chance to reach the server before
 * END_SESSION (#6903). The server builds the session summary, and the one-shot
 * Strava export, from the ticks it already has, so a climber who ends right
 * after their last tick would otherwise see "0 attempts".
 *
 * Polls the outbox rather than awaiting the drain: `drainMutationQueue`
 * resolves at once when another drain already holds the latch (the tick save
 * itself starts one), so its promise says nothing about our rows. Never
 * throws and never waits past `timeoutMs`; the caller ends the session
 * whatever this returns.
 */
export async function waitForSessionTicksToSync(
  sessionId: string,
  queryClient: QueryClient,
  { timeoutMs = SESSION_TICK_SYNC_TIMEOUT_MS, pollMs = SESSION_TICK_SYNC_POLL_MS } = {},
): Promise<SessionTickSyncResult> {
  const db = getDatabaseHandle();
  if (!db) return 'none';
  if (!isOnline()) return 'offline';

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<SessionTickSyncResult> => {
    if (!(await hasQueuedTicksForSession(sessionId))) return 'none';
    const graphqlFetch: GraphQLFetch = (query, variables) => getOfflineSyncHttpClient().request(query, variables);
    // Fire and forget: the poll below is what decides when we are done.
    drainMutationQueue(db, queryClient, graphqlFetch).catch(() => undefined);
    while (!settled) {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, pollMs);
      });
      if (settled) break;
      if (!(await hasQueuedTicksForSession(sessionId))) return 'synced';
    }
    return 'timedOut';
  };
  // The cap races the whole poll, first read included, so a SQLite read stuck
  // behind a write lock cannot stretch the wait either.
  const cap = new Promise<SessionTickSyncResult>((resolve) => {
    capTimer = setTimeout(() => resolve('timedOut'), timeoutMs);
  });
  try {
    return await Promise.race([poll(), cap]);
  } finally {
    settled = true;
    clearTimeout(timer);
    clearTimeout(capTimer);
  }
}
