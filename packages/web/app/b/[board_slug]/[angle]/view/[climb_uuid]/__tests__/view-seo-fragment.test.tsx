import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { getClimbStatsForAllAngles, type ClimbStatsForAngle } from '@/app/lib/data/queries';
import { getRedirectStatusCodeFromError, getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { constructBoardSlugViewUrl, extractUuidFromSlug } from '@/app/lib/url-utils';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';

/**
 * The climb front door's acceptance suite — the vitest form of #4369's curl
 * checks.
 *
 * Two halves:
 *  1. The page still SSR-emits `ClimbViewSeoFragment`, asserted by element
 *     identity so a refactor can't drop the page's only `<h1>` unnoticed. That
 *     assertion predates W-15 (it was the A0 guard) and is deliberately
 *     unchanged.
 *  2. The rendered front door carries exactly one `<h1>`, the board `<img>`
 *     with explicit dimensions, a setter link, angle cross-links, ≥3 internal
 *     links, and a CTA whose href is `APP_URL` + the same pathname.
 */

// Mutable bits of the mocked climb row, so a test can vary what `getClimb`
// returns without re-declaring the whole fixture.
const climbRow = vi.hoisted(() => ({ description: null as string | null }));

vi.mock('server-only', () => ({}));
// `usePathname` for the store button island, which re-reads a QR landing per page.
vi.mock('next/navigation', async () => ({
  notFound: vi.fn(),
  permanentRedirect: (await import('next/dist/client/components/redirect')).permanentRedirect,
  usePathname: () => null,
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const flat = Object.entries(options)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(',');
      return `${key}(${flat})`;
    },
    locale: 'en-US',
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: vi.fn(async () => ({
    slug: 'my-board',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
    isPublic: true,
    isUnlisted: false,
  })),
  boardToRouteParams: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    angle: 40,
  })),
  boardToRouteParamsFromAngleSegment: vi.fn((_board: unknown, angleSegment: string) => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    angle: Number(angleSegment),
  })),
}));

vi.mock('@/app/lib/board-image-details', async () => ({
  ...(await vi.importActual<typeof import('@/app/lib/board-image-details')>('@/app/lib/board-image-details')),
  getBoardImageDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12',
    size_description: 'Commercial',
    set_names: ['Bolt Ons', 'Screw Ons'],
    images_to_holds: {},
    holdsData: [],
    boardWidth: 1080,
    boardHeight: 1350,
  })),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({
    uuid: 'test-climb',
    name: 'Test Climb',
    difficulty: 'V5',
    setter_username: 'setter-person',
    quality_average: '4.20',
    ascensionist_count: 12,
    frames: 'p1r12',
    description: climbRow.description,
  })),
  getClimbStatsForAllAngles: vi.fn(async () => [
    {
      angle: 25,
      ascensionist_count: '4',
      quality_average: '3.80',
      difficulty_average: 17,
      display_difficulty: 17,
      fa_username: null,
      fa_at: null,
      difficulty: 'V3',
      quality_normalized: true,
      rating_count: '4',
    },
    {
      angle: 40,
      ascensionist_count: '12',
      quality_average: '4.20',
      difficulty_average: 20,
      display_difficulty: 20,
      fa_username: 'first-ascensionist',
      fa_at: '2024-03-01T00:00:00.000Z',
      difficulty: 'V5',
      quality_normalized: true,
      rating_count: '12',
    },
  ]),
}));

vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => ({ status: 'loaded', items: [] })),
  getFrontDoorBetaLinks: vi.fn(async () => ({ status: 'loaded', items: [] })),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOgImageWarming: vi.fn() }));
vi.mock('@/app/components/board-renderer/util', () => ({
  // The fixtures here are Kilter, which has no dark art — one composite, no photo layers, so
  // the assertions below keep counting a single board image.
  buildBoardArtLayers: vi.fn((_bd: unknown, frames: string | null | undefined) => ({
    backgroundUrls: [],
    overlayUrl: frames ? '/api/internal/board-render?variant=overlay' : null,
  })),
  toDarkArtUrl: (url: string) => url.replace(/\.webp$/, '.dark.webp'),
  buildOverlayUrl: vi.fn(
    (_bd: unknown, _frames: string, _thumbnail?: boolean, colorScheme?: 'light' | 'dark') =>
      `/api/internal/board-render?variant=overlay${colorScheme === 'dark' ? '&color_scheme=dark' : ''}`,
  ),
  buildOverlayPreloadUrls: vi.fn((_bd: unknown, frames: string | null | undefined) =>
    frames ? ['/api/internal/board-render?variant=overlay'] : [],
  ),
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  // The fixtures here are Kilter, which has no dark art — so the front door emits its
  // single board image and these assertions keep counting one.
  hasSplitDarkBoardArt: (board: string) => board === 'woods',
}));

// Below-the-fold client islands. They are not what this file asserts, and
// mounting them under `renderToString` would drag React Query and the socket
// providers into a node test.
vi.mock('@/app/components/similar-climbs/similar-climbs-list', () => ({ default: () => null }));
// The root layout's provider, as a cold server render sees it: no answer yet.
vi.mock('@/app/components/consent/consent-state-provider', () => ({
  useConsent: () => ({ granted: false, snapshot: { record: null }, dialogOpen: false }),
}));
vi.mock('@/app/components/social/climb-social-section', () => ({ default: () => null }));
vi.mock('@/app/components/beta-videos/boardsesh-beta-list', () => ({ default: () => null }));

function requireRedirectError(outcome: unknown) {
  expect(isRedirectError(outcome)).toBe(true);
  if (!isRedirectError(outcome)) throw new Error('Expected a Next redirect error');
  return outcome;
}

const pageModule = await import('@/app/(site)/b/[board_slug]/[angle]/view/[climb_uuid]/page');

const PARAMS = { board_slug: 'my-board', angle: '40', climb_uuid: 'test-climb' };

/**
 * Search the whole server-rendered element tree (not just the root's direct
 * children) for an element of `type`, so the assertion survives the front door
 * wrapping the fragment in a layout/fragment/conditional.
 */
function treeContainsElementOfType(node: React.ReactNode, type: React.ElementType): boolean {
  return React.Children.toArray(node).some((child) => {
    if (!React.isValidElement(child)) return false;
    if (child.type === type) return true;
    const { children } = child.props as { children?: React.ReactNode };
    return treeContainsElementOfType(children, type);
  });
}

async function renderFrontDoor(params = PARAMS): Promise<string> {
  const element = (await pageModule.default({
    searchParams: Promise.resolve({}),
    params: Promise.resolve(params),
  })) as React.ReactElement;
  return renderToString(<>{await resolveServerTree(element)}</>);
}

const CURRENT_ANGLE_STATS: ClimbStatsForAngle = {
  angle: 40,
  ascensionist_count: '12',
  quality_average: '4.20',
  difficulty_average: 20,
  display_difficulty: 20,
  fa_username: 'first-ascensionist',
  fa_at: '2024-03-01T00:00:00.000Z',
  difficulty: 'V5',
  quality_normalized: true,
  rating_count: '12',
};

/** `buildClimbSearchDescription` through the key-printing `t` above: lead, sends with rating, call to action. */
const JSON_LD_LEAD =
  'metadata.view.descriptionLead(climbName=Test Climb,grade=V5,layoutName=Kilter Board Original,angle=40,setter=setter-person)';
const JSON_LD_DESCRIPTION = `${JSON_LD_LEAD} metadata.view.descriptionSendsRated(count=12,ascents=12,quality=4.2) metadata.view.descriptionCta`;
const UNRATED_JSON_LD_DESCRIPTION = `${JSON_LD_LEAD} metadata.view.descriptionSends(count=12,ascents=12) metadata.view.descriptionCta`;

function jsonLdPayloads(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
}

function creativeWorkPayload(html: string): Record<string, unknown> {
  const creativeWork = jsonLdPayloads(html).find((payload) => payload['@type'] === 'CreativeWork');
  if (!creativeWork) throw new Error(`no CreativeWork payload rendered: ${html}`);
  return creativeWork;
}

type BreadcrumbItem = { '@type': string; position: number; name: string; item: string };

function breadcrumbItems(html: string): BreadcrumbItem[] {
  const breadcrumb = jsonLdPayloads(html).find((payload) => payload['@type'] === 'BreadcrumbList');
  if (!breadcrumb) throw new Error(`no BreadcrumbList payload rendered: ${html}`);
  return breadcrumb.itemListElement as BreadcrumbItem[];
}

describe('board slug climb view SEO fragment', () => {
  it('SSR-emits ClimbViewSeoFragment in the server output', async () => {
    const element = (await pageModule.default({
      searchParams: Promise.resolve({}),
      params: Promise.resolve(PARAMS),
    })) as React.ReactElement;
    // Expand every async server component EXCEPT the fragment, so the assertion
    // stays an element-identity check rather than a string match on its output.
    const tree = await resolveServerTree(element, new Set([ClimbViewSeoFragment]));

    expect(treeContainsElementOfType(tree, ClimbViewSeoFragment)).toBe(true);
  });
});

describe('climb front door server HTML', () => {
  it('carries exactly one <h1>', async () => {
    const html = await renderFrontDoor();
    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
  });

  it('renders the board image with an explicit width and height', async () => {
    const html = await renderFrontDoor();
    expect(html).toContain('/api/internal/board-render');
    expect(html).toMatch(/<img[^>]*width="1080"/);
    expect(html).toMatch(/<img[^>]*height="1350"/);
  });

  it('names the grade inside the <h1> and keeps the coloured tile out of the accessibility tree', async () => {
    const html = await renderFrontDoor();
    const heading = html.match(/<h1[\s>][\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(heading).toContain('Test Climb');
    expect(heading).toContain('frontDoor.hero.gradeForSearch(grade=V5)');
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*><span[^>]*>V5<\/span><\/span>/);
  });

  it('loads the board image first: high fetch priority and never lazy', async () => {
    const html = await renderFrontDoor();
    const boardImage = html.match(/<img[^>]*\/api\/internal\/board-render[^>]*>/)?.[0] ?? '';
    expect(boardImage).toMatch(/fetchPriority="high"|fetchpriority="high"/);
    expect(boardImage).not.toMatch(/loading=/);
  });

  it('carries one hand-off link to the app', async () => {
    const html = await renderFrontDoor();
    expect(html.match(/href="https:\/\/app\.boardsesh\.com/g) ?? []).toHaveLength(1);
  });

  it('reads crumbs, title, board, call to action, then the details, in DOM order', async () => {
    // The phone order. From md the CSS grid moves the board to a left column,
    // but crawlers, screen readers and phones all get this sequence.
    const html = await renderFrontDoor();
    const positions = [
      html.indexOf('aria-label="frontDoor.breadcrumb.aria"'),
      html.indexOf('<h1'),
      html.search(/<img[^>]*\/api\/internal\/board-render/),
      html.indexOf('href="https://app.boardsesh.com'),
      html.indexOf('<dl'),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((first, second) => first - second)).toEqual(positions);
  });

  it('prints the proof line from the current angle: sends, star and setter', async () => {
    const html = await renderFrontDoor();
    expect(html).toContain('sends(count=12,formattedCount=12)');
    expect(html).toContain('frontDoor.hero.qualityAria(quality=4.2)');
    expect(html).toContain('frontDoor.hero.boardAtAngle(board=Kilter Board Original,angle=40)');
  });

  it('agrees with the heading on quality: the facts list shows it only on the 1-5 scale', async () => {
    const factsList = (html: string) => html.match(/<dl[\s>][\s\S]*?<\/dl>/)?.[0] ?? '';
    const rated = factsList(await renderFrontDoor());
    expect(rated).toContain('frontDoor.facts.qualityAtAngle(angle=40)');
    expect(rated).toContain('frontDoor.hero.qualityAria(quality=4.2)');

    // Aurora's raw 1-3 average: neither the star, the facts list nor the table prints it.
    vi.mocked(getClimbStatsForAllAngles).mockResolvedValueOnce([
      { ...CURRENT_ANGLE_STATS, quality_average: '2.40', quality_normalized: false },
    ]);
    const html = await renderFrontDoor();
    expect(html).not.toContain('frontDoor.hero.qualityAria');
    expect(factsList(html)).toContain('frontDoor.angles.notRated');
  });

  it('emits one board image for a board with no dark art', async () => {
    // Woods ships a `.dark.webp` sibling and gets a light/dark pair the theme picks between
    // (issue #4753). Every other board must keep its single image — pairing them would
    // double both the request and the server render for identical bytes.
    const html = await renderFrontDoor();
    const boardImages = html.match(/<img[^>]*\/api\/internal\/board-render/g) ?? [];
    expect(boardImages).toHaveLength(1);
    expect(html).not.toContain('color_scheme=dark');
  });

  it('links the setter', async () => {
    const html = await renderFrontDoor();
    expect(html).toContain('href="/setter/setter-person"');
  });

  it('cross-links the other angles from the angle table and does not self-link the current one', async () => {
    const html = await renderFrontDoor();
    const table = html.match(/<table[\s>][\s\S]*?<\/table>/)?.[0] ?? '';
    // Angle navigation retains the shared physical board, while schema above
    // continues to use its canonical configuration URL.
    expect(table).toMatch(/href="\/b\/my-board\/25\/view\//);
    expect(html).not.toMatch(/href="\/b\/my-board\/40\/view\//);
    expect(table).toMatch(/<tr[^>]*aria-current="page"[^>]*>[\s\S]*?frontDoor\.facts\.angleValue\(angle=40\)/);
  });

  it('writes the about paragraph from the page data', async () => {
    const html = await renderFrontDoor();
    expect(html).toContain(
      'frontDoor.about.introWithSetter(climbName=Test Climb,board=Kilter Board Original,angle=40,grade=V5,setter=setter-person)',
    );
    expect(html).toContain('frontDoor.about.sendsHere(count=12,formattedCount=12)');
  });

  it('pins the BreadcrumbList crumbs, board name included', async () => {
    const html = await renderFrontDoor();
    const items = breadcrumbItems(html);

    // Home → board list → this climb, in that order, and nothing else.
    expect(items.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(items[2].name).toBe('Test Climb');
    // Casing is pinned deliberately. The board crumb reaches the payload through
    // `formatBoardDisplayName`, so the name a crawler reads is "Kilter", not the
    // lowercase `board_name` column value — the trademark rule applies to the
    // crumb the reader sees, and structured data must not drift from it.
    expect(items[1].name).toContain('boardName=Kilter');
    expect(items[1].name).not.toContain('boardName=kilter');
    // Twice: once in the payload, once as the visible crumb.
    expect(html.split(items[1].name).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('keeps an alternate angle at 200 but omits entity and breadcrumb JSON-LD', async () => {
    const html = await renderFrontDoor({ ...PARAMS, angle: '25' });

    // `<h1[\s>]`, not a bare `<h1>`: the heading renders through `Typography
    // component="h1"`, which lands a class attribute on the real tag.
    expect(html).toMatch(/<h1[\s>]/);
    expect(html).not.toContain('"@type":"CreativeWork"');
    expect(html).not.toContain('"@type":"BreadcrumbList"');
  });

  it('emits at least three internal links', async () => {
    const html = await renderFrontDoor();
    const internalHrefs = html.match(/href="\/[^"]*"/g) ?? [];
    expect(internalHrefs.length).toBeGreaterThanOrEqual(3);
  });

  it('points the CTA at APP_URL plus the same pathname, with no query string', async () => {
    const html = await renderFrontDoor();
    const ctaHref = html.match(/href="(https:\/\/app\.boardsesh\.com[^"]*)"/)?.[1];

    expect(ctaHref).toBe('https://app.boardsesh.com/b/my-board/40/view/test-climb');
    expect(ctaHref).not.toContain('?');
  });

  it('describes a climb from its normalized current-angle quality and ascents', async () => {
    const creativeWork = creativeWorkPayload(await renderFrontDoor());

    expect(creativeWork.description).toBe(JSON_LD_DESCRIPTION);
  });

  it('carries the meta description verbatim, so the two can never disagree', async () => {
    const creativeWork = creativeWorkPayload(await renderFrontDoor());
    const metadata = await pageModule.generateMetadata({
      searchParams: Promise.resolve({}),
      params: Promise.resolve(PARAMS),
    });

    expect(creativeWork.description).toBe(metadata.description);
  });

  it("links the JSON-LD author to the setter's page and pictures the climb with its share card", async () => {
    const creativeWork = creativeWorkPayload(await renderFrontDoor());
    const metadata = await pageModule.generateMetadata({
      searchParams: Promise.resolve({}),
      params: Promise.resolve(PARAMS),
    });
    const [ogImage] = (metadata.openGraph?.images ?? []) as Array<{ url: string }>;

    expect(creativeWork.author).toEqual({
      '@type': 'Person',
      name: 'setter-person',
      url: 'https://www.boardsesh.com/setter/setter-person',
    });
    // The card `og:image` names, not the holds render the page draws.
    expect(creativeWork.image).toBe(ogImage.url);
    expect(String(creativeWork.image)).not.toContain('variant=overlay');
    expect(vi.mocked(buildOgBoardRenderUrl)).toHaveBeenCalledWith(
      expect.objectContaining({ board_name: 'kilter', layout_id: 1, size_id: 7 }),
      'p1r12',
      expect.objectContaining({ angle: 40, name: 'Test Climb', setter: 'setter-person' }),
    );
    expect(creativeWork).not.toHaveProperty('aggregateRating');
  });

  it('states no rating when the current angle has no quality, instead of inventing 0/5', async () => {
    vi.mocked(getClimbStatsForAllAngles).mockResolvedValueOnce([
      { ...CURRENT_ANGLE_STATS, quality_average: null, rating_count: '0' },
    ]);

    expect(creativeWorkPayload(await renderFrontDoor()).description).toBe(UNRATED_JSON_LD_DESCRIPTION);
  });

  it('states no rating when current-angle quality is not normalized to five stars', async () => {
    vi.mocked(getClimbStatsForAllAngles).mockResolvedValueOnce([
      { ...CURRENT_ANGLE_STATS, quality_average: '2.40', quality_normalized: false },
    ]);

    expect(creativeWorkPayload(await renderFrontDoor()).description).toBe(UNRATED_JSON_LD_DESCRIPTION);
  });
});

// #4494: setter-written notes are the one genuinely unique piece of prose on a
// climb page, and until now they were stored and rendered nowhere.
describe('setter notes on the climb front door', () => {
  afterEach(() => {
    climbRow.description = null;
  });

  it('SSR-emits a heading and the setter prose, verbatim', async () => {
    climbRow.description = 'Match the rail, then a big move to the jug.';
    const html = await renderFrontDoor();

    expect(html).toContain('frontDoor.setterNotes.heading');
    expect(html).toContain('Match the rail, then a big move to the jug.');
  });

  it('emits neither the heading nor an empty block when the setter wrote nothing', async () => {
    climbRow.description = '';
    expect(await renderFrontDoor()).not.toContain('frontDoor.setterNotes.heading');

    climbRow.description = null;
    expect(await renderFrontDoor()).not.toContain('frontDoor.setterNotes.heading');
  });

  it('drops a description that is only a restatement of "no match"', async () => {
    for (const restatement of ['No match', 'No match\n', 'No matching.']) {
      climbRow.description = restatement;
      expect(await renderFrontDoor()).not.toContain('frontDoor.setterNotes.heading');
    }
  });

  it('keeps real setter beta that merely mentions matching', async () => {
    climbRow.description = 'No Houdini swap, spin around pls:). No matching.';
    const html = await renderFrontDoor();

    expect(html).toContain('frontDoor.setterNotes.heading');
    expect(html).toContain('No Houdini swap, spin around pls:). No matching.');
  });

  it('still carries exactly one <h1> with the notes rendered', async () => {
    climbRow.description = 'Match the rail, then a big move to the jug.';
    const html = await renderFrontDoor();

    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
  });

  it('leaves the JSON-LD description as the synthesised catalogue string', async () => {
    climbRow.description = 'Match the rail, then a big move to the jug.';
    const creativeWork = creativeWorkPayload(await renderFrontDoor());

    expect(creativeWork.description).toBe(JSON_LD_DESCRIPTION);
  });
});

describe('an alias URL', () => {
  const canonicalUuid = 'abcdef1234567890abcdef1234567890';
  const aliasUuid = '11112222333344445555666677778888';
  const canonicalRow = {
    uuid: canonicalUuid,
    name: 'Test Climb',
    difficulty: 'V5',
    setter_username: 'setter-person',
    quality_average: '4.20',
    ascensionist_count: 12,
    frames: 'p1r12',
    description: null,
  };

  it.each([aliasUuid, `old-name-${aliasUuid}`])(
    '308s alias %s within the same saved board and angle',
    async (requestedClimb) => {
      const { getClimb } = await import('@/app/lib/data/queries');
      vi.mocked(getClimb).mockResolvedValueOnce(canonicalRow as never);
      const outcome = await renderFrontDoor({ ...PARAMS, angle: '25', climb_uuid: requestedClimb }).catch(
        (error: unknown) => error,
      );
      expect(getRedirectStatusCodeFromError(requireRedirectError(outcome))).toBe(308);
      expect(getURLFromRedirectError(requireRedirectError(outcome))).toBe(
        constructBoardSlugViewUrl('my-board', 25, canonicalUuid, 'Test Climb'),
      );
    },
  );

  it('preserves locale and redirects a non-Latin alias to the bare canonical UUID', async () => {
    const { getClimb } = await import('@/app/lib/data/queries');
    const { getLocale } = await import('@/app/lib/i18n/get-locale');
    vi.mocked(getLocale).mockResolvedValueOnce('de');
    vi.mocked(getClimb).mockResolvedValueOnce({ ...canonicalRow, name: 'Скала' } as never);
    const outcome = await renderFrontDoor({ ...PARAMS, climb_uuid: aliasUuid }).catch((error: unknown) => error);
    expect(getRedirectStatusCodeFromError(requireRedirectError(outcome))).toBe(308);
    expect(getURLFromRedirectError(requireRedirectError(outcome))).toBe(
      `/de${constructBoardSlugViewUrl('my-board', 40, canonicalUuid, 'Скала')}`,
    );
  });

  it('renders the canonical landing once and reads its stats, similar climbs and beta', async () => {
    const { getClimb } = await import('@/app/lib/data/queries');
    const { getFrontDoorSimilarClimbs, getFrontDoorBetaLinks } = await import('@/app/lib/data/front-door-data.server');
    vi.mocked(getClimb)
      .mockResolvedValueOnce(canonicalRow as never)
      .mockResolvedValueOnce(canonicalRow as never);
    const outcome = await renderFrontDoor({ ...PARAMS, climb_uuid: aliasUuid }).catch((error: unknown) => error);
    const target = getURLFromRedirectError(requireRedirectError(outcome));
    if (!target) throw new Error('Expected canonical redirect');
    const landingSegment = target.split('/').at(-1)!;
    expect(extractUuidFromSlug(landingSegment)).toBe(canonicalUuid);
    vi.mocked(getClimbStatsForAllAngles).mockClear();
    vi.mocked(getFrontDoorSimilarClimbs).mockClear();
    vi.mocked(getFrontDoorBetaLinks).mockClear();
    const html = await renderFrontDoor({ ...PARAMS, climb_uuid: landingSegment });
    expect(html).toContain('<h1');
    expect(vi.mocked(getClimbStatsForAllAngles)).toHaveBeenCalledWith('kilter', canonicalUuid);
    expect(vi.mocked(getFrontDoorSimilarClimbs)).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: canonicalUuid }),
    );
    expect(vi.mocked(getFrontDoorBetaLinks)).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: canonicalUuid }),
    );
    expect(html).toContain(`https://app.boardsesh.com${target}`);
  });
});

describe('the CTA strips the locale prefix (accepted regression)', () => {
  it('sends an /es reader to the English app route, not one the app does not have', async () => {
    const { buildAppHandoffUrl } = await import('@/app/lib/app-handoff');
    const path = '/b/my-board/40/view/test-climb';

    // The Expo app has no `/es`, `/fr` or `/de` routing. Recorded in the
    // reposition epic as an accepted regression, pinned here so nobody
    // "fixes" it into a 404 on app.boardsesh.com.
    expect(buildAppHandoffUrl(`/es${path}`)).toBe(buildAppHandoffUrl(path));
    expect(buildAppHandoffUrl(`/es${path}`)).toBe(`https://app.boardsesh.com${path}`);
  });
});
