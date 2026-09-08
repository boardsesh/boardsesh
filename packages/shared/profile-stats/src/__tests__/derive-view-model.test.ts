import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { deriveProfileViewModel } from '../derive-view-model';
import type { LogbookEntry } from '../types';

function entry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return { climbed_at: dayjs().toISOString(), difficulty: 22, tries: 1, angle: 40, ...overrides };
}

const allBoardsTicks: Record<string, LogbookEntry[]> = {
  kilter: [
    entry({ difficulty: 16, status: 'flash', climbUuid: 'k1', layoutId: 1, boardType: 'kilter' }), // V3 flash
    entry({ difficulty: 22, status: 'send', tries: 3, climbUuid: 'k2', layoutId: 1, boardType: 'kilter' }), // V6 send
  ],
  tension: [
    entry({ difficulty: 28, status: 'send', climbUuid: 't1', layoutId: 9, boardType: 'tension' }), // V11 send
  ],
};

const base = {
  timeframe: 'all' as const,
  fromDate: '',
  toDate: '',
  gradeFormat: 'v-grade' as const,
  profileStats: null,
  comparisonMode: 'trailing' as const,
};

describe('deriveProfileViewModel', () => {
  it("'all' board includes every board's ticks", () => {
    const vm = deriveProfileViewModel({ ...base, allBoardsTicks, selectedBoard: 'all' });
    expect(vm.filteredLogbook).toHaveLength(3);
    // hardest send across all boards is V11 (tension), hardest flash is V3 (kilter)
    expect(vm.hardestSend).toMatchObject({ label: 'V11', status: 'send' });
    expect(vm.hardestFlash).toMatchObject({ label: 'V3', status: 'flash' });
    expect(vm.hardestSend).not.toHaveProperty('color');
  });

  it('scopes to a single board when selectedBoard is set', () => {
    const vm = deriveProfileViewModel({ ...base, allBoardsTicks, selectedBoard: 'kilter' });
    expect(vm.filteredLogbook).toHaveLength(2);
    // tension's V11 is excluded → hardest send becomes V6
    expect(vm.hardestSend).toMatchObject({ label: 'V6' });
  });

  it('returns a missing board as an empty scope (no throw)', () => {
    const vm = deriveProfileViewModel({ ...base, allBoardsTicks, selectedBoard: 'moonboard' });
    expect(vm.filteredLogbook).toHaveLength(0);
    expect(vm.hardestSend).toBeNull();
    expect(vm.hardestFlash).toBeNull();
    expect(vm.weeklyBars).toBeNull();
  });

  it('produces every chart slice plus the stats summary', () => {
    const vm = deriveProfileViewModel({
      ...base,
      allBoardsTicks,
      selectedBoard: 'all',
      profileStats: {
        totalDistinctClimbs: 3,
        layoutStats: [
          {
            layoutKey: 'kilter-1',
            boardType: 'kilter',
            layoutId: 1,
            distinctClimbCount: 2,
            gradeCounts: [
              { grade: '16', count: 1 },
              { grade: '22', count: 1 },
            ],
          },
          {
            layoutKey: 'tension-9',
            boardType: 'tension',
            layoutId: 9,
            distinctClimbCount: 1,
            gradeCounts: [{ grade: '28', count: 1 }],
          },
        ],
      },
    });
    expect(vm.weeklyBars).not.toBeNull();
    expect(vm.aggregatedStackedBars).not.toBeNull();
    expect(vm.aggregatedFlashRedpointBars).not.toBeNull();
    expect(vm.vPointsTimeline).not.toBeNull();
    expect(vm.statisticsSummary.totalAscents).toBe(3);
    expect(vm.statisticsSummary.layoutPercentages.reduce((s, l) => s + l.percentage, 0)).toBe(100);
  });
});

describe('deriveProfileViewModel periodComparison', () => {
  it('is present for week/month/year timeframes and null otherwise', () => {
    for (const timeframe of ['lastWeek', 'lastMonth', 'lastYear'] as const) {
      const vm = deriveProfileViewModel({ ...base, allBoardsTicks, selectedBoard: 'all', timeframe });
      expect(vm.periodComparison).not.toBeNull();
    }
    for (const timeframe of ['today', 'all', 'custom'] as const) {
      const vm = deriveProfileViewModel({ ...base, allBoardsTicks, selectedBoard: 'all', timeframe });
      expect(vm.periodComparison).toBeNull();
    }
  });

  it('threads comparisonMode through to the built comparison', () => {
    const trailing = deriveProfileViewModel({
      ...base,
      allBoardsTicks,
      selectedBoard: 'all',
      timeframe: 'lastYear',
      comparisonMode: 'trailing',
    });
    const yoy = deriveProfileViewModel({
      ...base,
      allBoardsTicks,
      selectedBoard: 'all',
      timeframe: 'lastYear',
      comparisonMode: 'yearOverYear',
    });
    expect(trailing.periodComparison?.mode).toBe('trailing');
    expect(yoy.periodComparison?.mode).toBe('yearOverYear');
  });

  it('scopes the comparison to the selected board, like every other builder', () => {
    const vm = deriveProfileViewModel({
      ...base,
      allBoardsTicks,
      selectedBoard: 'kilter',
      timeframe: 'lastYear',
    });
    // Only kilter's 2 ticks (both "now") are in scope for the current window.
    expect(vm.periodComparison?.current.sends).toBe(2);
  });
});

describe('deriveProfileViewModel with an injected `now`', () => {
  // Mirrors mobile's screenshot-mode frozen clock: passing `now` must make
  // timeframe filtering, the activity heatmap window, and the period
  // comparison card all agree on the same pinned instant, and produce the same
  // result no matter when the test actually runs.
  const pinnedNow = dayjs('2026-01-15T12:00:00.000Z');
  const pinnedTicks: Record<string, LogbookEntry[]> = {
    kilter: [
      entry({
        difficulty: 22,
        status: 'send',
        climbUuid: 'pinned-1',
        layoutId: 1,
        boardType: 'kilter',
        climbed_at: pinnedNow.subtract(2, 'day').toISOString(),
      }),
      entry({
        difficulty: 16,
        status: 'flash',
        climbUuid: 'pinned-2',
        layoutId: 1,
        boardType: 'kilter',
        climbed_at: pinnedNow.subtract(20, 'day').toISOString(),
      }),
    ],
  };

  it('filters the logbook against the pinned instant, not the real wall clock', () => {
    const vm = deriveProfileViewModel({
      ...base,
      allBoardsTicks: pinnedTicks,
      selectedBoard: 'all',
      timeframe: 'lastWeek',
      now: pinnedNow,
    });
    expect(vm.filteredLogbook).toHaveLength(1);
    expect(vm.filteredLogbook[0].climbUuid).toBe('pinned-1');
  });

  it('produces byte-identical output across repeated calls with the same pinned `now`', () => {
    const build = () =>
      deriveProfileViewModel({
        ...base,
        allBoardsTicks: pinnedTicks,
        selectedBoard: 'all',
        timeframe: 'lastMonth',
        now: pinnedNow,
      });
    expect(build()).toEqual(build());
  });

  it('threads the pinned `now` into the activity heatmap window', () => {
    const vm = deriveProfileViewModel({
      ...base,
      allBoardsTicks: pinnedTicks,
      selectedBoard: 'all',
      timeframe: 'all',
      now: pinnedNow,
    });
    // The heatmap's grid ends on pinnedNow's ISO week, not the real wall
    // clock's — this is the assertion the mutation below is meant to break.
    expect(vm.activityHeatmap).not.toBeNull();
    expect(vm.activityHeatmap?.endDate).toBe(pinnedNow.endOf('isoWeek').format('YYYY-MM-DD'));
  });

  it('threads the pinned `now` into the period comparison window', () => {
    const vm = deriveProfileViewModel({
      ...base,
      allBoardsTicks: pinnedTicks,
      selectedBoard: 'all',
      timeframe: 'lastWeek',
      comparisonMode: 'trailing',
      now: pinnedNow,
    });
    // Current window is (pinnedNow - 1 week, pinnedNow]: only the 2-day-old tick.
    expect(vm.periodComparison?.current.sends).toBe(1);
    expect(vm.periodComparison?.current.endDate).toBe(pinnedNow.format('YYYY-MM-DD'));
  });
});
