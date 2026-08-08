// @vitest-environment jsdom
//
// Issue #4164 (4): on the play drawer's "Community" chart the grade printed
// above each bar collided with its neighbours once the viewer turned on both
// grade formats — "V6 / 7A" is nearly three times the width of "V6", and the
// label used to sit in a fixed 60px box regardless of how much room the bar
// owned. These tests hold the wiring between DifficultyByAngleChart and
// computeBarTopLabelLayout: one line while it fits, stacked onto two when the
// column is tighter than the joined grade, vertical only as a last resort.
import { createElement, useEffect, type ReactElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AngleGradeBar } from '../community-utils';

/** A phone-width play drawer. Only the width comes from onLayout. */
const DRAWER_WIDTH = 320;

vi.mock('react-native', () => ({
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: DRAWER_WIDTH, height: 150, x: 0, y: 0 } } });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount, matching a real layout pass
    }, []);
    return createElement('div', null, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
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
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light' as const,
    chartColors: { secondaryLabel: '#666666', separator: '#dddddd', label: '#111111' },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 6: 24 },
  borderRadius: { sm: 4, md: 8 },
}));

vi.mock('../../you/profile-chart-colors', () => ({
  gradeChartColor: (key: string) => `grade-${key}`,
}));

import { DifficultyByAngleChart } from '../DifficultyByAngleChart';

/** Angles every 5° from 20°, each with the same both-formats grade label. */
function bars(count: number, gradeName = 'V6 / 7A'): AngleGradeBar[] {
  return Array.from({ length: count }, (_, index) => ({
    angle: 20 + index * 5,
    difficulty: 22,
    gradeName,
    sends: 40 + index,
  }));
}

/** The text of each line the top label draws above the first bar. */
function labelLines(props: CapturedChartProps): string[] {
  const element = props.data?.[0]?.topLabelComponent?.();
  if (!element) return [];
  const { children } = element.props as { children?: ReactElement[] };
  return (children ?? []).map((line) => String((line.props as { children?: unknown }).children));
}

/** The style entries applied to the first line of the first bar's label. */
function labelStyles(props: CapturedChartProps): Record<string, unknown>[] {
  const element = props.data?.[0]?.topLabelComponent?.();
  const [line] = ((element?.props as { children?: ReactElement[] })?.children ?? []) as ReactElement[];
  const { style } = (line?.props ?? {}) as { style?: unknown };
  return (Array.isArray(style) ? style : [style]).filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
}

describe('DifficultyByAngleChart grade labels (#4164)', () => {
  beforeEach(() => {
    chartProps = null;
  });

  it('keeps a both-formats grade on one line while the bars are wide', () => {
    render(<DifficultyByAngleChart data={bars(4)} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    expect(labelLines(props)).toEqual(['V6 / 7A']);
    // No rotation, and the plot keeps its full height.
    expect(labelStyles(props).some((style) => 'transform' in style)).toBe(false);
  });

  it('stacks the two grades over the narrow bars of an eight-angle climb', () => {
    render(<DifficultyByAngleChart data={bars(8)} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    // The joined grade is far wider than a bar plus its gap.
    expect(props.barWidth).toBeLessThan(30);
    expect(labelLines(props)).toEqual(['V6', '7A']);
    expect(labelStyles(props).some((style) => 'transform' in style)).toBe(false);
  });

  it('boxes the label to the room it needs and re-centres it over its own bar', () => {
    render(<DifficultyByAngleChart data={bars(8)} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    // The bug: a fixed 60px box, anchored left, spilling over the next bar.
    const { width: boxWidth = 0, left = 0 } = props.topLabelContainerStyle ?? {};
    expect(boxWidth).toBeGreaterThanOrEqual(props.barWidth ?? 0);
    expect(boxWidth).toBeLessThanOrEqual((props.barWidth ?? 0) + 12);
    expect(left).toBe(Math.round(((props.barWidth ?? 0) - boxWidth) / 2));
  });

  it('stands the grade vertical once even its halves will not fit', () => {
    render(<DifficultyByAngleChart data={bars(15, 'V13 / 8B+')} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    expect(labelLines(props)).toEqual(['V13 / 8B+']);
    const rotation = labelStyles(props).find((style) => 'transform' in style);
    expect(rotation).toEqual({ transform: [{ rotate: '-90deg' }], marginBottom: expect.any(Number) });
    // The standing label buys its height out of the plot, not the section above.
    expect(props.height).toBeLessThan(150);
  });

  it('leaves a single-format grade exactly as it was', () => {
    render(<DifficultyByAngleChart data={bars(8, 'V6')} />);
    const props = chartProps;
    expect(props).not.toBeNull();
    if (!props) return;

    expect(labelLines(props)).toEqual(['V6']);
    expect(labelStyles(props).some((style) => 'transform' in style)).toBe(false);
    expect(props.height).toBe(150);
  });
});
