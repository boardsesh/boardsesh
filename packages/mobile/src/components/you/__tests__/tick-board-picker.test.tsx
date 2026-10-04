// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TickBoardOption } from '@boardsesh/graphql/operations';
import { TickBoardPicker } from '../TickBoardPicker';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../lib/screenshot-mode', () => ({
  screenshotModeNextPageParam: (offset: number | undefined) => offset,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', null, 'Loading') }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityState,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityRole?: string;
    accessibilityState?: { checked: boolean };
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        role: accessibilityRole,
        'aria-label': accessibilityLabel,
        'aria-checked': accessibilityState?.checked,
      },
      children,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, spacing: { 2: 8, 3: 12 } }),
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({
    data,
    renderItem,
    onEndReached,
    ListFooterComponent,
  }: {
    data: (TickBoardOption | null)[];
    renderItem: (props: { item: TickBoardOption | null }) => ReactNode;
    onEndReached: () => void;
    ListFooterComponent: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      ...data.map((item) => createElement('div', { key: item?.uuid ?? 'none' }, renderItem({ item }))),
      createElement('button', { onClick: onEndReached }, 'End reached'),
      ListFooterComponent,
    ),
}));

const board: TickBoardOption = {
  uuid: 'homewall',
  name: 'Homewall',
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 17,
  setIds: '26,27',
};
const page = (boards: TickBoardOption[], hasMore = false) => ({
  tickBoardOptions: { boards, currentBoard: board, totalCount: hasMore ? 21 : boards.length, hasMore },
});
function openPicker() {
  const onSelect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TickBoardPicker, {
        tickUuid: 'tick',
        selection: undefined,
        onSelect,
        onBack: vi.fn(),
      }),
    ),
  );
  return onSelect;
}
beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

describe('TickBoardPicker', () => {
  it('keeps None usable while loading, without claiming it is selected', () => {
    request.mockReturnValue(new Promise(() => {}));
    const onSelect = openPicker();
    const none = screen.getByRole('radio', { name: 'mobile.logbook.boardNone' });
    expect(none.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(none);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('loads one more page per end reach and selects the resulting board', async () => {
    const secondBoard = { ...board, uuid: 'second', name: 'Second Homewall' };
    request.mockResolvedValueOnce(page([board], true)).mockResolvedValueOnce(page([secondBoard]));
    const onSelect = openPicker();
    expect((await screen.findByRole('radio', { name: 'Homewall' })).getAttribute('aria-checked')).toBe('true');
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('End reached'));
    fireEvent.click(await screen.findByRole('radio', { name: 'Second Homewall' }));
    expect(request.mock.calls[1][1]).toMatchObject({ offset: 20, limit: 20 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith(secondBoard);
  });

  it('offers retry after a request fails and keeps None available', async () => {
    request.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([]));
    openPicker();
    fireEvent.click(await screen.findByText('mobile.logbook.boardRetry'));
    await waitFor(() => expect(screen.queryByText('mobile.logbook.boardRetry')).toBeNull());
    expect(await screen.findByText('mobile.logbook.boardEmpty')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'mobile.logbook.boardNone' })).toBeTruthy();
  });
});
