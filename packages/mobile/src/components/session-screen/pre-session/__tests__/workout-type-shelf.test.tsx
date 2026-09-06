// @vitest-environment jsdom
import { createElement, type ReactNode, type Ref } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeTileWidth,
  INDICATOR_FLASH_DELAY_MS,
  MAX_PEEK_FRACTION,
  MIN_PEEK_FRACTION,
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

// Stands in for the native scroll view the shelf holds a ref to, so the test can
// see whether the shelf asked the platform to flash its indicator.
const scrollViewInstance = vi.hoisted(() => ({
  flashScrollIndicators: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: ({ children, pointerEvents }: ViewProps) =>
    createElement('div', { 'data-pointer-events': pointerEvents ?? '' }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: windowDimensions.width, height: 800 }),
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children, ref, ...props }: { children?: ReactNode; ref?: Ref<unknown> } & Record<string, unknown>) => {
    scrollViewProps.latest = props;
    if (ref != null && typeof ref === 'object') ref.current = scrollViewInstance;
    return createElement('div', null, children);
  },
}));

// The real hook runs its effect every time the Record tab comes forward; in a
// bare render there is one such moment, so a plain mount effect is the analogue.
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      useEffect(effect, [effect]);
    },
  };
});

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
  vi.useFakeTimers();
  windowDimensions.width = 375;
  scrollViewProps.latest = null;
  chartProps.latest = null;
  scrollViewInstance.flashScrollIndicators.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
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

/** Width the component put on a rendered tile, read back off its style. */
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

  // Guards the iPad regression: `shellContent` is far narrower than the window,
  // so sizing off useWindowDimensions() made a tile wider than the whole pane.
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

  // The peek is the only cue on a phone where the row already ended mid-tile
  // before any of this, and iOS hides the indicator whenever nobody is dragging.
  it('flashes the scroll indicator once the screen has settled', () => {
    render(createElement(WorkoutTypeShelf, { items: workoutTypes() }));

    expect(scrollViewInstance.flashScrollIndicators).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(INDICATOR_FLASH_DELAY_MS);
    });

    expect(scrollViewInstance.flashScrollIndicators).toHaveBeenCalledTimes(1);
  });

  it('drops a pending flash when the screen goes away before it fires', () => {
    const { unmount } = render(createElement(WorkoutTypeShelf, { items: workoutTypes() }));
    unmount();

    act(() => {
      vi.advanceTimersByTime(INDICATOR_FLASH_DELAY_MS);
    });

    expect(scrollViewInstance.flashScrollIndicators).not.toHaveBeenCalled();
  });
});

// Content is `[inset][tile][gap]…[inset]` and the viewport shows its first
// `containerWidth` points, so only the leading inset counts against the peek.
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
  // #4278 was a row of whole tiles that looked "done" with more off-screen.
  // Phones, the iPad `shellContent` panes and full-width tablets all need a peek.
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

    // Something is hidden, so a slice of the next tile has to be showing, and it
    // has to be a slice you read as cut off: a fifth of a tile at the least, and
    // never a whole one — a whole one is just another complete-looking row.
    expect(peek).toBeGreaterThanOrEqual(tileWidth * MIN_PEEK_FRACTION);
    expect(peek).toBeLessThan(tileWidth);
  });

  // 440pt is the width where "add a column instead of widening the tile" turned
  // against itself: two 168pt tiles overshoot by 2pt, and stepping up to three
  // shrank every tile to 116 and cut the peek from 64pt to 40.
  it('keeps the shipped tile width where capping already leaves a readable peek', () => {
    expect(computeTileWidth(440, WORKOUT_TYPE_COUNT)).toBe(TILE_MAX_WIDTH);

    const { tileWidth, wholeTiles, peek } = shelfLayout(440, WORKOUT_TYPE_COUNT);
    expect(wholeTiles).toBe(2);
    expect(peek).toBeGreaterThanOrEqual(tileWidth * MIN_PEEK_FRACTION);
    expect(peek).toBeLessThanOrEqual(tileWidth * MAX_PEEK_FRACTION);
  });

  // The other side of that trade. Capping wherever the tile overshoots is the
  // original bug one width over: 580pt fits three capped tiles with 24pt to
  // spare, 744pt fits four with 8pt. Both have to shrink the tile instead.
  it.each([
    [580, 'iPad 13" portrait content pane'],
    [744, 'iPad mini full width'],
  ])('shrinks the tile at %dpt (%s), where capping would leave a sliver', (containerWidth) => {
    const cappedTiles = Math.floor((containerWidth - SHELF_HORIZONTAL_INSET) / (TILE_MAX_WIDTH + TILE_GAP));
    const cappedPeek = containerWidth - SHELF_HORIZONTAL_INSET - cappedTiles * (TILE_MAX_WIDTH + TILE_GAP);
    expect(cappedPeek).toBeLessThan(TILE_MAX_WIDTH * MIN_PEEK_FRACTION);

    expect(computeTileWidth(containerWidth, WORKOUT_TYPE_COUNT)).toBeLessThan(TILE_MAX_WIDTH);
    const { tileWidth, peek } = shelfLayout(containerWidth, WORKOUT_TYPE_COUNT);
    expect(peek).toBeGreaterThanOrEqual(tileWidth * MIN_PEEK_FRACTION);
  });

  it('never lets a tile outgrow the pane it renders in', () => {
    // 1194pt window, 399pt pane: deriving the width from the window gave 484 —
    // wider than the pane itself, one clipped tile and no peek at all.
    expect(computeTileWidth(399, WORKOUT_TYPE_COUNT)).toBeLessThan(399);
    expect(computeTileWidth(485, WORKOUT_TYPE_COUNT)).toBeLessThan(485);
  });
});
