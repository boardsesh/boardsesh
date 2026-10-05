import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_PLAY_STORE_URL,
  APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH,
  IOS_APP_STORE_URL,
  appStoreCampaignToken,
  appStoreUrlForBrowserApp,
  buildBrowserAppInstallClickProperties,
  detectStorePlatform,
  playStoreUrlForBrowserApp,
  storeUrlForBrowserApp,
  type StorePromptSurface,
} from '../store-links';

const SURFACES: StorePromptSurface[] = ['climb-view', 'login', 'home'];

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI =
  'Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const HARMONY_BROWSER =
  'Mozilla/5.0 (Linux; Android 12; HarmonyOS; NOH-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 HuaweiBrowser/15.0 Mobile Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function readRepoFile(relativeToThisTest: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToThisTest, import.meta.url)), 'utf8');
}

describe('detectStorePlatform', () => {
  it('offers the App Store to iPhone and iPad browsers', () => {
    expect(detectStorePlatform(IPHONE_SAFARI)).toBe('ios');
    expect(detectStorePlatform(IPAD_SAFARI)).toBe('ios');
  });

  it('offers Google Play to Android browsers', () => {
    expect(detectStorePlatform(ANDROID_CHROME)).toBe('android');
  });

  it('offers nothing on a desktop browser', () => {
    expect(detectStorePlatform(MAC_SAFARI)).toBeNull();
    expect(detectStorePlatform(WINDOWS_CHROME)).toBeNull();
  });

  // The user agent says "Android", but the device has no Play Store.
  it('offers nothing on HarmonyOS', () => {
    expect(detectStorePlatform(HARMONY_BROWSER)).toBeNull();
  });

  it('offers nothing without a user agent', () => {
    expect(detectStorePlatform('')).toBeNull();
    expect(detectStorePlatform(null)).toBeNull();
    expect(detectStorePlatform(undefined)).toBeNull();
  });
});

describe('playStoreUrlForBrowserApp', () => {
  it.each(SURFACES)('carries the %s source in the install referrer', (surface) => {
    const url = new URL(playStoreUrlForBrowserApp(surface));

    expect(`${url.origin}${url.pathname}`).toBe('https://play.google.com/store/apps/details');
    expect(url.searchParams.get('id')).toBe('com.boardsesh.app');

    // What the app reads back on first launch: `install-referrer.ts` splits the
    // referrer as a query string. A link with only the bare utm_* params would
    // attribute nothing.
    const referrer = new URLSearchParams(url.searchParams.get('referrer') ?? '');
    expect(referrer.get('utm_source')).toBe('boardsesh');
    expect(referrer.get('utm_medium')).toBe('browser-app');
    expect(referrer.get('utm_campaign')).toBe(surface);

    // What Play's own acquisition report reads.
    expect(url.searchParams.get('utm_source')).toBe('boardsesh');
    expect(url.searchParams.get('utm_medium')).toBe('browser-app');
    expect(url.searchParams.get('utm_campaign')).toBe(surface);
  });

  it('encodes the referrer once, as a single parameter value', () => {
    expect(playStoreUrlForBrowserApp('login')).toBe(
      'https://play.google.com/store/apps/details?id=com.boardsesh.app&utm_source=boardsesh&utm_medium=browser-app&utm_campaign=login&referrer=utm_source%3Dboardsesh%26utm_medium%3Dbrowser-app%26utm_campaign%3Dlogin',
    );
  });
});

describe('appStoreUrlForBrowserApp', () => {
  it.each(SURFACES)('carries the %s campaign token', (surface) => {
    const url = new URL(appStoreUrlForBrowserApp(surface));

    expect(`${url.origin}${url.pathname}`).toBe(IOS_APP_STORE_URL);
    expect(url.searchParams.get('ct')).toBe(`browser-app-${surface}`);
    expect(url.searchParams.get('mt')).toBe('8');
    // No provider id in the repo yet; an empty `pt` would be worse than none.
    expect(url.searchParams.has('pt')).toBe(false);
  });

  it('adds the provider token when one is passed', () => {
    const url = new URL(appStoreUrlForBrowserApp('home', '123456'));
    expect(url.searchParams.get('pt')).toBe('123456');
  });

  it.each(SURFACES)('keeps the %s token inside the 40-character limit', (surface) => {
    expect(appStoreCampaignToken(surface).length).toBeLessThanOrEqual(APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH);
  });
});

describe('storeUrlForBrowserApp', () => {
  it('picks the store that matches the platform', () => {
    expect(storeUrlForBrowserApp('android', 'home')).toBe(playStoreUrlForBrowserApp('home'));
    expect(storeUrlForBrowserApp('ios', 'home')).toBe(appStoreUrlForBrowserApp('home'));
  });
});

describe('buildBrowserAppInstallClickProperties', () => {
  it("uses www's platform and source values, with a browser-app placement", () => {
    expect(buildBrowserAppInstallClickProperties('android', 'climb-view')).toEqual({
      platform: 'android',
      source: 'google-play',
      placement: 'browser-app-climb-view',
      utm_source: 'boardsesh',
      utm_medium: 'browser-app',
      utm_campaign: 'climb-view',
    });
    expect(buildBrowserAppInstallClickProperties('ios', 'login')).toEqual({
      platform: 'ios',
      source: 'app-store',
      placement: 'browser-app-login',
      utm_source: 'boardsesh',
      utm_medium: 'browser-app',
      utm_campaign: 'login',
    });
  });
});

// Three copies of the two store URLs exist because none can import another:
// build-time Expo config, the web package, and this module.
describe('store URL copies', () => {
  it('match the Expo config', () => {
    const appConfig = readRepoFile('../../../app.config.ts');
    expect(appConfig).toContain(`'${IOS_APP_STORE_URL}'`);
    expect(appConfig).toContain(`'${ANDROID_PLAY_STORE_URL}'`);
  });

  it('match www', () => {
    const webStoreUrls = readRepoFile('../../../../web/app/lib/store-urls.ts');
    expect(webStoreUrls).toContain(`'${IOS_APP_STORE_URL}'`);
    expect(webStoreUrls).toContain(`'${ANDROID_PLAY_STORE_URL}'`);
  });
});
