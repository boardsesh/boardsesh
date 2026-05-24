import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';

import type { GraphQLFetch } from './handlers';
import { processMutation } from './handlers';
import { peekPending, markCompleted, incrementRetry, markDeadLetter } from './queue';
import { isRetryable } from './error-classification';

let _isDraining = false;

function invalidateForTable(queryClient: QueryClient, tableName: string): void {
  const keyMap: Record<string, string[][]> = {
    boardsesh_ticks: [['ticks'], ['logbook']],
    user_favorites: [['favorites'], ['searchClimbs']],
    playlists: [['playlists']],
    playlist_climbs: [['playlists']],
    user_follows: [['followers'], ['following']],
    setter_follows: [['setterFollows']],
    playlist_follows: [['playlistFollows']],
    user_playlist_pins: [['playlists']],
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
): Promise<void> {
  if (_isDraining) return;
  _isDraining = true;

  try {
    while (true) {
      const batch = await peekPending(db, 10);
      if (batch.length === 0) break;

      let shouldBreak = false;

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
            shouldBreak = true;
            break;
          } else {
            await markDeadLetter(db, mutation.id, errorMessage);
          }
        }
      }

      if (shouldBreak) break;
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
