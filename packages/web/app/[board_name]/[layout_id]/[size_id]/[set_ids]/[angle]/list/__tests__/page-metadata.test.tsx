import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  permanentRedirect: vi.fn(),
}));

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

vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1, 20],
      angle: 40,
    },
    isNumericFormat: false,
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

const params = Promise.resolve({
  board_name: 'kilter',
  layout_id: 'kilter-original',
  size_id: '12x12',
  set_ids: 'bolt-ons',
  angle: '40',
});

function emptySearchParams() {
  return Promise.resolve({} as never);
}

function canonicalOf(metadata: Awaited<ReturnType<typeof pageModule.generateMetadata>>) {
  const canonical = metadata.alternates?.canonical;
  return typeof canonical === 'object' && canonical && 'url' in canonical ? String(canonical.url) : String(canonical);
}

describe('legacy board list metadata', () => {
  it('claims the self-canonical for an unfiltered request (A1: /b now points here)', async () => {
    const metadata = await pageModule.generateMetadata({ params, searchParams: emptySearchParams() });

    // This used to return a bare `{}`: `/b/{slug}/{angle}/list` was ALSO
    // self-canonicalising, and a second canonical would have widened the split.
    // W-15 flipped `/b` to canonicalise into this tree, so this page is now the
    // one URL for the config and says so.
    expect(canonicalOf(metadata)).toContain('/kilter/kilter-original/12x12/bolt-ons/40/list');
    expect(canonicalOf(metadata)).not.toContain('?page');
    expect(metadata.robots).toBeUndefined();
  });

  it('keeps pagination-only requests indexable, with the page in the canonical', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ page: '2' } as never),
    });

    expect(metadata.robots).toBeUndefined();
    expect(canonicalOf(metadata)).toContain('/kilter/kilter-original/12x12/bolt-ons/40/list?page=2');
  });

  it('canonicalises ?page=1 onto the bare path — same page, one URL', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ page: '1' } as never),
    });

    expect(canonicalOf(metadata)).not.toContain('?page');
    expect(metadata.robots).toBeUndefined();
  });

  it('noindexes past the last indexable page but keeps crawlers following the climb links', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ page: '11' } as never),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(canonicalOf(metadata)).toContain('?page=11');
  });

  it('noindexes filtered list requests and canonicalizes to the clean base URL', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ sortBy: 'quality', name: 'crimpy' } as never),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toContain('/kilter/kilter-original/12x12/bolt-ons/40/list');
    expect(metadata.alternates?.canonical).not.toContain('sortBy');
    expect(metadata.alternates?.canonical).not.toContain('crimpy');
  });
});
