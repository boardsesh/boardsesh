import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render as rtlRender, screen, fireEvent, type RenderOptions } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { APP_URL } from '@/app/lib/app-origin';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import PlaylistDetailContent from '../playlist-detail-content';

/**
 * The oracle for the activation replacement. Lighting a playlist on the wall
 * left for the app; what stays behind is one cross-origin CTA, the climb list,
 * and the discussion.
 */

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockPlaylist: Playlist = {
  uuid: 'playlist-uuid-1',
  name: 'Warm-up circuit',
  climbCount: 12,
  followerCount: 3,
  boardType: 'kilter',
  layoutId: 1,
  color: '#FF6600',
  isPublic: true,
  isFollowedByMe: false,
  isPinnedByMe: false,
  userRole: 'owner',
} as Playlist;

const mockExecuteGraphQL = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  executeGraphQL: (...args: unknown[]) => mockExecuteGraphQL(...args),
  createGraphQLHttpClient: () => ({ request: vi.fn().mockResolvedValue({}) }),
}));

let mockAllClimbs: unknown[] = [];
vi.mock('@boardsesh/playlists-react', () => ({
  usePlaylistClimbs: () => ({
    query: {
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetching: false,
      isFetchingNextPage: false,
      isLoading: false,
    },
    allClimbs: mockAllClimbs,
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false }),
}));

vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: () => ({ boards: [], isLoading: false }),
}));

const mockMultiboardProps = vi.fn();
vi.mock('../../../components/climb-list/multiboard-climb-list', () => ({
  default: (props: Record<string, unknown>) => {
    mockMultiboardProps(props);
    return <div data-testid="multiboard-climb-list" />;
  },
}));

vi.mock('@/app/components/social/comment-section', () => ({
  default: () => <div data-testid="comment-section" />,
}));

vi.mock('@/app/components/library/playlist-edit-drawer', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="edit-drawer" /> : null),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

// `prefetch` is load-bearing here: BackButton calls it in an effect.
vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/app/lib/recent-playlists-db', () => ({
  recordPlaylistOpen: () => Promise.resolve(),
}));

vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));

vi.mock('@/app/components/ui/page-container.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));
vi.mock('@/app/components/playlists/playlist-preview-square.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

function render(ui: React.ReactElement, options?: RenderOptions) {
  const queryClient = createTestQueryClient();
  return rtlRender(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    ...options,
  });
}

function renderDetail(playlist: Playlist = mockPlaylist) {
  return render(<PlaylistDetailContent playlistUuid={playlist.uuid} initialPlaylist={playlist} initialMyBoards={[]} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAllClimbs = [];
  mockExecuteGraphQL.mockResolvedValue({ playlist: mockPlaylist });
});

describe('PlaylistDetailContent app hand-off', () => {
  it('renders exactly one link, pointed at the playlist on the app origin', () => {
    renderDetail();

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(`${APP_URL}/discover/playlist-uuid-1`);
    expect(links[0].textContent).toContain(tFromCatalog('playlists', 'detail.openInApp'));
  });

  it('links out for a private playlist too — the app resolves access, not this page', () => {
    renderDetail({ ...mockPlaylist, isPublic: false });

    expect(screen.getByRole('link').getAttribute('href')).toBe(`${APP_URL}/discover/playlist-uuid-1`);
  });
});

describe('PlaylistDetailContent owner menu', () => {
  it('offers Edit and Delete but no Generate item', () => {
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'detail.actions') }));

    expect(screen.getByText(tFromCatalog('playlists', 'detail.menu.edit'))).toBeTruthy();
    expect(screen.getByText(tFromCatalog('playlists', 'detail.menu.delete'))).toBeTruthy();
    expect(screen.queryByText(/generate/i)).toBeNull();
  });
});

describe('PlaylistDetailContent surviving surfaces', () => {
  it('still mounts the discussion on a public playlist', () => {
    renderDetail();
    expect(screen.getByTestId('comment-section')).toBeTruthy();
  });

  it('passes no climb-activation props to the climb list', () => {
    mockAllClimbs = [{ uuid: 'climb-1', name: 'Test climb', angle: 40, boardType: 'kilter' }];
    renderDetail();

    const props = mockMultiboardProps.mock.calls[0]?.[0] ?? {};
    expect(props).not.toHaveProperty('onClimbSelect');
    expect(props).not.toHaveProperty('selectedClimbUuid');
    expect(screen.getByTestId('multiboard-climb-list')).toBeTruthy();
  });
});
