import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { CLIMB_SESSION_COOKIE } from '@/app/lib/climb-session-cookie';

const { getListPageCacheTTL, hasUserSpecificFilters } = await import('@/app/lib/list-page-cache');
const { middleware } = await import('@/middleware');

function sp(params: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams(params);
}

const TTL_24H = 86400;
const LEGACY_LIST = '/kilter/original/12x12-square/screw_bolt/40/list';
const SLUG_LIST = '/b/kilter-original-12x12/40/list';

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
    onlyClassics: false,
    onlyTallClimbs: false,
    settername: [] as string[],
    setternameSuggestion: '',
    holdsFilter: {},
    hideAttempted: false,
    hideCompleted: false,
    showOnlyAttempted: false,
    showOnlyCompleted: false,
    onlyDrafts: false,
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
  it('redirects when ?session= is present on a list page', async () => {
    const response = await middleware(makeRequest('/b/kilter-original-12x12/40/list?session=abc-123'));
    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBe('http://localhost:3000/b/kilter-original-12x12/40/list');
  });

  it('redirects when ?session= is present on any page', async () => {
    const response = await middleware(makeRequest('/some/page?session=xyz'));
    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBe('http://localhost:3000/some/page');
  });

  it('sets the climb session cookie on redirect', async () => {
    const response = await middleware(makeRequest('/b/kilter-original-12x12/40/list?session=abc-123'));
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain(CLIMB_SESSION_COOKIE);
    expect(setCookie).toContain('abc-123');
  });

  it('preserves other query params when stripping session', async () => {
    const response = await middleware(
      makeRequest('/b/kilter-original-12x12/40/list?minGrade=10&session=abc-123&sortBy=difficulty'),
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('minGrade')).toBe('10');
    expect(location.searchParams.get('sortBy')).toBe('difficulty');
    expect(location.searchParams.has('session')).toBe(false);
  });

  it('does not redirect when no ?session= is present', async () => {
    const response = await middleware(makeRequest('/b/kilter-original-12x12/40/list'));
    expect(response.status).not.toBe(307);
  });

  it('session redirect takes priority over CDN cache headers', async () => {
    const response = await middleware(makeRequest('/kilter/original/12x12-square/screw_bolt/40/list?session=abc-123'));
    expect(response.status).toBe(307);
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
  });
});

describe('middleware cache headers on list pages', () => {
  it('does not rewrite cacheable list pages', async () => {
    const response = await middleware(makeRequest(LEGACY_LIST));
    expect(response.headers.has('x-middleware-rewrite')).toBe(false);
  });

  it('sets CDN cache headers on cacheable list pages', async () => {
    const response = await middleware(makeRequest(LEGACY_LIST));
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe(
      `s-maxage=${TTL_24H}, stale-while-revalidate=${TTL_24H * 7}`,
    );
    expect(response.headers.get('CDN-Cache-Control')).toBe(
      `s-maxage=${TTL_24H}, stale-while-revalidate=${TTL_24H * 7}`,
    );
  });

  it('still sets cache headers when vercel-flag-overrides cookie is present', async () => {
    const req = makeRequest(LEGACY_LIST);
    req.cookies.set('vercel-flag-overrides', 'some-override');
    const response = await middleware(req);
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe(
      `s-maxage=${TTL_24H}, stale-while-revalidate=${TTL_24H * 7}`,
    );
  });

  it('does not set cache headers for non-list pages', async () => {
    const response = await middleware(makeRequest('/some/page'));
    expect(response.headers.has('Vercel-CDN-Cache-Control')).toBe(false);
    expect(response.headers.has('CDN-Cache-Control')).toBe(false);
  });
});
