// @vitest-environment jsdom
//
// The gym rows shared by the builder's gym picker sheet and the gym-first
// "Find your gym's board" screen (#8151).
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
type ListProps = {
  data: { uuid: string }[];
  renderItem: (info: { item: { uuid: string } }) => ReactNode;
  keyExtractor: (item: { uuid: string }) => string;
  keyboardShouldPersistTaps?: string;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  ListEmptyComponent?: ReactNode;
};

function renderList(listId: string) {
  return ({ data, renderItem, keyExtractor, keyboardShouldPersistTaps, ...slots }: ListProps) =>
    createElement('div', { 'data-testid': listId, 'data-persist-taps': keyboardShouldPersistTaps ?? '' }, [
      createElement('div', { key: 'header' }, slots.ListHeaderComponent),
      data.length === 0
        ? createElement('div', { key: 'empty' }, slots.ListEmptyComponent)
        : data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
      createElement('div', { key: 'footer' }, slots.ListFooterComponent),
    ]);
}

vi.mock('react-native', () => ({
  FlatList: renderList('flat-list'),
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: Children & { onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12, 4: 16 } }));

const { GymSearchList } = await import('../GymSearchList');

const gyms = [
  { uuid: 'gym-1', name: 'Boulder Space', address: '1 Wall St' },
  { uuid: 'gym-2', name: 'Crag Hall', address: null },
] as never[];

describe('GymSearchList', () => {
  it('draws one row per gym with its address, in a plain FlatList by default', () => {
    render(createElement(GymSearchList, { gyms, onSelect: vi.fn() }));
    expect(screen.getByTestId('flat-list')).toBeTruthy();
    expect(screen.getByText('Boulder Space')).toBeTruthy();
    expect(screen.getByText('1 Wall St')).toBeTruthy();
    expect(screen.getByText('Crag Hall')).toBeTruthy();
  });

  it('lets the first tap land while the keyboard is up', () => {
    render(createElement(GymSearchList, { gyms, onSelect: vi.fn() }));
    expect(screen.getByTestId('flat-list').getAttribute('data-persist-taps')).toBe('handled');
  });

  it('hands the tapped gym on', () => {
    const onSelect = vi.fn();
    render(createElement(GymSearchList, { gyms, onSelect }));
    fireEvent.click(screen.getByText('Crag Hall'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'gym-2' }));
  });

  it('checks the chosen gym, and draws chevrons for rows that open a screen', () => {
    const { container, rerender } = render(
      createElement(GymSearchList, { gyms, onSelect: vi.fn(), selectedUuid: 'gym-1' }),
    );
    expect(container.querySelectorAll('[data-icon="check.small"]')).toHaveLength(1);
    rerender(createElement(GymSearchList, { gyms, onSelect: vi.fn(), showChevrons: true }));
    expect(container.querySelectorAll('[data-icon="chevron.right"]')).toHaveLength(2);
  });

  it('uses the list the host hands in, with its header, footer and empty state', () => {
    const SheetList = renderList('sheet-list');
    render(
      createElement(GymSearchList, {
        gyms: [],
        onSelect: vi.fn(),
        ListComponent: SheetList as never,
        ListHeaderComponent: createElement('p', null, 'search here'),
        ListEmptyComponent: createElement('p', null, 'no gyms'),
        ListFooterComponent: createElement('p', null, 'not listed'),
      }),
    );
    expect(screen.getByTestId('sheet-list')).toBeTruthy();
    expect(screen.getByText('search here')).toBeTruthy();
    expect(screen.getByText('no gyms')).toBeTruthy();
    expect(screen.getByText('not listed')).toBeTruthy();
  });
});
