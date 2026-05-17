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
import {
  buildOptimisticAscentItem,
  cancelTickFeeds,
  prependToLogbookFeed,
  removeFromLogbookFeed,
  restoreTickFeeds,
  snapshotTickFeeds,
  type TickFeedSnapshot,
} from './use-tick-feed-cache';
import { clearTickDraft } from '@/app/lib/tick-draft-db';

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
  // Optional context for optimistic insert into the logbook feed cache.
  // Populated by callers that already have the climb on hand; the row renders
  // instantly with these fields and the background refetch fills in the rest.
  climbName?: string;
  setterUsername?: string | null;
  frames?: string | null;
  difficultyName?: string | null;
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
      // Same idea for the IDB-persisted logbook/ascents feed caches.
      await cancelTickFeeds(queryClient);

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

      // Snapshot the persisted feed caches before mutating so we can roll back
      // on error.
      const feedSnapshot = snapshotTickFeeds(queryClient);
      prependToLogbookFeed(
        queryClient,
        buildOptimisticAscentItem({
          tempUuid,
          climbUuid: options.climbUuid,
          climbName: options.climbName,
          setterUsername: options.setterUsername,
          boardType: boardName,
          layoutId: options.layoutId,
          angle: options.angle,
          isMirror: options.isMirror,
          status: options.status,
          attemptCount: options.attemptCount,
          quality: options.quality,
          difficulty: options.difficulty,
          difficultyName: options.difficultyName,
          isBenchmark: options.isBenchmark,
          comment: options.comment,
          climbedAt: options.climbedAt,
          frames: options.frames,
        }),
      );

      return { tempUuid, feedSnapshot };
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

      // Drop the temp row from the persisted feed caches; the invalidation
      // below pulls the canonical server row (with the real uuid + full
      // metadata) into its place. Doing it in this order avoids a transient
      // "two rows for the same tick" state.
      if (context?.tempUuid) {
        removeFromLogbookFeed(queryClient, context.tempUuid);
      }
      void queryClient.invalidateQueries({ queryKey: ['logbookFeed'] });
      void queryClient.invalidateQueries({ queryKey: ['ascentsFeed'] });

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
      if (context?.feedSnapshot) {
        restoreTickFeeds(queryClient, context.feedSnapshot satisfies TickFeedSnapshot);
      }
    },
  });
}
