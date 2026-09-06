// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

/**
 * Sentinels stand in for the drizzle handles `@/app/lib/db/db` exports.
 * Asserting on identity (not just "was called") is what actually pins the
 * replica seam: `executeRows` accepts any drizzle instance, so a regression
 * back to `dbz` (primary) would still "work" and only this test would catch it.
 */
const setterRouteState = vi.hoisted(() => ({
  getSetterOgSummaryMock: vi.fn(),
  executeRowsMock: vi.fn(),
  dbzReadSentinel: { __sentinel: 'dbzRead' } as unknown,
  dbzSentinel: { __sentinel: 'dbz' } as unknown,
  recordedReads: [] as { label: string; ms: number | undefined }[],
  capturedElement: null as unknown,
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSetterOgSummary: setterRouteState.getSetterOgSummaryMock,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/app/lib/db/db', () => ({
  dbzRead: setterRouteState.dbzReadSentinel,
  dbz: setterRouteState.dbzSentinel,
  executeRows: setterRouteState.executeRowsMock,
}));

vi.mock('@/app/lib/db/read-deadline', () => ({
  withReadDeadline: async (label: string, pending: Promise<unknown>, ms?: number) => {
    setterRouteState.recordedReads.push({ label, ms });
    return pending;
  },
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
    setterRouteState.capturedElement = element;
    return new Response('mock-image', {
      status: 200,
      headers: new Headers(init?.headers),
    });
  }),
}));

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/og/setter');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

/**
 * Mirrors real drizzle-orm@0.45.2's `DrizzleQueryError`: `.name` stays the
 * inherited "Error" (the class never overrides it), the message embeds the
 * full SQL + params, and `.cause` is always the underlying driver error.
 */
function makeDrizzleQueryError(sql: string, params: string, causeMessage = 'CONNECT_TIMEOUT'): Error {
  const cause = Object.assign(new Error(causeMessage), { code: causeMessage });
  return Object.assign(new Error(`Failed query: ${sql}\nparams: ${params}`), { cause });
}

describe('api/og/setter route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setterRouteState.recordedReads.length = 0;
    setterRouteState.capturedElement = null;
  });

  it('reads the tick-aggregate query off the replica seam (dbzRead), not the primary', async () => {
    setterRouteState.getSetterOgSummaryMock.mockResolvedValue({
      displayName: 'Alex',
      avatarUrl: null,
    });
    setterRouteState.executeRowsMock.mockResolvedValue([]);

    const response = await GET(makeRequest({ username: 'alex' }));

    expect(response.status).toBe(200);
    expect(setterRouteState.executeRowsMock).toHaveBeenCalledTimes(1);
    const [dbArg] = setterRouteState.executeRowsMock.mock.calls[0];
    expect(dbArg).toBe(setterRouteState.dbzReadSentinel);
    expect(dbArg).not.toBe(setterRouteState.dbzSentinel);
  });

  it('bounds the whole DB phase (summary + grade aggregate) under a single og-setter read deadline', async () => {
    setterRouteState.getSetterOgSummaryMock.mockResolvedValue({
      displayName: 'Alex',
      avatarUrl: null,
    });
    setterRouteState.executeRowsMock.mockResolvedValue([]);

    await GET(makeRequest({ username: 'alex' }));

    expect(setterRouteState.recordedReads.map((read) => read.label)).toEqual(['og-setter']);
  });

  it('404s for a setter with no publicly visible climb, rather than drawing a card for them', async () => {
    // The OG half of the soft-404 the page now 404s on. `getSetterOgSummary`
    // returns null only when the setter has no listed, non-draft climb — the
    // identical rule — so the card and the HTML page cannot disagree about
    // whether a setter exists.
    setterRouteState.getSetterOgSummaryMock.mockResolvedValue(null);
    setterRouteState.executeRowsMock.mockResolvedValue([]);

    const response = await GET(makeRequest({ username: 'drafts-only' }));

    expect(response.status).toBe(404);
    // Paired oracle: a handler that 404s AFTER rendering would pass on the
    // status alone, and rendering is the expensive half.
    expect(setterRouteState.capturedElement).toBeNull();
  });

  it('redirects to the branded fallback card and logs a throttled compact message when the DB rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setterRouteState.getSetterOgSummaryMock.mockRejectedValue(
      makeDrizzleQueryError('SELECT * FROM boardsesh_ticks WHERE setter_username = $1', 'alex'),
    );
    setterRouteState.executeRowsMock.mockResolvedValue([]);

    const response = await GET(makeRequest({ username: 'alex' }));
    const body = await response.text();

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/opengraph-image');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60');
    expect(response.headers.get('CDN-Cache-Control')).toBe('public, s-maxage=60');
    expect(body).not.toContain('SELECT');

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [, loggedMessage] = consoleErrorSpy.mock.calls[0] as [string, string];
    expect(loggedMessage).not.toContain('SELECT');
    expect(loggedMessage).toBe('Error: CONNECT_TIMEOUT');

    consoleErrorSpy.mockRestore();
  });
});
