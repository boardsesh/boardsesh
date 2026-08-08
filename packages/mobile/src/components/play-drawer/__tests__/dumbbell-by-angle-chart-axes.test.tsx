// @vitest-environment jsdom
//
// Issue #4164 (1): the angle labels under the Boardsesh grade chart ran straight
// across and clipped to "7…" on a board with fifteen angles, while the Community
// chart right below it had already learned to turn them diagonal (#3221). These
// tests hold the wiring between DumbbellByAngleChart and buildDumbbellAxis: when
// the markers crowd, the labels rotate; the y-axis gutter is sized to the labels
// the axis actually emits rather than a fixed 30px.
import { createElement, useEffect, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDumbbellByAngleModel } from '../by-angle-comparison';
import type { AngleGradeBar } from '../community-utils';

/** A phone-width play drawer. Only the width comes from onLayout. */
const DRAWER_WIDTH = 320;

vi.mock('react-native', () => ({
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: DRAWER_WIDTH, height: 168, x: 0, y: 0 } } });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount, matching a real layout pass
    }, []);
    return createElement('div', null, children);
  },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

type CapturedChartProps = {
  rotateLabel?: boolean;
  labelsExtraHeight?: number;
  yAxisLabelWidth?: number;
  yAxisLabelTexts?: string[];
  xAxisLabelTexts?: string[];
  noOfSections?: number;
};

let chartProps: CapturedChartProps | null = null;

vi.mock('react-native-gifted-charts', () => ({
  LineChart: (props: CapturedChartProps) => {
    chartProps = props;
    return createElement('div', { 'data-testid': 'gifted-line-chart' });
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    chartColors: {
      secondaryLabel: '#666666',
      tertiaryLabel: '#999999',
      separator: '#dddddd',
      label: '#111111',
    },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 4: 16 },
}));

import { DumbbellByAngleChart } from '../DumbbellByAngleChart';

/** `count` angles 5° apart, all around V6, as the drawer's join model builds them. */
function rowsForAngles(count: number, gradeFormat: 'v-grade' | 'font' | 'both' = 'v-grade') {
  const crowd: AngleGradeBar[] = Array.from({ length: count }, (_, index) => ({
    angle: 20 + index * 5,
    difficulty: 22,
    gradeName: 'V6',
    sends: 40,
  }));
  return buildDumbbellByAngleModel([], crowd, gradeFormat);
}

function renderChart(count: number, gradeFormat: 'v-grade' | 'font' | 'both' = 'v-grade') {
  render(
    <DumbbellByAngleChart
      rows={rowsForAngles(count, gradeFormat)}
      headlineGrade={22}
      gradeFormat={gradeFormat}
      accessibilityLabel="chart"
    />,
  );
  return chartProps;
}

describe('DumbbellByAngleChart axes (#4164)', () => {
  beforeEach(() => {
    chartProps = null;
  });

  it('turns the angle labels diagonal once fifteen angles crowd the axis', () => {
    const props = renderChart(15);
    expect(props).not.toBeNull();
    if (!props) return;

    expect(props.rotateLabel).toBe(true);
    // gifted's LineChart sizes the rotated label box off labelsExtraHeight, so
    // rotating without it would turn the labels inside a one-marker-wide box.
    expect(props.labelsExtraHeight).toBeGreaterThan(0);
    expect(props.xAxisLabelTexts?.at(-1)).toBe('90°');
  });

  it('leaves the labels horizontal when a climb has only a few angles', () => {
    const props = renderChart(3);
    expect(props).not.toBeNull();
    if (!props) return;

    expect(props.rotateLabel).toBe(false);
    expect(props.labelsExtraHeight).toBeUndefined();
  });

  it('never hands gifted an empty y label, which would render as a "0" tick', () => {
    const props = renderChart(5);
    expect(props).not.toBeNull();
    if (!props) return;

    expect(props.yAxisLabelTexts).not.toContain('');
    expect(props.yAxisLabelTexts).toHaveLength((props.noOfSections ?? 0) + 1);
  });

  it('widens the y-axis gutter when the viewer asks for both grade formats', () => {
    const single = renderChart(5, 'v-grade')?.yAxisLabelWidth ?? 0;
    const both = renderChart(5, 'both')?.yAxisLabelWidth ?? 0;
    expect(single).toBeGreaterThan(0);
    expect(both).toBeGreaterThan(single);
  });
});
