import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PATHNAME_HEADER } from '../lib/request-pathname-header';
import { IOS_APP_STORE_ID, IOS_APP_STORE_URL } from '../lib/store-urls';

/**
 * The iOS Smart App Banner (#6027): one `apple-itunes-app` meta tag from the
 * root layout, so Safari on an iPhone offers the app on every www page,
 * including the ones with no store button.
 */

vi.mock('server-only', () => ({}));

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const rootLayout = await import('../layout');

type ItunesMetadata = { appId: string; appArgument?: string };

async function bannerFor(headerEntries: Record<string, string>): Promise<ItunesMetadata | null | undefined> {
  requestHeaders.current = new Headers(headerEntries);
  const metadata = await rootLayout.generateMetadata();
  return metadata.itunes as ItunesMetadata | null | undefined;
}

describe('root layout Smart App Banner', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
  });

  it('names the app the store links point at', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/' });

    expect(banner?.appId).toBe(IOS_APP_STORE_ID);
    expect(IOS_APP_STORE_URL.endsWith(`/id${IOS_APP_STORE_ID}`)).toBe(true);
  });

  it('hands the app the page the visitor is on', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/kilter/original/12x12/screw_bolt/40/view/abc' });

    expect(banner?.appArgument).toBe('https://www.boardsesh.com/kilter/original/12x12/screw_bolt/40/view/abc');
  });

  it('puts the locale prefix back, since middleware strips it', async () => {
    const banner = await bannerFor({ [PATHNAME_HEADER]: '/gyms', 'x-boardsesh-locale': 'es' });

    expect(banner?.appArgument).toBe('https://www.boardsesh.com/es/gyms');
  });

  it('still offers the app on a request with no pathname header', async () => {
    const banner = await bannerFor({});

    expect(banner?.appId).toBe(IOS_APP_STORE_ID);
    expect(banner?.appArgument).toBeUndefined();
  });
});
