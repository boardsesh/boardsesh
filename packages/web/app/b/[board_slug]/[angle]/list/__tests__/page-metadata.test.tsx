import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const flat = Object.entries(options)
        .map(([name, option]) => `${name}=${String(option)}`)
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

function board(overrides: Partial<ResolvedBoard> = {}): ResolvedBoard {
  return {
    slug: 'my-board',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
    isPublic: true,
    isUnlisted: false,
    ...overrides,
  };
}

const resolveBoardBySlug = vi.fn<(slug: string) => Promise<ResolvedBoard | null>>();

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
  getBoardDetailsForBoard: vi.fn(() => ({ board_name: 'kilter', layout_id: 1, size_id: 7, set_ids: [1, 20] })),
}));

vi.mock('@/app/lib/data/list-page-data.server', () => ({
  fetchFrontDoorListPage: vi.fn(async () => ({
    boardDetails: { board_name: 'kilter', layout_id: 1, size_id: 7, set_ids: [1, 20] },
    climbs: [],
    hasMore: false,
    preloadUrl: null,
  })),
}));

vi.mock('@/app/components/climb-front-door/static-list-front-door', () => ({
  default: () => null,
}));

const pageModule = await import('../page');

// Every test states the board it wants. A shared `mockResolvedValueOnce` queue
// made each outcome depend on how many times the previous test happened to call
// the resolver, which is what made this file flake.
beforeEach(() => {
  resolveBoardBySlug.mockReset();
  resolveBoardBySlug.mockResolvedValue(board());
});

function generateMetadata(searchParams: Record<string, string> = {}) {
  return pageModule.generateMetadata({
    params: Promise.resolve({ board_slug: 'my-board', angle: '40' }),
    searchParams: Promise.resolve(searchParams as never),
  });
}

function canonicalOf(metadata: Awaited<ReturnType<typeof generateMetadata>>) {
  const canonical = metadata.alternates?.canonical;
  return typeof canonical === 'object' && canonical && 'url' in canonical ? String(canonical.url) : String(canonical);
}

describe('board slug list metadata', () => {
  it('canonicalises the unfiltered list INTO the config-tuple tree (A1), with no robots override', async () => {
    const metadata = await generateMetadata();

    expect(metadata.robots).toBeUndefined();
    // A1: `/b/{slug}` names a board a user owns, not a climb config. Most
    // configs have no `/b` URL and popular ones have many, so the config-tuple
    // tree is the consolidation target.
    expect(canonicalOf(metadata)).not.toContain('/b/my-board');
    expect(canonicalOf(metadata)).toContain('/kilter/');
    expect(canonicalOf(metadata)).toContain('/40/list');
  });

  it('keeps pagination-only requests indexable, carrying the page into the cross-tree canonical', async () => {
    const metadata = await generateMetadata({ page: '2' });

    expect(metadata.robots).toBeUndefined();
    expect(canonicalOf(metadata)).toContain('/40/list?page=2');
  });

  it('noindexes past the last indexable page and emits no canonical to leak it onto the twin', async () => {
    const metadata = await generateMetadata({ page: '11' });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });

  it('noindexes filtered list requests and emits no canonical at all', async () => {
    const metadata = await generateMetadata({ minGrade: '20' });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    // No `alternates` on a noindex page: a canonical pointing from a noindex
    // URL at the indexable config-tuple twin is a conflicting signal Google can
    // resolve by propagating the noindex to the target.
    expect(metadata.alternates).toBeUndefined();
  });

  it('noindexes an unlisted board even with no filter params, but keeps it readable and canonical-free', async () => {
    resolveBoardBySlug.mockResolvedValue(board({ isUnlisted: true }));

    const metadata = await generateMetadata();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });

  it('noindexes a private board however it resolved', async () => {
    resolveBoardBySlug.mockResolvedValue(board({ isPublic: false }));

    const metadata = await generateMetadata();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });

  it('falls back to generic metadata for an unresolvable slug — no name or canonical leak', async () => {
    // `boardBySlug` answers null for a slug that does not exist, and will also
    // answer null for a private board once #4087 masks it.
    resolveBoardBySlug.mockResolvedValue(null);

    const metadata = await generateMetadata();

    expect(metadata.alternates?.canonical).toBeUndefined();
    expect(JSON.stringify(metadata.title)).not.toContain('my-board');
  });
});

describe('board slug list page — unresolvable board', () => {
  it('404s instead of rendering the list when the slug does not resolve', async () => {
    const { notFound } = await import('next/navigation');
    vi.mocked(notFound).mockClear();
    resolveBoardBySlug.mockResolvedValue(null);

    await pageModule.default({
      params: Promise.resolve({ board_slug: 'my-board', angle: '40' }),
      searchParams: Promise.resolve({} as never),
    });

    expect(notFound).toHaveBeenCalled();
  });
});
