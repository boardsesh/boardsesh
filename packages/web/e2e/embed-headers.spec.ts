import { test, expect, type APIResponse } from '@playwright/test';

// These are raw APIRequestContext gets against a server that is concurrently
// SSR-ing front-door pages for the other worker's browser tests. On a 2-core
// CI runner that contention can hold a response past the default 15s (the
// header assertions themselves are latency-independent), and which files share
// a shard reshuffles every time a spec is added or removed — so give every
// request the headroom explicitly instead of inheriting the default.
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Security headers for the /embed/** iframe widgets (board view + gym
 * leaderboard) — the ONLY routes Boardsesh serves without a frame-denying
 * X-Frame-Options.
 *
 * Contract under test (next.config.mjs headers() + middleware.ts carve-out):
 *  - /embed/** responses carry `Content-Security-Policy: frame-ancestors *`,
 *    NO X-Frame-Options, and NO Set-Cookie (embeds are cookieless: the
 *    middleware bypasses locale detection, so the sticky-locale cookie can
 *    never be written on an embed response).
 *  - Every other route (including 404s) keeps X-Frame-Options: SAMEORIGIN.
 *  - Locale-prefixed embed paths 308 to the un-prefixed path, because the
 *    header matcher sees the ORIGINAL request path — /es/embed/** served
 *    directly would dodge the embed rule and arrive frame-denying.
 *
 * The assertions run against nonexistent uuids on purpose: next.config
 * `headers()` match the request PATH, not the response status, so they
 * exercise the exact header split without needing seeded embed data. The
 * status differs by environment — 404 when the GraphQL backend is up (the
 * resolver answers "no such board/gym"), 200 when it's down (the embed's
 * transient-failure retry screen renders instead of bricking the iframe) —
 * so status assertions accept both; the HEADER contract is identical.
 */

const MISSING_BOARD_UUID = '00000000-0000-4000-8000-000000000000';
const MISSING_GYM_UUID = '00000000-0000-4000-8000-000000000001';

function headerValue(response: APIResponse, name: string): string | undefined {
  return response.headers()[name];
}

function setCookieValues(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
}

test.describe('embed security headers', () => {
  test('board embed is frameable, cookieless, and drops X-Frame-Options (even on 404)', async ({ request }) => {
    const response = await request.get(`/embed/board/${MISSING_BOARD_UUID}`, {
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });

    // Nonexistent board → 404 (backend up) or the retry screen (backend
    // down); the route headers apply either way.
    expect([200, 404]).toContain(response.status());
    expect(headerValue(response, 'content-security-policy')).toContain('frame-ancestors *');
    expect(headerValue(response, 'x-frame-options')).toBeUndefined();
    expect(setCookieValues(response)).toEqual([]);
    // The rest of the security-header set still rides along on embeds.
    expect(headerValue(response, 'x-content-type-options')).toBe('nosniff');
    expect(headerValue(response, 'referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  test('gym leaderboard embed carries the same frameable, cookieless headers', async ({ request }) => {
    const response = await request.get(`/embed/gym/${MISSING_GYM_UUID}/leaderboard?period=day`, {
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });

    expect([200, 404]).toContain(response.status());
    expect(headerValue(response, 'content-security-policy')).toContain('frame-ancestors *');
    expect(headerValue(response, 'x-frame-options')).toBeUndefined();
    expect(setCookieValues(response)).toEqual([]);
  });

  test('non-embed routes keep X-Frame-Options: SAMEORIGIN', async ({ request }) => {
    const homeResponse = await request.get('/', { maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
    expect(homeResponse.status()).toBe(200);
    expect(headerValue(homeResponse, 'x-frame-options')).toBe('SAMEORIGIN');

    // A kiosk TV page (here a nonexistent one → 404) is NOT frameable either —
    // only /embed/** opted out of the frame-denying default.
    const kioskResponse = await request.get('/kiosk/whatever', { maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
    expect(headerValue(kioskResponse, 'x-frame-options')).toBe('SAMEORIGIN');
    expect(headerValue(kioskResponse, 'content-security-policy') ?? '').not.toContain('frame-ancestors *');
  });

  test('an embed-lookalike path outside /embed/ keeps the frame-denying default', async ({ request }) => {
    // Regex sanity for the `/((?!embed/).*)` exclusion: only the /embed/**
    // subtree opts out, not paths merely starting with the word "embed".
    const response = await request.get('/embedded', { maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
    expect(headerValue(response, 'x-frame-options')).toBe('SAMEORIGIN');
  });

  test('/embed exact (no child segment) keeps the frame-denying default, without the embed CSP', async ({
    request,
  }) => {
    // The exclusion regex `(?!embed/)` only skips paths with the trailing
    // slash, so bare /embed matches the SAMEORIGIN rule; the embed rule uses
    // `:path+` so it does NOT also match — one response must never carry the
    // contradictory XFO SAMEORIGIN + frame-ancestors * pair.
    const response = await request.get('/embed', { maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
    expect(headerValue(response, 'x-frame-options')).toBe('SAMEORIGIN');
    expect(headerValue(response, 'content-security-policy') ?? '').not.toContain('frame-ancestors');
    // The middleware still treats it as an embed path (no cookies).
    expect(setCookieValues(response)).toEqual([]);
  });

  test('case-drifted embed paths stay cookieless (header matchers are case-insensitive)', async ({ request }) => {
    // Next compiles header `source` patterns case-INsensitively, so
    // /EMBED/board/x gets the frameable embed headers. The middleware
    // carve-out must therefore be case-insensitive too — otherwise this
    // request would run the full pipeline and the ?session= branch would
    // Set-Cookie on a frameable response.
    const response = await request.get('/EMBED/board/x?session=abc', { maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
    expect(headerValue(response, 'content-security-policy')).toContain('frame-ancestors *');
    expect(headerValue(response, 'x-frame-options')).toBeUndefined();
    expect(setCookieValues(response)).toEqual([]);
  });

  test('locale-prefixed embed paths 308 to the un-prefixed embed path, cookieless', async ({ request }) => {
    const spanishResponse = await request.get('/es/embed/board/x', { maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
    expect(spanishResponse.status()).toBe(308);
    expect(new URL(spanishResponse.headers()['location'], 'http://localhost').pathname).toBe('/embed/board/x');
    expect(setCookieValues(spanishResponse)).toEqual([]);

    const frenchResponse = await request.get(`/fr/embed/gym/${MISSING_GYM_UUID}/leaderboard?period=day&board=abc`, {
      maxRedirects: 0,
    });
    expect(frenchResponse.status()).toBe(308);
    const frenchLocation = new URL(frenchResponse.headers()['location'], 'http://localhost');
    expect(frenchLocation.pathname).toBe(`/embed/gym/${MISSING_GYM_UUID}/leaderboard`);
    // The redirect preserves the widget's query string.
    expect(frenchLocation.search).toBe('?period=day&board=abc');
  });
});
