// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';

const social = vi.hoisted(() => ({
  mutate: vi.fn(),
  latestSearchQuery: '',
}));

const follower = {
  id: 'follower-1',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
  followerCount: 1,
  followingCount: 2,
  isFollowedByMe: true,
};

const following = {
  id: 'following-1',
  displayName: 'Grace Hopper',
  avatarUrl: null,
  followerCount: 3,
  followingCount: 4,
  isFollowedByMe: true,
};

const searchResult = {
  user: {
    id: 'friend-1',
    displayName: 'Marco',
    avatarUrl: null,
    followerCount: 5,
    followingCount: 6,
    isFollowedByMe: false,
  },
  recentAscentCount: 7,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const count = Number(options?.count ?? 0);
      const translations: Record<string, string> = {
        'metadata.dashboard.title': 'You',
        'mobile.unknownName': 'Climber',
        'mobile.social.title': 'Social',
        'mobile.social.followers': 'Followers',
        'mobile.social.following': 'Following',
        'mobile.social.findFriends': 'Find friends',
        'mobile.social.searchPlaceholder': 'Search climbers',
        'mobile.social.clearSearch': 'Clear search',
        'mobile.social.you': 'You',
        'mobile.social.followAction': 'Follow',
        'mobile.social.followingAction': 'Following',
        'mobile.social.emptyFollowers': 'No followers yet',
        'mobile.social.emptyFollowing': 'Not following anyone yet',
        'mobile.social.searchHint': 'Type at least 2 characters to search climbers',
        'mobile.social.emptySearch': 'No climbers found',
      };
      if (key === 'mobile.social.followerCount') return `${count} follower${count === 1 ? '' : 's'}`;
      if (key === 'mobile.social.followingCount') return `${count} following`;
      if (key === 'mobile.social.recentAscents') return `${count} ascents this month`;
      return translations[key] ?? key;
    },
  }),
}));

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
    placeholder,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    placeholder?: string;
  }) =>
    createElement('input', {
      value: value ?? '',
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: forwardRef(
    (
      {
        data,
        renderItem,
        ListHeaderComponent,
        ListEmptyComponent,
        ListFooterComponent,
      }: {
        data?: unknown[];
        renderItem: (input: { item: unknown; index: number }) => ReactNode;
        ListHeaderComponent?: ReactNode;
        ListEmptyComponent?: ReactNode;
        ListFooterComponent?: ReactNode;
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => ({ scrollToTop: vi.fn() }));
      return createElement(
        'div',
        null,
        ListHeaderComponent,
        data?.length
          ? data.map((item, index) => createElement('div', { key: index }, renderItem({ item, index })))
          : ListEmptyComponent,
        ListFooterComponent,
      );
    },
  ),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      fill: '#eee',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      secondaryBackground: '#fff',
      separator: '#ddd',
    },
    brandColors: { primary: '#6D28D9' },
    variant: 'glass',
  }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32, 16: 64 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#999' } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../Avatar', () => ({ Avatar: () => createElement('div', { 'data-avatar': 'true' }) }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, subtitle, trailing }: { title: string; subtitle?: string; trailing?: ReactNode }) =>
    createElement(
      'div',
      null,
      createElement('span', null, title),
      subtitle ? createElement('span', null, subtitle) : null,
      trailing,
    ),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: Array<{ key: string; label: string }>;
    onSelect: (key: 'followers' | 'following' | 'search') => void;
  }) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement('button', { key: option.key, onClick: () => onSelect(option.key as never) }, option.label),
      ),
    ),
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  usePublicProfile: () => ({
    data: { followerCount: 1, followingCount: 1 },
    isRefetching: false,
    refetch: vi.fn(),
  }),
  useFollowers: () => ({
    data: { pages: [{ users: [follower], hasMore: false, totalCount: 1 }] },
    isPending: false,
    isRefetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  }),
  useFollowing: () => ({
    data: { pages: [{ users: [following], hasMore: false, totalCount: 1 }] },
    isPending: false,
    isRefetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  }),
  useSearchUsers: (query: string) => {
    social.latestSearchQuery = query;
    return {
      data: query.length >= 2 ? { pages: [{ results: [searchResult], hasMore: false, totalCount: 1 }] } : undefined,
      isPending: false,
      isRefetching: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    };
  },
  useToggleUserFollow: () => ({
    mutate: social.mutate,
    isPending: false,
    variables: undefined,
  }),
}));

import { SocialTab } from '../SocialTab';

describe('SocialTab', () => {
  beforeEach(() => {
    social.mutate.mockReset();
    social.latestSearchQuery = '';
  });

  it('shows follower rows by default', () => {
    const { getByText } = render(<SocialTab userId="me" />);

    expect(getByText('Ada Lovelace')).toBeTruthy();
    expect(getByText('1 follower · 2 following')).toBeTruthy();
  });

  it('searches climbers and follows a result from the Find friends segment', () => {
    const { getByText, getByPlaceholderText } = render(<SocialTab userId="me" />);

    fireEvent.click(getByText('Find friends'));
    expect(getByText('Type at least 2 characters to search climbers')).toBeTruthy();

    fireEvent.change(getByPlaceholderText('Search climbers'), { target: { value: 'ma' } });

    expect(social.latestSearchQuery).toBe('ma');
    expect(getByText('Marco')).toBeTruthy();
    expect(getByText('7 ascents this month')).toBeTruthy();

    fireEvent.click(getByText('Follow'));
    expect(social.mutate).toHaveBeenCalledWith({ userId: 'friend-1', isFollowedByMe: false });
  });
});
