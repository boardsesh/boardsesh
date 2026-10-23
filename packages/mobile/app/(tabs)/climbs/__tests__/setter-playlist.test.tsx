// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { UsePlaylistActivationOptions } from '../../../../src/lib/playlists/use-playlist-activation';
import type { SetterSelection } from '../../../../src/lib/playlists/setter-sort-model';
import SetterPlaylist from '../setter/[username]';

const board = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '1,2', angle: 40 };
const climb = { uuid: 'setter-climb', name: 'First problem' } as Climb;
const mocks = vi.hoisted(() => ({
  board: null as typeof board | null,
  shared: false,
  push: vi.fn(),
  search: vi.fn(),
  count: vi.fn(),
  refetch: vi.fn(),
  fetchNext: vi.fn(),
  request: vi.fn(),
  activate: vi.fn(),
  append: vi.fn(),
  isAppending: false,
  activation: null as UsePlaylistActivationOptions | null,
  detail: null as {
    hero: { name: string; climbCount: number; subtitle?: string };
    renderBoard: typeof board;
    onAddAllToQueue?: () => void;
    isAddingAllToQueue?: boolean;
    addToQueueCount?: number;
    filterBar?: ReactNode;
    filterAction?: { activeCount: number; onPress: () => void } | null;
    emptyMessage?: string;
    emptyState?: { icon: string; title: string };
    scrollResetKey?: string | null;
  } | null,
}));

// The filter session, reduced to a selection a test can set. Its own behaviour
// is covered by use-climb-filter-session.test.
const filterSession = vi.hoisted(() => ({
  setSelection: null as null | ((selection: SetterSelection) => void),
  options: null as null | Record<string, unknown>,
  clearFilters: vi.fn(),
}));
vi.mock('../../../../src/hooks/use-climb-filter-session', async () => {
  const { useMemo, useState } = await import('react');
  const { SETTER_FILTER_DEFAULTS } = await import('../../../../src/lib/playlists/setter-playlist-input');
  const plainSelection: SetterSelection = {
    filters: SETTER_FILTER_DEFAULTS,
    boardFilters: {},
    name: '',
    sort: { sortBy: 'creation', sortOrder: 'desc' },
    boardFit: false,
  };
  return {
    useClimbFilterSession: (options: Record<string, unknown>) => {
      filterSession.options = options;
      const [selection, setSelection] = useState<SetterSelection>(plainSelection);
      filterSession.setSelection = setSelection;
      const actions = useMemo(
        () => ({
          openFilters: vi.fn(),
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
          sortDescription: `${selection.sort.sortBy}.${selection.sort.sortOrder}`,
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
vi.mock('../../../../src/lib/playlists/playlist-sort-memory', () => ({
  readListSort: () => ({ sortBy: 'creation', sortOrder: 'desc' }),
  writeListSort: vi.fn(),
}));
vi.mock('../../../../src/lib/last-search-store', () => ({
  boardConfigKey: (config: { boardName: string }) => config.boardName,
}));
vi.mock('../../../../src/lib/playlists/playlist-climb-render-board', () => ({
  resolvePlaylistClimbRenderBoard: () => null,
}));
vi.mock('../../../../src/hooks/use-personal-grades', () => ({ usePersonalGradesActive: () => false }));
vi.mock('../../../../src/lib/graphql/hooks/search-grade-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/graphql/hooks/search-grade-source')>()),
  useSearchGradeSourceActive: () => false,
}));
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));

/** The status the page hands its filter bar, or null without one. */
function filterBarStatus(): { shown: number; total: number } | null {
  const filterBar = mocks.detail?.filterBar;
  if (!isValidElement(filterBar)) return null;
  return (filterBar as ReactElement<{ status: { shown: number; total: number } | null }>).props.status;
}

const HARDEST_FIRST: SetterSelection['sort'] = { sortBy: 'difficulty', sortOrder: 'desc' };
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ username: 'accountless-setter' }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../../../src/theme/tokens', () => ({ spacing: { 3: 12, 4: 16 } }));
vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => <button onClick={onPress}>{title}</button>,
}));
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../../src/components/SetterFollowButton', () => ({
  SetterFollowButton: ({ username }: { username: string }) => <span>follow:{username}</span>,
}));
vi.mock('../../../../src/components/playlist', () => ({
  PlaylistStateHeader: () => <span data-testid="native-state-header" />,
  PlaylistFilterBar: () => null,
  PlaylistDetailView: (props: {
    hero: { name: string; climbCount: number };
    renderBoard: typeof board;
    climbs: Climb[];
    actions: () => ReactNode;
    headerSlot?: ReactNode;
    onActivateClimb: (climb: Climb) => void;
    onAddAllToQueue?: () => void;
    isAddingAllToQueue?: boolean;
  }) => {
    mocks.detail = props;
    return (
      <section>
        <h1>{props.hero.name}</h1>
        {props.actions()}
        {props.headerSlot}
        <button onClick={() => props.onActivateClimb(props.climbs[0])}>Activate climb</button>
      </section>
    );
  },
}));
vi.mock('../../../../src/lib/playlists/use-playlist-render-board', () => ({
  usePlaylistRenderBoard: () => ({ renderBoard: mocks.board }),
}));
vi.mock('../../../../src/providers/queue-provider', () => ({ useIsSharedSession: () => mocks.shared }));
vi.mock('../../../../src/lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: (options: UsePlaylistActivationOptions) => {
    mocks.activation = options;
    return {
      activate: mocks.activate,
      addToQueue: { append: mocks.append, isAppending: mocks.isAppending },
    };
  },
}));
vi.mock('../../../../src/lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: mocks.search,
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({ useSearchClimbsCount: mocks.count }));
vi.mock('../../../../src/lib/graphql/offline-request', () => ({ offlineAwareRequest: mocks.request }));
// The player's list count reads the query cache, and these screens render
// without a QueryClientProvider. No test here reads the count.
const countRequests = vi.hoisted(() => [] as ClimbSearchInput[]);
vi.mock('../../../../src/lib/graphql/hooks/search-climbs-count-query', () => {
  const countAndRecord = async (input: ClimbSearchInput) => {
    countRequests.push(input);
    return 0;
  };
  return { useFetchCachedSearchClimbsCount: () => countAndRecord };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.board = board;
  mocks.shared = false;
  mocks.detail = null;
  mocks.activation = null;
  mocks.search.mockReturnValue({
    data: { pages: [{ climbs: [climb] }] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: true,
    fetchNextPage: mocks.fetchNext,
    refetch: mocks.refetch,
    isError: false,
    isSuccess: true,
    isPlaceholderData: false,
  });
  mocks.count.mockReturnValue({ data: 8, isPlaceholderData: false });
  mocks.request.mockResolvedValue({ searchClimbs: { climbs: [climb], hasMore: true } });
});

describe('setter smart playlist route', () => {
  it('disables both searches and offers board selection when no board is active', () => {
    mocks.board = null;
    const screen = render(<SetterPlaylist />);
    expect(mocks.search).toHaveBeenCalledWith(expect.anything(), false, { keepPreviousResults: true });
    expect(mocks.count).toHaveBeenCalledWith(expect.anything(), false);
    expect(mocks.detail).toBeNull();
    // The native header (and its system back button) is still there.
    expect(screen.getByTestId('native-state-header')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'authors.chooseBoard' }));
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/climbs/setter/accountless-setter' },
    });
  });

  it.each([false, true])('wires queue replacement and shared-session preview=%s', (shared) => {
    mocks.shared = shared;
    const screen = render(<SetterPlaylist />);
    expect(mocks.detail).toMatchObject({ hero: { name: 'accountless-setter', climbCount: 8 }, renderBoard: board });
    expect(mocks.detail).toMatchObject({ onAddAllToQueue: mocks.append, isAddingAllToQueue: false });
    expect(screen.getByText('follow:accountless-setter')).not.toBeNull();
    expect(mocks.activation).toMatchObject({ allClimbs: [climb], previewOnly: shared, replaceQueueOnActivate: true });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ setter: ['accountless-setter'] }), true, {
      keepPreviousResults: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate climb' }));
    expect(mocks.activate).toHaveBeenCalledWith(climb);
    expect(screen.queryByTestId('replace-sheet')).toBeNull();
  });

  it('fetches the activated board and page using only the setter playlist filters', async () => {
    render(<SetterPlaylist />);
    const activatedBoard = { ...board, angle: 50 };
    const result = await mocks.activation!.fetchPage({
      page: 2,
      pageSize: 20,
      board: activatedBoard,
      signal: new AbortController().signal,
    });
    expect(mocks.request).toHaveBeenCalledWith(expect.anything(), {
      input: {
        ...activatedBoard,
        setter: ['accountless-setter'],
        sortBy: 'creation',
        sortOrder: 'desc',
        boulders: true,
        routes: true,
        page: 2,
        pageSize: 20,
      },
    });
    expect(result).toEqual({ climbs: [climb], hasMore: true });
  });

  it('rejects aborted fetches before requesting and after a response arrives', async () => {
    render(<SetterPlaylist />);
    const before = new AbortController();
    before.abort();
    await expect(
      mocks.activation!.fetchPage({ page: 1, pageSize: 20, board, signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.request).not.toHaveBeenCalled();
    const during = new AbortController();
    mocks.request.mockImplementationOnce(async () => {
      during.abort();
      return { searchClimbs: { climbs: [climb], hasMore: false } };
    });
    await expect(
      mocks.activation!.fetchPage({ page: 1, pageSize: 20, board, signal: during.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('offers retry when the climb search fails', () => {
    mocks.search.mockReturnValue({ isError: true, refetch: mocks.refetch });
    const screen = render(<SetterPlaylist />);
    fireEvent.click(screen.getByRole('button', { name: 'authors.retry' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});

describe('setter page sort and filters (#6651)', () => {
  it('names the sort in force under the board line', () => {
    render(<SetterPlaylist />);
    expect(mocks.detail?.hero.subtitle).toBe('authors.playlistSubtitleSort:{"sort":"creation.desc"}');
    act(() => filterSession.setSelection?.({ ...plainSelection(), sort: HARDEST_FIRST }));
    expect(mocks.detail?.hero.subtitle).toBe('authors.playlistSubtitleSort:{"sort":"difficulty.desc"}');
  });

  it('opens its sheet without Setters or "Fits my board", and with Climbs-stack pickers', () => {
    render(<SetterPlaylist />);
    expect(filterSession.options).toMatchObject({
      scopeKey: 'setter:accountless-setter|kilter|true',
      boardFitAvailable: false,
      pickers: { stack: 'climbs', heatmap: false },
      sections: expect.objectContaining({ setters: false, following: false }),
    });
    expect(filterSession.options?.sections).not.toHaveProperty('holds');
  });

  it('walks the drawer under the view whose rows are on screen', async () => {
    render(<SetterPlaylist />);
    act(() => filterSession.setSelection?.({ ...plainSelection(), sort: HARDEST_FIRST }));
    expect(mocks.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ setter: ['accountless-setter'], sortBy: 'difficulty', sortOrder: 'desc' }),
      true,
      { keepPreviousResults: true },
    );
    expect(mocks.activation?.sourceId).toMatch(/^setter:accountless-setter:.*\|/);

    await mocks.activation!.fetchPage({ page: 1, pageSize: 20, board, signal: new AbortController().signal });
    const sentInput = (mocks.request.mock.calls.at(-1) as unknown[] | undefined)?.[1] as { input: ClimbSearchInput };
    expect(sentInput.input).toMatchObject({
      ...board,
      setter: ['accountless-setter'],
      sortBy: 'difficulty',
      sortOrder: 'desc',
      page: 1,
      pageSize: 20,
    });
  });

  // The player's "4 of 30" counts the list the drawer walks: the view's filters,
  // at the default sort (a sort hides nothing). Counting the plain setter list
  // would print the unfiltered total under a filtered track (#6664).
  it("counts the player's list with the view's filters, at the default sort", async () => {
    render(<SetterPlaylist />);
    act(() => filterSession.setSelection?.({ ...plainSelection(), name: 'crimp', sort: HARDEST_FIRST }));

    await mocks.activation!.fetchTotal!({ board, signal: new AbortController().signal });
    expect(countRequests.at(-1)).toMatchObject({
      setter: ['accountless-setter'],
      name: 'crimp',
      sortBy: 'creation',
      sortOrder: 'desc',
    });
  });

  it("keeps the old rows' order for the drawer while a new view loads", async () => {
    render(<SetterPlaylist />);
    mocks.search.mockReturnValue({
      data: { pages: [{ climbs: [climb] }] },
      isLoading: false,
      hasNextPage: false,
      fetchNextPage: mocks.fetchNext,
      refetch: mocks.refetch,
      isError: false,
      isSuccess: true,
      isPlaceholderData: true,
    });
    act(() => filterSession.setSelection?.({ ...plainSelection(), sort: HARDEST_FIRST }));
    expect(mocks.activation?.sourceId).not.toContain('|');
    await mocks.activation!.fetchPage({ page: 0, pageSize: 20, board, signal: new AbortController().signal });
    const sentInput = (mocks.request.mock.calls.at(-1) as unknown[] | undefined)?.[1] as { input: ClimbSearchInput };
    expect(sentInput.input).toMatchObject({ sortBy: 'creation', sortOrder: 'desc' });
  });

  it("counts the sheet, the status line and Add to queue from the view's own count", () => {
    mocks.count.mockImplementation((input: ClimbSearchInput) => ({
      data: input.minRating === 3 ? 3 : 8,
      isPlaceholderData: false,
    }));
    mocks.search.mockReturnValue({
      data: { pages: [{ climbs: [climb] }] },
      isLoading: false,
      hasNextPage: true,
      fetchNextPage: mocks.fetchNext,
      refetch: mocks.refetch,
      isError: false,
      isSuccess: true,
      isPlaceholderData: false,
    });
    render(<SetterPlaylist />);
    expect(filterBarStatus()).toBeNull();

    act(() =>
      filterSession.setSelection?.({ ...plainSelection(), filters: { ...plainSelection().filters, minRating: 3 } }),
    );
    expect(filterSession.options?.liveCount).toBe(3);
    expect(filterBarStatus()).toMatchObject({ shown: 3, total: 8 });
    // Every row is on this board, so the count is what the add takes.
    expect(mocks.detail?.addToQueueCount).toBe(3);
    // The hero still counts every climb the setter set here.
    expect(mocks.detail?.hero.climbCount).toBe(8);
  });

  it('keeps "3 of 8" while the next view loads, and asks no new count for a new sort', () => {
    mocks.count.mockImplementation((input: ClimbSearchInput) => ({
      data: input.minRating === 3 ? 3 : 8,
      isPlaceholderData: false,
    }));
    const rowsFor = (placeholder: boolean) => ({
      data: { pages: [{ climbs: [climb] }] },
      isLoading: false,
      hasNextPage: false,
      fetchNextPage: mocks.fetchNext,
      refetch: mocks.refetch,
      isError: false,
      isSuccess: true,
      isPlaceholderData: placeholder,
    });
    mocks.search.mockReturnValue(rowsFor(false));
    render(<SetterPlaylist />);
    const filtered = { ...plainSelection(), filters: { ...plainSelection().filters, minRating: 3 } };
    act(() => filterSession.setSelection?.(filtered));
    expect(filterBarStatus()).toMatchObject({ shown: 3, total: 8 });

    // A new sort: its rows are loading, the old ones (and their count) stay up.
    mocks.search.mockReturnValue(rowsFor(true));
    mocks.count.mockClear();
    act(() => filterSession.setSelection?.({ ...filtered, sort: HARDEST_FIRST }));
    expect(filterBarStatus()).toMatchObject({ shown: 3, total: 8 });
    expect(mocks.detail?.addToQueueCount).toBe(3);
    // The count it asks for is the filters at the page's own order, as before the sort.
    for (const [countInput] of mocks.count.mock.calls as [ClimbSearchInput][]) {
      expect(countInput).toMatchObject({ sortBy: 'creation', sortOrder: 'desc' });
    }
  });

  it('words a page filtered to nothing for the filter', () => {
    mocks.search.mockReturnValue({
      data: { pages: [{ climbs: [] }] },
      isLoading: false,
      hasNextPage: false,
      fetchNextPage: mocks.fetchNext,
      refetch: mocks.refetch,
      isError: false,
      isSuccess: true,
      isPlaceholderData: false,
    });
    render(<SetterPlaylist />);
    act(() => filterSession.setSelection?.({ ...plainSelection(), name: 'crimp' }));
    expect(mocks.detail?.emptyState).toEqual({ icon: 'filter', title: mocks.detail?.emptyMessage });
    expect(mocks.detail?.emptyMessage).toBe('detail.view.empty.noName:{"name":"crimp"}');
  });
});

function plainSelection(): SetterSelection {
  return {
    filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any', boulders: true, routes: true },
    boardFilters: {},
    name: '',
    sort: { sortBy: 'creation', sortOrder: 'desc' },
    boardFit: false,
  };
}
