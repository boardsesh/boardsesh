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

// Discussion thread: capture the useComments args so the private-playlist case
// can prove the query never runs.
const commentsMock = vi.hoisted(() => ({
  calls: [] as Array<{ entityType: string; entityId: string | undefined; enabled: boolean }>,
  totalCount: 0,
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useComments: (entityType: string, entityId: string | undefined, enabled = true) => {
    commentsMock.calls.push({ entityType, entityId, enabled });
    return { data: enabled && entityId ? { comments: [], totalCount: commentsMock.totalCount } : undefined };
  },
}));

const commentSheetProps = vi.hoisted(() => ({
  current: null as { entityType?: string; entityId: string | null; canComment?: boolean } | null,
}));
const detailViewProps = vi.hoisted(() => ({
  current: null as { editMode: boolean; emptyAction: { label: string } | null } | null,
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
const playlistsAdapterMock = vi.hoisted(() => ({
  localLibrary: undefined as undefined | { get: (playlistUuid: string) => Promise<Record<string, unknown> | null> },
}));
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
  usePlaylistsAdapter: () => playlistsAdapterMock,
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
const authMock = vi.hoisted(() => ({
  isAuthenticated: true,
  accessCapabilities: { useAccountFeatures: true, useLocalPlaylists: false },
}));
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => authMock }));
vi.mock('../../../../src/providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../../src/lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
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
// renders *instead of* a fallback-titled hero, and `editMode` so the overflow
// menu's regression tests can see the screen actually flip into edit mode.
vi.mock('../../../../src/components/playlist', () => ({
  PlaylistDetailView: ({
    hero,
    headerSlot,
    actions,
    editMode,
    emptyAction,
  }: {
    hero: { name: string };
    headerSlot?: ReactNode;
    actions?: (collapsed: boolean) => ReactNode;
    editMode?: boolean;
    emptyAction?: { label: string; onPress: () => void };
  }) => {
    detailViewProps.current = { editMode: !!editMode, emptyAction: emptyAction ?? null };
    return createElement(
      'div',
      {
        'data-detail-view': 'true',
        'data-hero-name': hero.name,
        'data-edit-mode': String(!!editMode),
      },
      actions?.(false),
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
    allowPublic,
    onSubmit,
  }: {
    mode?: string;
    visible?: boolean;
    submitError?: string | null;
    allowPublic?: boolean;
    onSubmit?: (values: unknown) => void;
  }) =>
    createElement(
      'div',
      {
        'data-form-sheet': 'true',
        'data-form-mode': mode ?? '',
        'data-form-visible': String(!!visible),
        'data-allow-public': String(allowPublic ?? true),
      },
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
  // The overflow menu's rows are the regression surface for #3966: each callback
  // gets its own button so a test can fire it WITHOUT ever calling `onClose`
  // (which the real sheet coordinator suppresses on a controlled close).
  PlaylistActionsMenu: ({
    onTogglePin,
    onAddClimbs,
    onEditDetails,
    onEdit,
    onDelete,
    onClose,
  }: {
    onTogglePin?: () => void;
    onAddClimbs?: () => void;
    onEditDetails?: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    onClose?: () => void;
  }) =>
    createElement(
      'div',
      { 'data-actions-menu': 'true', 'data-has-add-climbs': String(!!onAddClimbs) },
      onTogglePin ? createElement('button', { 'data-menu-pin': 'true', onClick: onTogglePin }) : null,
      onAddClimbs ? createElement('button', { 'data-menu-add': 'true', onClick: onAddClimbs }) : null,
      createElement('button', { 'data-menu-edit-details': 'true', onClick: onEditDetails }),
      createElement('button', { 'data-menu-edit-climbs': 'true', onClick: onEdit }),
      createElement('button', { 'data-menu-delete': 'true', onClick: onDelete }),
      createElement('button', { 'data-menu-close': 'true', onClick: onClose }),
    ),
  PlaylistFollowButton: () => null,
  PlaylistEditDoneButton: () => null,
  // Surfaces onEdit so a test can enter the climbs edit mode without the real
  // glass toolbar.
  PlaylistOwnerToolbar: ({ onEdit }: { onEdit?: () => void }) =>
    createElement('button', { 'data-owner-edit': 'true', onClick: onEdit }, 'edit-climbs'),
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
  commentsMock.calls = [];
  commentsMock.totalCount = 0;
  commentSheetProps.current = null;
  detailViewProps.current = null;
  routerNavigate.mockClear();
  snapToIndex.mockClear();
  authMock.isAuthenticated = true;
  authMock.accessCapabilities = { useAccountFeatures: true, useLocalPlaylists: false };
  playlistsAdapterMock.localLibrary = undefined;
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
  it('loads local metadata without HTTP when local mode retains an account token', async () => {
    const localPlaylist = makePlaylist({ name: 'Local projects' });
    const get = vi.fn(async () => localPlaylist);
    authMock.accessCapabilities = { useAccountFeatures: false, useLocalPlaylists: true };
    playlistsAdapterMock.localLibrary = { get };

    const { container } = renderDetail();

    await waitFor(() => expect(container.querySelector('[data-hero-name="Local projects"]')).not.toBeNull());
    expect(get).toHaveBeenCalledWith('p-1');
    expect(container.querySelector('[data-menu-pin="true"]')).toBeNull();
    expect(container.querySelector('[data-allow-public="false"]')).not.toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });

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
    authMock.accessCapabilities = { useAccountFeatures: false, useLocalPlaylists: false };

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

// #3966. Every overflow-menu row used to defer its work to the menu's `onClose`,
// which the sheet coordinator deliberately suppresses on a controlled
// `visible: true -> false` (see the 'a coordinator-driven dismiss does NOT fire
// onClose (selfDismissRef gate)' test in sheet-presentation-provider.test.tsx).
// These tests fire each row WITHOUT calling `onClose` — the exact sequence a
// real tap produces — so a row that goes back to deferring fails here.
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

  it('does not enter edit mode when the menu is only swiped away', async () => {
    const { container } = await renderOwnerDetail();

    fireEvent.click(container.querySelector('[data-menu-close="true"]') as HTMLButtonElement);

    await waitFor(() => expect(container.querySelector('[data-detail-view="true"]')).not.toBeNull());
    expect(container.querySelector('[data-detail-view="true"]')?.getAttribute('data-edit-mode')).toBe('false');
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
    expect(detailViewProps.current?.emptyAction).toBeNull();
  });
});
