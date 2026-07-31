// @vitest-environment jsdom
//
// Issue #3779: on the You -> Progress "Flash vs Redpoint" card the count drawn
// above each bar was clipped — the reporter's screenshot shows seven grade
// pairs on a phone, where each bar lands around 13px wide, and gifted-charts
// boxes a top label to exactly one bar width. These tests hold the wiring
// between GroupedBarChart and computeBarTopLabelLayout: the label box has to
// outgrow the bar, re-centre itself, and turn vertical when even the gap beside
// the bar isn't enough.
import { createElement, useEffect, type ReactElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawGroupedBar } from '@boardsesh/profile-stats';

const CARD_WIDTH = 320;
// GroupedBarChart's own default `height` prop, and the room it always reserves
// under the plot for the grade axis. Only the card *width* comes from onLayout.
const CHART_HEIGHT = 150;
const X_AXIS_RESERVE = 28;

vi.mock('react-native', () => ({
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: CARD_WIDTH, height: CHART_HEIGHT, x: 0, y: 0 } } });
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

type BarItem = {
  value: number;
  topLabelComponent?: () => ReactElement;
};
type CapturedChartProps = {
  data?: BarItem[];
  barWidth?: number;
  height?: number;
  topLabelContainerStyle?: { width?: number; left?: number };
};

// The label box is a prop, not rendered output, so capture props rather than
// JSON-serialising them (JSON silently drops the component callbacks).
let chartProps: CapturedChartProps | null = null;

vi.mock('react-native-gifted-charts', () => ({
  BarChart: (props: CapturedChartProps) => {
    chartProps = props;
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

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../profile-chart-colors', () => ({
  gradeChartColor: (key: string) => `grade-${key}`,
  layoutChartColor: (key: string) => `layout-${key}`,
  flashRedpointColor: (key: string) => `status-${key}`,
}));

import { GroupedBarChart } from '../YouCharts';

/** The reporter's chart: V0-V6, counts up to 128, on a 320pt phone card. */
const reportedBars: RawGroupedBar[] = [128, 82, 61, 44, 41, 36, 30].map((flash, index) => ({
  key: `V${index}`,
  label: `V${index}`,
  values: [
    { key: 'flash', label: 'Flash', value: flash },
    { key: 'redpoint', label: 'Redpoint', value: Math.round(flash / 3) },
  ],
}));

const singleDigitBars: RawGroupedBar[] = reportedBars.map((bar) => ({
  ...bar,
  values: bar.values.map((value) => ({ ...value, value: 4 })),
}));

function labelStyles(props: CapturedChartProps): Record<string, unknown>[] {
  const element = props.data?.[0]?.topLabelComponent?.();
  if (!element) return [];
  const { style } = element.props as { style?: unknown };
  return (Array.isArray(style) ? style : [style]).filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
}

describe('GroupedBarChart top-label sizing (#3779)', () => {
  beforeEach(() => {
    chartProps = null;
  });

  it('gives a three-digit count a box wider than its 13px bar, centred over it', () => {
    render(<GroupedBarChart bars={reportedBars} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    // The bug: gifted-charts defaults this box to exactly `barWidth`.
    expect(props.barWidth).toBeLessThan(20);
    expect(props.topLabelContainerStyle?.width).toBeGreaterThan(props.barWidth ?? 0);
    // Widening alone would push the label right; the offset re-centres it.
    expect(props.topLabelContainerStyle?.left).toBeLessThan(0);
  });

  it('turns the count vertical and reserves height for it when bars are that narrow', () => {
    render(<GroupedBarChart bars={reportedBars} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    const rotation = labelStyles(props).find((style) => 'transform' in style);
    expect(rotation).toEqual({ transform: [{ rotate: '-90deg' }], marginBottom: expect.any(Number) });
    // Plot height shrinks so the standing label still fits inside the card.
    expect(props.height).toBeLessThan(CHART_HEIGHT - X_AXIS_RESERVE);
  });

  it('leaves single-digit counts horizontal and the plot at full height', () => {
    render(<GroupedBarChart bars={singleDigitBars} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    expect(labelStyles(props).some((style) => 'transform' in style)).toBe(false);
    expect(props.height).toBe(CHART_HEIGHT - X_AXIS_RESERVE);
    expect(props.topLabelContainerStyle?.width).toBe(props.barWidth);
  });
});
