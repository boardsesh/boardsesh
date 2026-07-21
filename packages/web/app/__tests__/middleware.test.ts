import { afterEach, beforeEach, describe, it, expect } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { CLIMB_SESSION_COOKIE } from '@/app/lib/climb-session-cookie';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_HEADER } from '@/app/lib/i18n/config';
import { EXPO_WEB_CLASSIC_COOKIE, EXPO_WEB_ENABLED_COOKIE } from '@/app/lib/expo-web-rollout';
import { PATHNAME_HEADER } from '@/app/lib/request-pathname-header';

const { getClimbViewPageCacheTTL, getListPageCacheTTL, hasUserSpecificFilters } =
  await import('@/app/lib/list-page-cache');
const { middleware } = await import('@/middleware');

function sp(params: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams(params);
}

const TTL_24H = 86400;
const TTL_1H = 3600;
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
    ])('caches for %s=%s', (param, value) => {
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
      expect(getClimbViewPageCacheTTL(SLUG_VIEW, sp())).toBe(TTL_1H);
    });

    it('matches the named-segment (legacy) view format', () => {
      expect(getClimbViewPageCacheTTL(NAMED_VIEW, sp())).toBe(TTL_1H);
    });

    it('matches the numeric view format (so its redirect is cacheable)', () => {
      expect(getClimbViewPageCacheTTL(NUMERIC_VIEW, sp())).toBe(TTL_1H);
    });

    it('matches the tension board view', () => {
      expect(getClimbViewPageCacheTTL('/tension/original/12x12/screw_bolt/30/view/some-climb-uuid', sp())).toBe(TTL_1H);
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
      expect(getClimbViewPageCacheTTL(SLUG_VIEW, sp({ utm_source: 'twitter' }))).toBe(TTL_1H);
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
  const expected1h = `s-maxage=${TTL_1H}, stale-while-revalidate=${TTL_1H * 7}`;

  it.each([
    ['slug view', SLUG_VIEW],
    ['named-segment view', NAMED_VIEW],
    // The numeric view URL 308-redirects to its slug form; caching the request
    // lets the CDN serve that deterministic redirect without re-rendering.
    ['numeric view (redirect)', NUMERIC_VIEW],
  ])('sets 1h CDN cache headers on the %s URL', (_shape, url) => {
    const response = middleware(makeRequest(url));
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe(expected1h);
    expect(response.headers.get('CDN-Cache-Control')).toBe(expected1h);
  });

  it('does not cache a play page', () => {
    const response = middleware(makeRequest('/kilter/1/10/1,20/40/play/some-uuid'));
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
  });

  it('does not cache a view page carrying a user-specific filter', () => {
    const response = middleware(makeRequest(`${SLUG_VIEW}?hideAttempted=true`));
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
  });

  it('cache-keys es and en separately (header follows the original locale-prefixed URL)', () => {
    const enResponse = middleware(makeRequest(SLUG_VIEW));
    const esResponse = middleware(makeRequest(`/es${SLUG_VIEW}`));
    // Both are cacheable, but the CDN keys them by their distinct request URLs.
    expect(enResponse.headers.get('Vercel-CDN-Cache-Control')).toBe(expected1h);
    expect(esResponse.headers.get('Vercel-CDN-Cache-Control')).toBe(expected1h);
  });

  it('never caches the sticky-locale redirect — a cookie-varying 307 must not enter the CDN', () => {
    const request = makeRequest(SLUG_VIEW);
    request.cookies.set(LOCALE_COOKIE, 'es');
    const response = middleware(request);
    // A visitor with a non-default locale cookie on the unprefixed URL gets a
    // 307 to /es/…; if that response ever carried the CDN header, the redirect
    // would be cached under the plain URL and served to every visitor.
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/es');
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
    expect(response.headers.has('CDN-Cache-Control')).toBe(false);
  });
});

describe('middleware forwards the routing pathname header', () => {
  const requestHeader = `x-middleware-request-${PATHNAME_HEADER}`;

  it('forwards the locale-stripped pathname on a board route', () => {
    const response = middleware(makeRequest(NUMERIC_VIEW));
    expect(response.headers.get(requestHeader)).toBe(NUMERIC_VIEW);
  });

  it('strips the locale prefix from the forwarded pathname', () => {
    const response = middleware(makeRequest(`/es${SLUG_VIEW}`));
    expect(response.headers.get(requestHeader)).toBe(SLUG_VIEW);
  });

  it('overwrites any client-supplied pathname header (no spoofing)', () => {
    const request = makeRequest(SLUG_VIEW);
    request.headers.set(PATHNAME_HEADER, '/list');
    const response = middleware(request);
    expect(response.headers.get(requestHeader)).toBe(SLUG_VIEW);
  });
});

describe('middleware Expo web rollout redirect', () => {
  const AUTH_COOKIE = 'next-auth.session-token';

  beforeEach(() => {
    process.env.BOARDSESH_WEB = '1';
  });

  afterEach(() => {
    if (originalExpoWebFlag === undefined) delete process.env.BOARDSESH_WEB;
    else process.env.BOARDSESH_WEB = originalExpoWebFlag;
  });

  function redirectedToAppPath(response: ReturnType<typeof middleware>): string | null {
    const location = response.headers.get('location');
    if (response.status !== 307 || location === null) return null;
    const { pathname } = new URL(location);
    return pathname.startsWith('/app') ? location : null;
  }

  function loggedInFlaggedRequest(url: string): NextRequest {
    const request = makeRequest(url);
    request.cookies.set(AUTH_COOKIE, 'token-123');
    request.cookies.set(EXPO_WEB_ENABLED_COOKIE, '1');
    return request;
  }

  it('redirects a logged-in flagged visitor from a legacy board-list URL to /app/climbs with no query', () => {
    const response = middleware(loggedInFlaggedRequest(LEGACY_LIST));
    const location = redirectedToAppPath(response);
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe('/app/climbs');
    // The Climbs tab reads no board-context search params — don't imply otherwise.
    expect(url.search).toBe('');
  });

  it('redirects a logged-in flagged visitor from a slug board-list URL to /app/climbs', () => {
    const response = middleware(loggedInFlaggedRequest(SLUG_LIST));
    const location = redirectedToAppPath(response);
    expect(location).not.toBeNull();
    expect(new URL(location!).pathname).toBe('/app/climbs');
  });

  it('redirects a numeric climb-view URL to the /app climb deep-link with the ClimbDetail param contract', () => {
    const response = middleware(loggedInFlaggedRequest('/kilter/1/10/1,20/40/view/climb-uuid'));
    const location = redirectedToAppPath(response);
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe('/app/climbs/climb-uuid');
    expect(url.searchParams.get('boardName')).toBe('kilter');
    expect(url.searchParams.get('layoutId')).toBe('1');
    expect(url.searchParams.get('sizeId')).toBe('10');
    expect(url.searchParams.get('setIds')).toBe('1,20');
    expect(url.searchParams.get('angle')).toBe('40');
  });

  it('keeps a slug climb-view URL classic (the SPA has no boardSlug resolution)', () => {
    const response = middleware(loggedInFlaggedRequest('/b/kilter-original-12x12/40/view/climb-uuid'));
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('keeps a named-segment climb-view URL classic (ClimbDetail would get layoutId=NaN)', () => {
    const response = middleware(loggedInFlaggedRequest('/kilter/original/12x12-square/screw_bolt/40/view/climb-uuid'));
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('keeps a list URL with filter query params classic (the SPA cannot consume them)', () => {
    const response = middleware(loggedInFlaggedRequest(`${LEGACY_LIST}?minGrade=10&sortBy=difficulty`));
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('redirects when the session rides the __Secure-next-auth.session-token cookie (https contexts)', () => {
    const request = makeRequest('/kilter/1/10/1,20/40/view/climb-uuid');
    request.cookies.set('__Secure-next-auth.session-token', 'token-123');
    request.cookies.set(EXPO_WEB_ENABLED_COOKIE, '1');
    const response = middleware(request);
    const location = redirectedToAppPath(response);
    expect(location).not.toBeNull();
    expect(new URL(location!).pathname).toBe('/app/climbs/climb-uuid');
  });

  it('does not redirect when the flag cookie is absent (flag off / unresolved)', () => {
    const request = makeRequest(LEGACY_LIST);
    request.cookies.set(AUTH_COOKIE, 'token-123');
    const response = middleware(request);
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('does not redirect a logged-out visitor even with the flag cookie (public page stays canonical)', () => {
    const request = makeRequest(LEGACY_LIST);
    request.cookies.set(EXPO_WEB_ENABLED_COOKIE, '1');
    const response = middleware(request);
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('does not redirect on a public/SEO route (playlists) even when flagged + logged in', () => {
    const response = middleware(loggedInFlaggedRequest('/playlists'));
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('does not redirect when BOARDSESH_WEB is not set (master env gate off)', () => {
    delete process.env.BOARDSESH_WEB;
    const response = middleware(loggedInFlaggedRequest(LEGACY_LIST));
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('?classic=1 sets the bs_classic cookie and lands on the classic URL, not /app', () => {
    const response = middleware(loggedInFlaggedRequest(`${SLUG_LIST}?classic=1`));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe(SLUG_LIST);
    expect(location.pathname.startsWith('/app')).toBe(false);
    expect(location.searchParams.has('classic')).toBe(false);
    expect(response.headers.get('set-cookie')).toContain(EXPO_WEB_CLASSIC_COOKIE);
  });

  it('honours the bs_classic opt-out cookie: no /app redirect while flagged + logged in', () => {
    const request = loggedInFlaggedRequest(LEGACY_LIST);
    request.cookies.set(EXPO_WEB_CLASSIC_COOKIE, '1');
    const response = middleware(request);
    expect(redirectedToAppPath(response)).toBeNull();
  });

  it('leaves a ?classic=1 API request alone (no 307, no cookie): the param belongs to the endpoint', () => {
    const response = middleware(loggedInFlaggedRequest('/api/v1/kilter/proxy/login?classic=1'));
    expect(response.status).not.toBe(307);
    expect(response.headers.get('set-cookie') ?? '').not.toContain(EXPO_WEB_CLASSIC_COOKIE);
  });

  it('marks the bs_classic cookie Secure in an https context (mirrors the auth session cookie)', () => {
    const originalNextAuthUrl = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
    try {
      const response = middleware(loggedInFlaggedRequest(`${SLUG_LIST}?classic=1`));
      expect(response.status).toBe(307);
      const setCookie = response.headers.get('set-cookie')!;
      expect(setCookie).toContain(EXPO_WEB_CLASSIC_COOKIE);
      expect(setCookie).toMatch(/secure/i);
    } finally {
      if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = originalNextAuthUrl;
    }
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

  it('does not add CORS to an auth path outside the allow-list, even from the app origin', () => {
    // /api/auth/providers-config isn't one of the endpoints the app calls
    // cross-origin, so it must not grow an ambient-credential CORS surface.
    const response = middleware(makeCorsRequest('/api/auth/providers-config', { origin: APP_ORIGIN }));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds no CORS to a same-origin request that carries no Origin header', () => {
    const response = middleware(makeCorsRequest('/api/auth/session'));

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
