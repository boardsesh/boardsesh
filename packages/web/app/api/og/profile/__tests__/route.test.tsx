// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

/**
 * `sqlTagMock` stands in for the tagged-template function `getReadPool()`
 * returns. Tests control exactly when it "resolves" — the mechanism the
 * first test below depends on to catch a specific regression: the route used
 * to do `rowsFromResult(await sql\`...\`)` *inside* the `Promise.all` array
 * literal, which resolves the query before `Promise.all`/`withReadDeadline`
 * ever run, silently leaving it unbounded despite the deadline wrap.
 */
const profileRouteState = vi.hoisted(() => ({
  getProfileOgSummaryMock: vi.fn(),
  sqlTagMock: vi.fn(),
  recordedReads: [] as { label: string; ms: number | undefined }[],
  capturedElement: null as unknown,
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getProfileOgSummary: profileRouteState.getProfileOgSummaryMock,
}));

vi.mock('@/app/lib/db/db', () => ({
  getReadPool: () => profileRouteState.sqlTagMock,
  rowsFromResult: (result: unknown) => (Array.isArray(result) ? result : []),
}));

vi.mock('@/app/lib/db/read-deadline', () => ({
  withReadDeadline: async (label: string, pending: Promise<unknown>, ms?: number) => {
    profileRouteState.recordedReads.push({ label, ms });
    return pending;
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: {
    neutral: {
      200: '#E0E0E0',
      300: '#D0D0D0',
      400: '#B0B0B0',
      500: '#909090',
      900: '#101010',
    },
  },
}));

vi.mock('@/app/lib/grade-colors', () => ({
  FONT_GRADE_COLORS: {
    v5: '#00AAFF',
  },
  getGradeColorWithOpacity: vi.fn(() => 'rgba(0, 170, 255, 0.5)'),
}));

vi.mock('@/app/lib/board-data', () => ({
  BOULDER_GRADES: [{ difficulty_id: 10, font_grade: 'V5' }],
}));

vi.mock('@/app/lib/seo/og', () => ({
  OG_IMAGE_WIDTH: 1200,
  OG_IMAGE_HEIGHT: 630,
  createOgImageHeaders: vi.fn(
    ({ contentType, version, serverTiming }: { contentType: string; version?: string; serverTiming?: string }) => ({
      'Content-Type': contentType,
      'Cache-Control': version
        ? 'public, max-age=31536000, s-maxage=31536000, immutable'
        : 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
      'CDN-Cache-Control': version
        ? 'public, s-maxage=31536000, immutable'
        : 'public, s-maxage=300, stale-while-revalidate=86400',
      'Vercel-CDN-Cache-Control': version
        ? 'public, s-maxage=31536000, immutable'
        : 'public, s-maxage=300, stale-while-revalidate=86400',
      'Server-Timing': serverTiming ?? '',
    }),
  ),
}));

vi.mock('@vercel/og', () => ({
  ImageResponse: vi.fn(function ImageResponse(element: unknown, init?: ResponseInit) {
    profileRouteState.capturedElement = element;
    return new Response('mock-image', {
      status: 200,
      headers: new Headers(init?.headers),
    });
  }),
}));

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/og/profile');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

describe('api/og/profile route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileRouteState.recordedReads.length = 0;
    profileRouteState.capturedElement = null;
  });

  it('passes the grade-count query into Promise.all unresolved, so both reads race under one og-profile deadline', async () => {
    let resolveGradeRows: (rows: unknown[]) => void = () => {};
    const gradeRowsPromise = new Promise<unknown[]>((resolve) => {
      resolveGradeRows = resolve;
    });
    profileRouteState.sqlTagMock.mockReturnValue(gradeRowsPromise);
    profileRouteState.getProfileOgSummaryMock.mockResolvedValue({
      displayName: 'Alex',
      avatarUrl: null,
      fallbackImageUrl: null,
    });

    const responsePromise = GET(makeRequest({ user_id: 'user-1' }));

    // Deliberately asserted before resolving the grade query and before ever
    // awaiting the route. Calling an async function runs its body
    // synchronously up to its first `await`, and our `withReadDeadline` mock
    // records its label before it awaits anything — so 'og-profile' is only
    // recorded here if the grade-count query was handed into `Promise.all`
    // still pending. A regression that reintroduces `await sql\`...\`` inside
    // the array literal would pause GET on that await *before* it ever
    // reaches `withReadDeadline`, leaving this empty since `sqlTagMock`'s
    // promise is deliberately never resolved above this line.
    expect(profileRouteState.recordedReads.map((read) => read.label)).toEqual(['og-profile']);

    resolveGradeRows([]);
    const response = await responsePromise;

    expect(response.status).toBe(200);
  });

  it('renders a 200 PNG with the profile summary and grade bars', async () => {
    profileRouteState.sqlTagMock.mockResolvedValue([{ difficulty: 10, cnt: 3 }]);
    profileRouteState.getProfileOgSummaryMock.mockResolvedValue({
      displayName: 'Alex',
      avatarUrl: null,
      fallbackImageUrl: null,
    });

    const response = await GET(makeRequest({ user_id: 'user-1' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
  });

  it('redirects to the branded fallback card on a DbReadTimeoutError-shaped rejection', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timeoutError = Object.assign(new Error('[db] front-door read "og-profile" exceeded 6000ms'), {
      name: 'DbReadTimeoutError',
      code: 'DB_READ_TIMEOUT',
    });
    profileRouteState.getProfileOgSummaryMock.mockRejectedValue(timeoutError);
    profileRouteState.sqlTagMock.mockResolvedValue([]);

    const response = await GET(makeRequest({ user_id: 'user-1' }));
    const body = await response.text();

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/opengraph-image');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60');
    expect(response.headers.get('CDN-Cache-Control')).toBe('public, s-maxage=60');
    expect(body).not.toContain('SELECT');

    consoleErrorSpy.mockRestore();
  });
});
