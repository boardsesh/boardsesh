// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SprayWallReportsScreen } from '../SprayWallReportsScreen';
const state = vi.hoisted(() => ({
  canReview: true,
  sessionScope: 7,
  offline: false,
  isError: false,
  isPending: false,
  reports: [
    {
      id: '1',
      wallUuid: 'wall-a',
      wallName: 'Crew wall',
      layoutId: 7,
      reason: 'OTHER',
      hidden: false,
      createdAt: '',
      photo: null,
    },
    {
      id: '2',
      wallUuid: 'wall-a',
      wallName: 'Crew wall',
      layoutId: 7,
      reason: 'PERSONAL_INFO',
      hidden: false,
      createdAt: '',
      photo: null,
    },
  ],
}));
const list = vi.hoisted(() => ({ renderItem: null as unknown, rows: [] as unknown[] }));
const mutate = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const queryInput = vi.hoisted(() => vi.fn());
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListEmptyComponent,
  }: {
    data: unknown[];
    renderItem: (input: { item: unknown }) => ReactNode;
    ListEmptyComponent: ReactNode;
  }) => {
    list.renderItem = renderItem;
    list.rows = data;
    return createElement(
      'div',
      null,
      data.length
        ? data.map((item, index) => createElement('div', { key: index }, renderItem({ item })))
        : ListEmptyComponent,
    );
  },
}));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    actions,
    onSelectIndex,
  }: {
    actions: { label: string; disabled: boolean }[];
    onSelectIndex: (index: number) => void;
  }) =>
    createElement(
      'div',
      null,
      actions.map((action, index) =>
        createElement(
          'button',
          { key: index, disabled: action.disabled, onClick: () => onSelectIndex(index) },
          action.label,
        ),
      ),
    ),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', null, 'Loading') }));
vi.mock('../../OfflineState', () => ({ OfflineState: () => createElement('span', null, 'Offline') }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {}, brandColors: {} }) }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline }),
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: state.offline, reason: 'offline' }),
}));
vi.mock('../../../lib/spray/use-spray-moderation', () => ({
  useSprayModerationAccess: () => ({ canReview: state.canReview, sessionScope: state.sessionScope }),
  useSprayWallReports: (enabled: boolean, scope: number) => {
    queryInput(enabled, scope);
    return {
      data: state.reports,
      status: 'success',
      fetchStatus: 'idle',
      isError: state.isError,
      isPending: state.isPending,
      isRefetching: false,
      refetch,
    };
  },
  useReviewSprayWall: () => ({ mutateAsync: mutate }),
}));
beforeEach(() => {
  state.canReview = true;
  state.sessionScope = 7;
  state.offline = false;
  state.isError = false;
  state.isPending = false;
  mutate.mockReset();
  mutate.mockResolvedValue({ uuid: 'wall-a' });
  queryInput.mockReset();
  refetch.mockReset();
});
describe('SprayWallReportsScreen', () => {
  it('blocks direct-route access and query fetching without admin access', () => {
    state.canReview = false;
    const screen = render(<SprayWallReportsScreen />);
    expect(screen.getByText('sprayModeration.unavailable')).toBeTruthy();
    expect(screen.queryByText('Crew wall')).toBeNull();
    expect(queryInput).toHaveBeenCalledWith(false, 7);
  });
  it('groups pending reasons under one wall and offers hide and keep-visible decisions', async () => {
    const screen = render(<SprayWallReportsScreen />);
    expect(screen.getAllByText('Crew wall')).toHaveLength(1);
    expect(screen.getByText('sprayModeration.reasons.other')).toBeTruthy();
    expect(screen.getByText('sprayModeration.reasons.personalInfo')).toBeTruthy();
    fireEvent.click(screen.getByText('sprayModeration.hide'));
    expect(mutate).toHaveBeenLastCalledWith({ input: { uuid: 'wall-a', hidden: true } });
    await waitFor(() =>
      expect((screen.getByText('sprayModeration.keepVisible') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('sprayModeration.keepVisible'));
    expect(mutate).toHaveBeenLastCalledWith({ input: { uuid: 'wall-a', hidden: false } });
  });
  it('keeps the failed wall visible and enables retry for that wall', async () => {
    mutate.mockRejectedValueOnce(new Error('Server unavailable'));
    const screen = render(<SprayWallReportsScreen />);
    expect(screen.getByText('Crew wall')).toBeTruthy();
    fireEvent.click(screen.getByText('sprayModeration.hide'));
    await waitFor(() => expect(screen.getByText('sprayModeration.reviewError')).toBeTruthy());
    fireEvent.click(screen.getByText('sprayModeration.keepVisible'));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('sprayModeration.reviewError')).toBeNull());
  });
  it('retains same-wall pending guards through an access off/on cycle', async () => {
    let settleReview: (result: { uuid: string }) => void = () => {
      throw new Error('No pending review');
    };
    mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleReview = resolve;
        }),
    );
    const screen = render(<SprayWallReportsScreen />);
    fireEvent.click(screen.getByText('sprayModeration.hide'));
    state.canReview = false;
    screen.rerender(<SprayWallReportsScreen />);
    expect(screen.queryByText('Crew wall')).toBeNull();
    state.canReview = true;
    screen.rerender(<SprayWallReportsScreen />);
    expect((screen.getByText('sprayModeration.keepVisible') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('sprayModeration.keepVisible'));
    expect(mutate).toHaveBeenCalledTimes(1);
    await act(async () => {
      settleReview({ uuid: 'wall-a' });
    });
    expect((screen.getByText('sprayModeration.keepVisible') as HTMLButtonElement).disabled).toBe(false);
  });
  it('ignores an old account completion while the new account reviews the same wall', async () => {
    let rejectOld: (reason: Error) => void = () => {
      throw new Error('No pending old review');
    };
    let resolveNew: (result: { uuid: string }) => void = () => {
      throw new Error('No pending new review');
    };
    mutate
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
    const screen = render(<SprayWallReportsScreen />);
    fireEvent.click(screen.getByText('sprayModeration.hide'));
    state.sessionScope = 8;
    screen.rerender(<SprayWallReportsScreen />);
    fireEvent.click(screen.getByText('sprayModeration.keepVisible'));
    expect(mutate).toHaveBeenCalledTimes(2);
    await act(async () => {
      rejectOld(new Error('Old account failed'));
    });
    expect(screen.queryByText('sprayModeration.reviewError')).toBeNull();
    expect((screen.getByText('sprayModeration.hide') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolveNew({ uuid: 'wall-a' });
    });
    expect((screen.getByText('sprayModeration.hide') as HTMLButtonElement).disabled).toBe(false);
  });
  it('isolates pending and error states by wall with a stable render callback', async () => {
    const reportsBefore = state.reports;
    state.reports = [...reportsBefore, { ...reportsBefore[0], id: '3', wallUuid: 'wall-b', wallName: 'Second wall' }];
    let rejectFirst: (reason: Error) => void = () => {
      throw new Error('No pending review');
    };
    let resolveSecond: (result: { uuid: string }) => void = () => {
      throw new Error('No pending review');
    };
    mutate
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const screen = render(<SprayWallReportsScreen />);
    const originalRenderItem = list.renderItem;
    const originalRows = list.rows;
    fireEvent.click(screen.getAllByText('sprayModeration.hide')[0]);
    fireEvent.click(screen.getAllByText('sprayModeration.hide')[0]);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect((screen.getAllByText('sprayModeration.hide')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByText('sprayModeration.hide')[1] as HTMLButtonElement).disabled).toBe(false);
    expect(list.renderItem).toBe(originalRenderItem);
    expect(list.rows).not.toBe(originalRows);
    fireEvent.click(screen.getAllByText('sprayModeration.keepVisible')[1]);
    expect(mutate).toHaveBeenCalledTimes(2);
    await act(async () => {
      rejectFirst(new Error('Review failed'));
    });
    expect(screen.getAllByText('sprayModeration.reviewError')).toHaveLength(1);
    expect((screen.getAllByText('sprayModeration.hide')[0] as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getAllByText('sprayModeration.hide')[1] as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolveSecond({ uuid: 'wall-b' });
    });
    expect((screen.getAllByText('sprayModeration.hide')[1] as HTMLButtonElement).disabled).toBe(false);
    state.reports = reportsBefore;
  });
  it('disables review while offline', () => {
    state.offline = true;
    const screen = render(<SprayWallReportsScreen />);
    fireEvent.click(screen.getByText('sprayModeration.hide'));
    expect(mutate).not.toHaveBeenCalled();
  });
});
