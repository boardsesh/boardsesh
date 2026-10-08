// @vitest-environment jsdom
vi.mock('../../../../src/components/AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../../src/hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../../../src/components/PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type PlaylistItem = { uuid: string; name: string; climbCount: number; color?: string; icon?: string };

// Mutable return value for useUserPlaylists — each test sets the slice it needs.
const hook = vi.hoisted(() => ({
  playlists: [] as PlaylistItem[],
  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  totalCount: 0,
  hasError: false,
  hasLoadMoreError: false,
  loadMore: vi.fn(),
  retryLoadMore: vi.fn(),
  refetch: vi.fn(),
}));

// Capture the focus callback so a test can replay focus events and assert the
// skip-first-focus refetch guard (the real useFocusEffect runs it on focus).
const focusEffect = vi.hoisted(() => ({ cb: null as null | (() => void) }));

vi.mock('@boardsesh/playlists-react', () => ({ useUserPlaylists: () => hook }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
  useFocusEffect: (cb: () => void) => {
    focusEffect.cb = cb;
  },
}));

// react-native primitives → DOM. FlatList renders its data (or the empty
// component) plus the footer so the error/retry affordances are assertable.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    accessibilityLabel?: string;
    placeholder?: string;
  }) =>
    createElement('input', {
      value: value ?? '',
      placeholder,
      'aria-label': accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  RefreshControl: ({ refreshing, onRefresh }: { refreshing?: boolean; onRefresh?: () => void }) =>
    createElement('button', { 'data-refresh-control': String(!!refreshing), onClick: onRefresh }, 'pull-to-refresh'),
  FlatList: ({
    data,
    renderItem,
    ListEmptyComponent,
    ListFooterComponent,
    refreshControl,
  }: {
    data?: PlaylistItem[];
    renderItem: (info: { item: PlaylistItem; index: number }) => ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    refreshControl?: ReactNode;
  }) =>
    createElement(
      'div',
      { 'data-list': 'true' },
      refreshControl,
      data && data.length > 0
        ? data.map((item, index) => createElement('div', { key: item.uuid }, renderItem({ item, index })))
        : ListEmptyComponent,
      ListFooterComponent,
    ),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    absoluteFill: {},
  },
  Platform: { OS: 'ios' },
}));

vi.mock('../../../../src/theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 10: 40, 16: 64 },
}));
vi.mock('../../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#8E8E93', systemGray4: '#C7C7CC' },
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { background: '#fff', fill: '#eee', label: '#000', secondaryLabel: '#666', separator: '#ddd' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock('../../../../src/lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: 'token' }) }));
vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1 } }),
}));
vi.mock('../../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../../../src/components/playlist', () => ({
  PlaylistListRow: ({ name }: { name: string }) => createElement('div', { 'data-playlist-row': name }),
  PlaylistListRowSeparator: () => createElement('div', { 'data-playlist-separator': 'true' }),
}));

import AllPlaylistsScreen from '../all';

beforeEach(() => {
  hook.playlists = [];
  hook.isLoading = false;
  hook.isLoadingMore = false;
  hook.hasMore = false;
  hook.hasError = false;
  hook.hasLoadMoreError = false;
  hook.loadMore.mockClear();
  hook.retryLoadMore.mockClear();
  hook.refetch.mockClear();
  focusEffect.cb = null;
});

describe('AllPlaylistsScreen', () => {
  it('shows an error state with a working retry when the initial load fails', () => {
    hook.hasError = true;
    const { getByText, getByLabelText } = render(<AllPlaylistsScreen />);

    expect(getByText('library.errors.loadTitle')).toBeTruthy();
    fireEvent.click(getByLabelText('library.errors.tryAgain'));
    expect(hook.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the loading spinner (not the error state) while a retry is in flight', () => {
    hook.hasError = true;
    hook.isLoading = true;
    const { queryByText, container } = render(<AllPlaylistsScreen />);

    expect(queryByText('library.errors.loadTitle')).toBeNull();
    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
  });

  it('flags an incomplete list and retries background pagination from the footer', () => {
    hook.playlists = [{ uuid: 'a', name: 'Alpha', climbCount: 1 }];
    hook.hasLoadMoreError = true;
    const { getByText, getByLabelText } = render(<AllPlaylistsScreen />);

    expect(getByText('library.allPlaylists.loadMoreError')).toBeTruthy();
    // The retry button's a11y label carries the error context, not just "Try Again".
    const retryButton = getByLabelText('library.allPlaylists.loadMoreError library.errors.tryAgain');
    fireEvent.click(retryButton);
    expect(hook.retryLoadMore).toHaveBeenCalledTimes(1);
  });

  it('skips the first focus but refetches on a return focus (e.g. after a detail edit)', () => {
    hook.playlists = [{ uuid: 'a', name: 'Alpha', climbCount: 1 }];
    render(<AllPlaylistsScreen />);

    // The component registered a focus callback; the mount load already ran, so
    // the first focus must NOT refetch.
    expect(focusEffect.cb).toBeTypeOf('function');
    focusEffect.cb?.();
    expect(hook.refetch).not.toHaveBeenCalled();

    // A later focus (returning from a pushed detail screen) refetches so an edit
    // there lands here.
    focusEffect.cb?.();
    expect(hook.refetch).toHaveBeenCalledTimes(1);
  });
});

// HIG Refresh content controls.
describe('AllPlaylistsScreen pull to refresh', () => {
  it('refetches on a pull and spins until the reload finishes', async () => {
    hook.playlists = [{ uuid: 'p-1', name: 'Projects', climbCount: 3 }];
    // Like the real hook: a refetch flips `isLoading` at once.
    hook.refetch.mockImplementationOnce(() => {
      hook.isLoading = true;
    });
    const { container, rerender } = render(<AllPlaylistsScreen />);
    const spinnerOn = () => container.querySelector('[data-refresh-control]')?.getAttribute('data-refresh-control');

    await act(async () => {
      fireEvent.click(container.querySelector('[data-refresh-control]') as HTMLElement);
    });
    expect(hook.refetch).toHaveBeenCalledTimes(1);
    expect(spinnerOn()).toBe('true');

    hook.isLoading = false;
    rerender(<AllPlaylistsScreen />);
    expect(spinnerOn()).toBe('false');
  });
});
