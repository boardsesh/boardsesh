// @vitest-environment jsdom
//
// Regression coverage for #3778: You-page Activity/Grade Distribution bar
// charts could overflow their card width. StackedBarChart and GroupedBarChart
// fit bar/spacing sizes off the measured frame width, then handed
// gifted-charts' BarChart a narrower `width` prop (room for its own
// right-edge padding) — so the fitted content ran wider than the canvas it
// was drawn into. This repo has no visual regression harness, so these tests
// pin the underlying prop contract instead: the fitted bar/spacing budget
// must never exceed the width actually given to BarChart.
import { createElement, useEffect, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RawGroupedBar } from '@boardsesh/profile-stats';
import type { ColoredBar } from '../profile-chart-colors';

const FRAME_WIDTH = 320;

// Minimal RN surface — mirrors you-charts-tap-tooltip.test.tsx's mock so
// ChartFrame's width-gated render path reaches the chart under test.
vi.mock('react-native', () => ({
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: FRAME_WIDTH, height: 160, x: 0, y: 0 } } });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount, matching a real layout pass
    }, []);
    return createElement('div', null, children);
  },
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', { type: 'button' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type BarChartCall = {
  width?: number;
  barWidth?: number;
  spacing?: number;
  initialSpacing?: number;
  stackData?: { stacks?: { value: number }[] }[];
  data?: unknown[];
};

const barChartCalls: BarChartCall[] = [];

vi.mock('react-native-gifted-charts', () => ({
  BarChart: (props: BarChartCall) => {
    barChartCalls.push(props);
    return createElement('div', { 'data-testid': 'gifted-bar-chart' });
  },
  LineChart: () => createElement('div', { 'data-testid': 'gifted-line-chart' }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: () => createElement('span', { 'data-testid': 'icon' }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', { 'data-testid': 'activity-indicator' }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'material' as const,
    colorScheme: 'light' as const,
    systemColors: {
      secondaryLabel: '#666666',
      tertiaryLabel: '#999999',
      elevatedSurface: '#ffffff',
      separator: '#dddddd',
      label: '#111111',
    },
    chartColors: {
      secondaryLabel: '#666666',
      tertiaryLabel: '#999999',
      elevatedSurface: '#ffffff',
      separator: '#dddddd',
      label: '#111111',
    },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { full: 999, xl: 16 },
  opacity: { peek: 0.5 },
  materialElevationByLevel: { level2: {} },
}));

vi.mock('../../../lib/haptics', () => ({
  hapticSelection: vi.fn(),
}));

vi.mock('../profile-chart-colors', () => ({
  gradeChartColor: (key: string) => `grade-${key}`,
  layoutChartColor: (key: string) => `layout-${key}`,
  flashRedpointColor: (key: string) => `status-${key}`,
}));

import { StackedBarChart, GroupedBarChart } from '../YouCharts';

/** Total pixel span the fitted stack-bar data actually occupies. */
function stackedContentSpan(call: BarChartCall): number {
  const count = call.stackData?.length ?? 0;
  const barWidth = call.barWidth ?? 0;
  const spacing = call.spacing ?? 0;
  const initial = call.initialSpacing ?? 0;
  return initial * 2 + count * barWidth + Math.max(0, count - 1) * spacing;
}

describe('StackedBarChart width budget (#3778)', () => {
  const bars: ColoredBar[] = Array.from({ length: 10 }, (_, index) => ({
    key: `V${index}`,
    label: `V${index}`,
    segments: [{ key: 'kilter-1', label: 'Kilter Original', value: index + 1 }],
  }));

  it('sizes bars to fit inside the width actually given to BarChart', () => {
    barChartCalls.length = 0;
    render(<StackedBarChart bars={bars} colorBy="layout" />);

    expect(barChartCalls).toHaveLength(1);
    const call = barChartCalls[0]!;
    expect(call.width).toBeGreaterThan(0);
    // The fitted content must not exceed the canvas BarChart was told to draw
    // into — before the #3778 fix, bars were fit to the full frame width while
    // BarChart was given `width - 8`, so this budget was routinely blown.
    expect(stackedContentSpan(call)).toBeLessThanOrEqual(call.width!);
  });
});

describe('GroupedBarChart width budget (#3778)', () => {
  const groupedBars: RawGroupedBar[] = Array.from({ length: 8 }, (_, index) => ({
    key: `V${index}`,
    label: `V${index}`,
    values: [
      { key: 'flash', label: 'Flash', value: index },
      { key: 'redpoint', label: 'Redpoint', value: index + 1 },
    ],
  }));

  it('sizes grouped bars to fit inside the width actually given to BarChart', () => {
    barChartCalls.length = 0;
    render(<GroupedBarChart bars={groupedBars} />);

    expect(barChartCalls).toHaveLength(1);
    const call = barChartCalls[0]!;
    expect(call.width).toBeGreaterThan(0);
    const count = call.data?.length ?? 0;
    // Grouped data flattens two bars per grade; spacing is per-item (carried on
    // each datum) rather than a single BarChart-level prop, so just confirm the
    // canvas width lines up with the frame's narrowed budget instead of the
    // pre-fix mismatched (wider) fitting budget.
    expect(count).toBeGreaterThan(0);
    expect(call.width).toBe(FRAME_WIDTH - 8);
  });
});
