import { describe, it, expect, vi } from 'vite-plus/test';
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
} from '../chart-data-builders';
import type { LogbookEntry } from '../profile-constants';

dayjs.extend(isoWeek);

vi.mock('@/app/lib/grade-colors', () => ({
  V_GRADE_COLORS: {
    V0: '#FFEB3B',
    V1: '#FFC107',
    V2: '#FF9800',
    V3: '#FF7043',
    V4: '#FF5722',
    V5: '#F44336',
    V6: '#E53935',
    V7: '#D32F2F',
    V8: '#C62828',
    V9: '#B71C1C',
    V10: '#A11B4A',
    V11: '#9C27B0',
  },
  getGradeColor: (grade: string | null | undefined) => {
    if (!grade) return undefined;
    const colors: Record<string, string> = {
      V0: '#FFEB3B',
      V1: '#FFC107',
      V2: '#FF9800',
      V3: '#FF7043',
      V4: '#FF5722',
      V5: '#F44336',
      V6: '#E53935',
      V7: '#D32F2F',
      V8: '#C62828',
      V9: '#B71C1C',
      V10: '#A11B4A',
      V11: '#9C27B0',
    };
    const vGradeMatch = grade.match(/V\d+/i);
    if (vGradeMatch) return colors[vGradeMatch[0].toUpperCase()];
    return undefined;
  },
  getGradeColorWithOpacity: (hex: string, opacity: number) => `rgba(0,0,0,${opacity})`,
}));

vi.mock('@/app/lib/board-data', () => ({
  SUPPORTED_BOARDS: ['kilter', 'tension', 'moonboard'],
  BOULDER_GRADES: [
    { difficulty_id: 10, font_grade: '4a', v_grade: 'V0', difficulty_name: '4a/V0' },
    { difficulty_id: 11, font_grade: '4b', v_grade: 'V0', difficulty_name: '4b/V0' },
    { difficulty_id: 12, font_grade: '4c', v_grade: 'V0', difficulty_name: '4c/V0' },
    { difficulty_id: 13, font_grade: '5a', v_grade: 'V1', difficulty_name: '5a/V1' },
    { difficulty_id: 14, font_grade: '5b', v_grade: 'V1', difficulty_name: '5b/V1' },
    { difficulty_id: 15, font_grade: '5c', v_grade: 'V2', difficulty_name: '5c/V2' },
    { difficulty_id: 16, font_grade: '6a', v_grade: 'V3', difficulty_name: '6a/V3' },
    { difficulty_id: 17, font_grade: '6a+', v_grade: 'V3', difficulty_name: '6a+/V3' },
    { difficulty_id: 18, font_grade: '6b', v_grade: 'V4', difficulty_name: '6b/V4' },
    { difficulty_id: 19, font_grade: '6b+', v_grade: 'V4', difficulty_name: '6b+/V4' },
    { difficulty_id: 20, font_grade: '6c', v_grade: 'V5', difficulty_name: '6c/V5' },
    { difficulty_id: 21, font_grade: '6c+', v_grade: 'V5', difficulty_name: '6c+/V5' },
    { difficulty_id: 22, font_grade: '7a', v_grade: 'V6', difficulty_name: '7a/V6' },
    { difficulty_id: 23, font_grade: '7a+', v_grade: 'V7', difficulty_name: '7a+/V7' },
    { difficulty_id: 24, font_grade: '7b', v_grade: 'V8', difficulty_name: '7b/V8' },
    { difficulty_id: 25, font_grade: '7b+', v_grade: 'V8', difficulty_name: '7b+/V8' },
    { difficulty_id: 26, font_grade: '7c', v_grade: 'V9', difficulty_name: '7c/V9' },
    { difficulty_id: 27, font_grade: '7c+', v_grade: 'V10', difficulty_name: '7c+/V10' },
    { difficulty_id: 28, font_grade: '8a', v_grade: 'V11', difficulty_name: '8a/V11' },
    { difficulty_id: 29, font_grade: '8a+', v_grade: 'V12', difficulty_name: '8a+/V12' },
    { difficulty_id: 30, font_grade: '8b', v_grade: 'V13', difficulty_name: '8b/V13' },
    { difficulty_id: 31, font_grade: '8b+', v_grade: 'V14', difficulty_name: '8b+/V14' },
    { difficulty_id: 32, font_grade: '8c', v_grade: 'V15', difficulty_name: '8c/V15' },
    { difficulty_id: 33, font_grade: '8c+', v_grade: 'V16', difficulty_name: '8c+/V16' },
  ],
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: { colors: { success: '#6B9080', error: '#B8524C' } },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return {
    climbed_at: dayjs().toISOString(),
    difficulty: 22, // V6
    tries: 1,
    angle: 40,
    ...overrides,
  };
}

// ── filterLogbookByTimeframe ─────────────────────────────────────────────────

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
    const result = filterLogbookByTimeframe(logbook, 'lastWeek', '', '');
    expect(result).toHaveLength(1);
    expect(dayjs(result[0].climbed_at).isAfter(dayjs().subtract(1, 'week'))).toBe(true);
  });

  it("'lastWeek' returns empty array when no entries are within 7 days", () => {
    const logbook = [makeEntry({ climbed_at: dayjs().subtract(30, 'day').toISOString() })];
    expect(filterLogbookByTimeframe(logbook, 'lastWeek', '', '')).toHaveLength(0);
  });

  it("'lastMonth' keeps only entries within the last month", () => {
    const logbook = [
      makeEntry({ climbed_at: dayjs().subtract(2, 'week').toISOString() }),
      makeEntry({ climbed_at: dayjs().subtract(2, 'month').toISOString() }),
    ];
    const result = filterLogbookByTimeframe(logbook, 'lastMonth', '', '');
    expect(result).toHaveLength(1);
    expect(dayjs(result[0].climbed_at).isAfter(dayjs().subtract(1, 'month'))).toBe(true);
  });

  it("'lastYear' keeps only entries within the last year", () => {
    const logbook = [
      makeEntry({ climbed_at: dayjs().subtract(6, 'month').toISOString() }),
      makeEntry({ climbed_at: dayjs().subtract(2, 'year').toISOString() }),
    ];
    const result = filterLogbookByTimeframe(logbook, 'lastYear', '', '');
    expect(result).toHaveLength(1);
  });

  it("'lastYear' returns empty array when no entries within the last year", () => {
    const logbook = [makeEntry({ climbed_at: dayjs().subtract(2, 'year').toISOString() })];
    expect(filterLogbookByTimeframe(logbook, 'lastYear', '', '')).toHaveLength(0);
  });

  it("'custom' uses fromDate and toDate (inclusive on both ends)", () => {
    const from = '2024-03-01';
    const to = '2024-03-31';
    const logbook = [
      makeEntry({ climbed_at: '2024-03-15T12:00:00Z' }),
      makeEntry({ climbed_at: '2024-02-28T12:00:00Z' }),
      makeEntry({ climbed_at: '2024-04-01T12:00:00Z' }),
      makeEntry({ climbed_at: '2024-03-01T00:00:00Z' }), // boundary — same as fromDate
      makeEntry({ climbed_at: '2024-03-31T23:59:59Z' }), // boundary — same as toDate
    ];
    const result = filterLogbookByTimeframe(logbook, 'custom', from, to);
    expect(result).toHaveLength(3);
  });

  it("'custom' returns empty array when range excludes all entries", () => {
    const logbook = [makeEntry({ climbed_at: '2023-01-01T00:00:00Z' })];
    const result = filterLogbookByTimeframe(logbook, 'custom', '2024-01-01', '2024-12-31');
    expect(result).toHaveLength(0);
  });

  it('returns the full logbook for an unrecognised timeframe (default branch)', () => {
    const logbook = [makeEntry()];
    // Cast to any to test the default branch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(filterLogbookByTimeframe(logbook, 'unknown' as any, '', '')).toHaveLength(1);
  });
});

// ── buildAggregatedStackedBars ────────────────────────────────────────────────

describe('buildAggregatedStackedBars', () => {
  it('returns null when no boards have ticks', () => {
    expect(buildAggregatedStackedBars({}, 'all')).toBeNull();
  });

  it('returns null when all entries are attempts (no sends)', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          difficulty: 22,
          status: 'attempt',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
    };
    expect(buildAggregatedStackedBars(ticks, 'all')).toBeNull();
  });

  it('returns null when entries lack climbUuid', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: undefined,
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
    };
    expect(buildAggregatedStackedBars(ticks, 'all')).toBeNull();
  });

  it('groups climbs by grade and layout', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }),
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c2',
          layoutId: 1,
          boardType: 'kilter',
        }),
        makeEntry({
          difficulty: 16,
          status: 'send',
          climbUuid: 'c3',
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.bars).toHaveLength(2); // V3 and V6

    const bar7a = result!.bars.find((b) => b.label === 'V6');
    expect(bar7a).toBeDefined();
    expect(bar7a!.segments[0].value).toBe(2); // 2 distinct climbs at V6

    const bar6a = result!.bars.find((b) => b.label === 'V3');
    expect(bar6a).toBeDefined();
    expect(bar6a!.segments[0].value).toBe(1);
  });

  it('deduplicates climbs by climbUuid within the same grade+layout', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }),
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }), // duplicate
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    const bar7a = result!.bars.find((b) => b.label === 'V6');
    expect(bar7a!.segments[0].value).toBe(1); // deduplicated to 1
  });

  it('creates separate segments for different layouts', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
      tension: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c2',
          layoutId: 9,
          boardType: 'tension',
        }),
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.legendEntries).toHaveLength(2);
    expect(result!.bars[0].segments).toHaveLength(2); // kilter + tension segments
  });

  it('returns legend entries sorted by layout order', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      tension: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 9,
          boardType: 'tension',
        }),
      ],
      kilter: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c2',
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    // Kilter comes before Tension in the layout order
    expect(result!.legendEntries[0].label).toContain('Kilter');
    expect(result!.legendEntries[1].label).toContain('Tension');
  });

  it('returns bars sorted by grade order', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }), // V6
        makeEntry({
          difficulty: 16,
          status: 'send',
          climbUuid: 'c2',
          layoutId: 1,
          boardType: 'kilter',
        }), // V3
        makeEntry({
          difficulty: 28,
          status: 'send',
          climbUuid: 'c3',
          layoutId: 1,
          boardType: 'kilter',
        }), // V11
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    const labels = result!.bars.map((b) => b.label);
    expect(labels).toEqual(['V3', 'V6', 'V11']);
  });

  it('filters by timeframe', () => {
    const recentDate = dayjs().subtract(3, 'day').toISOString();
    const oldDate = dayjs().subtract(2, 'month').toISOString();
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          climbed_at: recentDate,
          difficulty: 22,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }),
        makeEntry({
          climbed_at: oldDate,
          difficulty: 16,
          status: 'send',
          climbUuid: 'c2',
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
    };
    const resultWeek = buildAggregatedStackedBars(ticks, 'lastWeek');
    expect(resultWeek).not.toBeNull();
    expect(resultWeek!.bars).toHaveLength(1); // only the recent V6
    expect(resultWeek!.bars[0].label).toBe('V6');
  });

  it('ignores entries with null difficulty', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({
          difficulty: null,
          status: 'send',
          climbUuid: 'c1',
          layoutId: 1,
          boardType: 'kilter',
        }),
        makeEntry({
          difficulty: 22,
          status: 'send',
          climbUuid: 'c2',
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
    };
    const result = buildAggregatedStackedBars(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.bars).toHaveLength(1); // only V6, null is ignored
  });
});

// ── buildWeeklyBars ──────────────────────────────────────────────────────────

describe('buildWeeklyBars', () => {
  it('returns null for an empty logbook', () => {
    expect(buildWeeklyBars([])).toBeNull();
  });

  it('returns null when all entries have null difficulty', () => {
    const logbook = [makeEntry({ difficulty: null }), makeEntry({ difficulty: null })];
    expect(buildWeeklyBars(logbook)).toBeNull();
  });

  it('groups entries by ISO week', () => {
    const week1Date = '2024-01-08T12:00:00Z';
    const week2Date = '2024-01-15T12:00:00Z';
    const logbook = [
      makeEntry({ climbed_at: week2Date, difficulty: 22 }),
      makeEntry({ climbed_at: week1Date, difficulty: 22 }),
      makeEntry({ climbed_at: week1Date, difficulty: 22 }),
    ];
    const result = buildWeeklyBars(logbook);
    expect(result).not.toBeNull();

    const w2Key = `${dayjs(week1Date).isoWeekYear()}-W${dayjs(week1Date).isoWeek()}`;
    const w3Key = `${dayjs(week2Date).isoWeekYear()}-W${dayjs(week2Date).isoWeek()}`;
    const w2 = result!.find((b) => b.key === w2Key);
    const w3 = result!.find((b) => b.key === w3Key);

    expect(w2).toBeDefined();
    expect(w3).toBeDefined();

    expect(w2!.segments.find((s) => s.label === 'V6')?.value).toBe(2);
    expect(w3!.segments.find((s) => s.label === 'V6')?.value).toBe(1);
  });

  it('only includes grades that actually appear in the data', () => {
    const logbook = [makeEntry({ climbed_at: '2024-01-15T12:00:00Z', difficulty: 22 })];
    const result = buildWeeklyBars(logbook);
    expect(result).not.toBeNull();
    const grades = result![0].segments.map((s) => s.label);
    expect(grades).toEqual(['V6']);
    expect(grades).not.toContain('V3');
  });

  it('ignores entries with null difficulty', () => {
    const logbook = [
      makeEntry({ climbed_at: '2024-01-15T12:00:00Z', difficulty: 22 }),
      makeEntry({ climbed_at: '2024-01-15T12:00:00Z', difficulty: null }),
    ];
    const result = buildWeeklyBars(logbook);
    expect(result).not.toBeNull();
    const d = dayjs('2024-01-15T12:00:00Z');
    const w3 = result!.find((b) => b.key === `${d.isoWeekYear()}-W${d.isoWeek()}`);
    const totalValue = w3!.segments.reduce((sum, s) => sum + s.value, 0);
    expect(totalValue).toBe(1);
  });

  it('caps output at DEFAULT_MAX_WEEKS=52 (keeps most recent weeks)', () => {
    const entries: LogbookEntry[] = [];
    for (let w = 0; w < 60; w++) {
      entries.push(
        makeEntry({
          climbed_at: dayjs('2024-07-01').subtract(w, 'week').toISOString(),
          difficulty: 22,
        }),
      );
    }
    entries.sort((a, b) => (a.climbed_at > b.climbed_at ? -1 : 1));

    const result = buildWeeklyBars(entries);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(52);
  });

  it('does not collide week numbers across year boundaries', () => {
    const logbook = [
      makeEntry({ climbed_at: '2025-01-06T12:00:00Z', difficulty: 22 }),
      makeEntry({ climbed_at: '2024-12-30T12:00:00Z', difficulty: 16 }),
      makeEntry({ climbed_at: '2024-12-23T12:00:00Z', difficulty: 22 }),
    ];
    const result = buildWeeklyBars(logbook);
    expect(result).not.toBeNull();

    const allKeys = result!.map((b) => b.key);
    expect(allKeys).toContain('2024-W52');
    expect(allKeys).toContain('2025-W1');
    expect(allKeys).toContain('2025-W2');

    const w52_2024 = result!.find((b) => b.key === '2024-W52')!;
    const w1_2025 = result!.find((b) => b.key === '2025-W1')!;

    expect(w52_2024.segments.find((s) => s.label === 'V6')?.value).toBe(1);
    expect(w1_2025.segments.find((s) => s.label === 'V3')?.value).toBe(1);
    expect(w52_2024.label).toContain("'24");
    expect(w1_2025.label).toContain("'25");
  });

  it('returns bars with the correct structure', () => {
    const logbook = [makeEntry({ climbed_at: '2024-01-15T12:00:00Z', difficulty: 22 })];
    const result = buildWeeklyBars(logbook);
    expect(result).not.toBeNull();
    const bar = result![0];
    expect(bar).toHaveProperty('key');
    expect(bar).toHaveProperty('label');
    expect(Array.isArray(bar.segments)).toBe(true);
    const seg = bar.segments[0];
    expect(seg).toHaveProperty('value');
    expect(seg).toHaveProperty('color');
    expect(seg).toHaveProperty('label');
  });
});

// ── buildFlashRedpointBars ───────────────────────────────────────────────────

describe('buildFlashRedpointBars', () => {
  it('returns null for an empty logbook', () => {
    expect(buildFlashRedpointBars([])).toBeNull();
  });

  it('returns null when all entries have null difficulty', () => {
    const logbook = [makeEntry({ difficulty: null }), makeEntry({ difficulty: null, tries: 3 })];
    expect(buildFlashRedpointBars(logbook)).toBeNull();
  });

  it('returns null when all entries have zero tries (edge case)', () => {
    // tries===0 is neither flash nor redpoint, so no grades accumulate
    const logbook = [makeEntry({ difficulty: 22, tries: 0 })];
    expect(buildFlashRedpointBars(logbook)).toBeNull();
  });

  it('identifies a flash as tries===1 and counts occurrences', () => {
    const logbook = [
      makeEntry({ difficulty: 22, tries: 1 }), // V6 flash
      makeEntry({ difficulty: 22, tries: 1 }), // V6 flash
    ];
    const result = buildFlashRedpointBars(logbook);
    expect(result).not.toBeNull();
    const bar = result!.find((b) => b.key === 'V6')!;
    const flashSeg = bar.values.find((v) => v.label === 'Flash')!;
    expect(flashSeg.value).toBe(2);
  });

  it('identifies a redpoint as tries>1 and sums tries (not count)', () => {
    const logbook = [
      makeEntry({ difficulty: 22, tries: 3 }), // V6 redpoint — 3 tries
      makeEntry({ difficulty: 22, tries: 5 }), // V6 redpoint — 5 tries
    ];
    const result = buildFlashRedpointBars(logbook);
    expect(result).not.toBeNull();
    const bar = result!.find((b) => b.key === 'V6')!;
    const redpointSeg = bar.values.find((v) => v.label === 'Redpoint')!;
    expect(redpointSeg.value).toBe(8); // 3 + 5, not 2
  });

  it('treats flash and redpoint independently for the same grade', () => {
    const logbook = [
      makeEntry({ difficulty: 22, tries: 1 }), // V6 flash
      makeEntry({ difficulty: 22, tries: 4 }), // V6 redpoint — 4 tries
    ];
    const result = buildFlashRedpointBars(logbook);
    expect(result).not.toBeNull();
    const bar = result!.find((b) => b.key === 'V6')!;
    const flashSeg = bar.values.find((v) => v.label === 'Flash')!;
    const redpointSeg = bar.values.find((v) => v.label === 'Redpoint')!;
    expect(flashSeg.value).toBe(1);
    expect(redpointSeg.value).toBe(4);
  });

  it('returns grades in GRADE_ORDER (ascending difficulty)', () => {
    const logbook = [
      makeEntry({ difficulty: 24, tries: 1 }), // V8 — added last in logbook
      makeEntry({ difficulty: 22, tries: 1 }), // V6 — added first in logbook
    ];
    const result = buildFlashRedpointBars(logbook);
    expect(result).not.toBeNull();
    const keys = result!.map((b) => b.key);
    expect(keys).toEqual(['V6', 'V8']); // grade order, not insertion order
  });

  it('ignores entries with null difficulty', () => {
    const logbook = [makeEntry({ difficulty: 22, tries: 1 }), makeEntry({ difficulty: null, tries: 1 })];
    const result = buildFlashRedpointBars(logbook);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].key).toBe('V6');
  });

  it('each bar has exactly two values: Flash and Redpoint', () => {
    const logbook = [makeEntry({ difficulty: 22, tries: 1 })];
    const result = buildFlashRedpointBars(logbook);
    expect(result).not.toBeNull();
    const bar = result![0];
    expect(bar.values).toHaveLength(2);
    const labels = bar.values.map((v) => v.label);
    expect(labels).toContain('Flash');
    expect(labels).toContain('Redpoint');
  });

  it('a grade with only flashes has Redpoint value of 0', () => {
    const logbook = [makeEntry({ difficulty: 22, tries: 1 })];
    const result = buildFlashRedpointBars(logbook);
    const bar = result!.find((b) => b.key === 'V6')!;
    expect(bar.values.find((v) => v.label === 'Redpoint')!.value).toBe(0);
  });

  it('a grade with only redpoints has Flash value of 0', () => {
    const logbook = [makeEntry({ difficulty: 22, tries: 3 })];
    const result = buildFlashRedpointBars(logbook);
    const bar = result!.find((b) => b.key === 'V6')!;
    expect(bar.values.find((v) => v.label === 'Flash')!.value).toBe(0);
  });

  it('handles multiple different grades correctly', () => {
    const logbook = [
      makeEntry({ difficulty: 16, tries: 1 }), // V3 flash
      makeEntry({ difficulty: 22, tries: 2 }), // V6 redpoint
      makeEntry({ difficulty: 28, tries: 1 }), // V11 flash
    ];
    const result = buildFlashRedpointBars(logbook);
    expect(result).not.toBeNull();
    const keys = result!.map((b) => b.key);
    expect(keys).toContain('V3');
    expect(keys).toContain('V6');
    expect(keys).toContain('V11');
  });
});

// ── buildAggregatedFlashRedpointBars ─────────────────────────────────────────

describe('buildAggregatedFlashRedpointBars', () => {
  it('returns null when no boards have ticks', () => {
    expect(buildAggregatedFlashRedpointBars({}, 'all')).toBeNull();
  });

  it('returns null when all entries have null difficulty', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [makeEntry({ difficulty: null })],
    };
    expect(buildAggregatedFlashRedpointBars(ticks, 'all')).toBeNull();
  });

  it('combines flash/redpoint counts from multiple boards', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({ difficulty: 22, tries: 1 }), // flash V6
        makeEntry({ difficulty: 22, tries: 3 }), // redpoint V6 (3 tries)
      ],
      tension: [
        makeEntry({ difficulty: 22, tries: 1 }), // flash V6
      ],
    };
    const result = buildAggregatedFlashRedpointBars(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1); // single grade: V6

    const bar = result![0];
    const flash = bar.values.find((v) => v.label === 'Flash');
    const redpoint = bar.values.find((v) => v.label === 'Redpoint');
    expect(flash?.value).toBe(2); // 1 kilter + 1 tension
    expect(redpoint?.value).toBe(3); // 3 tries from kilter
  });

  it('filters by lastWeek timeframe', () => {
    const recentDate = dayjs().subtract(3, 'day').toISOString();
    const oldDate = dayjs().subtract(2, 'month').toISOString();
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [
        makeEntry({ climbed_at: recentDate, difficulty: 22, tries: 1 }),
        makeEntry({ climbed_at: oldDate, difficulty: 16, tries: 1 }),
      ],
    };
    const result = buildAggregatedFlashRedpointBars(ticks, 'lastWeek');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].label).toBe('V6'); // only recent entry
  });

  it('returns null when timeframe filters out all entries', () => {
    const oldDate = dayjs().subtract(2, 'year').toISOString();
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [makeEntry({ climbed_at: oldDate, difficulty: 22, tries: 1 })],
    };
    expect(buildAggregatedFlashRedpointBars(ticks, 'lastMonth')).toBeNull();
  });

  it('returns grades in correct order across boards', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: [makeEntry({ difficulty: 28, tries: 1 })], // V11
      tension: [makeEntry({ difficulty: 16, tries: 1 })], // V3
    };
    const result = buildAggregatedFlashRedpointBars(ticks, 'all');
    expect(result).not.toBeNull();
    const labels = result!.map((b) => b.label);
    expect(labels).toEqual(['V3', 'V11']);
  });
});

// ── buildStatisticsSummary ───────────────────────────────────────────────────

describe('buildStatisticsSummary', () => {
  it('returns zero totals for null input', () => {
    const result = buildStatisticsSummary(null);
    expect(result.totalAscents).toBe(0);
    expect(result.layoutPercentages).toEqual([]);
  });

  it('uses totalDistinctClimbs as totalAscents', () => {
    const profileStats = {
      totalDistinctClimbs: 42,
      layoutStats: [],
    };
    expect(buildStatisticsSummary(profileStats).totalAscents).toBe(42);
  });

  it('filters out layouts with 0 distinctClimbCount', () => {
    const profileStats = {
      totalDistinctClimbs: 10,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 10,
          gradeCounts: [],
        },
        {
          layoutKey: 'tension-9',
          boardType: 'tension',
          layoutId: 9,
          distinctClimbCount: 0,
          gradeCounts: [],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    expect(layoutPercentages).toHaveLength(1);
    expect(layoutPercentages[0].layoutKey).toBe('kilter-1');
  });

  it('computes percentage for a single layout as 100', () => {
    const profileStats = {
      totalDistinctClimbs: 50,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 50,
          gradeCounts: [],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    expect(layoutPercentages[0].percentage).toBe(100);
  });

  it('percentages sum to 100 for two equal layouts', () => {
    const profileStats = {
      totalDistinctClimbs: 100,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 50,
          gradeCounts: [],
        },
        {
          layoutKey: 'tension-9',
          boardType: 'tension',
          layoutId: 9,
          distinctClimbCount: 50,
          gradeCounts: [],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    const total = layoutPercentages.reduce((sum, l) => sum + l.percentage, 0);
    expect(total).toBe(100);
  });

  it('uses largest remainder method so percentages sum to 100', () => {
    // 3 layouts with 1/3 each — floored each gives 33, sum=99, one gets bumped to 34
    const profileStats = {
      totalDistinctClimbs: 3,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 1,
          gradeCounts: [],
        },
        {
          layoutKey: 'kilter-8',
          boardType: 'kilter',
          layoutId: 8,
          distinctClimbCount: 1,
          gradeCounts: [],
        },
        {
          layoutKey: 'tension-9',
          boardType: 'tension',
          layoutId: 9,
          distinctClimbCount: 1,
          gradeCounts: [],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    const total = layoutPercentages.reduce((sum, l) => sum + l.percentage, 0);
    expect(total).toBe(100);
  });

  it('maps numeric grade keys in gradeCounts to font grade names', () => {
    const profileStats = {
      totalDistinctClimbs: 10,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 10,
          gradeCounts: [
            { grade: '22', count: 5 }, // maps to V6
            { grade: '24', count: 3 }, // maps to V8
          ],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    expect(layoutPercentages[0].grades).toEqual({ V6: 5, V8: 3 });
  });

  it('ignores grade keys that are not valid numbers or not in the difficulty mapping', () => {
    const profileStats = {
      totalDistinctClimbs: 5,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 5,
          gradeCounts: [
            { grade: 'notANumber', count: 5 },
            { grade: '99', count: 2 }, // valid number but not in difficultyMapping
          ],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    expect(layoutPercentages[0].grades).toEqual({});
  });

  it('sorts layout percentages by count descending', () => {
    const profileStats = {
      totalDistinctClimbs: 100,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 20,
          gradeCounts: [],
        },
        {
          layoutKey: 'tension-9',
          boardType: 'tension',
          layoutId: 9,
          distinctClimbCount: 80,
          gradeCounts: [],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    expect(layoutPercentages[0].count).toBe(80);
    expect(layoutPercentages[1].count).toBe(20);
  });

  it('still includes layouts with count>0 when totalDistinctClimbs is 0', () => {
    // When totalDistinctClimbs=0 the exact percentage is 0 for each layout.
    // The largest-remainder method distributes (100 - 0) = 100 remainder points,
    // so the single layout ends up with percentage=1 (one remainder point).
    // The important thing is that the layout is not silently dropped.
    const profileStats = {
      totalDistinctClimbs: 0,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 5,
          gradeCounts: [],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    expect(layoutPercentages).toHaveLength(1);
    // percentage gets 1 from remainder distribution (edge case of the algorithm)
    expect(layoutPercentages[0].percentage).toBe(1);
  });

  it('returned objects do not include internal fields (exactPercentage, remainder)', () => {
    const profileStats = {
      totalDistinctClimbs: 10,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 10,
          gradeCounts: [],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    const entry = layoutPercentages[0] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('exactPercentage');
    expect(entry).not.toHaveProperty('remainder');
  });

  it('each LayoutPercentage entry has required shape', () => {
    const profileStats = {
      totalDistinctClimbs: 10,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 10,
          gradeCounts: [{ grade: '22', count: 10 }],
        },
      ],
    };
    const { layoutPercentages } = buildStatisticsSummary(profileStats);
    const entry = layoutPercentages[0];
    expect(entry).toHaveProperty('layoutKey', 'kilter-1');
    expect(entry).toHaveProperty('boardType', 'kilter');
    expect(entry).toHaveProperty('layoutId', 1);
    expect(typeof entry.displayName).toBe('string');
    expect(typeof entry.color).toBe('string');
    expect(entry).toHaveProperty('count', 10);
    expect(typeof entry.grades).toBe('object');
    expect(typeof entry.percentage).toBe('number');
  });
});

// ── buildVPointsTimeline ────────────────────────────────────────────────────

describe('buildVPointsTimeline', () => {
  it('returns null for empty data', () => {
    expect(buildVPointsTimeline({}, 'all')).toBeNull();
    expect(buildVPointsTimeline({ kilter: [], tension: [] }, 'all')).toBeNull();
  });

  it('returns null when all entries are attempts', () => {
    const ticks = {
      kilter: [
        makeEntry({
          status: 'attempt',
          difficulty: 22,
          climbed_at: '2024-06-01T12:00:00Z',
          layoutId: 1,
          boardType: 'kilter',
        }),
      ],
    };
    expect(buildVPointsTimeline(ticks, 'all')).toBeNull();
  });

  it('computes cumulative v-points for a single layout', () => {
    const monday = dayjs('2024-06-03').startOf('isoWeek'); // a Monday
    const ticks = {
      kilter: [
        makeEntry({
          status: 'send',
          difficulty: 16,
          climbed_at: monday.toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V3
        makeEntry({
          status: 'flash',
          difficulty: 20,
          climbed_at: monday.add(1, 'day').toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V5
      ],
    };
    const result = buildVPointsTimeline(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.series).toHaveLength(1);
    expect(result!.series[0].layoutKey).toBe('kilter-1');
    // V3 + V5 = 8, single week so one data point
    expect(result!.series[0].data).toEqual([8]);
    expect(result!.totalPoints).toBe(8);
  });

  it('V0 sends contribute 1 point each', () => {
    const monday = dayjs('2024-06-03').startOf('isoWeek');
    const ticks = {
      kilter: [
        makeEntry({
          status: 'send',
          difficulty: 10,
          climbed_at: monday.toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V0 → 1
        makeEntry({
          status: 'send',
          difficulty: 10,
          climbed_at: monday.add(1, 'day').toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V0 → 1
      ],
    };
    const result = buildVPointsTimeline(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.series[0].data).toEqual([2]);
    expect(result!.totalPoints).toBe(2);
  });

  it('splits data into separate series per layout', () => {
    const monday = dayjs('2024-06-03').startOf('isoWeek');
    const ticks = {
      kilter: [
        makeEntry({
          status: 'send',
          difficulty: 16,
          climbed_at: monday.toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V3
      ],
      tension: [
        makeEntry({
          status: 'send',
          difficulty: 20,
          climbed_at: monday.toISOString(),
          layoutId: 9,
          boardType: 'tension',
        }), // V5
      ],
    };
    const result = buildVPointsTimeline(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.series).toHaveLength(2);

    const kilterSeries = result!.series.find((s) => s.layoutKey === 'kilter-1');
    const tensionSeries = result!.series.find((s) => s.layoutKey === 'tension-9');
    expect(kilterSeries).toBeDefined();
    expect(tensionSeries).toBeDefined();
    expect(kilterSeries!.data).toEqual([3]);
    expect(tensionSeries!.data).toEqual([5]);
    expect(result!.totalPoints).toBe(8);
  });

  it('fills missing weeks with flat cumulative values', () => {
    const week1 = dayjs('2024-06-03').startOf('isoWeek');
    const week3 = week1.add(2, 'week'); // skip week 2
    const ticks = {
      kilter: [
        makeEntry({
          status: 'send',
          difficulty: 16,
          climbed_at: week1.toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V3
        makeEntry({
          status: 'send',
          difficulty: 20,
          climbed_at: week3.toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V5
      ],
    };
    const result = buildVPointsTimeline(ticks, 'all');
    expect(result).not.toBeNull();
    // 3 weeks: week1 (3), week2 (still 3), week3 (3+5=8)
    expect(result!.weekLabels).toHaveLength(3);
    expect(result!.series[0].data).toEqual([3, 3, 8]);
  });

  it('excludes attempts from v-points total', () => {
    const monday = dayjs('2024-06-03').startOf('isoWeek');
    const ticks = {
      kilter: [
        makeEntry({
          status: 'send',
          difficulty: 16,
          climbed_at: monday.toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V3 counts
        makeEntry({
          status: 'attempt',
          difficulty: 22,
          climbed_at: monday.toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }), // V6 excluded
      ],
    };
    const result = buildVPointsTimeline(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.series[0].data).toEqual([3]);
  });

  it('caps at 104 weeks with correct cumulative base', () => {
    // Create entries spanning 110 weeks
    const start = dayjs('2022-01-03').startOf('isoWeek');
    const entries: LogbookEntry[] = [];
    for (let w = 0; w < 110; w++) {
      entries.push(
        makeEntry({
          status: 'send',
          difficulty: 13, // V1
          climbed_at: start.add(w, 'week').toISOString(),
          layoutId: 1,
          boardType: 'kilter',
        }),
      );
    }
    const ticks = { kilter: entries };
    const result = buildVPointsTimeline(ticks, 'all');
    expect(result).not.toBeNull();
    expect(result!.weekLabels).toHaveLength(104);
    // First 6 weeks skipped (base = 6), so first visible week = 7
    expect(result!.series[0].data[0]).toBe(7);
    // Last week = 110
    expect(result!.series[0].data[103]).toBe(110);
  });
});
