// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookDayStats } from '@boardsesh/logbook';

// Renders the date anchor + conditional rollup. The bucketing/label DECISIONS
// live in @boardsesh/logbook (day-rows.test.ts); this covers the component's
// own rendering: which label kind shows, and that an incomplete day (stats
// null, page boundary) renders its date with NO rollup — a partial count would
// lie, including to VoiceOver.

vi.mock('react-native', () => ({
  View: ({ children, ...props }: { children?: ReactNode }) => createElement('div', props, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; grade?: string }) =>
      options?.count != null ? `${key}:${options.count}` : options?.grade != null ? `${key}:${options.grade}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 8 }),
  borderRadius: { md: 8 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    brandColors: { primary: '#6D28D9' },
    systemColors: { secondaryLabel: '#666' },
  }),
}));
vi.mock('../../../theme/variants', () => ({
  selectByVariant: (_variant: string, options: Record<string, unknown>) => options.liquidGlass,
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string | null | undefined) => grade ?? null }),
}));

import { LogbookDayDivider } from '../LogbookDayDivider';

const startOfToday = () => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};
const DAY_MS = 24 * 60 * 60 * 1000;

const stats = (overrides: Partial<LogbookDayStats> = {}): LogbookDayStats => ({
  climbCount: 6,
  sendCount: 4,
  topDifficulty: 18,
  topDifficultyName: 'V8',
  ...overrides,
});

describe('LogbookDayDivider', () => {
  it('labels today and yesterday via the i18n keys', () => {
    const { container: today } = render(createElement(LogbookDayDivider, { dayStartMs: startOfToday(), stats: null }));
    expect(today.textContent).toContain('mobile.logbook.day.today');

    const { container: yesterday } = render(
      createElement(LogbookDayDivider, { dayStartMs: startOfToday() - DAY_MS, stats: null }),
    );
    expect(yesterday.textContent).toContain('mobile.logbook.day.yesterday');
  });

  it('renders the full rollup for a complete day', () => {
    const { container } = render(createElement(LogbookDayDivider, { dayStartMs: startOfToday(), stats: stats() }));
    expect(container.textContent).toContain('mobile.logbook.day.climbs:6');
    expect(container.textContent).toContain('mobile.logbook.day.sends:4');
    expect(container.textContent).toContain('mobile.logbook.day.top:V8');
  });

  it('omits the sends and top parts for an attempts-only day', () => {
    const { container } = render(
      createElement(LogbookDayDivider, {
        dayStartMs: startOfToday(),
        stats: stats({ sendCount: 0, topDifficulty: null, topDifficultyName: null }),
      }),
    );
    expect(container.textContent).toContain('mobile.logbook.day.climbs:6');
    expect(container.textContent).not.toContain('mobile.logbook.day.sends');
    expect(container.textContent).not.toContain('mobile.logbook.day.top');
  });

  it('renders NO rollup while the day may straddle an unloaded page', () => {
    const { container } = render(createElement(LogbookDayDivider, { dayStartMs: startOfToday(), stats: null }));
    expect(container.textContent).not.toContain('mobile.logbook.day.climbs');
  });

  it('carries the wall on the label for a uniform complete day', () => {
    const { container } = render(
      createElement(LogbookDayDivider, { dayStartMs: startOfToday(), stats: stats(), wallLabel: 'Kilter 40°' }),
    );
    expect(container.textContent).toContain('mobile.logbook.day.today');
    expect(container.textContent).toContain('Kilter 40°');
    expect(container.querySelector('[accessibilityRole="header"]')?.getAttribute('accessibilityLabel')).toContain(
      'mobile.logbook.day.today · Kilter 40°',
    );
  });

  it('marks the anchor as a header for the screen-reader rotor', () => {
    const { container } = render(createElement(LogbookDayDivider, { dayStartMs: startOfToday(), stats: stats() }));
    expect(container.querySelector('[accessibilityRole="header"]')).not.toBeNull();
  });
});
