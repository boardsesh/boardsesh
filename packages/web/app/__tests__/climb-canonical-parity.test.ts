import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * Reposition invariant (Phase A0 → flips at A1).
 *
 * Today the two climb-view route trees self-canonicalize into DIFFERENT URLs for
 * the same climb. The legacy `[board_name]/…/view` page derives its canonical
 * via `tryConstructSlugViewUrl(...) ?? constructClimbViewUrl(...)` — both emit
 * the legacy verbose tree (`/{board}/…`) — while `/b/[slug]/…/view` passes a
 * `/b/…` canonical straight through. Two self-canonicalizing trees for one climb
 * permanently splits PageRank.
 *
 * A1 (canonical consolidation) repoints the `url-utils` helpers to emit the `/b`
 * form. WHEN A1 LANDS: flip the legacy assertion to `.startsWith('/b/')` (and
 * assert parity with the slug canonical), then delete the `false`/legacy-tree
 * markers. Until then this test documents the split and guards against it
 * silently widening.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), permanentRedirect: vi.fn() }));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({
    name: 'My Test Climb',
    difficulty: 'V5',
    setter_username: 'setter',
    quality_average: 4,
    ascensionist_count: 12,
    frames: 'p1r12',
  })),
}));

// Rich board details so the real `tryResolveBoardSlugs` (url-utils, left
// unmocked) resolves the production named-slug legacy canonical. Also serves
// each view page's own `getBoardDetailsForBoard` call.
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

// Legacy page: numeric route params.
vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 10,
      set_ids: [1, 20],
      angle: 40,
      climb_uuid: CLIMB_UUID,
    },
    isNumericFormat: true,
  })),
}));

// Slug page: board resolution + route params for the same climb.
vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: vi.fn(async () => ({
    slug: 'kilter-original-12x12',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
  })),
  boardToRouteParams: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    angle: 40,
  })),
}));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));
vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOverlayWarming: vi.fn() }));
vi.mock('@/app/components/board-page/board-page-climbs-list', () => ({ default: () => null }));
vi.mock('@/app/components/climb-detail/climb-view-seo-fragment', () => ({ default: () => null }));

// `@/app/lib/url-utils` is deliberately left REAL: the legacy canonical must
// reflect the true helper output, which is exactly what A1 changes.

const legacyPage = await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page');
const slugPage = await import('@/app/b/[board_slug]/[angle]/view/[climb_uuid]/page');

function canonicalPath(canonical: string | URL | { url: string | URL } | null | undefined): string {
  if (!canonical) throw new Error('expected generateMetadata to set alternates.canonical');
  const url = typeof canonical === 'object' && 'url' in canonical ? canonical.url : canonical;
  return new URL(url.toString(), 'https://www.boardsesh.com').pathname;
}

describe('climb-view canonical parity (RED until A1 consolidates onto /b)', () => {
  it('the /b slug view already self-canonicalizes into the /b tree', async () => {
    const metadata = await slugPage.generateMetadata({
      params: Promise.resolve({ board_slug: 'kilter-original-12x12', angle: '40', climb_uuid: CLIMB_UUID }),
    });
    expect(canonicalPath(metadata.alternates?.canonical).startsWith('/b/')).toBe(true);
  });

  it('documents the split: the legacy view canonicalizes into the legacy tree, NOT /b (flip at A1)', async () => {
    const metadata = await legacyPage.generateMetadata({
      params: Promise.resolve({
        board_name: 'kilter',
        layout_id: '1',
        size_id: '10',
        set_ids: '1,20',
        angle: '40',
        climb_uuid: CLIMB_UUID,
      }),
    });
    const path = canonicalPath(metadata.alternates?.canonical);
    // A1 flips these two lines to `expect(path.startsWith('/b/')).toBe(true)` and
    // asserts equality with the slug canonical for the same climb.
    expect(path.startsWith('/b/')).toBe(false);
    expect(path.startsWith('/kilter/')).toBe(true);
    // The uuid survives into the canonical either way (embedded in the name slug).
    expect(path).toContain(CLIMB_UUID);
  });
});
