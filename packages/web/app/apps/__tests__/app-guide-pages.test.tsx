import React, { type ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vite-plus/test';
import { APP_URL } from '@/app/lib/app-origin';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import {
  ALL_APP_GUIDE_PAGES,
  APP_GUIDE_COMPARISON,
  APP_GUIDE_HUB,
  APP_GUIDES,
  GATED_CLAIMS,
  getAppGuide,
  isClaimVisible,
} from '@/app/lib/seo/app-guides';
import { AURORA_BRAND_SLUGS, HUB_BOARD_SLUGS, hubBoardHref } from '@/app/lib/seo/app-guide-model';
import HubPage, { generateMetadata as getHubMetadata } from '../page';
import BoardPage, { generateMetadata as getBoardMetadata, generateStaticParams } from '../[slug]/page';
import SprayPage, { generateMetadata as getSprayMetadata } from '../../compare/spray-wall-apps/page';

const { cachedCommunityStats } = vi.hoisted(() => ({ cachedCommunityStats: vi.fn().mockResolvedValue(null) }));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ cachedCommunityStats }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'fr' }));
vi.mock('@/app/lib/i18n/missing-key-reporter', () => ({ reportMissingI18nKey: vi.fn() }));

const boards = [
  { slug: 'kilter', name: 'Kilter Board app' },
  { slug: 'aurora', name: 'Aurora board apps' },
  { slug: 'moonboard', name: 'MoonBoard app' },
  { slug: 'woods', name: 'Woods Board app' },
] as const;

const routeProps = (slug: string) => ({ params: Promise.resolve({ slug }) });
const { i18n } = await getServerTranslationForLocale('fr', 'common');

async function parsePage(element: ReactNode) {
  const markup = document.createElement('div');
  const stream = await renderToReadableStream(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
  await stream.allReady;
  markup.innerHTML = await new Response(stream).text();
  return markup;
}

function structuredData(markup: HTMLElement) {
  const script = markup.querySelector('script[type="application/ld+json"]');
  return (JSON.parse(script?.textContent ?? '{}') as { '@graph': Record<string, unknown>[] })['@graph'];
}

async function renderAll() {
  return [
    { id: 'hub', markup: await parsePage(await HubPage()) },
    ...(await Promise.all(
      boards.map(async ({ slug }) => ({ id: slug, markup: await parsePage(await BoardPage(routeProps(slug))) })),
    )),
    { id: 'spray-wall-apps', markup: await parsePage(await SprayPage()) },
  ];
}

describe('app guide pages before hydration', () => {
  it('links every board tile to the page that covers it, with descriptive link text', async () => {
    const markup = await parsePage(await HubPage());
    expect(markup.querySelectorAll('h1')).toHaveLength(1);
    expect(HUB_BOARD_SLUGS).toHaveLength(8);
    for (const slug of HUB_BOARD_SLUGS) {
      const tile = markup.querySelector(`#choose-board a[href="${hubBoardHref(slug)}"]`);
      expect(tile, slug).toBeTruthy();
      // The whole tile is the link: its name says which board, its text action says what you get.
      expect(tile?.textContent).toMatch(/Compare .+ apps/);
      expect(tile?.querySelector('h3')?.textContent).toBeTruthy();
    }
    for (const brand of AURORA_BRAND_SLUGS) expect(hubBoardHref(brand)).toBe(`/apps/aurora#${brand}`);
    expect(markup.querySelector('a[href="/compare/spray-wall-apps"]')?.textContent).toMatch(/spray wall/i);
    expect(generateStaticParams()).toEqual(boards.map(({ slug }) => ({ slug })));
  });

  it.each(boards)('serves the $slug comparison in the server HTML, verdict first', async ({ slug, name }) => {
    const markup = await parsePage(await BoardPage(routeProps(slug)));
    expect(markup.querySelectorAll('h1')).toHaveLength(1);
    expect(markup.querySelector('h1')?.textContent).toBe(`Boardsesh vs the ${name}`);
    expect(markup.querySelector('#verdict h3')?.textContent).toBe('Pick Boardsesh if');
    expect(markup.querySelector('#verdict')?.textContent).toContain(`Keep the ${name} if`);
    expect(markup.querySelectorAll('#verdict ul')[0]?.querySelectorAll('li')).toHaveLength(5);

    // The one filled action opens the browser app; both store badges carry this page's placement.
    expect(markup.querySelector(`a[href="${APP_URL}"]`)?.textContent).toBe('Open it in your browser');
    expect(markup.querySelector('a[data-store-badge="ios"]')?.getAttribute('href')).toContain(`compare-${slug}`);
    expect(markup.querySelector('a[data-store-badge="android"]')?.getAttribute('href')).toContain(`compare-${slug}`);

    // The hero capture is the LCP image: never lazy.
    const heroImage = Array.from(
      markup.querySelector('#page-title')?.closest('section')?.querySelectorAll('img') ?? [],
    ).find((image) => image.getAttribute('alt') && !image.closest('a'));
    expect(heroImage?.getAttribute('loading')).not.toBe('lazy');
    expect(heroImage?.getAttribute('alt')?.length).toBeGreaterThan(20);

    // A real table: row headers, a verdict on every row, headers that resolve, sources that resolve.
    const rows = markup.querySelectorAll('table tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      expect(row.querySelector('th[scope="row"]')?.textContent).toMatch(
        /does it better|Only in Boardsesh|Same in both/,
      );
      for (const cell of row.querySelectorAll('td')) {
        const ids = cell.getAttribute('headers')?.split(' ') ?? [];
        expect(ids).toHaveLength(2);
        expect(ids.every((id) => markup.querySelector(`#${id}`))).toBe(true);
      }
      for (const link of row.querySelectorAll('a[href^="#sources-"]')) {
        const group = markup.querySelector(`details#sources ${link.getAttribute('href')}`);
        expect(group?.nextElementSibling?.querySelector('a[href^="https://"]')).toBeTruthy();
      }
    }
    // At least one row the official app wins or ties: the honesty rule.
    expect(markup.querySelector('table')?.textContent).toMatch(/Same in both|app(s)? do(es)? it better/);

    // FAQ: native disclosures, the first open, every answer in the HTML.
    const faq = markup.querySelectorAll('#faq details');
    expect(faq.length).toBeGreaterThanOrEqual(5);
    expect(faq[0].hasAttribute('open')).toBe(true);
    expect(faq[1].hasAttribute('open')).toBe(false);
    expect(faq[1].querySelector('p')?.textContent?.length).toBeGreaterThan(20);

    expect(markup.textContent).toContain('Boardsesh is an independent app.');
    expect(markup.textContent).toMatch(/We make Boardsesh/);
    expect(markup.querySelector('main time[datetime]')?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(markup.querySelectorAll('a[href^="/help/"], a[href="/bring-your-logbook"]').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(markup.querySelector('nav a[href="/apps"]')).toBeTruthy();
    expect(markup.textContent).not.toContain('appGuides:');
    expect(markup.textContent).not.toMatch(/\[PENDING|Source pending/);
    expect(markup.querySelector('#check-board')).toBeNull();
  });

  it('gives each Aurora brand an anchored card with its own board drawing', async () => {
    const markup = await parsePage(await BoardPage(routeProps('aurora')));
    for (const brand of AURORA_BRAND_SLUGS) {
      const card = markup.querySelector(`#brands li#${brand}`);
      expect(card, brand).toBeTruthy();
      expect(decodeURIComponent(card?.querySelector('img')?.getAttribute('src') ?? '')).toContain(
        '/images/board-gallery/',
      );
      expect(card?.querySelector('h3')?.textContent).toBeTruthy();
      expect(card?.querySelector('dl')?.textContent).toMatch(/Official app/);
    }
    const ids = Array.from(markup.querySelectorAll('[id]'), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('publishes the spray comparison with every competitor column and named winners', async () => {
    const markup = await parsePage(await SprayPage());
    const columns = Array.from(markup.querySelectorAll('table thead th'), (column) => column.textContent);
    expect(columns).toEqual(['What you need', 'Boardsesh', 'Stōkt', 'Retro Flash', 'Crux']);
    const chips = Array.from(markup.querySelectorAll('table tbody th'), (header) => header.textContent ?? '');
    expect(chips.some((chip) => chip.includes('Stōkt does it better'))).toBe(true);
    expect(chips.some((chip) => chip.includes('Stōkt and Retro Flash do it better'))).toBe(true);
    expect(chips.some((chip) => chip.includes('Same in all 4'))).toBe(true);
    // A shared Boardsesh win names both apps and marks the other app's cell as a winner too.
    const shared = markup.querySelector('#compare-row-price')?.closest('tr');
    expect(shared?.querySelector('th')?.textContent).toContain('Boardsesh and Crux do it best');
    expect(shared?.querySelector('td[data-product="crux"]')?.hasAttribute('data-shared-win')).toBe(true);
    expect(shared?.querySelector('td[data-product="stokt"]')?.hasAttribute('data-shared-win')).toBe(false);
    expect(markup.querySelector('#other-apps li h3')).toBeTruthy();
    expect(markup.querySelector('a[href="/help/spray-walls"]')).toBeTruthy();
  });

  it('marks up Boardsesh only: dated WebPage, publisher, app, breadcrumbs and the hub list', async () => {
    for (const { id, markup } of await renderAll()) {
      const graph = structuredData(markup);
      const types = graph.map((entry) => entry['@type']);
      expect(types, id).toEqual(
        expect.arrayContaining(['WebPage', 'BreadcrumbList', 'Organization', 'MobileApplication']),
      );
      expect(graph.find((entry) => entry['@type'] === 'WebPage')).toMatchObject({
        dateModified: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        publisher: { '@id': expect.stringContaining('#organization') },
      });
      expect(graph.filter((entry) => entry['@type'] === 'MobileApplication')).toEqual([
        expect.objectContaining({ name: 'Boardsesh' }),
      ]);
      const json = markup.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
      expect(json).not.toMatch(/AggregateRating|"Review"|FAQPage|aggregateRating/);
      expect(types.includes('ItemList'), id).toBe(id === 'hub');
    }
    const hub = structuredData(await parsePage(await HubPage()));
    const list = hub.find((entry) => entry['@type'] === 'ItemList') as { itemListElement: { url: string }[] };
    expect(list.itemListElement.map((item) => new URL(item.url).pathname)).toEqual([
      ...APP_GUIDES.map((guide) => guide.path),
      APP_GUIDE_COMPARISON.path,
    ]);
  });

  it('cites the US rating snapshot and renders English badges for a French request', async () => {
    const markup = await parsePage(await BoardPage(routeProps('kilter')));
    const ratingSource = markup.querySelector('p a[href="https://apps.apple.com/us/app/boardsesh/id6761350784"]');
    expect(ratingSource?.textContent).toMatch(/\d\.\d out of 5 from \d+ US App Store ratings/i);
    expect(ratingSource?.closest('p')?.querySelector('time')?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(markup.querySelector('a[data-store-badge="ios"] img')?.getAttribute('alt')).toBe(
      'Download on the App Store',
    );
    expect(markup.querySelector('a[data-store-badge="android"] img')?.getAttribute('alt')).toBe(
      'Get it on Google Play',
    );
    expect(markup.textContent).not.toMatch(/in the last 30 days/i);
    expect((await getStoreButtonLabels()).ios).toBe("Télécharger dans l'App Store");
  });

  it('shows the cached app-wide numbers when available, and nothing when the read fails', async () => {
    expect((await parsePage(await HubPage())).querySelector('#numbers')).toBeNull();
    cachedCommunityStats.mockResolvedValueOnce({ climbersLast30Days: 3249, litLast30Days: 205800 });
    const numbers = (await parsePage(await HubPage())).querySelector('#numbers');
    expect(numbers?.textContent).toContain('3,200');
    expect(numbers?.textContent).toContain('206,000');
    cachedCommunityStats.mockResolvedValueOnce({ climbersLast30Days: 3249, litLast30Days: 205800 });
    const board = await parsePage(await BoardPage(routeProps('kilter')));
    expect(board.textContent).toMatch(/in the last 30 days, about 3,200 climbers used Boardsesh/i);
  });

  it('404s unknown and merged slugs at both route entry points', async () => {
    for (const slug of ['unknown-board', 'tension', 'so-ill']) {
      await expect(BoardPage(routeProps(slug))).rejects.toThrow(/404/);
      await expect(getBoardMetadata(routeProps(slug))).rejects.toThrow(/404/);
    }
  });

  it('publishes unique self-canonical English metadata from the catalog', async () => {
    const routes = await Promise.all([
      getHubMetadata().then((metadata) => ({ path: '/apps', metadata })),
      ...boards.map(async ({ slug }) => ({
        path: `/apps/${slug}`,
        metadata: await getBoardMetadata(routeProps(slug)),
      })),
      getSprayMetadata().then((metadata) => ({ path: '/compare/spray-wall-apps', metadata })),
    ]);
    for (const { path, metadata } of routes) {
      expect(metadata.alternates).toEqual({ canonical: path, languages: { 'en-US': path, 'x-default': path } });
      expect(metadata.openGraph).toMatchObject({ url: path, description: metadata.description });
      expect(metadata.twitter).toMatchObject({ description: metadata.description });
      const title = (metadata.title as { absolute: string }).absolute;
      // A title that already names Boardsesh gets no second "| Boardsesh".
      expect(title.match(/Boardsesh/g)?.length).toBe(1);
      expect(metadata.description?.length).toBeGreaterThanOrEqual(140);
      expect(metadata.description?.length).toBeLessThanOrEqual(155);
    }
    expect(new Set(routes.map(({ metadata }) => JSON.stringify(metadata.title))).size).toBe(routes.length);
    expect(new Set(routes.map(({ metadata }) => metadata.description)).size).toBe(routes.length);
  });
});

describe('claims that need evidence', () => {
  const certified = /google[- ]certified/i;

  it('shows the Google-certified Android contrast on the MoonBoard page only', async () => {
    for (const { id, markup } of await renderAll()) {
      expect(certified.test(markup.textContent ?? ''), id).toBe(id === 'moonboard');
    }
    expect(GATED_CLAIMS.googleCertified.pages).toEqual(['moonboard']);
  });

  it('hides the contrast when its source is not registered, and falls back to a plain Boardsesh verdict', () => {
    const moonboard = getAppGuide('moonboard');
    if (!moonboard) throw new Error('moonboard guide missing');
    const gated = moonboard.claims.filter((entry) => entry.claim === 'googleCertified').map((entry) => entry.path);
    expect(gated).toContain('comparison.rows.android');
    for (const path of gated) expect(isClaimVisible(moonboard, path)).toBe(true);
    const unsourced = { ...moonboard, sources: moonboard.sources.filter((source) => source.id !== 'grapheneos') };
    for (const path of gated) expect(isClaimVisible(unsourced, path)).toBe(false);
    // The hub's Android answer makes the same claim; the hub is not an allowed page.
    for (const entry of APP_GUIDE_HUB.claims) expect(isClaimVisible(APP_GUIDE_HUB, entry.path)).toBe(false);
  });

  it('cites at least one registered source on every "only in Boardsesh" row', () => {
    for (const page of ALL_APP_GUIDE_PAGES) {
      if (page.kind === 'hub') continue;
      const known = new Set(page.sources.map((source) => source.id));
      for (const row of page.rows) {
        for (const id of row.sourceIds) expect(known.has(id), `${page.id}.${row.id} cites ${id}`).toBe(true);
        if (row.verdict === 'only') expect(row.sourceIds.length, `${page.id}.${row.id}`).toBeGreaterThan(0);
        expect(row.pendingCells, `${page.id}.${row.id}`).toEqual([]);
        expect(row.pending, `${page.id}.${row.id}`).toBeUndefined();
      }
    }
  });
});
