// @vitest-environment jsdom
//
// The gym finder inside a sheet: a map card over the rows, a capsule row that
// sticks, "Add my gym" pinned above the home indicator (and at the end of the
// list while the keyboard is up), and nothing that looks like a second sheet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, createRef, forwardRef, useEffect, useImperativeHandle, type ReactNode, type Ref } from 'react';

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

const state = vi.hoisted(() => ({
  keyboardOverlap: 0,
  listProps: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID, style, onLayout }: ViewProps) => {
    const flat = flatten(style ?? null);
    useEffect(() => {
      // The page measures 700pt; the pinned footer 80pt.
      onLayout?.({ nativeEvent: { layout: { height: testID === 'map-card-list-footer' ? 80 : 700 } } });
    }, [onLayout, testID]);
    return createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flat) }, children);
  },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
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
      useImperativeHandle(ref, () => ({ scrollToIndex: state.scrollToIndex, scrollToOffset: state.scrollToOffset }));
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

const { MapCardList, mapCardHeight } = await import('../MapCardList');
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

describe('MapCardList', () => {
  it('draws the map in a card above the rows, with locate, a sticky capsule row, and no sheet chrome', () => {
    const onLocate = vi.fn();
    renderList({ onLocate });
    expect(styleOf('map-card')).toMatchObject({ height: 210, borderRadius: 12, overflow: 'hidden' });
    expect(screen.getByTestId('the-map')).toBeTruthy();
    fireEvent.click(screen.getByTestId('map-card-locate'));
    expect(onLocate).toHaveBeenCalledOnce();
    // The capsules are row 0 and stick; the caller's rows follow.
    expect(state.listProps?.stickyHeaderIndices).toEqual([0]);
    expect(screen.getByTestId('capsules')).toBeTruthy();
    expect(screen.getByTestId('row-b').textContent).toBe('Monk');
    // A page, not a panel: no rounded top, no shadow.
    const page = styleOf('page');
    expect(page.borderTopLeftRadius).toBeUndefined();
    expect(page.shadowOpacity).toBeUndefined();
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

  it('scrolls a pinned row into view, counting the sticky row above it', () => {
    const ref = createRef<Handle>();
    renderList({}, ref);
    act(() => ref.current?.scrollToItemKey('b'));
    expect(state.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: true, viewPosition: 0.3 });
    act(() => ref.current?.scrollToItemKey('missing'));
    expect(state.scrollToIndex).toHaveBeenCalledOnce();
    act(() => ref.current?.scrollToTop());
    expect(state.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  });

  it('folds the card away while asked to, or while the map cannot draw, keeping the map mounted', () => {
    const view = renderList({ mapHidden: true });
    expect(styleOf('map-card')).toMatchObject({ height: 0 });
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
    expect(styleOf('map-card')).toMatchObject({ height: 0 });
  });

  it('is a plain list with no map: no card, and no sticky row without a sticky header', () => {
    renderList({ map: undefined, stickyHeader: undefined });
    expect(screen.queryByTestId('map-card')).toBeNull();
    expect(state.listProps?.stickyHeaderIndices).toBeUndefined();
    const ref = createRef<Handle>();
    cleanup();
    renderList({ map: undefined, stickyHeader: undefined }, ref);
    act(() => ref.current?.scrollToItemKey('b'));
    expect(state.scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true, viewPosition: 0.3 });
  });
});
