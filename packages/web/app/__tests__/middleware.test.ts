import { afterEach, beforeEach, describe, it, expect } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { CLIMB_SESSION_COOKIE } from '@/app/lib/climb-session-cookie';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_HEADER } from '@/app/lib/i18n/config';
import { PATHNAME_HEADER } from '@/app/lib/request-pathname-header';

const { getClimbViewPageCacheTTL, getListPageCacheTTL, hasUserSpecificFilters } =
  await import('@/app/lib/list-page-cache');
const { middleware, config } = await import('@/middleware');

function sp(params: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams(params);
}

const TTL_24H = 86400;
const LEGACY_LIST = '/kilter/original/12x12-square/screw_bolt/40/list';
const SLUG_LIST = '/b/kilter-original-12x12/40/list';
// View pages, all three URL shapes that resolve to the same climb.
const SLUG_VIEW = '/b/kilter-original-12x12/40/view/test-climb-abcdef1234567890abcdef1234567890';
const NAMED_VIEW = '/kilter/original/12x12-square/screw_bolt/40/view/test-climb-abcdef1234567890abcdef1234567890';
const NUMERIC_VIEW = '/kilter/1/10/1,20/40/view/abcdef1234567890abcdef1234567890';
const originalExpoWebFlag = process.env.BOARDSESH_WEB;
const originalExpoWebOrigin = process.env.BOARDSESH_EXPO_WEB_ORIGIN;

describe('getListPageCacheTTL', () => {
  describe('route matching', () => {
    // Legacy format: /[board]/[layout]/[size]/[sets]/[angle]/list
    it('matches legacy format list page', () => {
      expect(getListPageCacheTTL(LEGACY_LIST, sp())).toBe(TTL_24H);
    });

    it('matches tension board (legacy format)', () => {
      expect(getListPageCacheTTL('/tension/original/12x12-square/screw_bolt/40/list', sp())).toBe(TTL_24H);
    });

    it('rejects unsupported board (legacy format)', () => {
      expect(getListPageCacheTTL('/fakeboard/original/12x12-square/screw_bolt/40/list', sp())).toBeNull();
    });

    it('rejects legacy path with too few segments', () => {
      expect(getListPageCacheTTL('/kilter/list', sp())).toBeNull();
    });

    it('rejects legacy path with 5 segments (needs 6)', () => {
      expect(getListPageCacheTTL('/kilter/original/12x12-square/screw_bolt/list', sp())).toBeNull();
    });

    // Slug format: /b/[board_slug]/[angle]/list
    it('matches slug format list page', () => {
      expect(getListPageCacheTTL(SLUG_LIST, sp())).toBe(TTL_24H);
    });

    it('matches slug format with different slug', () => {
      expect(getListPageCacheTTL('/b/tension-two-wall-12x12/30/list', sp())).toBe(TTL_24H);
    });

    it('rejects slug path with too few segments (/b/list)', () => {
      expect(getListPageCacheTTL('/b/list', sp())).toBeNull();
    });

    it('rejects slug path with only 3 segments', () => {
      expect(getListPageCacheTTL('/b/kilter-original/list', sp())).toBeNull();
    });

    // Non-list pages
    it('rejects non-list page (legacy format)', () => {
      expect(getListPageCacheTTL('/kilter/original/12x12-square/screw_bolt/40/climb/abc', sp())).toBeNull();
    });

    it('rejects non-list page (slug format)', () => {
      expect(getListPageCacheTTL('/b/kilter-original-12x12/40/climb/abc', sp())).toBeNull();
    });

    it('rejects path not ending in /list', () => {
      expect(getListPageCacheTTL('/kilter/original/12x12-square/screw_bolt/40/queue', sp())).toBeNull();
    });

    it('rejects root path', () => {
      expect(getListPageCacheTTL('/', sp())).toBeNull();
    });
  });

  describe('non-user-specific filters are always cacheable', () => {
    it('caches with grade filters', () => {
      expect(getListPageCacheTTL(LEGACY_LIST, sp({ minGrade: '10', maxGrade: '20' }))).toBe(TTL_24H);
    });

    it('caches with sort params', () => {
      expect(getListPageCacheTTL(LEGACY_LIST, sp({ sortBy: 'difficulty', sortOrder: 'asc' }))).toBe(TTL_24H);
    });

    it('caches with name search', () => {
      expect(getListPageCacheTTL(SLUG_LIST, sp({ name: 'benchmark' }))).toBe(TTL_24H);
    });

    it('caches with minAscents', () => {
      expect(getListPageCacheTTL(SLUG_LIST, sp({ minAscents: '5' }))).toBe(TTL_24H);
    });
  });

  describe('user-specific params skip cache', () => {
    it.each([
      ['hideAttempted', 'true'],
      ['hideAttempted', '1'],
      ['hideCompleted', 'true'],
      ['hideCompleted', '1'],
      ['showOnlyAttempted', 'true'],
      ['showOnlyAttempted', '1'],
      ['showOnlyCompleted', 'true'],
      ['showOnlyCompleted', '1'],
      ['onlyDrafts', 'true'],
      ['onlyDrafts', '1'],
      ['onlyRatedByMe', 'true'],
      ['onlyRatedByMe', '1'],
      // Numeric param — a flag-only 'true'/'1' test reads this as absent and
      // would let personalized HTML share the anonymous CDN entry for 24h.
      ['minUserRating', '4'],
      ['minUserRating', '1'],
    ])('skips cache for %s=%s (legacy format)', (param, value) => {
      expect(getListPageCacheTTL(LEGACY_LIST, sp({ [param]: value }))).toBeNull();
    });

    it.each([
      ['hideAttempted', 'true'],
      ['hideCompleted', '1'],
      ['showOnlyAttempted', 'true'],
      ['showOnlyCompleted', '1'],
      ['onlyDrafts', 'true'],
    ])('skips cache for %s=%s (slug format)', (param, value) => {
      expect(getListPageCacheTTL(SLUG_LIST, sp({ [param]: value }))).toBeNull();
    });
  });

  describe('falsy values for user-specific params are cacheable', () => {
    it.each([
      ['hideAttempted', 'false'],
      ['hideAttempted', '0'],
      ['hideAttempted', 'undefined'],
      ['hideAttempted', ''],
      ['hideCompleted', 'false'],
      ['hideCompleted', '0'],
      ['showOnlyAttempted', 'false'],
      ['showOnlyCompleted', '0'],
      ['onlyDrafts', 'false'],
      ['onlyDrafts', '0'],
      ['onlyRatedByMe', 'false'],
      ['minUserRating', '0'],
      ['minUserRating', ''],
    ])('caches for %s=%s', (param, value) => {
      expect(getListPageCacheTTL(LEGACY_LIST, sp({ [param]: value }))).toBe(TTL_24H);
    });

    // Per-type parsing, not "any non-empty value is user-specific": a crawler
    // appending junk must not turn every list page into a CDN miss.
    it.each([
      ['onlyDrafts', 'x'],
      ['hideAttempted', 'yes'],
      ['minUserRating', 'abc'],
    ])('caches for junk value %s=%s instead of bypassing the CDN', (param, value) => {
      expect(getListPageCacheTTL(LEGACY_LIST, sp({ [param]: value }))).toBe(TTL_24H);
    });
  });

  describe('mixed params', () => {
    it('skips cache when one user-specific param is true among non-specific ones', () => {
      expect(
        getListPageCacheTTL(LEGACY_LIST, sp({ minGrade: '10', hideAttempted: 'true', sortBy: 'difficulty' })),
      ).toBeNull();
    });

    it('caches when user-specific params are all falsy', () => {
      expect(getListPageCacheTTL(LEGACY_LIST, sp({ minGrade: '10', hideAttempted: 'false', onlyDrafts: '0' }))).toBe(
        TTL_24H,
      );
    });
  });
});

describe('getClimbViewPageCacheTTL', () => {
  describe('route matching', () => {
    it('matches the slug view format', () => {
      expect(getClimbViewPageCacheTTL(SLUG_VIEW, sp())).toBe(TTL_24H);
    });

    it('matches the named-segment (legacy) view format', () => {
      expect(getClimbViewPageCacheTTL(NAMED_VIEW, sp())).toBe(TTL_24H);
    });

    it('matches the numeric view format (so its redirect is cacheable)', () => {
      expect(getClimbViewPageCacheTTL(NUMERIC_VIEW, sp())).toBe(TTL_24H);
    });

    it('matches the tension board view', () => {
      expect(getClimbViewPageCacheTTL('/tension/original/12x12/screw_bolt/30/view/some-climb-uuid', sp())).toBe(
        TTL_24H,
      );
    });

    it('rejects an unsupported board (legacy view shape)', () => {
      expect(getClimbViewPageCacheTTL('/fakeboard/1/10/1,20/40/view/some-uuid', sp())).toBeNull();
    });

    it('rejects a list page', () => {
      expect(getClimbViewPageCacheTTL(LEGACY_LIST, sp())).toBeNull();
      expect(getClimbViewPageCacheTTL(SLUG_LIST, sp())).toBeNull();
    });

    it('rejects a play page (the play redirect page carries no OG card worth caching)', () => {
      expect(getClimbViewPageCacheTTL('/kilter/1/10/1,20/40/play/some-uuid', sp())).toBeNull();
      expect(getClimbViewPageCacheTTL('/b/kilter-original-12x12/40/play/some-uuid', sp())).toBeNull();
    });

    it('rejects a create page', () => {
      expect(getClimbViewPageCacheTTL('/kilter/original/12x12-square/screw_bolt/40/create', sp())).toBeNull();
    });

    it('rejects the slug view shape with a wrong segment count', () => {
      // /b/[board_slug]/view/[uuid] is missing the angle segment.
      expect(getClimbViewPageCacheTTL('/b/kilter-original-12x12/view/some-uuid', sp())).toBeNull();
    });

    it('rejects the root and settings paths', () => {
      expect(getClimbViewPageCacheTTL('/', sp())).toBeNull();
      expect(getClimbViewPageCacheTTL('/settings', sp())).toBeNull();
    });
  });

  describe('search params', () => {
    it('caches with non-user-specific params (tracking/query noise)', () => {
      expect(getClimbViewPageCacheTTL(SLUG_VIEW, sp({ utm_source: 'twitter' }))).toBe(TTL_24H);
    });

    it.each([
      ['hideAttempted', 'true'],
      ['showOnlyCompleted', '1'],
      ['onlyDrafts', 'true'],
    ])('skips cache for user-specific %s=%s (matching list behavior)', (param, value) => {
      expect(getClimbViewPageCacheTTL(SLUG_VIEW, sp({ [param]: value }))).toBeNull();
      expect(getClimbViewPageCacheTTL(NAMED_VIEW, sp({ [param]: value }))).toBeNull();
    });
  });
});

describe('hasUserSpecificFilters', () => {
  const baseParams = {
    gradeAccuracy: 0,
    maxGrade: 0,
    minAscents: 0,
    minGrade: 0,
    minRating: 0,
    sortBy: 'ascents' as const,
    sortOrder: 'desc' as const,
    name: '',
    onlyBenchmarks: false,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
    onlyWithBetaVideos: false,
    settername: [] as string[],
    setternameSuggestion: '',
    holdsFilter: {},
    hideAttempted: false,
    hideCompleted: false,
    showOnlyAttempted: false,
    showOnlyCompleted: false,
    onlyDrafts: false,
    projectsOnly: false,
    boulders: true,
    routes: false,
    zoneBox: null,
    zoneMode: 'allHolds' as const,
    page: 0,
    pageSize: 20,
  };

  it('returns false when no user-specific filters are set', () => {
    expect(hasUserSpecificFilters(baseParams)).toBe(false);
  });

  it.each(['hideAttempted', 'hideCompleted', 'showOnlyAttempted', 'showOnlyCompleted', 'onlyDrafts'] as const)(
    'returns true when %s is true',
    (param) => {
      expect(hasUserSpecificFilters({ ...baseParams, [param]: true })).toBe(true);
    },
  );

  it('returns false when all user-specific filters are explicitly false', () => {
    expect(
      hasUserSpecificFilters({
        ...baseParams,
        hideAttempted: false,
        hideCompleted: false,
        showOnlyAttempted: false,
        showOnlyCompleted: false,
        onlyDrafts: false,
      }),
    ).toBe(false);
  });

  it('returns true when multiple user-specific filters are set', () => {
    expect(
      hasUserSpecificFilters({
        ...baseParams,
        hideAttempted: true,
        showOnlyCompleted: true,
      }),
    ).toBe(true);
  });
});

// --- Middleware integration tests ---

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('middleware matcher config', () => {
  it('pins the exact matcher entries', () => {
    // Vercel bills/logs per invocation — this literal is the whole point of
    // the fix, so a drift here (an accidental widening back to /api/:path*,
    // or a narrowing that drops an auth path) must fail the suite outright.
    expect(config.matcher).toEqual([
      '/api/v1/:path*',
      '/api/auth/:path*',
      '/api/internal/ws-auth',
      '/((?!api/|_next/static|_next/image|favicon.ico|monitoring|\\.well-known/|.*\\..*).*)',
    ]);
  });

  // Coverage helper mirroring how Next compiles each matcher shape: entries
  // 1-2 are `:path*` prefixes, entry 3 is an exact path, entry 4 is the full
  // page-routes regex tested anchored end-to-end.
  function isMatchedByConfig(pathname: string): boolean {
    const [v1Prefix, authPrefix, wsAuthExact, pageRoutesRegex] = config.matcher;
    if (pathname.startsWith(v1Prefix.replace(':path*', ''))) return true;
    if (pathname.startsWith(authPrefix.replace(':path*', ''))) return true;
    if (pathname === wsAuthExact) return true;
    return new RegExp(`^${pageRoutesRegex}$`).test(pathname);
  }

  it.each([
    '/api/internal/board-render',
    '/api/og/setter',
    '/api/internal/prewarm-heatmap/kilter',
    '/api/internal/revalidate-climb',
  ])('does not run middleware on %s (no CORS/locale/board-validation work needed there)', (pathname) => {
    expect(isMatchedByConfig(pathname)).toBe(false);
  });

  it.each([
    '/api/internal/ws-auth',
    '/api/auth/session',
    '/api/auth/callback/credentials',
    '/api/v1/kilter/grades',
    '/',
    '/es/kilter/original/12x12-square/screw_bolt/40/view/x',
    '/b/some-board/40/list',
  ])('still runs middleware on %s', (pathname) => {
    expect(isMatchedByConfig(pathname)).toBe(true);
  });

  it.each(['/_next/static/chunk.js', '/logo.png'])('does not run middleware on static asset %s', (pathname) => {
    expect(isMatchedByConfig(pathname)).toBe(false);
  });
});

describe('middleware /api/v1 board validation', () => {
  it('404s an unsupported board name', () => {
    const response = middleware(makeRequest('/api/v1/fakeboard/grades'));
    expect(response.status).toBe(404);
  });

  it('passes through a supported board', () => {
    const response = middleware(makeRequest('/api/v1/kilter/grades'));
    expect(response.status).toBe(200);
  });

  it.each(['angles', 'grades'])('passes through the %s special segment without board validation', (segment) => {
    const response = middleware(makeRequest(`/api/v1/${segment}`));
    expect(response.status).toBe(200);
  });
});

describe('middleware session redirect', () => {
  it('redirects when ?session= is present on a list page', () => {
    const response = middleware(makeRequest('/b/kilter-original-12x12/40/list?session=abc-123'));
    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBe('http://localhost:3000/b/kilter-original-12x12/40/list');
  });

  it('redirects when ?session= is present on any page', () => {
    const response = middleware(makeRequest('/some/page?session=xyz'));
    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBe('http://localhost:3000/some/page');
  });

  it('sets the climb session cookie on redirect', () => {
    const response = middleware(makeRequest('/b/kilter-original-12x12/40/list?session=abc-123'));
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain(CLIMB_SESSION_COOKIE);
    expect(setCookie).toContain('abc-123');
  });

  it('preserves other query params when stripping session', () => {
    const response = middleware(
      makeRequest('/b/kilter-original-12x12/40/list?minGrade=10&session=abc-123&sortBy=difficulty'),
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('minGrade')).toBe('10');
    expect(location.searchParams.get('sortBy')).toBe('difficulty');
    expect(location.searchParams.has('session')).toBe(false);
  });

  it('does not redirect when no ?session= is present', () => {
    const response = middleware(makeRequest('/b/kilter-original-12x12/40/list'));
    expect(response.status).not.toBe(307);
  });

  it('session redirect takes priority over CDN cache headers', () => {
    const response = middleware(makeRequest('/kilter/original/12x12-square/screw_bolt/40/list?session=abc-123'));
    expect(response.status).toBe(307);
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
  });
});

describe('middleware localized /embed 308', () => {
  it.each(['es', 'fr', 'de'])('308s /%s/embed/board/... to the un-prefixed path', (locale) => {
    const response = middleware(makeRequest(`/${locale}/embed/board/abc-123`));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('http://localhost:3000/embed/board/abc-123');
  });

  it.each(['es', 'fr', 'de'])('308s the case-drifted /%s/embed form too', (locale) => {
    const response = middleware(makeRequest(`/${locale.toUpperCase()}/EMBED/board/abc-123`));
    expect(response.status).toBe(308);
  });

  it('serves un-prefixed /embed/** without redirect, cookie or locale rewrite', () => {
    const response = middleware(makeRequest('/embed/board/abc-123?session=party-123'));
    expect(response.status).toBe(200);
    expect(response.headers.has('location')).toBe(false);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.get(`x-middleware-request-${LOCALE_HEADER}`)).toBe(DEFAULT_LOCALE);
  });
});

describe('middleware Expo web carve-out', () => {
  const originalNextAuthUrl = process.env.NEXTAUTH_URL;

  beforeEach(() => {
    process.env.BOARDSESH_WEB = '1';
    delete process.env.NEXTAUTH_URL;
  });

  afterEach(() => {
    if (originalExpoWebFlag === undefined) delete process.env.BOARDSESH_WEB;
    else process.env.BOARDSESH_WEB = originalExpoWebFlag;
    if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalNextAuthUrl;
  });

  it.each(['/app', '/app/(tabs)/climbs', '/APP/play'])('keeps %s on the unprefixed path', (path) => {
    const request = makeRequest(path);
    request.cookies.set(LOCALE_COOKIE, 'es');

    const response = middleware(request);

    expect(response.status).toBe(200);
    expect(response.headers.has('location')).toBe(false);
    expect(response.headers.has('x-middleware-rewrite')).toBe(false);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    // Insecure (local http) context: no HSTS.
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('sets HSTS on /app in a secure (HTTPS) context', () => {
    process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';

    const response = middleware(makeRequest('/app'));

    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('leaves /app to normal routing when Expo web is not enabled', () => {
    delete process.env.BOARDSESH_WEB;

    const response = middleware(makeRequest('/app'));

    // No Expo carve-out: the utility headers are not applied.
    expect(response.headers.has('x-robots-tag')).toBe(false);
  });

  it('does not consume legacy session query parameters under /app', () => {
    const response = middleware(makeRequest('/app/play?session=party-123'));

    expect(response.status).toBe(200);
    expect(response.headers.has('location')).toBe(false);
    expect(response.headers.has('set-cookie')).toBe(false);
  });
});

describe('middleware Expo web support namespace carve-out', () => {
  beforeEach(() => {
    process.env.BOARDSESH_WEB = '1';
    process.env.BOARDSESH_EXPO_WEB_ORIGIN = 'http://localhost:8082';
  });

  afterEach(() => {
    if (originalExpoWebFlag === undefined) delete process.env.BOARDSESH_WEB;
    else process.env.BOARDSESH_WEB = originalExpoWebFlag;

    if (originalExpoWebOrigin === undefined) delete process.env.BOARDSESH_EXPO_WEB_ORIGIN;
    else process.env.BOARDSESH_EXPO_WEB_ORIGIN = originalExpoWebOrigin;
  });

  it.each([
    ['/assets', 'es'],
    ['/assets?unstable_path=node_modules%2Fvector-icons&session=party-123', 'fr'],
    ['/assets/vector-icons?session=party-123', 'es'],
    ['/packages/mobile', 'fr'],
    ['/packages/mobile?platform=web&session=party-123', 'es'],
    ['/packages/mobile/node_modules/expo-router/entry?platform=web&session=party-123', 'fr'],
  ])('passes %s through without locale or session handling', (path, locale) => {
    const request = makeRequest(path);
    request.cookies.set(LOCALE_COOKIE, locale);

    const response = middleware(request);

    expect(response.status).toBe(200);
    expect(response.headers.has('location')).toBe(false);
    expect(response.headers.has('x-middleware-rewrite')).toBe(false);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.get(`x-middleware-request-${LOCALE_HEADER}`)).toBe(DEFAULT_LOCALE);
  });

  it.each([
    ['missing web flag', undefined, 'http://localhost:8082'],
    ['missing proxy origin', '1', undefined],
  ])('preserves locale handling with %s', (_scenario, webFlag, proxyOrigin) => {
    if (webFlag === undefined) delete process.env.BOARDSESH_WEB;
    else process.env.BOARDSESH_WEB = webFlag;

    if (proxyOrigin === undefined) delete process.env.BOARDSESH_EXPO_WEB_ORIGIN;
    else process.env.BOARDSESH_EXPO_WEB_ORIGIN = proxyOrigin;

    const request = makeRequest('/assets');
    request.cookies.set(LOCALE_COOKIE, 'es');

    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/es/assets');
  });

  it('does not weaken session handling on unrelated routes', () => {
    const response = middleware(makeRequest('/some/page?session=party-123'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/some/page');
    expect(response.headers.get('set-cookie')).toContain(CLIMB_SESSION_COOKIE);
  });
});

describe('middleware cache headers on list pages', () => {
  it('does not rewrite cacheable list pages', () => {
    const response = middleware(makeRequest(LEGACY_LIST));
    expect(response.headers.has('x-middleware-rewrite')).toBe(false);
  });

  it('sets CDN cache headers on cacheable list pages', () => {
    const response = middleware(makeRequest(LEGACY_LIST));
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe(
      `s-maxage=${TTL_24H}, stale-while-revalidate=${TTL_24H * 7}`,
    );
    expect(response.headers.get('CDN-Cache-Control')).toBe(
      `s-maxage=${TTL_24H}, stale-while-revalidate=${TTL_24H * 7}`,
    );
  });

  it('still sets cache headers when vercel-flag-overrides cookie is present', () => {
    const req = makeRequest(LEGACY_LIST);
    req.cookies.set('vercel-flag-overrides', 'some-override');
    const response = middleware(req);
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe(
      `s-maxage=${TTL_24H}, stale-while-revalidate=${TTL_24H * 7}`,
    );
  });

  it('does not set cache headers for non-list pages', () => {
    const response = middleware(makeRequest('/some/page'));
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
    expect(response.headers.has('CDN-Cache-Control')).toBe(false);
  });
});

describe('middleware cache headers on climb view pages', () => {
  const expectedClimbViewCacheHeader = `s-maxage=${TTL_24H}, stale-while-revalidate=${TTL_24H * 7}`;

  it.each([
    ['slug view', SLUG_VIEW],
    ['named-segment view', NAMED_VIEW],
    // The numeric view URL 308-redirects to its slug form; caching the request
    // lets the CDN serve that deterministic redirect without re-rendering.
    ['numeric view (redirect)', NUMERIC_VIEW],
  ])('sets 24h CDN cache headers on the %s URL', (_shape, url) => {
    const response = middleware(makeRequest(url));
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe(expectedClimbViewCacheHeader);
    expect(response.headers.get('CDN-Cache-Control')).toBe(expectedClimbViewCacheHeader);
  });

  it('does not cache a play page', () => {
    const response = middleware(makeRequest('/kilter/1/10/1,20/40/play/some-uuid'));
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
  });

  it('does not cache a view page carrying a user-specific filter', () => {
    const response = middleware(makeRequest(`${SLUG_VIEW}?hideAttempted=true`));
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
  });

  it.each(['es', 'fr', 'de'])(
    'cache-keys %s and en separately (header follows the original locale-prefixed URL)',
    (locale) => {
      const enResponse = middleware(makeRequest(SLUG_VIEW));
      const localizedResponse = middleware(makeRequest(`/${locale}${SLUG_VIEW}`));
      // Both are cacheable, but the CDN keys them by their distinct request URLs.
      expect(enResponse.headers.get('Vercel-CDN-Cache-Control')).toBe(expectedClimbViewCacheHeader);
      expect(localizedResponse.headers.get('Vercel-CDN-Cache-Control')).toBe(expectedClimbViewCacheHeader);
    },
  );

  it.each(['es', 'fr', 'de'])(
    'never caches the sticky-locale redirect to %s — a cookie-varying 307 must not enter the CDN',
    (locale) => {
      const request = makeRequest(SLUG_VIEW);
      request.cookies.set(LOCALE_COOKIE, locale);
      const response = middleware(request);
      // A visitor with a non-default locale cookie on the unprefixed URL gets a
      // 307 to /{locale}/…; if that response ever carried the CDN header, the
      // redirect would be cached under the plain URL and served to every visitor.
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain(`/${locale}`);
      expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
      expect(response.headers.has('CDN-Cache-Control')).toBe(false);
    },
  );
});

// A crawler that persists cookies (observed in production logs) acquires
// boardsesh-locale by crawling one /de|/es|/fr page, then bounces every
// subsequent unprefixed URL through a locale twin — ~15k of these 307s/day,
// plus the render MISS on the twin it lands on. Crawlers must never be sent
// through the sticky-locale redirect, and must never acquire the cookie.
//
// #4667 gated this on Next's `userAgent(request).isBot`, whose list names no
// scraper newer than ~2023. Probed against production on 2026-08-24, Googlebot
// correctly got a 200 while AhrefsBot, SemrushBot, DataForSeoBot and MJ12bot
// were all still taking the 307 to the /es twin. The cases below cover both
// halves of the repo-owned list in `app/lib/is-crawler.ts`.
describe('middleware bot-gates the sticky locale redirect and cookie', () => {
  const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const CRAWLER_UAS: [string, string][] = [
    ['Googlebot (named by Next)', GOOGLEBOT_UA],
    ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
    ['SemrushBot', 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)'],
    ['DataForSeoBot', 'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)'],
    ['MJ12bot', 'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)'],
    ['DotBot', 'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)'],
    ['archive.org_bot', 'Mozilla/5.0 (compatible; archive.org_bot +http://www.archive.org/details/archive.org_bot)'],
  ];

  function makeRequestWithUserAgent(url: string, ua: string): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'), {
      headers: { 'user-agent': ua },
    });
  }

  it.each(CRAWLER_UAS)(
    'does not 307 %s carrying a stale non-default locale cookie — it gets a default-locale 200 for the requested URL',
    (_label, crawlerUa) => {
      const request = makeRequestWithUserAgent('/some/page', crawlerUa);
      request.cookies.set(LOCALE_COOKIE, 'de');

      const response = middleware(request);

      expect(response.status).not.toBe(307);
      expect(response.headers.has('location')).toBe(false);
      expect(response.headers.get(`x-middleware-request-${LOCALE_HEADER}`)).toBe(DEFAULT_LOCALE);
    },
  );

  it('still 307s a human (non-bot UA) carrying the same stale locale cookie', () => {
    const request = makeRequestWithUserAgent('/some/page', CHROME_UA);
    request.cookies.set(LOCALE_COOKIE, 'de');

    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/de/some/page');
  });

  it.each(CRAWLER_UAS)(
    'never sets the boardsesh-locale cookie for %s visiting a locale-prefixed URL',
    (_label, crawlerUa) => {
      const response = middleware(makeRequestWithUserAgent('/es/some/page', crawlerUa));

      expect(response.headers.has('set-cookie')).toBe(false);
    },
  );

  it('sets the boardsesh-locale cookie for a human (non-bot UA) visiting a locale-prefixed URL', () => {
    const response = middleware(makeRequestWithUserAgent('/es/some/page', CHROME_UA));

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain(LOCALE_COOKIE);
    expect(setCookie).toContain('es');
  });

  // The /api/v1 and /api/auth matcher entries reach the classifier call site,
  // so the isApi short-circuit must leave their behaviour untouched.
  it('leaves an /api/v1 request unchanged whether or not it carries a crawler UA', () => {
    const crawlerResponse = middleware(
      makeRequestWithUserAgent('/api/v1/kilter/climbs', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)'),
    );
    const humanResponse = middleware(makeRequestWithUserAgent('/api/v1/kilter/climbs', CHROME_UA));

    expect(crawlerResponse.status).toBe(humanResponse.status);
    expect(crawlerResponse.headers.has('set-cookie')).toBe(false);
    expect(humanResponse.headers.has('set-cookie')).toBe(false);
    expect(crawlerResponse.headers.get(`x-middleware-request-${LOCALE_HEADER}`)).toBe(DEFAULT_LOCALE);
    expect(humanResponse.headers.get(`x-middleware-request-${LOCALE_HEADER}`)).toBe(DEFAULT_LOCALE);
  });
});

describe('middleware forwards the routing pathname header', () => {
  const requestHeader = `x-middleware-request-${PATHNAME_HEADER}`;

  it('forwards the locale-stripped pathname on a board route', () => {
    const response = middleware(makeRequest(NUMERIC_VIEW));
    expect(response.headers.get(requestHeader)).toBe(NUMERIC_VIEW);
  });

  it.each(['es', 'fr', 'de'])('strips the %s locale prefix from the forwarded pathname', (locale) => {
    const response = middleware(makeRequest(`/${locale}${SLUG_VIEW}`));
    expect(response.headers.get(requestHeader)).toBe(SLUG_VIEW);
  });

  it('overwrites any client-supplied pathname header (no spoofing)', () => {
    const request = makeRequest(SLUG_VIEW);
    request.headers.set(PATHNAME_HEADER, '/list');
    const response = middleware(request);
    expect(response.headers.get(requestHeader)).toBe(SLUG_VIEW);
  });
});

// --- Cross-subdomain auth CORS for the standalone Expo-web app ---

function makeCorsRequest(url: string, options: { origin?: string; method?: string } = {}): NextRequest {
  const headers = new Headers();
  if (options.origin) headers.set('origin', options.origin);
  return new NextRequest(new URL(url, 'http://localhost:3000'), { method: options.method ?? 'GET', headers });
}

describe('middleware cross-subdomain auth CORS', () => {
  // NEXT_PUBLIC_APP_URL is unset in tests, so APP_URL resolves to its prod default.
  const APP_ORIGIN = 'https://app.boardsesh.com';

  it('echoes the app origin with credentials on the session read', () => {
    const response = middleware(makeCorsRequest('/api/auth/session', { origin: APP_ORIGIN }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Vary')).toContain('Origin');
  });

  it('echoes the app origin on the ws-auth bridge', () => {
    const response = middleware(makeCorsRequest('/api/internal/ws-auth', { origin: APP_ORIGIN }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('answers the OPTIONS preflight with 204 and the credentialed CORS headers', () => {
    const response = middleware(
      makeCorsRequest('/api/auth/callback/credentials', { origin: APP_ORIGIN, method: 'OPTIONS' }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('content-type');
    // Cached so the sequential credentialed sign-in calls don't each re-preflight.
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('allows a numbered app preview origin (https://{N}.app.boardsesh.com)', () => {
    const preview = 'https://3.app.boardsesh.com';
    const response = middleware(makeCorsRequest('/api/auth/csrf', { origin: preview }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(preview);
  });

  it.each(['/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password'])(
    'echoes the app origin on the credentials flow endpoint %s',
    (path) => {
      const response = middleware(makeCorsRequest(path, { origin: APP_ORIGIN }));

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    },
  );

  it('rejects a look-alike suffix origin (no ACAO)', () => {
    const response = middleware(makeCorsRequest('/api/auth/session', { origin: 'https://app.boardsesh.com.evil.com' }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('rejects a look-alike prefix subdomain (no ACAO)', () => {
    const response = middleware(makeCorsRequest('/api/auth/session', { origin: 'https://evil-app.boardsesh.com' }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rejects an unrelated origin (no ACAO)', () => {
    const response = middleware(makeCorsRequest('/api/auth/session', { origin: 'https://evil.com' }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows provider discovery from the standalone app origin', () => {
    const response = middleware(makeCorsRequest('/api/auth/providers-config', { origin: APP_ORIGIN }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('allows provider discovery from a numbered preview origin', () => {
    const preview = 'https://14.app.boardsesh.com';
    const response = middleware(makeCorsRequest('/api/auth/providers-config', { origin: preview }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(preview);
  });

  it('rejects provider discovery from a look-alike app origin', () => {
    const response = middleware(
      makeCorsRequest('/api/auth/providers-config', { origin: 'https://app.boardsesh.com.evil.com' }),
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds no CORS to a same-origin request that carries no Origin header', () => {
    const response = middleware(makeCorsRequest('/api/auth/session'));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
