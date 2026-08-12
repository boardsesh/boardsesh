import { useCallback, useMemo, useState } from 'react';
import { deriveProfileViewModel, type UnifiedTimeframeType } from '@boardsesh/profile-stats';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useOfflineQueryState } from '../../../hooks/use-offline-query-state';
import { useAllBoardsTicks, useUserProfileStats, useUserClimbPercentile } from './use-you-data';

/**
 * Mobile counterpart of web's `useProfileData`. Fans out the per-board ticks +
 * profile-stats + percentile queries, holds the board / timeframe filter state,
 * and runs the shared `deriveProfileViewModel` to
 * produce every Progress-tab chart's renderer-agnostic data plus the hardest
 * send/flash highlights. Color resolution happens in the chart components.
 *
 * `userId` should be the signed-in user's id (`useProfile().data?.id`). Every
 * query stays disabled until it resolves.
 */
export function useYouProfileData(userId: string | undefined) {
  const { gradeFormat } = useGradeFormat();

  const [selectedBoard, setSelectedBoard] = useState<string>('all');
  const [timeframe, setTimeframe] = useState<UnifiedTimeframeType>('all');
  // Custom date-range filtering isn't surfaced yet — YouFilterSheet only offers
  // all/year/month/week. Kept as empty constants so deriveProfileViewModel gets
  // a stable range; not exposed until the custom-range UI lands.
  // TODO(you-page): add from/to date pickers to YouFilterSheet and lift these to state.
  const fromDate = '';
  const toDate = '';

  const allBoardsTicksQuery = useAllBoardsTicks(userId);
  const profileStatsQuery = useUserProfileStats(userId);
  const percentileQuery = useUserClimbPercentile(userId);

  const allBoardsTicks = useMemo(() => allBoardsTicksQuery.data ?? {}, [allBoardsTicksQuery.data]);

  const viewModel = useMemo(
    () =>
      deriveProfileViewModel({
        allBoardsTicks,
        selectedBoard,
        timeframe,
        fromDate,
        toDate,
        gradeFormat,
        profileStats: profileStatsQuery.data ?? null,
      }),
    [allBoardsTicks, selectedBoard, timeframe, fromDate, toDate, gradeFormat, profileStatsQuery.data],
  );

  const refetch = useCallback(() => {
    void allBoardsTicksQuery.refetch();
    void profileStatsQuery.refetch();
    void percentileQuery.refetch();
  }, [allBoardsTicksQuery, profileStatsQuery, percentileQuery]);

  // With `networkMode: 'offlineFirst'`, an offline fetch pauses instead of
  // failing, so `isPending` stays true forever and `loading` below would spin
  // for good. This is what the Progress tab renders instead.
  const offline = useOfflineQueryState([allBoardsTicksQuery, profileStatsQuery]);

  // `!userId` (the brief post-login window before useProfile resolves) counts
  // as loading so the Progress tab shows a spinner instead of flashing the
  // empty state, then the charts.
  const loading = !offline.isBlocked && (!userId || allBoardsTicksQuery.isPending || profileStatsQuery.isPending);

  const refreshing = allBoardsTicksQuery.isRefetching || profileStatsQuery.isRefetching || percentileQuery.isRefetching;

  const hasActiveFilters = timeframe !== 'all' || selectedBoard !== 'all';

  return {
    loading,
    offline,
    refreshing,
    refetch,
    percentile: percentileQuery.data ?? null,

    // Filter state
    selectedBoard,
    setSelectedBoard,
    timeframe,
    setTimeframe,
    hasActiveFilters,

    // Derived view model (renderer-agnostic; colors applied in components)
    ...viewModel,
  };
}
