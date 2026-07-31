// @vitest-environment jsdom
//
// Regression coverage for #3778 / #3050: the You-page Activity and Grade
// Distribution bar charts (and the Flash vs Redpoint grouped chart, same file
// / same bug) bled past the rounded card edge.
//
// gifted-charts does not draw inside the `width` prop it is given. It offsets
// the plot area by `yAxisLabelWidth` to the LEFT of that width and extends the
// rules/x-axis row by `endSpacing` to the RIGHT of it, so the span it really
// occupies is `yAxisLabelWidth + width + endSpacing`. Both You-page charts
// handed it the full measured frame width (minus a token 8px) while also asking
// for a y-axis gutter, so the chart occupied ~22-32px more than the card had.
//
// This repo has no visual regression harness for RN charts, so these tests pin
// every layout prop explicitly: the FULL occupied span must fit inside the
// measured frame, and the fitted bar/spacing content must fit inside `width`.
import { createElement, useEffect, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGroupedBar } from '@boardsesh/profile-stats';
import type { ColoredBar } from '../profile-chart-colors';

const FRAME_WIDTH = 320;
const getFontScaleMock = vi.hoisted(() => vi.fn(() => 1));

// Minimal RN surface — mirrors you-charts-tap-tooltip.test.tsx's mock so
// ChartFrame's width-gated render path reaches the chart under test.
// PixelRatio is needed because GroupedBarChart reads PixelRatio.getFontScale()
// for its top-label rotation layout (#3779).
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
  PixelRatio: { getFontScale: getFontScaleMock },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type BarChartCall = {
  width?: number;
  height?: number;
  barWidth?: number;
  spacing?: number;
  initialSpacing?: number;
  endSpacing?: number;
  yAxisLabelWidth?: number;
  hideYAxisText?: boolean;
  disableScroll?: boolean;
  topLabelContainerStyle?: { width?: number; left?: number };
  stackData?: { stacks?: { value: number }[] }[];
  data?: { spacing?: number }[];
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

beforeEach(() => {
  barChartCalls.length = 0;
  getFontScaleMock.mockReset();
  getFontScaleMock.mockReturnValue(1);
});

/**
 * Horizontal span BarChart actually occupies in its parent: the y-axis gutter it
 * offsets the plot by, plus the `width` it draws into, plus the `endSpacing`
 * the rules/x-axis row extends by. This is the number that must fit the card.
 */
function occupiedSpan(call: BarChartCall): number {
  if (call.yAxisLabelWidth === undefined || call.width === undefined || call.endSpacing === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return call.yAxisLabelWidth + call.width + call.endSpacing;
}

/** Total pixel span the fitted stack-bar data actually occupies. */
function stackedContentSpan(call: BarChartCall): number {
  const count = call.stackData?.length ?? 0;
  const barWidth = call.barWidth ?? 0;
  const spacing = call.spacing ?? 0;
  const initial = call.initialSpacing ?? 0;
  return initial + count * barWidth + Math.max(0, count - 1) * spacing;
}

/**
 * Same, for the flattened grouped data: `spacing` is carried per-datum there
 * rather than as a single BarChart-level prop.
 */
function groupedContentSpan(call: BarChartCall): number {
  const data = call.data ?? [];
  const barWidth = call.barWidth ?? 0;
  const initial = call.initialSpacing ?? 0;
  const gaps = data.slice(0, -1).reduce((total, datum) => total + (datum.spacing ?? 0), 0);
  return initial + data.length * barWidth + gaps;
}

describe('StackedBarChart width budget (#3778, #3050)', () => {
  const bars: ColoredBar[] = Array.from({ length: 10 }, (_, index) => ({
    key: `V${index}`,
    label: `V${index}`,
    segments: [{ key: 'kilter-1', label: 'Kilter Original', value: index + 1 }],
  }));

  it('keeps the whole chart — y-axis gutter included — inside the measured frame', () => {
    // `showYAxisScale` is what ProgressTab passes for Activity and Grade
    // Distribution, the two charts reported in #3778 / #3050. It buys a 32px
    // y-axis gutter that gifted-charts renders OUTSIDE the `width` prop, so it
    // has to be budgeted out of the frame. Pre-fix this was 32 + 312 + 8 = 352
    // against a 320px frame.
    render(<StackedBarChart bars={bars} colorBy="layout" showYAxisScale />);

    expect(barChartCalls).toHaveLength(1);
    const call = barChartCalls[0]!;
    expect(call.width).toBe(FRAME_WIDTH - 8 - 32);
    expect(call.yAxisLabelWidth).toBe(32);
    expect(call.endSpacing).toBe(0);
    expect(call.disableScroll).toBe(true);
    expect(occupiedSpan(call)).toBeLessThanOrEqual(FRAME_WIDTH);
  });

  it('sizes bars to fit inside the width actually given to BarChart', () => {
    render(<StackedBarChart bars={bars} colorBy="layout" showYAxisScale />);

    const call = barChartCalls[0]!;
    expect(call.initialSpacing).toBe(8);
    expect(stackedContentSpan(call)).toBe(call.width);
  });

  it('stays inside the frame without the y-axis scale too', () => {
    render(<StackedBarChart bars={bars} colorBy="layout" />);

    const call = barChartCalls[0]!;
    expect(call.width).toBe(FRAME_WIDTH - 8);
    expect(call.yAxisLabelWidth).toBe(0);
    expect(call.endSpacing).toBe(0);
    expect(occupiedSpan(call)).toBeLessThanOrEqual(FRAME_WIDTH);
    expect(stackedContentSpan(call)).toBeLessThanOrEqual(call.width!);
  });

  it('enables base-scale scrolling when 52 weeks cannot fit above the minimum bar width', () => {
    const weeklyBars: ColoredBar[] = Array.from({ length: 52 }, (_, index) => ({
      key: `week-${index}`,
      label: `W${index + 1}`,
      segments: [{ key: 'kilter-1', label: 'Kilter Original', value: index + 1 }],
    }));

    render(<StackedBarChart bars={weeklyBars} colorBy="layout" showYAxisScale />);

    const call = barChartCalls[0]!;
    expect(stackedContentSpan(call)).toBeGreaterThan(call.width!);
    expect(call.disableScroll).toBe(false);
    expect(occupiedSpan(call)).toBeLessThanOrEqual(FRAME_WIDTH);
  });
});

describe('GroupedBarChart width budget (#3778, #3050)', () => {
  const groupedBars: RawGroupedBar[] = Array.from({ length: 8 }, (_, index) => ({
    key: `V${index}`,
    label: `V${index}`,
    values: [
      { key: 'flash', label: 'Flash', value: index },
      { key: 'redpoint', label: 'Redpoint', value: index + 1 },
    ],
  }));

  it('keeps the whole chart — y-axis gutter included — inside the measured frame', () => {
    render(<GroupedBarChart bars={groupedBars} />);

    expect(barChartCalls).toHaveLength(1);
    const call = barChartCalls[0]!;
    expect(call.width).toBe(FRAME_WIDTH - 8);
    // `hideYAxisText` on its own still reserves gifted-charts'
    // `yAxisEmptyLabelWidth` (10px) outside `width`, and an unset `endSpacing`
    // falls back to the 20px default `spacing` because this chart carries
    // spacing per-datum. Pre-fix that was 10 + 312 + 20 = 342 against a 320px
    // frame.
    expect(occupiedSpan(call)).toBeLessThanOrEqual(FRAME_WIDTH);
  });

  it('pins the y-axis gutter so the library default cannot creep back', () => {
    render(<GroupedBarChart bars={groupedBars} />);

    const call = barChartCalls[0]!;
    expect(call.yAxisLabelWidth).toBe(0);
    expect(call.endSpacing).toBe(0);
    expect(call.disableScroll).toBe(true);
  });

  it('sizes grouped bars to fit inside the width actually given to BarChart', () => {
    render(<GroupedBarChart bars={groupedBars} />);

    const call = barChartCalls[0]!;
    expect(call.data?.length).toBe(groupedBars.length * 2);
    expect(groupedContentSpan(call)).toBeLessThanOrEqual(call.width!);
  });

  it('enables base-scale scrolling when dense grade groups exceed the plot width', () => {
    const denseGroupedBars: RawGroupedBar[] = Array.from({ length: 18 }, (_, index) => ({
      key: `V${index}`,
      label: `V${index}`,
      values: [
        { key: 'flash', label: 'Flash', value: index + 1 },
        { key: 'redpoint', label: 'Redpoint', value: index + 2 },
      ],
    }));

    render(<GroupedBarChart bars={denseGroupedBars} />);

    const call = barChartCalls[0]!;
    expect(groupedContentSpan(call)).toBeGreaterThan(call.width!);
    expect(call.disableScroll).toBe(false);
    expect(occupiedSpan(call)).toBeLessThanOrEqual(FRAME_WIDTH);
  });

  it('preserves PixelRatio-driven top-label headroom from #3779', () => {
    const largeCountBars = groupedBars.map((bar, index) => ({
      ...bar,
      values: bar.values.map((value, valueIndex) => ({
        ...value,
        value: valueIndex === 0 ? 128 - index : 44 - index,
      })),
    }));

    const normalRender = render(<GroupedBarChart bars={largeCountBars} />);
    const normalScaleCall = barChartCalls[0]!;
    normalRender.unmount();

    barChartCalls.length = 0;
    getFontScaleMock.mockReturnValue(2);
    render(<GroupedBarChart bars={largeCountBars} />);
    const accessibilityScaleCall = barChartCalls[0]!;

    expect(accessibilityScaleCall.width).toBe(normalScaleCall.width);
    expect(accessibilityScaleCall.topLabelContainerStyle?.width).toBeGreaterThan(
      normalScaleCall.topLabelContainerStyle?.width ?? 0,
    );
    expect(accessibilityScaleCall.height).toBeLessThan(normalScaleCall.height ?? Number.POSITIVE_INFINITY);
  });
});
