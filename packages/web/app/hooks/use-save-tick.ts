'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from './use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { SAVE_TICK, type SaveTickMutationVariables, type SaveTickMutationResponse } from '@/app/lib/graphql/operations';
import type { BoardName } from '@/app/lib/types';
import {
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  toLogbookEntry,
  type TickStatus,
  type LogbookEntry,
} from './use-logbook';
import { clearTickDraft } from '@/app/lib/tick-draft-db';
import { saveLocalTick } from '@/app/lib/local-ticks-db';

// Options for saving a tick (local storage, no Aurora required)
export type SaveTickOptions = {
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality?: number;
  difficulty?: number;
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  sessionId?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  videoUrl?: string;
};

/**
 * Hook to save a tick (logbook entry) via GraphQL mutation.
 * Provides optimistic updates against the accumulated logbook cache.
 */
export function useSaveTick(boardName: BoardName) {
  const { token } = useWsAuthToken();
  const { status: sessionStatus } = useSession();
  const queryClient = useQueryClient();
  const accumulatedKey = accumulatedLogbookQueryKey(boardName);

  return useMutation({
    mutationFn: async (options: SaveTickOptions) => {
      // Signed-out users: persist locally instead of hitting the server.
      // The optimistic merge handles UI updates; we return a tick-shaped object
      // so the rest of the lifecycle treats this just like a server save.
      if (sessionStatus !== 'authenticated' || !token) {
        const setIdsForLocal =
          options.setIds === undefined || options.setIds === null || options.setIds === ''
            ? null
            : String(options.setIds);
        const tick = await saveLocalTick({
          climbUuid: options.climbUuid,
          angle: options.angle,
          isMirror: options.isMirror,
          status: options.status,
          attemptCount: options.attemptCount,
          quality: options.quality ?? null,
          difficulty: options.difficulty ?? null,
          comment: options.comment,
          climbedAt: options.climbedAt,
          videoUrl: options.videoUrl ?? null,
          boardName,
          layoutId: options.layoutId ?? null,
          sizeId: options.sizeId ?? null,
          setIds: setIdsForLocal,
        });
        if (!tick) {
          throw new Error('Local storage unavailable');
        }
        return {
          uuid: tick.uuid,
          climbUuid: tick.climbUuid,
          angle: tick.angle,
          isMirror: tick.isMirror,
          status: tick.status,
          attemptCount: tick.attemptCount,
          quality: tick.quality,
          difficulty: tick.difficulty,
          comment: tick.comment,
          climbedAt: tick.climbedAt,
        };
      }

      const client = createGraphQLHttpClient(token);
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

      const response = await client.request<SaveTickMutationResponse>(SAVE_TICK, variables);
      return response.saveTick;
    },
    onMutate: async (options) => {
      // Cancel outgoing fetch batches so stale responses merge against the
      // latest accumulated cache entry instead of racing the optimistic write.
      await queryClient.cancelQueries({ queryKey: fetchLogbookQueryKeyPrefix(boardName) });

      // Create optimistic entry
      const tempUuid = `temp-${Date.now()}`;
      const optimisticEntry: LogbookEntry = {
        uuid: tempUuid,
        climb_uuid: options.climbUuid,
        angle: options.angle,
        is_mirror: options.isMirror,
        tries: options.attemptCount,
        quality: options.quality ?? null,
        difficulty: options.difficulty ?? null,
        comment: options.comment,
        climbed_at: options.climbedAt,
        is_ascent: options.status === 'flash' || options.status === 'send',
        status: options.status,
        upvotes: 0,
        downvotes: 0,
        commentCount: 0,
      };

      queryClient.setQueryData<LogbookEntry[]>(accumulatedKey, (existing = []) => [optimisticEntry, ...existing]);

      return { tempUuid };
    },
    onSuccess: (savedTick, options, context) => {
      const savedEntry = toLogbookEntry(savedTick);
      queryClient.setQueriesData<LogbookEntry[]>({ queryKey: accumulatedKey, exact: true }, (existing = []) => {
        if (!context?.tempUuid) {
          return existing.some((entry) => entry.uuid === savedEntry.uuid) ? existing : [savedEntry, ...existing];
        }

        let replaced = false;
        const next = existing.map((entry) => {
          if (entry.uuid !== context.tempUuid) return entry;
          replaced = true;
          return savedEntry;
        });

        if (replaced) {
          const seen = new Set<string>();
          return next.filter((entry) => {
            if (seen.has(entry.uuid)) return false;
            seen.add(entry.uuid);
            return true;
          });
        }
        return existing.some((entry) => entry.uuid === savedEntry.uuid) ? existing : [savedEntry, ...existing];
      });

      // Clear any IndexedDB draft for this climb (belt-and-suspenders with QuickTickBar's .then)
      void clearTickDraft(options.climbUuid, options.angle);

      // If the user attached an Instagram video, refresh the beta-videos section
      // so the new embed shows up without a page reload.
      if (options.videoUrl) {
        void queryClient.invalidateQueries({
          queryKey: ['betaLinks', boardName, options.climbUuid],
        });
      }
    },
    onError: (_err, _options, context) => {
      // Rollback optimistic update. User-facing error feedback is handled by
      // the caller (e.g. QuickTickBar's .catch → onError callback) to avoid
      // duplicate snackbars.
      if (context?.tempUuid) {
        queryClient.setQueriesData<LogbookEntry[]>({ queryKey: accumulatedKey, exact: true }, (existing = []) =>
          existing.filter((entry) => entry.uuid !== context.tempUuid),
        );
      }
    },
  });
}
