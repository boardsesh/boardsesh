// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
//
// No grade is ever cut short in the app. The Progress grade distribution and
// Flash vs Redpoint axes clipped "V10 / 7A+" to "V1…": gifted boxes each axis
// label to one bar. Grade axes now print whole grades only, stacking V over
// Font and skipping bars when the row is crowded.
import { createElement, useEffect, type ReactElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGroupedBar } from '@boardsesh/profile-stats';
import type { ColoredBar } from '../profile-chart-colors';
import { estimateLabelWidth } from '../../../lib/chart/label-metrics';

const FRAME_WIDTH = 320;
const getFontScaleMock = vi.hoisted(() => vi.fn(() => 1));
const frameLayout = vi.hoisted(() => ({ width: 320, onLayout: null as ((event: unknown) => void) | null }));

// Minimal RN surface — mirrors you-charts-tap-tooltip.test.tsx's mock so
// ChartFrame's width-gated render path reaches the chart under test.
// PixelRatio is needed because GroupedBarChart reads PixelRatio.getFontScale()
// for its top-label rotation layout (#3779).
vi.mock('react-native', () => ({
  View: ({
    children,
    onLayout,
    testID,
  }: {
    children?: ReactNode;
    onLayout?: (event: unknown) => void;
    testID?: string;
  }) => {
    if (onLayout) frameLayout.onLayout = onLayout;
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: frameLayout.width, height: 160, x: 0, y: 0 } } });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount, matching a real layout pass
    }, []);
    return createElement('div', { 'data-testid': testID }, children);
  },
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', { type: 'button' }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  PixelRatio: { getFontScale: getFontScaleMock },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type AxisLabelDatum = { label?: string; labelWidth?: number; labelComponent?: () => ReactElement };
type BarChartCall = {
  height?: number;
  xAxisTextNumberOfLines?: number;
  stackData?: AxisLabelDatum[];
  data?: AxisLabelDatum[];
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
  useOptionalTheme: () => null,
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
  frameLayout.width = FRAME_WIDTH;
  frameLayout.onLayout = null;
});

const FONT = [
  '4A',
  '5A',
  '5C',
  '6A',
  '6B',
  '6C',
  '7A',
  '7A+',
  '7B',
  '7B+',
  '7C',
  '7C+',
  '8A',
  '8A+',
  '8B',
  '8B+',
  '8C',
];
/** V0 to V16 in the both-formats style ("V10 / 7C+"), the widest a grade gets. */
const BOTH_FORMAT_GRADES = FONT.map((font, index) => `V${index} / ${font}`);

/** What each bar's axis label renders: its lines and the box width it asked for. */
function renderedAxisLabels(data: AxisLabelDatum[]): { lines: string[]; width: number }[] {
  return data.flatMap((datum) => {
    if (!datum.labelComponent) return [];
    const element = datum.labelComponent();
    const { container, unmount } = render(element);
    const lines = Array.from(container.querySelectorAll('span'), (span) => span.textContent ?? '');
    unmount();
    return [{ lines, width: (element.props as { width: number }).width }];
  });
}

function expectWholeGrades(labels: { lines: string[]; width: number }[], grades: string[]) {
  expect(labels.length).toBeGreaterThan(0);
  const pieces = new Set(grades.flatMap((grade) => [grade, ...grade.split(' / ')]));
  for (const { lines, width } of labels) {
    for (const line of lines) {
      expect(pieces.has(line)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(estimateLabelWidth(line));
    }
  }
}

describe('grade axis labels are never truncated', () => {
  it('stacks a crowded grade distribution instead of clipping it', () => {
    const bars: ColoredBar[] = BOTH_FORMAT_GRADES.map((grade, index) => ({
      key: grade,
      label: grade,
      segments: [{ key: 'tension-1', label: 'Tension Classic', value: index + 1 }],
    }));
    render(<StackedBarChart bars={bars} colorBy="layout" gradeAxis showYAxisScale />);

    const call = barChartCalls[0]!;
    // gifted's own label text is blanked; the grade lives in labelComponent.
    expect(call.stackData!.every((datum) => datum.label === '')).toBe(true);
    expect(call.xAxisTextNumberOfLines).toBe(2);
    const labels = renderedAxisLabels(call.stackData!);
    expectWholeGrades(labels, BOTH_FORMAT_GRADES);
    expect(labels.every(({ lines }) => lines.length === 2)).toBe(true);
    expect(labels.map(({ lines }) => lines[0])).toContain('V10');
  });

  it('labels every bar on one line when there is room', () => {
    const bars: ColoredBar[] = ['V3', 'V4', 'V5'].map((grade) => ({
      key: grade,
      label: grade,
      segments: [{ key: 'kilter-1', label: 'Kilter Original', value: 2 }],
    }));
    render(<StackedBarChart bars={bars} colorBy="grade" gradeAxis />);

    const call = barChartCalls[0]!;
    expect(call.xAxisTextNumberOfLines).toBe(1);
    expect(renderedAxisLabels(call.stackData!).map(({ lines }) => lines)).toEqual([['V3'], ['V4'], ['V5']]);
  });

  it('keeps flash vs redpoint grades whole', () => {
    const bars: RawGroupedBar[] = BOTH_FORMAT_GRADES.map((grade, index) => ({
      key: grade,
      label: grade,
      values: [
        { key: 'flash', label: 'Flash', value: index },
        { key: 'redpoint', label: 'Redpoint', value: index + 1 },
      ],
    }));
    render(<GroupedBarChart bars={bars} />);

    const call = barChartCalls[0]!;
    expectWholeGrades(renderedAxisLabels(call.data!), BOTH_FORMAT_GRADES);
    // Only the first bar of each flash|redpoint pair carries the grade.
    expect(call.data!.filter((_, index) => index % 2 === 1).every((datum) => !datum.labelComponent)).toBe(true);
  });
});
