// @vitest-environment jsdom
//
// Climber search is a push over the tabs. HIG Navigation bars: it takes the
// native header and its system back button (long-press history, edge swipe)
// rather than hiding the header behind an in-body Cancel.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const screenOptions = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

function idleSearch() {
  return {
    data: undefined,
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
}

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('@shopify/flash-list', () => ({ FlashList: () => createElement('div', { 'data-list': 'true' }) }));
vi.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options: Record<string, unknown> }) => {
      screenOptions.current = options;
      return null;
    },
  },
  useFocusEffect: () => undefined,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'me-123' } }),
  useSearchUsers: () => idleSearch(),
  useToggleUserFollow: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock('../../../src/hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isOffline: false, isBlocked: false, reason: null }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff' }, brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 2: 8, 4: 16, 5: 20 } }));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/OfflineState', () => ({ OfflineState: () => null }));
vi.mock('../../../src/components/SearchField', () => ({
  SearchField: ({ placeholder }: { placeholder: string }) => createElement('input', { placeholder }),
}));
vi.mock('../../../src/components/you/ClimberSearch', () => ({
  ClimberSearchEmptyState: () => null,
  ClimberSearchErrorState: () => null,
  ClimberSearchLoadingState: () => null,
  ClimberSearchPersonRow: () => null,
  mapSearchResults: () => [],
  useDebouncedClimberSearch: (query: string) => ({
    trimmedSearchQuery: query.trim(),
    debouncedSearchQuery: query.trim(),
    searchIsDebouncing: false,
    canUseSearchQuery: false,
  }),
}));

import ClimberSearchScreen from '../search';

describe('ClimberSearchScreen header', () => {
  it('shows the native header, titled, so the system back button is there', () => {
    render(<ClimberSearchScreen />);

    expect(screenOptions.current).toMatchObject({
      headerShown: true,
      headerTransparent: false,
      title: 'mobile.social.searchTitle',
    });
  });

  it('keeps the search field and drops the in-body Cancel', () => {
    const { getByPlaceholderText, queryByText } = render(<ClimberSearchScreen />);

    expect(getByPlaceholderText('mobile.social.searchPlaceholder')).not.toBeNull();
    expect(queryByText('actions.cancel')).toBeNull();
  });
});
