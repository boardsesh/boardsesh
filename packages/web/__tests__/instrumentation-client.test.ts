import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Guards the crawler half of the Sentry client gate.
//
// `tunnelRoute: '/monitoring'` in next.config.mjs means every browser event the
// SDK sends is first a POST to our own origin. Crawlers that execute JavaScript
// boot this SDK exactly like a browser does, so they generate that POST too. A
// 5-minute sample of production boardsesh-web on 2026-09-10 caught Applebot
// sending 190 of its 253 requests to `/monitoring` — the single most-requested
// path on the service, ahead of every climb page. Those events have no user
// behind them and no session to replay, so they cost origin CPU, egress and
// Sentry quota for nothing.
//
// The module calls Sentry.init at import time, so each case re-imports it with
// a fresh module registry.

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  init: mocks.init,
  captureRouterTransitionStart: mocks.captureRouterTransitionStart,
}));

const originalLocation = window.location;
const originalUserAgent = navigator.userAgent;

function setWindowLocation(url: string): void {
  Object.defineProperty(window, 'location', { value: new URL(url), writable: true, configurable: true });
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, writable: true, configurable: true });
}

/** Import the module fresh and hand back the options it passed to Sentry.init. */
async function initOptions(): Promise<{ enabled: boolean }> {
  await import('../instrumentation-client');
  expect(mocks.init).toHaveBeenCalledTimes(1);
  return mocks.init.mock.calls[0][0] as { enabled: boolean };
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

describe('Sentry client gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setWindowLocation('https://www.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/list');
    setUserAgent(BROWSER_UA);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
    Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, writable: true, configurable: true });
  });

  it('stays enabled for a real browser on a production host', async () => {
    // The control. Without this, a gate that disabled Sentry outright would
    // pass every other case in this file.
    expect((await initOptions()).enabled).toBe(true);
  });

  it.each([
    [
      'Applebot',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    ],
    ['YandexBot', 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)'],
    [
      'Googlebot',
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.36 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    ],
  ])('never initialises for %s, even on a production host', async (_label, userAgent) => {
    setUserAgent(userAgent);
    expect((await initOptions()).enabled).toBe(false);
  });

  it('still refuses a non-production host', async () => {
    // The host gate predates this one and must survive it — preview deploys at
    // <pr>.preview.boardsesh.com leaked into the prod project once already
    // (#3808). See app/lib/production-hosts.ts.
    setWindowLocation('https://1234.preview.boardsesh.com/');
    expect((await initOptions()).enabled).toBe(false);
  });

  it.each([
    [
      'Yandex Browser',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 YaBrowser/23.9.1.962 Yowser/2.5 Safari/537.36',
    ],
    [
      // The reason this file uses isAutomatedCrawlerUserAgent rather than the
      // locale gates' isCrawlerUserAgent: the in-app browser spells itself
      // `YandexSearch`, which contains Next's `yandex` token. Costing this
      // visitor a default-locale page is acceptable; silently dropping their
      // error reports is not.
      'Yandex Search in-app browser',
      'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/106.0.0.0 Mobile Safari/537.36 YandexSearch/1.0',
    ],
  ])('keeps a real %s user reporting', async (_label, userAgent) => {
    setUserAgent(userAgent);
    expect((await initOptions()).enabled).toBe(true);
  });
});
