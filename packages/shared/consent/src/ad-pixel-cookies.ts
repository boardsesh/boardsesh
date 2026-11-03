/**
 * First-party cookies the Meta Pixel and the Reddit Pixel write on www (see
 * docs/analytics-consent.md#ad-pixels). Both www and the browser app at
 * app.boardsesh.com share `.boardsesh.com`, so a No on either must clear them.
 */
export const AD_PIXEL_COOKIE_NAMES = ['_fbp', '_fbc', '_rdt_uuid', '_rdt_cid'] as const;

/**
 * Every `document.cookie` assignment that expires the ad-pixel cookies for
 * `hostname`: host-only, then each parent domain (the pixels write to the
 * registrable domain, e.g. `boardsesh.com`). Pure, so both platforms share it.
 */
export function adPixelCookieExpiries(hostname: string): string[] {
  const labels = hostname.split('.');
  const domains: Array<string | null> = [null];
  for (let index = 0; index < labels.length - 1; index += 1) domains.push(labels.slice(index).join('.'));
  return AD_PIXEL_COOKIE_NAMES.flatMap((name) =>
    domains.map((domain) => `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ''}`),
  );
}
