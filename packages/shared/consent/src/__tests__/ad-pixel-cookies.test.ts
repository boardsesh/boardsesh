import { describe, expect, it } from 'vite-plus/test';
import { AD_PIXEL_COOKIE_NAMES, adPixelCookieExpiries } from '../ad-pixel-cookies';

describe('adPixelCookieExpiries', () => {
  it('expires every pixel cookie host-only and on each parent domain', () => {
    const expiries = adPixelCookieExpiries('app.boardsesh.com');
    expect(expiries).toHaveLength(AD_PIXEL_COOKIE_NAMES.length * 3);
    expect(expiries).toContain('_fbp=; Max-Age=0; Path=/');
    expect(expiries).toContain('_fbp=; Max-Age=0; Path=/; Domain=app.boardsesh.com');
    expect(expiries).toContain('_rdt_uuid=; Max-Age=0; Path=/; Domain=boardsesh.com');
    expect(expiries.some((expiry) => expiry.includes('Domain=com'))).toBe(false);
  });

  it('only clears host-only on a single-label host', () => {
    expect(adPixelCookieExpiries('localhost')).toEqual(
      AD_PIXEL_COOKIE_NAMES.map((name) => `${name}=; Max-Age=0; Path=/`),
    );
  });
});
