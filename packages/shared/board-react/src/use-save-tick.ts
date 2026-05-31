import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SAVE_TICK,
  type SaveTickMutationVariables,
  type SaveTickMutationResponse,
} from '@boardsesh/graphql/operations';
import { useRef } from 'react';
import type { SaveTickDeps } from './types';
import {
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  toLogbookEntry,
  nextTempUuid,
  buildOptimisticTickEntry,
  applySavedTickToLogbook,
  rollbackOptimisticTick,
  type LogbookEntry,
  type SaveTickOptions,
} from './transforms';

/**
 * Renderer-agnostic tick save with optimistic updates against the accumulated
 * logbook cache. Ported from web's `packages/web/app/hooks/use-save-tick.ts`;
 * platform I/O (auth state, GraphQL request, optional draft cleanup) is injected
 * via `deps`. `boardName` is nullable (mobile); the mutation throws on a null
 * board so an unresolved board never sends `boardType: ''`.
 */
export function useSaveTick(deps: SaveTickDeps, boardName: string | null) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const queryClient = useQueryClient();
  const accumulatedKey = accumulatedLogbookQueryKey(boardName);

  return useMutation({
    mutationFn: async (options: SaveTickOptions) => {
      // Platform decides the exact auth message(s) (web: 'Not authenticated' /
      // 'Auth token not available'); throws when not ready.
      depsRef.current.assertAuthed();
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
          videoUrl: options.videoUrl,
        },
      };

      const response = await depsRef.current.requestHttp<SaveTickMutationResponse>(
        SAVE_TICK,
        variables as unknown as Record<string, unknown>,
      );
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
      queryClient.setQueriesData<LogbookEntry[]>({ queryKey: accumulatedKey, exact: true }, (existing = []) =>
        applySavedTickToLogbook(existing, savedEntry, context?.tempUuid),
      );

      depsRef.current.clearTickDraft?.(options.climbUuid, options.angle);

      // Bust the stats caches so the next visit reflects the new tick. React
      // Query does prefix matching on queryKey arrays — the bare root string
      // invalidates every variant (['userTicks', '<any-userId>']).
      void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
      void queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
      void queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });

      // If the user attached a video, refresh the beta-videos section so the new
      // embed shows up without a manual reload.
      if (options.videoUrl) {
        void queryClient.invalidateQueries({
          queryKey: ['betaLinks', boardName, options.climbUuid],
        });
      }
    },
    onError: (_err, _options, context) => {
      // Rollback optimistic update. User-facing error feedback is handled by the
      // caller to avoid duplicate toasts/snackbars.
      if (context?.tempUuid) {
        const { tempUuid } = context;
        queryClient.setQueriesData<LogbookEntry[]>({ queryKey: accumulatedKey, exact: true }, (existing = []) =>
          rollbackOptimisticTick(existing, tempUuid),
        );
      }
    },
  });
}
