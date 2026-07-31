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
 * A1 (canonical consolidation) points both trees at the config-tuple tree
 * (route segments `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/…`,
 * served in its named-slug form — `/kilter/original/12x12/screw_bolt/40/…`),
 * not at `/b`. `/b/{slug}` resolves through `boardBySlug`
 * (`packages/backend/src/graphql/resolvers/social/boards.ts:786-800`), which
 * reads `user_boards` scoped only by `slug` and `deletedAt` — a board a specific
 * user owns, not a climb config. Most climbs have no `/b` URL at all, because no
 * `user_boards` row exists for their layout/size/set/angle combination; popular
 * configs have many `/b` URLs, one per user who owns a board with that config.
 * The config-tuple tree is the only one that names a climb config uniquely, so
 * it is the consolidation target.
 *
 * The `url-utils` helpers already emit that form, so A1 has no work there. What
 * changes is the `/b` pages' inline canonical literal, which reaches
 * `createPageMetadata` without passing through `url-utils`:
 * `app/b/[board_slug]/[angle]/view/[climb_uuid]/page.tsx:54` and its list
 * sibling `app/b/[board_slug]/[angle]/list/page.tsx:37`. WHEN A1 LANDS: point
 * that literal at the legacy tree's canonical for the same climb, then flip the
 * `/b` test below to assert parity and drop its split markers. Until then this
 * test documents the split and guards against it silently widening.
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

describe('climb-view canonical parity (documents the split; the /b half flips at A1)', () => {
  it('the /b slug view self-canonicalizes into the /b tree today (flips at A1)', async () => {
    const metadata = await slugPage.generateMetadata({
      params: Promise.resolve({ board_slug: 'kilter-original-12x12', angle: '40', climb_uuid: CLIMB_UUID }),
    });
    // A1 repoints this page's inline canonical literal at the legacy tree, so
    // this flips to `.toBe(false)` plus an equality assertion against the legacy
    // page's canonical for the same climb.
    expect(canonicalPath(metadata.alternates?.canonical).startsWith('/b/')).toBe(true);
  });

  it('documents the split: the legacy view already canonicalizes onto the config-tuple tree A1 keeps', async () => {
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
    // No flip needed here at A1 — this tree is already the consolidation target.
    // The prefix check is deliberately shape-agnostic: it holds for the
    // named-slug canonical this page emits today and for the numeric fallback.
    expect(path.startsWith('/b/')).toBe(false);
    expect(path.startsWith('/kilter/')).toBe(true);
    // The uuid survives into the canonical either way (embedded in the name slug).
    expect(path).toContain(CLIMB_UUID);
  });
});
