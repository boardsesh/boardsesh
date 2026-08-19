// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeTileWidth,
  SHELF_HORIZONTAL_INSET,
  TILE_GAP,
  TILE_MAX_WIDTH,
  TILE_MIN_WIDTH,
  WorkoutTypeShelf,
  type WorkoutTypeShelfItem,
} from '../WorkoutTypeShelf';

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
  scrollViewProps.latest = null;
  chartProps.latest = null;
});

/** The five workout types the real shelf renders. */
const WORKOUT_TYPE_COUNT = 5;

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

function workoutTypes(): WorkoutTypeShelfItem[] {
  return Array.from({ length: WORKOUT_TYPE_COUNT }, (_unused, index) =>
    item({ key: `workout-${index}`, label: `Workout ${index}` }),
  );
}

function widthOfTile(tile: Element): number {
  const style = JSON.parse(tile.getAttribute('data-style') ?? 'null') as Array<Record<string, unknown>> | null;
  if (style == null) throw new Error('tile has no style');
  const width = style.map((entry) => entry?.width).find((candidate) => candidate != null);
  if (typeof width !== 'number') throw new Error('tile has no numeric width');
  return width;
}

/** Width the component actually put on a rendered tile, read back out of the
 *  style the tile hands to PressableSurface. */
function renderedTileWidth(container: HTMLElement): number {
  const tile = container.querySelector('button');
  if (tile == null) throw new Error('no tile rendered');
  return widthOfTile(tile);
}

/** Report the container's measured width to the shelf, the way onLayout does. */
function measureShelf(width: number): void {
  const onLayout = scrollViewProps.latest?.onLayout;
  if (typeof onLayout !== 'function') throw new Error('shelf does not measure its container');
  const notifyLayout = onLayout as (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  act(() => {
    notifyLayout({ nativeEvent: { layout: { width, height: 140 } } });
  });
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
    render(createElement(WorkoutTypeShelf, { items: workoutTypes() }));

    const expectedTileWidth = computeTileWidth(375, WORKOUT_TYPE_COUNT);
    expect(scrollViewProps.latest?.snapToInterval).toBe(expectedTileWidth + TILE_GAP);
    expect(scrollViewProps.latest?.snapToAlignment).toBe('start');
    expect(scrollViewProps.latest?.decelerationRate).toBe('fast');
  });

  it('puts the computed width on every rendered tile', () => {
    const { container } = render(createElement(WorkoutTypeShelf, { items: workoutTypes() }));

    const expectedTileWidth = computeTileWidth(375, WORKOUT_TYPE_COUNT);
    const widths = Array.from(container.querySelectorAll('button')).map(widthOfTile);

    expect(widths).toEqual(Array.from({ length: WORKOUT_TYPE_COUNT }, () => expectedTileWidth));
  });

  // The regression this guards: the shelf renders inside `shellContent` on the
  // iPad adaptive shell, a pane far narrower than the window. Sizing off
  // useWindowDimensions() there made a single tile wider than the whole pane.
  it('sizes tiles from the measured container, not the window', () => {
    windowDimensions.width = 1194; // iPad 11" landscape
    const { container } = render(createElement(WorkoutTypeShelf, { items: workoutTypes() }));

    const paneWidth = 399; // shellContent, between the sidebar and the play/wall panes
    measureShelf(paneWidth);

    expect(renderedTileWidth(container)).toBe(computeTileWidth(paneWidth, WORKOUT_TYPE_COUNT));
    expect(renderedTileWidth(container)).not.toBe(computeTileWidth(1194, WORKOUT_TYPE_COUNT));
    expect(renderedTileWidth(container)).toBeLessThan(paneWidth);
  });

  it('falls back to the window width until the container reports its box', () => {
    windowDimensions.width = 390;
    const { container } = render(createElement(WorkoutTypeShelf, { items: workoutTypes() }));

    expect(renderedTileWidth(container)).toBe(computeTileWidth(390, WORKOUT_TYPE_COUNT));
  });

  it('ignores a zero-width layout pass instead of collapsing the tiles', () => {
    const { container } = render(createElement(WorkoutTypeShelf, { items: workoutTypes() }));
    measureShelf(0);

    expect(renderedTileWidth(container)).toBe(computeTileWidth(375, WORKOUT_TYPE_COUNT));
  });
});

/**
 * What the row actually puts on screen at rest. Content is laid out as
 * `[inset][tile][gap][tile][gap]…[inset]`, and the viewport shows the first
 * `containerWidth` points of it — so only the LEADING inset is on screen, and
 * the peek is whatever of the next tile is left after the whole ones.
 */
function shelfLayout(containerWidth: number, itemCount: number) {
  const tileWidth = computeTileWidth(containerWidth, itemCount);
  const pitch = tileWidth + TILE_GAP;
  const contentWidth = SHELF_HORIZONTAL_INSET * 2 + itemCount * tileWidth + (itemCount - 1) * TILE_GAP;
  const wholeTiles = Math.min(itemCount, Math.floor((containerWidth - SHELF_HORIZONTAL_INSET + TILE_GAP) / pitch));

  return {
    tileWidth,
    wholeTiles,
    peek: containerWidth - (SHELF_HORIZONTAL_INSET + wholeTiles * pitch),
    scrolls: contentWidth > containerWidth,
  };
}

describe('computeTileWidth', () => {
  // A whole number of tiles filling the row exactly is what caused #4278: the row
  // looked "done" with no cue that more workout types were off-screen. Phones,
  // the iPad panes (`shellContent`, between the sidebar and the play/wall
  // columns) and full-width tablet/desktop windows all have to leave a partial
  // tile peeking whenever something is hidden.
  it.each([
    [320, 'iPad Slide Over / small split'],
    [375, 'iPhone SE / mini'],
    [390, 'iPhone 14/15/16'],
    [430, 'iPhone 16 Pro Max'],
    [440, 'just past two max-width tiles'],
    [399, 'iPad 11" landscape content pane'],
    [418, 'iPad 11" portrait content pane'],
    [485, 'iPad 13" landscape content pane'],
    [580, 'iPad 13" portrait content pane'],
    [648, 'iPad mini portrait content pane'],
    [744, 'iPad mini full width'],
    [834, 'iPad 11" portrait full width'],
    [1024, 'iPad 13" portrait full width'],
    [1194, 'iPad 11" landscape full width'],
    [1366, 'iPad 13" landscape full width / desktop browser'],
  ])('keeps tiles sane and the peek visible at %dpt (%s)', (containerWidth) => {
    const { tileWidth, wholeTiles, peek, scrolls } = shelfLayout(containerWidth, WORKOUT_TYPE_COUNT);

    // A tile has to fit the box it renders in, and must not stretch its chart.
    expect(tileWidth).toBeLessThanOrEqual(TILE_MAX_WIDTH);
    expect(tileWidth).toBeGreaterThanOrEqual(TILE_MIN_WIDTH);
    expect(tileWidth).toBeLessThan(containerWidth);
    expect(wholeTiles).toBeGreaterThanOrEqual(2);

    if (!scrolls) {
      // Every workout type is already on screen — nothing for a peek to advertise.
      expect(wholeTiles).toBe(WORKOUT_TYPE_COUNT);
      return;
    }

    // Something is hidden, so a slice of the next tile has to be showing: more
    // than a gap's worth (a sliver you would miss), less than a whole tile
    // (which is just another complete-looking row).
    expect(peek).toBeGreaterThan(TILE_GAP);
    expect(peek).toBeLessThan(tileWidth);
  });

  it('never lets a tile outgrow the pane it renders in', () => {
    // 1194pt window, 399pt pane: deriving the width from the window gave 484 —
    // wider than the pane itself, one clipped tile and no peek at all.
    expect(computeTileWidth(399, WORKOUT_TYPE_COUNT)).toBeLessThan(399);
    expect(computeTileWidth(485, WORKOUT_TYPE_COUNT)).toBeLessThan(485);
  });
});
