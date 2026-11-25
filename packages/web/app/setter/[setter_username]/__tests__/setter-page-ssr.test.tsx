import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { Writable } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

/**
 * The headline verify for #4473: the *first server render* — the one the
 * crawler and the HTML response see — carries the `<h1>`, the summary copy and
 * real climb anchors.
 *
 * It renders the PAGE default export rather than the SEO fragment on purpose.
 * Rendering the fragment alone would stay green if `page.tsx` were reverted to
 * mount the client component, because `renderToString` runs only the server
 * pass and that component's `loading` state is initialised true — a spinner
 * with no heading and no links, which is exactly what production served.
 */

const setterData = vi.hoisted(() => ({
  value: null as unknown,
}));

const ogSummary = vi.hoisted(() => ({
  value: { displayName: 'Marco', totalAscents: 0, version: 'v1' } as {
    displayName: string;
    totalAscents: number;
    version: string;
  } | null,
  calls: 0,
  /** The username each call asked for: `cache()` dedupes the head's and the body's only if they match. */
  usernames: [] as string[],
  /** Set to drive the head down its `catch`, the way a database blip would. */
  failure: null as Error | null,
}));

/**
 * The locale the head is serving, mutable so a test can ask for a twin.
 *
 * The board-content carve-out is invisible at `en-US` — the canonical is the
 * served URL either way — so only a prefixed locale can tell
 * `createBoardContentPageMetadata` apart from a self-canonicalising helper.
 */
const serverLocale = vi.hoisted(() => ({ value: 'en-US' as 'en-US' | 'de' }));

/**
 * Which of the head's two reads started when.
 *
 * Both stubs below suspend once before they resolve, which is the whole trick:
 * a `Promise.all` calls both functions before either can get past that await,
 * so `view:start` lands before `og:end`. Sequenced awaits cannot produce that
 * order no matter how fast either read is, so the assertion is about the code's
 * shape rather than about timing.
 *
 * `view:*` is stamped by the `getSetterPageData` stub, one layer below the
 * `setterPageHasCrawlableClimb` the head actually calls — that call reaches
 * this stub through `getSetterPageView`. It is the closest seam a stub can sit
 * on, and it is a real dependency of the assertion: route the head's second
 * read around `getSetterPageData` and no `view:*` event is stamped at all,
 * which is what the presence checks in the test below exist to catch.
 */
const readOrder = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ dbz: {}, dbzRead: {}, sql: {}, executeRows: async () => [] }));

const notFoundCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/setter/marco',
  notFound: () => {
    notFoundCalls.count += 1;
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('../server-setter-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server-setter-data')>()),
  getSetterPageData: async () => {
    readOrder.events.push('view:start');
    await Promise.resolve();
    readOrder.events.push('view:end');
    return setterData.value;
  },
}));

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async (): Promise<PopularBoardConfig[]> => [
    {
      boardType: 'kilter',
      layoutId: 1,
      layoutName: 'Kilter Board Original',
      sizeId: 10,
      sizeName: '12 x 12 with kickboard',
      sizeDescription: '12 x 12 Square',
      setIds: [1, 20],
      setNames: ['Bolt Ons', 'Screw Ons'],
      climbCount: 4200,
      totalAscents: 99,
      boardCount: 12,
      displayName: 'Kilter Original 12x12',
    },
  ],
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSetterOgSummary: async (username: string) => {
    ogSummary.calls += 1;
    ogSummary.usernames.push(username);
    readOrder.events.push('og:start');
    await Promise.resolve();
    readOrder.events.push('og:end');
    if (ogSummary.failure) throw ogSummary.failure;
    return ogSummary.value;
  },
}));

vi.mock('@/app/lib/backend-url', () => ({ getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com' }));

vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => serverLocale.value }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    locale: serverLocale.value,
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/app/components/back-button', () => ({ default: () => null }));
vi.mock('../setter-share-button', () => ({ default: () => null }));
// The follow island is NOT mocked: the follower count lives inside it, and the
// point of the assertion below is that moving it there kept it in the server
// HTML. Only its session read is stubbed.
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
// `useWsAuthToken` is a React Query hook and this render has no provider. The
// stub answers as it does for the anonymous crawler this test is about.
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: null, isAuthenticated: false, isLoading: false, error: null }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
// What the root layout's provider gives a cold server render: no answer yet.
vi.mock('@/app/components/consent/consent-state-provider', () => ({
  useConsent: () => ({ granted: false, snapshot: { record: null }, dialogOpen: false }),
}));
// The real code is a wall of `<path>`; the URL it encodes is what is under test.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, 'aria-label': ariaLabel }: { value: string; 'aria-label'?: string }) => (
    <svg data-qr-value={value} aria-label={ariaLabel} role="img" />
  ),
}));

const pageModule = await import('@/app/(site)/setter/[setter_username]/page');
const SetterProfilePage = pageModule.default;
const { generateMetadata } = pageModule;
const { absoluteUrl } = await import('@/app/lib/seo/base-url');
const { buildCanonicalClimbListUrl } = await import('@/app/lib/url-utils');
const { getBoardImageDetailsForBoard } = await import('@/app/lib/board-image-details');
const { setterQrUrl } = await import('@/app/lib/gym-attribution');

type StubClimb = {
  uuid: string;
  name: string;
  isDraft?: boolean;
  isListed?: boolean;
  /** Overridden by the no-crawlable-link case: a set the chosen config lacks. */
  requiredSetIds?: number[];
};

function climbRow(climb: StubClimb & { requiredSetIds?: number[] }) {
  return {
    uuid: climb.uuid,
    layoutId: 1,
    boardType: 'kilter',
    setter_username: 'marco',
    name: climb.name,
    description: '',
    frames: 'p1080r15',
    framesCount: 1,
    framesPace: 0,
    angle: 40,
    ascensionist_count: 12,
    difficulty: '6B',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    created_at: null,
    compatibleSizeIds: [10, 27],
    requiredSetIds: climb.requiredSetIds ?? [1, 20],
    updatedAt: new Date('2026-05-04T11:22:33.000Z'),
  };
}

function pageData(climbs: StubClimb[]) {
  return {
    username: 'marco',
    displayName: 'Marco',
    avatarUrl: null,
    boardTypes: ['kilter'],
    climbCount: climbs.length,
    followerCount: 3,
    climbs: climbs.map(climbRow),
    hasMore: false,
  };
}

/**
 * The full server pass, to completion.
 *
 * `renderToString` cannot render async server components — it aborts the moment
 * one suspends — and the page's SEO fragment is one. `onAllReady` is the whole
 * point here: it is what makes this test see the same HTML the crawler gets
 * rather than a fallback.
 */
function renderPage(element: React.ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    sink.on('finish', () => resolve(chunks.join('')));

    const { pipe } = renderToPipeableStream(element, {
      onAllReady: () => pipe(sink),
      onError: reject,
    });
  });
}

async function render(searchParams: Record<string, string> = {}, username = 'marco') {
  return renderPage(
    await SetterProfilePage({
      params: Promise.resolve({ setter_username: username }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

function metadataFor(searchParams: Record<string, string> = {}, username = 'marco') {
  return generateMetadata({
    params: Promise.resolve({ setter_username: username }),
    searchParams: Promise.resolve(searchParams),
  });
}

/** The `@graph` the page really emitted, parsed out of the rendered HTML. */
function graphOf(
  html: string,
): { '@type': string; '@id'?: string; url?: string; mainEntityOfPage?: { '@id': string } }[] {
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  expect(block).not.toBeNull();
  return JSON.parse(block![1].replace(/\\u003c/g, '<'))['@graph'];
}

beforeEach(() => {
  notFoundCalls.count = 0;
  ogSummary.value = { displayName: 'Marco', totalAscents: 0, version: 'v1' };
  ogSummary.calls = 0;
  ogSummary.usernames = [];
  ogSummary.failure = null;
  serverLocale.value = 'en-US';
  readOrder.events = [];
});

describe('the setter front door, server-rendered', () => {
  it('emits one h1, descriptive copy and a real anchor per climb — no spinner', async () => {
    setterData.value = pageData([
      { uuid: 'a'.repeat(32), name: 'First Climb' },
      { uuid: 'b'.repeat(32), name: 'Second Climb' },
      { uuid: 'c'.repeat(32), name: 'Third Climb' },
    ]);

    const html = await render();

    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
    expect(html).toContain('setter.seoHeading:Marco');
    // Three crawlable climb links on the config-tuple tree, in the first server
    // HTML. This is the assertion that reds if the page goes back to rendering
    // the client component.
    const climbAnchors = html.match(/href="\/kilter\/[^"]*\/view\/[^"]*"/g) ?? [];
    expect(climbAnchors).toHaveLength(3);
    expect(html).not.toContain('loading-spinner');
    // The follower count moved into the follow island so a follow/unfollow moves
    // it. A client component's first render still happens on the server, so it
    // must remain in the crawlable HTML — this is what reds if it is ever made
    // conditional on the viewer's follow state resolving.
    expect(html).toContain('setter.follower');
  });

  it('advertises exactly the climb URLs it links to in the JSON-LD', () => {
    // Structured data that names a URL the page does not link to is worse than
    // no structured data. Both sides are read out of the rendered HTML, so this
    // cannot pass by both halves drifting together.
    return (async () => {
      setterData.value = pageData([
        { uuid: 'a'.repeat(32), name: 'First Climb' },
        { uuid: 'b'.repeat(32), name: 'Second Climb' },
      ]);

      const html = await render();
      // `[\s\S]` rather than the `s` flag: this file lints against a target
      // where `dotAll` is not available.
      const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
      expect(block).not.toBeNull();

      const graph = JSON.parse(block![1].replace(/\\u003c/g, '<')) as {
        '@graph': { '@type': string; itemListElement?: { url: string }[] }[];
      };
      const itemList = graph['@graph'].find((node) => node['@type'] === 'ItemList');
      const listPaths = (itemList?.itemListElement ?? []).map((item) => new URL(item.url).pathname);
      const anchorPaths = [...html.matchAll(/href="(\/kilter\/[^"]*\/view\/[^"]*)"/g)].map((match) => match[1]);

      expect(listPaths).toHaveLength(2);
      expect(listPaths).toEqual(anchorPaths);
    })();
  });

  it('still advertises exactly the URLs it links to when the most-sent cards repeat some of them', async () => {
    // The art cards link the top three climbs a second time, at the SAME URL
    // as their rows. The set of linked URLs is what has to match the ItemList.
    setterData.value = pageData(
      ['a', 'b', 'c', 'd', 'e'].map((letter) => ({ uuid: letter.repeat(32), name: `Climb ${letter}` })),
    );

    const html = await render();
    const itemList = graphOf(html).find((node) => node['@type'] === 'ItemList') as
      | { itemListElement?: { url: string }[] }
      | undefined;
    const listPaths = (itemList?.itemListElement ?? []).map((item) => new URL(item.url).pathname);
    const anchorPaths = [...html.matchAll(/href="(\/kilter\/[^"]*\/view\/[^"]*)"/g)].map((match) => match[1]);

    expect(listPaths).toHaveLength(5);
    expect([...new Set(anchorPaths)]).toEqual(listPaths);
    // Rows plus three cards, and every card URL is one of the rows'.
    expect(anchorPaths).toHaveLength(8);
  });

  it('404s instead of serving a 200 shell when the setter has no visible climb', async () => {
    // Three production states arrive here as the same null — a username nobody
    // ever set a climb under, a setter whose every climb is a draft, and one
    // whose every climb is unlisted. That the last two really do produce null is
    // the visibility predicate, pinned by the byte-comparison in
    // `server-setter-data.test.ts`; what is pinned here is that null means 404
    // rather than the indexable 200 shell every one of them used to get.
    setterData.value = null;

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundCalls.count).toBe(1);
  });

  it("404s a `?page` inside the range but past this setter's climbs", async () => {
    // Nothing links there and the sitemap submits only the bare path, so an
    // indexable empty page is a thin duplicate reachable only by guessing.
    setterData.value = { ...pageData([]), climbCount: 12 };

    await expect(render({ page: '2' })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundCalls.count).toBe(1);
  });

  it('404s a `?page` past the hard ceiling instead of running a deep OFFSET', async () => {
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'First Climb' }]);

    await expect(render({ page: '5000' })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('the setter front door hero, cards and rows', () => {
  const FIVE_CLIMBS = ['a', 'b', 'c', 'd', 'e'].map((letter) => ({ uuid: letter.repeat(32), name: `Climb ${letter}` }));

  it('reads the send total for the line under the name from the same summary the head reads', async () => {
    setterData.value = pageData(FIVE_CLIMBS);
    ogSummary.value = { displayName: 'Marco', totalAscents: 9860, version: 'v1' };

    const [html] = await Promise.all([render(), metadataFor()]);

    // The mocked `t` prints the key: the joined key only appears with a send count.
    expect(html).toContain('setter.stats.joined');
    // One argument for both callers, which is what lets `cache()` answer the
    // second from the first in production: two requests' worth of GraphQL
    // became one.
    expect(ogSummary.usernames).toEqual(['marco', 'marco']);
  });

  it('names no send count when the summary has none, or when it fails', async () => {
    setterData.value = pageData(FIVE_CLIMBS);

    expect(await render()).not.toContain('setter.stats.joined');

    ogSummary.failure = new Error('summary lookup failed');
    const html = await render();
    expect(html).toContain('setter.stats.climbs');
    expect(html).not.toContain('setter.stats.joined');
    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
  });

  it("draws page one's three most-sent climbs as board art with reserved boxes, the first one eager", async () => {
    setterData.value = pageData(FIVE_CLIMBS);

    const html = await render();
    // The row thumbnails are stubbed out in this file, so every <img> here but
    // the store badges is card art.
    const images = (html.match(/<img [^>]*>/g) ?? []).filter((image) => !image.includes('/images/store-badges/'));

    expect(html).toContain('setter.mostSent.heading');
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image).toMatch(/width="\d+"/);
      expect(image).toMatch(/height="\d+"/);
      expect(image).toContain('frames=p1080r15');
    }
    // The first card is in the first screen at 390px and 1440px: it is the
    // page's LCP candidate, so it loads now and first. The other two wait.
    const [first, ...rest] = images;
    expect(first).toMatch(/fetchPriority="high"/i);
    expect(first).not.toContain('loading="lazy"');
    for (const image of rest) {
      expect(image).toContain('loading="lazy"');
      expect(image).not.toMatch(/fetchPriority/i);
    }
  });

  it('draws no cards on a later page, or for a setter with three climbs', async () => {
    setterData.value = pageData(FIVE_CLIMBS);
    expect(await render({ page: '2' })).not.toContain('setter.mostSent.heading');

    setterData.value = pageData(FIVE_CLIMBS.slice(0, 3));
    expect(await render()).not.toContain('setter.mostSent.heading');
  });

  it("links the board chip to that board's climb list", async () => {
    setterData.value = pageData(FIVE_CLIMBS);

    const html = await render();
    const listHref = buildCanonicalClimbListUrl(
      getBoardImageDetailsForBoard({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] }),
      40,
    );

    // The chip, and the "every climb on" link at the foot, name one URL.
    expect(html.match(new RegExp(`href="${listHref}"`, 'g')) ?? []).toHaveLength(2);
    expect(html).toContain('aria-label="setter.browseBoard"');
  });

  it('keeps the board as a plain label when no climb on the page has a canonical config', async () => {
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Unlinkable', requiredSetIds: [1, 20, 26] }]);

    const html = await render();

    expect(html).not.toMatch(/href="[^"]*\/list"/);
    expect(html).toContain('>Kilter<');
  });
});

describe('the setter front door on a laptop', () => {
  const FIVE_CLIMBS = ['a', 'b', 'c', 'd', 'e'].map((letter) => ({ uuid: letter.repeat(32), name: `Climb ${letter}` }));

  it("shows a QR code that opens page one of this setter's climbs on a phone", async () => {
    setterData.value = pageData(FIVE_CLIMBS);

    const html = await render({ page: '2' }, 'jimmy webb');
    const encoded = /data-qr-value="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');

    expect(html.match(/data-qr-value=/g) ?? []).toHaveLength(1);
    expect(encoded).toBe(setterQrUrl('/setter/jimmy%20webb', 'en-US'));
    expect(encoded).toContain('/setter/jimmy%20webb?src=qr&medium=desktop');
    expect(html).toContain('setter.qr.title');
    expect(html).toContain('aria-label="setter.qr.imageLabel:Marco"');
  });

  it("gives the QR card's store buttons their own link id, apart from the phone's", async () => {
    setterData.value = pageData(FIVE_CLIMBS);

    const html = await render();

    expect(html).toContain('ct=setter-qr-card');
    expect(html).toContain('ct=setter&amp;');
    // One store pair per screen: the phone's and the laptop's, never both shown.
    expect(html.match(/href="https:\/\/apps\.apple\.com/g) ?? []).toHaveLength(2);
  });
});

describe('the setter front door, as a crawler reads its head', () => {
  it('names THIS page in the structured data, not page 1', async () => {
    // On `?page=2` the graph used to carry page 1's URL while the document
    // self-canonicalised to `?page=2` and the ItemList positions started at 51 —
    // structured data asserting that the page-1 URL contains items 51–100.
    // The expectation is COMPUTED from `generateMetadata`'s own canonical, so
    // it cannot pass by both halves drifting together.
    setterData.value = pageData([
      { uuid: 'a'.repeat(32), name: 'First Climb' },
      { uuid: 'b'.repeat(32), name: 'Second Climb' },
    ]);

    const [html, metadata] = await Promise.all([render({ page: '2' }), metadataFor({ page: '2' })]);
    const canonical = absoluteUrl(String(metadata.alternates?.canonical));
    const graph = graphOf(html);

    expect(canonical).toContain('?page=2');
    const profilePage = graph.find((node) => node['@type'] === 'ProfilePage');
    expect(profilePage?.['@id']).toBe(canonical);
    expect(profilePage?.url).toBe(canonical);
    expect(graph.find((node) => node['@type'] === 'ItemList')?.url).toBe(canonical);
    expect(graph.some((node) => node.mainEntityOfPage)).toBe(false);
  });

  it('noindexes a page that renders no crawlable climb link at all', async () => {
    // 22,490 of the 91,946 setters who answer 200 on the dev image (24.5%) have
    // no climb on any configuration `resolveClimbSitemapGroups` resolves, so
    // their page is an `<h1>` over rows with no anchor. The sitemap already
    // refuses to submit them; this keeps the ones a share link surfaces out of
    // the index too.
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Unlinkable', requiredSetIds: [1, 20, 26] }]);

    const [metadata, html] = await Promise.all([metadataFor(), render()]);

    expect(html.match(/href="\/kilter\/[^"]*\/view\/[^"]*"/g) ?? []).toHaveLength(0);
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('keeps a page whose climbs DO link indexable', async () => {
    // The control for the assertion above: without it a `robots` that was
    // always `noindex` would pass just as happily.
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Linkable' }]);

    const [metadata, html] = await Promise.all([metadataFor(), render()]);

    expect(html.match(/href="\/kilter\/[^"]*\/view\/[^"]*"/g) ?? []).toHaveLength(1);
    expect(metadata.robots).toBeUndefined();
  });

  it('404s from the head, and queries nothing, for a `?page` past the hard ceiling', async () => {
    // The page body 404s there before it touches the database, and the head
    // 404s on the identical condition — a crawler walking `?page=50000` must
    // not cost one setter-page query per guess.
    //
    // `notFound()` in both, not noindex metadata in one: metadata built on this
    // branch is discarded, and two readers of one condition emitting different
    // signals is how they drift apart.
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'First Climb' }]);
    const before = notFoundCalls.count;

    await expect(metadataFor({ page: '5000' })).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFoundCalls.count).toBe(before + 1);
    expect(ogSummary.calls).toBe(0);
  });

  it('starts both of its reads at once rather than one after the other', async () => {
    // The OG summary and the page view are two independent queries, and the
    // early return between them saves neither: the body resolves the page view
    // on every request, the 404 path included. Awaiting them in sequence only
    // added a round trip to the head of every cold request.
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'First Climb' }]);

    await metadataFor();

    const viewStart = readOrder.events.indexOf('view:start');
    const ogEnd = readOrder.events.indexOf('og:end');
    // Presence first, and not as ceremony: `indexOf` answers -1 for an event
    // that never happened, and -1 satisfies the ordering check against any real
    // index. A refactor that stopped this path reaching `getSetterPageData` at
    // all would otherwise turn this test green by removing what it measures.
    expect(viewStart).toBeGreaterThan(-1);
    expect(ogEnd).toBeGreaterThan(-1);
    expect(viewStart).toBeLessThan(ogEnd);
  });

  it.each([
    [
      'a setter the OG summary does not know',
      () => {
        ogSummary.value = null;
      },
    ],
    [
      'a lookup that blew up',
      () => {
        ogSummary.failure = new Error('summary lookup failed');
      },
    ],
  ])('keeps the %s cross-canonicalised instead of republishing its locale twins', async (_case, arrange) => {
    // Both fallback branches used to answer through `createNoIndexMetadata`,
    // which delegates to `createPageMetadata` and therefore ships a
    // self-canonical plus the full four-locale `alternates.languages` map. On a
    // surface of ~32,000 setter URLs that is the hreflang cluster the whole
    // board-content carve-out exists to collapse — and `robots: noindex` does
    // not suppress it, because `hreflang` is read independently.
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'First Climb' }]);
    serverLocale.value = 'de';
    arrange();

    const metadata = await metadataFor();

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/setter/marco');
    expect(metadata.alternates?.languages).toBeUndefined();
  });

  it('still canonicalises the served locale onto the default one when the setter DOES resolve', async () => {
    // The control: a green pair above would also be satisfied by a head that
    // emitted no `alternates` at all on any branch.
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Linkable' }]);
    serverLocale.value = 'de';

    const metadata = await metadataFor();

    expect(metadata.alternates?.canonical).toBe('/setter/marco');
    expect(metadata.alternates?.languages).toBeUndefined();
  });

  it('points the share preview at the backend setter card, versioned by what it draws', async () => {
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Most Sent' }]);

    const first = await metadataFor();
    const [firstImage] = (first.openGraph?.images ?? []) as Array<{ url: string }>;
    expect(firstImage.url).toMatch(
      /^https:\/\/ws\.boardsesh\.com\/og\/setter\?username=marco&v=[0-9a-f]{12}-[0-9a-z]+$/,
    );

    // A new most-sent climb is a new card, so it must be a new URL: the old
    // token was a constant and a setter card could stay stale forever.
    setterData.value = pageData([{ uuid: 'b'.repeat(32), name: 'New Favourite' }]);
    const second = await metadataFor({}, 'marco ');
    const [secondImage] = (second.openGraph?.images ?? []) as Array<{ url: string }>;
    expect(secondImage.url.split('v=')[1]).not.toBe(firstImage.url.split('v=')[1]);
  });

  it('headlines the send total once there are ten sends, and the climb count below that', async () => {
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Most Sent' }]);
    ogSummary.value = { displayName: 'Marco', totalAscents: 1_136_595, version: 'v1' };

    const prolific = await metadataFor();
    // The mocked `t` prints the key and the name.
    expect(prolific.openGraph?.title).toBe('metadata.setter.ogTitleSends:Marco');
    expect(prolific.openGraph?.description).toBe(
      'metadata.setter.ogSetCount metadata.setter.ogMostSent metadata.setter.ogPickOne',
    );

    ogSummary.value = { displayName: 'Marco', totalAscents: 9, version: 'v1' };
    const quiet = await metadataFor({}, 'marco2');
    expect(quiet.openGraph?.title).toBe('metadata.setter.ogTitleSetCount:Marco');
    expect(quiet.openGraph?.description).toBe(
      'metadata.setter.ogOnBoards metadata.setter.ogMostSentSoFar metadata.setter.ogGoGetOnIt',
    );
  });

  it('titles the search result with the climb count and boards, and describes the sends', async () => {
    setterData.value = pageData([
      { uuid: 'a'.repeat(32), name: 'Most Sent' },
      { uuid: 'b'.repeat(32), name: 'Runner Up' },
    ]);
    ogSummary.value = { displayName: 'Marco', totalAscents: 120, version: 'v1' };

    const metadata = await metadataFor();

    // The mocked `t` prints the key and the name; the wording itself is pinned
    // against the real catalogs in `search-description.test.ts`.
    expect(metadata.title).toEqual({ absolute: 'metadata.setter.titleWithClimbs:Marco | Boardsesh' });
    expect(metadata.description).toBe(
      'metadata.setter.descriptionSetCount:Marco metadata.setter.descriptionSends metadata.setter.descriptionCta',
    );
  });

  it('keeps the counts on a later page, from the page the head already read, and numbers it', async () => {
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Most Sent' }]);
    ogSummary.value = { displayName: 'Marco', totalAscents: 120, version: 'v1' };

    const metadata = await metadataFor({ page: '2' });

    // Page 2 is indexable with its own canonical, so it must not share page 1's title.
    expect(metadata.title).toEqual({ absolute: 'metadata.setter.titleWithClimbsPage:Marco | Boardsesh' });
  });

  it('leaves the sends out for a setter nobody has sent yet, and asks no one to "pick" from one climb', async () => {
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'Fresh' }]);

    const metadata = await metadataFor();

    expect(metadata.description).toBe('metadata.setter.descriptionSetCount:Marco metadata.setter.descriptionCtaSingle');
  });

  it('serves a setter whose name contains a percent sign instead of 500ing on it', async () => {
    // Next already decoded the dynamic segment, so the page's own
    // `decodeURIComponent` was a SECOND decode: `50%` threw an unhandled
    // `URIError` out of both `generateMetadata` and the page body — a 500 where
    // a 404 or a 200 belongs — and `abc%2541` was silently rewritten to `abcA`,
    // a canonical naming a different setter.
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'First Climb' }]);

    const metadata = await metadataFor({}, '50%');
    expect(metadata.alternates?.canonical).toBe('/setter/50%25');

    const html = await render({}, '50%');
    expect(html).toContain('setter.seoHeading:Marco');
  });
});
