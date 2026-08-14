import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * Reposition invariant — A1 (canonical consolidation), LANDED in W-15 (#4369).
 *
 * The two climb-view route trees used to self-canonicalize into DIFFERENT URLs
 * for the same climb: the legacy `[board_name]/…/view` page emitted the
 * config-tuple form, while `/b/[slug]/…/view` passed a `/b/…` canonical
 * straight through. Two self-canonicalizing trees for one climb permanently
 * split PageRank.
 *
 * A1 points both trees at the config-tuple tree (route segments
 * `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/…`, served in its
 * named-slug form — `/kilter/original/12x12/screw_bolt/40/…`), not at `/b`.
 * `/b/{slug}` resolves through `boardBySlug`
 * (`packages/backend/src/graphql/resolvers/social/boards.ts`), which reads
 * `user_boards` scoped only by `slug` and `deletedAt` — a board a specific user
 * owns, not a climb config. Most climbs have no `/b` URL at all, because no
 * `user_boards` row exists for their layout/size/set/angle combination; popular
 * configs have many `/b` URLs, one per user who owns a board with that config.
 * The config-tuple tree is the only one that names a climb config uniquely, so
 * it is the consolidation target.
 *
 * Both pages now call `buildCanonicalClimbViewUrl` — ONE function, which is why
 * the parity assertion below can be an equality rather than a shape check.
 *
 * The second case guards the sharp edge that comes with cross-canonicalising:
 * an unlisted or private `/b` board is `noindex`, and a canonical pointing from
 * a noindex URL at an indexable twin is a conflicting signal Google can resolve
 * by propagating the noindex — deindexing a public config-tuple climb page
 * because one private board happens to share its configuration. So a noindex
 * `/b` page passes no `path` and emits no `alternates` at all.
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
  getClimbStatsForAllAngles: vi.fn(async () => []),
}));

vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => []),
  getFrontDoorBetaLinks: vi.fn(async () => []),
}));

// Rich board details so the real `tryResolveBoardSlugs` (url-utils, left
// unmocked) resolves the production named-slug config-tuple canonical. Also
// serves each view page's own `getBoardDetailsForBoard` call.
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

// Slug page: board resolution + route params for the same climb. Mutable so a
// case can hand back a private/unlisted board.
const resolvedBoard = {
  slug: 'kilter-original-12x12',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  isPublic: true,
  isUnlisted: false,
};
const resolveBoardBySlug = vi.fn(async () => resolvedBoard);

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug,
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
vi.mock('@/app/components/climb-front-door/climb-front-door', () => ({ default: () => null }));

// `@/app/lib/url-utils` is deliberately left REAL: the canonical both pages
// emit must reflect the true helper output, which is the whole point of A1.

const legacyPage = await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page');
const slugPage = await import('@/app/b/[board_slug]/[angle]/view/[climb_uuid]/page');

function canonicalPath(canonical: string | URL | { url: string | URL } | null | undefined): string {
  if (!canonical) throw new Error('expected generateMetadata to set alternates.canonical');
  const url = typeof canonical === 'object' && 'url' in canonical ? canonical.url : canonical;
  return new URL(url.toString(), 'https://www.boardsesh.com').pathname;
}

function legacyMetadata() {
  return legacyPage.generateMetadata({
    params: Promise.resolve({
      board_name: 'kilter',
      layout_id: '1',
      size_id: '10',
      set_ids: '1,20',
      angle: '40',
      climb_uuid: CLIMB_UUID,
    }),
  });
}

function slugMetadata() {
  return slugPage.generateMetadata({
    params: Promise.resolve({ board_slug: 'kilter-original-12x12', angle: '40', climb_uuid: CLIMB_UUID }),
  });
}

describe('climb-view canonical parity (A1 landed in W-15)', () => {
  it('both trees emit the identical canonical string for one climb', async () => {
    const [legacy, slug] = await Promise.all([legacyMetadata(), slugMetadata()]);

    const legacyCanonical = canonicalPath(legacy.alternates?.canonical);
    const slugCanonical = canonicalPath(slug.alternates?.canonical);

    expect(slugCanonical).toBe(legacyCanonical);
    // Non-vacuous: the shared string is the config-tuple tree, not `/b`.
    expect(slugCanonical.startsWith('/b/')).toBe(false);
    expect(slugCanonical.startsWith('/kilter/')).toBe(true);
    // The uuid survives into the canonical either way (embedded in the name slug).
    expect(slugCanonical).toContain(CLIMB_UUID);
  });

  it('the config-tuple tree still canonicalizes onto itself', async () => {
    const path = canonicalPath((await legacyMetadata()).alternates?.canonical);

    expect(path.startsWith('/b/')).toBe(false);
    expect(path.startsWith('/kilter/')).toBe(true);
    expect(path).toContain(CLIMB_UUID);
  });

  it('an unlisted /b board noindexes AND emits no canonical to leak that onto the twin', async () => {
    resolveBoardBySlug.mockResolvedValueOnce({ ...resolvedBoard, isUnlisted: true });

    const metadata = await slugMetadata();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });

  it('a private /b board noindexes AND emits no canonical either', async () => {
    resolveBoardBySlug.mockResolvedValueOnce({ ...resolvedBoard, isPublic: false });

    const metadata = await slugMetadata();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });
});
