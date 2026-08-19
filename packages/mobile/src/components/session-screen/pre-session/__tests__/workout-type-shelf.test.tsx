// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTileWidth, TILE_GAP, WorkoutTypeShelf, type WorkoutTypeShelfItem } from '../WorkoutTypeShelf';

type ViewProps = {
  children?: ReactNode;
  pointerEvents?: string;
};

const chartProps = vi.hoisted(() => ({
  latest: null as Record<string, unknown> | null,
}));

const windowDimensions = vi.hoisted(() => ({
  width: 375,
}));

const scrollViewProps = vi.hoisted(() => ({
  latest: null as Record<string, unknown> | null,
}));

vi.mock('react-native', () => ({
  View: ({ children, pointerEvents }: ViewProps) =>
    createElement('div', { 'data-pointer-events': pointerEvents ?? '' }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: windowDimensions.width, height: 800 }),
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    scrollViewProps.latest = props;
    return createElement('div', null, children);
  },
}));

vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, style }: { children?: ReactNode; onPress?: () => void; style?: unknown }) =>
    createElement('button', { onClick: onPress, 'data-style': JSON.stringify(style) }, children),
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

beforeEach(() => {
  windowDimensions.width = 375;
});

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

  it('restores the platform scroll indicator so the row signals it scrolls', () => {
    render(createElement(WorkoutTypeShelf, { items: [item()] }));

    expect(scrollViewProps.latest?.showsHorizontalScrollIndicator).toBe(true);
  });

  it('snaps to tile boundaries', () => {
    render(createElement(WorkoutTypeShelf, { items: [item()] }));

    const expectedTileWidth = computeTileWidth(375);
    expect(scrollViewProps.latest?.snapToInterval).toBe(expectedTileWidth + TILE_GAP);
    expect(scrollViewProps.latest?.snapToAlignment).toBe('start');
    expect(scrollViewProps.latest?.decelerationRate).toBe('fast');
  });
});

describe('computeTileWidth', () => {
  // A whole number of tiles fitting the screen exactly is what caused #4278:
  // the row looked "done" with no visual cue that 3 more workout types were
  // off-screen. These sizes must always leave a partial tile peeking.
  it.each([
    [375, 136], // iPhone SE / mini-width devices
    [390, 142], // iPhone 14/15/16
    [430, 159], // iPhone 16 Pro Max
  ])('leaves a partial tile peeking at %dpt wide (tile width %dpx)', (windowWidth, expectedTileWidth) => {
    const tileWidth = computeTileWidth(windowWidth);
    expect(tileWidth).toBe(expectedTileWidth);

    const horizontalInset = 16;
    const contentWidth = windowWidth - horizontalInset * 2;
    const twoTilesAndOneGap = tileWidth * 2 + TILE_GAP;
    const peek = contentWidth - twoTilesAndOneGap;

    // A peek must be visible (not zero/negative) and must be less than a
    // full tile (otherwise it's just a 3rd whole tile, reproducing the bug).
    expect(peek).toBeGreaterThan(0);
    expect(peek).toBeLessThan(tileWidth);
  });
});
