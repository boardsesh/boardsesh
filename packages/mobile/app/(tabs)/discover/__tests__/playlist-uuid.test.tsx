// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Climb } from '@boardsesh/queue';

type TestRenderBoard = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type TestBoardBanner = {
  title: string;
  subtitle: string;
  cta: string;
  onPress: () => void;
};

type CapturedActivationOptions = {
  viewOnlyBoard?: TestRenderBoard | ((climb: Climb) => TestRenderBoard | null) | null;
};

// The metadata query goes through getHttpClient().request — mock it so we can
// make GET_PLAYLIST reject (the error path) or resolve (the not-found path).
const requestMock = vi.hoisted(() => vi.fn());
const playlistMocks = vi.hoisted(() => ({
  allClimbs: [] as Climb[],
  activationOptions: null as CapturedActivationOptions | null,
  renderBoardResult: {
    renderBoard: null as TestRenderBoard | null,
    banner: null as TestBoardBanner | null,
  },
}));
vi.mock('../../../../src/lib/graphql/client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// usePlaylistClimbs: the climbs infinite query. The detail screen only reads
// query.refetch (for the retry) and allClimbs here.
const climbsRefetch = vi.hoisted(() => vi.fn());
const updatePlaylistMock = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@boardsesh/playlists-react', () => ({
  usePlaylistClimbs: () => ({
    query: {
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: climbsRefetch,
    },
    allClimbs: playlistMocks.allClimbs,
  }),
  usePlaylistMutations: () => ({
    updatePlaylist: updatePlaylistMock,
    deletePlaylist: vi.fn(),
    pinPlaylist: vi.fn(),
    unpinPlaylist: vi.fn(),
    followPlaylist: vi.fn(),
    unfollowPlaylist: vi.fn(),
  }),
  usePlaylistItemMutations: () => ({
    reorderPlaylistClimb: vi.fn(),
    removeClimbFromPlaylist: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ playlist_uuid: 'p-1' }),
  useNavigation: () => ({ goBack: vi.fn() }),
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
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
}));

vi.mock('../../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray4: '#C7C7CC' },
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' }, brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../src/providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../../src/lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: (options: CapturedActivationOptions) => {
    playlistMocks.activationOptions = options;
    return {
      activate: vi.fn(),
      queueReplaceSheet: {
        visible: false,
        futureQueueCount: 0,
        isReplacing: false,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      },
    };
  },
}));
vi.mock('../../../../src/lib/playlists/use-playlist-render-board', () => ({
  usePlaylistRenderBoard: () => playlistMocks.renderBoardResult,
}));
vi.mock('../../../../src/lib/playlists/recents-store', () => ({ recordPlaylistOpen: vi.fn() }));
vi.mock('../../../../src/lib/climb-types', () => ({ toQueueClimbs: (climbs: unknown) => climbs }));
vi.mock('../../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../../../src/components/ClimbListRowSkeleton', () => ({
  ClimbListRowSkeleton: () => createElement('div', { 'data-skeleton': 'true' }),
}));
vi.mock('../../../../src/components/GlassIconButton', () => ({
  GlassIconButton: () => createElement('div', { 'data-glass-button': 'true' }),
}));
// PlaylistDetailView surfaces the hero title so we can prove the error branch
// renders *instead of* a fallback-titled hero.
vi.mock('../../../../src/components/playlist', () => ({
  PlaylistDetailView: ({ hero }: { hero: { name: string } }) =>
    createElement('div', { 'data-detail-view': 'true', 'data-hero-name': hero.name }),
  SKELETON_PLACEHOLDERS: ['a', 'b'],
  // Surface the edit submit so the cache-patch test can drive handleEditSubmit
  // without the real gorhom sheet.
  PlaylistFormSheet: ({
    submitError,
    onSubmit,
  }: {
    submitError?: string | null;
    onSubmit?: (values: unknown) => void;
  }) =>
    createElement(
      'div',
      null,
      submitError ? createElement('span', { 'data-edit-error': 'true' }, submitError) : null,
      createElement(
        'button',
        {
          'data-form-submit': 'true',
          onClick: () =>
            onSubmit?.({ name: 'Bad climbs', description: '', color: '#1F2937', icon: '💀', isPublic: false }),
        },
        'form-submit',
      ),
    ),
  PlaylistActionsMenu: () => null,
  PlaylistFollowButton: () => null,
  PlaylistEditDoneButton: () => null,
  PlaylistOwnerToolbar: () => null,
  PlaylistBackFab: () => createElement('div', { 'data-back-fab': 'true' }),
  PlaylistQueueReplaceSheet: () => null,
}));

import PlaylistDetail from '../[playlist_uuid]';

function renderDetail(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <PlaylistDetail />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  requestMock.mockReset();
  climbsRefetch.mockClear();
  updatePlaylistMock.mockReset();
  toast.showToast.mockClear();
  playlistMocks.allClimbs = [];
  playlistMocks.activationOptions = null;
  playlistMocks.renderBoardResult = { renderBoard: null, banner: null };
});

function makePlaylist(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'p-1',
    name: 'Playlist',
    description: null,
    color: '#8C4A52',
    icon: null,
    climbCount: 2,
    boardType: 'tension',
    layoutId: 9,
    isPublic: false,
    userRole: 'owner',
    isPinnedByMe: false,
    isFollowedByMe: false,
    followerCount: 0,
    ...overrides,
  };
}

function makeClimb(uuid: string, boardType: string, layoutId: number, angle: number): Climb {
  return {
    uuid,
    name: uuid,
    setter_username: 'setter',
    frames: '',
    angle,
    ascensionist_count: 0,
    difficulty: 'V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    boardType,
    layoutId,
  };
}

describe('PlaylistDetail metadata error handling', () => {
  it('renders an error + retry state (not a fallback-titled hero) when GET_PLAYLIST rejects', async () => {
    // react-query leaves data undefined (never null) on a thrown error.
    requestMock.mockRejectedValue(new Error('network down'));

    const { findByText, queryByText, container } = renderDetail();

    expect(await findByText('detail.errors.loadTitle')).toBeTruthy();
    // The PlaylistDetailView (and its fallback-titled hero) must NOT render in
    // its place.
    expect(container.querySelector('[data-detail-view="true"]')).toBeNull();
    expect(queryByText('metadata.detail.fallbackTitle')).toBeNull();
  });

  it('retries both the metadata and climbs queries from the error state', async () => {
    requestMock.mockRejectedValue(new Error('network down'));

    const { findByLabelText } = renderDetail();
    const retry = await findByLabelText('detail.errors.tryAgain');

    requestMock.mockResolvedValue({ playlist: null });
    fireEvent.click(retry);

    // The metadata query refetches (request fires again) and the climbs query
    // is told to refetch too.
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(climbsRefetch).toHaveBeenCalledTimes(1);
  });

  it('renders the not-found state (not the load-error state) when GET_PLAYLIST resolves null', async () => {
    requestMock.mockResolvedValue({ playlist: null });

    const { findByText, queryByText } = renderDetail();

    expect(await findByText('detail.errors.notFoundTitle')).toBeTruthy();
    expect(queryByText('detail.errors.loadTitle')).toBeNull();
  });

  it('only opens incompatible rows view-only when the playlist board is mismatched', async () => {
    const compatibleClimb = makeClimb('compatible-kilter', 'kilter', 1, 40);
    const incompatibleClimb = makeClimb('incompatible-tension', 'tension', 9, 35);
    playlistMocks.allClimbs = [compatibleClimb, incompatibleClimb];
    playlistMocks.renderBoardResult = {
      renderBoard: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 },
      banner: { title: 'title', subtitle: 'subtitle', cta: 'cta', onPress: vi.fn() },
    };
    requestMock.mockResolvedValue({ playlist: makePlaylist() });

    renderDetail();

    await waitFor(() => expect(playlistMocks.activationOptions?.viewOnlyBoard).toEqual(expect.any(Function)));
    const resolveViewOnlyBoard = playlistMocks.activationOptions?.viewOnlyBoard;
    if (typeof resolveViewOnlyBoard !== 'function') throw new Error('Expected a view-only resolver');

    expect(resolveViewOnlyBoard(compatibleClimb)).toBeNull();
    expect(resolveViewOnlyBoard(incompatibleClimb)).toMatchObject({
      boardName: 'tension',
      layoutId: 9,
      angle: 35,
    });
  });
});

describe('PlaylistDetail edit cache propagation', () => {
  const basePlaylist = {
    uuid: 'p-1',
    id: 'p-1',
    name: 'Old name',
    icon: '🔥',
    color: '#6D28D9',
    description: '',
    climbCount: 3,
    boardType: 'kilter',
    layoutId: 1,
    isPublic: false,
    userRole: 'owner',
    isPinnedByMe: false,
    isFollowedByMe: false,
    followerCount: 0,
  };

  it("patches the ['userPlaylists'] cache after an edit so the Add-to-Playlist picker is not stale", async () => {
    requestMock.mockResolvedValue({ playlist: basePlaylist });
    const updated = { ...basePlaylist, name: 'Bad climbs', icon: '💀', color: '#1F2937' };
    updatePlaylistMock.mockResolvedValue(updated);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The picker's cached list still holds the pre-edit row (matched by uuid).
    queryClient.setQueryData(['userPlaylists'], [{ uuid: 'p-1', id: 'p-1', name: 'Old name', icon: '🔥' }]);

    const { findByText } = renderDetail(queryClient);

    fireEvent.click(await findByText('form-submit'));

    await waitFor(() => expect(updatePlaylistMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const cached = queryClient.getQueryData<Array<{ icon: string; name: string }>>(['userPlaylists']);
      expect(cached?.[0].icon).toBe('💀');
      expect(cached?.[0].name).toBe('Bad climbs');
    });
    // The detail hero cache is updated to the full server response.
    expect(queryClient.getQueryData(['playlist', 'p-1'])).toEqual(updated);
  });

  it('shows an update failure inline in the edit sheet (not a toast)', async () => {
    requestMock.mockResolvedValue({ playlist: basePlaylist });
    updatePlaylistMock.mockRejectedValue(new Error('update failed'));

    const { findByText, container } = renderDetail();

    fireEvent.click(await findByText('form-submit'));

    await waitFor(() => {
      expect(container.querySelector('[data-edit-error="true"]')?.textContent).toBe('edit.messages.updateFailed');
    });
    // A root toast would render behind the native sheet and be invisible.
    expect(toast.showToast).not.toHaveBeenCalledWith('edit.messages.updateFailed', 'error');
  });
});
