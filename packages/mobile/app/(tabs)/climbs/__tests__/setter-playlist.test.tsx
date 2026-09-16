// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { UsePlaylistActivationOptions } from '../../../../src/lib/playlists/use-playlist-activation';
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
  activation: null as UsePlaylistActivationOptions | null,
  detail: null as { hero: { name: string; climbCount: number }; renderBoard: typeof board } | null,
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ username: 'accountless-setter' }),
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
  PlaylistBackFab: () => <button>Back</button>,
  PlaylistQueueReplaceSheet: () => <div data-testid="replace-sheet" />,
  PlaylistDetailView: (props: {
    hero: { name: string; climbCount: number };
    renderBoard: typeof board;
    climbs: Climb[];
    actions: () => ReactNode;
    headerSlot?: ReactNode;
    onActivateClimb: (climb: Climb) => void;
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
    return { activate: mocks.activate, queueReplaceSheet: {} };
  },
}));
vi.mock('../../../../src/lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: mocks.search,
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({ useSearchClimbsCount: mocks.count }));
vi.mock('../../../../src/lib/graphql/offline-request', () => ({ offlineAwareRequest: mocks.request }));

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
  });
  mocks.count.mockReturnValue({ data: 8 });
  mocks.request.mockResolvedValue({ searchClimbs: { climbs: [climb], hasMore: true } });
});

describe('setter smart playlist route', () => {
  it('disables both searches and offers board selection when no board is active', () => {
    mocks.board = null;
    const screen = render(<SetterPlaylist />);
    expect(mocks.search).toHaveBeenCalledWith(expect.anything(), false);
    expect(mocks.count).toHaveBeenCalledWith(expect.anything(), false);
    expect(mocks.detail).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'authors.chooseBoard' }));
    expect(mocks.push).toHaveBeenCalledWith('/boards');
  });

  it.each([false, true])('wires queue replacement and shared-session preview=%s', (shared) => {
    mocks.shared = shared;
    const screen = render(<SetterPlaylist />);
    expect(mocks.detail).toMatchObject({ hero: { name: 'accountless-setter', climbCount: 8 }, renderBoard: board });
    expect(screen.getByText('follow:accountless-setter')).not.toBeNull();
    expect(mocks.activation).toMatchObject({ allClimbs: [climb], previewOnly: shared, replaceQueueOnActivate: true });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ setter: ['accountless-setter'] }), true);
    fireEvent.click(screen.getByRole('button', { name: 'Activate climb' }));
    expect(mocks.activate).toHaveBeenCalledWith(climb);
    expect(screen.getByTestId('replace-sheet')).not.toBeNull();
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
