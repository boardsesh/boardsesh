// @vitest-environment jsdom
//
// The gym finder inside a sheet: a map card over the rows, a capsule row that
// sticks, "Add my gym" pinned above the home indicator (and at the end of the
// list while the keyboard is up), and nothing that looks like a second sheet.
// The map is never inside the scroll view (Android's ScrollView would steal
// its vertical pans): it floats over a spacer and follows the scroll offset.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  createElement,
  createRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from 'react';

type StyleValue = Record<string, unknown> | false | null | undefined | StyleValue[];
type ViewProps = {
  children?: ReactNode;
  testID?: string;
  style?: StyleValue;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};

function flatten(style: StyleValue): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style;
}

type Layout = { x: number; y: number; width: number; height: number };
const state = vi.hoisted(() => ({
  keyboardOverlap: 0,
  scrollOffset: 0,
  windowHeight: 500,
  firstItemOffset: 226,
  layouts: [] as (Layout | undefined)[],
  listProps: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
}));

function MockView({ children, testID, style, onLayout }: ViewProps) {
  const flat = flatten(style ?? null);
  useEffect(() => {
    // The page measures 700pt; the pinned footer 80pt.
    onLayout?.({ nativeEvent: { layout: { height: testID === 'map-card-list-footer' ? 80 : 700 } } });
  }, [onLayout, testID]);
  return createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flat) }, children);
}

vi.mock('react-native', () => ({
  View: MockView,
  Platform: { OS: 'ios' },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: MockView },
  // The UI-thread scroll offset, read once per render here.
  useScrollOffset: () => ({ value: state.scrollOffset }),
  useAnimatedStyle: (worklet: () => Record<string, unknown>) => worklet(),
  useAnimatedRef: () => {
    const [animatedRef] = useState(() => {
      const assign = (instance: unknown) => {
        assign.current = instance;
      };
      assign.current = null as unknown;
      return assign;
    });
    return animatedRef;
  },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: forwardRef(
    (
      props: {
        data: unknown[];
        renderItem: (info: { item: unknown }) => ReactNode;
        keyExtractor: (item: unknown) => string;
        ListHeaderComponent?: ReactNode;
        ListFooterComponent?: ReactNode;
      },
      ref: Ref<unknown>,
    ) => {
      state.listProps = props as unknown as Record<string, unknown>;
      useImperativeHandle(ref, () => ({
        scrollToIndex: state.scrollToIndex,
        scrollToOffset: state.scrollToOffset,
        getLayout: (index: number) => state.layouts[index],
        getFirstItemOffset: () => state.firstItemOffset,
        getAbsoluteLastScrollOffset: () => state.scrollOffset,
        getWindowSize: () => ({ width: 390, height: state.windowHeight }),
      }));
      return createElement('section', { 'data-testid': 'flash-list' }, [
        createElement('header', { key: 'header' }, props.ListHeaderComponent),
        ...props.data.map((item) =>
          createElement('div', { key: props.keyExtractor(item) }, props.renderItem({ item })),
        ),
        createElement('footer', { key: 'footer', 'data-testid': 'list-tail' }, props.ListFooterComponent),
      ]);
    },
  ),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('../panel-keyboard', () => ({ useKeyboardOverlap: () => state.keyboardOverlap }));
vi.mock('../../ChromeIconButton', () => ({
  ChromeIconButton: ({
    onPress,
    accessibilityLabel,
    testID,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
    testID?: string;
  }) =>
    createElement('button', {
      type: 'button',
      onClick: onPress,
      'aria-label': accessibilityLabel,
      'data-testid': testID,
    }),
}));
vi.mock('../../ReadableColumn', () => ({ READABLE_CONTENT_WIDTH: 672 }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      groupedBackground: '#f2f2f7',
      separator: '#ccc',
      tertiaryFill: '#eee',
      secondaryBackground: '#fff',
    },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  cardCorners: { borderRadius: 12, borderCurve: 'continuous' },
  shadows: { sm: {} },
  spacing: { 1: 4, 2: 8, 4: 16, 6: 24 },
}));

const { MapCardList, mapCardHeight, pinnedMapBandHeight, rowScrollTarget } = await import('../MapCardList');
type Handle = import('../MapCardList').MapCardListHandle;

type Row = { key: string; label: string };
const ROWS: Row[] = [
  { key: 'a', label: 'Boulderhal' },
  { key: 'b', label: 'Monk' },
];
const rowKey = (row: Row) => row.key;
const renderRow = ({ item }: { item: Row }) => createElement('span', { 'data-testid': `row-${item.key}` }, item.label);

function renderList(overrides: Partial<Parameters<typeof MapCardList<Row>>[0]> = {}, ref?: Ref<Handle>) {
  return render(
    createElement(MapCardList<Row>, {
      data: ROWS,
      renderItem: renderRow,
      keyExtractor: rowKey,
      map: createElement('div', { 'data-testid': 'the-map' }),
      onLocate: vi.fn(),
      locateLabel: 'Use my location',
      stickyHeader: createElement('div', { 'data-testid': 'capsules' }),
      footer: createElement('button', { type: 'button', 'data-testid': 'add-gym' }, 'Add my gym'),
      ref,
      testID: 'page',
      ...overrides,
    }),
  );
}

const styleOf = (testID: string) => JSON.parse(screen.getByTestId(testID).getAttribute('data-style') ?? '{}');

beforeEach(() => {
  state.keyboardOverlap = 0;
  state.scrollOffset = 0;
  state.windowHeight = 500;
  state.firstItemOffset = 226;
  state.layouts = [];
  state.listProps = null;
  state.scrollToIndex.mockClear();
  state.scrollToOffset.mockClear();
});
afterEach(cleanup);

describe('mapCardHeight', () => {
  it('is 30% of the page, kept between 150 and 240 pt', () => {
    expect(mapCardHeight(0)).toBe(150);
    expect(mapCardHeight(700)).toBe(210);
    expect(mapCardHeight(1200)).toBe(240);
  });
});

describe('pinnedMapBandHeight', () => {
  it('is the whole card with the keyboard down', () => {
    expect(pinnedMapBandHeight(700, 0)).toBe(210);
  });

  it('leaves the rows 120 pt above the keyboard, never more than the card', () => {
    // 700 - 336 = 364 above the keyboard: room for the whole 210 pt card.
    expect(pinnedMapBandHeight(700, 336)).toBe(210);
    // 600 - 336 = 264 above it: 264 - 120 - 16 = 128 pt of band.
    expect(pinnedMapBandHeight(600, 336)).toBe(128);
    for (const [page, keyboard] of [
      [600, 336],
      [700, 420],
      [900, 336],
    ]) {
      const band = pinnedMapBandHeight(page, keyboard);
      expect(page - keyboard - (band + 16)).toBeGreaterThanOrEqual(120);
    }
  });

  it('folds (0) where the band would be under 88 pt', () => {
    // 450 - 300 = 150 above the keyboard: 14 pt of band, too little to use.
    expect(pinnedMapBandHeight(450, 300)).toBe(0);
    // 224 pt above it: 88 pt, just enough.
    expect(pinnedMapBandHeight(560, 336)).toBe(88);
    expect(pinnedMapBandHeight(559, 336)).toBe(0);
  });
});

describe('rowScrollTarget', () => {
  // Header 226 (the card's space), capsule 44 stuck at the top, footer 80.
  const view = { windowHeight: 500, headerHeight: 226, stickyHeight: 44, footerHeight: 80 };

  it('leaves a row that is already fully in view where it is', () => {
    expect(rowScrollTarget({ ...view, rowTop: 280, rowHeight: 70, scrollOffset: 0 })).toBeNull();
  });

  it('scrolls down only far enough to clear the pinned footer, keeping the rest of the map', () => {
    // The row's bottom at 470 is behind the footer (visible to 420): 50 pt, no more.
    expect(rowScrollTarget({ ...view, rowTop: 400, rowHeight: 70, scrollOffset: 0 })).toBe(50);
  });

  it('scrolls up to put a row hidden under the stuck capsules just below them', () => {
    expect(rowScrollTarget({ ...view, rowTop: 300, rowHeight: 70, scrollOffset: 600 })).toBe(256);
  });
});

describe('MapCardList', () => {
  it('floats the map card over a spacer of its size, outside the list, with locate and a sticky capsule row', () => {
    const onLocate = vi.fn();
    renderList({ onLocate });
    expect(styleOf('map-card')).toMatchObject({ height: 210, borderRadius: 12, overflow: 'hidden' });
    expect(styleOf('map-card-box')).toMatchObject({ position: 'absolute', top: 0, height: 226 });
    expect(styleOf('map-card-spacer')).toMatchObject({ height: 226 });
    // The map never sits inside the scroll view: no ScrollView can steal its pans.
    expect(screen.getByTestId('flash-list').contains(screen.getByTestId('the-map'))).toBe(false);
    fireEvent.click(screen.getByTestId('map-card-locate'));
    expect(onLocate).toHaveBeenCalledOnce();
    // The capsules are row 0 and stick, and the row they stand for is hidden.
    expect(state.listProps?.stickyHeaderIndices).toEqual([0]);
    expect(state.listProps?.stickyHeaderConfig).toEqual({ hideRelatedCell: true });
    expect(screen.getByTestId('capsules')).toBeTruthy();
    expect(screen.getByTestId('row-b').textContent).toBe('Monk');
    // A page, not a panel: no rounded top, no shadow.
    const page = styleOf('page');
    expect(page.borderTopLeftRadius).toBeUndefined();
    expect(page.shadowOpacity).toBeUndefined();
  });

  it('moves the card up with the rows, and stops once it has scrolled away', () => {
    state.scrollOffset = 100;
    const view = renderList();
    expect(styleOf('map-card-box').transform).toEqual([{ translateY: -100 }]);
    state.scrollOffset = 900;
    view.rerender(
      createElement(MapCardList<Row>, {
        data: ROWS,
        renderItem: renderRow,
        keyExtractor: rowKey,
        map: createElement('div', { 'data-testid': 'the-map' }),
      }),
    );
    expect(styleOf('map-card-box').transform).toEqual([{ translateY: -226 }]);
  });

  it('pins the footer above the home indicator and lets the last row scroll clear of it', () => {
    renderList();
    expect(styleOf('map-card-list-footer')).toMatchObject({ position: 'absolute', bottom: 0, paddingBottom: 34 + 8 });
    expect(screen.getByTestId('map-card-list-footer').textContent).toBe('Add my gym');
    expect(state.listProps?.contentContainerStyle).toEqual({ paddingBottom: 80 + 16 });
    expect(screen.getByTestId('list-tail').textContent).toBe('');
  });

  it('ends the page at the keyboard and moves the footer to the end of the list while it is up', () => {
    state.keyboardOverlap = 336;
    renderList();
    expect(styleOf('page')).toMatchObject({ paddingBottom: 336 });
    expect(screen.queryByTestId('map-card-list-footer')).toBeNull();
    expect(screen.getByTestId('list-tail').textContent).toBe('Add my gym');
  });

  it("brings a pin's row into view with the least scroll, and leaves a visible one alone", () => {
    const ref = createRef<Handle>();
    renderList({}, ref);
    // Row 0 is the capsules; 'a' is row 1, 'b' row 2 (y is below the card's space).
    state.layouts = [
      { x: 0, y: 0, width: 390, height: 44 },
      { x: 0, y: 44, width: 390, height: 70 },
      { x: 0, y: 174, width: 390, height: 70 },
    ];
    act(() => ref.current?.scrollToItemKey('a'));
    expect(state.scrollToOffset).not.toHaveBeenCalled();
    // 'b' ends at 226 + 174 + 70 = 470, behind the 80 pt footer: scroll 50.
    act(() => ref.current?.scrollToItemKey('b'));
    expect(state.scrollToOffset).toHaveBeenCalledWith({ offset: 50, animated: true });
    act(() => ref.current?.scrollToItemKey('missing'));
    expect(state.scrollToOffset).toHaveBeenCalledOnce();
    act(() => ref.current?.scrollToTop());
    expect(state.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: true });
  });

  it('falls back to the row index when its layout is not known yet', () => {
    const ref = createRef<Handle>();
    renderList({}, ref);
    act(() => ref.current?.scrollToItemKey('b'));
    expect(state.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: true, viewPosition: 0.5 });
  });

  it('folds the card box away while asked to, or while the map cannot draw, keeping the map full size inside', () => {
    const view = renderList({ mapHidden: true });
    expect(styleOf('map-card-box')).toMatchObject({ height: 0, overflow: 'hidden' });
    expect(styleOf('map-card')).toMatchObject({ height: 210 });
    expect(styleOf('map-card-spacer')).toMatchObject({ height: 0 });
    expect(screen.getByTestId('the-map')).toBeTruthy();
    view.rerender(
      createElement(MapCardList<Row>, {
        data: ROWS,
        renderItem: renderRow,
        keyExtractor: rowKey,
        map: createElement('div', { 'data-testid': 'the-map' }),
        mapAvailable: false,
      }),
    );
    expect(styleOf('map-card-box')).toMatchObject({ height: 0 });
  });

  it('pins the card above the list when asked: no spacer, no scroll-linked move, locate on the card', () => {
    state.scrollOffset = 300;
    const onLocate = vi.fn();
    renderList({ cardPinned: true, stickyHeader: undefined, footer: undefined, onLocate });
    const box = styleOf('map-card-box');
    expect(box).toMatchObject({ height: 226, overflow: 'hidden' });
    expect(box.position).toBeUndefined();
    expect(box.transform).toBeUndefined();
    expect(screen.queryByTestId('map-card-spacer')).toBeNull();
    expect(styleOf('map-card-band')).toMatchObject({ height: 210, overflow: 'hidden' });
    expect(styleOf('map-card')).toMatchObject({ height: 210 });
    expect(styleOf('map-card').transform).toBeUndefined();
    // Still never inside the scroll view.
    expect(screen.getByTestId('flash-list').contains(screen.getByTestId('the-map'))).toBe(false);
    fireEvent.click(screen.getByTestId('map-card-locate'));
    expect(onLocate).toHaveBeenCalledOnce();
  });

  it('keeps the whole pinned card while the keyboard is up for a field above it (not compact)', () => {
    state.keyboardOverlap = 500;
    renderList({ cardPinned: true });
    expect(styleOf('map-card-box')).toMatchObject({ height: 226 });
    expect(styleOf('map-card-band')).toMatchObject({ height: 210 });
    expect(styleOf('map-card').marginTop).toBeUndefined();
  });

  it('shows the middle band of a compact pinned card, moved by layout, the map keeping its size', () => {
    // The page is 700 pt: 280 above a 420 pt keyboard, 280 - 120 - 16 = 144 pt of band.
    state.keyboardOverlap = 420;
    renderList({ cardPinned: true, cardCompact: true });
    expect(styleOf('map-card-box')).toMatchObject({ height: 144 + 16 });
    expect(styleOf('map-card-band')).toMatchObject({ height: 144 });
    // Half of the 66 pt cut, by margin (it animates with the band), never a transform.
    const card = styleOf('map-card');
    expect(card).toMatchObject({ height: 210, marginTop: -33 });
    expect(card.transform).toBeUndefined();
    // The rows keep 120 pt above the keyboard.
    expect(700 - 420 - styleOf('map-card-box').height).toBeGreaterThanOrEqual(120);
    expect(screen.getByTestId('the-map')).toBeTruthy();
    // The locate button sits on the band, so it stays in view.
    expect(screen.getByTestId('map-card-band').contains(screen.getByTestId('map-card-locate'))).toBe(true);
    expect(screen.getByTestId('map-card').contains(screen.getByTestId('map-card-locate'))).toBe(false);
  });

  it('folds a compact pinned card where no useful band fits, and unfolds once it is no longer compact', () => {
    // 200 pt above the keyboard: 64 pt of band, under 88.
    state.keyboardOverlap = 500;
    const view = renderList({ cardPinned: true, cardCompact: true });
    expect(styleOf('map-card-box')).toMatchObject({ height: 0, overflow: 'hidden' });
    // Clipped, not resized or unmounted: the map keeps its size and camera.
    expect(styleOf('map-card')).toMatchObject({ height: 210 });
    expect(styleOf('map-card').marginTop).toBeUndefined();
    expect(screen.getByTestId('the-map')).toBeTruthy();
    view.rerender(
      createElement(MapCardList<Row>, {
        data: ROWS,
        renderItem: renderRow,
        keyExtractor: rowKey,
        map: createElement('div', { 'data-testid': 'the-map' }),
        cardPinned: true,
        cardCompact: false,
      }),
    );
    expect(styleOf('map-card-box')).toMatchObject({ height: 226 });
    expect(styleOf('map-card')).toMatchObject({ height: 210 });
  });

  it('folds a pinned card while the map cannot draw, keeping the map mounted', () => {
    renderList({ cardPinned: true, mapAvailable: false });
    expect(styleOf('map-card-box')).toMatchObject({ height: 0, overflow: 'hidden' });
    expect(styleOf('map-card')).toMatchObject({ height: 210 });
    expect(screen.getByTestId('the-map')).toBeTruthy();
  });

  it('is a plain list with no map: no card, and no sticky row without a sticky header', () => {
    const ref = createRef<Handle>();
    renderList({ map: undefined, stickyHeader: undefined }, ref);
    expect(screen.queryByTestId('map-card-box')).toBeNull();
    expect(state.listProps?.stickyHeaderIndices).toBeUndefined();
    act(() => ref.current?.scrollToItemKey('b'));
    expect(state.scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true, viewPosition: 0.5 });
  });
});
