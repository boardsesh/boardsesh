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
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Climb } from '@boardsesh/queue';
import type { PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import type { PlaylistSelection } from '../../../../src/lib/playlists/playlist-view';

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
  previewOnly?: boolean;
  sourceId: string;
  allClimbs: Climb[];
  fetchPage: (args: {
    page: number;
    pageSize: number;
    board: TestRenderBoard;
    signal: AbortSignal;
  }) => Promise<{ climbs: Climb[]; hasMore: boolean }>;
};

/** What the mocked climbs query answers for one view (undefined = the playlist's own order). */
type TestPlaylistPage = {
  climbs: Climb[];
  totalCount: number;
  unfilteredCount: number | null;
  /** The previous view's rows standing in while this view loads. */
  placeholder?: boolean;
  error?: boolean;
  /** A fetch is under way (a background refetch or the next page). */
  fetching?: boolean;
  /** Waiting for a connection. */
  paused?: boolean;
  hasNextPage?: boolean;
};

// The metadata query goes through getHttpClient().request — mock it so we can
// make GET_PLAYLIST reject (the error path) or resolve (the not-found path).
const requestMock = vi.hoisted(() => vi.fn());
const playlistMocks = vi.hoisted(() => ({
  allClimbs: [] as Climb[],
  /** Every `view` the screen asked the climbs query for, in render order. */
  views: [] as Array<PlaylistClimbViewInput | undefined>,
  /** Overrides the query's answer per view; null answers every view with `allClimbs`. */
  pageFor: null as null | ((view: PlaylistClimbViewInput | undefined) => TestPlaylistPage),
  fetchNextPage: vi.fn(),
  activationOptions: null as CapturedActivationOptions | null,
  renderBoardResult: {
    renderBoard: null as TestRenderBoard | null,
    banner: null as TestBoardBanner | null,
  },
  appendToQueue: vi.fn(),
  reorderClimb: vi.fn(),
  removeClimb: vi.fn(),
}));
vi.mock('../../../../src/lib/graphql/client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// Discussion thread: capture the useComments args so the private-playlist case
// can prove the query never runs.
const commentsMock = vi.hoisted(() => ({
  calls: [] as Array<{ entityType: string; entityId: string | undefined; enabled: boolean }>,
  totalCount: 0,
  refetch: vi.fn(),
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useComments: (entityType: string, entityId: string | undefined, enabled = true) => {
    commentsMock.calls.push({ entityType, entityId, enabled });
    return {
      data: enabled && entityId ? { comments: [], totalCount: commentsMock.totalCount } : undefined,
      refetch: commentsMock.refetch,
    };
  },
}));

const commentSheetProps = vi.hoisted(() => ({
  current: null as { entityType?: string; entityId: string | null; canComment?: boolean } | null,
}));
const detailViewProps = vi.hoisted(() => ({
  current: null as {
    editMode: boolean;
    emptyAction: { label: string } | null;
    emptyMessage?: string;
    emptyIcon?: string;
    emptyState?: { icon: string; title: string };
    onAddAllToQueue?: () => void;
    isAddingAllToQueue?: boolean;
    addToQueueCount?: number;
    onRefresh?: () => unknown;
    climbs: Climb[];
    onReorderClimb?: (uuid: string, index: number) => Promise<void>;
    onRemoveClimb: (uuid: string) => void;
    filterBar?: ReactNode;
    filterAction?: { activeCount: number; onPress: () => void } | null;
    scrollResetKey?: string | null;
    hero: { climbCount: number };
  } | null,
}));
const snapToIndex = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/components/you/CommentSheet', () => ({
  CommentSheet: (props: {
    sheetRef: { current: { snapToIndex: (index: number) => void } | null };
    entityType?: string;
    entityId: string | null;
    canComment?: boolean;
  }) => {
    commentSheetProps.current = {
      entityType: props.entityType,
      entityId: props.entityId,
      canComment: props.canComment,
    };
    props.sheetRef.current = { snapToIndex };
    return createElement('div', { 'data-comment-sheet': 'true', 'data-entity-id': props.entityId ?? '' });
  },
}));

// usePlaylistClimbs: the climbs infinite query. The detail screen only reads
// query.refetch (for the retry) and allClimbs here.
const climbsRefetch = vi.hoisted(() => vi.fn());
const updatePlaylistMock = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@boardsesh/playlists-react', async (importOriginal) => ({
  // The real key builder: the screen invalidates one view by it.
  playlistClimbsQueryKeyFor: (await importOriginal<typeof import('@boardsesh/playlists-react')>())
    .playlistClimbsQueryKeyFor,
  usePlaylistClimbs: ({ view }: { view?: PlaylistClimbViewInput }) => {
    playlistMocks.views.push(view);
    const page: TestPlaylistPage = playlistMocks.pageFor?.(view) ?? {
      climbs: playlistMocks.allClimbs,
      totalCount: playlistMocks.allClimbs.length,
      unfilteredCount: null,
    };
    return {
      query: {
        isLoading: false,
        isSuccess: !page.error,
        isError: !!page.error,
        isFetchNextPageError: false,
        isFetching: !!page.fetching,
        fetchStatus: page.paused ? 'paused' : page.fetching ? 'fetching' : 'idle',
        isPlaceholderData: !!page.placeholder,
        data: page.error
          ? undefined
          : {
              pages: [
                {
                  climbs: page.climbs,
                  totalCount: page.totalCount,
                  unfilteredCount: page.unfilteredCount,
                  hasMore: false,
                },
              ],
            },
        isFetchingNextPage: false,
        hasNextPage: !!page.hasNextPage,
        fetchNextPage: playlistMocks.fetchNextPage,
        refetch: climbsRefetch,
      },
      allClimbs: page.error ? [] : page.climbs,
    };
  },
  usePlaylistMutations: () => ({
    updatePlaylist: updatePlaylistMock,
    deletePlaylist: vi.fn(),
    pinPlaylist: vi.fn(),
    unpinPlaylist: vi.fn(),
    followPlaylist: vi.fn(),
    unfollowPlaylist: vi.fn(),
  }),
  usePlaylistItemMutations: () => ({
    reorderPlaylistClimb: playlistMocks.reorderClimb,
    removeClimbFromPlaylist: playlistMocks.removeClimb,
  }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const routerNavigate = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ playlist_uuid: 'p-1' }),
  useNavigation: () => ({ goBack: vi.fn() }),
  useRouter: () => ({ navigate: routerNavigate, push: vi.fn(), back: vi.fn() }),
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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    absoluteFill: {},
  },
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
}));

vi.mock('../../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray4: '#C7C7CC' },
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' }, brandColors: { primary: '#6D28D9' } }),
}));
const authMock = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => authMock }));
// Whether anyone else is in the session — what turns a row tap from "replace the
// crew's queue and take the wall" into "show me this climb".
const sessionMock = vi.hoisted(() => ({ isShared: false }));
vi.mock('../../../../src/providers/queue-provider', () => ({ useIsSharedSession: () => sessionMock.isShared }));
vi.mock('../../../../src/providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../../src/lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: (options: CapturedActivationOptions) => {
    playlistMocks.activationOptions = options;
    return {
      activate: vi.fn(),
      addToQueue: { append: playlistMocks.appendToQueue, isAppending: false },
    };
  },
}));
// The filter session, reduced to a selection a test can set and the actions the
// screen calls. Its own behaviour is covered by use-climb-filter-session.test.
const filterSession = vi.hoisted(() => ({
  initialSelection: null as PlaylistSelection | null,
  setSelection: null as null | ((selection: PlaylistSelection) => void),
  activeFilterCount: 0,
  options: null as null | {
    disabled: boolean;
    liveCount: number | null;
    scopeKey: string | null;
    onSortCommit?: (sort: { sortBy: string; sortOrder: string }) => void;
    pickers?: unknown;
  },
  pauseView: vi.fn(),
  resumeView: vi.fn(),
  clearFilters: vi.fn(),
  openFilters: vi.fn(),
}));
vi.mock('../../../../src/hooks/use-climb-filter-session', async () => {
  const { useMemo, useState } = await import('react');
  const { PLAYLIST_FILTER_DEFAULTS } = await import('../../../../src/lib/playlists/playlist-view');
  const plainSelection: PlaylistSelection = {
    filters: PLAYLIST_FILTER_DEFAULTS,
    boardFilters: {},
    name: '',
    sort: { sortBy: 'position', sortOrder: 'asc' },
    boardFit: false,
  };
  return {
    useClimbFilterSession: (options: NonNullable<typeof filterSession.options>) => {
      filterSession.options = options;
      const [selection, setSelection] = useState<PlaylistSelection>(filterSession.initialSelection ?? plainSelection);
      const [pausedSelection, setPausedSelection] = useState<PlaylistSelection | null>(null);
      filterSession.setSelection = setSelection;
      const actions = useMemo(
        () => ({
          openFilters: filterSession.openFilters,
          clearFilters: filterSession.clearFilters,
          resetToDefault: vi.fn(),
          pauseView: () => {
            filterSession.pauseView();
            setPausedSelection(selection);
            setSelection(plainSelection);
          },
          resumeView: () => {
            filterSession.resumeView();
            if (pausedSelection) setSelection({ ...plainSelection, sort: pausedSelection.sort });
          },
        }),
        [selection, pausedSelection],
      );
      const state = useMemo(
        () => ({
          querySelection: selection,
          activeFilterCount: filterSession.activeFilterCount,
          chipRowProps: {},
          tokens: [],
          gradeRail: null,
          sheetProps: null,
        }),
        [selection],
      );
      return { state, actions };
    },
  };
});
vi.mock('../../../../src/components/ClimbFilterSheet', () => ({ ClimbFilterSheet: () => null }));
vi.mock('../../../../src/lib/playlist-pinned-chips-store', () => ({ playlistPinnedChipsStore: {} }));
const sortMemory = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../../../../src/lib/playlists/playlist-sort-memory', () => ({
  playlistSortMemoryKey: (uuid: string) => `playlist:${uuid}`,
  readListSort: () => ({ sortBy: 'position', sortOrder: 'asc' }),
  writeListSort: sortMemory.write,
}));
vi.mock('../../../../src/lib/last-search-store', () => ({
  boardConfigKey: (board: { boardName: string }) => board.boardName,
}));
vi.mock('../../../../src/hooks/use-personal-grades', () => ({ usePersonalGradesActive: () => false }));
vi.mock('../../../../src/lib/graphql/hooks/search-grade-source', () => ({ useSearchGradeSourceActive: () => false }));

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
// renders *instead of* a fallback-titled hero, and `editMode` so the overflow
// menu's regression tests can see the screen actually flip into edit mode.
vi.mock('../../../../src/components/playlist', () => ({
  PlaylistDetailView: ({
    hero,
    headerSlot,
    actions,
    editMode,
    emptyAction,
    emptyMessage,
    emptyIcon,
    emptyState,
    onAddAllToQueue,
    isAddingAllToQueue,
    addToQueueCount,
    onRefresh,
    climbs,
    onReorderClimb,
    onRemoveClimb,
    filterBar,
    filterAction,
    scrollResetKey,
  }: {
    hero: { name: string; climbCount: number };
    headerSlot?: ReactNode;
    actions?: (collapsed: boolean) => ReactNode;
    editMode?: boolean;
    emptyAction?: { label: string; onPress: () => void };
    emptyMessage?: string;
    emptyIcon?: string;
    emptyState?: { icon: string; title: string };
    onAddAllToQueue?: () => void;
    isAddingAllToQueue?: boolean;
    addToQueueCount?: number;
    onRefresh?: () => unknown;
    climbs: Climb[];
    onReorderClimb?: (uuid: string, index: number) => Promise<void>;
    onRemoveClimb: (uuid: string) => void;
    filterBar?: ReactNode;
    filterAction?: { activeCount: number; onPress: () => void } | null;
    scrollResetKey?: string | null;
  }) => {
    detailViewProps.current = {
      editMode: !!editMode,
      emptyAction: emptyAction ?? null,
      emptyMessage,
      emptyIcon,
      emptyState,
      onAddAllToQueue,
      isAddingAllToQueue,
      addToQueueCount,
      onRefresh,
      climbs,
      onReorderClimb,
      onRemoveClimb,
      filterBar,
      filterAction,
      scrollResetKey,
      hero,
    };
    return createElement(
      'div',
      {
        'data-detail-view': 'true',
        'data-hero-name': hero.name,
        'data-edit-mode': String(!!editMode),
      },
      // Both forms: the expanded header controls, and the collapsed form the
      // header switches to once the hero scrolls away.
      createElement('div', { 'data-actions-expanded': 'true' }, actions?.(false)),
      createElement('div', { 'data-actions-collapsed': 'true' }, actions?.(true)),
      headerSlot,
      emptyAction
        ? createElement(
            'button',
            { 'data-empty-action': emptyAction.label, onClick: emptyAction.onPress },
            emptyAction.label,
          )
        : null,
    );
  },
  PlaylistDiscussionRow: ({ commentCount, onPress }: { commentCount: number; onPress: () => void }) =>
    createElement(
      'button',
      { 'data-discussion-row': 'true', 'data-comment-count': String(commentCount), onClick: onPress },
      'discussion',
    ),
  SKELETON_PLACEHOLDERS: ['a', 'b'],
  // Surface the edit submit so the cache-patch test can drive handleEditSubmit
  // without the real gorhom sheet.
  PlaylistFormSheet: ({
    mode,
    visible,
    submitError,
    onSubmit,
  }: {
    mode?: string;
    visible?: boolean;
    submitError?: string | null;
    onSubmit?: (values: unknown) => void;
  }) =>
    createElement(
      'div',
      { 'data-form-sheet': 'true', 'data-form-mode': mode ?? '', 'data-form-visible': String(!!visible) },
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
  // The overflow menu's rows: each callback gets its own button so a test can
  // fire it the way a tap on the native menu row does.
  PlaylistActionsMenu: ({
    onTogglePin,
    onAddClimbs,
    onEditDetails,
    onEdit,
    onDelete,
  }: {
    onTogglePin?: () => void;
    onAddClimbs?: () => void;
    onEditDetails?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
  }) =>
    createElement(
      'div',
      { 'data-actions-menu': 'true', 'data-has-add-climbs': String(!!onAddClimbs) },
      createElement('button', { 'data-menu-pin': 'true', onClick: onTogglePin }),
      onAddClimbs ? createElement('button', { 'data-menu-add': 'true', onClick: onAddClimbs }) : null,
      createElement('button', { 'data-menu-edit-details': 'true', onClick: onEditDetails }),
      createElement('button', { 'data-menu-edit-climbs': 'true', onClick: onEdit }),
      createElement('button', { 'data-menu-delete': 'true', onClick: onDelete }),
    ),
  PlaylistFollowButton: () => null,
  PlaylistEditDoneButton: ({ onPress, collapsed }: { onPress: () => void; collapsed?: boolean }) =>
    collapsed ? null : createElement('button', { 'data-edit-done': 'true', onClick: onPress }, 'done'),
  PlaylistFilterBar: ({ editing }: { editing: boolean }) =>
    createElement('div', { 'data-filter-bar': 'true', 'data-editing': String(editing) }),
  // Surfaces onEdit so a test can enter the climbs edit mode without the real
  // glass toolbar.
  PlaylistOwnerToolbar: ({ onEdit }: { onEdit?: () => void }) =>
    createElement('button', { 'data-owner-edit': 'true', onClick: onEdit }, 'edit-climbs'),
  PlaylistStateHeader: () => createElement('div', { 'data-state-header': 'true' }),
}));

import PlaylistDetail from '../[playlist_uuid]';
import { Alert } from 'react-native';
import { invalidatePrivacySnapshots } from '../../../../src/lib/privacy/privacy-cache';

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
  playlistMocks.views = [];
  playlistMocks.pageFor = null;
  playlistMocks.fetchNextPage.mockClear();
  filterSession.initialSelection = null;
  filterSession.setSelection = null;
  filterSession.activeFilterCount = 0;
  filterSession.options = null;
  filterSession.pauseView.mockClear();
  filterSession.resumeView.mockClear();
  filterSession.clearFilters.mockClear();
  filterSession.openFilters.mockClear();
  sortMemory.write.mockClear();
  climbsRefetch.mockClear();
  updatePlaylistMock.mockReset();
  toast.showToast.mockClear();
  playlistMocks.allClimbs = [];
  playlistMocks.reorderClimb.mockReset();
  playlistMocks.removeClimb.mockReset();
  vi.mocked(Alert.alert).mockClear();
  playlistMocks.activationOptions = null;
  sessionMock.isShared = false;
  playlistMocks.renderBoardResult = { renderBoard: null, banner: null };
  commentsMock.calls = [];
  commentsMock.totalCount = 0;
  commentSheetProps.current = null;
  detailViewProps.current = null;
  routerNavigate.mockClear();
  snapToIndex.mockClear();
  authMock.isAuthenticated = true;
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

  // A row tap on this screen activates with `replaceQueueOnActivate` — the
  // loudest write in the app, since it swaps everyone's queue for the playlist
  // order and takes the wall. In a crew that cannot be what tapping a row to look
  // at a climb means, so the tap browses instead.
  it('browses a row tap in a crew instead of replacing everyone’s queue', async () => {
    sessionMock.isShared = true;
    requestMock.mockResolvedValue({ playlist: makePlaylist() });

    renderDetail();

    await waitFor(() => expect(playlistMocks.activationOptions?.previewOnly).toBe(true));
  });

  it('leaves a solo row tap activating the playlist as before', async () => {
    requestMock.mockResolvedValue({ playlist: makePlaylist() });

    renderDetail();

    await waitFor(() => expect(playlistMocks.activationOptions).not.toBeNull());
    expect(playlistMocks.activationOptions?.previewOnly).toBe(false);
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

describe('PlaylistDetail discussion thread', () => {
  it('renders the discussion row and wires the sheet to the `<uuid>:_all` entity on a public playlist', async () => {
    commentsMock.totalCount = 4;
    requestMock.mockResolvedValue({ playlist: makePlaylist({ isPublic: true }) });

    const { container } = renderDetail();

    await waitFor(() => expect(container.querySelector('[data-discussion-row="true"]')).not.toBeNull());
    expect(container.querySelector('[data-discussion-row="true"]')?.getAttribute('data-comment-count')).toBe('4');
    expect(commentsMock.calls.some((call) => call.entityType === 'playlist_climb' && call.enabled)).toBe(true);
    // Closed until tapped, but already pointed at the right entity type.
    expect(commentSheetProps.current?.entityType).toBe('playlist_climb');
    expect(commentSheetProps.current?.entityId).toBeNull();

    fireEvent.click(container.querySelector('[data-discussion-row="true"]') as HTMLButtonElement);

    // Stacked native sheets are opened imperatively, not via a `visible` prop.
    await waitFor(() => expect(snapToIndex).toHaveBeenCalledWith(0));
    await waitFor(() => expect(commentSheetProps.current?.entityId).toBe('p-1:_all'));
  });

  it('renders no discussion row and never enables the comments query on a private playlist', async () => {
    requestMock.mockResolvedValue({ playlist: makePlaylist({ isPublic: false }) });

    const { container } = renderDetail();

    await waitFor(() => expect(container.querySelector('[data-detail-view="true"]')).not.toBeNull());
    expect(container.querySelector('[data-discussion-row="true"]')).toBeNull();
    expect(commentsMock.calls.every((call) => call.enabled === false)).toBe(true);
    expect(commentSheetProps.current?.entityId).toBeNull();
  });

  it('passes canComment=false through when the viewer is logged out', async () => {
    requestMock.mockResolvedValue({ playlist: makePlaylist({ isPublic: true }) });
    authMock.isAuthenticated = false;

    renderDetail();

    await waitFor(() => expect(commentSheetProps.current?.canComment).toBe(false));
  });

  it('hides the discussion row while the climbs edit mode is open', async () => {
    requestMock.mockResolvedValue({ playlist: makePlaylist({ isPublic: true, userRole: 'owner' }) });

    const { container } = renderDetail();

    await waitFor(() => expect(container.querySelector('[data-discussion-row="true"]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);

    await waitFor(() => expect(container.querySelector('[data-discussion-row="true"]')).toBeNull());
  });
});

// The owner's overflow is a native menu (HIG Pull-down buttons), the collapsed
// form of the header controls. Each row acts directly; there is no sheet whose
// `onClose` it could wait on (#3966).
describe('PlaylistDetail owner overflow menu', () => {
  async function renderOwnerDetail(playlistOverrides: Record<string, unknown> = {}) {
    requestMock.mockResolvedValue({ playlist: makePlaylist({ userRole: 'owner', ...playlistOverrides }) });
    const rendered = renderDetail();
    await waitFor(() => expect(rendered.container.querySelector('[data-actions-menu="true"]')).not.toBeNull());
    return rendered;
  }

  it('enters the climbs edit mode from the menu without waiting on onClose', async () => {
    const { container } = await renderOwnerDetail();
    expect(container.querySelector('[data-detail-view="true"]')?.getAttribute('data-edit-mode')).toBe('false');

    fireEvent.click(container.querySelector('[data-menu-edit-climbs="true"]') as HTMLButtonElement);

    await waitFor(() =>
      expect(container.querySelector('[data-detail-view="true"]')?.getAttribute('data-edit-mode')).toBe('true'),
    );
  });

  it('is the collapsed form only: the expanded header keeps the owner toolbar', async () => {
    const { container } = await renderOwnerDetail();

    const expanded = container.querySelector('[data-actions-expanded="true"]');
    const collapsed = container.querySelector('[data-actions-collapsed="true"]');
    expect(expanded?.querySelector('[data-owner-edit="true"]')).not.toBeNull();
    expect(expanded?.querySelector('[data-actions-menu="true"]')).toBeNull();
    expect(collapsed?.querySelector('[data-actions-menu="true"]')).not.toBeNull();
    // No sheet is mounted for it any more.
    expect(container.querySelectorAll('[data-actions-menu="true"]')).toHaveLength(1);
  });

  it('opens the edit-details sheet from the menu (rename has its own row now)', async () => {
    const { container } = await renderOwnerDetail();
    expect(container.querySelector('[data-form-sheet="true"]')?.getAttribute('data-form-visible')).toBe('false');

    fireEvent.click(container.querySelector('[data-menu-edit-details="true"]') as HTMLButtonElement);

    await waitFor(() =>
      expect(container.querySelector('[data-form-sheet="true"]')?.getAttribute('data-form-visible')).toBe('true'),
    );
    expect(container.querySelector('[data-form-sheet="true"]')?.getAttribute('data-form-mode')).toBe('edit');
    // The rename sheet must NOT drag the screen into edit mode with it.
    expect(container.querySelector('[data-detail-view="true"]')?.getAttribute('data-edit-mode')).toBe('false');
  });

  it('routes the add-climbs row and the empty-state CTA to the Climbs tab', async () => {
    const { container } = await renderOwnerDetail();

    fireEvent.click(container.querySelector('[data-menu-add="true"]') as HTMLButtonElement);
    expect(routerNavigate).toHaveBeenCalledWith('/(tabs)/climbs');

    routerNavigate.mockClear();
    fireEvent.click(container.querySelector('[data-empty-action="detail.menu.addClimbs"]') as HTMLButtonElement);
    expect(routerNavigate).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  it('hides the add-climbs affordances when the playlist is on another board', async () => {
    playlistMocks.renderBoardResult = {
      renderBoard: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 },
      banner: { title: 'title', subtitle: 'subtitle', cta: 'cta', onPress: vi.fn() },
    };

    const { container } = await renderOwnerDetail();

    // The switch-board banner owns that prompt, so no competing add CTA.
    expect(container.querySelector('[data-actions-menu="true"]')?.getAttribute('data-has-add-climbs')).toBe('false');
    expect(detailViewProps.current?.emptyAction).toBeNull();
  });

  it('gives a non-owner no overflow menu at all', async () => {
    requestMock.mockResolvedValue({ playlist: makePlaylist({ userRole: 'viewer', isPublic: true }) });

    const { container } = renderDetail();

    await waitFor(() => expect(container.querySelector('[data-detail-view="true"]')).not.toBeNull());
    expect(container.querySelector('[data-actions-menu="true"]')).toBeNull();
    expect(detailViewProps.current?.emptyAction).toBeNull();
  });

  it('gives a signed-out viewer no header actions at all, so no empty glass item shows', async () => {
    authMock.isAuthenticated = false;
    requestMock.mockResolvedValue({ playlist: makePlaylist({ userRole: 'viewer', isPublic: true }) });

    const { container } = renderDetail();

    await waitFor(() => expect(container.querySelector('[data-detail-view="true"]')).not.toBeNull());
    expect(container.querySelector('[data-actions-expanded="true"]')?.childElementCount).toBe(0);
    expect(container.querySelector('[data-actions-collapsed="true"]')?.childElementCount).toBe(0);
  });

  it('forwards the bulk add-to-queue handler and its in-flight flag to the detail view', async () => {
    // A non-owner is the case the issue names — a crew member queueing someone
    // else's playlist — and it is exactly the population the overflow menu can't
    // reach, so the wiring has to survive here.
    requestMock.mockResolvedValue({ playlist: makePlaylist({ userRole: 'viewer', isPublic: true }) });

    const { container } = renderDetail();

    await waitFor(() => expect(container.querySelector('[data-detail-view="true"]')).not.toBeNull());
    expect(detailViewProps.current?.onAddAllToQueue).toBe(playlistMocks.appendToQueue);
    expect(detailViewProps.current?.isAddingAllToQueue).toBe(false);
  });
});

// HIG Refresh content controls: a pull refetches what the screen shows.
describe('PlaylistDetail pull to refresh', () => {
  it('refetches the playlist details and its climbs', async () => {
    requestMock.mockResolvedValue({ playlist: makePlaylist({ userRole: 'viewer', isPublic: true }) });
    const { container } = renderDetail();
    await waitFor(() => expect(container.querySelector('[data-detail-view="true"]')).not.toBeNull());
    const callsBefore = requestMock.mock.calls.length;
    climbsRefetch.mockClear();
    commentsMock.refetch.mockClear();

    await act(async () => {
      await detailViewProps.current?.onRefresh?.();
    });

    expect(climbsRefetch).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls.length).toBeGreaterThan(callsBefore);
    // A public playlist has a discussion thread, so its count refreshes too.
    expect(commentsMock.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('PlaylistDetail privacy withdrawal', () => {
  async function editProtectedClimbs() {
    playlistMocks.allClimbs = [makeClimb('private-climb', 'kilter', 1, 40), makeClimb('other-climb', 'kilter', 1, 40)];
    requestMock.mockResolvedValue({ playlist: makePlaylist() });
    const rendered = renderDetail();
    await waitFor(() => expect(rendered.container.querySelector('[data-owner-edit="true"]')).not.toBeNull());
    fireEvent.click(rendered.container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);
    expect(detailViewProps.current?.editMode).toBe(true);
    expect(detailViewProps.current?.climbs).toHaveLength(2);
    return rendered;
  }

  it('withdraws the edit snapshot before stale query props change and accepts fresh authorized rows', async () => {
    const { rerender, queryClient } = await editProtectedClimbs();
    act(() => invalidatePrivacySnapshots());
    expect(detailViewProps.current?.editMode).toBe(false);
    expect(detailViewProps.current?.climbs).toEqual([]);
    playlistMocks.allClimbs = [makeClimb('authorized-climb', 'kilter', 1, 40)];
    rerender(
      <QueryClientProvider client={queryClient}>
        <PlaylistDetail />
      </QueryClientProvider>,
    );
    expect(detailViewProps.current?.climbs.map((climb) => climb.uuid)).toEqual(['authorized-climb']);
  });

  it('does not restore revoked rows from an in-flight reorder failure', async () => {
    let rejectReorder: ((reason: Error) => void) | undefined;
    playlistMocks.reorderClimb.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectReorder = reject;
        }),
    );
    await editProtectedClimbs();
    let pending: Promise<void> | undefined;
    act(() => {
      pending = detailViewProps.current?.onReorderClimb?.('private-climb', 1);
    });
    expect(playlistMocks.reorderClimb).toHaveBeenCalledTimes(1);
    act(() => invalidatePrivacySnapshots());
    await act(async () => {
      rejectReorder?.(new Error('Access revoked'));
      await pending;
    });
    expect(detailViewProps.current?.climbs).toEqual([]);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('retires an already open removal confirmation across credential changes', async () => {
    await editProtectedClimbs();
    act(() => {
      detailViewProps.current?.onRemoveClimb('private-climb');
    });
    const confirmation = vi
      .mocked(Alert.alert)
      .mock.calls.at(-1)?.[2]
      ?.find((button) => button.style === 'destructive');
    expect(confirmation).toBeDefined();
    act(() => invalidatePrivacySnapshots('credential'));
    await act(async () => {
      await Promise.resolve(confirmation?.onPress?.());
    });
    expect(playlistMocks.removeClimb).not.toHaveBeenCalled();
    expect(detailViewProps.current?.climbs).toEqual([]);
  });
});

// Sort and filters inside a playlist (#6651). The session itself is mocked; these
// pin what the screen does with it: which view the query asks for, which view the
// play drawer and Add to queue follow, and how edit mode gets the plain order.
describe('PlaylistDetail sort and filters', () => {
  const PLAIN_ROWS = [makeClimb('plain-1', 'tension', 9, 40), makeClimb('plain-2', 'tension', 9, 40)];
  const SORTED_ROWS = [makeClimb('plain-2', 'tension', 9, 40), makeClimb('plain-1', 'tension', 9, 40)];
  const FILTERED_ROWS = [makeClimb('plain-2', 'tension', 9, 40)];
  const DIFFICULTY_VIEW_KEY = JSON.stringify({ sortBy: 'difficulty', sortOrder: 'asc' });

  function selectionWith(overrides: Partial<PlaylistSelection>): PlaylistSelection {
    return {
      filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', boulders: true, routes: true },
      boardFilters: {},
      name: '',
      sort: { sortBy: 'position', sortOrder: 'asc' },
      boardFit: false,
      ...overrides,
    };
  }

  function answerBySort(sortedPlaceholder = false) {
    playlistMocks.pageFor = (view) =>
      view?.sortBy === 'difficulty'
        ? {
            climbs: sortedPlaceholder ? PLAIN_ROWS : SORTED_ROWS,
            totalCount: 2,
            unfilteredCount: null,
            placeholder: sortedPlaceholder,
          }
        : { climbs: PLAIN_ROWS, totalCount: 2, unfilteredCount: null };
  }

  function mockClimbsRequests() {
    requestMock.mockImplementation(async (request: unknown) => {
      if (typeof request === 'object' && request !== null && 'document' in request) {
        return { playlistClimbs: { climbs: [], hasMore: false } };
      }
      return { playlist: makePlaylist() };
    });
  }

  async function renderPlaylist() {
    mockClimbsRequests();
    const rendered = renderDetail();
    // The owner toolbar shows once the playlist itself has loaded.
    await waitFor(() => expect(rendered.container.querySelector('[data-owner-edit="true"]')).not.toBeNull());
    return rendered;
  }

  async function lastFetchInput() {
    const board = { boardName: 'tension', layoutId: 9, sizeId: 1, setIds: '1', angle: 40 };
    await playlistMocks.activationOptions?.fetchPage({
      page: 0,
      pageSize: 50,
      board,
      signal: new AbortController().signal,
    });
    const call = requestMock.mock.calls.findLast(
      ([request]) => typeof request === 'object' && request !== null && 'document' in request,
    );
    if (!call) throw new Error('fetchPage sent no request');
    return (call[0] as { variables: { input: Record<string, unknown> } }).variables.input;
  }

  it('sends no view for the playlist order, and the picked sort once there is one', async () => {
    await renderPlaylist();
    expect(playlistMocks.views.at(-1)).toBeUndefined();

    act(() => filterSession.setSelection?.(selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } })));

    expect(playlistMocks.views.at(-1)).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
  });

  it('keeps the drawer track and Add to queue on the rows on screen while a new sort loads', async () => {
    answerBySort(true);
    await renderPlaylist();

    act(() => filterSession.setSelection?.(selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } })));

    // The plain rows still stand in, so the plain playlist is what a tap walks.
    expect(playlistMocks.activationOptions?.sourceId).toBe('playlist:p-1');
    expect(await lastFetchInput()).not.toHaveProperty('view');
    expect(detailViewProps.current?.scrollResetKey).toBeNull();

    answerBySort(false);
    act(() => filterSession.setSelection?.(selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } })));

    expect(playlistMocks.activationOptions?.sourceId).toBe(`playlist:p-1|${DIFFICULTY_VIEW_KEY}`);
    expect(playlistMocks.activationOptions?.allClimbs.map((climb) => climb.uuid)).toEqual(['plain-2', 'plain-1']);
    expect(await lastFetchInput()).toMatchObject({ view: { sortBy: 'difficulty', sortOrder: 'asc' } });
    expect(detailViewProps.current?.scrollResetKey).toBe(DIFFICULTY_VIEW_KEY);
  });

  it('opens the editor on the playlist order once it is on screen, then gives the sort back', async () => {
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    let plainOrderLoaded = false;
    playlistMocks.pageFor = (view) => {
      if (view?.sortBy === 'difficulty') return { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null };
      // The plain order loads behind the sorted rows until the test lets it land.
      return plainOrderLoaded
        ? { climbs: PLAIN_ROWS, totalCount: 2, unfilteredCount: null }
        : { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null, placeholder: true };
    };
    const { container, rerender, queryClient } = await renderPlaylist();
    // A sorted list never offers a drag: a reorder index is a place in the playlist order.
    expect(detailViewProps.current?.onReorderClimb).toBeUndefined();

    fireEvent.click(container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);

    expect(filterSession.pauseView).toHaveBeenCalledTimes(1);
    expect(detailViewProps.current?.editMode).toBe(false);
    expect(filterSession.options?.disabled).toBe(true);
    expect(detailViewProps.current?.filterAction).toBeNull();

    plainOrderLoaded = true;
    rerender(
      <QueryClientProvider client={queryClient}>
        <PlaylistDetail />
      </QueryClientProvider>,
    );

    expect(detailViewProps.current?.editMode).toBe(true);
    expect(detailViewProps.current?.climbs.map((climb) => climb.uuid)).toEqual(['plain-1', 'plain-2']);
    expect(detailViewProps.current?.onReorderClimb).toBeDefined();

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(container.querySelector('[data-edit-done="true"]') as HTMLButtonElement);

    expect(detailViewProps.current?.editMode).toBe(false);
    expect(filterSession.resumeView).toHaveBeenCalledTimes(1);
    expect(playlistMocks.views.at(-1)).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
    // A removed climb can take its setter off the sheet's Setters picker.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['playlistSetters', 'p-1'] });
  });

  it("opens the sheet's pickers on the Discover stack, with this playlist's setters and no heatmap", async () => {
    await renderPlaylist();
    expect(filterSession.options?.pickers).toEqual({
      stack: 'discover',
      heatmap: false,
      setterList: { kind: 'playlist', playlistId: 'p-1' },
    });
  });

  it('gives the view back when the playlist order fails to load for the editor', async () => {
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    playlistMocks.pageFor = (view) =>
      view?.sortBy === 'difficulty'
        ? { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null }
        : { climbs: [], totalCount: 0, unfilteredCount: null, error: true };
    const { container } = await renderPlaylist();

    fireEvent.click(container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);

    expect(detailViewProps.current?.editMode).toBe(false);
    expect(filterSession.resumeView).toHaveBeenCalledTimes(1);
    expect(filterSession.options?.disabled).toBe(false);
  });

  it('says how many a filtered list holds and adds just those, with "Fits my board" on', async () => {
    filterSession.initialSelection = selectionWith({ name: 'crimp', boardFit: true });
    filterSession.activeFilterCount = 1;
    playlistMocks.pageFor = () => ({ climbs: FILTERED_ROWS, totalCount: 12, unfilteredCount: 117 });
    await renderPlaylist();

    expect(detailViewProps.current?.addToQueueCount).toBe(12);
    expect(detailViewProps.current?.filterAction).toMatchObject({ activeCount: 1 });
    expect(filterSession.options?.liveCount).toBe(12);
    // The hero keeps the playlist's own count.
    expect(detailViewProps.current?.hero.climbCount).toBe(2);
  });

  it('keeps the plain Add to queue label for a sort alone', async () => {
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    answerBySort(false);
    await renderPlaylist();

    expect(detailViewProps.current?.addToQueueCount).toBeUndefined();
  });

  it('offers Clear filters on a list filtered to nothing, worded for the filter', async () => {
    filterSession.initialSelection = selectionWith({ name: 'crimp' });
    playlistMocks.pageFor = () => ({ climbs: [], totalCount: 0, unfilteredCount: 117 });
    const { container } = await renderPlaylist();

    expect(detailViewProps.current?.emptyMessage).toBe('detail.view.empty.noName');
    expect(detailViewProps.current?.emptyIcon).toBe('filter');
    expect(detailViewProps.current?.emptyState).toEqual({ icon: 'filter', title: 'detail.view.empty.noName' });
    fireEvent.click(container.querySelector('[data-empty-action="detail.view.clearFilters"]') as HTMLButtonElement);
    expect(filterSession.clearFilters).toHaveBeenCalledTimes(1);
  });

  it('reads a list that is merely empty as empty, even with a filter just set', async () => {
    filterSession.initialSelection = selectionWith({ name: 'crimp' });
    // The server sends no unfilteredCount: the rows on screen are not filtered yet.
    playlistMocks.pageFor = () => ({ climbs: [], totalCount: 0, unfilteredCount: null });
    await renderPlaylist();

    expect(detailViewProps.current?.emptyMessage).toBe('detail.empty');
    expect(detailViewProps.current?.emptyState).toBeUndefined();
  });

  it('says the climbs failed to load and offers a retry, rather than an empty playlist', async () => {
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    playlistMocks.pageFor = () => ({ climbs: [], totalCount: 0, unfilteredCount: null, error: true });
    const { container } = await renderPlaylist();

    expect(detailViewProps.current?.emptyMessage).toBe('detail.errors.loadTitle');
    expect(detailViewProps.current?.emptyState).toMatchObject({ icon: 'error' });
    climbsRefetch.mockClear();
    fireEvent.click(container.querySelector('[data-empty-action="detail.errors.tryAgain"]') as HTMLButtonElement);
    expect(climbsRefetch).toHaveBeenCalledTimes(1);
  });

  it('counts only the climbs this board can add once every filtered row is loaded', async () => {
    playlistMocks.renderBoardResult = {
      renderBoard: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 },
      banner: null,
    };
    filterSession.initialSelection = selectionWith({ name: 'crimp' });
    const mixedRows = [makeClimb('kilter-row', 'kilter', 1, 40), makeClimb('tension-row', 'tension', 9, 40)];
    let allLoaded = false;
    playlistMocks.pageFor = () => ({ climbs: mixedRows, totalCount: 3, unfilteredCount: 9, hasNextPage: !allLoaded });
    const { rerender, queryClient } = await renderPlaylist();
    // Rows still to load: the count would be a guess, so the label stays plain.
    expect(detailViewProps.current?.addToQueueCount).toBeUndefined();

    allLoaded = true;
    rerender(
      <QueryClientProvider client={queryClient}>
        <PlaylistDetail />
      </QueryClientProvider>,
    );
    // The dimmed Tension row is left out of the add, so it is left out of the count.
    expect(detailViewProps.current?.addToQueueCount).toBe(1);
  });

  it('marks the cached playlist order stale and waits for its refetch before the editor reads it', async () => {
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    const STALE_ROWS = [makeClimb('removed-climb', 'tension', 9, 40), ...PLAIN_ROWS];
    let refetched = false;
    playlistMocks.pageFor = (view) =>
      view?.sortBy === 'difficulty'
        ? { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null }
        : refetched
          ? { climbs: PLAIN_ROWS, totalCount: 2, unfilteredCount: null }
          : { climbs: STALE_ROWS, totalCount: 3, unfilteredCount: null, fetching: true };
    const { container, rerender, queryClient } = await renderPlaylist();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['playlistClimbs', 'p-1', 'all', null, null, 'default', 0],
      exact: true,
      refetchType: 'none',
    });
    // The cached rows are up but still refreshing: no editor yet.
    expect(detailViewProps.current?.editMode).toBe(false);

    refetched = true;
    rerender(
      <QueryClientProvider client={queryClient}>
        <PlaylistDetail />
      </QueryClientProvider>,
    );
    expect(detailViewProps.current?.editMode).toBe(true);
    expect(detailViewProps.current?.climbs.map((climb) => climb.uuid)).toEqual(['plain-1', 'plain-2']);
  });

  it('loads as many playlist-order rows as the sorted list showed before the editor opens', async () => {
    const sortedForty = Array.from({ length: 40 }, (_, index) => makeClimb(`climb-${39 - index}`, 'tension', 9, 40));
    const plainTwenty = sortedForty.slice(0, 20).reverse();
    const plainForty = [...sortedForty].reverse();
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    let pagesLoaded = 1;
    playlistMocks.pageFor = (view) =>
      view?.sortBy === 'difficulty'
        ? { climbs: sortedForty, totalCount: 40, unfilteredCount: null }
        : pagesLoaded === 1
          ? { climbs: plainTwenty, totalCount: 40, unfilteredCount: null, hasNextPage: true }
          : { climbs: plainForty, totalCount: 40, unfilteredCount: null };
    const { container, rerender, queryClient } = await renderPlaylist();

    fireEvent.click(container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);

    expect(playlistMocks.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(detailViewProps.current?.editMode).toBe(false);

    pagesLoaded = 2;
    rerender(
      <QueryClientProvider client={queryClient}>
        <PlaylistDetail />
      </QueryClientProvider>,
    );
    expect(detailViewProps.current?.editMode).toBe(true);
    expect(detailViewProps.current?.climbs).toHaveLength(40);
  });

  it('gives the view back with a message when the playlist order waits for a connection', async () => {
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    playlistMocks.pageFor = (view) =>
      view?.sortBy === 'difficulty'
        ? { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null }
        : { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null, placeholder: true, paused: true };
    const { container } = await renderPlaylist();

    fireEvent.click(container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);

    expect(detailViewProps.current?.editMode).toBe(false);
    expect(filterSession.resumeView).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('detail.errors.loadDescription', 'error');
    expect(filterSession.options?.disabled).toBe(false);
  });

  it('offers Done while the editor waits, which gives the view back', async () => {
    filterSession.initialSelection = selectionWith({ sort: { sortBy: 'difficulty', sortOrder: 'asc' } });
    playlistMocks.pageFor = (view) =>
      view?.sortBy === 'difficulty'
        ? { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null }
        : { climbs: SORTED_ROWS, totalCount: 2, unfilteredCount: null, placeholder: true, fetching: true };
    const { container } = await renderPlaylist();

    fireEvent.click(container.querySelector('[data-owner-edit="true"]') as HTMLButtonElement);
    expect(filterSession.options?.disabled).toBe(true);

    fireEvent.click(container.querySelector('[data-edit-done="true"]') as HTMLButtonElement);

    expect(detailViewProps.current?.editMode).toBe(false);
    expect(filterSession.resumeView).toHaveBeenCalledTimes(1);
    expect(filterSession.options?.disabled).toBe(false);
    expect(playlistMocks.views.at(-1)).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
  });

  it('remembers a picked sort for this playlist', async () => {
    await renderPlaylist();
    const sort = { sortBy: 'quality', sortOrder: 'desc' };

    filterSession.options?.onSortCommit?.(sort);

    expect(sortMemory.write).toHaveBeenCalledWith(
      'playlist:p-1',
      sort,
      expect.objectContaining({ options: expect.any(Array) }),
    );
  });

  it('shows no filter chrome on a playlist with no climbs', async () => {
    requestMock.mockResolvedValue({ playlist: makePlaylist({ climbCount: 0 }) });
    const { container } = renderDetail();
    await waitFor(() => expect(container.querySelector('[data-detail-view="true"]')).not.toBeNull());

    expect(detailViewProps.current?.filterBar).toBeNull();
    expect(detailViewProps.current?.filterAction).toBeNull();
  });
});
