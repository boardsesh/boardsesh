import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PATHNAME_HEADER } from '../lib/request-pathname-header';
import { SMART_APP_BANNER_META_NAME } from '../lib/smart-app-banner';
import { IOS_APP_STORE_ID, IOS_APP_STORE_URL } from '../lib/store-urls';

/**
 * The iOS Smart App Banner (#6027): one `apple-itunes-app` meta tag from the
 * root layout, so Safari on an iPhone offers the app on the www pages that have
 * no store button of their own.
 */

vi.mock('server-only', () => ({}));

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const rootLayout = await import('../layout');

/** The tag's `content` for a request, split into its `key=value` parts; `null` when the page has no tag. */
async function bannerFor(headerEntries: Record<string, string>): Promise<Map<string, string> | null> {
  requestHeaders.current = new Headers(headerEntries);
  const metadata = await rootLayout.generateMetadata();
  const content = metadata.other?.[SMART_APP_BANNER_META_NAME];
  if (typeof content !== 'string') return null;
  return new Map(
    content.split(', ').map((part): [string, string] => {
      const separatorIndex = part.indexOf('=');
      return [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)];
    }),
  );
}

describe('root layout Smart App Banner', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names the app the store links point at', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/' });

    expect(banner?.get('app-id')).toBe(IOS_APP_STORE_ID);
    expect(IOS_APP_STORE_URL.endsWith(`/id${IOS_APP_STORE_ID}`)).toBe(true);
  });

  it('hands the app the page the visitor is on', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/kilter/original/12x12/screw_bolt/40/view/abc' });

    expect(banner?.get('app-argument')).toBe('https://www.boardsesh.com/kilter/original/12x12/screw_bolt/40/view/abc');
  });

  it('puts the locale prefix back, since middleware strips it', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/gyms', 'x-boardsesh-locale': 'es' });

    expect(banner?.get('app-argument')).toBe('https://www.boardsesh.com/es/gyms');
  });

  it('still offers the app on a request with no pathname header', async () => {
    const banner = await bannerFor({});

    expect(banner?.get('app-id')).toBe(IOS_APP_STORE_ID);
    expect(banner?.has('app-argument')).toBe(false);
  });

  it('carries its own campaign token, so its downloads are not filed as untagged', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/' });

    expect(banner?.get('affiliate-data')).toBe('ct=site-banner');
  });

  it('names the provider next to the token when the build has one', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_STORE_PROVIDER_ID', '123456');
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/' });

    expect(banner?.get('affiliate-data')).toBe('pt=123456&ct=site-banner');
  });

  it.each(['/auth/reset-password', '/auth/login', '/auth'])(
    'offers the app on %s without handing it a link that needs its query string',
    async (pathname) => {
      const banner = await bannerFor({ [PATHNAME_HEADER]: pathname });

      expect(banner?.get('app-id')).toBe(IOS_APP_STORE_ID);
      expect(banner?.has('app-argument')).toBe(false);
    },
  );

  it.each(['/kiosk/some-gym', '/kiosk/some-gym/front-wall', '/embed/board/abc', '/embed/gym/abc/leaderboard'])(
    "puts no banner over %s, which is a display and not a page on someone's phone",
    async (pathname) => {
      expect(await bannerFor({ [PATHNAME_HEADER]: pathname })).toBeNull();
    },
  );

  it('keeps the banner on a page whose name only starts like an excluded one', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/authors' });

    expect(banner?.get('app-argument')).toBe('https://www.boardsesh.com/authors');
  });
});
