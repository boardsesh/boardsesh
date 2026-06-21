// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkoutTypeShelf, type WorkoutTypeShelfItem } from '../WorkoutTypeShelf';

type ViewProps = {
  children?: ReactNode;
  pointerEvents?: string;
};

const chartProps = vi.hoisted(() => ({
  latest: null as Record<string, unknown> | null,
}));

vi.mock('react-native', () => ({
  View: ({ children, pointerEvents }: ViewProps) =>
    createElement('div', { 'data-pointer-events': pointerEvents ?? '' }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
}));

vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../Icon', () => ({
  Icon: () => createElement('span', null),
}));

vi.mock('../../../you/YouCharts', () => ({
  StackedBarChart: (props: Record<string, unknown>) => {
    chartProps.latest = props;
    return createElement('div', { 'data-testid': 'chart' });
  },
}));

vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      separator: '#ddd',
      fill: '#eee',
      secondaryLabel: '#666',
    },
    brandColors: { primary: '#2563eb' },
  }),
}));

vi.mock('../../../../theme/colors', () => ({
  withAlpha: (color: string) => color,
}));

vi.mock('../../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8, lg: 12 },
}));

function item(overrides?: Partial<WorkoutTypeShelfItem>): WorkoutTypeShelfItem {
  return {
    key: 'volume',
    label: 'Volume',
    selected: false,
    bars: [
      {
        key: 'v1',
        label: 'V1',
        segments: [{ key: 'v1', label: 'V1', value: 1, color: '#111' }],
      },
    ],
    onPress: vi.fn(),
    accessibilityLabel: 'Workout, Volume',
    ...overrides,
  };
}

describe('WorkoutTypeShelf', () => {
  it('lets chart touches pass through to the tile press target', () => {
    const { getByTestId } = render(createElement(WorkoutTypeShelf, { items: [item()] }));

    expect(getByTestId('chart').parentElement?.getAttribute('data-pointer-events')).toBe('none');
    expect(chartProps.latest?.fitYAxisToData).toBe(true);
    expect(chartProps.latest?.interactive).toBe(false);
    expect(chartProps.latest?.zoomable).toBe(false);
  });
});
