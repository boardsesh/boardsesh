// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';

type ChartBar = { key: string; label: string; segments: Array<{ value: number; key: string; color?: string }> };

// Capture what SessionAnalyticsSection feeds the chart so we can assert the bars
// are real grade-coloured bars and that there's exactly one chart (no second
// flash-vs-redpoint chart). buildSessionGradeBars/gradeBadgeColor stay real so
// the colours under test are the production ones.
const chart = vi.hoisted(() => ({ renderCount: 0, bars: null as ChartBar[] | null, legendCount: 0 }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  // theme/colors (pulled in transitively by profile-chart-colors) reads these.
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'chart-card' }, children),
}));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('div', { 'data-testid': 'section-header' }, title),
}));
vi.mock('../../you/YouCharts', () => ({
  StackedBarChart: ({ bars, legend }: { bars: ChartBar[] | null; legend?: unknown[] }) => {
    chart.renderCount += 1;
    chart.bars = bars;
    chart.legendCount = legend?.length ?? 0;
    return createElement('div', { 'data-testid': 'stacked-bar-chart' });
  },
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ colorScheme: 'light' }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16 } }));

import { SessionAnalyticsSection } from '../SessionAnalyticsSection';
import { gradeBadgeColor } from '../../you/profile-chart-colors';

const distribution: SessionGradeDistributionItem[] = [{ grade: 'V4', flash: 2, send: 3, attempt: 0 }];

beforeEach(() => {
  chart.renderCount = 0;
  chart.bars = null;
  chart.legendCount = 0;
});

describe('SessionAnalyticsSection', () => {
  it('renders one solid grade-coloured chart (a grade pyramid, no flash/redpoint split or legend)', () => {
    const { getAllByTestId } = render(createElement(SessionAnalyticsSection, { gradeDistribution: distribution }));

    expect(getAllByTestId('stacked-bar-chart')).toHaveLength(1);
    expect(chart.renderCount).toBe(1);

    // Solid bars: one segment per grade (flash + send combined = 5) in the grade's
    // vivid colour. No two-shade split.
    expect(chart.bars).not.toBeNull();
    expect(chart.bars).toHaveLength(1);
    const [bar] = chart.bars ?? [];
    expect(bar.key).toBe('V4');
    expect(bar.segments.map((segment) => segment.value)).toEqual([5]);
    expect(bar.segments[0].color).toBe(gradeBadgeColor('V4'));

    // No legend — the grade hue + x-axis label carry it.
    expect(chart.legendCount).toBe(0);
  });

  it('renders nothing when the distribution is empty', () => {
    const { container } = render(createElement(SessionAnalyticsSection, { gradeDistribution: [] }));
    expect(container.querySelector('[data-testid="stacked-bar-chart"]')).toBeNull();
    expect(chart.renderCount).toBe(0);
  });

  it('renders nothing when grades have only attempts (no sends or flashes to chart)', () => {
    const { container } = render(
      createElement(SessionAnalyticsSection, {
        gradeDistribution: [{ grade: 'V4', flash: 0, send: 0, attempt: 3 }],
      }),
    );
    expect(container.querySelector('[data-testid="stacked-bar-chart"]')).toBeNull();
    expect(chart.renderCount).toBe(0);
  });
});
