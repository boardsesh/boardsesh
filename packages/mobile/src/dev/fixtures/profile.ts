import { deriveProfileViewModel, type LogbookEntry } from '@boardsesh/profile-stats';
import dayjs from 'dayjs';
import type { ProgressViewData } from '../../components/you/ProgressView';

const NOW = dayjs('2026-10-26T12:00:00.000Z');
const noop = () => {};
const entries: LogbookEntry[] = Array.from({ length: 48 }, (_, index) => ({
  climbed_at: NOW.subtract(Math.floor(index / 4) * 3, 'day').toISOString(),
  difficulty: 13 + (index % 10),
  tries: 1 + (index % 3),
  angle: 40,
  status: index % 3 === 0 ? 'flash' : 'send',
  climbUuid: `profile-climb-${index}`,
  layoutId: 1,
  boardType: 'kilter',
}));

export function profileStoryData(empty = false): ProgressViewData {
  return {
    ...deriveProfileViewModel({
      allBoardsTicks: empty ? {} : { kilter: entries },
      selectedBoard: 'all',
      timeframe: 'all',
      fromDate: '',
      toDate: '',
      gradeFormat: 'v-grade',
      comparisonMode: 'trailing',
      now: NOW,
      profileStats: {
        totalDistinctClimbs: empty ? 0 : 48,
        layoutStats: empty
          ? []
          : [
              {
                layoutKey: 'kilter-1',
                boardType: 'kilter',
                layoutId: 1,
                distinctClimbCount: 48,
                gradeCounts: [
                  { grade: '13', count: 18 },
                  { grade: '16', count: 16 },
                  { grade: '22', count: 14 },
                ],
              },
            ],
      },
    }),
    loading: false,
    refreshing: false,
    refetch: noop,
    retryTotals: noop,
    totalsStatus: 'ready',
    selectedBoard: 'all',
    timeframe: 'all',
    comparisonMode: 'trailing',
    setComparisonMode: noop,
    hasActiveFilters: false,
    percentile: null,
    offline: { isOffline: false, isBlocked: false, reason: null },
  };
}
