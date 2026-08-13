import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest, NextResponse } from 'next/server';
import { PATHNAME_HEADER } from '@/app/lib/request-pathname-header';

/**
 * Reposition invariant (Phase A0), rewritten for W-09.
 *
 * The expo-web rollout redirect — the `middleware.ts` block gated on
 * `BOARDSESH_WEB=1`, including the `?classic=1` escape hatch — is deleted.
 * This file is now the single owner of the crawler-classic contract:
 *
 *  1. A cookie-less request to a canonical board URL (`/b/**`, a config-tuple
 *     `.../list`, or a config-tuple `.../view/**`) gets NO 3xx at all from
 *     middleware. The old contract only checked status 307 with a pathname
 *     starting `/app` — blind to a 308, to a cross-host `Location`, and to a
 *     legacy→`/b` redirect.
 *  2. The three legitimate same-host redirect classes — numeric→slug in the
 *     `[angle]` and `[angle]/list` layouts, bare-uuid/numeric→slug at
 *     `view/[climb_uuid]`, and `/play`→`/view` on both trees — are owned by
 *     React Server Components, not middleware, so they are invisible to a bare
 *     `middleware(request)` call. This file exercises the real page/layout
 *     modules with a captured `permanentRedirect` and resolves each captured
 *     target with `new URL(target, 'https://www.boardsesh.com')`: a relative
 *     path resolves to that host, an absolute `https://app.boardsesh.com/...`
 *     target does not. Assertions run on the `Location` HOST, never the
 *     pathname, because a pathname check can't tell a legitimate same-host
 *     308 apart from a cross-host redirect that happens to share a pathname
 *     shape — and a blanket ban on redirect statuses would be wrong, because
 *     those same-host 308s are correct.
 *
 * The config-tuple tree is canonical (locked decision); `/b` cross-canonicals
 * into it. A redirect must never cross trees.
 */

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

const { permanentRedirect, notFound, requestHeaders } = vi.hoisted(() => {
  const hoistedRedirect = vi.fn((url: string) => {
    const redirectError = new Error('NEXT_REDIRECT') as Error & { digest: string };
    redirectError.digest = `NEXT_REDIRECT;replace;${url};308;`;
    throw redirectError;
  });
  const hoistedNotFound = vi.fn(() => {
    throw new Error('NOT_FOUND');
  });
  return { permanentRedirect: hoistedRedirect, notFound: hoistedNotFound, requestHeaders: new Map<string, string>() };
});
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ permanentRedirect, notFound }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({ get: (name: string) => requestHeaders.get(name) ?? null })),
}));

// `@/app/lib/url-utils.server` is mocked WHOLESALE — never via `importOriginal`.
// The real module imports `./slug-utils`, which imports `@/app/lib/db/db`,
// whose module body calls `createPool()`/`createDb()` at load time.
// `@/app/lib/url-utils` is deliberately left REAL: the redirect targets these
// tests assert on are built there (`constructClimbListWithSlugs`,
// `constructClimbViewUrlWithSlugs`, `constructBoardSlugViewUrl`), so the
// host-preservation property is exercised for real rather than re-asserted
// against a rebuilt predicate. Trade-off: `redirectWithQuery`'s own query-string
// handling is not exercised for real — unavoidable given the db-import trap.
vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 10,
      set_ids: [1, 20],
      angle: 40,
      climb_uuid: CLIMB_UUID,
    },
    isNumericFormat: true,
  })),
  redirectWithQuery: vi.fn((viewUrl: string, searchParams: Record<string, string | string[]>) => {
    const query = new URLSearchParams(
      Object.entries(searchParams).flatMap(([key, value]) =>
        Array.isArray(value) ? value.map((v) => [key, v]) : [[key, value]],
      ),
    ).toString();
    permanentRedirect(query ? `${viewUrl}?${query}` : viewUrl);
  }),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12',
    size_description: 'Commercial',
    set_names: ['Bolt Ons', 'Screw Ons'],
  })),
  generateBoardTitle: vi.fn(() => 'Kilter Board'),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({ name: 'My Test Climb', frames: 'p1r12' })),
  getLayouts: vi.fn(async () => [{ id: 1, name: 'Kilter Board Original' }]),
  getSizes: vi.fn(async () => [{ id: 10, name: '12 x 12', description: 'Commercial' }]),
  getSets: vi.fn(async () => [
    { id: 1, name: 'Bolt Ons' },
    { id: 20, name: 'Screw Ons' },
  ]),
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: vi.fn(async () => ({
    slug: 'kilter-original-12x12',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    isPublic: true,
    isUnlisted: false,
  })),
  boardToRouteParams: vi.fn(() => ({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20], angle: 40 })),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOverlayWarming: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));

// Render stubs: none of these render on the redirect path — every module below
// throws its redirect before returning JSX — but they still need to import
// cleanly, since the page/layout modules import them at the top level.
vi.mock('@/app/components/board-page/board-page-climbs-list', () => ({ default: () => null }));
vi.mock('@/app/components/climb-detail/climb-view-seo-fragment', () => ({ default: () => null }));
vi.mock('@/app/components/board-page/header', () => ({ default: () => null }));
vi.mock('@/app/components/board-page/last-used-board-tracker', () => ({ default: () => null }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: () => null }));
vi.mock('@/app/components/graphql-queue', () => ({ GraphQLQueueProvider: () => null }));
vi.mock('@/app/components/connection-manager/connection-settings-context', () => ({
  ConnectionSettingsProvider: () => null,
}));
vi.mock('@/app/components/connection-manager/websocket-connection-provider', () => ({
  WebSocketConnectionProvider: () => null,
}));
vi.mock('@/app/components/persistent-session', () => ({ BoardSessionBridge: () => null }));
vi.mock('@/app/components/queue-control/ui-searchparams-provider', () => ({ UISearchParamsProvider: () => null }));
vi.mock('@/app/components/queue-control/queue-bridge-context', () => ({ QueueBridgeInjector: () => null }));
vi.mock('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/list/layout-client', () => ({
  default: () => null,
}));

const { middleware } = await import('@/middleware');
const BoardAngleLayout = (await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/layout')).default;
const BoardListLayout = (await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/list/layout'))
  .default;
const ClimbViewPage = (
  await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page')
).default;
const LegacyPlayPage = (
  await import('@/app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/play/[climb_uuid]/page')
).default;
const SlugPlayPage = (await import('@/app/b/[board_slug]/[angle]/play/[climb_uuid]/page')).default;

const PROD_HOST = 'www.boardsesh.com';
const PROD_ORIGIN = `https://${PROD_HOST}`;
const REDIRECT_STATUSES = [301, 302, 307, 308];

function expectNoRedirect(response: ReturnType<typeof middleware>): void {
  expect(REDIRECT_STATUSES).not.toContain(response.status);
  expect(response.headers.get('location')).toBeNull();
}

// A relative target resolves to the prod host; an absolute
// `https://app.boardsesh.com/...` target does not — that's the whole point.
function expectSameHostRedirectTarget(target: string): void {
  expect(new URL(target, PROD_ORIGIN).host).toBe(PROD_HOST);
}

// The config-tuple tree is canonical; `/b` cross-canonicals into it. A
// redirect must never cross trees.
function expectSameTree(sourcePath: string, target: string): void {
  expect(new URL(target, PROD_ORIGIN).pathname.startsWith('/b/')).toBe(sourcePath.startsWith('/b/'));
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

beforeEach(() => {
  // clearAllMocks clears call records, not implementations — mirrors the
  // layout-redirect.test.tsx harness this file's mocks are copied from.
  vi.clearAllMocks();
  requestHeaders.clear();
});

describe("middleware: a cookie-less request to a canonical board URL never 3xx's", () => {
  const CANONICAL_SURFACES = [
    '/kilter/original/12x12-square/screw_bolt/40/list',
    '/b/kilter-original-12x12/40/list',
    '/kilter/original/12x12-square/screw_bolt/40/view/test-climb-abcdef1234567890abcdef1234567890',
    '/b/kilter-original-12x12/40/view/test-climb-abcdef1234567890abcdef1234567890',
  ];

  it.each(CANONICAL_SURFACES)('no cookies at all: %s', (surface) => {
    expectNoRedirect(middleware(makeRequest(surface)));
  });

  const LOCALE_PREFIXED_CASES: [string, string][] = CANONICAL_SURFACES.flatMap((surface) =>
    ['es', 'fr', 'de'].map((locale): [string, string] => [surface, locale]),
  );

  it.each(LOCALE_PREFIXED_CASES)(
    'a locale-prefixed cookie-less request is a rewrite, never a redirect: /%s%s',
    (surface, locale) => {
      const response = middleware(makeRequest(`/${locale}${surface}`));
      expectNoRedirect(response);
      expect(response.headers.has('x-middleware-rewrite')).toBe(true);
    },
  );

  it("the numeric legacy view URL gets no middleware hop — its redirect is the page's own", () => {
    const response = middleware(makeRequest('/kilter/1/10/1,20/40/view/abcdef1234567890abcdef1234567890'));
    expectNoRedirect(response);
  });

  it.each(['/kilter/original/12x12-square/screw_bolt/40/list', '/b/kilter-original-12x12/40/list'])(
    '?classic=1 is inert on %s: the page renders, no 307, no cookie set',
    (listPath) => {
      const response = middleware(makeRequest(`${listPath}?classic=1`));
      expectNoRedirect(response);
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('s-maxage=86400, stale-while-revalidate=604800');
    },
  );
});

describe('the three legitimate redirect classes stay on www.boardsesh.com', () => {
  it('(A1) numeric→slug in the board [angle] layout', async () => {
    const sourcePath = '/kilter/1/10/1,20/40/list';
    requestHeaders.set(PATHNAME_HEADER, sourcePath);
    await expect(
      BoardAngleLayout({
        params: Promise.resolve({ board_name: 'kilter', layout_id: '1', size_id: '10', set_ids: '1,20', angle: '40' }),
        children: null,
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    const target = permanentRedirect.mock.calls[0]![0];
    expectSameHostRedirectTarget(target);
    expectSameTree(sourcePath, target);
    expect(target).toContain('/list');
  });

  it('(A2) numeric→slug in the [angle]/list layout', async () => {
    const sourcePath = '/kilter/1/10/1,20/40/list';
    await expect(
      BoardListLayout({
        params: Promise.resolve({ board_name: 'kilter', layout_id: '1', size_id: '10', set_ids: '1,20', angle: '40' }),
        children: null,
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    const target = permanentRedirect.mock.calls[0]![0];
    expectSameHostRedirectTarget(target);
    expectSameTree(sourcePath, target);
  });

  it('(B) bare-uuid/numeric→slug at the climb view page', async () => {
    const sourcePath = `/kilter/1/10/1,20/40/view/${CLIMB_UUID}`;
    await expect(
      ClimbViewPage({
        params: Promise.resolve({
          board_name: 'kilter',
          layout_id: '1',
          size_id: '10',
          set_ids: '1,20',
          angle: '40',
          climb_uuid: CLIMB_UUID,
        }),
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    const target = permanentRedirect.mock.calls[0]![0];
    expectSameHostRedirectTarget(target);
    expectSameTree(sourcePath, target);
    expect(target).toContain('/view/');
    expect(target).toContain(CLIMB_UUID);
  });

  it('(C1) /play→/view on the config-tuple tree', async () => {
    const sourcePath = `/kilter/1/10/1,20/40/play/${CLIMB_UUID}`;
    await expect(
      LegacyPlayPage({
        params: Promise.resolve({
          board_name: 'kilter',
          layout_id: '1',
          size_id: '10',
          set_ids: '1,20',
          angle: '40',
          climb_uuid: CLIMB_UUID,
        }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    const target = permanentRedirect.mock.calls[0]![0];
    expectSameHostRedirectTarget(target);
    expectSameTree(sourcePath, target);
    expect(target).toContain('/view/');
    expect(target).not.toContain('/play/');
  });

  it('(C2) /play→/view on the /b tree', async () => {
    const sourcePath = `/b/kilter-original-12x12/40/play/${CLIMB_UUID}`;
    await expect(
      SlugPlayPage({
        params: Promise.resolve({ board_slug: 'kilter-original-12x12', angle: '40', climb_uuid: CLIMB_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    const target = permanentRedirect.mock.calls[0]![0];
    // Stays inside /b/ — the mirror of the legacy→/b negative case below.
    expectSameHostRedirectTarget(target);
    expectSameTree(sourcePath, target);
  });
});

describe('the guard is not vacuous: it catches what the pre-teardown helper missed', () => {
  it('expectNoRedirect rejects all four redirect statuses, not just 307', () => {
    for (const status of REDIRECT_STATUSES) {
      expect(() => expectNoRedirect(NextResponse.redirect('https://www.boardsesh.com/app/climbs', status))).toThrow();
    }
  });

  it('expectSameHostRedirectTarget rejects a cross-host Location', () => {
    expect(() => expectSameHostRedirectTarget('https://app.boardsesh.com/climbs/abc')).toThrow();
    // Same pathname SHAPE as a legitimate target — a pathname check would wave
    // this through. That's the old blindness this helper closes.
    expect(() =>
      expectSameHostRedirectTarget('https://app.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/list'),
    ).toThrow();
  });

  it('expectSameHostRedirectTarget accepts a same-host relative or absolute target', () => {
    expect(() => expectSameHostRedirectTarget('/kilter/original/12x12-square/screw_bolt/40/list')).not.toThrow();
    expect(() =>
      expectSameHostRedirectTarget('https://www.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/list'),
    ).not.toThrow();
  });

  it('expectSameTree rejects a legacy → /b redirect (same host, wrong tree)', () => {
    expect(() => expectSameTree('/kilter/1/10/1,20/40/list', '/b/kilter-original-12x12/40/list')).toThrow();
    expect(() =>
      expectSameTree('/b/kilter-original-12x12/40/list', '/kilter/original/12x12-square/screw_bolt/40/list'),
    ).toThrow();
  });
});
