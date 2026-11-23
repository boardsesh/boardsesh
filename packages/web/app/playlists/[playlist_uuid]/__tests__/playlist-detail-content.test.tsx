import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render as rtlRender, screen, fireEvent, waitFor, type RenderOptions } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { APP_URL } from '@/app/lib/app-origin';
import type { Playlist, PlaylistClimbsResult } from '@boardsesh/graphql/operations/playlists';
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

type DetailProps = React.ComponentProps<typeof PlaylistDetailContent>;

function renderDetail(playlist: Playlist = mockPlaylist, props: Partial<DetailProps> = {}) {
  return render(
    <PlaylistDetailContent
      playlistUuid={playlist.uuid}
      locale="en-US"
      initialPlaylist={playlist}
      initialMyBoards={[]}
      {...props}
    />,
  );
}

const firstPage = (climbs: Array<{ uuid: string; boardType?: string }>) =>
  ({
    climbs: climbs.map((climb) => ({ layoutId: 1, frames: 'p1r12', name: climb.uuid, ...climb })),
    totalCount: climbs.length,
    hasMore: false,
  }) as unknown as PlaylistClimbsResult;

const sublineText = (container: HTMLElement) => container.querySelector('h1 + p')?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  mockAllClimbs = [];
  mockExecuteGraphQL.mockResolvedValue({ playlist: mockPlaylist });
});

const handoffOf = (container: HTMLElement) => container.querySelector('[data-cta="handoff"]');

describe('PlaylistDetailContent app hand-off', () => {
  it('renders a playlist hand-off and an attributed fallback for each store', () => {
    const { container } = renderDetail();

    // The phone's store cell holds both store badges in the HTML (CSS shows one
    // per phone), then the hand-off: three anchors, whichever one a screen reader hears.
    expect(container.querySelectorAll('a')).toHaveLength(3);
    const handoff = handoffOf(container);
    expect(handoff?.getAttribute('href')).toBe(`${APP_URL}/discover/playlist-uuid-1`);
    expect(handoff?.textContent).toContain(tFromCatalog('playlists', 'detail.cta.openInBrowserMobile'));
    expect(handoff?.textContent).toContain(tFromCatalog('playlists', 'detail.cta.openInBrowser'));
    const storeHrefs = [...container.querySelectorAll('[data-cta="mobile-install"] a')].map((link) =>
      link.getAttribute('href'),
    );
    expect(storeHrefs).toHaveLength(2);
    expect(storeHrefs[0]).toContain('apps.apple.com');
    expect(storeHrefs[0]).toContain('ct=playlist');
    expect(storeHrefs[1]).toContain('play.google.com');
    expect(storeHrefs[1]).toContain('utm_content%3Dplaylist');
  });

  it('puts the store first on a phone: its official badge, before the hand-off text link', () => {
    const { container } = renderDetail();

    // No filled button: the store link is the badge itself.
    expect(container.querySelectorAll('.MuiButton-contained')).toHaveLength(0);
    const badges = [...container.querySelectorAll('[data-cta="mobile-install"] a[data-store-badge] > img')];
    expect(badges.map((image) => [image.getAttribute('src'), image.getAttribute('alt')])).toEqual([
      ['/images/store-badges/app-store-black-en-US.svg', tFromCatalog('marketing', 'home.hero.ctaInstallIos')],
      ['/images/store-badges/google-play-en-US.svg', tFromCatalog('marketing', 'home.hero.ctaInstallAndroid')],
    ]);
    const mobileInstall = container.querySelector('[data-cta="mobile-install"]');
    const handoff = handoffOf(container);
    expect(mobileInstall && handoff && mobileInstall.compareDocumentPosition(handoff)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(handoff?.classList.contains('MuiButton-text')).toBe(true);
    expect(mobileInstall?.textContent).toContain(tFromCatalog('playlists', 'detail.cta.getAppHelper'));
  });

  it('shows the QR card the server rendered on a public playlist', () => {
    renderDetail(mockPlaylist, { qrCard: <div data-testid="phone-qr-card" /> });

    expect(screen.getByTestId('phone-qr-card')).toBeTruthy();
  });

  it('shows no QR card on a private playlist, even when one was handed in', () => {
    renderDetail({ ...mockPlaylist, isPublic: false }, { qrCard: <div data-testid="phone-qr-card" /> });

    expect(screen.queryByTestId('phone-qr-card')).toBeNull();
  });

  it('drops the QR card when the live playlist turns out private after the server rendered it', async () => {
    mockExecuteGraphQL.mockResolvedValue({ playlist: { ...mockPlaylist, isPublic: false } });
    renderDetail(mockPlaylist, { qrCard: <div data-testid="phone-qr-card" /> });
    expect(screen.getByTestId('phone-qr-card')).toBeTruthy();

    await waitFor(() => expect(screen.queryByTestId('phone-qr-card')).toBeNull());
  });

  it('links out for a private playlist too — the app resolves access, not this page', () => {
    const { container } = renderDetail({ ...mockPlaylist, isPublic: false });

    expect(handoffOf(container)?.getAttribute('href')).toBe(`${APP_URL}/discover/playlist-uuid-1`);
  });
});

describe('PlaylistDetailContent owner menu', () => {
  it('offers Delete but no Edit or Generate item — editing moved to the app', () => {
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'detail.actions') }));

    expect(screen.getByText(tFromCatalog('playlists', 'detail.menu.delete'))).toBeTruthy();
    expect(screen.queryByText(tFromCatalog('playlists', 'detail.menu.edit'))).toBeNull();
    expect(screen.queryByText(/generate/i)).toBeNull();
  });

  it.each([
    ['a signed-in reader', 'viewer'],
    ['a visitor', undefined],
  ])('gives %s no ⋮ button: its only item is the owner’s Delete', async (_who, userRole) => {
    const visitorPlaylist = { ...mockPlaylist, userRole } as Playlist;
    mockExecuteGraphQL.mockResolvedValue({ playlist: visitorPlaylist });
    renderDetail(visitorPlaylist);

    // Let the client refetch settle, so the assertion covers the refreshed state too.
    await waitFor(() => expect(mockExecuteGraphQL).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: tFromCatalog('playlists', 'detail.actions') })).toBeNull();
    // Share stays: anyone can share a public playlist.
    expect(screen.getByRole('button', { name: tFromCatalog('playlists', 'detail.share') })).toBeTruthy();
  });
});

describe('PlaylistDetailContent cover', () => {
  it('draws the first climbs’ art as the cover', () => {
    renderDetail(mockPlaylist, {
      initialClimbs: firstPage([{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }, { uuid: 'd' }]),
    });

    expect(screen.getByTestId('playlist-cover-mosaic')).toBeTruthy();
    expect(screen.getAllByTestId('playlist-cover-cell')).toHaveLength(4);
  });

  it('keeps the icon tile for an empty playlist', () => {
    renderDetail({ ...mockPlaylist, climbCount: 0 }, { initialClimbs: firstPage([]) });

    expect(screen.queryByTestId('playlist-cover-mosaic')).toBeNull();
  });
});

describe('PlaylistDetailContent subline', () => {
  it('names the board, counts the climbs and prints the grade band', () => {
    const { container } = renderDetail(mockPlaylist, { gradeSummary: { p10Difficulty: 10, p90Difficulty: 24 } });

    // Spaces between the parts, so a screen reader and a crawler don't get "playlist12 climbsV0".
    expect(sublineText(container)).toBe('Kilter playlist 12 climbs V0 to V8');
  });

  it('leaves the band out when the playlist has no grade summary', () => {
    const { container } = renderDetail(mockPlaylist, { gradeSummary: null });

    expect(sublineText(container)).toBe('Kilter playlist 12 climbs');
  });

  it('prints one grade, not "V8 to V8", when both ends of the band match', () => {
    const { container } = renderDetail(mockPlaylist, { gradeSummary: { p10Difficulty: 24, p90Difficulty: 25 } });

    expect(sublineText(container)).toBe('Kilter playlist 12 climbs V8');
  });

  it('says "1 climb" for a single climb', () => {
    const { container } = renderDetail({ ...mockPlaylist, climbCount: 1 });

    expect(sublineText(container)).toBe('Kilter playlist 1 climb');
  });

  it('counts the climbs the list shows, not drafts or hidden climbs', () => {
    // `climbCount` is 12 but only 2 climbs are visible: the meta description and share card say 2 too.
    const { container } = renderDetail(mockPlaylist, { initialClimbs: firstPage([{ uuid: 'a' }, { uuid: 'b' }]) });

    expect(sublineText(container)).toBe('Kilter playlist 2 climbs');
  });

  it('calls a spray wall playlist by the translated wall name, not a board brand', () => {
    const { container } = renderDetail({ ...mockPlaylist, boardType: 'spray' });

    expect(sublineText(container)).toBe('Spraywall playlist 12 climbs');
  });

  it('names every board a mixed playlist spans, its own board first', () => {
    const { container } = renderDetail(mockPlaylist, {
      initialClimbs: firstPage([
        { uuid: 'a', boardType: 'tension' },
        { uuid: 'b', boardType: 'kilter' },
      ]),
    });

    expect(sublineText(container)).toMatch(/^Kilter and Tension playlist/);
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

  it('ends a short list at its last row, with no empty band for a tab bar www does not have', () => {
    mockAllClimbs = [{ uuid: 'climb-1', name: 'Test climb', angle: 40, boardType: 'kilter' }];
    renderDetail();

    expect(mockMultiboardProps.mock.calls[0]?.[0]).toMatchObject({ showBottomSpacer: false });
  });
});

describe('PlaylistDetailContent heading outline', () => {
  it('gives the page exactly one h1, and it holds the playlist name', () => {
    // 3,320 sitemapped playlist URLs shipped with no h1 at all — the name was
    // an h2 under nothing. Google reads a page with no top-level heading as a
    // page about nothing.
    const { container } = renderDetail();

    const topLevelHeadings = container.querySelectorAll('h1');
    expect(topLevelHeadings).toHaveLength(1);
    expect(topLevelHeadings[0].textContent).toBe(mockPlaylist.name);
  });
});
