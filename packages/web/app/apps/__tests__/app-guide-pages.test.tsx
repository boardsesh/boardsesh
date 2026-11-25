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
  quotesFor,
} from '@/app/lib/seo/app-guides';
import { AURORA_BRAND_SLUGS, HUB_BOARD_SLUGS, hubBoardHref } from '@/app/lib/seo/app-guide-model';
import { verdictLabel } from '@/app/components/app-guides/comparison-table';
import HubPage, { generateMetadata as getHubMetadata } from '@/app/(marketing)/apps/page';
import BoardPage, {
  generateMetadata as getBoardMetadata,
  generateStaticParams,
} from '@/app/(marketing)/apps/[slug]/page';
import SprayPage, { generateMetadata as getSprayMetadata } from '@/app/(marketing)/compare/spray-wall-apps/page';

const { cachedCommunityStats } = vi.hoisted(() => ({ cachedCommunityStats: vi.fn().mockResolvedValue(null) }));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ cachedCommunityStats }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'fr' }));
vi.mock('@/app/lib/i18n/missing-key-reporter', () => ({ reportMissingI18nKey: vi.fn() }));

const boards = [
  { slug: 'kilter', name: 'Kilter Board app', h1: 'Boardsesh vs the Kilter Board app' },
  // Climbers search for Tension, not the vendor, so the Aurora H1 leads with it.
  { slug: 'aurora', name: 'Aurora board apps', h1: 'Boardsesh vs the Tension Board app and other Aurora apps' },
  { slug: 'moonboard', name: 'MoonBoard app', h1: 'Boardsesh vs the MoonBoard app' },
  { slug: 'woods', name: 'Woods Board app', h1: 'Boardsesh vs the Woods Board app' },
] as const;

const routeProps = (slug: string) => ({ params: Promise.resolve({ slug }) });
const CTA_LABELS: Record<string, string> = {
  kilter: 'Browse Kilter climbs',
  aurora: 'Pick your Tension or Aurora board',
  moonboard: 'Browse MoonBoard problems',
  woods: 'Browse Woods climbs',
};
/** The section of www's board gallery each page's button lands on. */
const CTA_SECTIONS: Record<string, string> = {
  kilter: 'kilter',
  aurora: 'tension',
  moonboard: 'moonboard',
  woods: 'woods',
};
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
    for (const slug of HUB_BOARD_SLUGS) {
      const tile = markup.querySelector(`#choose-board a[href="${hubBoardHref(slug)}"]`);
      expect(tile, slug).toBeTruthy();
      // The whole tile is the link: its name says which board, its text action says what you get.
      expect(tile?.textContent).toMatch(/Compare .+ apps/);
      expect(tile?.querySelector('h3')?.textContent).toBeTruthy();
    }
    expect(markup.querySelector('a[href="/compare/spray-wall-apps"]')?.textContent).toMatch(/spray wall/i);
    expect(generateStaticParams()).toEqual(boards.map(({ slug }) => ({ slug })));
  });

  it.each(boards)('serves the $slug comparison in the server HTML, verdict first', async ({ slug, name, h1 }) => {
    const markup = await parsePage(await BoardPage(routeProps(slug)));
    expect(markup.querySelectorAll('h1')).toHaveLength(1);
    expect(markup.querySelector('h1')?.textContent).toBe(h1);
    expect(markup.querySelector('#verdict h3')?.textContent).toBe('Pick Boardsesh if');
    expect(markup.querySelector('#verdict')?.textContent).toContain(`Keep the ${name} if`);
    expect(markup.querySelectorAll('#verdict ul')[0]?.querySelectorAll('li')).toHaveLength(5);

    // The one filled action opens the browser app; both store badges carry this page's placement.
    // The filled button says what it opens, and lands on this family's section of www's board
    // gallery, where the climber picks their own wall with no account: never one preselected
    // layout, size or angle. The header's "Start climbing" covers the browser app, so the hero
    // carries no second app link.
    const browse = Array.from(markup.querySelectorAll<HTMLAnchorElement>('a')).find(
      (link) => link.textContent === CTA_LABELS[slug],
    );
    expect(browse?.getAttribute('href'), slug).toBe(`/boards#${CTA_SECTIONS[slug]}`);
    const hero = markup.querySelector('section[aria-labelledby="page-title"]');
    expect(hero?.querySelector(`a[href="${APP_URL}"]`), slug).toBeNull();
    expect(markup.querySelector('a[data-store-badge="ios"]')?.getAttribute('href')).toContain(`compare-${slug}`);
    expect(markup.querySelector('a[data-store-badge="android"]')?.getAttribute('href')).toContain(`compare-${slug}`);

    // The hero capture is the LCP image: eager, and first in the fetch queue.
    const heroImage = Array.from(
      markup.querySelector('#page-title')?.closest('section')?.querySelectorAll('img') ?? [],
    ).find((image) => image.getAttribute('alt') && !image.closest('a'));
    expect(heroImage?.getAttribute('loading')).toBe('eager');
    expect(heroImage?.getAttribute('fetchpriority')).toBe('high');
    expect(heroImage?.getAttribute('alt')?.length).toBeGreaterThan(20);

    // A real table: row headers, a verdict on every row, headers that resolve, sources that resolve.
    const rows = markup.querySelectorAll('table tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      expect(row.querySelector('th[scope="row"]')?.textContent).toMatch(
        /does it better|do it best|Only in Boardsesh|Same in both|doesn't list it|don't list it/,
      );
      for (const cell of row.querySelectorAll('td')) {
        const ids = cell.getAttribute('headers')?.split(' ') ?? [];
        expect(ids).toHaveLength(2);
        expect(ids.every((id) => markup.querySelector(`#${id}`))).toBe(true);
      }
      // The verdict chip is the link to the row's sources.
      const chip = row.querySelector('th a[href^="#sources-"]');
      expect(chip?.textContent).toMatch(
        /does it better|do it best|Only in Boardsesh|Same in both|doesn't list it|don't list it/,
      );
      expect(chip?.getAttribute('aria-label')).toMatch(/^.+\. See sources for .+$/);
      expect(chip?.getAttribute('aria-label')).not.toContain('—');
    }
    // At least one row the official app wins or ties: the honesty rule.
    expect(markup.querySelector('table')?.textContent).toMatch(/Same in both|app(s)? do(es)? it better/);

    // FAQ: native disclosures, the first open, every answer in the HTML.
    const faq = markup.querySelectorAll('#faq details');
    expect(faq.length).toBeGreaterThanOrEqual(5);
    expect(faq[0].hasAttribute('open')).toBe(true);
    expect(faq[1].hasAttribute('open')).toBe(false);
    expect(faq[1].querySelector('p')?.textContent?.length).toBeGreaterThan(20);
    // Each question is a real heading inside its summary; the source group labels are not.
    expect(faq[1].querySelector('summary > h3')?.textContent?.length).toBeGreaterThan(5);
    expect(markup.querySelectorAll('#sources h3')).toHaveLength(0);

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
    // Sources are one disclosure at the bottom, reached through the verdict chips; no inline "Sources" links.
    expect(Array.from(markup.querySelectorAll('main a'), (link) => link.textContent?.trim())).not.toContain('Sources');
    expect(markup.querySelector('#comparison')?.textContent).toContain('Tap a verdict to see its sources');
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
    expect(columns).toEqual(['What you need', 'Boardsesh', 'Stōkt', 'Crux', 'Retro Flash']);
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
        datePublished: '2026-11-24',
        dateModified: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        publisher: { '@id': expect.stringContaining('/#organization') },
        isPartOf: { '@id': expect.stringContaining('/#website') },
      });
      // The same Organization entity the homepage defines, with its profiles.
      expect(graph.find((entry) => entry['@type'] === 'Organization')).toMatchObject({
        '@id': expect.stringContaining('/#organization'),
        sameAs: ['https://github.com/marcodejongh/boardsesh', 'https://discord.gg/YXA8GsXfQK'],
      });
      expect(graph.filter((entry) => entry['@type'] === 'MobileApplication')).toEqual([
        expect.objectContaining({ name: 'Boardsesh' }),
      ]);
      // Every source URL is linked once per page; a repeat names it as plain text.
      const sourceLinks = Array.from(markup.querySelectorAll('#sources a')).map((link) => link.getAttribute('href'));
      expect(new Set(sourceLinks).size, id).toBe(sourceLinks.length);
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
    expect(ratingSource?.textContent).toBe('4.7 out of 5 from 72 App Store ratings in 17 countries');
    const line = ratingSource?.closest('p');
    const playLink = Array.from(line?.querySelectorAll('a') ?? []).find((link) =>
      link.getAttribute('href')?.startsWith('https://play.google.com/store/apps/details?id=com.boardsesh.app'),
    );
    expect(playLink?.textContent).toBe('4.6 from 38 Google Play ratings');
    expect(line?.textContent).toContain('Checked Nov 24, 2026');
    // The closing band repeats the same line.
    expect(
      markup.querySelectorAll('a[href="https://apps.apple.com/us/app/boardsesh/id6761350784"]').length,
    ).toBeGreaterThanOrEqual(2);
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
    // Floored to the unit and marked "+": 3,249 climbers is "3,200+", 205,800 climbs "205,000+".
    expect(numbers?.textContent).toContain('3,200+');
    expect(numbers?.textContent).toContain('205,000+');
    expect(numbers?.textContent).toContain('out of 5 from 38 Google Play ratings');
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
      // Never two "Boardsesh", and never past the 60-character cut.
      expect(title.match(/Boardsesh/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(title.length, path).toBeLessThanOrEqual(60);
      const images = metadata.openGraph?.images as { alt?: string }[] | undefined;
      expect(images?.[0]?.alt, path).toBe(title.replace(/ \| Boardsesh$/, ''));
      expect(metadata.description?.length).toBeGreaterThanOrEqual(140);
      expect(metadata.description?.length).toBeLessThanOrEqual(155);
    }
    expect(new Set(routes.map(({ metadata }) => JSON.stringify(metadata.title))).size).toBe(routes.length);
    expect(new Set(routes.map(({ metadata }) => metadata.description)).size).toBe(routes.length);
  });
});

describe('the browser app', () => {
  const alt =
    'Boardsesh open in a desktop browser at app.boardsesh.com: the Kilter climb list next to Blue Jeans, a V4, ready to put on the board';
  const isBrowserShot = (image: Element) =>
    decodeURIComponent(image.getAttribute('src') ?? '').includes('/images/app/web/kilter.webp');

  it('shows the real Kilter browser capture on the hub and the Kilter page, and the drawing where it would be the wrong board', async () => {
    for (const { id, markup } of await renderAll()) {
      const shots = Array.from(markup.querySelectorAll('img')).filter(isBrowserShot);
      if (id === 'hub' || id === 'kilter') {
        expect(shots, id).toHaveLength(1);
        expect(shots[0].getAttribute('alt')).toBe(alt);
      } else {
        expect(shots, id).toHaveLength(0);
      }
      expect(markup.textContent, id).not.toContain('not a screenshot');
    }
    const hub = await parsePage(await HubPage());
    expect(Array.from(hub.querySelectorAll('#devices img')).some(isBrowserShot)).toBe(true);
    const kilter = await parsePage(await BoardPage(routeProps('kilter')));
    expect(Array.from(kilter.querySelectorAll('#differences img')).some(isBrowserShot)).toBe(true);
  });
});

describe('what climbers say', () => {
  it('quotes each page its picked store reviews verbatim, in English, with no stars or rating markup', async () => {
    for (const { id, markup } of await renderAll()) {
      const expected = quotesFor(id as Parameters<typeof quotesFor>[0]);
      const cards = Array.from(markup.querySelectorAll('#quotes figure'));
      expect(cards.length, id).toBe(expected.length);
      expect(cards.length, id).toBeGreaterThanOrEqual(1);
      expect(cards.length, id).toBeLessThanOrEqual(3);
      cards.forEach((card, index) => {
        const quote = expected[index];
        const blockquote = card.querySelector('blockquote');
        expect(blockquote?.getAttribute('lang')).toBe('en');
        expect(blockquote?.textContent).toBe(`“${quote.text}”`);
        const caption = card.querySelector('figcaption')?.textContent ?? '';
        expect(caption).toContain(quote.author);
        expect(caption).toContain(quote.store === 'appStore' ? 'App Store' : 'Google Play');
        if (quote.country) expect(caption).toContain(quote.country);
        expect(caption).toMatch(/[A-Z][a-z]{2} 2026/);
      });
      expect(markup.querySelector('#quotes')?.textContent).not.toMatch(/[★☆]/);
      // On phones the row scrolls sideways: it must be reachable and named for the keyboard.
      const row = markup.querySelector('#quotes ul');
      expect(row?.getAttribute('tabindex')).toBe('0');
      expect(row?.getAttribute('aria-label')).toBe('Store reviews from climbers');
      const json = markup.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
      expect(json, id).not.toMatch(/"Review"|AggregateRating|aggregateRating|reviewRating/);
    }
    // Verbatim: curly apostrophes survive as written.
    expect(quotesFor('hub').some((quote) => quote.text.includes('I’m'))).toBe(true);
  });

  it('follows the comparison table on board pages and "Pick your board" on the hub', async () => {
    const kilter = await parsePage(await BoardPage(routeProps('kilter')));
    const comparison = kilter.querySelector('#comparison');
    expect(comparison?.nextElementSibling?.id).toBe('quotes');
    const hub = await parsePage(await HubPage());
    expect(hub.querySelector('#choose-board')?.previousElementSibling?.querySelector('h1')).toBeTruthy();
    expect(hub.querySelector('#choose-board')?.nextElementSibling?.id).toBe('quotes');
  });
});

describe('page-level claims from the registry', () => {
  it('offers "Bring your logbook" only where an import exists, and browser lighting only where it is backed', async () => {
    for (const { id, markup } of await renderAll()) {
      if (id === 'hub') continue;
      const cta = markup.querySelector('#logbook a[href="/bring-your-logbook"], #logbook a[href="/help/logbook"]');
      expect(cta?.getAttribute('href'), id).toBe(
        ['woods', 'spray-wall-apps'].includes(id) ? '/help/logbook' : '/bring-your-logbook',
      );
      const strip = markup.querySelector('ul[aria-label="Where Boardsesh runs"]')?.textContent ?? '';
      expect(strip.includes('Chrome and Edge light the board'), id).toBe(!['woods', 'spray-wall-apps'].includes(id));
    }
  });

  it('says how each page lights the wall, and where its filled button goes', async () => {
    const pages = Object.fromEntries((await renderAll()).map(({ id, markup }) => [id, markup]));
    const strip = (id: string) => pages[id].querySelector('ul[aria-label="Where Boardsesh runs"]')?.textContent ?? '';
    expect(strip('hub')).toContain('Your web browser');
    expect(strip('hub')).toContain(
      'Chrome and Edge light the board over Web Bluetooth; Safari and Firefox can browse and log',
    );
    // The queue and workout tiles show real screens, so they say what is on them.
    const everyBoardShots = Array.from(pages.hub.querySelectorAll('#every-board img'));
    expect(everyBoardShots.length).toBeGreaterThan(0);
    for (const image of everyBoardShots) expect(image.getAttribute('alt')?.length).toBeGreaterThan(10);
    expect(pages.hub.querySelector('#every-board .lead, #every-board h2 + p')?.textContent).toMatch(
      /Learn the app once/,
    );
    expect(strip('spray-wall-apps')).toContain('Lights your wall through WLED over Wi-Fi');
    expect(strip('spray-wall-apps')).not.toMatch(/Bluetooth|Chrome and Edge light/);
    expect(strip('woods')).not.toContain('Chrome and Edge light');
    const button = (id: string, label: string) =>
      Array.from(pages[id].querySelectorAll('a'))
        .find((link) => link.textContent === label)
        ?.getAttribute('href');
    expect(button('hub', 'Find climbs for your board')).toBe('/boards');
    expect(pages.hub.querySelector(`section[aria-labelledby="page-title"] a[href="${APP_URL}"]`)).toBeNull();
    // Hold and LED makers get one quiet card after the board tiles, linking the partners section.
    const makers = pages.hub.querySelector('#choose-board a[href="/for-gyms#partners"]');
    expect(makers?.textContent).toBe('Talk to us about your board');
    expect(makers?.closest('ul')).toBeNull();
    // Its art is a drawn mystery board: decorative, the "?" its only text, the same on every render.
    const mystery = pages.hub.querySelector('#choose-board svg[aria-hidden="true"]');
    expect(mystery?.querySelectorAll('path').length).toBeGreaterThanOrEqual(12);
    expect(mystery?.textContent?.trim()).toBe('?');
    const again = (await renderAll()).find(({ id }) => id === 'hub')?.markup;
    expect(again?.querySelector('#choose-board svg[aria-hidden="true"]')?.innerHTML).toBe(mystery?.innerHTML);
    // Setting up a spray wall needs an account anyway, so its button opens the app's new-wall flow.
    expect(button('spray-wall-apps', 'Set up your spray wall')).toBe(`${APP_URL}/boards/spray/new`);
  });
});

describe('the "unlisted" verdict', () => {
  it('reads as a neutral fact naming the app, or "Others" when there are several', async () => {
    const { t } = await getServerTranslationForLocale('en-US', 'appGuides');
    const kilter = getAppGuide('kilter');
    if (!kilter) throw new Error('kilter guide missing');
    expect(verdictLabel(t, kilter, { verdict: 'unlisted', winners: [] })).toBe("Kilter Board app doesn't list it");
    expect(verdictLabel(t, APP_GUIDE_COMPARISON, { verdict: 'unlisted', winners: [] })).toBe("Others don't list it");
  });
});

describe('session steps', () => {
  it("shows only this page's own board or a board-neutral screen, and reads cleanly as text", async () => {
    for (const { id, markup } of await renderAll()) {
      const steps = Array.from(markup.querySelectorAll('#session ol > li'));
      if (id === 'hub') continue;
      expect(steps, id).toHaveLength(4);
      for (const step of steps) {
        const src = decodeURIComponent(step.querySelector('img')?.getAttribute('src') ?? '');
        if (id !== 'kilter') expect(src, id).not.toMatch(/\/app\/ios\/(kilter|queue|wall-status)\.webp/);
        if (id !== 'aurora') expect(src, id).not.toContain('/app/ios/tension.webp');
        if (id !== 'moonboard') expect(src, id).not.toContain('/app/ios/moonboard.webp');
        // The step number is decoration: the heading text is the title alone.
        expect(step.querySelector('h3')?.textContent).not.toMatch(/^\d/);
      }
    }
  });
});

describe('verdict chips as source links', () => {
  it('points every chip at a source group that exists in the server HTML', async () => {
    for (const { id, markup } of await renderAll()) {
      const chips = Array.from(markup.querySelectorAll<HTMLAnchorElement>('table a[href^="#"]'));
      if (id !== 'hub') expect(chips.length, id).toBeGreaterThanOrEqual(7);
      for (const chip of chips) {
        const target = markup.querySelector(chip.getAttribute('href') ?? '#missing');
        expect(target, `${id} ${chip.getAttribute('href')}`).toBeTruthy();
        expect(target?.closest('details#sources'), `${id} ${chip.getAttribute('href')}`).toBeTruthy();
        // Each cited source is either linked here or, when an earlier row already linked it, named.
        const items = Array.from(target?.nextElementSibling?.querySelectorAll('li') ?? []);
        expect(items.length, `${id} ${chip.getAttribute('href')}`).toBeGreaterThan(0);
        for (const item of items) {
          expect(
            Boolean(item.querySelector('a[href^="https://"]')) || /linked above/.test(item.textContent ?? ''),
          ).toBe(true);
        }
      }
    }
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
