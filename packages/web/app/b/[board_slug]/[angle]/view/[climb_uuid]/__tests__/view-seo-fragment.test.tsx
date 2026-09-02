import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { getClimbStatsForAllAngles, type ClimbStatsForAngle } from '@/app/lib/data/queries';

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
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));

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

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
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
  getFrontDoorSimilarClimbs: vi.fn(async () => []),
  getFrontDoorBetaLinks: vi.fn(async () => []),
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
  hasDarkBoardArt: (board: string) => board === 'woods',
}));

// Below-the-fold client islands. They are not what this file asserts, and
// mounting them under `renderToString` would drag React Query and the socket
// providers into a node test.
vi.mock('@/app/components/similar-climbs/similar-climbs-list', () => ({ default: () => null }));
vi.mock('@/app/components/social/climb-social-section', () => ({ default: () => null }));
vi.mock('@/app/components/beta-videos/boardsesh-beta-list', () => ({ default: () => null }));

const pageModule = await import('../page');

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
  const element = (await pageModule.default({ params: Promise.resolve(params) })) as React.ReactElement;
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
    const element = (await pageModule.default({ params: Promise.resolve(PARAMS) })) as React.ReactElement;
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

  it('cross-links the other angles and does not self-link the current one', async () => {
    const html = await renderFrontDoor();
    // 25° is a real link; 40° — the angle being viewed — must not be one.
    expect(html).toMatch(/href="\/kilter\/[^"]*\/25\/view\//);
    expect(html).not.toMatch(/href="\/kilter\/[^"]*\/40\/view\//);
    expect(html).toContain('aria-current="page"');
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

    expect(creativeWork.description).toBe(
      'metadata.view.description(climbName=Test Climb,grade=V5,setter=setter-person,quality=4.20,ascents=12)',
    );
  });

  it('omits the description when the current angle has no quality instead of inventing 0/5', async () => {
    vi.mocked(getClimbStatsForAllAngles).mockResolvedValueOnce([
      { ...CURRENT_ANGLE_STATS, quality_average: null, rating_count: '0' },
    ]);

    expect(creativeWorkPayload(await renderFrontDoor())).not.toHaveProperty('description');
  });

  it('omits the description when current-angle quality is not normalized to five stars', async () => {
    vi.mocked(getClimbStatsForAllAngles).mockResolvedValueOnce([
      { ...CURRENT_ANGLE_STATS, quality_average: '2.40', quality_normalized: false },
    ]);

    expect(creativeWorkPayload(await renderFrontDoor())).not.toHaveProperty('description');
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

    expect(creativeWork.description).toBe(
      'metadata.view.description(climbName=Test Climb,grade=V5,setter=setter-person,quality=4.20,ascents=12)',
    );
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
