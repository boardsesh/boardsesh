// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import type { SmartListSelection } from '../../../../../src/lib/playlists/smart-list-view';

// Parity guard for the smart-playlist detail screen: it must opt into whole-queue
// replacement (replaceQueueOnActivate) and thread the queue-replace sheet through,
// exactly like the regular playlist detail screen. The hook + sheet themselves are
// unit-tested elsewhere; here we only assert the wiring.
type CapturedOptions = {
  sourceId: string;
  replaceQueueOnActivate?: boolean;
  previewOnly?: boolean;
  fetchPage: (args: {
    page: number;
    pageSize: number;
    board: { boardName: string };
    signal: AbortSignal;
  }) => Promise<{ climbs: Climb[]; hasMore: boolean }>;
};

/** What the mocked smart-list query answers for one view (undefined = the list's own order). */
type TestSmartPage = {
  climbs: Climb[];
  totalCount: number;
  unfilteredCount: number | null;
  climbCount?: number;
  /** The previous view's rows standing in while this view loads. */
  placeholder?: boolean;
  error?: boolean;
  /** With `error`: a failed refetch that kept the rows it had. */
  keptRows?: boolean;
};

const smartMocks = vi.hoisted(() => ({
  activationOptions: null as CapturedOptions | null,
  queryOptions: null as Record<string, unknown> | null,
  activeBoard: { uuid: 'spray-liz', boardType: 'spray', sizeId: 17, angle: 40 } as Record<string, unknown> | null,
  /** Overrides the query's answer per view; null answers every view with `allClimbs`. */
  pageFor: null as null | ((view: PlaylistClimbViewInput | undefined) => TestSmartPage),
  refetch: vi.fn(),
  request: vi.fn(),
  activate: vi.fn<(climb: Climb) => Promise<void>>(),
  appendToQueue: vi.fn(),
  allClimbs: [{ uuid: 'c-1', name: 'Boulder' }] as unknown as Climb[],
}));

const routeMock = vi.hoisted(() => ({ params: { type: 'liked' } as { type: string; source?: string } }));
const trackMock = vi.hoisted(() => vi.fn());
const presetMock = vi.hoisted(() => ({ known: true, type: 'LIKED_CLIMBS' as string }));

vi.mock('expo-router', () => ({ useLocalSearchParams: () => routeMock.params }));
vi.mock('../../../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/playlists-react', async (importOriginal) => ({
  // The real key rule: the settled view key carries the board through it.
  smartPlaylistGeometryKey: (await importOriginal<typeof import('@boardsesh/playlists-react')>())
    .smartPlaylistGeometryKey,
  useSmartPlaylist: (options: Record<string, unknown>) => {
    smartMocks.queryOptions = options;
    const view = options.view as PlaylistClimbViewInput | undefined;
    const page: TestSmartPage = smartMocks.pageFor?.(view) ?? {
      climbs: smartMocks.allClimbs,
      totalCount: smartMocks.allClimbs.length,
      unfilteredCount: null,
    };
    return {
      query: {
        isLoading: false,
        isSuccess: !page.error,
        isError: !!page.error,
        isPlaceholderData: !!page.placeholder,
        isFetchingNextPage: false,
        hasNextPage: false,
        fetchNextPage: vi.fn(),
        refetch: smartMocks.refetch,
        data:
          page.error && !page.keptRows
            ? undefined
            : { pages: [{ totalCount: page.totalCount, unfilteredCount: page.unfilteredCount, climbs: page.climbs }] },
      },
      allClimbs: page.error && !page.keptRows ? [] : page.climbs,
      meta:
        page.error && !page.keptRows
          ? undefined
          : { climbCount: page.climbCount ?? page.totalCount, userName: 'Tester' },
    };
  },
}));

// The filter session, reduced to a selection a test can set. Its own behaviour
// is covered by use-climb-filter-session.test.
const filterSession = vi.hoisted(() => ({
  initialSelection: null as SmartListSelection | null,
  setSelection: null as null | ((selection: SmartListSelection) => void),
  options: null as null | Record<string, unknown>,
  clearFilters: vi.fn(),
  openFilters: vi.fn(),
}));
vi.mock('../../../../../src/hooks/use-climb-filter-session', async () => {
  const { useMemo, useState } = await import('react');
  const { PLAYLIST_FILTER_DEFAULTS } = await import('../../../../../src/lib/playlists/playlist-view');
  const plainSelection: SmartListSelection = {
    filters: PLAYLIST_FILTER_DEFAULTS,
    boardFilters: {},
    name: '',
    sort: { sortBy: 'position', sortOrder: 'asc' },
    boardFit: false,
  };
  return {
    useClimbFilterSession: (options: Record<string, unknown>) => {
      filterSession.options = options;
      const [selection, setSelection] = useState<SmartListSelection>(filterSession.initialSelection ?? plainSelection);
      filterSession.setSelection = setSelection;
      const actions = useMemo(
        () => ({
          openFilters: filterSession.openFilters,
          clearFilters: filterSession.clearFilters,
          resetToDefault: vi.fn(),
          pauseView: vi.fn(),
          resumeView: vi.fn(),
        }),
        [],
      );
      const state = useMemo(
        () => ({
          querySelection: selection,
          activeFilterCount: 0,
          sortDescription: 'sort',
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
vi.mock('../../../../../src/components/ClimbFilterSheet', () => ({ ClimbFilterSheet: () => null }));
vi.mock('../../../../../src/lib/playlist-pinned-chips-store', () => ({ playlistPinnedChipsStore: {} }));
vi.mock('../../../../../src/lib/playlists/playlist-sort-memory', () => ({
  readListSort: () => ({ sortBy: 'position', sortOrder: 'asc' }),
  writeListSort: vi.fn(),
}));
vi.mock('../../../../../src/lib/last-search-store', () => ({
  boardConfigKey: (board: { boardName: string }) => board.boardName,
}));
vi.mock('../../../../../src/lib/playlists/playlist-climb-render-board', () => ({
  resolvePlaylistClimbRenderBoard: () => null,
}));
vi.mock('../../../../../src/hooks/use-personal-grades', () => ({ usePersonalGradesActive: () => false }));
vi.mock('../../../../../src/lib/graphql/hooks/search-grade-source', () => ({
  useSearchGradeSourceActive: () => false,
}));
vi.mock('../../../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));

vi.mock('@boardsesh/graphql/operations/playlists', () => ({ GET_SMART_PLAYLIST: 'GET_SMART_PLAYLIST' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('../../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../../src/components/ClimbListRowSkeleton', () => ({ ClimbListRowSkeleton: () => null }));

type DetailViewProps = {
  onActivateClimb?: (climb: Climb) => void;
  onAddAllToQueue?: () => void;
  isAddingAllToQueue?: boolean;
  filterBar?: ReactNode;
  filterAction?: { activeCount: number; onPress: () => void } | null;
  emptyMessage?: string;
  emptyState?: { icon: string; title: string; supporting?: string };
  emptyAction?: { label: string; onPress: () => void };
  addToQueueCount?: number;
  scrollResetKey?: string | null;
  hero?: { climbCount: number };
};
const detailViewProps = vi.hoisted(() => ({ current: null as DetailViewProps | null }));
vi.mock('../../../../../src/components/playlist', () => ({
  SKELETON_PLACEHOLDERS: [],
  PlaylistStateHeader: () => null,
  PlaylistFilterBar: () => null,
  PlaylistDetailView: (props: DetailViewProps) => {
    detailViewProps.current = props;
    const { onActivateClimb, onAddAllToQueue, isAddingAllToQueue } = props;
    return createElement(
      'div',
      null,
      createElement('button', {
        'data-activate': 'true',
        onClick: () => onActivateClimb?.({ uuid: 'c-1' } as unknown as Climb),
      }),
      createElement('button', {
        'data-add-all': onAddAllToQueue ? 'true' : 'false',
        'data-appending': String(!!isAddingAllToQueue),
        onClick: onAddAllToQueue,
      }),
    );
  },
}));

vi.mock('../../../../../src/lib/graphql/client', () => ({ getHttpClient: () => ({ request: smartMocks.request }) }));
vi.mock('../../../../../src/lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: (options: CapturedOptions) => {
    smartMocks.activationOptions = options;
    return { activate: smartMocks.activate, addToQueue: { append: smartMocks.appendToQueue, isAppending: false } };
  },
}));
vi.mock('../../../../../src/lib/playlists/use-playlist-render-board', () => ({
  usePlaylistRenderBoard: () => ({ renderBoard: null }),
}));
vi.mock('../../../../../src/lib/climb-types', () => ({ toQueueClimbs: (climbs: unknown) => climbs }));
vi.mock('../../../../../src/lib/smart-playlists', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/lib/smart-playlists')>();
  return {
    ...actual,
    // The real parser: the screen must not send a made-up source to PostHog.
    smartPlaylistByType: () =>
      presetMock.known
        ? {
            type: presetMock.type,
            titleI18nKey: 'library.smart.likedClimbs.title',
            color: '#f00',
            icon: 'favorite',
          }
        : null,
  };
});
vi.mock('../../../../../src/lib/graphql/hooks', () => ({ useProfile: () => ({ data: { id: 'u-1' } }) }));
vi.mock('../../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: smartMocks.activeBoard, isPending: false }),
}));
vi.mock('../../../../../src/lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ isLoading: false }) }));
vi.mock('../../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { tertiaryLabel: 'theme-tertiary-label' } }),
}));
// Whether anyone else is in the session — what decides between replacing the
// crew's queue and simply showing the tapped climb.
const sessionMock = vi.hoisted(() => ({ isShared: false }));
vi.mock('../../../../../src/providers/queue-provider', () => ({
  useIsSharedSession: () => sessionMock.isShared,
}));

import SmartPlaylistDetail from '../[type]';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SmartPlaylistDetail queue replacement wiring', () => {
  it('activates with replaceQueueOnActivate', () => {
    const { container } = render(<SmartPlaylistDetail />);

    expect(smartMocks.activationOptions?.replaceQueueOnActivate).toBe(true);
    expect(smartMocks.activationOptions?.sourceId).toBe('smart:LIKED_CLIMBS:u-1');

    fireEvent.click(container.querySelector('[data-activate]')!);
    expect(smartMocks.activate).toHaveBeenCalledWith({ uuid: 'c-1' });
  });

  it('forwards the bulk add-to-queue handler and its in-flight flag', () => {
    // Smart playlists render no overflow menu at all, so the header row is the
    // ONLY additive bulk affordance they can ever have. If this wiring drops,
    // Liked Climbs / Five Stars / Projects silently lose the feature.
    const { container } = render(<SmartPlaylistDetail />);

    const addAll = container.querySelector('[data-add-all]');
    expect(addAll?.getAttribute('data-add-all')).toBe('true');
    expect(addAll?.getAttribute('data-appending')).toBe('false');

    fireEvent.click(addAll as HTMLButtonElement);
    expect(smartMocks.appendToQueue).toHaveBeenCalledTimes(1);
  });

  // Same rule as the playlist detail screen: with a crew present, a row tap is a
  // look — not a replacement of everyone's queue plus a wall grab.
  it('browses a row tap in a crew instead of replacing everyone’s queue', () => {
    sessionMock.isShared = true;
    render(<SmartPlaylistDetail />);

    expect(smartMocks.activationOptions?.previewOnly).toBe(true);
  });

  it('leaves a solo row tap replacing the queue as before', () => {
    sessionMock.isShared = false;
    render(<SmartPlaylistDetail />);

    expect(smartMocks.activationOptions?.previewOnly).toBe(false);
    expect(smartMocks.activationOptions?.replaceQueueOnActivate).toBe(true);
  });
  it('scopes CPP smart-playlist requests to the active wall and keeps ordinary requests unchanged', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_CPP_URL', 'http://localhost:19870/cpp');
    const { rerender } = render(<SmartPlaylistDetail />);
    expect(smartMocks.queryOptions).toMatchObject({
      boardName: 'spray',
      boardUuid: 'spray-liz',
      sizeId: 17,
      angle: 40,
      pageSize: 10,
    });
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
    rerender(<SmartPlaylistDetail />);
    expect(smartMocks.queryOptions).not.toHaveProperty('boardName');
    expect(smartMocks.queryOptions).not.toHaveProperty('boardUuid');
  });
});

// `$screen` keeps `/discover/smart/[type]` verbatim, so this event is the only
// thing that tells a Liked Climbs open from any other smart list (#6002).
describe('SmartPlaylistDetail open event', () => {
  beforeEach(() => {
    routeMock.params = { type: 'liked' };
    presetMock.known = true;
    sessionMock.isShared = false;
    trackMock.mockClear();
  });

  it.each([
    ['Discover', 'discover', 'discover'],
    ["Home's Playlists card", 'home', 'home'],
    ['a deep link with no source', undefined, 'other'],
    ['a source nobody defined', 'somewhere_else', 'other'],
  ])('names the list and where it was opened from: %s', (_label, source, expected) => {
    routeMock.params = source === undefined ? { type: 'liked' } : { type: 'liked', source };
    render(<SmartPlaylistDetail />);

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Smart Playlist Opened', { type: 'LIKED_CLIMBS', source: expected });
  });

  it('fires once per mount, not once per render', () => {
    const { rerender } = render(<SmartPlaylistDetail />);
    rerender(<SmartPlaylistDetail />);
    rerender(<SmartPlaylistDetail />);

    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a type the app does not know', () => {
    presetMock.known = false;
    render(<SmartPlaylistDetail />);

    expect(trackMock).not.toHaveBeenCalled();
  });
});

const HARDEST_FIRST: SmartListSelection['sort'] = { sortBy: 'difficulty', sortOrder: 'desc' };
/** The settled view key of Hardest first read on the test's Kilter board: the view, then the board. */
const HARDEST_FIRST_ON_KILTER = '{"sortBy":"difficulty","sortOrder":"desc"}|kilter|40|1|10|1,20';

function selectionWith(overrides: Partial<SmartListSelection>): SmartListSelection {
  return {
    filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', boulders: true, routes: true },
    boardFilters: {},
    name: '',
    sort: { sortBy: 'position', sortOrder: 'asc' },
    boardFit: false,
    ...overrides,
  };
}

/** The status the screen hands its filter bar, or null without one. */
function filterBarStatus(): { shown: number; total: number } | null {
  const filterBar = detailViewProps.current?.filterBar;
  if (!isValidElement(filterBar)) return null;
  return (filterBar as ReactElement<{ status: { shown: number; total: number } | null }>).props.status;
}

describe('SmartPlaylistDetail sort and filters (#6651)', () => {
  beforeEach(() => {
    routeMock.params = { type: 'liked' };
    presetMock.known = true;
    presetMock.type = 'LIKED_CLIMBS';
    sessionMock.isShared = false;
    smartMocks.pageFor = null;
    smartMocks.activeBoard = { uuid: 'kb', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
    smartMocks.request.mockReset();
    smartMocks.request.mockResolvedValue({ smartPlaylist: { climbs: [], hasMore: false } });
    filterSession.initialSelection = null;
    detailViewProps.current = null;
  });

  it('gives a recommended list no bar and no filter button, and never sends a view', () => {
    presetMock.type = 'RECOMMENDED_CROWD_FAVORITES';
    filterSession.initialSelection = selectionWith({ sort: HARDEST_FIRST });
    render(<SmartPlaylistDetail />);

    expect(filterSession.options).toMatchObject({ scopeKey: null, disabled: true });
    expect(smartMocks.queryOptions?.view).toBeUndefined();
    expect(detailViewProps.current?.filterBar).toBeNull();
    expect(detailViewProps.current?.filterAction).toBeNull();
  });

  it('hands Liked its own sorts, rows, chips and the Discover pickers for its setters', async () => {
    const { smartListHiddenChips, smartListSheetSections, smartListSortModelFor } =
      await import('../../../../../src/lib/playlists/smart-list-view');
    render(<SmartPlaylistDetail />);

    expect(filterSession.options?.sortModel).toBe(smartListSortModelFor('LIKED_CLIMBS'));
    expect(filterSession.options?.sections).toBe(smartListSheetSections('LIKED_CLIMBS', true));
    expect(filterSession.options?.hiddenChips).toBe(smartListHiddenChips('LIKED_CLIMBS'));
    expect(filterSession.options?.pickers).toEqual({
      stack: 'discover',
      heatmap: false,
      setterList: { kind: 'smart', smartType: 'LIKED_CLIMBS', userId: 'u-1' },
    });
    expect(filterSession.options?.scopeKey).toBe('smart:LIKED_CLIMBS:u-1|kilter|true');
    expect(detailViewProps.current?.filterBar).not.toBeNull();
  });

  it('sends nothing new for the own order, and the view with the active board once sorted', () => {
    render(<SmartPlaylistDetail />);
    expect(smartMocks.queryOptions?.view).toBeUndefined();

    act(() => filterSession.setSelection?.(selectionWith({ sort: HARDEST_FIRST })));
    expect(smartMocks.queryOptions).toMatchObject({
      view: { sortBy: 'difficulty', sortOrder: 'desc' },
      activeBoardInput: {
        activeBoardName: 'kilter',
        activeAngle: 40,
        activeLayoutId: 1,
        activeSizeId: 10,
        activeSetIds: '1,20',
      },
    });
  });

  it('walks the drawer and names the source by the view whose rows are on screen', async () => {
    let loading = true;
    smartMocks.pageFor = (view) =>
      view
        ? { climbs: smartMocks.allClimbs, totalCount: 1, unfilteredCount: null, placeholder: loading }
        : { climbs: smartMocks.allClimbs, totalCount: 1, unfilteredCount: null };
    const { rerender } = render(<SmartPlaylistDetail />);
    expect(smartMocks.activationOptions?.sourceId).toBe('smart:LIKED_CLIMBS:u-1');

    // The new view is still loading: the old rows, and so the old source, stay.
    act(() => filterSession.setSelection?.(selectionWith({ sort: HARDEST_FIRST })));
    expect(smartMocks.activationOptions?.sourceId).toBe('smart:LIKED_CLIMBS:u-1');
    await smartMocks.activationOptions?.fetchPage({
      page: 0,
      pageSize: 20,
      board: { boardName: 'kilter' },
      signal: new AbortController().signal,
    });
    expect(smartMocks.request.mock.calls.at(-1)?.[0].variables.input).toEqual({
      type: 'LIKED_CLIMBS',
      userId: 'u-1',
      boardName: 'kilter',
      page: 0,
      pageSize: 20,
    });

    // Its rows land: the source and the drawer's pages follow.
    loading = false;
    rerender(<SmartPlaylistDetail />);
    expect(smartMocks.activationOptions?.sourceId).toBe(`smart:LIKED_CLIMBS:u-1|${HARDEST_FIRST_ON_KILTER}`);
    expect(detailViewProps.current?.scrollResetKey).toBe(HARDEST_FIRST_ON_KILTER);
    await smartMocks.activationOptions?.fetchPage({
      page: 1,
      pageSize: 20,
      board: { boardName: 'kilter' },
      signal: new AbortController().signal,
    });
    expect(smartMocks.request.mock.calls.at(-1)?.[0].variables.input).toEqual({
      type: 'LIKED_CLIMBS',
      userId: 'u-1',
      boardName: 'kilter',
      page: 1,
      pageSize: 20,
      activeBoardName: 'kilter',
      activeAngle: 40,
      activeLayoutId: 1,
      activeSizeId: 10,
      activeSetIds: '1,20',
      view: { sortBy: 'difficulty', sortOrder: 'desc' },
    });
  });

  it('reads "12 of 40" from the response, and keeps the hero on the whole list', () => {
    filterSession.initialSelection = selectionWith({
      filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', boulders: true, routes: true, minRating: 3 },
    });
    smartMocks.pageFor = () => ({ climbs: smartMocks.allClimbs, totalCount: 12, unfilteredCount: 40, climbCount: 40 });
    render(<SmartPlaylistDetail />);

    expect(filterBarStatus()).toMatchObject({ shown: 12, total: 40 });
    expect(detailViewProps.current?.hero?.climbCount).toBe(40);
  });

  it('words a list filtered to nothing for the filter, over the Liked heart prompt', () => {
    filterSession.initialSelection = selectionWith({ name: 'crimp' });
    smartMocks.pageFor = () => ({ climbs: [], totalCount: 0, unfilteredCount: 40, climbCount: 40 });
    render(<SmartPlaylistDetail />);

    expect(detailViewProps.current?.emptyState).toEqual({ icon: 'filter', title: 'detail.view.empty.noName' });
    expect(detailViewProps.current?.emptyAction?.label).toBe('detail.view.clearFilters');
    detailViewProps.current?.emptyAction?.onPress();
    expect(filterSession.clearFilters).toHaveBeenCalledTimes(1);
  });

  it('keeps the heart prompt for a Liked list with no likes at all', () => {
    smartMocks.pageFor = () => ({ climbs: [], totalCount: 0, unfilteredCount: null });
    render(<SmartPlaylistDetail />);
    expect(detailViewProps.current?.emptyState?.icon).toBe('favorite');
    expect(detailViewProps.current?.filterBar).toBeNull();
  });

  it('says a failed load failed, and retries', () => {
    smartMocks.pageFor = () => ({ climbs: [], totalCount: 0, unfilteredCount: null, error: true });
    render(<SmartPlaylistDetail />);

    expect(detailViewProps.current?.emptyState).toMatchObject({ icon: 'error', title: 'detail.errors.loadTitle' });
    detailViewProps.current?.emptyAction?.onPress();
    expect(smartMocks.refetch).toHaveBeenCalled();
  });

  it('moves the track to the new board under a view, once its rows are up', async () => {
    filterSession.initialSelection = selectionWith({ sort: HARDEST_FIRST });
    const { rerender } = render(<SmartPlaylistDetail />);
    expect(smartMocks.activationOptions?.sourceId).toBe(`smart:LIKED_CLIMBS:u-1|${HARDEST_FIRST_ON_KILTER}`);

    smartMocks.activeBoard = { uuid: 'kb', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 50 };
    rerender(<SmartPlaylistDetail />);
    expect(smartMocks.activationOptions?.sourceId).toBe(
      'smart:LIKED_CLIMBS:u-1|{"sortBy":"difficulty","sortOrder":"desc"}|kilter|50|1|10|1,20',
    );
    await smartMocks.activationOptions?.fetchPage({
      page: 0,
      pageSize: 20,
      board: { boardName: 'kilter' },
      signal: new AbortController().signal,
    });
    expect(smartMocks.request.mock.calls.at(-1)?.[0].variables.input).toMatchObject({ activeAngle: 50 });
  });

  it('settles on rows a failed refetch kept, since they are what is on screen', () => {
    // The sorted view's cache entry failed a refetch but still holds its rows.
    smartMocks.pageFor = (view) => ({
      climbs: smartMocks.allClimbs,
      totalCount: 1,
      unfilteredCount: null,
      ...(view ? { error: true, keptRows: true } : {}),
    });
    render(<SmartPlaylistDetail />);
    act(() => filterSession.setSelection?.(selectionWith({ sort: HARDEST_FIRST })));
    expect(smartMocks.activationOptions?.sourceId).toBe(`smart:LIKED_CLIMBS:u-1|${HARDEST_FIRST_ON_KILTER}`);
  });
});
