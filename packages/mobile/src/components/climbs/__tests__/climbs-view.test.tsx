// @vitest-environment jsdom
import { createElement, useEffect, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { FlashListProps } from '@shopify/flash-list';

const listMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-native', () => ({
  StyleSheet: { create: <Styles,>(styles: Styles) => styles, absoluteFill: {} },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: FlashListProps<Climb>) => {
    useEffect(() => {
      listMounts.count++;
    }, []);
    return createElement(
      'div',
      {},
      createElement('button', { onClick: props.onEndReached }, 'Load more'),
      props.data?.map((item, index) =>
        createElement(
          'div',
          { key: item.uuid },
          props.renderItem?.({ item, index, target: 'Cell', extraData: undefined }),
        ),
      ),
    );
  },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff' } }),
}));

import { ClimbsView } from '../ClimbsView';
import { ContentRenderObserverProvider } from '../../ContentRenderObserver';
import { climbListThumbnailSize } from '../../climb-list-thumbnail-metrics';

const climb: Climb = {
  uuid: 'first',
  name: 'First climb',
  setter_username: 'Sam',
  frames: 'p1213r12',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '6b/V4',
  quality_average: '4',
  stars: 4,
  difficulty_error: '0',
  benchmark_difficulty: null,
};
const thumbnailSize = climbListThumbnailSize(1);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ClimbsView', () => {
  it('renders injected rows and actions without live app providers', () => {
    const onPress = vi.fn();
    const onEndReached = vi.fn();
    const observe = vi.fn();
    const rendered = render(
      <ContentRenderObserverProvider onContentRendered={observe}>
        <ClimbsView
          thumbnailSize={thumbnailSize}
          chrome={<div>Filters</div>}
          listProps={{
            data: [climb],
            onEndReached,
            renderItem: ({ item }) => <button onClick={() => onPress(item)}>{item.name}</button>,
          }}
        />
      </ContentRenderObserverProvider>,
    );
    fireEvent.click(rendered.getByText('First climb'));
    fireEvent.click(rendered.getByText('Load more'));
    expect(onPress).toHaveBeenCalledWith(climb);
    expect(onEndReached).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({ route: '/climbs', count: 1 });
    expect(rendered.getByText('Filters')).toBeTruthy();
  });

  it('remounts the virtualized list when changing column count', () => {
    listMounts.count = 0;
    const rendered = render(
      <ClimbsView thumbnailSize={thumbnailSize} listProps={{ data: [climb], renderItem: () => null, numColumns: 1 }} />,
    );
    rendered.rerender(
      <ClimbsView thumbnailSize={thumbnailSize} listProps={{ data: [climb], renderItem: () => null, numColumns: 2 }} />,
    );
    expect(listMounts.count).toBe(2);
  });

  it('delays the placeholder tint and cancels it when results arrive', () => {
    vi.useFakeTimers();
    const props = { thumbnailSize, listProps: { data: [climb], renderItem: () => null } };
    const rendered = render(<ClimbsView {...props} placeholder />);
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(rendered.queryByTestId('climb-list-placeholder-tint')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(rendered.queryByTestId('climb-list-placeholder-tint')).not.toBeNull();
    rendered.rerender(<ClimbsView {...props} placeholder={false} />);
    expect(rendered.queryByTestId('climb-list-placeholder-tint')).toBeNull();
  });
});
