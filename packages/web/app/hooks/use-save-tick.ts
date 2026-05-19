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
import { bumpAscentDelta, climbStatsLiveKey, type ClimbStatsLive } from './use-climb-stats-live';

// Backstop in case the live stats WS event never lands (backend down,
// Redis hiccup, recompute failed). Slightly longer than the server-side
// 2s debounce so the live event has a clear shot to arrive first.
const ASCENT_DELTA_SAFETY_MS = 5_000;

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
      if (sessionStatus !== 'authenticated') {
        throw new Error('Not authenticated');
      }
      if (!token) {
        throw new Error('Auth token not available');
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

      // Snapshot the user's prior flash/send state at this (climb, angle)
      // *before* we insert the optimistic entry, so the "first ascent"
      // check below mirrors the server's COUNT(DISTINCT user_id) rule.
      const isAscent = options.status === 'flash' || options.status === 'send';
      const priorAccumulated = queryClient.getQueryData<LogbookEntry[]>(accumulatedKey) ?? [];
      const hadPriorAscent = priorAccumulated.some(
        (entry) =>
          entry.climb_uuid === options.climbUuid &&
          entry.angle === options.angle &&
          (entry.status === 'flash' || entry.status === 'send'),
      );

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

      // Optimistically bump the ascensionist_count shown in the UI. The
      // recompute is debounced ~2s on the backend; a live WS event will
      // later replace this delta with the canonical number. We only bump
      // when this is the user's first send/flash at this (climb, angle)
      // — repeat sends by the same user don't move the distinct-user count.
      const bumpedAscent = isAscent && !hadPriorAscent;
      if (bumpedAscent) {
        bumpAscentDelta(queryClient, boardName, options.climbUuid, options.angle, 1);
      }

      return { tempUuid, bumpedAscent };
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

      // Bust the You-page stats caches so the next visit reflects the new tick.
      // React Query does prefix matching on queryKey arrays — the bare root
      // string invalidates every variant (['userTicks', '<any-userId>']).
      void queryClient.invalidateQueries({ queryKey: ['userTicks'] });
      void queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
      void queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });

      // If the user attached an Instagram video, refresh the beta-videos section
      // so the new embed shows up without a page reload.
      if (options.videoUrl) {
        void queryClient.invalidateQueries({
          queryKey: ['betaLinks', boardName, options.climbUuid],
        });
      }

      // Safety net for the optimistic ascent bump: if the live-stats WS
      // event never arrives (backend down, Redis hiccup, recompute crashed)
      // the delta would persist and double-count after the next page-level
      // refetch. Zero it after a buffer that comfortably outruns the 2s
      // debounce + publish — but only if the live event hasn't already
      // arrived and reset the delta. In the happy path this is a no-op.
      if (context?.bumpedAscent) {
        setTimeout(() => {
          const current = queryClient.getQueryData<ClimbStatsLive>(
            climbStatsLiveKey(boardName, options.climbUuid, options.angle),
          );
          if (current?.live) return; // Live event already reconciled.
          bumpAscentDelta(queryClient, boardName, options.climbUuid, options.angle, -1);
        }, ASCENT_DELTA_SAFETY_MS);
      }
    },
    onError: (_err, options, context) => {
      // Rollback optimistic update. User-facing error feedback is handled by
      // the caller (e.g. QuickTickBar's .catch → onError callback) to avoid
      // duplicate snackbars.
      if (context?.tempUuid) {
        queryClient.setQueriesData<LogbookEntry[]>({ queryKey: accumulatedKey, exact: true }, (existing = []) =>
          existing.filter((entry) => entry.uuid !== context.tempUuid),
        );
      }
      if (context?.bumpedAscent) {
        bumpAscentDelta(queryClient, boardName, options.climbUuid, options.angle, -1);
      }
    },
  });
}
