import React, { type ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vite-plus/test';
import { APP_URL } from '@/app/lib/app-origin';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import HubPage, { generateMetadata as getHubMetadata } from '../page';
import BoardPage, { generateMetadata as getBoardMetadata, generateStaticParams } from '../[slug]/page';
import SprayPage, { generateMetadata as getSprayMetadata } from '../../compare/spray-wall-apps/page';

const { cachedCommunityStats } = vi.hoisted(() => ({ cachedCommunityStats: vi.fn().mockResolvedValue(null) }));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ cachedCommunityStats }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'fr' }));
vi.mock('@/app/lib/i18n/missing-key-reporter', () => ({ reportMissingI18nKey: vi.fn() }));

const boards = [
  { slug: 'kilter', name: 'Kilter', artwork: '/images/app/android/kilter.webp' },
  { slug: 'tension', name: 'Tension', artwork: '/images/app/android/tension.webp' },
  { slug: 'moonboard', name: 'MoonBoard', artwork: '/images/app/android/moonboard.webp' },
  { slug: 'decoy', name: 'Decoy', artwork: '/images/board-gallery/decoy-' },
  { slug: 'touchstone', name: 'Touchstone', artwork: '/images/board-gallery/touchstone-' },
  { slug: 'grasshopper', name: 'Grasshopper', artwork: '/images/board-gallery/grasshopper-' },
  { slug: 'so-ill', name: 'So iLL', artwork: '/images/board-gallery/soill-' },
  { slug: 'woods', name: 'Woods', artwork: '/images/board-gallery/woods-' },
];

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

describe('app guide pages before hydration', () => {
  it('links to all eight board guides and the spray-wall comparison from the hub', async () => {
    const markup = await parsePage(await HubPage());
    expect(markup.querySelectorAll('h1')).toHaveLength(1);
    for (const { slug, name } of boards) {
      expect(markup.querySelector(`a[href="/apps/${slug}"]`)?.textContent).toContain(name);
    }
    expect(markup.querySelector('a[href="/compare/spray-wall-apps"]')?.textContent).toMatch(/spray wall/i);
    expect(generateStaticParams()).toEqual(boards.map(({ slug }) => ({ slug })));
  });

  it.each(boards)(
    'serves the $name comparison with first-render actions, sources and links',
    async ({ slug, name, artwork }) => {
      const markup = await parsePage(await BoardPage(routeProps(slug)));
      expect(markup.querySelector('h1')?.textContent).toContain(name);
      expect(markup.querySelector('main header > p')?.textContent?.length).toBeGreaterThan(50);
      expect(markup.textContent).toContain('Boardsesh is an independent app.');
      const guideImage = Array.from(markup.querySelectorAll('img')).find((image) =>
        decodeURIComponent(image.getAttribute('src') ?? '').includes(artwork),
      );
      expect(guideImage?.alt).toContain(name);
      expect(guideImage?.alt.length).toBeGreaterThan(20);
      expect(markup.querySelector('a[data-store-badge="ios"]')?.getAttribute('href')).toContain(`compare-${slug}`);
      expect(markup.querySelector('a[data-store-badge="android"]')?.getAttribute('href')).toContain(`compare-${slug}`);
      expect(markup.querySelector(`a[href="${APP_URL}"]`)?.textContent).toMatch(/web app/i);
      expect(markup.querySelector('ol li strong')?.textContent).toBeTruthy();
      expect(markup.querySelectorAll('table tbody th[scope="row"]').length).toBeGreaterThanOrEqual(2);
      expect(markup.querySelectorAll('a[href^="/help/"]').length).toBeGreaterThanOrEqual(2);
      expect(markup.querySelector('nav a[href="/apps"]')).toBeTruthy();
      expect(markup.querySelectorAll('li time[datetime]').length).toBeGreaterThan(0);
      expect(markup.querySelector('time[datetime]')?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(markup.textContent).not.toContain('appGuides:');
      expect(markup.textContent).not.toContain(`pages.${slug}.`);
      expect(structuredData(markup).map((entry) => entry['@type'])).toEqual(['WebPage', 'BreadcrumbList']);
    },
  );

  it('links Grasshopper layout claims to the official adjustable wall catalog', async () => {
    const markup = await parsePage(await BoardPage(routeProps('grasshopper')));
    const kitSource = markup.querySelector(
      'a[href="https://shop.grasshopperclimbing.com/collections/adjustable-climbing-walls"]',
    );
    expect(kitSource?.textContent).toContain('Grasshopper');
    expect(markup.querySelector('table a[href="#app-guide-source-kits"]')).toBeTruthy();
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

  it('shows the cached app-wide activity in English when available', async () => {
    cachedCommunityStats.mockResolvedValueOnce({ climbersLast30Days: 3249, litLast30Days: 205800 });
    const markup = await parsePage(await HubPage());
    expect(markup.textContent).toMatch(/in the last 30 days, about 3,200 climbers used Boardsesh/i);
    expect(markup.textContent).toContain('206,000 times');
  });

  it('publishes one spray comparison with labeled competitor columns and source links', async () => {
    const markup = await parsePage(await SprayPage());
    const columns = Array.from(markup.querySelectorAll('table thead th'), (column) => column.textContent);
    expect(columns).toEqual(expect.arrayContaining(['Boardsesh', 'Stōkt', 'Retro Flash']));
    for (const detail of markup.querySelectorAll('table td')) {
      const labelIds = detail.getAttribute('headers')?.split(' ') ?? [];
      expect(labelIds).toHaveLength(2);
      expect(labelIds.every((id) => markup.querySelector(`#${id}`))).toBe(true);
    }
    for (const rowLabel of markup.querySelectorAll('table tbody th')) {
      const citations = Array.from(rowLabel.querySelectorAll('a'));
      expect(citations.length).toBeGreaterThan(0);
      expect(
        citations.every((citation) => markup.querySelector(`${citation.getAttribute('href')} > a[href^="https://"]`)),
      ).toBe(true);
    }
    expect(markup.querySelector('a[href="https://www.getstokt.com/pricing"]')).toBeTruthy();
    expect(markup.querySelector('a[href="/help/spray-walls"]')).toBeTruthy();
    expect(structuredData(markup)).toContainEqual(
      expect.objectContaining({ '@type': 'Article', headline: markup.querySelector('h1')?.textContent }),
    );
    expect(markup.querySelector('script[type="application/ld+json"]')?.textContent).not.toMatch(
      /AggregateRating|Review/,
    );
  });

  it('404s unknown slugs at both route entry points', async () => {
    await expect(BoardPage(routeProps('unknown-board'))).rejects.toThrow(/404/);
    await expect(getBoardMetadata(routeProps('unknown-board'))).rejects.toThrow(/404/);
  });

  it('publishes unique self-canonical English metadata and social previews', async () => {
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
      expect(metadata.description).toBeTruthy();
    }
    expect(new Set(routes.map(({ metadata }) => JSON.stringify(metadata.title))).size).toBe(routes.length);
    expect(new Set(routes.map(({ metadata }) => metadata.description)).size).toBe(routes.length);
  });
});
