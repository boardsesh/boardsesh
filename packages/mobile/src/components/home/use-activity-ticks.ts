import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { getDatabaseHandle } from '../../db';
import { readActivityTicksLocal, type ActivityTick } from '../../db/queries/get-activity-ticks-local';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { useOfflineDownloadsEnabled } from '../../providers/feature-flags-provider';

/**
 * Under the `['localTicks']` prefix, which the drainer and the pull sync
 * invalidate when a `boardsesh_ticks` row lands, and which an offline tick save
 * invalidates by name (`board-adapter.tsx`), so a logged send reaches the cards
 * without a refetch of their own. Edits and deletes are network-only and reach
 * them with the next pull. Ends in the viewer's id, so one account's ticks are
 * never handed to another from the cache.
 */
export function activityTicksQueryKey(viewerId: string) {
  return ['localTicks', 'activity', viewerId] as const;
}

/**
 * Every tick on this phone for Home's own-climbing cards, This week (#7690) and
 * Back to your projects (#7691): one read and one cache entry for both.
 * Undefined while the read loads, when nobody is signed in, or when the logbook
 * on the phone is not complete yet (a first sync still running): a card waits
 * rather than drawing an empty logbook for a climber who has climbed.
 *
 * Re-renders its caller on focus and on return from the background, which is
 * also what turns This week over to a new week after midnight on Sunday.
 */
export function useActivityTicks(enabled: boolean): ActivityTick[] | undefined {
  const localReads = useOfflineDownloadsEnabled();
  const wanted = enabled && localReads;
  const { userId: viewerId } = useStoredUserId(wanted);
  const isFocused = useIsFocused();
  const backgrounded = useIsAppBackgrounded();
  const { data } = useQuery({
    queryKey: activityTicksQueryKey(viewerId ?? ''),
    // Changes arrive through the invalidations on the key. A declined read is
    // stale at once, so the next visit to Home asks again once the sync is done.
    staleTime: (query) => (query.state.data === null ? 0 : Infinity),
    enabled: wanted && !!viewerId,
    // Off screen the cards hold their last answer: a drain during a session on
    // Climbs marks it stale, and it reads again when Home is back in front.
    subscribed: isFocused && !backgrounded,
    // A local read must not wait on the network.
    networkMode: 'always',
    queryFn: async (): Promise<ActivityTick[] | null> => {
      const db = getDatabaseHandle();
      if (!db || !viewerId) return null;
      return readActivityTicksLocal(db, viewerId);
    },
  });
  return data ?? undefined;
}
