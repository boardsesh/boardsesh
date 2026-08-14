import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render as rtlRender, screen, fireEvent, waitFor, type RenderOptions } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { PlaylistsAdapterTestProvider } from '@/app/test-utils/playlists-adapter-wrapper';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { APP_URL } from '@/app/lib/app-origin';
import LibraryPageContent from '../library-page-content';
import type { Playlist, DiscoverablePlaylist } from '@boardsesh/graphql/operations/playlists';
import type { UserBoard } from '@boardsesh/shared-schema';

/**
 * `/playlists` is a read-only directory now: every playlist is a real anchor,
 * and creating one, filtering by board and building a custom board all left
 * for the app. The previous suite tested nothing but that create/board-picker
 * orchestration, so it could not be adapted — these cases cover what the page
 * does instead, plus the two absences that would mean the teardown regressed.
 *
 * There are deliberately no `vi.mock`s for `queue-control/queue-bridge-context`,
 * `library/*` or `board-scroll/*`: the page no longer imports them, so a mock
 * would be dead code. Their absence is the signal.
 */

function render(ui: React.ReactElement, options?: RenderOptions) {
  const queryClient = createTestQueryClient();
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <PlaylistsAdapterTestProvider>{children}</PlaylistsAdapterTestProvider>
      </QueryClientProvider>
    ),
    ...options,
  });
}

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockSession: { data: { user?: { id: string } } | null; status: 'authenticated' | 'unauthenticated' } = {
  data: { user: { id: 'user-1' } },
  status: 'authenticated',
};
vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}));

const mockOpenAuthModal = vi.fn();
vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: mockOpenAuthModal }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false }),
}));

vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: (_enabled: boolean, _limit?: number, initial?: UserBoard[] | null) => ({
    boards: initial ?? [],
    isLoading: false,
  }),
}));

// Own-playlist pagination is driven from the test so the "Show more" control
// can be exercised without standing up the whole GraphQL hook.
const mockLoadMorePlaylists = vi.fn();
let mockPlaylistsHasMore = false;
let mockPlaylistsLoading = false;
vi.mock('@/app/hooks/use-user-playlists', () => ({
  useUserPlaylists: ({ initialData }: { initialData?: Playlist[] }) => ({
    playlists: initialData ?? [],
    isLoading: mockPlaylistsLoading,
    isLoadingMore: false,
    hasMore: mockPlaylistsHasMore,
    hasError: false,
    loadMore: mockLoadMorePlaylists,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/app/hooks/use-pinned-playlists', () => ({
  usePinnedPlaylists: () => ({ pinned: [], isLoading: false }),
}));

let mockDiscoverLoading = false;
vi.mock('@/app/hooks/use-discover-playlists', () => ({
  useDiscoverPlaylists: ({ initialData }: { initialData?: { popular: DiscoverablePlaylist[] } }) => ({
    popular: initialData?.popular ?? [],
    recent: [],
    isLoading: mockDiscoverLoading,
    isLoadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
  }),
}));

// CSS module proxies
vi.mock('@/app/components/ui/page-container.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));
vi.mock('@/app/components/playlists/playlist-link-card.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));
vi.mock('@/app/components/playlists/playlist-preview-square.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

// The board artwork is irrelevant here — only the anchors the cards emit are.
vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

function makePlaylist(uuid: string, overrides?: Partial<Playlist>): Playlist {
  return {
    uuid,
    name: `Playlist ${uuid}`,
    climbCount: 7,
    boardType: 'kilter',
    layoutId: 1,
    color: '#FF6600',
    ...overrides,
  } as Playlist;
}

function makeDiscoverable(uuid: string, creatorId = 'someone-else'): DiscoverablePlaylist {
  return {
    uuid,
    name: `Discover ${uuid}`,
    climbCount: 3,
    boardType: 'kilter',
    layoutId: 1,
    creatorId,
  } as DiscoverablePlaylist;
}

const NO_DISCOVER = { popular: [], recent: [], popularHasMore: false, recentHasMore: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockPlaylistsHasMore = false;
  mockPlaylistsLoading = false;
  mockDiscoverLoading = false;
  mockSession.data = { user: { id: 'user-1' } };
  mockSession.status = 'authenticated';
});

describe('LibraryPageContent read-only directory', () => {
  it('renders every owned playlist as a real anchor to its detail page', () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{
          playlists: [makePlaylist('aaa'), makePlaylist('bbb'), makePlaylist('ccc')],
          totalCount: 3,
          hasMore: false,
        }}
        initialDiscoverPlaylists={NO_DISCOVER}
      />,
    );

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/playlists/aaa', '/playlists/bbb', '/playlists/ccc']);
  });

  it('prefixes the hrefs with playlistsBasePath on a board route', () => {
    render(
      <LibraryPageContent
        playlistsBasePath="/b/my-kilter/40/playlists"
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [makePlaylist('aaa')], totalCount: 1, hasMore: false }}
        initialDiscoverPlaylists={NO_DISCOVER}
      />,
    );

    expect(screen.getByRole('link').getAttribute('href')).toBe('/b/my-kilter/40/playlists/aaa');
  });

  it("renders the discover section's playlists as anchors too, skipping the viewer's own", () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{
          ...NO_DISCOVER,
          popular: [makeDiscoverable('pub-1'), makeDiscoverable('mine', 'user-1')],
        }}
      />,
    );

    // The empty-owned-playlists state also renders here (its app-handoff CTA
    // is covered by its own test above) — filter down to the playlist-detail
    // anchors this test is actually about.
    const playlistHrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href !== null && href.startsWith('/playlists/'));
    expect(playlistHrefs).toEqual(['/playlists/pub-1']);
  });

  it('shows "Show more" only when another page exists, and calls loadMore', () => {
    mockPlaylistsHasMore = true;
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [makePlaylist('aaa')], totalCount: 40, hasMore: true }}
        initialDiscoverPlaylists={NO_DISCOVER}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'library.showMore') }));
    expect(mockLoadMorePlaylists).toHaveBeenCalledTimes(1);
  });

  it('hides "Show more" when the first page is the whole list', () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [makePlaylist('aaa')], totalCount: 1, hasMore: false }}
        initialDiscoverPlaylists={NO_DISCOVER}
      />,
    );

    expect(screen.queryByRole('button', { name: tFromCatalog('playlists', 'library.showMore') })).toBeNull();
  });

  it('renders the empty state for an authenticated user with no playlists', () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={NO_DISCOVER}
      />,
    );

    expect(screen.getByText(tFromCatalog('playlists', 'library.empty.title'))).toBeTruthy();
  });

  it('gives the empty state an app-handoff CTA, not a dead end', () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={NO_DISCOVER}
      />,
    );

    // Nothing else on the empty state is a link, so this is the CTA.
    const cta = screen.getByRole('link');
    expect(cta.getAttribute('href')).toBe(`${APP_URL}/discover`);
    expect(cta.textContent).toContain(tFromCatalog('playlists', 'library.empty.cta'));
  });

  it('shows a Jump Back In loading placeholder while nothing has arrived yet', () => {
    mockPlaylistsLoading = true;
    render(<LibraryPageContent initialMyBoards={[]} initialPlaylists={null} initialDiscoverPlaylists={NO_DISCOVER} />);

    expect(screen.getByText(tFromCatalog('playlists', 'library.sections.jumpBackIn'))).toBeTruthy();
    // No real cards (anchors) have loaded yet — only skeleton placeholders.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('replaces the Jump Back In skeleton once playlists have loaded', () => {
    mockPlaylistsLoading = false;
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [makePlaylist('aaa')], totalCount: 1, hasMore: false }}
        initialDiscoverPlaylists={NO_DISCOVER}
      />,
    );

    expect(screen.getByRole('link').getAttribute('href')).toBe('/playlists/aaa');
  });

  it('shows a Discover loading placeholder while nothing has arrived yet', () => {
    mockDiscoverLoading = true;
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [makePlaylist('aaa')], totalCount: 1, hasMore: false }}
        initialDiscoverPlaylists={null}
      />,
    );

    expect(screen.getByText(tFromCatalog('playlists', 'library.sections.discover'))).toBeTruthy();
  });

  it('still offers the sign-in banner to signed-out visitors and opens the auth modal', async () => {
    mockSession.data = null;
    mockSession.status = 'unauthenticated';
    render(
      <LibraryPageContent initialMyBoards={null} initialPlaylists={null} initialDiscoverPlaylists={NO_DISCOVER} />,
    );

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'library.signInBanner.cta') }));
    await waitFor(() => expect(mockOpenAuthModal).toHaveBeenCalledTimes(1));
  });

  describe('teardown assertions', () => {
    it('has no create FAB', () => {
      render(
        <LibraryPageContent
          initialMyBoards={[]}
          initialPlaylists={{ playlists: [makePlaylist('aaa')], totalCount: 1, hasMore: false }}
          initialDiscoverPlaylists={NO_DISCOVER}
        />,
      );

      expect(screen.queryByLabelText(tFromCatalog('playlists', 'library.createFab.ariaLabel'))).toBeNull();
    });

    it('renders no board filter strip and no interactive control other than links', () => {
      const { container } = render(
        <LibraryPageContent
          initialMyBoards={[]}
          initialPlaylists={{ playlists: [makePlaylist('aaa')], totalCount: 1, hasMore: false }}
          initialDiscoverPlaylists={NO_DISCOVER}
        />,
      );

      expect(container.querySelector('[data-testid="filter-strip"]')).toBeNull();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  });
});
