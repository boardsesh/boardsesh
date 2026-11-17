import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import dayjs from 'dayjs';
import { buildWeekSummary, type WeekSummary } from '@boardsesh/profile-stats';
import { getDatabaseHandle } from '../../db';
import { readWeekActivityLocal, type WeekActivityTick } from '../../db/queries/get-week-activity-local';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { nowMs } from '../../lib/clock';
import { useOfflineDownloadsEnabled } from '../../providers/feature-flags-provider';

/**
 * Under the `['localTicks']` prefix, which the drainer and the pull sync
 * invalidate when a `boardsesh_ticks` row lands, and which an offline tick save
 * invalidates by name (`board-adapter.tsx`), so a logged send reaches the card
 * without a refetch of its own. Edits and deletes are network-only and reach it
 * with the next pull. Ends in the viewer's id, so one account's week is never
 * handed to another from the cache.
 */
export function weekActivityQueryKey(viewerId: string) {
  return ['localTicks', 'week', viewerId] as const;
}

/**
 * Home's "This week" card, from the ticks on this phone (#7690). Undefined
 * while the local read loads, when nobody is signed in, or when the logbook on
 * the phone is not complete yet (a first sync still running): the card waits
 * rather than drawing an empty week for a climber who has climbed.
 */
export function useWeekSummary(enabled: boolean): WeekSummary<WeekActivityTick> | undefined {
  const localReads = useOfflineDownloadsEnabled();
  const wanted = enabled && localReads;
  const { userId: viewerId } = useStoredUserId(wanted);
  // Re-renders on focus and on return from the background, which is also what
  // turns the card over to a new week after midnight on Sunday.
  const isFocused = useIsFocused();
  const backgrounded = useIsAppBackgrounded();
  const { data: ticks } = useQuery({
    queryKey: weekActivityQueryKey(viewerId ?? ''),
    // Changes arrive through the invalidations on the key. A declined read is
    // stale at once, so the next visit to Home asks again once the sync is done.
    staleTime: (query) => (query.state.data === null ? 0 : Infinity),
    enabled: wanted && !!viewerId,
    // Off screen the card holds its last answer: a drain during a session on
    // Climbs marks it stale, and it reads again when Home is back in front.
    subscribed: isFocused && !backgrounded,
    // A local read must not wait on the network.
    networkMode: 'always',
    queryFn: async (): Promise<WeekActivityTick[] | null> => {
      const db = getDatabaseHandle();
      if (!db || !viewerId) return null;
      return readWeekActivityLocal(db, viewerId);
    },
  });

  const { formatGradeByDifficultyId } = useGradeFormat();
  // The day the week is anchored on, read on each render (see above).
  const todayKey = dayjs(nowMs()).format('YYYY-MM-DD');
  return useMemo(() => {
    if (!ticks) return undefined;
    return buildWeekSummary(ticks, {
      today: dayjs(todayKey).hour(12),
      gradeLabel: (difficulty, boardType) => formatGradeByDifficultyId(difficulty, boardType),
    });
  }, [ticks, todayKey, formatGradeByDifficultyId]);
}
