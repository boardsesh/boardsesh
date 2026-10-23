// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { UsePlaylistActivationOptions } from '../../../../src/lib/playlists/use-playlist-activation';
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
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ setter: ['accountless setter'] }), true);
    expect(mocks.activation).toMatchObject({ allClimbs: [climb], replaceQueueOnActivate: true });
    fireEvent.click(screen.getByRole('button', { name: 'Activate climb' }));
    expect(mocks.activate).toHaveBeenCalledWith(climb);
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
