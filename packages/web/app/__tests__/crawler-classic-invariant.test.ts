import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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

// `@/app/lib/slug-utils` is the db-import trap, NOT `@/app/lib/url-utils.server`:
// slug-utils imports `@/app/lib/db/db`, whose module body calls
// `createPool()`/`createDb()` at load time. Mocking the actual offender keeps
// the REAL `redirectWithQuery` in the graph. `url-utils.server` pulls exactly
// these three from here, and no other module this test imports touches it.
vi.mock('@/app/lib/slug-utils', () => ({
  getLayoutBySlug: vi.fn(async () => null),
  getSizeBySlug: vi.fn(async () => null),
  getSetsBySlug: vi.fn(async () => null),
}));

// Only `parseRouteParams` is stubbed, via `importOriginal`, so the rest of the
// module stays real — crucially `redirectWithQuery`, which is what actually
// emits the `/play`→`/view` `Location` in (C1)/(C2). Asserting against a
// test-local copy of it would make those two cases a rebuilt predicate.
// `@/app/lib/url-utils` is left REAL for the same reason: the redirect targets
// these tests assert on are built there (`constructClimbListWithSlugs`,
// `constructClimbViewUrlWithSlugs`, `constructBoardSlugViewUrl`).
vi.mock('@/app/lib/url-utils.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/url-utils.server')>()),
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
  boardToRouteParamsFromAngleSegment: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    angle: 40,
  })),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOgImageWarming: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayPreloadUrls: vi.fn((_bd: unknown, frames: string | null | undefined) =>
    frames ? ['/api/internal/board-render'] : [],
  ),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));

// Render stubs: neither renders on the redirect path — every module below
// throws its redirect before returning JSX — but they still need to import
// cleanly, since the page/layout modules import them at the top level. The
// eight climbing-stack stubs that used to sit here (board-page, graphql-queue,
// connection-manager, persistent-session, queue-control) came out with W-16:
// the modules they mocked no longer exist, and vitest throws on a mock whose
// path the module graph never reaches.
vi.mock('@/app/components/climb-detail/climb-view-seo-fragment', () => ({ default: () => null }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: () => null }));

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
const { getClimb } = await import('@/app/lib/data/queries');

const PROD_HOST = 'www.boardsesh.com';
const PROD_ORIGIN = `https://${PROD_HOST}`;
const REDIRECT_STATUSES = [301, 302, 307, 308];
// Test requests ride on the dev origin (see `makeRequest`), and the vacuity
// self-tests below construct rewrites against PROD_ORIGIN. A legitimate
// middleware rewrite never leaves those hosts — `app.boardsesh.com` under a
// clean pathname is the same crawler harm with the `/app` prefix laundered off.
const REQUEST_ORIGIN = 'http://localhost:3000';
const ALLOWED_REWRITE_HOSTS = [new URL(REQUEST_ORIGIN).host, PROD_HOST];

// The rewrite target, when there is one. `next.config.mjs` serves `/app` by
// REWRITE, so a status-only invariant leaves the same crawler harm reachable by
// a different mechanism: the noindex SPA rendered at a canonical board URL.
function rewriteTargetPathname(response: ReturnType<typeof middleware>): string | null {
  const rewriteTarget = response.headers.get('x-middleware-rewrite');
  return rewriteTarget === null ? null : new URL(rewriteTarget, PROD_ORIGIN).pathname;
}

function expectNoRedirect(response: ReturnType<typeof middleware>): void {
  expect(REDIRECT_STATUSES).not.toContain(response.status);
  expect(response.headers.get('location')).toBeNull();
  // Not-a-redirect is not enough: the surface must also not be rewritten onto
  // the `/app` SPA, nor onto a foreign host. `x-middleware-rewrite` carries an
  // absolute URL, so the host is checked before the pathname.
  const rewriteTarget = response.headers.get('x-middleware-rewrite');
  if (rewriteTarget !== null) {
    const resolved = new URL(rewriteTarget, PROD_ORIGIN);
    expect(ALLOWED_REWRITE_HOSTS).toContain(resolved.host);
    expect(resolved.pathname === '/app' || resolved.pathname.startsWith('/app/')).toBe(false);
  }
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
  return new NextRequest(new URL(url, REQUEST_ORIGIN));
}

const ORIGINAL_EXPO_WEB_FLAG = process.env.BOARDSESH_WEB;

beforeEach(() => {
  // clearAllMocks clears call records, not implementations — mirrors the
  // layout-redirect.test.tsx harness this file's mocks are copied from.
  vi.clearAllMocks();
  requestHeaders.clear();
});

afterEach(() => {
  if (ORIGINAL_EXPO_WEB_FLAG === undefined) {
    delete process.env.BOARDSESH_WEB;
  } else {
    process.env.BOARDSESH_WEB = ORIGINAL_EXPO_WEB_FLAG;
  }
});

const CANONICAL_SURFACES = [
  '/kilter/original/12x12-square/screw_bolt/40/list',
  '/b/kilter-original-12x12/40/list',
  '/kilter/original/12x12-square/screw_bolt/40/view/test-climb-abcdef1234567890abcdef1234567890',
  '/b/kilter-original-12x12/40/view/test-climb-abcdef1234567890abcdef1234567890',
];

// `middleware.ts` reads `BOARDSESH_WEB` at REQUEST time (the `/app` and
// `/assets` carve-outs), and `Dockerfile.web` sets it in both the builder and
// the runner stage — flag-ON is production's shipped configuration, not an
// exotic case. The deleted rollout redirect was gated on exactly this flag, so
// run the whole invariant under both states: an env-gated re-arm has to fail
// this suite rather than slip past because the flag happened to be unset.
// Only board surfaces are asserted here — the `/app` carve-out itself is
// legitimate behaviour and is owned by middleware.test.ts.
describe.each([
  ['BOARDSESH_WEB=1 (production default)', '1'],
  ['BOARDSESH_WEB unset', undefined],
] as const)("middleware, %s: a cookie-less request to a canonical board URL never 3xx's", (_label, flagValue) => {
  beforeEach(() => {
    if (flagValue === undefined) {
      delete process.env.BOARDSESH_WEB;
    } else {
      process.env.BOARDSESH_WEB = flagValue;
    }
  });

  it.each(CANONICAL_SURFACES)('no cookies at all: %s', (surface) => {
    expectNoRedirect(middleware(makeRequest(surface)));
  });

  const LOCALE_PREFIXED_CASES: [string, string][] = CANONICAL_SURFACES.flatMap((surface) =>
    ['es', 'fr', 'de'].map((locale): [string, string] => [locale, surface]),
  );

  it.each(LOCALE_PREFIXED_CASES)(
    'a locale-prefixed cookie-less request is a rewrite to the locale-stripped surface, never a redirect: /%s%s',
    (locale, surface) => {
      const response = middleware(makeRequest(`/${locale}${surface}`));
      expectNoRedirect(response);
      // WHERE the rewrite points, not merely that one exists: a rewrite onto
      // the noindex `/app` SPA is the same crawler harm as a redirect to it.
      expect(rewriteTargetPathname(response)).toBe(surface);
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
    // Same destination assertion as (A1): host + tree alone are satisfied by a
    // self-redirect, which is a loop, not a canonicalisation.
    expect(target).toContain('/list');
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
    // Mirrors (C1). Without these, a `/b` play page redirecting to ITSELF — an
    // infinite loop — satisfies host + tree and passes.
    expect(target).toContain('/view/');
    expect(target).not.toContain('/play/');
  });

  // Both play pages wrap `getClimb` in try/catch and fall back to the bare-uuid
  // `/view/` URL when the climb has no resolvable name. With `getClimb` always
  // resolving a name, that fallback branch of the URL builders is dead code
  // under this suite — so a regression confined to it (a `/play` self-redirect
  // loop) would ship green. These two exercise it for real.
  it('(C1n) /play→/view still holds when the climb name cannot be resolved (config-tuple tree)', async () => {
    const sourcePath = `/kilter/1/10/1,20/40/play/${CLIMB_UUID}`;
    vi.mocked(getClimb).mockRejectedValueOnce(new Error('db unavailable'));
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
    expect(target).toContain(`/view/${CLIMB_UUID}`);
    expect(target).not.toContain('/play/');
  });

  it('(C2n) /play→/view still holds when the climb name cannot be resolved (/b tree)', async () => {
    const sourcePath = `/b/kilter-original-12x12/40/play/${CLIMB_UUID}`;
    vi.mocked(getClimb).mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      SlugPlayPage({
        params: Promise.resolve({ board_slug: 'kilter-original-12x12', angle: '40', climb_uuid: CLIMB_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    const target = permanentRedirect.mock.calls[0]![0];
    expectSameHostRedirectTarget(target);
    expectSameTree(sourcePath, target);
    expect(target).toContain(`/view/${CLIMB_UUID}`);
    expect(target).not.toContain('/play/');
  });
});

describe('the guard is not vacuous: it catches what the pre-teardown helper missed', () => {
  it('expectNoRedirect rejects all four redirect statuses, not just 307', () => {
    for (const status of REDIRECT_STATUSES) {
      expect(() => expectNoRedirect(NextResponse.redirect('https://www.boardsesh.com/app/climbs', status))).toThrow();
    }
  });

  it('expectNoRedirect rejects a same-host REWRITE onto the /app SPA', () => {
    // `next.config.mjs` serves `/app` by rewrite, so this is the realistic way
    // to regress the invariant without emitting any 3xx at all.
    expect(() => expectNoRedirect(NextResponse.rewrite(new URL('/app/climbs', PROD_ORIGIN)))).toThrow();
    expect(() => expectNoRedirect(NextResponse.rewrite(new URL('/app', PROD_ORIGIN)))).toThrow();
    // A rewrite to a real board surface — what locale-stripping does — is fine.
    expect(() =>
      expectNoRedirect(NextResponse.rewrite(new URL('/kilter/original/12x12-square/screw_bolt/40/list', PROD_ORIGIN))),
    ).not.toThrow();
  });

  it('expectNoRedirect rejects a CROSS-HOST rewrite even under a clean pathname', () => {
    // The `/app` pathname check alone is launderable: serve the SPA from the
    // app host under the canonical pathname and no `/app` prefix ever appears.
    expect(() => expectNoRedirect(NextResponse.rewrite(new URL('https://app.boardsesh.com/climbs')))).toThrow();
    expect(() =>
      expectNoRedirect(
        NextResponse.rewrite(new URL('/kilter/original/12x12-square/screw_bolt/40/list', 'https://app.boardsesh.com')),
      ),
    ).toThrow();
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
