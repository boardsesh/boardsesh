import { describe, expect, it, vi } from 'vitest';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));

import { DARK_GRADE_REFERENCE_SURFACE } from '@boardsesh/board-constants/grade-colors';
import { compositeOver, contrastRatio } from '@boardsesh/board-constants/readable-text-color';
import {
  buildSessionGradeBars,
  gradeBadgeColor,
  gradeChartColor,
  gradeMarkColor,
  gradeTextColor,
  gradeTextOnTintColor,
  GRADE_TINT_ALPHA,
  layoutChartColor,
} from '../profile-chart-colors';

const HARD_GRADES = ['V5', 'V8', 'V10', 'V12', 'V14', 'V16', '7C', '8C+'];

function gradeItem(overrides: Partial<SessionGradeDistributionItem> = {}): SessionGradeDistributionItem {
  return { grade: 'V4', flash: 0, send: 0, attempt: 0, ...overrides };
}

describe('profile chart colors', () => {
  it('uses opaque grade chart colors for light and dark schemes', () => {
    expect(gradeChartColor('V4', 'light')).toMatch(/^hsl\(/);
    expect(gradeChartColor('V4', 'dark')).toMatch(/^hsl\(/);
    expect(gradeChartColor('V4', 'light')).not.toContain('0.');
    expect(gradeChartColor('V4', 'dark')).not.toContain('0.');
  });

  it('resolves combined grade labels to grade chart colors', () => {
    expect(gradeChartColor('V8 / 7B', 'light')).toMatch(/^hsl\(/);
    expect(gradeChartColor('V3+ / 6A+', 'dark')).toMatch(/^hsl\(/);
    expect(gradeChartColor('6A+', 'light')).toMatch(/^hsl\(/);
    expect(gradeChartColor('not-a-grade', 'light')).toBe('#5F5868');
    expect(gradeChartColor('not-a-grade', 'dark')).toBe('#B8B2C4');
  });

  it('uses scheme-aware categorical layout colors', () => {
    expect(layoutChartColor('kilter-1', 'light')).toBe('#0284C7');
    expect(layoutChartColor('kilter-1', 'dark')).toBe('#38BDF8');
    expect(layoutChartColor('unknown-layout', 'light')).toMatch(/^#/);
    expect(layoutChartColor('unknown-layout', 'dark')).toMatch(/^#/);
    expect(layoutChartColor('unknown-layout', 'light')).not.toBe(layoutChartColor('unknown-layout', 'dark'));
  });
});

describe('buildSessionGradeBars with splitFlash', () => {
  it('splits a grade with both sends and flashes into a muted send base and a vivid flash cap', () => {
    const bars = buildSessionGradeBars([gradeItem({ grade: 'V4', send: 3, flash: 2 })], undefined, {
      splitFlash: true,
      colorScheme: 'light',
    });

    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(1);
    const [bar] = bars ?? [];
    expect(bar.segments).toHaveLength(2);

    // segments[0] is the bottom of the stack — the muted send (redpoint) base.
    expect(bar.segments[0]).toMatchObject({ value: 3, key: 'V4', color: gradeChartColor('V4', 'light') });
    expect(bar.segments[0].color).toMatch(/^hsl\(/);

    // segments[1] is pushed last so it caps the top of the stack — the vivid flash.
    // In light mode the mark colour is the raw badge colour.
    expect(bar.segments[1]).toMatchObject({ value: 2, key: 'V4', color: gradeMarkColor('V4', 'light') });
    expect(gradeMarkColor('V4', 'light')).toBe(gradeBadgeColor('V4'));
    // V4 resolves to its vivid badge hex (#FF5026), not the muted hsl().
    expect(bar.segments[1].color).toBe('#FF5026');
  });

  it('emits a single send segment when there are no flashes', () => {
    const bars = buildSessionGradeBars([gradeItem({ grade: 'V4', send: 5, flash: 0 })], undefined, {
      splitFlash: true,
      colorScheme: 'light',
    });

    expect(bars).toHaveLength(1);
    const [bar] = bars ?? [];
    expect(bar.segments).toHaveLength(1);
    expect(bar.segments[0]).toMatchObject({ value: 5, color: gradeChartColor('V4', 'light') });
  });

  it('emits a single flash cap segment when there are no sends', () => {
    const bars = buildSessionGradeBars([gradeItem({ grade: 'V4', send: 0, flash: 4 })], undefined, {
      splitFlash: true,
      colorScheme: 'light',
    });

    expect(bars).toHaveLength(1);
    const [bar] = bars ?? [];
    expect(bar.segments).toHaveLength(1);
    expect(bar.segments[0]).toMatchObject({ value: 4, color: gradeMarkColor('V4', 'light') });
  });

  it('drops grades with no ascents and returns null for an entirely empty distribution', () => {
    expect(buildSessionGradeBars([], undefined, { splitFlash: true, colorScheme: 'light' })).toBeNull();
    expect(
      buildSessionGradeBars([gradeItem({ grade: 'V4', send: 0, flash: 0 })], undefined, {
        splitFlash: true,
        colorScheme: 'light',
      }),
    ).toBeNull();
  });

  it('orders bars easy to hard regardless of input order', () => {
    const bars = buildSessionGradeBars(
      [gradeItem({ grade: 'V6', send: 1 }), gradeItem({ grade: 'V2', send: 1 }), gradeItem({ grade: 'V4', send: 1 })],
      undefined,
      { splitFlash: true, colorScheme: 'light' },
    );

    expect((bars ?? []).map((bar) => bar.key)).toEqual(['V2', 'V4', 'V6']);
  });

  it('applies formatGrade to the segment label while keeping the grade key', () => {
    const bars = buildSessionGradeBars([gradeItem({ grade: 'V4', send: 1, flash: 1 })], (grade) => `Grade ${grade}`, {
      splitFlash: true,
      colorScheme: 'light',
    });

    const [bar] = bars ?? [];
    expect(bar.label).toBe('Grade V4');
    expect(bar.key).toBe('V4');
    expect(bar.segments.every((segment) => segment.label === 'Grade V4')).toBe(true);
  });
});

describe('buildSessionGradeBars default (no splitFlash) — regression guard', () => {
  it('produces a single vivid total segment per grade (SessionGradeChart / SessionFeedCard shape)', () => {
    const bars = buildSessionGradeBars([gradeItem({ grade: 'V4', send: 3, flash: 2 })], undefined, {
      colorScheme: 'light',
    });

    expect(bars).toHaveLength(1);
    const [bar] = bars ?? [];
    expect(bar.segments).toHaveLength(1);
    // total = flash + send, drawn in the vivid grade colour.
    expect(bar.segments[0]).toMatchObject({ value: 5, key: 'V4', color: gradeBadgeColor('V4') });
    expect(bar.segments[0].color).toBe('#FF5026');
  });

  it('returns null for an empty distribution', () => {
    expect(buildSessionGradeBars([], undefined, { colorScheme: 'light' })).toBeNull();
  });
});

describe('buildSessionGradeBars in dark mode', () => {
  const distribution = HARD_GRADES.map((grade) => gradeItem({ grade, send: 2, flash: 1 }));

  it('lifts every solid bar to at least 3:1 against the dark surface', () => {
    const bars = buildSessionGradeBars(distribution, undefined, { colorScheme: 'dark' }) ?? [];
    expect(bars).toHaveLength(HARD_GRADES.length);
    for (const bar of bars) {
      const color = bar.segments[0].color ?? '';
      expect(color).toBe(gradeMarkColor(bar.key, 'dark'));
      expect(contrastRatio(color, DARK_GRADE_REFERENCE_SURFACE)).toBeGreaterThanOrEqual(3);
    }
  });

  it('lifts the split flash cap to at least 3:1 and keeps the muted send base', () => {
    const bars = buildSessionGradeBars(distribution, undefined, { splitFlash: true, colorScheme: 'dark' }) ?? [];
    for (const bar of bars) {
      const [sendBase, flashCap] = bar.segments;
      expect(sendBase.color).toBe(gradeChartColor(bar.key, 'dark'));
      expect(contrastRatio(flashCap.color ?? '', DARK_GRADE_REFERENCE_SURFACE)).toBeGreaterThanOrEqual(3);
    }
  });

  it('changes the V16 bar (1.1:1 raw) but leaves the light-mode bar raw', () => {
    const [darkBar] =
      buildSessionGradeBars([gradeItem({ grade: 'V16', send: 1 })], undefined, { colorScheme: 'dark' }) ?? [];
    const [lightBar] =
      buildSessionGradeBars([gradeItem({ grade: 'V16', send: 1 })], undefined, { colorScheme: 'light' }) ?? [];
    expect(lightBar.segments[0].color).toBe(gradeBadgeColor('V16'));
    expect(darkBar.segments[0].color).not.toBe(gradeBadgeColor('V16'));
  });
});

describe('gradeTextColor / gradeMarkColor', () => {
  it('return the raw badge colour in light mode', () => {
    for (const grade of HARD_GRADES) {
      expect(gradeTextColor(grade, 'light')).toBe(gradeBadgeColor(grade));
      expect(gradeMarkColor(grade, 'light')).toBe(gradeBadgeColor(grade));
    }
  });

  it('clear 4.5:1 (text) and 3:1 (mark) against the dark surface for hard grades', () => {
    for (const grade of HARD_GRADES) {
      expect(contrastRatio(gradeTextColor(grade, 'dark'), DARK_GRADE_REFERENCE_SURFACE)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(gradeMarkColor(grade, 'dark'), DARK_GRADE_REFERENCE_SURFACE)).toBeGreaterThanOrEqual(3);
    }
  });

  it('resolves combined board labels and unknown grades like gradeBadgeColor', () => {
    expect(gradeTextColor('6B+/V4', 'light')).toBe(gradeBadgeColor('6B+/V4'));
    expect(gradeTextColor(null, 'light')).toBe(gradeBadgeColor(null));
    expect(contrastRatio(gradeTextColor(null, 'dark'), DARK_GRADE_REFERENCE_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('gradeTextOnTintColor', () => {
  const grades = ['V0', 'V4', 'V6', 'V10', 'V13', 'V16', '7a', '8c+'];

  it('clears 4.5:1 on the grade tint over the reference surface in dark mode', () => {
    for (const grade of grades) {
      const tint = compositeOver(gradeBadgeColor(grade), GRADE_TINT_ALPHA, DARK_GRADE_REFERENCE_SURFACE);
      const text = gradeTextOnTintColor(grade, 'dark', GRADE_TINT_ALPHA);
      expect(contrastRatio(text, tint), grade).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('returns the raw grade colour in light mode', () => {
    for (const grade of grades) {
      expect(gradeTextOnTintColor(grade, 'light', GRADE_TINT_ALPHA)).toBe(gradeBadgeColor(grade));
    }
  });
});
