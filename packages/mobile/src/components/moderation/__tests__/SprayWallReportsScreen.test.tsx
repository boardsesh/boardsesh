// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SprayWallReportsScreen } from '../SprayWallReportsScreen';
const state = vi.hoisted(() => ({
  canReview: true,
  offline: false,
  isError: false,
  isPending: false,
  reviewError: false,
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
  }) =>
    createElement(
      'div',
      null,
      data.length
        ? data.map((item, index) => createElement('div', { key: index }, renderItem({ item })))
        : ListEmptyComponent,
    ),
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
  useSprayModerationAccess: () => ({ canReview: state.canReview, sessionScope: 7 }),
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
  useReviewSprayWall: () => ({ mutate, isPending: false, isError: state.reviewError }),
}));
beforeEach(() => {
  state.canReview = true;
  state.offline = false;
  state.isError = false;
  state.isPending = false;
  state.reviewError = false;
  mutate.mockReset();
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
  it('groups pending reasons under one wall and offers hide and keep-visible decisions', () => {
    const screen = render(<SprayWallReportsScreen />);
    expect(screen.getAllByText('Crew wall')).toHaveLength(1);
    expect(screen.getByText('sprayModeration.reasons.other')).toBeTruthy();
    expect(screen.getByText('sprayModeration.reasons.personalInfo')).toBeTruthy();
    fireEvent.click(screen.getByText('sprayModeration.hide'));
    expect(mutate).toHaveBeenLastCalledWith({ input: { uuid: 'wall-a', hidden: true } });
    fireEvent.click(screen.getByText('sprayModeration.keepVisible'));
    expect(mutate).toHaveBeenLastCalledWith({ input: { uuid: 'wall-a', hidden: false } });
  });
  it('keeps the grouped wall and reasons visible after failed review', () => {
    state.reviewError = true;
    const screen = render(<SprayWallReportsScreen />);
    expect(screen.getByText('Crew wall')).toBeTruthy();
    expect(screen.getByText('sprayModeration.reviewError')).toBeTruthy();
  });
  it('disables review while offline', () => {
    state.offline = true;
    const screen = render(<SprayWallReportsScreen />);
    fireEvent.click(screen.getByText('sprayModeration.hide'));
    expect(mutate).not.toHaveBeenCalled();
  });
});
