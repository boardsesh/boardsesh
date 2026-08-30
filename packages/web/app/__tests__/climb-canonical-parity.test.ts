import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';

/**
 * Reposition invariant — A1 (canonical consolidation), LANDED in W-15 (#4369).
 *
 * The two climb route trees used to self-canonicalize into DIFFERENT URLs for
 * the same climb: the legacy `[board_name]/…/view` page emitted the config-tuple
 * form, while `/b/[slug]/…/view` passed a `/b/…` canonical straight through.
 * Two self-canonicalizing trees for one climb permanently split PageRank. The
 * `/list` pair had the same shape, one level up.
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
 * All four pages call `buildCanonicalClimbViewUrl` / `buildCanonicalClimbListUrl`
 * — ONE function per surface, which is why the parity assertions can be
 * equalities rather than shape checks.
 *
 * `getBoardDetailsForBoard` is mocked as a FUNCTION OF ITS ARGUMENT rather than
 * a shared constant: with one frozen object both trees would agree no matter
 * how they derived their board details, and the parity assertion would hold by
 * construction. Deriving from the ids each tree actually passes is what makes
 * these equalities load-bearing.
 *
 * Two sharp edges are pinned alongside parity:
 *  - An unlisted or private `/b` board is `noindex`, and a canonical pointing
 *    from a noindex URL at an *indexable* twin is a conflicting signal Google
 *    can resolve by propagating the noindex — deindexing a public config-tuple
 *    page because one private board shares its configuration. So a hidden-board
 *    page passes no `path` and emits no `alternates` at all.
 *  - The shadowed size: Kilter layout 1 sizes 10 and 27 share the bare `12x12`
 *    slug, so only the id-aware builder can tell them apart. Both trees must
 *    emit the same qualified slug for 27, and it must differ from 10's.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), permanentRedirect: vi.fn() }));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

/**
 * The board config both trees resolve to. Mutable so a case can swap in the
 * shadowed size (27) and watch both trees follow it.
 */
const boardConfig = { layoutId: 1, sizeId: 10, setIds: [1, 20] as number[], angle: 40 };

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

vi.mock('@/app/lib/data/list-page-data.server', () => ({
  fetchFrontDoorListPage: vi.fn(async () => ({
    boardDetails: { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] },
    climbs: [],
    hasMore: false,
    preloadUrls: [],
  })),
}));

// Derived from the ids the CALLER passes, so neither tree can quietly canonicalise
// off a board config it didn't resolve. Names are rich enough that the real
// (unmocked) `tryResolveBoardSlugs` in url-utils produces the production
// named-slug form.
vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(
    (params: { board_name: string; layout_id: number; size_id: number; set_ids: number[] }) => ({
      board_name: params.board_name,
      layout_id: params.layout_id,
      size_id: params.size_id,
      set_ids: params.set_ids,
      layout_name: 'Kilter Board Original',
      size_name: '12 x 12',
      // Deliberately IDENTICAL for sizes 10 and 27. The name-based fallback
      // builder would collapse them onto one slug from these strings, so the
      // shadowed-size cases below can only pass through the id-aware path.
      size_description: 'Commercial',
      set_names: ['Bolt Ons', 'Screw Ons'],
    }),
  ),
}));

// Legacy pages: numeric route params, resolved from the shared board config.
vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: 'kilter',
      layout_id: boardConfig.layoutId,
      size_id: boardConfig.sizeId,
      set_ids: boardConfig.setIds,
      angle: boardConfig.angle,
      climb_uuid: CLIMB_UUID,
    },
    isNumericFormat: true,
  })),
}));

// Slug pages: board resolution + route params for the SAME board config.
// Mutable so a case can hand back a private/unlisted board.
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
    layout_id: boardConfig.layoutId,
    size_id: boardConfig.sizeId,
    set_ids: boardConfig.setIds,
    angle: boardConfig.angle,
  })),
}));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayPreloadUrls: vi.fn((_bd: unknown, frames: string | null | undefined) =>
    frames ? ['/api/internal/board-render'] : [],
  ),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));
vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOverlayWarming: vi.fn() }));
// Recorded rather than discarded: the `noindex` prop is what stops the
// CreativeWork JSON-LD from naming the indexable twin on a hidden `/b` page, and
// the prop is the only place that decision is made.
const frontDoorProps = vi.fn();
vi.mock('@/app/components/climb-front-door/climb-front-door', () => ({
  default: (props: Record<string, unknown>) => {
    frontDoorProps(props);
    return null;
  },
}));
vi.mock('@/app/components/climb-front-door/static-list-front-door', () => ({ default: () => null }));

// `@/app/lib/url-utils` is deliberately left REAL: the canonical every page
// emits must reflect the true helper output, which is the whole point of A1.

const { climbRowsToItems } = await import('@/app/lib/seo/sitemap/climb-entries');
const { expandDefaultLocaleOnly } = await import('@/app/lib/seo/sitemap/entries');

const legacyViewPage =
  await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page');
const slugViewPage = await import('@/app/b/[board_slug]/[angle]/view/[climb_uuid]/page');
const legacyListPage = await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/list/page');
const slugListPage = await import('@/app/b/[board_slug]/[angle]/list/page');

function canonicalPath(canonical: string | URL | { url: string | URL } | null | undefined): string {
  if (!canonical) throw new Error('expected generateMetadata to set alternates.canonical');
  const url = typeof canonical === 'object' && 'url' in canonical ? canonical.url : canonical;
  const parsed = new URL(url.toString(), 'https://www.boardsesh.com');
  return `${parsed.pathname}${parsed.search}`;
}

function legacyViewMetadata() {
  return legacyViewPage.generateMetadata({
    params: Promise.resolve({
      board_name: 'kilter',
      layout_id: String(boardConfig.layoutId),
      size_id: String(boardConfig.sizeId),
      set_ids: boardConfig.setIds.join(','),
      angle: String(boardConfig.angle),
      climb_uuid: CLIMB_UUID,
    }),
  });
}

function slugViewMetadata() {
  return slugViewPage.generateMetadata({
    params: Promise.resolve({
      board_slug: 'kilter-original-12x12',
      angle: String(boardConfig.angle),
      climb_uuid: CLIMB_UUID,
    }),
  });
}

function legacyListMetadata(searchParams: Record<string, string> = {}) {
  return legacyListPage.generateMetadata({
    params: Promise.resolve({
      board_name: 'kilter',
      layout_id: String(boardConfig.layoutId),
      size_id: String(boardConfig.sizeId),
      set_ids: boardConfig.setIds.join(','),
      angle: String(boardConfig.angle),
    }),
    searchParams: Promise.resolve(searchParams as never),
  });
}

/** Renders the `/b` view page body so the props it hands the front door are observable. */
async function renderSlugViewPage() {
  renderToString(
    await slugViewPage.default({
      params: Promise.resolve({
        board_slug: 'kilter-original-12x12',
        angle: String(boardConfig.angle),
        climb_uuid: CLIMB_UUID,
      }),
    } as never),
  );
}

function slugListMetadata(searchParams: Record<string, string> = {}) {
  return slugListPage.generateMetadata({
    params: Promise.resolve({ board_slug: 'kilter-original-12x12', angle: String(boardConfig.angle) }),
    searchParams: Promise.resolve(searchParams as never),
  });
}

beforeEach(() => {
  boardConfig.sizeId = 10;
});

describe('climb-view canonical parity (A1 landed in W-15)', () => {
  it('both trees emit the identical canonical string for one climb', async () => {
    const [legacy, slug] = await Promise.all([legacyViewMetadata(), slugViewMetadata()]);

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
    const path = canonicalPath((await legacyViewMetadata()).alternates?.canonical);

    expect(path.startsWith('/b/')).toBe(false);
    expect(path.startsWith('/kilter/')).toBe(true);
    expect(path).toContain(CLIMB_UUID);
  });

  it('agrees on the shadowed size (Kilter layout 1 size 27) and keeps it distinct from size 10', async () => {
    const sizeTenCanonical = canonicalPath((await legacyViewMetadata()).alternates?.canonical);

    boardConfig.sizeId = 27;
    const [legacy, slug] = await Promise.all([legacyViewMetadata(), slugViewMetadata()]);
    const sizeTwentySevenCanonical = canonicalPath(legacy.alternates?.canonical);

    expect(canonicalPath(slug.alternates?.canonical)).toBe(sizeTwentySevenCanonical);
    // The qualified size slug is the whole reason the builder resolves ids
    // before names: 27 and 10 must not collapse onto one URL.
    expect(sizeTwentySevenCanonical).not.toBe(sizeTenCanonical);
  });

  it('an unlisted /b board noindexes AND emits no canonical to leak that onto the twin', async () => {
    resolveBoardBySlug.mockResolvedValueOnce({ ...resolvedBoard, isUnlisted: true });

    const metadata = await slugViewMetadata();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });

  it('a private /b board noindexes AND emits no canonical either', async () => {
    resolveBoardBySlug.mockResolvedValueOnce({ ...resolvedBoard, isPublic: false });

    const metadata = await slugViewMetadata();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });

  it('tells the front door to withhold the CreativeWork url on a hidden /b board', async () => {
    // `generateMetadata` withholding `alternates` is only half the guard: the
    // page body renders the same canonical again as `CreativeWork.url`, which is
    // the field Google actually uses for page association. Both halves have to
    // agree, so the body gets the same `shouldNoindex` decision.
    for (const hidden of [{ isUnlisted: true }, { isPublic: false }]) {
      frontDoorProps.mockClear();
      resolveBoardBySlug.mockResolvedValueOnce({ ...resolvedBoard, ...hidden });

      await renderSlugViewPage();

      expect(frontDoorProps.mock.calls[0]?.[0]).toMatchObject({ noindex: true });
    }
  });

  it('still emits the CreativeWork url on a public /b board', async () => {
    // Non-vacuous: the gate must be the hidden-board condition, not "always on".
    frontDoorProps.mockClear();

    await renderSlugViewPage();

    expect(frontDoorProps.mock.calls[0]?.[0]).toMatchObject({ noindex: false });
  });
});

describe('sitemap ↔ canonical parity (W-23)', () => {
  /**
   * The own-goal the climb shards exist to avoid: submitting ~85k URLs that
   * differ from the pages' own canonicals, which Google drops wholesale as
   * "alternate page with proper canonical". `toBe` against the literal string
   * the page emits — not a regex, not `toContain`.
   */
  const sitemapPath = (sizeId: number) =>
    climbRowsToItems(
      [{ uuid: CLIMB_UUID, name: 'My Test Climb', angle: boardConfig.angle, updatedAt: new Date('2026-05-04') }],
      { boardType: 'kilter', layoutId: boardConfig.layoutId, sizeId, setIds: boardConfig.setIds },
    ).items[0].path;

  it('the sitemap URL is byte-identical to the canonical both trees emit', async () => {
    const [legacy, slug] = await Promise.all([legacyViewMetadata(), slugViewMetadata()]);

    expect(sitemapPath(boardConfig.sizeId)).toBe(canonicalPath(legacy.alternates?.canonical));
    expect(sitemapPath(boardConfig.sizeId)).toBe(canonicalPath(slug.alternates?.canonical));
  });

  it('the emitted <loc> is the absolute form of that same canonical', () => {
    const [entry] = expandDefaultLocaleOnly([{ path: sitemapPath(boardConfig.sizeId) }]);

    expect(entry.loc).toBe(`https://www.boardsesh.com${sitemapPath(boardConfig.sizeId)}`);
    expect(entry.alternates).toBeUndefined();
  });

  it('follows both trees onto the shadowed size (Kilter layout 1 size 27)', async () => {
    boardConfig.sizeId = 27;
    const legacy = await legacyViewMetadata();

    expect(sitemapPath(27)).toBe(canonicalPath(legacy.alternates?.canonical));
    expect(sitemapPath(27)).not.toBe(sitemapPath(10));
  });
});

describe('/list canonical parity (A1 landed in W-15)', () => {
  it('both trees emit the identical canonical string for one board config', async () => {
    const [legacy, slug] = await Promise.all([legacyListMetadata(), slugListMetadata()]);

    const legacyCanonical = canonicalPath(legacy.alternates?.canonical);
    const slugCanonical = canonicalPath(slug.alternates?.canonical);

    expect(slugCanonical).toBe(legacyCanonical);
    expect(slugCanonical.startsWith('/b/')).toBe(false);
    expect(slugCanonical).toMatch(/^\/kilter\/.*\/40\/list$/);
  });

  it('agrees on the shadowed size for /list too', async () => {
    const sizeTenCanonical = canonicalPath((await legacyListMetadata()).alternates?.canonical);

    boardConfig.sizeId = 27;
    const [legacy, slug] = await Promise.all([legacyListMetadata(), slugListMetadata()]);
    const sizeTwentySevenCanonical = canonicalPath(legacy.alternates?.canonical);

    expect(canonicalPath(slug.alternates?.canonical)).toBe(sizeTwentySevenCanonical);
    expect(sizeTwentySevenCanonical).not.toBe(sizeTenCanonical);
  });

  it('carries pagination into both trees identically', async () => {
    const [legacy, slug] = await Promise.all([legacyListMetadata({ page: '3' }), slugListMetadata({ page: '3' })]);

    expect(canonicalPath(slug.alternates?.canonical)).toBe(canonicalPath(legacy.alternates?.canonical));
    expect(canonicalPath(legacy.alternates?.canonical)).toContain('?page=3');
  });

  it('resolves filtered variants onto the same clean base on both trees', async () => {
    const filters = { minGrade: '20', sortBy: 'quality' };
    const [legacy, slug] = await Promise.all([legacyListMetadata(filters), slugListMetadata(filters)]);

    const unfiltered = canonicalPath((await legacyListMetadata()).alternates?.canonical);

    expect(legacy.robots).toEqual({ index: false, follow: true });
    expect(slug.robots).toEqual({ index: false, follow: true });
    expect(canonicalPath(legacy.alternates?.canonical)).toBe(unfiltered);
    expect(canonicalPath(slug.alternates?.canonical)).toBe(unfiltered);
  });

  it('an unlisted /b board list noindexes and emits no canonical', async () => {
    resolveBoardBySlug.mockResolvedValueOnce({ ...resolvedBoard, isUnlisted: true });

    const metadata = await slugListMetadata();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
  });
});
