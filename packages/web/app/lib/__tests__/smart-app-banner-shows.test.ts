import { describe, expect, it } from 'vite-plus/test';
import { smartAppBannerShows } from '../smart-app-banner';

const IOS = 'iPhone; CPU iPhone OS 18_0 like Mac OS X';
const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';

/** Which browsers show Safari's own Smart App Banner, so a page skips its own install bar there. */
describe('smartAppBannerShows', () => {
  it.each([
    ['Safari on an iPhone', `Mozilla/5.0 (${IOS}) ${WEBKIT} Version/18.0 Mobile/15E148 Safari/604.1`, 0],
    [
      'Safari on an iPad asking for the mobile page',
      `Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) ${WEBKIT} Version/17.0 Mobile/15E148 Safari/604.1`,
      0,
    ],
    [
      'Safari on an iPad asking for the desktop page',
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/17.0 Safari/605.1.15`,
      5,
    ],
  ])('shows for %s', (_browser, userAgent, maxTouchPoints) => {
    expect(smartAppBannerShows(userAgent, maxTouchPoints)).toBe(true);
  });

  it.each([
    ['Chrome on an iPhone', `Mozilla/5.0 (${IOS}) ${WEBKIT} CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1`, 0],
    ['Firefox on an iPhone', `Mozilla/5.0 (${IOS}) ${WEBKIT} FxiOS/132.0 Mobile/15E148 Safari/605.1.15`, 0],
    [
      'Edge on an iPhone',
      `Mozilla/5.0 (${IOS}) ${WEBKIT} Version/18.0 EdgiOS/130.0.2849.80 Mobile/15E148 Safari/604.1`,
      0,
    ],
    ['the Google app on an iPhone', `Mozilla/5.0 (${IOS}) ${WEBKIT} GSA/340.0.692345303 Mobile/15E148 Safari/604.1`, 0],
    [
      "Instagram's in-app browser",
      `Mozilla/5.0 (${IOS}) ${WEBKIT} Mobile/15E148 Instagram 340.0.0.22.109 (iPhone15,2; iOS 18_0; en_US)`,
      0,
    ],
    [
      "Facebook's in-app browser",
      `Mozilla/5.0 (${IOS}) ${WEBKIT} Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.42.105;FBBV/650000000]`,
      0,
    ],
    ['Safari on a Mac', `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT} Version/17.0 Safari/605.1.15`, 0],
    [
      'Chrome on Android',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      5,
    ],
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      0,
    ],
    ['no user agent at all', '', 0],
  ])('does not show for %s', (_browser, userAgent, maxTouchPoints) => {
    expect(smartAppBannerShows(userAgent, maxTouchPoints)).toBe(false);
  });
});
