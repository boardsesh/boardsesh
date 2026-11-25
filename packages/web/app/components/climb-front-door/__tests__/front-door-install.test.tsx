import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { buildStoreUrl } from '@/app/lib/store-links';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { MarketingPreviewProvider } from '@/app/components/marketing/marketing-preview-provider';
import type { BoardImageDetails, Climb } from '@/app/lib/types';
import type { HandoffTree } from '../climb-handoff-cta';

/**
 * #6027: a climb page and a climb list each ship a store link in their first
 * HTML, beside the hand-off, with their own link id.
 *
 * On the climb page the store is the official badge below md (both stores
 * stacked in one cell, CSS showing one), and the hand-off is a text link there
 * and the filled button from md, next to a QR code for the phone.
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

// The app module's and the board list's 30-day line: one cached read, here a
// fixed answer.
vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  cachedCommunityStats: vi.fn(async () => ({ climbersLast30Days: 3249, litLast30Days: 205_800 })),
}));

// What the root layout's provider gives a cold server render: no answer yet.
vi.mock('@/app/components/consent/consent-state-provider', () => ({
  useConsent: () => ({ granted: false, snapshot: { record: null }, dialogOpen: false }),
}));

// The real code is a wall of `<path>`; the URL it encodes is what is under test.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, ...svgProps }: { value: string } & React.SVGProps<SVGSVGElement>) => (
    <svg data-qr-value={value} role={svgProps.role} aria-label={svgProps['aria-label']} />
  ),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// Every band of the two pages except the hand-off block under test.
vi.mock('../front-door-breadcrumb', () => ({ default: () => null }));
vi.mock('../climb-creative-work-json-ld', () => ({
  default: ({ canonicalClimbUrl }: { canonicalClimbUrl: string }) => <meta data-climb-canonical={canonicalClimbUrl} />,
}));
vi.mock('../climb-list-json-ld', () => ({ default: () => null }));
vi.mock('../angle-table', () => ({ default: () => null }));
vi.mock('../about-climb', () => ({ default: () => null }));
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
const { climbQrUrl, listQrUrl } = await import('@/app/lib/gym-attribution');
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
  backgroundImagePaths: [],
  boardHeight: 1350,
} as unknown as BoardImageDetails;

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

async function renderClimbPage(tree: HandoffTree, climb = CLIMB): Promise<string> {
  const element = await ClimbFrontDoor({
    climb,
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

/** The server HTML as a document, so the assertions can ask where a button sits. */
function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
}

/**
 * The phone's store link: the official badge of each store, both in the HTML.
 * Only one is ever on show (CSS picks it), so both are the lone badge's 48px,
 * and black: the page shows another store pair further down, and Apple allows
 * its white badge only when it is the page's one store badge.
 */
function expectPhoneBadges(page: Document) {
  const badges = [...page.querySelectorAll('[data-cta="mobile-install"] a[data-store-badge] > img')].map((image) => ({
    store: image.parentElement?.getAttribute('data-store-badge'),
    src: image.getAttribute('src'),
    alt: image.getAttribute('alt'),
    height: image.getAttribute('height'),
  }));
  expect(badges).toEqual([
    {
      store: 'ios',
      src: '/images/store-badges/app-store-black-en-US.svg',
      alt: 'home.hero.ctaInstallIos',
      height: '48',
    },
    {
      store: 'android',
      src: '/images/store-badges/google-play-en-US.svg',
      alt: 'home.hero.ctaInstallAndroid',
      height: '48',
    },
  ]);
}

describe.each(TREES)('climb page store button, %s tree', (tree) => {
  it('ships a store link with the climb-view link id in the server HTML', async () => {
    const html = await renderClimbPage(tree);

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-view' })));
    expect(html).toContain('ct=climb-view');
    expect(html).toContain('frontDoor.cta.getAppHelper');
    expectPhoneBadges(parseHtml(html));
  });

  it('puts both stores in the one mobile cell, and the store first', async () => {
    const html = await renderClimbPage(tree);
    const mobileInstall = parseHtml(html).querySelector('[data-cta="mobile-install"]');
    const storeHrefs = [...(mobileInstall?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href'));

    expect(storeHrefs).toEqual([
      buildStoreUrl('ios', { placement: 'climb-view' }),
      buildStoreUrl('android', { placement: 'climb-view' }),
    ]);
    // The store comes first: on a phone it is the page's primary action.
    expect(html.indexOf('data-cta="mobile-install"')).toBeLessThan(html.indexOf('data-cta="handoff"'));
  });

  it('keeps the hand-off, still pointing at the app, with both of its labels', async () => {
    const page = parseHtml(await renderClimbPage(tree));
    const handoff = page.querySelector('[data-cta="handoff"]');

    expect(handoff?.getAttribute('href')).toBe(`https://app.boardsesh.com${HANDOFF_PATHS[tree]}`);
    // No aria-label: the visible text at each width is the name (WCAG 2.5.3).
    expect(handoff?.hasAttribute('aria-label')).toBe(false);
    expect(handoff?.textContent).toContain('frontDoor.cta.openInBrowserMobile');
    expect(handoff?.textContent).toContain('frontDoor.cta.openInBrowser');
  });

  it('uses the compatible canonical configuration in structured data and keeps the hand-off context', async () => {
    const page = parseHtml(
      await renderClimbPage(tree, { ...CLIMB, compatibleSizeIds: [7, 10], requiredSetIds: [1, 20] }),
    );

    expect(page.querySelector('meta[data-climb-canonical]')?.getAttribute('data-climb-canonical')).toBe(
      '/kilter/original/12x14-commercial/screw_bolt/40/view/test-climb-CLIMB-UNDER-TEST',
    );
    expect(page.querySelector('[data-cta="handoff"]')?.getAttribute('href')).toBe(
      `https://app.boardsesh.com${HANDOFF_PATHS[tree]}`,
    );
  });

  it('renders no filled button: the phone gets the store badge, and the hand-off is not a contained button', async () => {
    const page = parseHtml(await renderClimbPage(tree));

    expect(page.querySelectorAll('.MuiButton-contained')).toHaveLength(0);
    expect(page.querySelector('[data-cta="mobile-install"] .MuiButton-root')).toBeNull();
    expectPhoneBadges(page);
    expect(page.querySelector('[data-cta="handoff"]')?.classList.contains('MuiButton-contained')).toBe(false);
    // The app module's second store pair is the official badges: no second filled action.
    expect(page.querySelectorAll('[data-cta="app-install"] img[src^="/images/store-badges/"]')).toHaveLength(2);
    expect(page.querySelector('[data-cta="app-install"] .MuiButton-root')).toBeNull();
  });

  it('ships the app module its own store pair, with its own link id, that keeps the sticky bar down', async () => {
    const page = parseHtml(await renderClimbPage(tree));
    const appInstall = page.querySelector('[data-cta="app-install"]');
    const storeHrefs = [...(appInstall?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href'));

    expect(storeHrefs).toEqual([
      buildStoreUrl('ios', { placement: 'climb-app-module' }),
      buildStoreUrl('android', { placement: 'climb-app-module' }),
    ]);
    expect(appInstall?.hasAttribute('data-sticky-install-hide')).toBe(true);
    // The module follows the climb, not the other way round.
    const html = page.body.innerHTML;
    expect(html.indexOf('data-cta="mobile-install"')).toBeLessThan(html.indexOf('data-cta="app-install"'));
  });

  it('shows a QR code that opens this climb on a phone, from the page it is on', async () => {
    const page = parseHtml(await renderClimbPage(tree));
    const code = page.querySelector('svg[data-qr-value]');

    expect(code?.getAttribute('data-qr-value')).toBe(climbQrUrl(HANDOFF_PATHS[tree], 'en-US'));
    expect(code?.getAttribute('data-qr-value')).toContain('?src=qr&medium=desktop');
    expect(code?.getAttribute('role')).toBe('img');
    expect(code?.getAttribute('aria-label')).toBe('frontDoor.qr.imageLabel');
    expect(page.body.textContent).toContain('frontDoor.qr.title');
  });

  it("gives the laptop's QR card store buttons their own link id", async () => {
    const html = await renderClimbPage(tree);

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-qr-card' })));
    expect(html).toContain(asAttribute(buildStoreUrl('android', { placement: 'climb-qr-card' })));
  });

  it('ships no sticky install bar in the server HTML, only its end marker', async () => {
    const page = parseHtml(await renderClimbPage(tree));

    expect(page.querySelector('[data-testid="sticky-install-bar"]')).toBeNull();
    expect(page.querySelectorAll('[data-sticky-install-end]')).toHaveLength(1);
    expect(page.querySelector('main > :last-child')?.hasAttribute('data-sticky-install-end')).toBe(true);
    expect(page.querySelector('[data-cta="mobile-install"]')?.hasAttribute('data-sticky-install-hide')).toBe(true);
  });
});

describe.each(TREES)('climb list store button, %s tree', (tree) => {
  it('ships a store link with the climb-list link id in the server HTML', async () => {
    const html = await renderListPage(tree);

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-list' })));
    expect(html).toContain('ct=climb-list');
    expect(html).toContain('list.frontDoor.cta.getAppHelper');
  });

  it('puts the store first on a phone: both store badges in the one cell, before the hand-off', async () => {
    const html = await renderListPage(tree);
    const page = parseHtml(html);
    const storeHrefs = [...page.querySelectorAll('[data-cta="mobile-install"] a')].map((link) =>
      link.getAttribute('href'),
    );

    expect(storeHrefs).toEqual([
      buildStoreUrl('ios', { placement: 'climb-list' }),
      buildStoreUrl('android', { placement: 'climb-list' }),
    ]);
    expect(html.indexOf('data-cta="mobile-install"')).toBeLessThan(html.indexOf('data-cta="handoff"'));
    expectPhoneBadges(page);
    expect(page.querySelectorAll('.MuiButton-contained')).toHaveLength(0);
  });

  it('keeps the hand-off, still pointing at the app, with both of its labels', async () => {
    const handoff = parseHtml(await renderListPage(tree)).querySelector('[data-cta="handoff"]');

    expect(handoff?.getAttribute('href')).toBe(`https://app.boardsesh.com${LIST_PATHS[tree]}`);
    // No aria-label: the visible text at each width is the name (WCAG 2.5.3).
    expect(handoff?.hasAttribute('aria-label')).toBe(false);
    // The list's own words, not the climb page's "open it".
    expect(handoff?.textContent).toContain('list.frontDoor.cta.openInBrowserMobile');
    expect(handoff?.textContent).toContain('list.frontDoor.cta.openInBrowser');
  });

  it('shows a QR code that opens this list on a phone, from the page it is on', async () => {
    const page = parseHtml(await renderListPage(tree));
    const codes = page.querySelectorAll('svg[data-qr-value]');

    expect(codes).toHaveLength(1);
    expect(codes[0].getAttribute('data-qr-value')).toBe(listQrUrl(LIST_PATHS[tree], 'en-US'));
    expect(codes[0].getAttribute('data-qr-value')).toContain('/list?src=qr&medium=desktop');
    expect(codes[0].getAttribute('aria-label')).toBe('list.frontDoor.qr.imageLabel');
    expect(page.body.textContent).toContain('list.frontDoor.qr.title');
  });

  it("gives the laptop's QR card store buttons their own link id", async () => {
    const html = await renderListPage(tree);

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-list-qr-card' })));
    expect(html).toContain(asAttribute(buildStoreUrl('android', { placement: 'climb-list-qr-card' })));
  });

  it('has one call to action: no second store block at the end of the page', async () => {
    const page = parseHtml(await renderListPage(tree));

    expect(page.querySelectorAll('[data-cta="handoff"]')).toHaveLength(1);
    expect(page.querySelectorAll('[data-cta="mobile-install"]')).toHaveLength(1);
    // The phone's pair plus the QR card's pair: every store link on the page.
    expect(page.querySelectorAll('a[href*="apps.apple.com"]')).toHaveLength(2);
    expect(page.querySelectorAll('a[href*="play.google.com"]')).toHaveLength(2);
    // The climbs come last: nothing but the pagination follows the list.
    expect(page.querySelector('main')?.textContent?.trim().endsWith('list.frontDoor.pagination.next')).toBe(true);
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
    // The mobile button's store is picked by CSS, then by the browser after
    // mount: whoever populated the cache must not have picked it for everyone.
    expect(html).not.toContain('data-store=');
    expect(parseHtml(html).querySelectorAll('[data-cta="mobile-install"] [data-store-link]')).toHaveLength(2);
  });

  it('renders the same app screenshots whoever populated the cache', async () => {
    const showcaseFor = async (userAgent: string) => {
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
        <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(userAgent)}>
          {page}
        </MarketingPreviewProvider>,
      );
      return parseHtml(html).querySelector('section[aria-labelledby="climb-app-showcase-heading"]')?.outerHTML;
    };

    const fromGooglebot = await showcaseFor(GOOGLEBOT_SMARTPHONE_UA);
    expect(fromGooglebot).toContain('data-marketing-shot="wall-status"');
    expect(await showcaseFor(IPHONE_UA)).toBe(fromGooglebot);
    expect(await showcaseFor(DESKTOP_UA)).toBe(fromGooglebot);
    expect(await showcaseFor('')).toBe(fromGooglebot);
  });

  it('ships both stores on a cached list page too', async () => {
    const html = await renderListPage('slug');

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'climb-list' })));
    expect(html).toContain(asAttribute(buildStoreUrl('android', { placement: 'climb-list' })));
  });
});
