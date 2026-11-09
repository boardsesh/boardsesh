import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { isBlockedCrawler, LOCALE_PATH_SEGMENTS } from '../crawler-policy';

const HEADLESS_CHROME_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36';

// What a partner's coding agent, test run or server sends. Each one carries a
// signature from AUTOMATION_SIGNATURE_TOKENS.
const AUTOMATED_USER_AGENTS = [
  HEADLESS_CHROME_USER_AGENT,
  'curl/8.9.1',
  'python-requests/2.32.3',
  'Go-http-client/2.0',
] as const;

const PARTNER_OAUTH_PATHS = [
  '/v1/me',
  '/v1/connection',
  // The name the design doc used before the API moved to /v1/.
  '/v1/partner/workouts',
  '/api/auth/oauth2/authorize',
  '/api/auth/oauth2/token',
  '/.well-known/oauth-authorization-server/api/auth',
  '/oauth/consent',
  '/oauth/sign-in',
  '/developers',
  '/developers/apps',
  '/auth/login',
] as const;

describe('automation default-deny exemptions for partner OAuth', () => {
  describe.each(PARTNER_OAUTH_PATHS)('GET %s', (pathname) => {
    it.each(AUTOMATED_USER_AGENTS)('lets %s through', (userAgent) => {
      expect(isBlockedCrawler(userAgent, { method: 'GET', pathname })).toBe(false);
    });

    it('still refuses a named crawler, whatever the path', () => {
      expect(isBlockedCrawler('GPTBot/1.4', { method: 'GET', pathname })).toBe(true);
    });
  });

  it.each(['/', '/setter/jimmy', '/auth/register', '/api/auth/session', '/oauthish', '/developersish'])(
    'keeps refusing automation on %s',
    (pathname) => {
      for (const userAgent of AUTOMATED_USER_AGENTS) {
        expect(isBlockedCrawler(userAgent, { method: 'GET', pathname })).toBe(true);
      }
    },
  );

  it('lists every locale www serves', () => {
    expect([...LOCALE_PATH_SEGMENTS].sort()).toEqual(
      SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).sort(),
    );
  });

  describe.each(['es', 'fr', 'de', 'it'])('under the /%s locale prefix', (locale) => {
    it.each(['/oauth/consent', '/oauth/sign-in', '/developers', '/developers/apps', '/auth/login'])(
      'lets automation reach %s',
      (path) => {
        for (const userAgent of AUTOMATED_USER_AGENTS) {
          expect(isBlockedCrawler(userAgent, { method: 'GET', pathname: `/${locale}${path}` })).toBe(false);
        }
      },
    );

    it('still refuses a named crawler', () => {
      expect(isBlockedCrawler('GPTBot/1.4', { method: 'GET', pathname: `/${locale}/oauth/consent` })).toBe(true);
    });

    // The API surfaces are never localized, and other pages stay covered.
    it.each(['/v1/me', '/auth/register', '/setter/jimmy'])('keeps refusing automation on %s', (path) => {
      expect(isBlockedCrawler('curl/8.9.1', { method: 'GET', pathname: `/${locale}${path}` })).toBe(true);
    });
  });

  it('leaves a real browser alone on a page outside the exemptions', () => {
    const chromeUserAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    expect(isBlockedCrawler(chromeUserAgent, { method: 'GET', pathname: '/setter/jimmy' })).toBe(false);
  });
});
