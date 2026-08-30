import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
}));

// `page.tsx` uses `getServerTranslation` which imports `server-only`. Stub the i18n
// helper so the test can import the page without crashing on the server-only guard.
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const flat = Object.entries(options)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',');
      return `${key}(${flat})`;
    },
    locale: 'en-US',
  })),
}));

type ResolvedBoard = {
  slug: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  isPublic: boolean;
  isUnlisted: boolean;
};

const resolveBoardBySlug = vi.fn<(slug: string) => Promise<ResolvedBoard | null>>(async () => ({
  slug: 'my-board',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  isPublic: true,
  isUnlisted: false,
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug,
  boardToRouteParams: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    angle: 40,
  })),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 144,
    edge_bottom: 0,
    edge_top: 180,
    boardWidth: 1080,
    boardHeight: 1350,
  })),
}));

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimbStatsForAllAngles: vi.fn(async () => []),
  getClimb: vi.fn(async () => ({
    name: 'Test Climb',
    difficulty: 'V5',
    setter_username: 'setter',
    quality_average: 4,
    ascensionist_count: 12,
    frames: 'p1r12,p2r13',
  })),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({
  scheduleOgImageWarming: vi.fn(),
}));

vi.mock('@/app/lib/url-utils', () => ({
  extractUuidFromSlug: vi.fn((value: string) => value),
  // A1: the page now builds its canonical with the config-tuple builder rather
  // than interpolating a `/b/…` literal.
  buildCanonicalClimbViewUrl: vi.fn(
    (_boardDetails: unknown, angle: number, climbUuid: string) =>
      `/kilter/kilter-board-original/12x12/bolt-ons/${angle}/view/${climbUuid}`,
  ),
}));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb?board_name=kilter&variant=og&format=jpeg'),
  buildOverlayPreloadUrls: vi.fn((_bd: unknown, frames: string | null | undefined) =>
    frames ? ['/api/internal/board-render'] : [],
  ),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render?board_name=kilter&variant=overlay'),
}));

// Stubs for the page body's imports — generateMetadata never uses them, but
// importing the page module pulls them in.
vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => []),
  getFrontDoorBetaLinks: vi.fn(async () => []),
}));
vi.mock('@/app/components/climb-front-door/climb-front-door', () => ({
  default: () => null,
}));

const pageModule = await import('../page');

function getOpenGraphImageUrl(image: string | URL | { url: string | URL } | undefined) {
  if (!image) {
    return undefined;
  }

  if (typeof image === 'string') {
    return image;
  }

  if (image instanceof URL) {
    return image.toString();
  }

  return typeof image.url === 'string' ? image.url : image.url.toString();
}

describe('board slug climb metadata', () => {
  it('uses the absolute backend OG image URL for social images', async () => {
    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({
        board_slug: 'my-board',
        angle: '40',
        climb_uuid: 'test-climb',
      }),
    });

    const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;
    const imageUrl = getOpenGraphImageUrl(image);

    // The absolute backend URL must pass through createPageMetadata/normalizePath
    // untouched — no leading slash mangling it into `/https://…`.
    expect(imageUrl).toBe('https://ws.boardsesh.com/og/climb?board_name=kilter&variant=og&format=jpeg');
    expect(imageUrl).not.toContain('/api/og/climb');
  });

  it('emits explicit width and height on the OG image', async () => {
    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({
        board_slug: 'my-board',
        angle: '40',
        climb_uuid: 'test-climb',
      }),
    });

    const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : metadata.openGraph?.images;
    expect(image).toMatchObject({ width: 1200, height: 630 });
  });

  it('marks the fallback metadata as noindex when board lookup fails', async () => {
    resolveBoardBySlug.mockResolvedValueOnce(null);

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({
        board_slug: 'unknown',
        angle: '40',
        climb_uuid: 'test-climb',
      }),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  // An anonymous request never gets here: `boardBySlug` answers null for a
  // private board, which the "board lookup fails" case above covers. A private
  // board only resolves for its owner or the staff of its linked gym, and their
  // render must still stay out of the index.
  it('noindexes a private board that resolved for its owner, without hiding the climb from them', async () => {
    resolveBoardBySlug.mockResolvedValueOnce({
      slug: 'my-board',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      isPublic: false,
      isUnlisted: false,
    });

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({
        board_slug: 'my-board',
        angle: '40',
        climb_uuid: 'test-climb',
      }),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.description).toContain('Test Climb');
    // No canonical at all on a noindex page — see the A1 case below.
    expect(metadata.alternates).toBeUndefined();
  });

  it('keeps an unlisted (but public) board readable, but noindexes the climb page', async () => {
    resolveBoardBySlug.mockResolvedValueOnce({
      slug: 'my-board',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      isPublic: true,
      isUnlisted: true,
    });

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({
        board_slug: 'my-board',
        angle: '40',
        climb_uuid: 'test-climb',
      }),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.description).toContain('Test Climb');
    expect(metadata.alternates).toBeUndefined();
  });

  it('canonicalises a public, listed board INTO the config-tuple tree (A1)', async () => {
    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({
        board_slug: 'my-board',
        angle: '40',
        climb_uuid: 'test-climb',
      }),
    });

    const canonical = metadata.alternates?.canonical;
    const canonicalUrl =
      typeof canonical === 'object' && canonical && 'url' in canonical ? String(canonical.url) : String(canonical);
    expect(canonicalUrl).not.toContain('/b/my-board');
    expect(canonicalUrl).toContain('/40/view/test-climb');
    expect(metadata.robots).toBeUndefined();
  });
});
