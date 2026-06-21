import { describe, it, expect, vi } from 'vite-plus/test';
import {
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildFlashRedpointBars,
  buildStatisticsSummary,
} from '../chart-data-builders';
import type { LogbookEntry } from '../profile-constants';

vi.mock('@/app/lib/board-data', () => ({
  SUPPORTED_BOARDS: ['kilter', 'tension'],
  BOULDER_GRADES: [
    { difficulty_id: 16, font_grade: '6a', v_grade: 'V3', difficulty_name: '6a/V3' },
    { difficulty_id: 17, font_grade: '6a+', v_grade: 'V3', difficulty_name: '6a+/V3' },
    { difficulty_id: 22, font_grade: '7a', v_grade: 'V6', difficulty_name: '7a/V6' },
  ],
}));

vi.mock('@/app/lib/grade-colors', () => ({
  V_GRADE_COLORS: { V3: '#FF7043', V6: '#E53935' } as Record<string, string>,
  FONT_GRADE_COLORS: { '6a': '#FF7043', '6a+': '#FF7043', '7a': '#E53935' } as Record<string, string>,
  getGradeColor: (grade: string | null | undefined) => {
    if (!grade) return undefined;
    const vGradeMatch = grade.match(/V\d+/i);
    if (vGradeMatch) {
      return ({ V3: '#FF7043', V6: '#E53935' } as Record<string, string>)[vGradeMatch[0].toUpperCase()];
    }
    const fontGradeMatch = grade.match(/\d[abc]\+?/i);
    if (fontGradeMatch) {
      return ({ '6a': '#FF7043', '6a+': '#FF7043', '7a': '#E53935' } as Record<string, string>)[
        fontGradeMatch[0].toLowerCase()
      ];
    }
    return undefined;
  },
  GradeDisplayFormat: {},
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    colors: { success: '#4caf50', error: '#f44336' },
    neutral: { 300: '#e0e0e0' },
  },
}));

// ── Shared test data ───────────────────────────────────────────────────────

const entries: LogbookEntry[] = [
  {
    climbed_at: '2025-01-15T10:00:00Z',
    difficulty: 16,
    tries: 1,
    angle: 40,
    status: 'flash',
    climbUuid: 'a',
  },
  {
    climbed_at: '2025-01-15T11:00:00Z',
    difficulty: 22,
    tries: 3,
    angle: 40,
    status: 'send',
    climbUuid: 'b',
  },
  {
    climbed_at: '2025-01-15T12:00:00Z',
    difficulty: 17,
    tries: 1,
    angle: 40,
    status: 'flash',
    climbUuid: 'c',
  },
];

// ── buildAggregatedStackedBars with Font format ────────────────────────────

describe('buildAggregatedStackedBars with font format', () => {
  const ticks: Record<string, LogbookEntry[]> = {
    kilter: entries.map((e) => ({ ...e, layoutId: 1, boardType: 'kilter' })),
  };

  it('uses Font grade labels (6A, 6A+, 7A) instead of V-grade labels', () => {
    const result = buildAggregatedStackedBars(ticks, 'all', 'font');
    expect(result).not.toBeNull();

    const labels = result!.bars.map((b) => b.label);
    expect(labels).toContain('6A');
    expect(labels).toContain('6A+');
    expect(labels).toContain('7A');
    // V-grade labels must not appear
    expect(labels).not.toContain('V3');
    expect(labels).not.toContain('V6');
  });

  it('sorts bars by Font grade order (6A before 6A+ before 7A)', () => {
    const result = buildAggregatedStackedBars(ticks, 'all', 'font');
    expect(result).not.toBeNull();

    const labels = result!.bars.map((b) => b.label);
    expect(labels).toEqual(['6A', '6A+', '7A']);
  });
});

// ── buildWeeklyBars with Font format ───────────────────────────────────────

describe('buildWeeklyBars with font format', () => {
  it('uses Font grade labels in segment labels', () => {
    const result = buildWeeklyBars(entries, undefined, undefined, 'font');
    expect(result).not.toBeNull();

    const segmentLabels = new Set(result!.flatMap((bar) => bar.segments.map((s) => s.label)));
    expect(segmentLabels.has('6A')).toBe(true);
    expect(segmentLabels.has('7A')).toBe(true);
    expect(segmentLabels.has('V3')).toBe(false);
    expect(segmentLabels.has('V6')).toBe(false);
  });

  it('sorts active grades by Font order', () => {
    const result = buildWeeklyBars(entries, undefined, undefined, 'font');
    expect(result).not.toBeNull();

    const bar = result![0];
    const segmentLabels = bar.segments.map((s) => s.label);
    const idx6A = segmentLabels.indexOf('6A');
    const idx6APlus = segmentLabels.indexOf('6A+');
    const idx7A = segmentLabels.indexOf('7A');
    expect(idx6A).toBeLessThan(idx6APlus);
    expect(idx6APlus).toBeLessThan(idx7A);
  });
});

describe('buildWeeklyBars with combined grade format', () => {
  it('uses grade colors for combined V and Font segment keys', () => {
    const result = buildWeeklyBars(entries, undefined, undefined, 'both');
    expect(result).not.toBeNull();

    const segments = result!.flatMap((bar) => bar.segments);
    expect(segments.map((segment) => segment.label)).toEqual(expect.arrayContaining(['V3 / 6A', 'V6 / 7A']));
    expect(segments.every((segment) => segment.color !== 'hsla(0, 0%, 78%, 0.7)')).toBe(true);
  });
});

// ── buildFlashRedpointBars with Font format ────────────────────────────────

describe('buildFlashRedpointBars with font format', () => {
  it('uses Font grade labels for bar keys and labels', () => {
    const result = buildFlashRedpointBars(entries, 'font');
    expect(result).not.toBeNull();

    const labels = result!.map((b) => b.label);
    expect(labels).toContain('6A');
    expect(labels).toContain('6A+');
    expect(labels).toContain('7A');
    expect(labels).not.toContain('V3');
    expect(labels).not.toContain('V6');
  });

  it('sorts bars by Font grade order', () => {
    const result = buildFlashRedpointBars(entries, 'font');
    expect(result).not.toBeNull();

    const labels = result!.map((b) => b.label);
    expect(labels).toEqual(['6A', '6A+', '7A']);
  });
});

// ── buildStatisticsSummary with Font format ────────────────────────────────

describe('buildStatisticsSummary with font format', () => {
  it('maps numeric grade keys to Font labels in layout grades', () => {
    const profileStats = {
      totalDistinctClimbs: 10,
      layoutStats: [
        {
          layoutKey: 'kilter-1',
          boardType: 'kilter',
          layoutId: 1,
          distinctClimbCount: 10,
          gradeCounts: [
            { grade: '16', count: 3 }, // 6A
            { grade: '17', count: 2 }, // 6A+
            { grade: '22', count: 5 }, // 7A
          ],
        },
      ],
    };

    const { layoutPercentages } = buildStatisticsSummary(profileStats, 'font');
    const grades = layoutPercentages[0].grades;
    expect(grades).toEqual({ '6A': 3, '6A+': 2, '7A': 5 });
    // V-grade keys must not appear
    expect(grades).not.toHaveProperty('V3');
    expect(grades).not.toHaveProperty('V6');
  });
});

// ── Comparison: same data with v-grade format still produces V-grade labels ──

describe('v-grade format comparison (default behavior)', () => {
  it('buildAggregatedStackedBars with v-grade uses V3, V6 labels', () => {
    const ticks: Record<string, LogbookEntry[]> = {
      kilter: entries.map((e) => ({ ...e, layoutId: 1, boardType: 'kilter' })),
    };
    const result = buildAggregatedStackedBars(ticks, 'all', 'v-grade');
    expect(result).not.toBeNull();

    const labels = result!.bars.map((b) => b.label);
    // difficulty 16 and 17 both map to V3, so there are only two distinct bars
    expect(labels).toContain('V3');
    expect(labels).toContain('V6');
    expect(labels).not.toContain('6A');
    expect(labels).not.toContain('7A');
  });

  it('buildFlashRedpointBars with v-grade uses V-grade labels', () => {
    const result = buildFlashRedpointBars(entries, 'v-grade');
    expect(result).not.toBeNull();

    const labels = result!.map((b) => b.label);
    expect(labels).toContain('V3');
    expect(labels).toContain('V6');
    expect(labels).not.toContain('6A');
    expect(labels).not.toContain('7A');
  });
});
