// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import type { ShareBetaListItem } from '../../src/lib/share-beta-list';

type MutationCallbacks = {
  onSuccess: () => void;
  onError: (error: unknown) => void;
};

const router = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());
const notificationAsync = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fetchNextPage = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());
const hookCalls = vi.hoisted(() => ({
  feedInputs: [] as unknown[],
  captionInputs: [] as Array<string | null | undefined>,
}));
const flashListState = vi.hoisted(() => ({ props: null as null | { onEndReached?: () => void } }));

const state = vi.hoisted(() => ({
  link: 'https://instagram.com/reel/abc',
  authenticated: true,
  profileId: 'user-1' as string | undefined,
  caption: 'Purple People Eater on the garage wall' as string | null,
  thumbnail: null as string | null,
  previewLoading: false,
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
        'mobile.betaVideos.shareTargetTitle': 'Attach your beta',
        'mobile.betaVideos.shareTargetPrompt': 'Tap the climb',
        'mobile.betaVideos.shareSearchPlaceholder': 'Search your logged climbs',
        'mobile.betaVideos.shareNoAscents': 'No ascents',
        'mobile.betaVideos.shareNoResults': 'No matches',
        'mobile.betaVideos.shareSignIn': 'Sign in to attach',
        'mobile.betaVideos.shareSignInButton': 'Sign in',
        'mobile.betaVideos.shareClose': 'Close',
        'mobile.betaVideos.shareReadingCaption': 'Reading caption',
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
    onEndReached?: () => void;
    ListFooterComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) => {
    flashListState.props = props;
    return createElement(
      'div',
      { 'data-testid': 'flash-list' },
      props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item) =>
            createElement(
              'div',
              {
                key: props.keyExtractor(item),
                'data-item-type': props.getItemType(item),
              },
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
  useUserAscentsFeed: (_userId: string | undefined, input: unknown) => {
    hookCalls.feedInputs.push(input);
    return {
      data: { pages: [{ userAscentsFeed: { items: state.ascents, hasMore: state.hasNextPage } }] },
      isPending: state.feedPending,
      hasNextPage: state.hasNextPage,
      isFetchingNextPage: state.fetchingNextPage,
      fetchNextPage,
    };
  },
  useAscentCaptionMatches: (_userId: string | undefined, caption: string | null | undefined) => {
    hookCalls.captionInputs.push(caption);
    return { data: state.suggestions };
  },
  useAttachBetaLink: () => ({ isPending: state.attachPending, mutate }),
  useBetaLinkPreview: () => ({
    data: { caption: state.caption, thumbnail: state.thumbnail },
    isLoading: state.previewLoading,
  }),
}));

vi.mock('../../src/lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: (error: unknown) => (error instanceof Error ? error.message : null),
}));

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

vi.mock('../../src/components/share-beta/ShareBetaAscentRow', () => ({
  ShareBetaAscentRow: ({
    ascent,
    onActivate,
  }: {
    ascent: AscentFeedItem;
    onActivate: (ascent: AscentFeedItem) => void;
  }) =>
    createElement(
      'button',
      { type: 'button', 'aria-label': `attach-${ascent.uuid}`, onClick: () => onActivate(ascent) },
      ascent.climbName,
    ),
}));

import ShareBetaScreen from '../share-beta';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  state.link = 'https://instagram.com/reel/abc';
  state.authenticated = true;
  state.profileId = 'user-1';
  state.caption = 'Purple People Eater on the garage wall';
  state.thumbnail = null;
  state.previewLoading = false;
  state.ascents = [];
  state.suggestions = [];
  state.feedPending = false;
  state.hasNextPage = false;
  state.fetchingNextPage = false;
  state.attachPending = false;
  hookCalls.feedInputs = [];
  hookCalls.captionInputs = [];
  flashListState.props = null;
  fetchNextPage.mockResolvedValue({});
});

describe('ShareBetaScreen', () => {
  it('renders caption suggestions and non-duplicate recent ascents through one FlashList', () => {
    state.suggestions = [makeAscent('suggested', 'shared-climb')];
    state.ascents = [makeAscent('duplicate-recent', 'shared-climb'), makeAscent('other', 'other-climb')];

    const { getByText, getByRole, queryByRole, container } = render(<ShareBetaScreen />);

    expect(getByText('Matched from the caption')).toBeTruthy();
    expect(getByText('Your other ascents')).toBeTruthy();
    expect(getByRole('button', { name: 'attach-suggested' })).toBeTruthy();
    expect(getByRole('button', { name: 'attach-other' })).toBeTruthy();
    expect(queryByRole('button', { name: 'attach-duplicate-recent' })).toBeNull();
    expect(container.querySelectorAll('[data-testid="flash-list"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-item-type="section"]')).toHaveLength(2);
  });

  it('suppresses caption suggestions immediately while the feed query stays debounced', async () => {
    vi.useFakeTimers();
    state.suggestions = [makeAscent('suggested')];
    state.ascents = [makeAscent('recent')];
    const { getByPlaceholderText, queryByRole } = render(<ShareBetaScreen />);
    expect(queryByRole('button', { name: 'attach-suggested' })).toBeTruthy();

    fireEvent.change(getByPlaceholderText('Search your logged climbs'), { target: { value: 'purple' } });

    expect(queryByRole('button', { name: 'attach-suggested' })).toBeNull();
    expect(hookCalls.captionInputs.at(-1)).toBeNull();
    expect(hookCalls.feedInputs.at(-1)).toEqual({ statusMode: 'both' });

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(hookCalls.feedInputs.at(-1)).toEqual({ statusMode: 'both', climbName: 'purple' });
  });

  it('allows at most one pagination request until the current request settles', async () => {
    state.ascents = [makeAscent('recent')];
    state.hasNextPage = true;
    let resolvePage: (() => void) | undefined;
    fetchNextPage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePage = resolve;
      }),
    );
    render(<ShareBetaScreen />);
    const onEndReached = flashListState.props?.onEndReached;
    expect(onEndReached).toBeTruthy();

    act(() => {
      onEndReached?.();
      onEndReached?.();
    });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePage?.();
      await Promise.resolve();
    });
    act(() => onEndReached?.());
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  it('attaches the exact tick once and reports success after a rapid double tap', () => {
    const ascent = makeAscent('tick-1');
    state.ascents = [ascent];
    const { getByRole } = render(<ShareBetaScreen />);
    const row = getByRole('button', { name: 'attach-tick-1' });

    fireEvent.click(row);
    fireEvent.click(row);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      {
        boardType: 'kilter',
        climbUuid: 'climb-tick-1',
        link: 'https://instagram.com/reel/abc',
        angle: 40,
        tickUuid: 'tick-1',
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );

    const callbacks = mutate.mock.calls[0]![1] as MutationCallbacks;
    act(() => callbacks.onSuccess());
    expect(notificationAsync).toHaveBeenCalledWith('success');
    expect(showToast).toHaveBeenCalledWith('Beta attached', 'success');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('shows the backend error inline and releases the attachment latch for retry', () => {
    state.ascents = [makeAscent('tick-1')];
    const { getByRole, getByText } = render(<ShareBetaScreen />);
    const row = getByRole('button', { name: 'attach-tick-1' });
    fireEvent.click(row);

    const callbacks = mutate.mock.calls[0]![1] as MutationCallbacks;
    act(() => callbacks.onError(new Error('Post is unavailable')));

    expect(getByText('Post is unavailable')).toBeTruthy();
    expect(notificationAsync).toHaveBeenCalledWith('error');
    fireEvent.click(row);
    expect(mutate).toHaveBeenCalledTimes(2);
  });
});
