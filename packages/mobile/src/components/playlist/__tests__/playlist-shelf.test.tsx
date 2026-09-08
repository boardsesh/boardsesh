// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ShelfListProps {
  data: { uuid: string }[];
  onEndReached: () => void;
  onScrollBeginDrag: () => void;
  onScrollEndDrag: () => void;
  onMomentumScrollBegin: () => void;
  onMomentumScrollEnd: () => void;
  onScroll: (event: {
    nativeEvent: {
      contentOffset: { x: number };
      contentSize: { width: number };
      layoutMeasurement: { width: number };
    };
  }) => void;
  keyExtractor: (item: { uuid: string }) => string;
  renderItem: unknown;
  extraData: unknown;
  drawDistance: number;
}
const list = vi.hoisted(() => ({ current: null as ShelfListProps | null }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: ShelfListProps) => {
    list.current = props;
    return createElement('div', { 'data-count': props.data.length });
  },
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    textStyles: { subheadline: { lineHeight: 20 }, caption1: { lineHeight: 16 } },
  }),
}));
vi.mock('../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
import { PlaylistShelf, playlistShelfHeight } from '../PlaylistShelf';

const keyExtractor = (item: { uuid: string }) => item.uuid;
const renderItem = () => null;
const nearEnd = {
  nativeEvent: {
    contentOffset: { x: 950 },
    contentSize: { width: 1400 },
    layoutMeasurement: { width: 390 },
  },
};
function callbacks(): ShelfListProps {
  if (!list.current) throw new Error('No list mounted.');
  return list.current;
}
beforeEach(() => {
  list.current = null;
});
describe('playlist shelf pagination', () => {
  it('loads one page per user end-reach and never drains appended data', () => {
    const loadMore = vi.fn();
    const initial = [{ uuid: 'first' }];
    const props = {
      title: 'Owned',
      items: initial,
      renderItem,
      keyExtractor,
      hasMore: true,
      onEndReached: loadMore,
    };
    const view = render(<PlaylistShelf {...props} />);
    act(() => callbacks().onEndReached());
    expect(loadMore).not.toHaveBeenCalled();
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onScroll(nearEnd);
      callbacks().onEndReached();
    });
    expect(loadMore).toHaveBeenCalledTimes(1);
    view.rerender(<PlaylistShelf {...props} items={[...initial, { uuid: 'second' }]} />);
    act(() => {
      callbacks().onEndReached();
      callbacks().onScroll(nearEnd);
    });
    expect(loadMore).toHaveBeenCalledTimes(1);
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onScroll(nearEnd);
    });
    expect(loadMore).toHaveBeenCalledTimes(2);
  });
  it('allows another gesture to retry after failure or a duplicate-only page', () => {
    const loadMore = vi.fn();
    const props = {
      title: 'Owned',
      items: [{ uuid: 'first' }],
      renderItem,
      keyExtractor,
      hasMore: true,
      onEndReached: loadMore,
    };
    const view = render(<PlaylistShelf {...props} />);
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onEndReached();
    });
    view.rerender(<PlaylistShelf {...props} isLoadingMore />);
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onScroll(nearEnd);
    });
    expect(loadMore).toHaveBeenCalledTimes(1);
    view.rerender(<PlaylistShelf {...props} items={[{ uuid: 'first' }]} />);
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onScroll(nearEnd);
      callbacks().onScroll(nearEnd);
    });
    expect(loadMore).toHaveBeenCalledTimes(2);
  });
  it('does not rearm while a page is pending or fetch solely from its append', () => {
    const loadMore = vi.fn();
    const props = {
      title: 'Owned',
      items: [{ uuid: 'first' }],
      renderItem,
      keyExtractor,
      hasMore: true,
      onEndReached: loadMore,
    };
    const view = render(<PlaylistShelf {...props} />);
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onEndReached();
    });
    view.rerender(<PlaylistShelf {...props} isLoadingMore />);
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onScroll(nearEnd);
      callbacks().onScrollEndDrag();
      callbacks().onMomentumScrollBegin();
    });
    view.rerender(<PlaylistShelf {...props} items={[...props.items, { uuid: 'second' }]} />);
    act(() => callbacks().onEndReached());
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
  it('does not fetch an exhausted stream or fetch after a settled gesture', () => {
    const loadMore = vi.fn();
    const props = {
      title: 'Owned',
      items: [{ uuid: 'first' }],
      renderItem,
      keyExtractor,
      hasMore: false,
      onEndReached: loadMore,
    };
    const view = render(<PlaylistShelf {...props} />);
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onScroll(nearEnd);
    });
    expect(loadMore).not.toHaveBeenCalled();
    view.rerender(<PlaylistShelf {...props} hasMore />);
    act(() => {
      callbacks().onScrollEndDrag();
      callbacks().onMomentumScrollEnd();
      callbacks().onScroll(nearEnd);
    });
    expect(loadMore).not.toHaveBeenCalled();
  });
  it('loads at the end of momentum using the same gesture budget', () => {
    const loadMore = vi.fn();
    render(
      <PlaylistShelf
        title="Owned"
        items={[{ uuid: 'first' }]}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        hasMore
        onEndReached={loadMore}
      />,
    );
    act(() => {
      callbacks().onScrollBeginDrag();
      callbacks().onScrollEndDrag();
      callbacks().onMomentumScrollBegin();
      callbacks().onScroll(nearEnd);
      callbacks().onEndReached();
    });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
  it.each([20, 100, 200])('retains all %i items and passes a bounded draw window to FlashList', (count) => {
    const items = Array.from({ length: count }, (_, index) => ({ uuid: String(index) }));
    const extraData = { pinned: true };
    render(
      <PlaylistShelf
        title="Owned"
        items={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={extraData}
        hasMore
        onEndReached={vi.fn()}
      />,
    );
    expect(callbacks().data).toBe(items);
    expect(callbacks().drawDistance).toBe(240);
    expect(callbacks().renderItem).toBe(renderItem);
    expect(callbacks().extraData).toBe(extraData);
    expect(callbacks().keyExtractor(items[count - 1])).toBe(String(count - 1));
  });
  it('reserves room for card text up to the shared Text scaling cap', () => {
    expect(playlistShelfHeight(1, 20, 16)).toBe(172);
    expect(playlistShelfHeight(1.5, 20, 16)).toBe(190);
    expect(playlistShelfHeight(3, 20, 16)).toBe(190);
  });
});
