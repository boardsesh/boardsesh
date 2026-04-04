import { describe, it, expect, vi } from 'vitest';

vi.mock('@/app/lib/grade-colors', () => ({
  formatVGrade: (grade: string | null | undefined) => {
    if (!grade) return null;
    const map: Record<string, string> = {
      '4a/V0': 'V0',
      '6a/V3': 'V3',
      '6a+/V3': 'V3+',
      '7a/V6': 'V6',
    };
    return map[grade] ?? null;
  },
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    colors: { success: '#4caf50', error: '#f44336' },
    neutral: { 300: '#e0e0e0' },
  },
}));

import { buildSessionGradeBars, SESSION_GRADE_LEGEND } from '../session-grade-bars';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';

describe('buildSessionGradeBars', () => {
  it('returns empty array for empty input', () => {
    expect(buildSessionGradeBars([])).toEqual([]);
  });

  it('reverses input order (hardest-first → easiest-first)', () => {
    const input: SessionGradeDistributionItem[] = [
      { grade: '7a/V6', flash: 1, send: 0, attempt: 0 },
      { grade: '6a/V3', flash: 0, send: 1, attempt: 0 },
      { grade: '4a/V0', flash: 0, send: 0, attempt: 2 },
    ];

    const bars = buildSessionGradeBars(input);
    expect(bars.map((b) => b.key)).toEqual(['4a/V0', '6a/V3', '7a/V6']);
  });

  it('formats labels as V-grades via formatVGrade', () => {
    const input: SessionGradeDistributionItem[] = [
      { grade: '6a+/V3', flash: 1, send: 0, attempt: 0 },
      { grade: '4a/V0', flash: 0, send: 1, attempt: 0 },
    ];

    const bars = buildSessionGradeBars(input);
    expect(bars[0].label).toBe('V0');
    expect(bars[1].label).toBe('V3+');
  });

  it('falls back to raw grade when formatVGrade returns null', () => {
    const input: SessionGradeDistributionItem[] = [
      { grade: 'unknown-grade', flash: 1, send: 0, attempt: 0 },
    ];

    const bars = buildSessionGradeBars(input);
    expect(bars[0].label).toBe('unknown-grade');
  });

  it('produces exactly 3 segments per bar in flash/send/attempt order', () => {
    const input: SessionGradeDistributionItem[] = [
      { grade: '6a/V3', flash: 3, send: 2, attempt: 5 },
    ];

    const bars = buildSessionGradeBars(input);
    expect(bars).toHaveLength(1);

    const segments = bars[0].segments;
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ value: 3, label: 'Flash' });
    expect(segments[1]).toMatchObject({ value: 2, label: 'Send' });
    expect(segments[2]).toMatchObject({ value: 5, label: 'Attempt' });
  });

  it('preserves zero values in segments', () => {
    const input: SessionGradeDistributionItem[] = [
      { grade: '6a/V3', flash: 0, send: 0, attempt: 0 },
    ];

    const bars = buildSessionGradeBars(input);
    expect(bars[0].segments.map((s) => s.value)).toEqual([0, 0, 0]);
  });

  it('uses key from original grade string', () => {
    const input: SessionGradeDistributionItem[] = [
      { grade: '6a/V3', flash: 1, send: 0, attempt: 0 },
    ];

    const bars = buildSessionGradeBars(input);
    expect(bars[0].key).toBe('6a/V3');
  });

  it('does not mutate the input array', () => {
    const input: SessionGradeDistributionItem[] = [
      { grade: '7a/V6', flash: 1, send: 0, attempt: 0 },
      { grade: '4a/V0', flash: 0, send: 1, attempt: 0 },
    ];
    const original = [...input];

    buildSessionGradeBars(input);
    expect(input).toEqual(original);
  });
});

describe('SESSION_GRADE_LEGEND', () => {
  it('has 3 entries: Flash, Send, Attempt', () => {
    expect(SESSION_GRADE_LEGEND).toHaveLength(3);
    expect(SESSION_GRADE_LEGEND.map((e) => e.label)).toEqual(['Flash', 'Send', 'Attempt']);
  });

  it('each entry has a non-empty color string', () => {
    for (const entry of SESSION_GRADE_LEGEND) {
      expect(typeof entry.color).toBe('string');
      expect(entry.color.length).toBeGreaterThan(0);
    }
  });
});
