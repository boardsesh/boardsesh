import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import ClimbViewSeoFragment from '@/app/components/climb-detail/climb-view-seo-fragment';

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
  })),
  getClimbStatsForAllAngles: vi.fn(async () => [
    {
      angle: 40,
      ascensionist_count: '12',
      quality_average: '4.20',
      difficulty_average: 20,
      display_difficulty: 20,
      fa_username: 'first-ascensionist',
      fa_at: '2024-03-01T00:00:00.000Z',
      difficulty: 'V5',
    },
    {
      angle: 25,
      ascensionist_count: '4',
      quality_average: '3.80',
      difficulty_average: 17,
      display_difficulty: 17,
      fa_username: null,
      fa_at: null,
      difficulty: 'V3',
    },
  ]),
}));

vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => []),
  getFrontDoorBetaLinks: vi.fn(async () => []),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOverlayWarming: vi.fn() }));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render?variant=overlay'),
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
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

/**
 * `renderToString` can't await async server components, so expand them first:
 * walk the element tree and replace every async function component with what it
 * resolves to, leaving sync components (the client islands and MUI's `Box`)
 * for `renderToString` to render normally. `AsyncFunction` is the
 * discriminator — invoking a client component outside a render would blow up on
 * its first hook.
 *
 * `stopAt` holds back components the caller wants to observe by identity rather
 * than by output.
 */
function isAsyncComponent(type: unknown): boolean {
  return (
    typeof type === 'function' && (type as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction'
  );
}

async function resolveServerTree(
  node: React.ReactNode,
  stopAt: ReadonlySet<unknown> = new Set(),
): Promise<React.ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveServerTree(child, stopAt)));
  if (!React.isValidElement(node)) return node;

  const element = node as React.ReactElement<{ children?: React.ReactNode }>;
  if (isAsyncComponent(element.type) && !stopAt.has(element.type)) {
    const produced = await (element.type as (props: unknown) => Promise<unknown>)(element.props);
    if (React.isValidElement(produced)) return resolveServerTree(produced, stopAt);
    return (produced ?? null) as React.ReactNode;
  }

  const { children } = element.props;
  if (children === undefined) return element;
  return React.cloneElement(element, undefined, await resolveServerTree(children, stopAt));
}

async function renderFrontDoor(): Promise<string> {
  const element = (await pageModule.default({ params: Promise.resolve(PARAMS) })) as React.ReactElement;
  return renderToString(<>{await resolveServerTree(element)}</>);
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
