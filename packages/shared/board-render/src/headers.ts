export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

const ONE_YEAR_SECONDS = 31_536_000;
const SHORT_TTL_SECONDS = 300;
const STALE_TTL_SECONDS = 86_400;

/**
 * Build the cache + content headers for an OG image response. Versioned
 * requests (a content hash / timestamp in the URL) get immutable one-year
 * caching; unversioned ones get a short TTL with a stale-while-revalidate
 * window. Emits the Vercel-CDN-Cache-Control variant too — harmless on other
 * CDNs, load-bearing on Vercel.
 */
export function createOgImageHeaders({
  contentType,
  version,
  serverTiming,
}: {
  contentType: string;
  version?: string | null;
  serverTiming?: string;
}): Record<string, string> {
  const isVersioned = version !== null && version !== undefined;
  const browserCacheControl = isVersioned
    ? `public, max-age=${ONE_YEAR_SECONDS}, s-maxage=${ONE_YEAR_SECONDS}, immutable`
    : `public, max-age=0, s-maxage=${SHORT_TTL_SECONDS}, stale-while-revalidate=${STALE_TTL_SECONDS}`;
  const cdnCacheControl = isVersioned
    ? `public, s-maxage=${ONE_YEAR_SECONDS}, immutable`
    : `public, s-maxage=${SHORT_TTL_SECONDS}, stale-while-revalidate=${STALE_TTL_SECONDS}`;

  return {
    'Content-Type': contentType,
    'Cache-Control': browserCacheControl,
    'CDN-Cache-Control': cdnCacheControl,
    'Vercel-CDN-Cache-Control': cdnCacheControl,
    ...(serverTiming ? { 'Server-Timing': serverTiming } : {}),
  };
}
