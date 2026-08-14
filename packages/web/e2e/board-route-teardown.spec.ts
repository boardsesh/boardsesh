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
 * MoonBoard 2024 (layout 3) running Hold Set D + Wooden Holds (5,8) — two of the
 * layout's six sets, which is what makes the `sets` param observable.
 */
const MOONBOARD_PATH = '/moonboard/3/17/5,8/40';
const SLUG_BOARD_PATH = '/b/test-board/40';
const LOCALE_PREFIXES = ['', '/es', '/fr', '/de'] as const;

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

/**
 * Deleted paths re-homed onto the board-agnostic importer. Bulk import is
 * MoonBoard-only, so the Aurora board's `…/import` is NOT one of them — it goes
 * to that board's own list, asserted separately below.
 */
const IMPORTER_PATHS = [`${MOONBOARD_PATH}/import`, `${SLUG_BOARD_PATH}/import`] as const;

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

    test(`${localeLabel}: a MoonBoard import URL carries the hold sets it named`, async ({ request }) => {
      const response = await request.get(`${prefix}${MOONBOARD_PATH}/import`, { maxRedirects: 0 });

      expect(response.status()).toBe(308);
      const location = new URL(response.headers()['location'], 'http://localhost');
      expect(location.pathname).toBe(`${prefix}/moonboard-import`);
      expect(location.searchParams.get('sets')).toBe('5,8');
    });

    test(`${localeLabel}: a non-MoonBoard import URL lands on that board's own list`, async ({ request }) => {
      // Bulk import is MoonBoard-only, and MoonBoard layout ids collide with
      // Aurora's — without its own rule this would open the importer for the
      // wrong board.
      const response = await request.get(`${prefix}${NUMERIC_BOARD_PATH}/import`, { maxRedirects: 0 });

      expect(response.status()).toBe(308);
      expect(response.headers()['location']).toBe(`${prefix}${NUMERIC_BOARD_PATH}/list`);
    });

    for (const from of IMPORTER_PATHS) {
      test(`${localeLabel}: ${from} 308s to the MoonBoard importer`, async ({ request }) => {
        const response = await request.get(`${prefix}${from}`, { maxRedirects: 0 });

        expect(response.status()).toBe(308);
        expect(response.headers()['location'].startsWith(`${prefix}/moonboard-import`)).toBe(true);
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

  test('the MoonBoard importer answers on its own route', async ({ request }) => {
    const response = await request.get('/moonboard-import');

    expect(response.status()).toBe(200);
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
