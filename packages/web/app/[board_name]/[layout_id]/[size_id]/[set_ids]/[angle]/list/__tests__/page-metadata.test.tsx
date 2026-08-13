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
  getBoardDetailsForBoard: vi.fn(() => ({ board_name: 'kilter' })),
}));

vi.mock('@/app/lib/data/list-page-data.server', () => ({
  fetchListPageData: vi.fn(async () => ({
    boardDetails: { board_name: 'kilter' },
    searchResponse: { climbs: [], hasMore: false },
    preloadUrl: null,
  })),
}));

vi.mock('@/app/components/board-page/board-page-climbs-list', () => ({
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

describe('legacy board list metadata', () => {
  it('leaves an unfiltered request alone rather than minting a second canonical for the same list', async () => {
    const metadata = await pageModule.generateMetadata({ params, searchParams: emptySearchParams() });

    // `/b/{slug}/{angle}/list` is the canonical home for this content. Emitting
    // a canonical here too would split PageRank across both trees, which is the
    // regression climb-canonical-parity.test.ts guards for the view route.
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.robots).toBeUndefined();
  });

  it('keeps pagination-only requests out of the noindex bucket', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ page: '2' } as never),
    });

    expect(metadata.robots).toBeUndefined();
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
