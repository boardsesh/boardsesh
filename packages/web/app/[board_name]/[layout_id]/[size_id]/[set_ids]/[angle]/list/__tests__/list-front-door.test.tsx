vi.mock('server-only', () => ({}));
import React from 'react';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import {
  FRONT_DOOR_MAX_INDEXABLE_PAGE,
  FRONT_DOOR_MAX_PAGE,
  FRONT_DOOR_PAGE_SIZE,
  frontDoorPagePath,
  isFrontDoorPageOutOfRange,
  isIndexableFrontDoorPage,
  parseFrontDoorPage,
} from '@/app/lib/seo/list-page-robots';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import type { BoardImageDetails, Climb } from '@/app/lib/types';

/**
 * The `/list` front door's `?page` contract, which both trees' pages consume.
 *
 * The per-page metadata assertions live next to each page
 * (`list/__tests__/page-metadata.test.tsx` and its `/b` twin); this file pins
 * the shared rules those two agree on, so a change to one page can't quietly
 * diverge from the other.
 */

const BASE = '/kilter/original/12x12-square/screw_bolt/40/list';

describe('front door pagination contract', () => {
  it('serves a page size that meets the ≥50-crawlable-links bar', () => {
    expect(FRONT_DOOR_PAGE_SIZE).toBeGreaterThanOrEqual(50);
  });

  it('treats a missing, empty or nonsense ?page as page 1', () => {
    expect(parseFrontDoorPage(undefined)).toBe(1);
    expect(parseFrontDoorPage('')).toBe(1);
    expect(parseFrontDoorPage('banana')).toBe(1);
    expect(parseFrontDoorPage('0')).toBe(1);
    expect(parseFrontDoorPage('-4')).toBe(1);
  });

  it('reads a repeated ?page=a&page=b as the first value', () => {
    expect(parseFrontDoorPage(['3', '9'])).toBe(3);
  });

  it('canonicalises ?page=1 onto the bare path — same page, one URL', () => {
    expect(frontDoorPagePath(BASE, 1)).toBe(BASE);
    expect(frontDoorPagePath(BASE, 2)).toBe(`${BASE}?page=2`);
  });

  it('keeps pages 1..10 indexable and drops out beyond', () => {
    for (let page = 1; page <= FRONT_DOOR_MAX_INDEXABLE_PAGE; page += 1) {
      expect(isIndexableFrontDoorPage(page)).toBe(true);
    }
    expect(isIndexableFrontDoorPage(FRONT_DOOR_MAX_INDEXABLE_PAGE + 1)).toBe(false);
    expect(isIndexableFrontDoorPage(500)).toBe(false);
  });

  it('clamps ?page above the hard ceiling instead of turning it into an unbounded offset', () => {
    // `fetchFrontDoorListPage` derives its OFFSET straight from this number, so
    // an unclamped `?page` is an unbounded `OFFSET` over the climb/stats join.
    expect(FRONT_DOOR_MAX_PAGE).toBeGreaterThan(FRONT_DOOR_MAX_INDEXABLE_PAGE);
    expect(parseFrontDoorPage(String(FRONT_DOOR_MAX_PAGE))).toBe(FRONT_DOOR_MAX_PAGE);
    expect(parseFrontDoorPage('5000')).toBe(FRONT_DOOR_MAX_PAGE);
    expect(parseFrontDoorPage('999999999')).toBe(FRONT_DOOR_MAX_PAGE);
  });

  it('reports anything past the hard ceiling as out of range, so the pages can 404 it', () => {
    expect(isFrontDoorPageOutOfRange(undefined)).toBe(false);
    expect(isFrontDoorPageOutOfRange('banana')).toBe(false);
    expect(isFrontDoorPageOutOfRange('1')).toBe(false);
    expect(isFrontDoorPageOutOfRange(String(FRONT_DOOR_MAX_PAGE))).toBe(false);
    expect(isFrontDoorPageOutOfRange(String(FRONT_DOOR_MAX_PAGE + 1))).toBe(true);
    expect(isFrontDoorPageOutOfRange('5000')).toBe(true);
    expect(isFrontDoorPageOutOfRange(['5000', '2'])).toBe(true);
  });
});

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

// Every prop a caller hands the link reaches the anchor, so `aria-label` and
// `aria-current` stay assertable.
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...anchorProps }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...anchorProps}>
      {children}
    </a>
  ),
}));

// The list rows and the call to action are asserted elsewhere
// (`front-door-install.test.tsx`), and both would drag client-side providers
// into a node render. The stub keeps the props the page hands the CTA.
const staticClimbListProps = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/climb-list/static-climb-list', () => ({
  default: (props: Record<string, unknown>) => {
    staticClimbListProps(props);
    return null;
  },
}));
vi.mock('@/app/components/climb-front-door/front-door-hero-cta', () => ({
  default: ({
    placement,
    qrLanding,
    qrUrl,
    labels,
  }: {
    placement: string;
    qrLanding?: string;
    qrUrl: string;
    labels: { storeHelper: string; qr: { imageLabel: string } };
  }) => (
    <div
      data-testid="hero-cta"
      data-placement={placement}
      data-qr-landing={qrLanding}
      data-qr-url={qrUrl}
      data-store-helper={labels.storeHelper}
      data-qr-image-label={labels.qr.imageLabel}
    />
  ),
}));
vi.mock('@/app/components/climb-front-door/qr-landing-tracker', () => ({
  default: ({ kind }: { kind: string }) => <span data-testid="qr-landing-tracker" data-kind={kind} />,
}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  cachedCommunityStats: vi.fn(async () => ({ climbersLast30Days: 3249, litLast30Days: 205_800 })),
}));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildBoardArtLayers: vi.fn((_boardDetails: unknown, frames: string) => ({
    backgroundUrls: [],
    overlayUrl: `/api/internal/board-render?frames=${frames}`,
  })),
  toDarkArtUrl: (url: string) => url,
}));

const StaticListFrontDoor = (await import('@/app/components/climb-front-door/static-list-front-door')).default;
const { listRailAngles } = await import('@/app/components/climb-front-door/list-angle-rail');
const { cachedCommunityStats } = await import('@/app/lib/graphql/server-cached-client');
const { listQrUrl } = await import('@/app/lib/gym-attribution');
const { buildCanonicalClimbViewUrl, constructBoardSlugViewUrl } = await import('@/app/lib/url-utils');
const { getServerTranslation } = await import('@/app/lib/i18n/server');
const { boardConfigForSearch } = await import('@/app/lib/seo/climb-display');

const boardDetails = {
  board_name: 'kilter',
  backgroundImagePaths: [],
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  layout_name: 'Kilter Board Original',
  boardWidth: 1080,
  boardHeight: 1170,
} as unknown as BoardImageDetails;

const FIRST_CLIMB = {
  uuid: 'FIRST-CLIMB',
  name: 'leistenliebe',
  difficulty: '7a/V6',
  frames: 'p1r12p2r13',
  angle: 40,
} as unknown as Climb;
const SECOND_CLIMB = { ...FIRST_CLIMB, uuid: 'SECOND-CLIMB', name: 'Jackie Blue', frames: 'p3r14' } as Climb;

type RenderOptions = {
  page?: number;
  hasMore?: boolean;
  noindex?: boolean;
  climbs?: Climb[];
  tree?: 'config-tuple' | 'slug';
};

// `FrontDoorBreadcrumb` is an async server component nested in the returned
// tree, and `renderToString` cannot suspend — expand the async layer first.
async function renderList({
  page = 1,
  hasMore = false,
  noindex = false,
  climbs = [],
  tree = 'config-tuple',
}: RenderOptions = {}): Promise<string> {
  const element = await StaticListFrontDoor({
    boardDetails,
    boardSlug: tree === 'slug' ? 'my-garage-board' : undefined,
    angle: 40,
    climbs,
    hasMore,
    page,
    basePath: tree === 'slug' ? '/b/my-garage-board/40/list' : BASE,
    tree,
    noindex,
  });
  return renderToString(<>{await resolveServerTree(element)}</>);
}

async function renderFrontDoor(page: number, hasMore: boolean, noindex = false): Promise<string> {
  return renderList({ page, hasMore, noindex });
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
}

describe('front door pagination anchors', () => {
  it('links onward while the next page is still indexable', async () => {
    const html = await renderFrontDoor(FRONT_DOOR_MAX_INDEXABLE_PAGE - 1, true);

    expect(html).toContain(`rel="next"`);
    expect(html).toContain(`href="${BASE}?page=${FRONT_DOOR_MAX_INDEXABLE_PAGE}"`);
  });

  it('stops the walk at the last indexable page even when more climbs exist', async () => {
    const html = await renderFrontDoor(FRONT_DOOR_MAX_INDEXABLE_PAGE, true);

    // `noindex, follow` past the cap is an explicit "keep following links", so a
    // `next` chain gated on `hasMore` alone would invite crawlers into a
    // corridor thousands of pages deep, each hop a deeper OFFSET.
    expect(html).not.toContain('rel="next"');
    expect(html).toContain(`href="${BASE}?page=${FRONT_DOOR_MAX_INDEXABLE_PAGE - 1}"`);
  });

  it('still walks a deep grace-band page BACK into the indexable set', async () => {
    const html = await renderFrontDoor(FRONT_DOOR_MAX_INDEXABLE_PAGE + 1, true);

    expect(html).not.toContain('rel="next"');
    expect(html).toContain('rel="prev"');
    expect(html).toContain(`href="${BASE}?page=${FRONT_DOOR_MAX_INDEXABLE_PAGE}"`);
  });

  it('offers no anchor at either end of the walk — a disabled control, not a dead link', async () => {
    const html = await renderFrontDoor(1, false);

    expect(html).not.toContain('rel="prev"');
    expect(html).not.toContain('rel="next"');
    // `\sdisabled=""`, not a bare `disabled` inside `[^>]*`: MUI also puts a
    // `Mui-disabled` token in the class list, so the loose form would pass on a
    // control that merely LOOKS inert while still being a focusable dead link.
    expect(html.match(/<button[^>]*\sdisabled=""/g) ?? []).toHaveLength(2);
  });
});

describe('front door breadcrumb', () => {
  it('gives the list page an upward link home', async () => {
    const html = await renderFrontDoor(1, false);

    expect(html).toContain('href="/"');
    expect(html).toContain('aria-current="page"');
  });

  it('links this board\'s app comparison, for searches like "kilter board app not working"', async () => {
    const document = parseHtml(await renderFrontDoor(1, false));
    expect(document.querySelector('a[href="/apps/kilter"]')?.textContent).toBe('boardAppGuideLink');
  });

  it('emits BreadcrumbList on page 1 of an indexed board', async () => {
    const html = await renderFrontDoor(1, false);

    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  it('omits BreadcrumbList past page 1 — those pages are self-canonical', async () => {
    // The crumbs describe the clean list URL. On `?page=2` that contradicts the
    // page's own canonical, so the visible crumbs stay and the schema does not.
    const html = await renderFrontDoor(2, true);

    expect(html).not.toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('aria-current="page"');
  });

  it('omits BreadcrumbList on a noindex board, which the CreativeWork payload also skips', async () => {
    const html = await renderFrontDoor(1, false, true);

    expect(html).not.toContain('"@type":"BreadcrumbList"');
  });
});

describe('front door stage: the first climb as the hero', () => {
  it("draws the first climb's full render as the LCP image, never lazy", async () => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB, SECOND_CLIMB] }));
    const art = page.querySelector('figure img[alt]');

    expect(art?.getAttribute('src')).toBe(`/api/internal/board-render?frames=${FIRST_CLIMB.frames}`);
    expect(art?.getAttribute('width')).toBe('1080');
    expect(art?.getAttribute('height')).toBe('1170');
    expect(art?.getAttribute('fetchpriority')).toBe('high');
    expect(art?.getAttribute('loading')).toBeNull();
    expect(art?.getAttribute('alt')).toBe('frontDoor.boardImageAlt');
    // One stage, for the first climb only.
    expect(page.querySelectorAll('figure')).toHaveLength(1);
  });

  it('names the climb under the art with a link to the same URL as its row, and its grade', async () => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB, SECOND_CLIMB] }));
    const caption = page.querySelector('[data-testid="list-stage-caption"]');
    const link = caption?.querySelector('a');

    expect(caption?.textContent).toContain('list.frontDoor.stage.caption');
    expect(link?.textContent).toBe('leistenliebe');
    expect(link?.getAttribute('href')).toBe(
      buildCanonicalClimbViewUrl(boardDetails, 40, FIRST_CLIMB.uuid, 'leistenliebe'),
    );
    // The chip is decoration; the grade is said in words for a screen reader.
    expect(caption?.querySelector('[aria-hidden="true"]')?.textContent).toBe('V6');
    expect(caption?.textContent).toContain('frontDoor.hero.gradeForSearch');
    // The caption link is the first climb link in <main>, which the public-page
    // journey clicks: it must land on a climb page.
    expect(page.querySelector('main a[href*="/view/"]')).toBe(link);
  });

  it('keeps the /b board in the caption link on the slug tree', async () => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB], tree: 'slug' }));

    expect(page.querySelector('[data-testid="list-stage-caption"] a')?.getAttribute('href')).toBe(
      constructBoardSlugViewUrl('my-garage-board', 40, FIRST_CLIMB.uuid, 'leistenliebe'),
    );
  });

  it('says "first on this page" past page 1', async () => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB], page: 2, hasMore: true }));

    expect(page.querySelector('[data-testid="list-stage-caption"]')?.textContent).toContain(
      'list.frontDoor.stage.captionLaterPage',
    );
  });

  it('shows no stage at all for an empty list', async () => {
    const page = parseHtml(await renderList({ climbs: [] }));

    expect(page.querySelector('figure')).toBeNull();
    expect(page.querySelector('[data-testid="list-stage-caption"]')).toBeNull();
  });

  it('keeps one h1, and the ItemList for the climbs it rendered', async () => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB, SECOND_CLIMB] }));

    expect(page.querySelectorAll('h1')).toHaveLength(1);
    expect(page.querySelector('h1')?.textContent).toBe('list.frontDoor.heading');
    const itemList = [...page.querySelectorAll('script[type="application/ld+json"]')].find((script) =>
      script.textContent?.includes('"ItemList"'),
    );
    expect(itemList?.textContent).toContain('FIRST-CLIMB');
    expect(itemList?.textContent).toContain('SECOND-CLIMB');
  });
});

describe('front door angle rail', () => {
  it.each([
    ['config-tuple', '/kilter/original/12x12-square/screw_bolt/25/list'],
    ['slug', '/b/my-garage-board/25/list'],
  ] as const)('links the same board at every other angle on the %s tree', async (tree, expected25Href) => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB], tree }));
    const rail = page.querySelector('nav[aria-labelledby]');
    const links = [...(rail?.querySelectorAll('a') ?? [])];

    // Kilter's angle table is 0°–70° in 5° steps: fourteen links and the page's own stop.
    expect(rail?.querySelectorAll('li')).toHaveLength(15);
    expect(links).toHaveLength(14);
    expect(links.map((link) => link.getAttribute('href'))).toContain(expected25Href);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/\/list$/);
      expect(link.getAttribute('aria-label')).toBe('list.frontDoor.angles.linkAria');
    }
  });

  it('marks the angle being read as the current page, as text rather than a self-link', async () => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB] }));
    const current = page.querySelector('nav[aria-labelledby] [aria-current="page"]');

    expect(current?.tagName).toBe('SPAN');
    expect(current?.textContent).toBe('list.frontDoor.angles.stop');
    expect(page.querySelector(`nav[aria-labelledby] a[href="${BASE}"]`)).toBeNull();
  });

  it('gives an angle off the table its own stop, in order', () => {
    expect(listRailAngles('moonboard', 40)).toEqual([25, 40]);
    expect(listRailAngles('moonboard', 30)).toEqual([25, 30, 40]);
    expect(listRailAngles('kilter', 42)).toContain(42);
  });
});

describe('front door call to action', () => {
  it.each([
    ['config-tuple', BASE, 'list'],
    ['slug', '/b/my-garage-board/40/list', 'board'],
  ] as const)('renders one CTA block on the %s tree, its QR code opening this list', async (tree, path, landing) => {
    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB], tree, page: 2, hasMore: true }));
    const ctas = page.querySelectorAll('[data-testid="hero-cta"]');

    expect(ctas).toHaveLength(1);
    expect(ctas[0].getAttribute('data-placement')).toBe('climb-list');
    // The QR code carries page 1 of the list the reader is on, with the desktop pair.
    expect(ctas[0].getAttribute('data-qr-url')).toBe(listQrUrl(path, 'en-US'));
    expect(ctas[0].getAttribute('data-qr-url')).toMatch(/\/list\?src=qr&medium=desktop$/);
    // `/b` keeps naming a kiosk or poster scan in the store link id; the
    // config-tuple list is only reached through its own laptop code.
    expect(ctas[0].getAttribute('data-qr-landing')).toBe(landing);
  });

  it('counts a scan of the list code on both trees', async () => {
    for (const tree of ['config-tuple', 'slug'] as const) {
      const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB], tree }));

      expect(page.querySelector('[data-testid="qr-landing-tracker"]')?.getAttribute('data-kind')).toBe('list');
    }
  });

  it('prints the site-wide 30-day line from the one cached read', async () => {
    vi.mocked(cachedCommunityStats).mockClear();
    const html = await renderList({ climbs: [FIRST_CLIMB] });

    expect(html).toContain('home.hero.proof');
    expect(cachedCommunityStats).toHaveBeenCalledTimes(1);
  });

  it('drops the line, not the page, when the numbers could not be read', async () => {
    vi.mocked(cachedCommunityStats).mockResolvedValueOnce(null);
    const html = await renderList({ climbs: [FIRST_CLIMB] });

    expect(html).not.toContain('home.hero.proof');
    expect(html).toContain('list.frontDoor.heading');
  });
});

describe('front door rows and names', () => {
  it("draws the rows as the app's grade-chip cards and leaves the high fetch priority to the hero art", async () => {
    staticClimbListProps.mockClear();
    await renderList({ climbs: [FIRST_CLIMB, SECOND_CLIMB] });

    expect(staticClimbListProps).toHaveBeenCalledTimes(1);
    expect(staticClimbListProps.mock.calls[0]?.[0]).toMatchObject({
      rowVariant: 'card',
      prioritizeFirstRow: false,
      virtualize: false,
    });
  });

  it('names the layout and size in the heading, intro, helper and QR label, as the page title does', async () => {
    const withBoardName = ((key: string, options?: { boardName?: string; board?: string }) =>
      `${key}[${options?.boardName ?? options?.board ?? ''}]`) as unknown as TFunction;
    vi.mocked(getServerTranslation).mockResolvedValueOnce({
      t: withBoardName,
      locale: 'en-US',
    } as unknown as Awaited<ReturnType<typeof getServerTranslation>>);
    const configName = boardConfigForSearch(boardDetails);

    const page = parseHtml(await renderList({ climbs: [FIRST_CLIMB] }));
    const cta = page.querySelector('[data-testid="hero-cta"]');

    // The size makes it this configuration's name, not every Kilter Original's.
    expect(configName).not.toBe('Kilter Board Original');
    expect(configName.startsWith('Kilter Board Original ')).toBe(true);
    expect(page.querySelector('h1')?.textContent).toBe(`list.frontDoor.heading[${configName}]`);
    expect(page.body.textContent).toContain(`list.frontDoor.intro[${configName}]`);
    expect(cta?.getAttribute('data-store-helper')).toBe(`list.frontDoor.cta.getAppHelper[${configName}]`);
    expect(cta?.getAttribute('data-qr-image-label')).toBe(`list.frontDoor.qr.imageLabel[${configName}]`);
  });
});
