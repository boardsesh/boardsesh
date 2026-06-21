// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type PlaylistItem = {
  uuid: string;
  name: string;
  climbCount: number;
  creatorId?: string;
  creatorName?: string;
  color?: string;
  icon?: string;
  isPinnedByMe?: boolean;
};

type SmartCountItem = {
  type: string;
  count: number;
};

type DiscoverOptions = {
  generatedRecommendation?: boolean;
  boardType?: string;
  layoutId?: number;
  sizeId?: number;
  angle?: number;
};

// Mutable hook return values — each test sets the slice it needs. The two
// section hooks both expose `hasError`; the hub must read them.
const userHook = vi.hoisted(() => ({
  playlists: [] as PlaylistItem[],
  isLoading: false,
  isLoadingMore: false,
  hasError: false,
  loadMore: vi.fn(),
  refetch: vi.fn(),
}));
const exactForYouHook = vi.hoisted(() => ({
  popular: [] as PlaylistItem[],
  recent: [] as PlaylistItem[],
  isLoading: false,
  isLoadingMore: false,
  hasError: false,
  loadMore: vi.fn(),
  refetch: vi.fn(),
}));
const smartCountsHook = vi.hoisted(() => ({
  data: undefined as SmartCountItem[] | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const communityHook = vi.hoisted(() => ({
  popular: [] as PlaylistItem[],
  recent: [] as PlaylistItem[],
  isLoading: false,
  isLoadingMore: false,
  hasError: false,
  loadMore: vi.fn(),
  refetch: vi.fn(),
}));
const pinnedHook = vi.hoisted(() => ({
  pinned: [] as PlaylistItem[],
  refetch: vi.fn(),
}));
const createPlaylist = vi.hoisted(() => vi.fn());
const pinPlaylist = vi.hoisted(() => vi.fn());
const unpinPlaylist = vi.hoisted(() => vi.fn());
const discoverOptions = vi.hoisted(() => [] as DiscoverOptions[]);
const asyncStorage = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  getItem: vi.fn(async (key: string) => asyncStorage.storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    asyncStorage.storage.set(key, value);
  }),
}));

vi.mock('@boardsesh/playlists-react', () => ({
  useUserPlaylists: () => userHook,
  useDiscoverPlaylists: (options: DiscoverOptions) => {
    discoverOptions.push(options);
    return options.generatedRecommendation ? exactForYouHook : communityHook;
  },
  usePinnedPlaylists: () => pinnedHook,
  useSmartPlaylistCounts: () => smartCountsHook,
  usePlaylistMutations: () => ({ createPlaylist, pinPlaylist, unpinPlaylist }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorage.getItem,
    setItem: asyncStorage.setItem,
  },
}));

// @tanstack/react-query is NOT mocked — the create flow writes to the real
// ['userPlaylists'] cache, which the Add-to-Playlist picker reads, so the test
// asserts against the live cache. Renders are wrapped in a QueryClientProvider.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() }, useFocusEffect: () => undefined }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

// Reanimated primitives the hub touches → inert stubs. Animated.ScrollView just
// renders its children so the in-body sections (and our error block) are in DOM.
vi.mock('react-native-reanimated', () => ({
  default: {
    ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  },
  useAnimatedRef: () => ({ current: null }),
  useAnimatedScrollHandler: () => vi.fn(),
  useSharedValue: (initial: unknown) => ({ value: initial }),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios' },
}));

vi.mock('../../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 10: 40, 16: 64 },
}));
vi.mock('../../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#8E8E93', systemGray4: '#C7C7CC', separator: '#ddd' },
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock('../../../../src/providers/toast-provider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../../../../src/lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: 'token' }) }));
vi.mock('../../../../src/lib/graphql/hooks', () => ({ useProfile: () => ({ data: { id: 'me' } }) }));
vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1, sizeId: 10, angle: 40 } }),
}));
vi.mock('../../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../../src/lib/smart-playlists', () => ({
  DEFAULT_PINNED_SMART_PLAYLIST_TYPES: ['LIKED_CLIMBS', 'FIVE_STARS'],
  SMART_PLAYLISTS: [
    {
      type: 'RECOMMENDED_CROWD_FAVORITES',
      slug: 'crowd-favorites',
      icon: '🔥',
      color: '#D65A4F',
      titleI18nKey: 'library.smart.crowdFavorites.title',
    },
    {
      type: 'RECOMMENDED_HIDDEN_GEMS',
      slug: 'hidden-gems',
      icon: '💎',
      color: '#9C27B0',
      titleI18nKey: 'library.smart.hiddenGems.title',
    },
    {
      type: 'RECOMMENDED_AT_LEVEL',
      slug: 'at-your-level',
      icon: '📈',
      color: '#5FB27A',
      titleI18nKey: 'library.smart.atYourLevel.title',
    },
    {
      type: 'RECOMMENDED_FRESH',
      slug: 'fresh',
      icon: '🌱',
      color: '#FBBF24',
      titleI18nKey: 'library.smart.fresh.title',
    },
    {
      type: 'LIKED_CLIMBS',
      slug: 'liked-climbs',
      icon: '❤️',
      color: '#EC4899',
      titleI18nKey: 'library.smart.likedClimbs.title',
    },
    {
      type: 'FIVE_STARS',
      slug: 'five-stars',
      icon: '⭐',
      color: '#FBBF24',
      titleI18nKey: 'library.smart.fiveStars.title',
    },
    {
      type: 'MOST_REPEATED',
      slug: 'most-repeated',
      icon: '🔁',
      color: '#9C27B0',
      titleI18nKey: 'library.smart.mostRepeated.title',
    },
    {
      type: 'PROJECTS',
      slug: 'projects',
      icon: '🎯',
      color: '#2563EB',
      titleI18nKey: 'library.smart.projects.title',
    },
  ],
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
vi.mock('../../../../src/components/SectionHeader', () => ({
  SectionHeader: ({ title, actionLabel }: { title: string; actionLabel?: string }) =>
    createElement('h2', { 'data-section': title }, actionLabel ? `${title} ${actionLabel}` : title),
}));
// The form sheet exposes a submit button driving onSubmit with fixed form
// values, so the test can trigger the create flow without the real sheet UI.
const FORM_VALUES = { name: 'Crimps', description: '', color: undefined, icon: undefined, isPublic: false };
vi.mock('../../../../src/components/playlist', () => ({
  PlaylistCard: ({
    name,
    metaLabel,
    isPinned,
    onTogglePin,
  }: {
    name: string;
    metaLabel?: string;
    isPinned?: boolean;
    onTogglePin?: () => void;
  }) =>
    createElement(
      'div',
      { 'data-card': name, 'data-pinned': isPinned ? 'true' : 'false' },
      createElement('span', null, metaLabel ? `${name} ${metaLabel}` : name),
      onTogglePin ? createElement('button', { 'aria-label': `pin-${name}`, onClick: onTogglePin }, 'pin') : null,
    ),
  PlaylistFormSheet: ({ onSubmit }: { onSubmit: (values: typeof FORM_VALUES) => void }) =>
    createElement('button', { 'aria-label': 'submit-create', onClick: () => onSubmit(FORM_VALUES) }, 'submit'),
}));
vi.mock('../../../../src/components/HorizontalScrollSection', () => ({
  HorizontalScrollSection: ({ children, title }: { children?: ReactNode; title: string }) =>
    createElement('section', { 'data-scroll-section': title }, createElement('h2', null, title), children),
}));
// The chrome exposes the create button so the test can open + submit the flow.
vi.mock('../../../../src/components/chrome', () => ({
  DiscoverTopChrome: ({ onCreate }: { onCreate: () => void }) =>
    createElement('button', { 'aria-label': 'open-create', onClick: onCreate }, 'create'),
}));

import DiscoverLibrary from '../index';

// The hub calls useQueryClient(); give it a real client so cache writes/reads
// behave. Surface the client so the create test can read ['userPlaylists'].
function renderHub() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <DiscoverLibrary />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

beforeEach(() => {
  userHook.playlists = [];
  userHook.isLoading = false;
  userHook.hasError = false;
  userHook.refetch.mockClear();
  exactForYouHook.popular = [];
  exactForYouHook.recent = [];
  exactForYouHook.isLoading = false;
  exactForYouHook.hasError = false;
  exactForYouHook.refetch.mockClear();
  smartCountsHook.data = [
    { type: 'RECOMMENDED_CROWD_FAVORITES', count: 748 },
    { type: 'RECOMMENDED_HIDDEN_GEMS', count: 1178 },
    { type: 'RECOMMENDED_AT_LEVEL', count: 719 },
    { type: 'RECOMMENDED_FRESH', count: 5485 },
    { type: 'FIVE_STARS', count: 523 },
    { type: 'MOST_REPEATED', count: 292 },
    { type: 'PROJECTS', count: 92 },
    { type: 'LIKED_CLIMBS', count: 46 },
  ];
  smartCountsHook.isLoading = false;
  smartCountsHook.isError = false;
  smartCountsHook.refetch.mockClear();
  asyncStorage.storage.clear();
  asyncStorage.getItem.mockClear();
  asyncStorage.setItem.mockClear();
  communityHook.popular = [];
  communityHook.recent = [];
  communityHook.isLoading = false;
  communityHook.hasError = false;
  communityHook.refetch.mockClear();
  pinnedHook.pinned = [];
  pinnedHook.refetch.mockClear();
  createPlaylist.mockReset();
  pinPlaylist.mockReset();
  unpinPlaylist.mockReset();
  discoverOptions.length = 0;
});

describe('DiscoverLibrary error handling', () => {
  it('shows a load-error state with a retry (not the empty state) when a section fails and the hub is empty', () => {
    smartCountsHook.data = undefined;
    userHook.hasError = true;
    const { getByText, queryByText, getByLabelText } = renderHub();

    expect(getByText('library.errors.loadTitle')).toBeTruthy();
    // Must not fall through to the misleading "no playlists yet" empty copy.
    expect(queryByText('library.empty.title')).toBeNull();

    fireEvent.click(getByLabelText('library.errors.tryAgain'));
    expect(userHook.refetch).toHaveBeenCalledTimes(1);
  });

  it('retries only the community stream when only it failed', () => {
    smartCountsHook.data = undefined;
    communityHook.hasError = true;
    const { getByLabelText } = renderHub();

    fireEvent.click(getByLabelText('library.errors.tryAgain'));
    expect(communityHook.refetch).toHaveBeenCalledTimes(1);
    expect(exactForYouHook.refetch).not.toHaveBeenCalled();
    expect(userHook.refetch).not.toHaveBeenCalled();
  });

  it('retries only the for-you smart count stream when only it failed', () => {
    smartCountsHook.data = undefined;
    smartCountsHook.isError = true;
    const { getByLabelText } = renderHub();

    fireEvent.click(getByLabelText('library.errors.tryAgain'));
    expect(smartCountsHook.refetch).toHaveBeenCalledTimes(1);
    expect(communityHook.refetch).not.toHaveBeenCalled();
    expect(userHook.refetch).not.toHaveBeenCalled();
  });

  it('keeps showing content (no error block) when a section errored but data is present', () => {
    userHook.hasError = true;
    userHook.playlists = [{ uuid: 'a', name: 'Alpha', climbCount: 1 }];
    const { queryByText } = renderHub();

    expect(queryByText('library.errors.loadTitle')).toBeNull();
  });

  it('renders for-you smart cards and community playlists', () => {
    communityHook.popular = [
      { uuid: 'community', name: 'Setter picks', climbCount: 7, creatorId: 'creator-2', creatorName: 'Jess' },
    ];

    const { getByText } = renderHub();

    expect(getByText('library.smart.crowdFavorites.title')).toBeTruthy();
    expect(getByText('library.smart.hiddenGems.title')).toBeTruthy();
    expect(getByText('library.smart.atYourLevel.title')).toBeTruthy();
    expect(getByText('library.smart.fresh.title')).toBeTruthy();
    expect(getByText('library.smart.fiveStars.title')).toBeTruthy();
    expect(getByText('library.smart.mostRepeated.title')).toBeTruthy();
    expect(getByText('library.smart.projects.title')).toBeTruthy();
    expect(getByText('library.smart.likedClimbs.title')).toBeTruthy();
    expect(getByText('Setter picks library.communityByline')).toBeTruthy();
  });

  it('orders for-you smart cards in the mobile product order', () => {
    const { container } = renderHub();
    const forYouSection = container.querySelector('[data-scroll-section="library.sections.forYou"]');
    const sectionText = forYouSection?.textContent ?? '';
    const expectedTitles = [
      'library.smart.likedClimbs.title',
      'library.smart.fiveStars.title',
      'library.smart.projects.title',
      'library.smart.mostRepeated.title',
      'library.smart.crowdFavorites.title',
      'library.smart.hiddenGems.title',
      'library.smart.atYourLevel.title',
      'library.smart.fresh.title',
    ];

    let previousIndex = -1;
    for (const title of expectedTitles) {
      const currentIndex = sectionText.indexOf(title);
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
  });

  it('does not request generated discover playlists for the for-you shelf', () => {
    renderHub();

    expect(discoverOptions).not.toContainEqual(expect.objectContaining({ generatedRecommendation: true }));
  });

  it('renders pinned grid, owned playlists, for-you smart cards, and community in order', () => {
    pinnedHook.pinned = [{ uuid: 'pinned', name: 'Pinned list', climbCount: 2, isPinnedByMe: true }];
    userHook.playlists = [
      { uuid: 'pinned', name: 'Pinned list', climbCount: 2, isPinnedByMe: true },
      { uuid: 'owned', name: 'Project drawer', climbCount: 5, isPinnedByMe: false },
    ];
    communityHook.popular = [
      { uuid: 'community', name: 'Setter picks', climbCount: 7, creatorId: 'creator-2', creatorName: 'Jess' },
    ];

    const { container, getByText } = renderHub();
    const bodyText = container.textContent ?? '';
    const pinnedIndex = bodyText.indexOf('library.sections.pinned');
    const pinnedItemIndex = bodyText.indexOf('Pinned list');
    const userPlaylistsIndex = bodyText.indexOf('library.allPlaylists.title');
    const forYouIndex = bodyText.indexOf('library.sections.forYou');
    const communityIndex = bodyText.indexOf('library.sections.community');

    expect(getByText('Pinned list')).toBeTruthy();
    expect(getByText('Project drawer')).toBeTruthy();
    expect(pinnedIndex).toBeGreaterThanOrEqual(0);
    expect(pinnedItemIndex).toBeGreaterThan(pinnedIndex);
    expect(pinnedItemIndex).toBeLessThan(userPlaylistsIndex);
    expect(userPlaylistsIndex).toBeLessThan(forYouIndex);
    expect(forYouIndex).toBeLessThan(communityIndex);
  });

  it('renders for-you smart cards when generated discover playlists are empty', () => {
    userHook.playlists = [{ uuid: 'owned', name: 'Project drawer', climbCount: 5, isPinnedByMe: false }];
    communityHook.popular = [
      { uuid: 'community', name: 'Setter picks', climbCount: 7, creatorId: 'creator-2', creatorName: 'Jess' },
    ];

    const { getByText } = renderHub();

    expect(getByText('library.sections.forYou')).toBeTruthy();
    expect(getByText('library.smart.crowdFavorites.title')).toBeTruthy();
  });

  it('does not show see all in the pinned header', () => {
    pinnedHook.pinned = [{ uuid: 'pinned', name: 'Pinned list', climbCount: 2, isPinnedByMe: true }];
    userHook.playlists = [
      { uuid: 'pinned', name: 'Pinned list', climbCount: 2, isPinnedByMe: true },
      { uuid: 'owned', name: 'Project drawer', climbCount: 5, isPinnedByMe: false },
    ];

    const { container } = renderHub();
    const pinnedHeader = container.querySelector('[data-section="library.sections.pinned"]');

    expect(pinnedHeader?.textContent).toBe('library.sections.pinned');
  });

  it('shows pin controls on community playlist cards', async () => {
    communityHook.popular = [
      { uuid: 'community', name: 'Setter picks', climbCount: 7, creatorId: 'creator-2', creatorName: 'Jess' },
    ];
    pinPlaylist.mockResolvedValue(true);

    const { getByLabelText } = renderHub();

    await act(async () => {
      fireEvent.click(getByLabelText('pin-Setter picks'));
    });

    expect(pinPlaylist).toHaveBeenCalledWith('community');
    expect(pinnedHook.refetch).toHaveBeenCalledTimes(1);
  });

  it('pins for-you smart cards into the pinned grid without calling playlist pin mutations', async () => {
    const { container, findByLabelText } = renderHub();

    fireEvent.click(await findByLabelText('pin-library.smart.likedClimbs.title'));

    const bodyText = container.textContent ?? '';
    const pinnedIndex = bodyText.indexOf('library.sections.pinned');
    const pinnedSmartIndex = bodyText.indexOf('library.smart.likedClimbs.title');
    const pinnedSmartLastIndex = bodyText.lastIndexOf('library.smart.likedClimbs.title');
    const forYouIndex = bodyText.indexOf('library.sections.forYou');
    const forYouSection = container.querySelector('[data-scroll-section="library.sections.forYou"]');

    expect(pinnedIndex).toBeGreaterThanOrEqual(0);
    expect(pinnedSmartIndex).toBeGreaterThan(pinnedIndex);
    expect(pinnedSmartIndex).toBeLessThan(forYouIndex);
    expect(pinnedSmartLastIndex).toBe(pinnedSmartIndex);
    expect(forYouSection?.textContent).not.toContain('library.smart.likedClimbs.title');
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      'boardsesh_pinned_smart_playlists_v1_me',
      JSON.stringify(['LIKED_CLIMBS']),
    );
    expect(pinPlaylist).not.toHaveBeenCalled();
    expect(unpinPlaylist).not.toHaveBeenCalled();
  });

  it('shows a retry when smart counts fail even with stored smart pins', async () => {
    smartCountsHook.data = undefined;
    smartCountsHook.isError = true;
    asyncStorage.storage.set('boardsesh_pinned_smart_playlists_v1_me', JSON.stringify(['LIKED_CLIMBS']));

    const { findByText, queryByText } = renderHub();

    expect(await findByText('library.errors.loadTitle')).toBeTruthy();
    expect(queryByText('library.sections.pinned')).toBeNull();
  });

  it('reserves pinned-grid slots for regular playlist pins when many smart playlists are pinned', async () => {
    pinnedHook.pinned = Array.from({ length: 8 }, (_, index) => ({
      uuid: `pinned-${index}`,
      name: `Pinned ${index + 1}`,
      climbCount: index,
      isPinnedByMe: true,
    }));
    asyncStorage.storage.set(
      'boardsesh_pinned_smart_playlists_v1_me',
      JSON.stringify([
        'LIKED_CLIMBS',
        'FIVE_STARS',
        'PROJECTS',
        'MOST_REPEATED',
        'RECOMMENDED_CROWD_FAVORITES',
        'RECOMMENDED_HIDDEN_GEMS',
        'RECOMMENDED_AT_LEVEL',
        'RECOMMENDED_FRESH',
      ]),
    );

    const { getByText, queryByText } = renderHub();

    await waitFor(() => expect(getByText('library.smart.mostRepeated.title')).toBeTruthy());
    expect(getByText('Pinned 1')).toBeTruthy();
    expect(getByText('Pinned 4')).toBeTruthy();
    expect(queryByText('Pinned 5')).toBeNull();
  });

  it('caps the pinned grid at eight playlists', () => {
    pinnedHook.pinned = Array.from({ length: 9 }, (_, index) => ({
      uuid: `pinned-${index}`,
      name: `Pinned ${index + 1}`,
      climbCount: index,
      isPinnedByMe: true,
    }));

    const { getByText, queryByText } = renderHub();

    expect(getByText('Pinned 1')).toBeTruthy();
    expect(getByText('Pinned 8')).toBeTruthy();
    expect(queryByText('Pinned 9')).toBeNull();
  });
});

describe('DiscoverLibrary create flow', () => {
  it('prepends a created playlist to the ["userPlaylists"] cache the picker reads', async () => {
    const created = {
      id: '99',
      uuid: 'p-new',
      name: 'Crimps',
      climbCount: 0,
      boardType: 'kilter',
      layoutId: 1,
      isPublic: false,
      followerCount: 0,
      isFollowedByMe: false,
      isPinnedByMe: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    createPlaylist.mockResolvedValue(created);

    const { getByLabelText, queryClient } = renderHub();
    // Seed the picker's cache so the prepend is observable against existing data.
    queryClient.setQueryData(['userPlaylists'], [{ ...created, uuid: 'p-old', name: 'Slopers' }]);

    fireEvent.click(getByLabelText('open-create'));
    await act(async () => {
      fireEvent.click(getByLabelText('submit-create'));
    });

    const cached = queryClient.getQueryData<Array<{ uuid: string }>>(['userPlaylists']);
    expect(cached?.map((playlist) => playlist.uuid)).toEqual(['p-new', 'p-old']);
  });
});
