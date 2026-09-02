export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

const ONE_YEAR_SECONDS = 31_536_000;
const SHORT_TTL_SECONDS = 300;
// The short tier's stale window and the daily tier's fresh window are both a day
// by coincidence, not by shared meaning — they answer different questions and can
// move independently. Named apart so an edit to one cannot silently be an edit to
// the other.
const SHORT_STALE_TTL_SECONDS = 86_400;
const DAILY_TTL_SECONDS = 86_400;
const DAILY_STALE_TTL_SECONDS = 604_800;

/**
 * How long an *unversioned* request may be cached. Versioned requests always get
 * the one-year immutable branch.
 *
 * - `short` (default, 300s + 24h SWR): the original branch, calibrated for the
 *   `/api/og/climb` 307 redirect, which carries no image bytes.
 * - `daily` (24h + 7d SWR): for an unversioned request that costs a real render.
 *   Board-render is 48.7% of all function invocations and `app/robots.ts` invites
 *   Googlebot-Image to index it, so a 300s TTL there would mean re-rendering the
 *   already-crawled unversioned tail up to 288 times a day per URL. A day of
 *   staleness is the whole correctness win at 1/288th of the origin cost.
 */
export type UnversionedCacheTier = 'short' | 'daily';

/**
 * Build the cache + content headers for an OG image response. Three tiers:
 * versioned (a content hash in the URL) gets immutable one-year caching;
 * unversioned gets either the short redirect-grade TTL or the bounded daily one.
 * Emits the Vercel-CDN-Cache-Control variant too — harmless on other CDNs,
 * load-bearing on Vercel.
 */
/**
 * Padding between the OG canvas edge and the board art, in canvas pixels.
 *
 * Lives here rather than beside the backdrop it pads because `render-config.ts`
 * needs it to compute the OG scale, and that module is imported by the browser's
 * render worker — `background.ts` reaches `@boardsesh/board-config` for MoonBoard's
 * layout art, which is a whole board catalogue to carry for two integers.
 */
export const OG_BOARD_PADDING_X = 48;
export const OG_BOARD_PADDING_Y = 48;

export function createOgImageHeaders({
  contentType,
  version,
  serverTiming,
  unversionedTier = 'short',
}: {
  contentType: string;
  version?: string | null;
  serverTiming?: string;
  unversionedTier?: UnversionedCacheTier;
}): Record<string, string> {
  const isVersioned = version !== null && version !== undefined;
  const unversionedMaxAge = unversionedTier === 'daily' ? DAILY_TTL_SECONDS : SHORT_TTL_SECONDS;
  const unversionedStale = unversionedTier === 'daily' ? DAILY_STALE_TTL_SECONDS : SHORT_STALE_TTL_SECONDS;
  const browserCacheControl = isVersioned
    ? `public, max-age=${ONE_YEAR_SECONDS}, s-maxage=${ONE_YEAR_SECONDS}, immutable`
    : `public, max-age=0, s-maxage=${unversionedMaxAge}, stale-while-revalidate=${unversionedStale}`;
  const cdnCacheControl = isVersioned
    ? `public, s-maxage=${ONE_YEAR_SECONDS}, immutable`
    : `public, s-maxage=${unversionedMaxAge}, stale-while-revalidate=${unversionedStale}`;

  return {
    'Content-Type': contentType,
    'Cache-Control': browserCacheControl,
    'CDN-Cache-Control': cdnCacheControl,
    'Vercel-CDN-Cache-Control': cdnCacheControl,
    ...(serverTiming ? { 'Server-Timing': serverTiming } : {}),
  };
}
