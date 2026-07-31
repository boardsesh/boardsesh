// @vitest-environment jsdom
//
// Regression coverage for issue #2758: a tester on TestFlight build 100220
// (uploaded 2026-06-10) reported that tapping a grade bar on the You page
// showed nothing. That build predates PR #2974 (merged 2026-06-17), which
// added tap-to-reveal tooltips (grade + total + per-segment counts) to
// StackedBarChart and GroupedBarChart. The feature is live on current
// builds, but nothing exercised the actual tap wiring end to end — only the
// pure tooltip-model builders (chart-model.test.ts) were covered, and the
// gifted-charts `onPress`/`onBackgroundPress` callbacks silently had no
// coverage between the initial ship (no interactivity at all) and the fix.
// These tests pin the tap → reveal → dismiss behaviour so it can't regress
// again unnoticed.
import { createElement, useEffect, type MouseEvent, type ReactNode } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RawGroupedBar } from '@boardsesh/profile-stats';
import type { ColoredBar } from '../profile-chart-colors';

// Minimal RN surface. View simulates a native onLayout call (fixed non-zero
// width) so ChartFrame's width-gated render path (`width > 0 ? children(...)
// : null`) actually reaches the chart instead of staying stuck pre-measure.
vi.mock('react-native', () => ({
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 320, height: 160, x: 0, y: 0 } } });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount, matching a real layout pass
    }, []);
    return createElement('div', null, children);
  },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  PixelRatio: { getFontScale: () => 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type MockBarItem = { onPress?: () => void };
type MockBarChartProps = {
  stackData?: MockBarItem[];
  data?: MockBarItem[];
  onBackgroundPress?: () => void;
};

// react-native-gifted-charts' BarChart is the interactive surface under test:
// a bar's `onPress` (carried on `stackData`/`data` items) is exactly what
// StackedBarChart/GroupedBarChart wire to `setSelectedIndex`, and
// `onBackgroundPress` is what clears it. The mock renders one button per bar
// item invoking that item's own `onPress`, plus a background click target —
// faithfully exercising the same callback wiring the real component invokes
// on tap, without pulling in gifted-charts' SVG rendering.
vi.mock('react-native-gifted-charts', () => ({
  BarChart: (props: MockBarChartProps) => {
    const items = props.stackData ?? props.data ?? [];
    return createElement(
      'div',
      { 'data-testid': 'gifted-bar-chart', onClick: () => props.onBackgroundPress?.() },
      items.map((item, index) =>
        createElement('button', {
          key: index,
          type: 'button',
          'data-testid': `gifted-bar-${index}`,
          onClick: (event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            item.onPress?.();
          },
        }),
      ),
    );
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

describe('StackedBarChart tap-to-reveal tooltip (#2758)', () => {
  const bars: ColoredBar[] = [
    {
      key: 'V3',
      label: 'V3',
      segments: [
        { key: 'kilter-1', label: 'Kilter Original', value: 4 },
        { key: 'tension-9', label: 'Tension Original', value: 2 },
      ],
    },
    {
      key: 'V4',
      label: 'V4',
      segments: [{ key: 'kilter-1', label: 'Kilter Original', value: 1 }],
    },
  ];

  it('shows the grade, total, and per-board counts when a bar is tapped', () => {
    const { getByTestId, getByText, queryByText } = render(<StackedBarChart bars={bars} colorBy="layout" />);

    expect(queryByText('V3')).toBeNull();

    fireEvent.click(getByTestId('gifted-bar-0'));

    expect(getByText('V3')).toBeTruthy();
    expect(getByText('6')).toBeTruthy(); // total: 4 + 2
    expect(getByText('Kilter Original')).toBeTruthy();
    expect(getByText('4')).toBeTruthy();
    expect(getByText('Tension Original')).toBeTruthy();
    expect(getByText('2')).toBeTruthy();
  });

  it('clears the tooltip when the chart background is tapped', () => {
    const { getByTestId, getByText, queryByText } = render(<StackedBarChart bars={bars} colorBy="layout" />);

    fireEvent.click(getByTestId('gifted-bar-1'));
    expect(getByText('V4')).toBeTruthy();

    fireEvent.click(getByTestId('gifted-bar-chart'));
    expect(queryByText('V4')).toBeNull();
  });
});

describe('GroupedBarChart tap-to-reveal tooltip (#2758)', () => {
  const groupedBars: RawGroupedBar[] = [
    {
      key: 'V3',
      label: 'V3',
      values: [
        { key: 'flash', label: 'Flash', value: 3 },
        { key: 'redpoint', label: 'Redpoint', value: 5 },
      ],
    },
    {
      key: 'V4',
      label: 'V4',
      values: [
        { key: 'flash', label: 'Flash', value: 1 },
        { key: 'redpoint', label: 'Redpoint', value: 0 },
      ],
    },
  ];

  it('shows the grade, total, and flash/redpoint split when a bar is tapped', () => {
    const { getByTestId, getByText } = render(<GroupedBarChart bars={groupedBars} />);

    fireEvent.click(getByTestId('gifted-bar-0'));

    expect(getByText('V3')).toBeTruthy();
    expect(getByText('8')).toBeTruthy(); // total: 3 + 5
    expect(getByText('Flash')).toBeTruthy();
    expect(getByText('3')).toBeTruthy();
    expect(getByText('Redpoint')).toBeTruthy();
    expect(getByText('5')).toBeTruthy();
  });

  it('clears the tooltip when the chart background is tapped', () => {
    const { getByTestId, getByText, queryByText } = render(<GroupedBarChart bars={groupedBars} />);

    // V4's redpoint value is 0 and gets filtered out of the tooltip rows —
    // this also pins createGroupedTooltipModel's zero-filtering end to end.
    fireEvent.click(getByTestId('gifted-bar-2'));
    expect(getByText('V4')).toBeTruthy();
    expect(queryByText('Redpoint')).toBeNull();

    fireEvent.click(getByTestId('gifted-bar-chart'));
    expect(queryByText('V4')).toBeNull();
  });
});
