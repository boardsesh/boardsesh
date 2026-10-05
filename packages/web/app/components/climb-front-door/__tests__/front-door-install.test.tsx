import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { buildStoreUrl } from '@/app/lib/store-links';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { MarketingPreviewProvider } from '@/app/components/marketing/marketing-preview-provider';
import type { BoardDetails, Climb } from '@/app/lib/types';
import type { HandoffTree } from '../climb-handoff-cta';

/**
 * #6027: a climb page and a climb list each ship a store link in their first
 * HTML, beside the hand-off, with their own link id.
 *
 * Rendered with `renderToString`, which is what a crawler and a reader with
 * JavaScript off get, and what the shared CDN cache stores. So the assertions
 * are on the server markup: a real anchor, the placement in the URL, and no
 * visitor-specific campaign in it.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

vi.mock('@/app/lib/analytics', () => ({ track: vi.fn(), trackBeforeNavigation: vi.fn() }));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// Every band of the two pages except the hand-off block under test.
vi.mock('../front-door-breadcrumb', () => ({ default: () => null }));
vi.mock('../climb-creative-work-json-ld', () => ({ default: () => null }));
vi.mock('../climb-list-json-ld', () => ({ default: () => null }));
vi.mock('../climb-facts', () => ({ default: () => null }));
vi.mock('../angle-cross-links', () => ({ default: () => null }));
vi.mock('@/app/components/climb-detail/climb-view-seo-fragment', () => ({ default: () => null }));
vi.mock('@/app/components/similar-climbs/similar-climbs-list', () => ({ default: () => null }));
vi.mock('@/app/components/social/climb-social-section', () => ({ default: () => null }));
vi.mock('@/app/components/beta-videos/boardsesh-beta-list', () => ({ default: () => null }));
vi.mock('@/app/components/climb-list/static-climb-list', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildBoardArtLayers: vi.fn(() => ({ backgroundUrls: [], overlayUrl: null })),
  toDarkArtUrl: (url: string) => url,
}));

const ClimbFrontDoor = (await import('../climb-front-door')).default;
const StaticListFrontDoor = (await import('../static-list-front-door')).default;

const BOARD_DETAILS = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  layout_name: 'Kilter Board Original',
  size_name: '12 x 12',
  set_names: ['Bolt Ons', 'Screw Ons'],
  boardWidth: 1080,
  boardHeight: 1350,
} as unknown as BoardDetails;

const CLIMB = {
  uuid: 'CLIMB-UNDER-TEST',
  name: 'Test Climb',
  difficulty: 'V5',
  setter_username: 'setter-person',
  frames: 'p1r12',
  description: null,
} as unknown as Climb;

const HANDOFF_PATHS: Record<HandoffTree, string> = {
  'config-tuple': '/kilter/1/10/1,20/40/view/CLIMB-UNDER-TEST',
  slug: '/b/my-garage-board/40/view/CLIMB-UNDER-TEST',
};

const LIST_PATHS: Record<HandoffTree, string> = {
  'config-tuple': '/kilter/1/10/1,20/40/list',
  slug: '/b/my-garage-board/40/list',
};

const GOOGLEBOT_SMARTPHONE_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const TREES: HandoffTree[] = ['config-tuple', 'slug'];

/** The attribute as React writes it: `&` in a URL is `&amp;` in markup. */
function asAttribute(url: string): string {
  return `href="${url.replaceAll('&', '&amp;')}"`;
}

async function renderClimbPage(tree: HandoffTree): Promise<string> {
  const element = await ClimbFrontDoor({
    climb: CLIMB,
    boardDetails: BOARD_DETAILS,
    boardSlug: tree === 'slug' ? 'my-garage-board' : undefined,
    angle: 40,
    canonicalAngle: 40,
    angleStats: [],
    similarClimbs: { status: 'loaded', items: [] },
    betaLinks: { status: 'loaded', items: [] },
    handoffPath: HANDOFF_PATHS[tree],
    tree,
  });
  return renderToString(<>{await resolveServerTree(element)}</>);
}

async function renderListPage(tree: HandoffTree): Promise<string> {
  const element = await StaticListFrontDoor({
    boardDetails: BOARD_DETAILS,
    boardSlug: tree === 'slug' ? 'my-garage-board' : undefined,
    angle: 40,
    climbs: [],
    hasMore: false,
    page: 1,
    basePath: LIST_PATHS[tree],
    tree,
  });
  return renderToString(<>{await resolveServerTree(element)}</>);
}

describe.each(TREES)('climb page store button, %s tree', (tree) => {
  it('ships a store link with the climb-view link id in the server HTML', async () => {
    const html = await renderClimbPage(tree);

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-view' })));
    expect(html).toContain('ct=climb-view');
    expect(html).toContain('home.hero.ctaInstallIos');
    expect(html).toContain('frontDoor.install.helper');
  });

  it('keeps the hand-off beside it, still pointing at the app', async () => {
    const html = await renderClimbPage(tree);

    expect(html).toContain('frontDoor.cta.climbThis');
    expect(html).toContain(`href="https://app.boardsesh.com${HANDOFF_PATHS[tree]}"`);
    // The hand-off comes first: it is the page's primary action.
    expect(html.indexOf('frontDoor.cta.climbThis')).toBeLessThan(html.indexOf('frontDoor.install.helper'));
  });

  it('leaves the hand-off as the only filled button', async () => {
    const html = await renderClimbPage(tree);

    expect(html.match(/MuiButton-contained[\s"]/g) ?? []).toHaveLength(1);
  });
});

describe.each(TREES)('climb list store button, %s tree', (tree) => {
  it('ships a store link with the climb-list link id in the server HTML', async () => {
    const html = await renderListPage(tree);

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-list' })));
    expect(html).toContain('ct=climb-list');
    expect(html).toContain('list.frontDoor.install.helper');
  });

  it('keeps the hand-off beside it, still pointing at the app', async () => {
    const html = await renderListPage(tree);

    expect(html).toContain(`href="https://app.boardsesh.com${LIST_PATHS[tree]}"`);
    expect(html.indexOf('list.frontDoor.cta')).toBeLessThan(html.indexOf('list.frontDoor.install.helper'));
  });
});

describe('a cached front door', () => {
  it('renders the same store links whatever campaign the first visitor arrived on', async () => {
    // The page is cached with no session split, so its HTML cannot carry one
    // visitor's source. The tagged link is a post-hydration upgrade only.
    const html = await renderClimbPage('config-tuple');

    expect(html).not.toContain('utm_source=chatgpt');
    expect(html).toContain(asAttribute(buildStoreUrl('android', { placement: 'climb-view' })));
  });

  // The root layout seeds the provider from the user agent of the REQUEST, and
  // the edge stores the resulting HTML for 24 hours with no user-agent split.
  // Whoever asks first must not decide which store everyone after them gets.
  it.each([
    ['Googlebot Smartphone', GOOGLEBOT_SMARTPHONE_UA],
    ['an iPhone', IPHONE_UA],
    ['a desktop', DESKTOP_UA],
    ['no user agent at all', ''],
  ])('ships both stores when %s populated the cache', async (_requester, userAgent) => {
    const page = await resolveServerTree(
      await ClimbFrontDoor({
        climb: CLIMB,
        boardDetails: BOARD_DETAILS,
        angle: 40,
        canonicalAngle: 40,
        angleStats: [],
        similarClimbs: { status: 'loaded', items: [] },
        betaLinks: { status: 'loaded', items: [] },
        handoffPath: HANDOFF_PATHS['config-tuple'],
        tree: 'config-tuple',
      }),
    );
    const html = renderToString(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(userAgent)}>{page}</MarketingPreviewProvider>,
    );

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-view' })));
    expect(html).toContain(asAttribute(buildStoreUrl('android', { placement: 'climb-view' })));
    expect(html).toContain('home.hero.ctaInstallIos');
    expect(html).toContain('home.hero.ctaInstallAndroid');
  });

  it('ships both stores on a cached list page too', async () => {
    const html = await renderListPage('slug');

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-list' })));
    expect(html).toContain(asAttribute(buildStoreUrl('android', { placement: 'climb-list' })));
  });
});
