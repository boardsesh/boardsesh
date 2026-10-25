// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { UsePlaylistActivationOptions } from '../../../../src/lib/playlists/use-playlist-activation';
import type { SetterSelection } from '../../../../src/lib/playlists/setter-sort-model';
import DiscoverSetterPlaylist from '../setter/[username]';

// A For You setter card opens this route inside Discover (#6668). It is the same
// screen as the Climbs tab's setter route; what differs is the tab it returns to.
const board = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '1,2', angle: 40 };
const climb = { uuid: 'setter-climb', name: 'First problem' } as Climb;
const mocks = vi.hoisted(() => ({
  board: null as typeof board | null,
  push: vi.fn(),
  search: vi.fn(),
  count: vi.fn(),
  activate: vi.fn(),
  activation: null as UsePlaylistActivationOptions | null,
  detail: null as { hero: { name: string; climbCount: number } } | null,
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ username: 'accountless setter' }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
  PlaylistFilterBar: () => null,
  PlaylistStateHeader: () => <span data-testid="native-state-header" />,
  PlaylistDetailView: (props: {
    hero: { name: string; climbCount: number };
    climbs: Climb[];
    actions: () => ReactNode;
    onActivateClimb: (climb: Climb) => void;
  }) => {
    mocks.detail = props;
    return (
      <section>
        <h1>{props.hero.name}</h1>
        {props.actions()}
        <button onClick={() => props.onActivateClimb(props.climbs[0])}>Activate climb</button>
      </section>
    );
  },
}));
vi.mock('../../../../src/lib/playlists/use-playlist-render-board', () => ({
  usePlaylistRenderBoard: () => ({ renderBoard: mocks.board }),
}));
vi.mock('../../../../src/providers/queue-provider', () => ({ useIsSharedSession: () => false }));
vi.mock('../../../../src/lib/playlists/use-playlist-activation', () => ({
  usePlaylistActivation: (options: UsePlaylistActivationOptions) => {
    mocks.activation = options;
    return { activate: mocks.activate, addToQueue: { append: vi.fn(), isAppending: false } };
  },
}));
vi.mock('../../../../src/lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: mocks.search,
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({ useSearchClimbsCount: mocks.count }));
vi.mock('../../../../src/lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));
// The page's sort and filters (#6651), reduced to the plain view. Its own
// behaviour is covered by the Climbs setter test and use-climb-filter-session.
const filterSession = vi.hoisted(() => ({ options: null as null | Record<string, unknown> }));
vi.mock('../../../../src/hooks/use-climb-filter-session', async () => {
  const { useMemo } = await import('react');
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
      const actions = useMemo(() => ({ openFilters: vi.fn(), clearFilters: vi.fn() }), []);
      const state = useMemo(
        () => ({
          querySelection: plainSelection,
          activeFilterCount: 0,
          sortDescription: 'creation.desc',
          chipRowProps: {},
          tokens: [],
          gradeRail: null,
          sheetProps: null,
        }),
        [],
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
vi.mock('../../../../src/hooks/use-personal-grades', () => ({ usePersonalGradesActive: () => false }));
vi.mock('../../../../src/lib/graphql/hooks/search-grade-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/graphql/hooks/search-grade-source')>()),
  useSearchGradeSourceActive: () => false,
}));
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
// The player's list count reads the query cache, and these screens render
// without a QueryClientProvider. No test here reads the count.
vi.mock('../../../../src/lib/graphql/hooks/search-climbs-count-query', () => {
  const countNothing = async () => 0;
  return { useFetchCachedSearchClimbsCount: () => countNothing };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.board = board;
  mocks.detail = null;
  mocks.activation = null;
  mocks.search.mockReturnValue({
    data: { pages: [{ climbs: [climb] }] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    isError: false,
  });
  mocks.count.mockReturnValue({ data: 8 });
});

describe('Discover setter route', () => {
  it("shows the setter's climbs and plays them like the Climbs tab's setter page", () => {
    const screen = render(<DiscoverSetterPlaylist />);
    expect(mocks.detail).toMatchObject({ hero: { name: 'accountless setter', climbCount: 8 } });
    expect(screen.getByText('follow:accountless setter')).not.toBeNull();
    expect(mocks.search.mock.calls[0]?.slice(0, 2)).toEqual([
      expect.objectContaining({ setter: ['accountless setter'] }),
      true,
    ]);
    expect(mocks.activation).toMatchObject({ allClimbs: [climb], honorPlaylistLoadSetting: true });
    fireEvent.click(screen.getByRole('button', { name: 'Activate climb' }));
    expect(mocks.activate).toHaveBeenCalledWith(climb);
  });

  // A filter picker pushed into the Climbs tab would strand Discover's Back
  // (#6572). The setter page hides its Setters row, so it offers no setter list.
  it("pushes the filter sheet's pickers into Discover", () => {
    render(<DiscoverSetterPlaylist />);
    expect(filterSession.options?.pickers).toEqual({ stack: 'discover', heatmap: false, setterList: null });
  });

  it('comes back to this Discover page after choosing a board', () => {
    mocks.board = null;
    const screen = render(<DiscoverSetterPlaylist />);
    fireEvent.click(screen.getByRole('button', { name: 'authors.chooseBoard' }));
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/boards',
      params: { returnTo: '/(tabs)/discover/setter/accountless%20setter' },
    });
  });
});
