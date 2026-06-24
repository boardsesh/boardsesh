// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable feed mock so each test can set the hook's return shape.
const feed = vi.hoisted(() => ({
  current: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    isRefetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  },
}));

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (specifics: Record<string, unknown>) => specifics.ios ?? specifics.default },
  Pressable: ({ children, onPress, disabled }: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: disabled ? undefined : onPress, disabled }, children),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListEmptyComponent,
  }: {
    data: Array<{ uuid: string }>;
    renderItem: (info: { item: { uuid: string } }) => ReactNode;
    ListEmptyComponent?: ReactNode;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'flash-list' },
      data.length > 0 ? data.map((item) => renderItem({ item })) : ListEmptyComponent,
    ),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../LogbookRow', () => ({ LogbookRow: () => createElement('div') }));
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../LogbookFilterSheet', () => ({ LogbookFilterSheet: () => null }));
vi.mock('../../SearchHeader', () => ({ SearchHeader: () => null }));
vi.mock('../../ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../lib/graphql/hooks', () => ({ useUserAscentsFeed: () => feed.current }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));

import { LogbookTab } from '../LogbookTab';

beforeEach(() => {
  feed.current.refetch = vi.fn();
  feed.current.data = undefined;
  feed.current.isPending = false;
  feed.current.isError = false;
  feed.current.isRefetching = false;
});

describe('LogbookTab error state', () => {
  it('renders the error view with a retry control when the feed errors', () => {
    feed.current.isError = true;

    render(createElement(LogbookTab, { userId: 'user-1' }));

    // The error title must render, not the empty-state copy.
    expect(screen.getByText('mobile.logbook.errorTitle')).toBeTruthy();
    expect(screen.queryByText('mobile.logbook.empty')).toBeNull();
    expect(screen.getByText('mobile.logbook.retry')).toBeTruthy();
  });

  it('calls refetch when the retry control is pressed', () => {
    feed.current.isError = true;

    render(createElement(LogbookTab, { userId: 'user-1' }));

    fireEvent.click(screen.getByText('mobile.logbook.retry'));

    expect(feed.current.refetch).toHaveBeenCalledTimes(1);
  });

  it('still shows the empty state on a successful feed with zero items', () => {
    feed.current.isError = false;
    feed.current.data = { pages: [{ userAscentsFeed: { items: [] } }] };

    render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(screen.getByText('mobile.logbook.empty')).toBeTruthy();
    expect(screen.queryByText('mobile.logbook.errorTitle')).toBeNull();
  });
});
