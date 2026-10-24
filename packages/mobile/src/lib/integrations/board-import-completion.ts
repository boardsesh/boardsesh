import type { QueryClient } from '@tanstack/react-query';
import { invalidateTickDependents } from '@boardsesh/board-react';
import type { AuroraCredentialStatus } from '../aurora-credentials';
import { AURORA_CREDENTIALS_QUERY_KEY } from './use-board-account-credentials';

export type BoardImportState = Pick<AuroraCredentialStatus, 'boardType' | 'pendingRunId' | 'lastSyncAt'>;

function indexByBoard(credentials: readonly BoardImportState[]): Map<string, BoardImportState> {
  return new Map(credentials.map((credential) => [credential.boardType, credential]));
}

/**
 * Board types whose first import finished between two credential reads: the
 * queued run cleared, or the first `lastSyncAt` appeared. The first observation
 * (`previous` undefined) and a board that vanished (unlink) report nothing.
 */
export function boardsWithFinishedImport(
  previous: readonly BoardImportState[] | undefined,
  next: readonly BoardImportState[],
): string[] {
  if (!previous) return [];
  const before = indexByBoard(previous);
  const finished: string[] = [];
  for (const credential of next) {
    const prior = before.get(credential.boardType);
    if (!prior) continue;
    const runCleared = Boolean(prior.pendingRunId) && !credential.pendingRunId;
    const firstSync = prior.lastSyncAt === null && credential.lastSyncAt !== null;
    if (runCleared || firstSync) finished.push(credential.boardType);
  }
  return finished;
}

// Keys beyond the tick dependents that an import fills in. None of them is a
// credentials key, so invalidating them can never re-trigger the watcher.
const IMPORT_EXTRA_KEYS = [['userTickCountsByBoard'], ['localTicks'], ['userPlaylists'], ['playlistClimbs']] as const;

/**
 * Refresh the climber's own data once a board import finishes. The You page
 * caches for 30 min and nothing else tells it an import landed. Returns the
 * unsubscribe.
 */
export function watchBoardImportCompletion(queryClient: QueryClient): () => void {
  let previous: BoardImportState[] | undefined;
  return queryClient.getQueryCache().subscribe((event) => {
    const { query } = event;
    if (query.queryKey.length !== 1 || query.queryKey[0] !== AURORA_CREDENTIALS_QUERY_KEY[0]) return;
    const data = query.state.data as { credentials?: BoardImportState[] } | undefined;
    if (!data?.credentials) return;
    const next = data.credentials.map(({ boardType, pendingRunId, lastSyncAt }) => ({
      boardType,
      pendingRunId: pendingRunId ?? null,
      lastSyncAt,
    }));
    const finished = boardsWithFinishedImport(previous, next);
    previous = next;
    if (finished.length === 0) return;
    invalidateTickDependents(queryClient);
    for (const queryKey of IMPORT_EXTRA_KEYS) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });
}
