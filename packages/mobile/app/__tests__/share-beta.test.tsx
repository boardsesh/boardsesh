// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import type { ShareBetaAscentSource, ShareBetaListItem } from '../../src/lib/share-beta-list';

type MutationCallbacks = {
  onSuccess: () => void;
  onError: (error: unknown) => void;
};

const router = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());
const notificationAsync = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fetchNextPage = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());
const flashListState = vi.hoisted(() => ({
  props: null as null | { data: unknown[]; getItemType: (item: never) => string },
}));

const state = vi.hoisted(() => ({
  link: 'https://instagram.com/reel/abc',
  authenticated: true,
  profileId: 'user-1' as string | undefined,
  caption: 'Purple People Eater on the garage wall' as string | null,
  ascents: [] as AscentFeedItem[],
  suggestions: [] as AscentFeedItem[],
  feedPending: false,
  hasNextPage: false,
  fetchingNextPage: false,
  attachPending: false,
}));

function makeAscent(uuid: string, climbUuid = `climb-${uuid}`): AscentFeedItem {
  return {
    uuid,
    climbUuid,
    climbName: `Climb ${uuid}`,
    setterUsername: null,
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: null,
    layoutId: 8,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    difficulty: 20,
    difficultyName: 'V4',
    consensusDifficulty: 20,
    consensusDifficultyName: 'V4',
    boardseshDifficulty: null,
    boardseshConfidence: null,
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: '',
    climbedAt: '2026-07-31T12:00:00.000Z',
    frames: 'p1r1',
  };
}

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
  }) =>
    createElement('input', {
      value,
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ link: state.link }),
  useRouter: () => router,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'mobile.betaVideos.attachSuccess': 'Beta attached',
        'mobile.betaVideos.attachError': 'Could not attach',
        'mobile.betaVideos.shareNoAscents': 'No ascents',
        'mobile.betaVideos.shareNoResults': 'No matches',
        'mobile.betaVideos.shareSuggestedTitle': 'Matched from the caption',
        'mobile.betaVideos.shareOtherAscents': 'Your other ascents',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 10 }) }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data: ShareBetaListItem[];
    renderItem: (input: { item: ShareBetaListItem }) => ReactNode;
    keyExtractor: (item: ShareBetaListItem) => string;
    getItemType: (item: ShareBetaListItem) => string;
    ListFooterComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) => {
    flashListState.props = props as unknown as typeof flashListState.props;
    return createElement(
      'div',
      { 'data-testid': 'flash-list' },
      props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item) =>
            createElement(
              'div',
              { key: props.keyExtractor(item), 'data-item-type': props.getItemType(item) },
              props.renderItem({ item }),
            ),
          ),
      props.ListFooterComponent,
    );
  },
}));

vi.mock('expo-image', () => ({ Image: () => createElement('div', { 'data-testid': 'image' }) }));

vi.mock('expo-haptics', () => ({
  notificationAsync,
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#eee',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      separator: '#ccc',
    },
    brandColors: { primary: '#6D28D9', error: '#c00' },
  }),
}));

vi.mock('../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.authenticated }),
}));

vi.mock('../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

vi.mock('../../src/lib/graphql/hooks', () => ({
  useProfile: () => ({ data: state.profileId ? { id: state.profileId } : undefined }),
  useUserAscentsFeed: () => ({
    data: { pages: [{ userAscentsFeed: { items: state.ascents, hasMore: state.hasNextPage } }] },
    isPending: state.feedPending,
    hasNextPage: state.hasNextPage,
    isFetchingNextPage: state.fetchingNextPage,
    fetchNextPage,
  }),
  useAscentCaptionMatches: () => ({ data: state.suggestions }),
  useAttachBetaLink: () => ({ isPending: state.attachPending, mutate }),
  useBetaLinkPreview: () => ({ data: { caption: state.caption, thumbnail: null }, isLoading: false }),
}));

vi.mock('../../src/lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: (error: unknown) => (error instanceof Error ? error.message : null),
}));

vi.mock('../../src/lib/analytics', () => ({ track }));

vi.mock('../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 },
  borderRadius: { sm: 4, md: 8 },
}));

vi.mock('../../src/theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888' } }));

vi.mock('../../src/components/Text', () => ({
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children),
}));

vi.mock('../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));

vi.mock('../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

vi.mock('../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));

// Stand-in for the real row — this file is about the list, not the art.
vi.mock('../../src/components/share-beta/ShareBetaAscentRow', () => ({
  ShareBetaAscentRow: ({
    ascent,
    source,
    onActivate,
  }: {
    ascent: AscentFeedItem;
    source: ShareBetaAscentSource;
    onActivate: (ascent: AscentFeedItem, source: ShareBetaAscentSource) => void;
  }) =>
    createElement(
      'button',
      { type: 'button', 'aria-label': `attach-${ascent.uuid}`, onClick: () => onActivate(ascent, source) },
      ascent.climbName,
    ),
}));

import ShareBetaScreen from '../share-beta';

beforeEach(() => {
  vi.clearAllMocks();
  state.link = 'https://instagram.com/reel/abc';
  state.authenticated = true;
  state.profileId = 'user-1';
  state.caption = 'Purple People Eater on the garage wall';
  state.ascents = [];
  state.suggestions = [];
  state.feedPending = false;
  state.hasNextPage = false;
  state.fetchingNextPage = false;
  state.attachPending = false;
  flashListState.props = null;
  fetchNextPage.mockResolvedValue({});
});

describe('ShareBetaScreen — one virtualized list', () => {
  it('puts the caption suggestions inside the FlashList data, not a header block', () => {
    state.suggestions = [makeAscent('suggested', 'shared-climb')];
    state.ascents = [makeAscent('other', 'other-climb')];

    const { getByText, getByRole, container } = render(<ShareBetaScreen />);

    expect(getByText('Matched from the caption')).toBeTruthy();
    expect(getByText('Your other ascents')).toBeTruthy();
    expect(getByRole('button', { name: 'attach-suggested' })).toBeTruthy();
    expect(getByRole('button', { name: 'attach-other' })).toBeTruthy();
    // Every row (headers included) came out of `data`, so nothing is mounted
    // outside the recycler.
    expect(flashListState.props?.data).toHaveLength(4);
    expect(container.querySelectorAll('[data-item-type="section"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="flash-list"]')).toHaveLength(1);
  });

  it('does not list a suggested climb twice', () => {
    state.suggestions = [makeAscent('suggested', 'shared-climb')];
    state.ascents = [makeAscent('duplicate-recent', 'shared-climb'), makeAscent('other', 'other-climb')];

    const { getByRole, queryByRole } = render(<ShareBetaScreen />);

    expect(getByRole('button', { name: 'attach-suggested' })).toBeTruthy();
    expect(getByRole('button', { name: 'attach-other' })).toBeTruthy();
    expect(queryByRole('button', { name: 'attach-duplicate-recent' })).toBeNull();
  });

  it('shows the empty state when there is nothing to pick', () => {
    const { getByText } = render(<ShareBetaScreen />);

    expect(getByText('No ascents')).toBeTruthy();
  });
});

describe('ShareBetaScreen — attaching', () => {
  it('attaches the tapped ascent', () => {
    state.ascents = [makeAscent('tick-1')];

    const { getByRole } = render(<ShareBetaScreen />);
    fireEvent.click(getByRole('button', { name: 'attach-tick-1' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      boardType: 'kilter',
      climbUuid: 'climb-tick-1',
      link: 'https://instagram.com/reel/abc',
      angle: 40,
      tickUuid: 'tick-1',
    });
  });

  it('reports the attach with the section it came from', () => {
    state.suggestions = [makeAscent('suggested', 'shared-climb')];
    state.ascents = [makeAscent('other', 'other-climb')];

    const { getByRole } = render(<ShareBetaScreen />);
    fireEvent.click(getByRole('button', { name: 'attach-suggested' }));
    const callbacks = mutate.mock.calls[0][1] as MutationCallbacks;
    callbacks.onSuccess();

    expect(track).toHaveBeenCalledWith('Beta Attached', {
      source: 'suggested',
      boardType: 'kilter',
      viaSearch: false,
      hasCaption: true,
    });
    expect(showToast).toHaveBeenCalledWith('Beta attached', 'success');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('reports a browsed attach separately, and notes when there was no caption', () => {
    state.caption = null;
    state.ascents = [makeAscent('tick-1')];

    const { getByRole } = render(<ShareBetaScreen />);
    fireEvent.click(getByRole('button', { name: 'attach-tick-1' }));
    (mutate.mock.calls[0][1] as MutationCallbacks).onSuccess();

    expect(track).toHaveBeenCalledWith('Beta Attached', {
      source: 'other',
      boardType: 'kilter',
      viaSearch: false,
      hasCaption: false,
    });
  });

  it('does not report an attach that failed', () => {
    state.ascents = [makeAscent('tick-1')];

    const { getByRole, getByText } = render(<ShareBetaScreen />);
    fireEvent.click(getByRole('button', { name: 'attach-tick-1' }));
    act(() => {
      (mutate.mock.calls[0][1] as MutationCallbacks).onError(new Error('Already attached to Purple People Eater'));
    });

    expect(track).not.toHaveBeenCalled();
    expect(getByText('Already attached to Purple People Eater')).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
  });
});
