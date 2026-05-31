import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';

import type { GraphQLFetch } from './handlers';
import { processMutation } from './handlers';
import { peekPending, markCompleted, incrementRetry, markDeadLetter } from './queue';
import { isRetryable } from './error-classification';

let _isDraining = false;

// Bounded exponential backoff between drain attempts within a single cycle
// (I7). A transient failure (network blip, 5xx) recovers on its own instead of
// stalling until the next external trigger. Capped so we never busy-loop or
// retry forever inside one drain.
const DEFAULT_MAX_CYCLE_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

export type DrainOptions = {
  /** Injectable sleep for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Max retryable attempts within one drain cycle before giving up. */
  maxCycleAttempts?: number;
  /** First backoff delay; doubles each attempt. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. */
  maxDelayMs?: number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full-jitter exponential backoff: random in [0, min(cap, base * 2^attempt)].
// `attempt` is 0-based (first retry after a failure uses attempt 0).
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * exponential);
}

function invalidateForTable(queryClient: QueryClient, tableName: string): void {
  const keyMap: Record<string, string[][]> = {
    // ['climb'] + ['localTicks'] so the climb detail's server counts refetch and
    // the "waiting to sync" badge clears once a tick actually reaches the server.
    boardsesh_ticks: [['ticks'], ['logbook'], ['climb'], ['localTicks']],
    user_favorites: [['favorites'], ['searchClimbs']],
    playlists: [['playlists']],
    playlist_climbs: [['playlists']],
    user_follows: [['followers'], ['following']],
    setter_follows: [['setterFollows']],
    playlist_follows: [['playlistFollows']],
    user_playlist_pins: [['playlists']],
    // Board tables aren't mutation-driven today, but if a board-table write ever
    // drains, point it at the keys real readers use (mirrors table-config.ts).
    board_climbs: [['searchClimbs'], ['searchClimbsCount'], ['climb']],
    board_climb_stats: [['searchClimbs'], ['searchClimbsCount'], ['climb']],
  };
  for (const key of keyMap[tableName] ?? []) {
    queryClient.invalidateQueries({ queryKey: key });
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function drainMutationQueue(
  db: SQLiteDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphQLFetch,
  options?: DrainOptions,
): Promise<void> {
  if (_isDraining) return;
  _isDraining = true;

  const sleep = options?.sleep ?? defaultSleep;
  const maxCycleAttempts = options?.maxCycleAttempts ?? DEFAULT_MAX_CYCLE_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  // Counts only retryable failures within this cycle. A successful batch resets
  // it, so a long healthy queue never exhausts the budget.
  let retryAttempts = 0;

  try {
    while (true) {
      const batch = await peekPending(db, 10);
      if (batch.length === 0) break;

      let retryableHit = false;

      for (const mutation of batch) {
        try {
          await processMutation(mutation, graphqlFetch);
          await markCompleted(db, mutation.id);
          invalidateForTable(queryClient, mutation.table_name);
        } catch (error: unknown) {
          const errorMessage = formatError(error);

          if (isRetryable(error)) {
            await incrementRetry(db, mutation.id, errorMessage);
            if (mutation.retry_count + 1 >= mutation.max_retries) {
              await markDeadLetter(db, mutation.id, errorMessage);
            }
            retryableHit = true;
            break;
          } else {
            await markDeadLetter(db, mutation.id, errorMessage);
          }
        }
      }

      if (retryableHit) {
        // Give up this cycle once the in-cycle attempt budget is spent; the next
        // external trigger (or the scheduler's own retrigger) starts fresh.
        if (retryAttempts >= maxCycleAttempts) break;
        await sleep(backoffDelay(retryAttempts, baseDelayMs, maxDelayMs));
        retryAttempts += 1;
        continue;
      }

      // Whole batch succeeded (or only dead-lettered non-retryables); reset the
      // backoff budget so transient failures later don't inherit a high count.
      retryAttempts = 0;
    }
  } finally {
    _isDraining = false;
  }
}

export function isDraining(): boolean {
  return _isDraining;
}

export function __resetDrainerStateForTests(): void {
  _isDraining = false;
}
