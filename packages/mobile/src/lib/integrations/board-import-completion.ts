import type { QueryClient } from '@tanstack/react-query';
import { invalidateTickDependents } from '@boardsesh/board-react';
import { subscribeToCredentialChanges } from '../privacy/privacy-cache';
import type { AuroraCredentialStatus } from '../aurora-credentials';
import { AURORA_CREDENTIALS_QUERY_KEY } from './board-account-query-keys';
import { captureRestReadView } from '../rest-operation';
import { subscribeToAcceptedBoardAccountReads } from './use-board-account-reads';

export type BoardImportState = Pick<AuroraCredentialStatus, 'boardType' | 'pendingRunId' | 'lastSyncAt'>;

function indexByBoard(credentials: readonly BoardImportState[]): Map<string, BoardImportState> {
  return new Map(credentials.map((credential) => [credential.boardType, credential]));
}

/**
 * Board types whose first import finished between two credential reads: the
 * queued run cleared, or `lastSyncAt` advanced (first sync or a newer one). The first observation
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
    const syncAdvanced = credential.lastSyncAt !== null && credential.lastSyncAt !== prior.lastSyncAt;
    if (runCleared || syncAdvanced) finished.push(credential.boardType);
  }
  return finished;
}

// Keys beyond the tick dependents that an import fills in. None of them is a
// credentials key, so invalidating them can never re-trigger the watcher.
const IMPORT_EXTRA_KEYS = [['userTickCountsByBoard'], ['userPlaylists'], ['playlistClimbs']] as const;

/**
 * Refresh everything a finished import fills in. None of these is a credentials
 * key, so calling this can never re-trigger the watcher. Also used by the
 * manual Aurora export and MoonBoard CSV imports, which touch no sync fields.
 */
export function invalidateOwnDataAfterImport(queryClient: Pick<QueryClient, 'invalidateQueries'>): void {
  invalidateTickDependents(queryClient);
  for (const queryKey of IMPORT_EXTRA_KEYS) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Refresh the climber's own data once a board import finishes. The You page
 * caches for 30 min and nothing else tells it an import landed. The remembered
 * state resets at credential boundaries (sign-out, account switch) so the next
 * climber's first read is a first observation. It is not reset on a cache
 * `removed` event: gc also emits that, and would lose a run that finished
 * while unobserved. Returns the unsubscribe.
 */
export function watchBoardImportCompletion(queryClient: QueryClient): () => void {
  let previous: BoardImportState[] | undefined;
  let selectedPrevious: { scope: string; snapshot: readonly Readonly<BoardImportState>[] } | undefined;
  let lifetime = 0;
  let active = true;
  const retiredLifetime = Object.freeze({});
  const unsubscribeSelected = subscribeToAcceptedBoardAccountReads(queryClient, (observation) => {
    const originalLifetime = lifetime;
    const assertCurrent = () => {
      if (!active || lifetime !== originalLifetime) throw retiredLifetime;
      observation.assertCurrent();
    };
    try {
      assertCurrent();
      const prior = selectedPrevious?.scope === observation.scope ? selectedPrevious.snapshot : undefined;
      const finished = boardsWithFinishedImport(prior, observation.snapshot);
      if (finished.length) {
        const port: Pick<QueryClient, 'invalidateQueries'> = {
          invalidateQueries(filters, options) {
            assertCurrent();
            const pending = queryClient.invalidateQueries(
              { ...filters, queryKey: observation.key(filters?.queryKey ?? []) },
              options,
            );
            // Observe immediately, before the post-call guard can refuse.
            void pending.catch(() => {});
            assertCurrent();
            return pending;
          },
        };
        invalidateOwnDataAfterImport(port);
      }
      assertCurrent();
      // A partial/refused enqueue leaves prior history for an idempotent retry.
      selectedPrevious = { scope: observation.scope, snapshot: observation.snapshot };
    } catch (error) {
      if (error !== retiredLifetime) throw error;
    }
  });
  const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    const { query } = event;
    if (query.queryKey.length !== 1 || query.queryKey[0] !== AURORA_CREDENTIALS_QUERY_KEY[0]) return;
    const view = captureRestReadView();
    if (!view.ready || !view.isCurrent() || (view.mode !== 'native' && view.mode !== 'legacy')) return;
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
    invalidateOwnDataAfterImport(queryClient);
  });
  const unsubscribePrivacy = subscribeToCredentialChanges(() => {
    previous = undefined;
    selectedPrevious = undefined;
    lifetime += 1;
  });
  return () => {
    active = false;
    lifetime += 1;
    selectedPrevious = undefined;
    unsubscribeCache();
    unsubscribePrivacy();
    unsubscribeSelected();
  };
}
