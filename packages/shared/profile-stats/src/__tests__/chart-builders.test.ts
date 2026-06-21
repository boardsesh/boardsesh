import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildAggregatedFlashRedpointBars,
  buildWeeklyBars,
  buildFlashRedpointBars,
  buildStatisticsSummary,
  buildVPointsTimeline,
  buildActivityHeatmap,
} from '../chart-builders';
import type { LogbookEntry } from '../types';

dayjs.extend(isoWeek);

// These tests run against the REAL @boardsesh/board-config grade taxonomy
// (difficulty 22 → V6 / 7a, 16 → V3 / 6a, etc.) — no mocks. Output is the
// renderer-agnostic raw shape: segments/values carry { value, key, label } and
// no colors.

function makeEntry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return {
    climbed_at: dayjs().toISOString(),
    difficulty: 22, // V6
    tries: 1,
    angle: 40,
    ...overrides,
  };
}

describe('filterLogbookByTimeframe', () => {
  it("'all' returns every entry unchanged", () => {
    const logbook = [
      makeEntry({ climbed_at: dayjs().subtract(3, 'year').toISOString() }),
      makeEntry({ climbed_at: dayjs().subtract(1, 'day').toISOString() }),
    ];
    expect(filterLogbookByTimeframe(logbook, 'all', '', '')).toHaveLength(2);
  });

  it("'lastWeek' keeps only entries within the last 7 days", () => {
    const logbook = [
      makeEntry({ climbed_at: dayjs().subtract(3, 'day').toISOString() }),
      makeEntry({ climbed_at: dayjs().subtract(10, 'day').toISOString() }),
    ];
    expect(filterLogbookByTimeframe(logbook, 'lastWeek', '', '')).toHaveLength(1);
  });

  it("'lastMonth' and 'lastYear' window correctly", () => {
    const logbook = [
      makeEntry({ climbed_at: dayjs().subtract(2, 'week').toISOString() }),
      makeEntry({ climbed_at: dayjs().subtract(2, 'month').toISOString() }),
      makeEntry({ climbed_at: dayjs().subtract(2, 'year').toISOString() }),
    ];
    expect(filterLogbookByTimeframe(logbook, 'lastMonth', '', '')).toHaveLength(1);
    expect(filterLogbookByTimeframe(logbook, 'lastYear', '', '')).toHaveLength(2);
  });

  it("'custom' is inclusive on both ends", () => {
    const logbook = [
      makeEntry({ climbed_at: '2024-03-15T12:00:00Z' }),
      makeEntry({ climbed_at: '2024-02-28T12:00:00Z' }),
      makeEntry({ climbed_at: '2024-04-01T12:00:00Z' }),
      makeEntry({ climbed_at: '2024-03-01T00:00:00Z' }),
      makeEntry({ climbed_at: '2024-03-31T23:59:59Z' }),
    ];
    expect(filterLogbookByTimeframe(logbook, 'custom', '2024-03-01', '2024-03-31')).toHaveLength(3);
  });

  it('returns the full logbook for an unrecognised timeframe (default branch)', () => {
    expect(filterLogbookByTimeframe([makeEntry()], 'unknown' as never, '', '')).toHaveLength(1);
  });
});

describe('buildAggregatedStackedBars', () => {
  it('returns null when no boards have ticks', () => {
    expect(buildAggregatedStackedBars({}, 'all')).toBeNull();
  });

  it('returns null when all entries are attempts or lack climbUuid', () => {
    expect(
      buildAggregatedStackedBars(
        { kilter: [makeEntry({ status: 'attempt', climbUuid: 'c1', layoutId: 1, boardType: 'kilter' })] },
        'all',
      ),
    ).toBeNull();
    expect(
      buildAggregatedStackedBars(
        { kilter: [makeEntry({ status: 'send', climbUuid: undefined, layoutId: 1, boardType: 'kilter' })] },
        'all',
      ),
    ).toBeNull();
  });

  it('groups by grade and layout, dedupes by climbUuid, sorts by grade order', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({ difficulty: 22, status: 'send', climbUuid: 'c1', layoutId: 1, boardType: 'kilter' }),
        makeEntry({ difficulty: 22, status: 'send', climbUuid: 'c1', layoutId: 1, boardType: 'kilter' }), // dup
        makeEntry({ difficulty: 22, status: 'send', climbUuid: 'c2', layoutId: 1, boardType: 'kilter' }),
        makeEntry({ difficulty: 16, status: 'send', climbUuid: 'c3', layoutId: 1, boardType: 'kilter' }),
        makeEntry({ difficulty: 28, status: 'send', climbUuid: 'c4', layoutId: 1, boardType: 'kilter' }),
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.bars.map((b) => b.label)).toEqual(['V3', 'V6', 'V11']);
    const v6 = result!.bars.find((b) => b.label === 'V6')!;
    expect(v6.segments[0].value).toBe(2); // deduped c1, plus c2
    expect(v6.segments[0].key).toBe('kilter-1');
  });

  it('creates separate segments + legend per layout, ordered kilter before tension', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      tension: [makeEntry({ difficulty: 22, status: 'send', climbUuid: 'c1', layoutId: 9, boardType: 'tension' })],
      kilter: [makeEntry({ difficulty: 22, status: 'send', climbUuid: 'c2', layoutId: 1, boardType: 'kilter' })],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.legend).toHaveLength(2);
    expect(result!.legend[0].key).toBe('kilter-1');
    expect(result!.legend[0].label).toContain('Kilter');
    expect(result!.legend[1].label).toContain('Tension');
    expect(result!.bars[0].segments).toHaveLength(2);
  });

  it('filters by timeframe and ignores null difficulty', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          climbed_at: dayjs().subtract(3, 'day').toISOString(),
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }),
        makeEntry({
          climbed_at: dayjs().subtract(2, 'month').toISOString(),
          difficulty: 16,
          status: 'send',
          climbUuid: 'c2',
          layoutId: 1,
          boardType: 'kilter',
        }),
        makeEntry({ difficulty: null, status: 'send', climbUuid: 'c3', layoutId: 1, boardType: 'kilter' }),
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'lastWeek');
    expect(result).not.toBeNull();
    expect(result!.bars).toHaveLength(1);
    expect(result!.bars[0].label).toBe('V6');
  });
});

describe('buildWeeklyBars', () => {
  it('returns null for empty / all-null logbook', () => {
    expect(buildWeeklyBars([])).toBeNull();
    expect(buildWeeklyBars([makeEntry({ difficulty: null })])).toBeNull();
  });

  it('groups by ISO week with key+label grade segments', () => {
    const logbook = [
      makeEntry({ climbed_at: '2024-01-15T12:00:00Z', difficulty: 22 }),
      makeEntry({ climbed_at: '2024-01-08T12:00:00Z', difficulty: 22 }),
      makeEntry({ climbed_at: '2024-01-08T12:00:00Z', difficulty: 22 }),
    ];
    const result = buildWeeklyBars(logbook);
    expect(result).not.toBeNull();
    const w1 = result!.find(
      (b) => b.key === `${dayjs('2024-01-08T12:00:00Z').isoWeekYear()}-W${dayjs('2024-01-08T12:00:00Z').isoWeek()}`,
    )!;
    expect(w1.segments.find((s) => s.label === 'V6')?.value).toBe(2);
    const seg = result![0].segments[0];
    expect(seg).toMatchObject({ key: expect.any(String), label: expect.any(String), value: expect.any(Number) });
  });

  it('caps output at 52 weeks (keeps most recent)', () => {
    const entries: LogbookEntry[] = [];
    for (let w = 0; w < 60; w++) {
      entries.push(makeEntry({ climbed_at: dayjs('2024-07-01').subtract(w, 'week').toISOString(), difficulty: 22 }));
    }
    entries.sort((a, b) => (a.climbed_at > b.climbed_at ? -1 : 1));
    expect(buildWeeklyBars(entries)!.length).toBe(52);
  });

  it('does not collide week numbers across year boundaries', () => {
    const logbook = [
      makeEntry({ climbed_at: '2025-01-06T12:00:00Z', difficulty: 22 }),
      makeEntry({ climbed_at: '2024-12-30T12:00:00Z', difficulty: 16 }),
      makeEntry({ climbed_at: '2024-12-23T12:00:00Z', difficulty: 22 }),
    ];
    const result = buildWeeklyBars(logbook)!;
    const keys = result.map((b) => b.key);
    expect(keys).toContain('2024-W52');
    expect(keys).toContain('2025-W1');
    expect(result.find((b) => b.key === '2024-W52')!.label).toContain("'24");
  });

  // Regression: derive-view-model concatenates per-board tick arrays in
  // BOARD_TYPES order (Object.values(...).flat()), each newest-first, so the
  // combined array is NOT globally sorted. An early board (Kilter, 2024) whose
  // oldest tick is newer than a later board's newest is impossible, but the
  // reverse — an early board entirely older than a later board — makes
  // entries[0] (treated as newest) older than entries[last] (treated as
  // oldest), so first > last, the week loop never runs, and the whole chart
  // disappears.
  it('spans the full range for unsorted multi-board input (regression A5-you-profile-001)', () => {
    // Kilter ticks from early 2024 (newest-first), then Tension ticks from
    // late 2024 (newest-first) — concatenated, NOT globally sorted, and within
    // the 52-week cap. Before the fix, entries[0] (treated as global-newest)
    // was the Kilter March tick while entries[last] (treated as global-oldest)
    // was the Tension October tick, so first > last and the loop produced no
    // weeks → the whole chart returned null.
    const kilterEarly2024 = [
      makeEntry({ climbed_at: '2024-03-15T12:00:00Z', difficulty: 22 }),
      makeEntry({ climbed_at: '2024-03-01T12:00:00Z', difficulty: 22 }),
    ];
    const tensionLate2024 = [
      makeEntry({ climbed_at: '2024-10-15T12:00:00Z', difficulty: 16 }),
      makeEntry({ climbed_at: '2024-10-01T12:00:00Z', difficulty: 16 }),
    ];
    const unsorted = [...kilterEarly2024, ...tensionLate2024];

    const result = buildWeeklyBars(unsorted);
    expect(result).not.toBeNull();
    const keys = result!.map((b) => b.key);
    // Range must cover both the March and October weeks, not collapse to empty.
    expect(keys).toContain(
      `${dayjs('2024-03-01T12:00:00Z').isoWeekYear()}-W${dayjs('2024-03-01T12:00:00Z').isoWeek()}`,
    );
    expect(keys).toContain(
      `${dayjs('2024-10-15T12:00:00Z').isoWeekYear()}-W${dayjs('2024-10-15T12:00:00Z').isoWeek()}`,
    );
  });
});

describe('buildFlashRedpointBars', () => {
  it('returns null for empty / all-null / zero-tries logbook', () => {
    expect(buildFlashRedpointBars([])).toBeNull();
    expect(buildFlashRedpointBars([makeEntry({ difficulty: null })])).toBeNull();
    expect(buildFlashRedpointBars([makeEntry({ difficulty: 22, tries: 0, status: undefined })])).toBeNull();
  });

  it('flash counts occurrences; redpoint sums tries', () => {
    const result = buildFlashRedpointBars([
      makeEntry({ difficulty: 22, tries: 1, status: 'flash' }),
      makeEntry({ difficulty: 22, tries: 3, status: 'send' }),
      makeEntry({ difficulty: 22, tries: 5, status: 'send' }),
    ])!;
    const bar = result.find((b) => b.key === 'V6')!;
    expect(bar.values.find((v) => v.key === 'flash')!.value).toBe(1);
    expect(bar.values.find((v) => v.key === 'redpoint')!.value).toBe(8);
    expect(bar.values.map((v) => v.label)).toEqual(['Flash', 'Redpoint']);
  });

  it('returns grades in ascending difficulty order', () => {
    const result = buildFlashRedpointBars([
      makeEntry({ difficulty: 24, tries: 1, status: 'flash' }),
      makeEntry({ difficulty: 22, tries: 1, status: 'flash' }),
    ])!;
    expect(result.map((b) => b.key)).toEqual(['V6', 'V8']);
  });
});

describe('buildAggregatedFlashRedpointBars', () => {
  it('combines counts across boards and filters by timeframe', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({ difficulty: 22, tries: 1, status: 'flash' }),
        makeEntry({ difficulty: 22, tries: 3, status: 'send' }),
      ],
      tension: [makeEntry({ difficulty: 22, tries: 1, status: 'flash' })],
    };
    const result = buildAggregatedFlashRedpointBars(ticks, 'all')!;
    expect(result).toHaveLength(1);
    expect(result[0].values.find((v) => v.key === 'flash')!.value).toBe(2);
    expect(result[0].values.find((v) => v.key === 'redpoint')!.value).toBe(3);
  });

  it('returns null when timeframe filters everything out', () => {
    const ticks = {
      kilter: [makeEntry({ climbed_at: dayjs().subtract(2, 'year').toISOString(), difficulty: 22, status: 'flash' })],
    };
    expect(buildAggregatedFlashRedpointBars(ticks, 'lastMonth')).toBeNull();
  });
});

describe('buildStatisticsSummary', () => {
  it('returns zero totals for null input', () => {
    expect(buildStatisticsSummary(null)).toEqual({ totalAscents: 0, layoutPercentages: [] });
  });

  it('filters zero-count layouts, sorts by count desc, sums percentages to 100', () => {
    const { totalAscents, layoutPercentages } = buildStatisticsSummary({
      totalDistinctClimbs: 3,
      layoutStats: [
        { layoutKey: 'kilter-1', boardType: 'kilter', layoutId: 1, distinctClimbCount: 1, gradeCounts: [] },
        { layoutKey: 'kilter-8', boardType: 'kilter', layoutId: 8, distinctClimbCount: 1, gradeCounts: [] },
        { layoutKey: 'tension-9', boardType: 'tension', layoutId: 9, distinctClimbCount: 1, gradeCounts: [] },
        { layoutKey: 'tension-10', boardType: 'tension', layoutId: 10, distinctClimbCount: 0, gradeCounts: [] },
      ],
    });
    expect(totalAscents).toBe(3);
    expect(layoutPercentages).toHaveLength(3);
    expect(layoutPercentages.reduce((s, l) => s + l.percentage, 0)).toBe(100);
  });

  it('maps numeric grade keys to grade labels and excludes unknown ids', () => {
    const { layoutPercentages } = buildStatisticsSummary({
      totalDistinctClimbs: 10,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 10,
          gradeCounts: [
            { grade: '22', count: 5 }, // V6
            { grade: '24', count: 3 }, // V8
            { grade: 'notANumber', count: 2 },
            { grade: '999', count: 1 },
          ],
        },
      ],
    });
    expect(layoutPercentages[0].grades).toEqual({ V6: 5, V8: 3 });
  });

  it('emits no color field (renderer-agnostic)', () => {
    const { layoutPercentages } = buildStatisticsSummary({
      totalDistinctClimbs: 10,
      layoutStats: [
        { layoutKey: 'kilter-1', boardType: 'kilter', layoutId: 1, distinctClimbCount: 10, gradeCounts: [] },
      ],
    });
    expect(layoutPercentages[0]).not.toHaveProperty('color');
    expect(typeof layoutPercentages[0].displayName).toBe('string');
  });
});

describe('buildVPointsTimeline', () => {
  it('returns null for empty data or all-attempts', () => {
    expect(buildVPointsTimeline({}, 'all')).toBeNull();
    expect(
      buildVPointsTimeline(
        {
          kilter: [
            makeEntry({
              status: 'attempt',
              difficulty: 22,
              climbed_at: '2024-06-01T12:00:00Z',
              layoutId: 1,
              boardType: 'kilter',
            }),
          ],
        },
        'all',
      ),
    ).toBeNull();
  });

  it('computes cumulative v-points (V0 = 1 point) without colors', () => {
    const monday = dayjs('2024-06-03').startOf('isoWeek');
    const result = buildVPointsTimeline(
      {
        kilter: [
          makeEntry({
            status: 'send',
            difficulty: 16,
            climbed_at: monday.toISOString(),
            layoutId: 1,
            boardType: 'kilter',
          }), // V3 → 3
          makeEntry({
            status: 'flash',
            difficulty: 20,
            climbed_at: monday.add(1, 'day').toISOString(),
            layoutId: 1,
            boardType: 'kilter',
          }), // V5 → 5
        ],
      },
      'all',
    )!;
    expect(result.series).toHaveLength(1);
    expect(result.series[0].layoutKey).toBe('kilter-1');
    expect(result.series[0]).not.toHaveProperty('color');
    expect(result.series[0].data).toEqual([8]);
    expect(result.totalPoints).toBe(8);
  });

  it('fills missing weeks with flat cumulative values', () => {
    const week1 = dayjs('2024-06-03').startOf('isoWeek');
    const week3 = week1.add(2, 'week');
    const result = buildVPointsTimeline(
      {
        kilter: [
          makeEntry({
            status: 'send',
            difficulty: 16,
            climbed_at: week1.toISOString(),
            layoutId: 1,
            boardType: 'kilter',
          }),
          makeEntry({
            status: 'send',
            difficulty: 20,
            climbed_at: week3.toISOString(),
            layoutId: 1,
            boardType: 'kilter',
          }),
        ],
      },
      'all',
    )!;
    expect(result.weekLabels).toHaveLength(3);
    expect(result.series[0].data).toEqual([3, 3, 8]);
  });

  it('caps at 104 weeks with correct cumulative base', () => {
    const start = dayjs('2022-01-03').startOf('isoWeek');
    const entries: LogbookEntry[] = [];
    for (let w = 0; w < 110; w++) {
      entries.push(
        makeEntry({
          status: 'send',
          difficulty: 13,
          climbed_at: start.add(w, 'week').toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }),
      ); // V1 → 1
    }
    const result = buildVPointsTimeline({ kilter: entries }, 'all')!;
    expect(result.weekLabels).toHaveLength(104);
    expect(result.series[0].data[0]).toBe(7); // 6 skipped weeks as base
    expect(result.series[0].data[103]).toBe(110);
  });

  it('handles a single mid-week tick (one week, one cumulative point)', () => {
    const wednesday = dayjs('2024-06-05'); // mid-week, not a range boundary
    const result = buildVPointsTimeline(
      {
        kilter: [
          makeEntry({
            status: 'send',
            difficulty: 13, // V1 → 1 point
            climbed_at: wednesday.toISOString(),
            layoutId: 1,
            boardType: 'kilter',
          }),
        ],
      },
      'all',
    )!;
    expect(result).not.toBeNull();
    expect(result.weekLabels).toHaveLength(1);
    expect(result.series).toHaveLength(1);
    expect(result.series[0].data).toEqual([1]);
    expect(result.totalPoints).toBe(1);
  });

  it('keeps the week for a tick logged on a Sunday (iso-week boundary)', () => {
    // Sunday is the last day of the iso week; the week-range loop must still
    // emit exactly one week, not zero (which would null out the whole chart).
    const sunday = dayjs('2024-06-09');
    const result = buildVPointsTimeline(
      {
        kilter: [
          makeEntry({
            status: 'send',
            difficulty: 13,
            climbed_at: sunday.toISOString(),
            layoutId: 1,
            boardType: 'kilter',
          }),
        ],
      },
      'all',
    )!;
    expect(result.weekLabels).toHaveLength(1);
    expect(result.series[0].data).toEqual([1]);
  });
});

describe('buildActivityHeatmap', () => {
  it('returns null for an empty logbook', () => {
    expect(buildActivityHeatmap([])).toBeNull();
  });

  it('returns null when all activity predates the trailing window', () => {
    expect(buildActivityHeatmap([makeEntry({ climbed_at: dayjs().subtract(3, 'year').toISOString() })])).toBeNull();
  });

  it('counts ascents per day on a whole-week-aligned grid', () => {
    const today = dayjs();
    const result = buildActivityHeatmap([
      makeEntry({ climbed_at: today.toISOString() }),
      makeEntry({ climbed_at: today.toISOString() }),
      makeEntry({ climbed_at: today.subtract(1, 'day').toISOString() }),
    ])!;
    expect(result.days.length % 7).toBe(0);
    expect(result.weeks).toBe(result.days.length / 7);
    expect(result.maxCount).toBe(2);
    expect(result.days.find((day) => day.date === today.format('YYYY-MM-DD'))!.count).toBe(2);
  });

  it('counts attempts as activity (you still showed up)', () => {
    const result = buildActivityHeatmap([makeEntry({ status: 'attempt', climbed_at: dayjs().toISOString() })])!;
    expect(result.maxCount).toBe(1);
  });

  it('honours a custom window size', () => {
    const result = buildActivityHeatmap([makeEntry({ climbed_at: dayjs().toISOString() })], 4)!;
    expect(result.weeks).toBe(4);
    expect(result.days.length).toBe(28);
  });

  it('anchors the grid to a provided `today` (deterministic, ISO-week aligned)', () => {
    const today = dayjs('2024-06-12'); // a Wednesday
    const result = buildActivityHeatmap([makeEntry({ climbed_at: '2024-06-12T12:00:00Z' })], 53, today)!;
    expect(result.weeks).toBe(53);
    expect(result.days.length).toBe(53 * 7);
    // End/start derive purely from `today` (no tick parsing), so these are
    // timezone-independent: the grid ends on that ISO week's Sunday.
    expect(result.endDate).toBe(today.endOf('isoWeek').format('YYYY-MM-DD'));
    expect(result.startDate).toBe(
      today
        .endOf('isoWeek')
        .subtract(53 * 7 - 1, 'day')
        .startOf('isoWeek')
        .format('YYYY-MM-DD'),
    );
  });
});
