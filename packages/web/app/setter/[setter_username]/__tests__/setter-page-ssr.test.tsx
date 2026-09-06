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
  value: { displayName: 'Marco', version: 'v1' } as { displayName: string; version: string } | null,
  calls: 0,
}));

/**
 * Which of the head's two reads started when.
 *
 * Both stubs below suspend once before they resolve, which is the whole trick:
 * a `Promise.all` calls both functions before either can get past that await,
 * so `view:start` lands before `og:end`. Sequenced awaits cannot produce that
 * order no matter how fast either read is, so the assertion is about the code's
 * shape rather than about timing.
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
  getSetterOgSummary: async () => {
    ogSummary.calls += 1;
    readOrder.events.push('og:start');
    await Promise.resolve();
    readOrder.events.push('og:end');
    return ogSummary.value;
  },
}));

vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    locale: 'en-US',
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
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));

const pageModule = await import('../page');
const SetterProfilePage = pageModule.default;
const { generateMetadata } = pageModule;
const { absoluteUrl } = await import('@/app/lib/seo/base-url');

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
  ogSummary.value = { displayName: 'Marco', version: 'v1' };
  ogSummary.calls = 0;
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
    expect(graph.find((node) => node['@type'] === 'ItemList')?.mainEntityOfPage?.['@id']).toBe(canonical);
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

    expect(readOrder.events.indexOf('view:start')).toBeLessThan(readOrder.events.indexOf('og:end'));
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
