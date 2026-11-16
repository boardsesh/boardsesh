import { useCallback, useMemo, useReducer, useRef, useLayoutEffect, type SetStateAction } from 'react';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useHttpQueryScope } from '../use-http-query-scope';
import dayjs from 'dayjs';
import { useIsFocused } from 'expo-router';
import { deriveProfileViewModel, type UnifiedTimeframeType, type PeriodComparisonMode } from '@boardsesh/profile-stats';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useOfflineQueryState } from '../../../hooks/use-offline-query-state';
import { nowMs } from '../../clock';
import { useAllBoardsTicks, useUserProfileStats, useUserClimbPercentile } from './use-you-data';

/**
 * Where the authoritative all-board totals (`userProfileStats`) stand. The header
 * renders a number only for `'ready'`: a failed or not-yet-landed request would
 * otherwise read as a real "0 climbs sent" next to records the logbook did load.
 */
export type ProfileTotalsStatus = 'loading' | 'ready' | 'error' | 'offline';

export function profileTotalsStatus(query: {
  data?: unknown;
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
}): ProfileTotalsStatus {
  if (query.data !== undefined && query.data !== null) return 'ready';
  // offlineFirst pauses a request it can't send; it stays `pending` for good.
  if (query.fetchStatus === 'paused') return 'offline';
  if (query.status === 'error') return 'error';
  return 'loading';
}

type ProgressFilters = {
  selectedBoard: string;
  timeframe: UnifiedTimeframeType;
  comparisonMode: PeriodComparisonMode;
};
type FilterIntent = {
  assertCurrent: () => void;
} & (
  | { field: 'selectedBoard'; selection: SetStateAction<string> }
  | { field: 'timeframe'; selection: SetStateAction<UnifiedTimeframeType> }
  | { field: 'comparisonMode'; selection: SetStateAction<PeriodComparisonMode> }
);
function selectFilter<Selection extends string>(current: Selection, selection: SetStateAction<Selection>): Selection {
  return typeof selection === 'function' ? selection(current) : selection;
}
/** useReducer does not cache a useState eager result. The original UI guard
 * is pure and runs again if React suspends/rebases a filter action. */
function reduceProgressFilters(current: ProgressFilters, intent: FilterIntent): ProgressFilters {
  try {
    intent.assertCurrent();
    let next: ProgressFilters;
    switch (intent.field) {
      case 'selectedBoard':
        next = { ...current, selectedBoard: selectFilter(current.selectedBoard, intent.selection) };
        break;
      case 'timeframe':
        next = { ...current, timeframe: selectFilter(current.timeframe, intent.selection) };
        break;
      case 'comparisonMode':
        next = { ...current, comparisonMode: selectFilter(current.comparisonMode, intent.selection) };
        break;
    }
    intent.assertCurrent();
    return next;
  } catch (error: unknown) {
    if (error instanceof BrowserBackendConsumerError) return current;
    throw error;
  }
}

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

  const scope = useHttpQueryScope();
  const owner = useRef({ mounted: true, epoch: 0 });
  const target = useRef({ userId, scope, identity: Object.freeze({}) });
  if (target.current.userId !== userId || target.current.scope !== scope) {
    target.current = { userId, scope, identity: Object.freeze({}) };
  }
  const identity = target.current.identity;
  useLayoutEffect(() => {
    const original = owner.current;
    original.mounted = true;
    return () => {
      original.mounted = false;
      original.epoch += 1;
    };
  }, []);
  const captureIntent = useCallback(() => {
    const original = owner.current;
    const epoch = original.epoch;
    const assertCurrent = () => {
      if (!original.mounted || original.epoch !== epoch || target.current.identity !== identity)
        throw new BrowserBackendConsumerError('superseded');
      scope.assertView();
    };
    assertCurrent();
    return assertCurrent;
  }, [identity, scope]);
  const [{ selectedBoard, timeframe, comparisonMode }, dispatchFilter] = useReducer(reduceProgressFilters, {
    selectedBoard: 'all',
    timeframe: 'all',
    comparisonMode: 'trailing',
  });
  const setSelectedBoard = useCallback(
    (selection: SetStateAction<string>) => {
      try {
        dispatchFilter({ field: 'selectedBoard', selection, assertCurrent: captureIntent() });
      } catch {
        /* Retired UI is inert. */
      }
    },
    [captureIntent],
  );
  const setTimeframe = useCallback(
    (selection: SetStateAction<UnifiedTimeframeType>) => {
      try {
        dispatchFilter({ field: 'timeframe', selection, assertCurrent: captureIntent() });
      } catch {
        /* Retired UI is inert. */
      }
    },
    [captureIntent],
  );
  const setComparisonMode = useCallback(
    (selection: SetStateAction<PeriodComparisonMode>) => {
      try {
        dispatchFilter({ field: 'comparisonMode', selection, assertCurrent: captureIntent() });
      } catch {
        /* Retired UI is inert. */
      }
    },
    [captureIntent],
  );
  // Custom date-range filtering isn't surfaced yet — YouFilterSheet only offers
  // all/year/month/week. Kept as empty constants so deriveProfileViewModel gets
  // a stable range; not exposed until the custom-range UI lands.
  // TODO(you-page): add from/to date pickers to YouFilterSheet and lift these to state.
  const fromDate = '';
  const toDate = '';

  // Off screen, the three reads are disabled: a tick invalidation marks them
  // stale instead of refetching 32 queries behind a screen nobody is looking
  // at, and regaining focus re-enables them and refetches the stale ones.
  const onScreen = useIsFocused();
  const allBoardsTicksQuery = useAllBoardsTicks(userId, { onScreen });
  const profileStatsQuery = useUserProfileStats(userId, { onScreen });
  const percentileQuery = useUserClimbPercentile(userId, { onScreen });

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
        comparisonMode,
        // Use one instant for timeframe filters, heatmaps and comparison cards.
        now: dayjs(nowMs()),
      }),
    [allBoardsTicks, selectedBoard, timeframe, fromDate, toDate, gradeFormat, profileStatsQuery.data, comparisonMode],
  );

  const totalsStatus = profileTotalsStatus(profileStatsQuery);
  const startOriginalRefetch = useCallback(
    (query: { refetchOriginal: (assertIntent: () => void) => Promise<unknown> }, assertIntent: () => void) => {
      assertIntent();
      // Normal query errors arrive in the real observer result/cache. A retired
      // original intent can reject after an await; this void UI event owns no
      // later error reporter or side effect under another viewer.
      void query.refetchOriginal(assertIntent).catch(() => {});
      assertIntent();
    },
    [],
  );
  const retryTotals = useCallback(() => {
    try {
      startOriginalRefetch(profileStatsQuery, captureIntent());
    } catch {
      /* Expected retired UI hold. */
    }
  }, [captureIntent, profileStatsQuery, startOriginalRefetch]);

  const refetch = useCallback(() => {
    try {
      const assertIntent = captureIntent();
      startOriginalRefetch(allBoardsTicksQuery, assertIntent);
      startOriginalRefetch(profileStatsQuery, assertIntent);
      startOriginalRefetch(percentileQuery, assertIntent);
    } catch {
      /* A reentrant retirement stops all remaining dispatches. */
    }
  }, [allBoardsTicksQuery, captureIntent, profileStatsQuery, percentileQuery, startOriginalRefetch]);

  // With `networkMode: 'offlineFirst'`, an offline fetch pauses instead of
  // failing, so `isPending` stays true forever and `loading` below would spin
  // for good. This is what the Progress tab renders instead.
  const offline = useOfflineQueryState([allBoardsTicksQuery, profileStatsQuery]);

  // `!userId` (the brief post-login window before useProfile resolves) counts
  // as loading so the Progress tab shows a spinner instead of flashing the
  // empty state, then the charts. Only the logbook gates the spinner: the
  // all-board totals have their own loading and error states in the header, so
  // a slow or paused totals request can't hold the whole tab on a spinner.
  const loading = !offline.isBlocked && (!userId || allBoardsTicksQuery.isPending);

  const refreshing = allBoardsTicksQuery.isRefetching || profileStatsQuery.isRefetching || percentileQuery.isRefetching;

  const hasActiveFilters = timeframe !== 'all' || selectedBoard !== 'all';

  return {
    loading,
    offline,
    refreshing,
    refetch,
    percentile: percentileQuery.data ?? null,
    totalsStatus,
    retryTotals,

    // Filter state
    selectedBoard,
    setSelectedBoard,
    timeframe,
    setTimeframe,
    comparisonMode,
    setComparisonMode,
    hasActiveFilters,

    // Derived view model (renderer-agnostic; colors applied in components)
    ...viewModel,
  };
}
