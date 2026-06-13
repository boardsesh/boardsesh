import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SAVE_TICK,
  type SaveTickMutationVariables,
  type SaveTickMutationResponse,
} from '@boardsesh/graphql/operations';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardAdapter } from './adapter';
import {
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  toLogbookEntry,
  type LogbookEntry,
} from './logbook-keys';
import {
  applySavedTickToLogbook,
  buildOptimisticTickEntry,
  rollbackOptimisticTick,
  type SaveTickOptions,
} from './tick-helpers';

/**
 * Build a collision-resistant temp uuid for the optimistic entry. Falls back
 * to a counter-based suffix when `crypto.randomUUID` isn't available
 * (older RN Hermes builds). `Date.now()` alone is not enough — two rapid
 * taps within the same millisecond would collide and clobber each other's
 * onSuccess/onError contexts.
 */
let tempUuidCounter = 0;
function nextTempUuid(): string {
  const cryptoObj: { randomUUID?: () => string } | undefined =
    typeof globalThis === 'undefined' ? undefined : (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `temp-${cryptoObj.randomUUID()}`;
  }
  tempUuidCounter = (tempUuidCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `temp-${Date.now()}-${tempUuidCounter}`;
}

/**
 * Save a tick (logbook entry) via GraphQL mutation. Provides optimistic
 * updates against the accumulated logbook cache: inserts a temp entry on
 * mutate, replaces it with the server response on success, rolls back on
 * error. Stats / climb caches are invalidated post-success so dependent
 * surfaces refresh without a manual reload.
 */
export function useSaveTick(boardName: BoardName | null) {
  const { isAuthenticated, executeHttp, onTickSaved } = useBoardAdapter();
  const queryClient = useQueryClient();
  const accumulatedKey = accumulatedLogbookQueryKey(boardName);

  return useMutation({
    mutationFn: async (options: SaveTickOptions) => {
      if (!isAuthenticated) {
        throw new Error('Not authenticated');
      }
      if (!boardName) {
        throw new Error('No board selected');
      }

      const variables: SaveTickMutationVariables = {
        input: {
          boardType: boardName,
          climbUuid: options.climbUuid,
          angle: options.angle,
          isMirror: options.isMirror,
          status: options.status,
          attemptCount: options.attemptCount,
          quality: options.quality,
          difficulty: options.difficulty,
          isBenchmark: options.isBenchmark,
          comment: options.comment,
          climbedAt: options.climbedAt,
          sessionId: options.sessionId,
          layoutId: options.layoutId,
          sizeId: options.sizeId,
          setIds: options.setIds,
          boardUuid: options.boardUuid,
          ...(options.boardId != null ? { boardId: options.boardId } : {}),
          videoUrl: options.videoUrl,
        },
      };

      const response = await executeHttp<SaveTickMutationResponse, SaveTickMutationVariables>(SAVE_TICK, variables);
      return response.saveTick;
    },
    onMutate: async (options) => {
      // Cancel outgoing fetch batches so stale responses merge against the
      // latest accumulated cache entry instead of racing the optimistic write.
      await queryClient.cancelQueries({ queryKey: fetchLogbookQueryKeyPrefix(boardName) });

      const tempUuid = nextTempUuid();
      const optimisticEntry = buildOptimisticTickEntry(options, tempUuid);
      queryClient.setQueryData<LogbookEntry[]>(accumulatedKey, (existing = []) => [optimisticEntry, ...existing]);

      return { tempUuid };
    },
    onSuccess: (savedTick, options, context) => {
      const savedEntry = toLogbookEntry(savedTick);
      // `setQueriesData` (not `setQueryData`) so a logbook cache that was
      // removed mid-flight (e.g. invalidate fired between mutate and
      // success) is NOT recreated. setQueriesData iterates already-existing
      // queries; a removed entry just doesn't get the update.
      queryClient.setQueriesData<LogbookEntry[]>({ queryKey: accumulatedKey, exact: true }, (existing = []) =>
        applySavedTickToLogbook(existing ?? [], savedEntry, context?.tempUuid),
      );

      onTickSaved?.(options.climbUuid, options.angle);

      // Bust the stats caches so the next visit reflects the new tick.
      // React Query does prefix matching on queryKey arrays — the bare root
      // string invalidates every variant (e.g. ['userTicks', '<any-userId>']).
      void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
      void queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
      void queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });

      // Climb detail / search surfaces show a "ticked" state derived from
      // these queries — keep them refreshing after a tick.
      void queryClient.invalidateQueries({ queryKey: ['climb'] });
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });

      // Named-board sends can change board summary counts shown in board
      // pickers/details. Bust those caches when the tick was associated with a
      // concrete board row rather than only a board config.
      if (options.boardId != null || options.boardUuid) {
        void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
        void queryClient.invalidateQueries({ queryKey: ['board'] });
        void queryClient.invalidateQueries({ queryKey: ['searchBoards'] });
        void queryClient.invalidateQueries({ queryKey: ['boardsBySerialNumbers'] });
      }

      // The You-page Logbook tab feed and the Sessions feed/detail are separate
      // cache families from the optimistically-updated accumulated logbook, so
      // a new tick won't appear there without busting them. Matches the
      // edit/delete path (use-mutate-tick) — the create path was missing these.
      void queryClient.invalidateQueries({ queryKey: ['userAscentsFeed'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionDetail'] });

      if (options.videoUrl) {
        void queryClient.invalidateQueries({
          queryKey: ['betaLinks', boardName, options.climbUuid],
        });
      }
    },
    onError: (_err, _options, context) => {
      // Rollback optimistic update. Caller-side toasts (QuickTickBar /
      // LogAscentSheet / web's create-form) handle user-facing error UI to
      // avoid duplicate snackbars.
      if (context?.tempUuid) {
        const { tempUuid } = context;
        // Same setQueriesData reason as onSuccess: don't recreate a removed
        // cache entry on rollback.
        queryClient.setQueriesData<LogbookEntry[]>({ queryKey: accumulatedKey, exact: true }, (existing = []) =>
          rollbackOptimisticTick(existing ?? [], tempUuid),
        );
      }
    },
  });
}
