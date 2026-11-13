/**
 * The board-route teardown (#4433), checked end to end.
 *
 * Three things a unit test cannot see:
 *  1. Every deleted path actually 30x's — in all four locales. `redirects()`
 *     runs before middleware and matches sources literally, so a missing
 *     locale twin is a 404 for three quarters of the audience and nothing in
 *     the type system notices.
 *  2. `/play` still 308s with the climb name attached. A static redirect over
 *     the same prefix would swallow it into a bare-uuid `/view` URL that
 *     redirects again.
 *  3. No WebSocket opens on a board route for a signed-out visitor. This is
 *     W-17's own DoD, and it only became true once the layouts stopped
 *     mounting the session providers and the comment section stopped dialling
 *     the backend for anonymous readers.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForBoardListReady } from './helpers/waits';

const BOARD_PATH = '/kilter/original/12x12-square/screw_bolt/40';
/** The same board in canonical numeric form — the only form the app can parse. */
const NUMERIC_BOARD_PATH = '/kilter/1/10/1,2/40';
/**
 * A legacy MoonBoard import bookmark, before import moved out of Next.
 */
const MOONBOARD_PATH = '/moonboard/3/17/5,8/40';
const SLUG_BOARD_PATH = '/b/test-board/40';
const LOCALE_PREFIXES = ['', '/es', '/fr', '/de', '/it'] as const;

/** Deleted paths whose destination stays on www, and where each one lands. */
const SAME_ORIGIN_REDIRECTS = [
  { from: `${BOARD_PATH}/liked`, to: `${BOARD_PATH}/list` },
  { from: `${BOARD_PATH}/logbook`, to: '/playlists' },
  { from: `${BOARD_PATH}/playlists`, to: '/playlists' },
  { from: `${BOARD_PATH}/playlists/some-playlist-uuid`, to: '/playlists/some-playlist-uuid' },
  { from: `${SLUG_BOARD_PATH}/liked`, to: `${SLUG_BOARD_PATH}/list` },
  { from: `${SLUG_BOARD_PATH}/logbook`, to: '/playlists' },
  { from: `${SLUG_BOARD_PATH}/playlists`, to: '/playlists' },
  { from: `${SLUG_BOARD_PATH}/playlists/some-playlist-uuid`, to: '/playlists/some-playlist-uuid' },
] as const;

/** Deleted paths that hand off to the app. */
const APP_HANDOFF_PATHS = [`${BOARD_PATH}/create`, `${SLUG_BOARD_PATH}/create`] as const;

/** Import bookmarks now lead to the app's board-account integrations. */
const IMPORTER_PATHS = [
  '/moonboard-import',
  `${MOONBOARD_PATH}/import`,
  `${SLUG_BOARD_PATH}/import`,
  `${NUMERIC_BOARD_PATH}/import`,
] as const;

test.describe('deleted board-route siblings redirect in every locale', () => {
  for (const prefix of LOCALE_PREFIXES) {
    const localeLabel = prefix === '' ? 'en-US' : prefix.slice(1);

    for (const { from, to } of SAME_ORIGIN_REDIRECTS) {
      test(`${localeLabel}: ${from} 308s to ${to}`, async ({ request }) => {
        const response = await request.get(`${prefix}${from}`, { maxRedirects: 0 });

        expect(response.status()).toBe(308);
        expect(response.headers()['location']).toBe(`${prefix}${to}`);
      });
    }

    for (const from of APP_HANDOFF_PATHS) {
      test(`${localeLabel}: ${from} hands off to the app, temporarily`, async ({ request }) => {
        const response = await request.get(`${prefix}${from}`, { maxRedirects: 0 });

        // 307, not 308: a permanent cross-origin redirect is cached by the
        // browser forever and there would be no way back.
        expect(response.status()).toBe(307);
        const location = response.headers()['location'];
        expect(location).toMatch(/^https?:\/\//);
        // The app has no locale routing — the prefix is dropped on purpose.
        expect(new URL(location).pathname).toBe('/climbs/create');
      });
    }

    test(`${localeLabel}: a numeric create URL carries its board to the app`, async ({ request }) => {
      const response = await request.get(`${prefix}${NUMERIC_BOARD_PATH}/create`, { maxRedirects: 0 });

      expect(response.status()).toBe(307);
      const location = new URL(response.headers()['location']);
      expect(location.pathname).toBe('/climbs/create');
      expect(Object.fromEntries(location.searchParams)).toEqual({
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
      });
    });

    for (const from of IMPORTER_PATHS) {
      test(`${localeLabel}: ${from} hands off to app integrations`, async ({ request }) => {
        const response = await request.get(`${prefix}${from}`, { maxRedirects: 0 });

        expect(response.status()).toBe(307);
        const location = new URL(response.headers()['location']);
        expect(location.origin).not.toBe(new URL(response.url()).origin);
        expect(location.pathname).toBe('/settings/integrations');
      });
    }
  }
});

test.describe('the surviving board routes', () => {
  test('/play still redirects to the slugged climb view', async ({ page, request }) => {
    await page.goto(`${BOARD_PATH}/list`);
    await waitForBoardListReady(page);

    const climbHref = await page.locator(`a[href*="${BOARD_PATH}/view/"]`).first().getAttribute('href');
    expect(climbHref).toBeTruthy();

    const climbSegment = climbHref!.split('/view/')[1];
    const response = await request.get(`${BOARD_PATH}/play/${climbSegment}`, { maxRedirects: 0 });

    expect([301, 308]).toContain(response.status());
    expect(response.headers()['location']).toContain(`${BOARD_PATH}/view/`);
  });
});

/**
 * The path every product WebSocket in this app connects to. The only one is the
 * graphql-ws link to the backend — `getBackendWsUrl()` in
 * `app/lib/backend-url.ts` always ends in `/graphql`.
 *
 * Matching it positively is what makes this check trustworthy. A negative
 * filter would have to enumerate every socket that is *not* ours, and the local
 * runner boots the Next dev server, where HMR, the RSC debug channel and the
 * Vercel toolbar each open their own — any of which would red a test whose
 * subject is the comment socket.
 */
const PRODUCT_WS_PATHNAME = '/graphql';

/**
 * Records every product WebSocket the page opens while it loads and while it
 * sits scrolled to the bottom — the comment section mounts below the fold, so
 * a check that never scrolls passes vacuously.
 */
async function socketsOpenedOn(page: Page, path: string): Promise<string[]> {
  const sockets: string[] = [];
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).pathname === PRODUCT_WS_PATHNAME) sockets.push(ws.url());
  });

  await page.goto(path, { waitUntil: 'load' });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3_000);

  return sockets;
}

test.describe('no WebSocket opens on a board route for a signed-out visitor', () => {
  test('the board list front door', async ({ page }) => {
    expect(await socketsOpenedOn(page, `${BOARD_PATH}/list`)).toEqual([]);
  });

  test('the named-board list front door', async ({ page }) => {
    // The `/b/{slug}` tree has its own layout, stripped in the same PR — a green
    // config-tuple tree says nothing about this one.
    expect(await socketsOpenedOn(page, `${SLUG_BOARD_PATH}/list`)).toEqual([]);
  });

  test('a climb front door', async ({ page }) => {
    await page.goto(`${BOARD_PATH}/list`);
    await waitForBoardListReady(page);
    const climbHref = await page.locator(`a[href*="${BOARD_PATH}/view/"]`).first().getAttribute('href');
    expect(climbHref).toBeTruthy();

    expect(await socketsOpenedOn(page, climbHref!)).toEqual([]);
  });
});
