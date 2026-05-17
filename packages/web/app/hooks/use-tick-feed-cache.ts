import type { QueryClient } from '@tanstack/react-query';
import type { AscentFeedItem, GroupedAscentFeedItem } from '@/app/lib/graphql/operations/ticks';

// Shared in-place updates for the two React Query infinite-query caches that
// hold tick rows:
//   - ['logbookFeed', ...] — flat per-user ascent list (LogbookFeed)
//   - ['ascentsFeed', ...] — grouped per-user ascent list (AscentsFeed)
//
// Used by useSaveTick / useUpdateTick / useDeleteTick to keep the IDB-persisted
// caches consistent without an extra network round-trip. Each helper walks every
// cache entry under the matching root key, so it covers all filter/sort variants.

type LogbookFeedPage = {
  items: AscentFeedItem[];
  totalCount?: number;
  hasMore: boolean;
};

type LogbookFeedData = {
  pages: LogbookFeedPage[];
  pageParams: unknown[];
};

type AscentsFeedPage = {
  groups: GroupedAscentFeedItem[];
  totalCount?: number;
  hasMore: boolean;
};

type AscentsFeedData = {
  pages: AscentsFeedPage[];
  pageParams: unknown[];
};

const LOGBOOK_FEED_KEY = ['logbookFeed'] as const;
const ASCENTS_FEED_KEY = ['ascentsFeed'] as const;

export function prependToLogbookFeed(queryClient: QueryClient, item: AscentFeedItem): void {
  queryClient.setQueriesData<LogbookFeedData>({ queryKey: LOGBOOK_FEED_KEY }, (old) => {
    if (!old || old.pages.length === 0) return old;
    return {
      ...old,
      pages: old.pages.map((page, i) =>
        i === 0
          ? {
              ...page,
              items: [item, ...page.items],
              totalCount: page.totalCount !== undefined ? page.totalCount + 1 : undefined,
            }
          : page,
      ),
    };
  });
}

export function removeFromLogbookFeed(queryClient: QueryClient, uuid: string): void {
  queryClient.setQueriesData<LogbookFeedData>({ queryKey: LOGBOOK_FEED_KEY }, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => {
        const items = page.items.filter((i) => i.uuid !== uuid);
        if (items.length === page.items.length) return page;
        return {
          ...page,
          items,
          totalCount: page.totalCount !== undefined ? Math.max(0, page.totalCount - 1) : undefined,
        };
      }),
    };
  });
}

export function mergeIntoLogbookFeed(queryClient: QueryClient, uuid: string, patch: Partial<AscentFeedItem>): void {
  queryClient.setQueriesData<LogbookFeedData>({ queryKey: LOGBOOK_FEED_KEY }, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => {
        let changed = false;
        const items = page.items.map((item) => {
          if (item.uuid !== uuid) return item;
          changed = true;
          return { ...item, ...patch };
        });
        return changed ? { ...page, items } : page;
      }),
    };
  });
}

// Recompute every group-level aggregate that's derived from `items`. We do
// this after any in-place mutation (merge or remove) instead of patching
// individual counters incrementally — an edit can change an item's status
// (e.g. attempt → flash), which would flip two counters at once; tracking
// that with delta logic is fragile and easy to leave inconsistent.
function recomputeGroupAggregates(group: GroupedAscentFeedItem): GroupedAscentFeedItem {
  let flashCount = 0;
  let sendCount = 0;
  let attemptCount = 0;
  let bestQuality: number | null = null;
  for (const item of group.items) {
    if (item.status === 'flash') flashCount++;
    else if (item.status === 'send') sendCount++;
    else attemptCount++;
    if (item.quality !== null && (bestQuality === null || item.quality > bestQuality)) {
      bestQuality = item.quality;
    }
  }
  // Latest non-empty comment by climbedAt. Items aren't guaranteed sorted in
  // cache, so do a single pass tracking the most recent timestamp seen.
  let latestComment: string | null = null;
  let latestCommentAt = '';
  for (const item of group.items) {
    const trimmed = item.comment?.trim();
    if (!trimmed) continue;
    if (item.climbedAt > latestCommentAt) {
      latestCommentAt = item.climbedAt;
      latestComment = item.comment;
    }
  }
  return { ...group, flashCount, sendCount, attemptCount, bestQuality, latestComment };
}

export function removeFromAscentsFeed(queryClient: QueryClient, uuid: string): void {
  queryClient.setQueriesData<AscentsFeedData>({ queryKey: ASCENTS_FEED_KEY }, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => {
        let groupChanged = false;
        const groups = page.groups
          .map((group) => {
            const items = group.items.filter((i) => i.uuid !== uuid);
            if (items.length === group.items.length) return group;
            groupChanged = true;
            return recomputeGroupAggregates({ ...group, items });
          })
          .filter((group) => group.items.length > 0);
        return groupChanged ? { ...page, groups } : page;
      }),
    };
  });
}

export function mergeIntoAscentsFeed(queryClient: QueryClient, uuid: string, patch: Partial<AscentFeedItem>): void {
  queryClient.setQueriesData<AscentsFeedData>({ queryKey: ASCENTS_FEED_KEY }, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => {
        let pageChanged = false;
        const groups = page.groups.map((group) => {
          let groupChanged = false;
          const items = group.items.map((item) => {
            if (item.uuid !== uuid) return item;
            groupChanged = true;
            return { ...item, ...patch };
          });
          if (!groupChanged) return group;
          pageChanged = true;
          return recomputeGroupAggregates({ ...group, items });
        });
        return pageChanged ? { ...page, groups } : page;
      }),
    };
  });
}

export type TickFeedSnapshot = {
  logbookFeed: [readonly unknown[], LogbookFeedData | undefined][];
  ascentsFeed: [readonly unknown[], AscentsFeedData | undefined][];
};

export function snapshotTickFeeds(queryClient: QueryClient): TickFeedSnapshot {
  return {
    logbookFeed: queryClient.getQueriesData<LogbookFeedData>({ queryKey: LOGBOOK_FEED_KEY }),
    ascentsFeed: queryClient.getQueriesData<AscentsFeedData>({ queryKey: ASCENTS_FEED_KEY }),
  };
}

export function restoreTickFeeds(queryClient: QueryClient, snapshot: TickFeedSnapshot): void {
  snapshot.logbookFeed.forEach(([key, data]) => queryClient.setQueryData(key, data));
  snapshot.ascentsFeed.forEach(([key, data]) => queryClient.setQueryData(key, data));
}

export async function cancelTickFeeds(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: LOGBOOK_FEED_KEY }),
    queryClient.cancelQueries({ queryKey: ASCENTS_FEED_KEY }),
  ]);
}

export type OptimisticAscentInput = {
  tempUuid: string;
  climbUuid: string;
  climbName?: string;
  setterUsername?: string | null;
  boardType: string;
  layoutId?: number | null;
  angle: number;
  isMirror: boolean;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  quality?: number | null;
  difficulty?: number | null;
  difficultyName?: string | null;
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  frames?: string | null;
};

export function buildOptimisticAscentItem(input: OptimisticAscentInput): AscentFeedItem {
  return {
    uuid: input.tempUuid,
    climbUuid: input.climbUuid,
    climbName: input.climbName ?? '',
    setterUsername: input.setterUsername ?? null,
    boardType: input.boardType,
    layoutId: input.layoutId ?? null,
    angle: input.angle,
    isMirror: input.isMirror,
    status: input.status,
    attemptCount: input.attemptCount,
    quality: input.quality ?? null,
    difficulty: input.difficulty ?? null,
    difficultyName: input.difficultyName ?? null,
    consensusDifficulty: null,
    consensusDifficultyName: null,
    qualityAverage: null,
    isBenchmark: input.isBenchmark,
    isNoMatch: false,
    comment: input.comment,
    climbedAt: input.climbedAt,
    frames: input.frames ?? null,
  };
}
