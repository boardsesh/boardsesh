import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * The canonical this page claims is built from the RESOLVED board ids, never
 * echoed back from the request's own segments — because several slug spellings
 * resolve to one board config (`kilter-original` and `original` are both layout
 * 1; `12x12` and `12x12-square` are both size 10; `bolt_screw` and `screw_bolt`
 * are both sets [1,20]). Echoing would give each spelling its own
 * self-canonical, and none of them would be the URL `/b` canonicalises into.
 *
 * So the params below are deliberately a DIFFERENT spelling from what the
 * mocked `parseRouteParams` resolves to, and every assertion is on the builder
 * output for the resolved ids.
 */

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
      size_id: 10,
      set_ids: [1, 20],
      angle: 40,
    },
    isNumericFormat: false,
  })),
}));

// Rich enough for the real (unmocked) `buildCanonicalClimbListUrl` to resolve
// the production named-slug form.
vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12',
    size_description: 'Commercial',
    set_names: ['Bolt Ons', 'Screw Ons'],
  })),
}));

vi.mock('@/app/lib/data/list-page-data.server', () => ({
  fetchFrontDoorListPage: vi.fn(async () => ({
    boardDetails: { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] },
    climbs: [],
    hasMore: false,
    preloadUrl: null,
  })),
}));

vi.mock('@/app/components/climb-front-door/static-list-front-door', () => ({
  default: () => null,
}));

const pageModule = await import('../page');
const { buildCanonicalClimbListUrl } = await import('@/app/lib/url-utils');
const { getBoardDetailsForBoard } = await import('@/app/lib/board-utils');

/** What the resolved ids canonically are, straight from the shared builder. */
const RESOLVED_CANONICAL = buildCanonicalClimbListUrl(
  getBoardDetailsForBoard({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] }),
  40,
);

// An alias spelling of the same board config. `parseRouteParams` above resolves
// it to layout 1 / size 10 / sets [1,20] regardless.
const params = Promise.resolve({
  board_name: 'kilter',
  layout_id: 'kilter-original',
  size_id: '12x12',
  set_ids: 'bolt_screw',
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
    expect(canonicalOf(metadata)).toBe(RESOLVED_CANONICAL);
    expect(metadata.robots).toBeUndefined();
  });

  it('canonicalises the request spelling onto the resolved config, not back at itself', async () => {
    const canonical = canonicalOf(await pageModule.generateMetadata({ params, searchParams: emptySearchParams() }));

    // Non-vacuous: the requested `kilter-original` / `bolt_screw` spellings are
    // NOT what comes back. Either one echoed here is a second canonical for one
    // board config.
    expect(canonical).toContain('/kilter/original/');
    expect(canonical).not.toContain('/kilter-original/');
    expect(canonical).not.toContain('/bolt_screw/');
    expect(canonical).toMatch(/\/40\/list$/);
  });

  it('keeps pagination-only requests indexable, with the page in the canonical', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ page: '2' } as never),
    });

    expect(metadata.robots).toBeUndefined();
    expect(canonicalOf(metadata)).toBe(`${RESOLVED_CANONICAL}?page=2`);
  });

  it('canonicalises ?page=1 onto the bare path — same page, one URL', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ page: '1' } as never),
    });

    expect(canonicalOf(metadata)).toBe(RESOLVED_CANONICAL);
    expect(metadata.robots).toBeUndefined();
  });

  it('noindexes past the last indexable page but keeps the page self-canonical', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ page: '11' } as never),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    // Self-canonical, not pointed at page 1: `?page=11` is different climbs.
    expect(canonicalOf(metadata)).toBe(`${RESOLVED_CANONICAL}?page=11`);
  });

  it('noindexes filtered list requests and canonicalizes to the clean base URL', async () => {
    const metadata = await pageModule.generateMetadata({
      params,
      searchParams: Promise.resolve({ sortBy: 'quality', name: 'crimpy' } as never),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(canonicalOf(metadata)).toBe(RESOLVED_CANONICAL);
  });

  it('claims no canonical for a board config that does not resolve', async () => {
    const { parseRouteParams } = await import('@/app/lib/url-utils.server');
    vi.mocked(parseRouteParams).mockRejectedValueOnce(new Error('no such layout'));

    const metadata = await pageModule.generateMetadata({ params, searchParams: emptySearchParams() });

    expect(metadata.alternates).toBeUndefined();
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});
