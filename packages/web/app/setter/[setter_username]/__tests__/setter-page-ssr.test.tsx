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
  getSetterPageData: async () => setterData.value,
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
vi.mock('../setter-follow-island', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));

const SetterProfilePage = (await import('../page')).default;

type StubClimb = {
  uuid: string;
  name: string;
  isDraft?: boolean;
  isListed?: boolean;
};

function climbRow(climb: StubClimb) {
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
    requiredSetIds: [1, 20],
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

async function render(searchParams: Record<string, string> = {}) {
  return renderPage(
    await SetterProfilePage({
      params: Promise.resolve({ setter_username: 'marco' }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

beforeEach(() => {
  notFoundCalls.count = 0;
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

  it('404s a `?page` past the hard ceiling instead of running a deep OFFSET', async () => {
    setterData.value = pageData([{ uuid: 'a'.repeat(32), name: 'First Climb' }]);

    await expect(render({ page: '5000' })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
