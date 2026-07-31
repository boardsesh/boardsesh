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
// the prop contract instead: the FULL occupied span must fit inside the
// measured frame, and the fitted bar/spacing content must fit inside the width
// prop. The library-default fallbacks below mirror gifted-charts-core 0.1.81
// (`AxesAndRulesDefaults.yAxisEmptyLabelWidth = 10`, `yAxisLabelWidth = 35`,
// `endSpacing = spacing`, `BarDefaults.spacing = 20`) so a chart that simply
// omits a prop is still measured at its true rendered size.
import { createElement, useEffect, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGroupedBar } from '@boardsesh/profile-stats';
import type { ColoredBar } from '../profile-chart-colors';

const FRAME_WIDTH = 320;

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
  PixelRatio: { getFontScale: () => 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type BarChartCall = {
  width?: number;
  barWidth?: number;
  spacing?: number;
  initialSpacing?: number;
  endSpacing?: number;
  yAxisLabelWidth?: number;
  hideYAxisText?: boolean;
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

// gifted-charts-core defaults, applied when we omit the prop. Transcribed from
// `AxesAndRulesDefaults` / `BarDefaults` in dist/utils/constants.js at the
// version pinned in bun.lock (0.1.81) — bun's isolated install puts
// gifted-charts-core outside packages/mobile's resolution path, so they can't be
// imported. COUPLING: bumping react-native-gifted-charts can move these, and a
// bump that grows a default would make the charts overflow again while these
// tests stayed green. Re-read dist/utils/constants.js on any such bump.
const GIFTED_DEFAULT_SPACING = 20;
const GIFTED_Y_AXIS_LABEL_WIDTH = 35;
const GIFTED_Y_AXIS_EMPTY_LABEL_WIDTH = 10;

beforeEach(() => {
  barChartCalls.length = 0;
});

/**
 * Horizontal span BarChart actually occupies in its parent: the y-axis gutter it
 * offsets the plot by, plus the `width` it draws into, plus the `endSpacing`
 * the rules/x-axis row extends by. This is the number that must fit the card.
 */
function occupiedSpan(call: BarChartCall): number {
  const barLevelSpacing = call.spacing ?? GIFTED_DEFAULT_SPACING;
  const endSpacing = call.endSpacing ?? barLevelSpacing;
  const yAxisGutter =
    call.yAxisLabelWidth ?? (call.hideYAxisText ? GIFTED_Y_AXIS_EMPTY_LABEL_WIDTH : GIFTED_Y_AXIS_LABEL_WIDTH);
  return yAxisGutter + (call.width ?? 0) + endSpacing;
}

/** Total pixel span the fitted stack-bar data actually occupies. */
function stackedContentSpan(call: BarChartCall): number {
  const count = call.stackData?.length ?? 0;
  const barWidth = call.barWidth ?? 0;
  const spacing = call.spacing ?? 0;
  const initial = call.initialSpacing ?? 0;
  return initial * 2 + count * barWidth + Math.max(0, count - 1) * spacing;
}

/**
 * Same, for the flattened grouped data: `spacing` is carried per-datum there
 * rather than as a single BarChart-level prop.
 */
function groupedContentSpan(call: BarChartCall): number {
  const data = call.data ?? [];
  const barWidth = call.barWidth ?? 0;
  const initial = call.initialSpacing ?? 0;
  const gaps = data.reduce((total, datum) => total + (datum.spacing ?? 0), 0);
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
    expect(call.width).toBeGreaterThan(0);
    expect(occupiedSpan(call)).toBeLessThanOrEqual(FRAME_WIDTH);
  });

  it('sizes bars to fit inside the width actually given to BarChart', () => {
    render(<StackedBarChart bars={bars} colorBy="layout" showYAxisScale />);

    const call = barChartCalls[0]!;
    // The fitted content must also not exceed the canvas BarChart was told to
    // draw into, or the last bar is clipped by the plot ScrollView at zoom 1.
    expect(stackedContentSpan(call)).toBeLessThanOrEqual(call.width!);
  });

  it('stays inside the frame without the y-axis scale too', () => {
    render(<StackedBarChart bars={bars} colorBy="layout" />);

    const call = barChartCalls[0]!;
    expect(call.yAxisLabelWidth).toBe(0);
    expect(occupiedSpan(call)).toBeLessThanOrEqual(FRAME_WIDTH);
    expect(stackedContentSpan(call)).toBeLessThanOrEqual(call.width!);
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
    expect(call.width).toBeGreaterThan(0);
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
  });

  it('sizes grouped bars to fit inside the width actually given to BarChart', () => {
    render(<GroupedBarChart bars={groupedBars} />);

    const call = barChartCalls[0]!;
    expect(call.data?.length).toBe(groupedBars.length * 2);
    expect(groupedContentSpan(call)).toBeLessThanOrEqual(call.width!);
  });
});
