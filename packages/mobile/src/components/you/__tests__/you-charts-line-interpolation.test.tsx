// @vitest-environment jsdom
//
// Regression coverage for #3780: the V-Points area chart used gifted-charts'
// cardinal-spline `curved` interpolation, which can overshoot past a data
// point's y-value between two neighbours — making a flat or dipping week
// look like it rose (or vice versa). This repo has no visual regression
// harness, so this test pins the prop contract instead: the LineChart must
// render straight segments (`curved={false}`) with no leftover `curvature`.
import { createElement, useEffect, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawVPointsTimeline } from '@boardsesh/profile-stats';

const FRAME_WIDTH = 320;

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

type LineChartCall = { curved?: boolean; curvature?: number; width?: number };

// Hoist the mock so vi.mock's hoisted factory can access it.
const { lineChartMock } = vi.hoisted(() => ({ lineChartMock: vi.fn<(props: LineChartCall) => void>() }));

vi.mock('react-native-gifted-charts', () => ({
  BarChart: () => createElement('div', { 'data-testid': 'gifted-bar-chart' }),
  LineChart: (props: LineChartCall) => {
    lineChartMock(props);
    return createElement('div', { 'data-testid': 'gifted-line-chart' });
  },
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

import { TotalAreaChart } from '../YouCharts';

describe('TotalAreaChart line interpolation (#3780)', () => {
  // V-points data is cumulative, so the fixture must be monotonically non-decreasing.
  const timeline: RawVPointsTimeline = {
    weekLabels: ['W1', 'W2', 'W3', 'W4'],
    series: [{ layoutKey: 'kilter-1', displayName: 'Kilter Original', data: [10, 22, 31, 51] }],
    totalPoints: 51,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders straight segments instead of an overshooting curve', () => {
    render(<TotalAreaChart timeline={timeline} color="#7c3aed" />);

    expect(lineChartMock).toHaveBeenCalledTimes(1);
    const call = lineChartMock.mock.calls[0]![0];
    expect(call.curved).toBe(false);
    expect(call.curvature).toBeUndefined();
  });
});
