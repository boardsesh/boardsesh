// @vitest-environment jsdom
import { createElement, useEffect, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  focused: true,
  fetching: false,
  history: vi.fn(),
  refresh: vi.fn(),
  nextPage: vi.fn(),
  onEndReached: null as (() => void) | null,
  push: vi.fn(),
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mocks.push }),
  useIsFocused: () => mocks.focused,
  useFocusEffect: (callback: () => void) =>
    useEffect(() => {
      if (mocks.focused) return callback();
    }, [callback, mocks.focused]),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true, isLoading: false }) }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'account', isLoading: false }),
}));
vi.mock('../../../hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({ useOfflineQueryState: () => ({ isBlocked: false }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', separator: '#aaa' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16, 6: 24 } }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => 'now' }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../OfflineState', () => ({ OfflineState: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../Button', () => ({ Button: () => null }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({ onEndReached }: { onEndReached: () => void }) => {
    mocks.onEndReached = onEndReached;
    return null;
  },
}));
vi.mock('../../../lib/feedback/use-bug-reports', () => ({
  useMyAppBugReports: (accountId: string, enabled: boolean) => {
    mocks.history(accountId, enabled);
    return {
      data: { pages: [] },
      refetch: mocks.refresh,
      fetchNextPage: mocks.nextPage,
      hasNextPage: true,
      isFetching: mocks.fetching,
      isFetchingNextPage: false,
      isRefetching: mocks.fetching,
      isPending: false,
      isError: false,
    };
  },
}));

import BugReportsScreen from '../BugReportsScreen';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.focused = true;
  mocks.fetching = false;
  mocks.onEndReached = null;
});

describe('bug report history screen', () => {
  it('pauses the history query and end-reached requests beneath a conversation', () => {
    mocks.focused = false;
    const { rerender } = render(<BugReportsScreen />);
    expect(mocks.history).toHaveBeenLastCalledWith('account', false);
    act(() => mocks.onEndReached?.());
    expect(mocks.nextPage).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    mocks.focused = true;
    rerender(<BugReportsScreen />);
    expect(mocks.history).toHaveBeenLastCalledWith('account', true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it('loads one page only when focused and no other request is running', () => {
    mocks.fetching = true;
    const { rerender } = render(<BugReportsScreen />);
    act(() => mocks.onEndReached?.());
    expect(mocks.nextPage).not.toHaveBeenCalled();
    mocks.fetching = false;
    rerender(<BugReportsScreen />);
    act(() => mocks.onEndReached?.());
    expect(mocks.nextPage).toHaveBeenCalledOnce();
    expect(mocks.nextPage).toHaveBeenCalledWith({ cancelRefetch: false });
  });
});
