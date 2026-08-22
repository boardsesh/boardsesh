import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { waitForBoardListReady } from './helpers/waits';

// This file used to be `aa-embed-headers.spec.ts`. The prefix was load-bearing:
// Playwright orders spec files alphabetically inside a shard, and these raw
// APIRequestContext requests hung for 60s+ when browser-driven specs had run
// against the same server first. #4463 root-caused that and removed it. The
// short version, so nobody re-derives it:
//
//  - Nothing here was a Playwright state leak. The `request` fixture builds a
//    fresh APIRequestContext per test, and the suite installs no service
//    worker, storageState, or route interception.
//  - The stall was never in the web server. The GraphQL backend's connection
//    pool was exhausted by concurrent copies of one uncached statement — the
//    home page's `popularBoardConfigs`, which the CI backend can never cache
//    because it runs with no REDIS_URL. Every spec that loaded `/` added
//    another copy. postgres.js's acquire queue is unbounded and untimed, so
//    every other backend read then waited forever, `/embed/**` renders
//    included. `{ __typename }` kept answering in milliseconds throughout,
//    which is why it looked like something subtler than saturation.
//  - Two fixes closed it: the backend now runs one copy of those cold reads at
//    a time, and the SSR fetches that wait on the backend carry
//    SSR_BACKEND_FETCH_TIMEOUT_MS, so a slow backend paints the retry screen —
//    a 200 these assertions already accept.
//
// The ordering dependency is pinned explicitly at the bottom of this file
// instead of through the filename, so it survives the next spec being added.

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

/**
 * The ordering pin, written down instead of encoded in the filename.
 *
 * `--shard=N/8` reshuffles which specs share a server every time a test is
 * added or removed, so the `aa-` prefix only ever protected one particular
 * arrangement — and hid the defect rather than testing it. This drives the
 * browser preamble explicitly, in-file, so the raw-request path is checked
 * against a warmed-up server in EVERY run regardless of how the shards land.
 *
 * The budget is deliberately far above the 3 s SSR deadline and far below the
 * 60 s+ the un-deadlined fetch used to burn: a stalled backend must reach the
 * retry screen, not hold the socket. Measured wall clock, not just the request
 * timeout, so a response that arrives at 14.9 s still reads as a pass and a
 * regression to "hangs until Playwright gives up" reads as a fail.
 */
const PREAMBLE_BOARD_PATH = '/kilter/original/12x12-square/screw_bolt/40';
/** 5× the SSR deadline. Anything slower than this is the stall, not latency. */
const POST_PREAMBLE_BUDGET_MS = 15_000;

async function timedGet(
  request: APIRequestContext,
  path: string,
): Promise<{ response: APIResponse; elapsedMs: number }> {
  const startedAt = Date.now();
  const response = await request.get(path, { maxRedirects: 0, timeout: POST_PREAMBLE_BUDGET_MS });
  return { response, elapsedMs: Date.now() - startedAt };
}

test.describe.serial('raw embed requests survive a browser-driven preamble', () => {
  test('the embed and kiosk raw requests still answer after front-door page loads', async ({ page, request }) => {
    // Six cold server renders before the two assertions. On a 2-core runner
    // that is comfortably past the 60 s per-test default, and a timeout here
    // would read as the stall this guard exists to detect.
    test.setTimeout(180_000);

    // CONCURRENT home-page renders first. This is the load that caused the
    // stall, and the concurrency is the whole mechanism: `/` is the only
    // surface that reads `popularBoardConfigs` + `recentBetaLinks`, the two
    // cold backend reads that used to take one pool connection each, and the
    // web's 3 s deadline aborts them before Next can cache the result — so
    // every `/` render is a cold read, forever. Ten at once used to leave the
    // backend's ten-connection pool with nothing for anything else.
    //
    // Sequential `page.goto`s do NOT reproduce this (verified: a four-locale
    // sequential preamble stays green against the un-fixed backend), which is
    // why these are parallel raw requests rather than navigations.
    const HOME_RENDER_FANOUT = 10;
    await Promise.all(
      Array.from({ length: HOME_RENDER_FANOUT }, () => request.get('/', { timeout: POST_PREAMBLE_BUDGET_MS })),
    );

    // Then the preamble board-route-teardown.spec.ts drives: the SSR front
    // door, scrolled to the bottom so everything below the fold mounts, then a
    // climb view. Both read the database on the server.
    await page.goto(`${PREAMBLE_BOARD_PATH}/list`, { waitUntil: 'load' });
    await waitForBoardListReady(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const climbHref = await page.locator(`a[href*="${PREAMBLE_BOARD_PATH}/view/"]`).first().getAttribute('href');
    expect(climbHref).toBeTruthy();
    await page.goto(climbHref!, { waitUntil: 'load' });

    // /embed/board/** is the render that awaits the backend over HTTP — the
    // one that used to hang. A uuid nothing has asked for keeps it off the
    // Data Cache fast path (`revalidate: 300` would otherwise answer this from
    // the entry the first test in this file wrote), so it always exercises a
    // cold backend read.
    const embed = await timedGet(request, `/embed/board/${randomUUID()}`);
    expect([200, 404]).toContain(embed.response.status());
    expect(headerValue(embed.response, 'content-security-policy')).toContain('frame-ancestors *');
    expect(embed.elapsedMs).toBeLessThan(POST_PREAMBLE_BUDGET_MS);

    // /kiosk/** is the same shape one route tree over, and it hung in CI too.
    const kiosk = await timedGet(request, `/kiosk/${randomUUID()}`);
    expect(headerValue(kiosk.response, 'x-frame-options')).toBe('SAMEORIGIN');
    expect(kiosk.elapsedMs).toBeLessThan(POST_PREAMBLE_BUDGET_MS);
  });
});
