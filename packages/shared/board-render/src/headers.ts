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
 * The share-card family's `full` art slot: the board on the left, the text column
 * from `OG_CARD_COLUMN_LEFT`. Every card that draws a board uses it, the climb card
 * included (docs/og-climb.md, "The climb-identity column").
 *
 * Plain numbers here rather than in `og-family.ts` because `render-config.ts` needs
 * the board box to compute the OG scale, and that module is in the browser's render
 * worker, which must not pull in sharp.
 */
export const OG_CARD_ART_LEFT = 16;
export const OG_CARD_ART_RIGHT = 560;
/** Left edge of the text column. The hero runs from here to the search crop's right edge. */
export const OG_CARD_COLUMN_LEFT = 590;
/** Inset above and below the board. */
export const OG_CARD_BOARD_TOP_INSET = 14;

/**
 * The box the board art is fitted into, right-aligned inside it so a portrait
 * board reaches into a search engine's square centre crop (x 285-915).
 */
export const OG_CARD_BOARD_BOX = {
  left: OG_CARD_ART_LEFT,
  top: OG_CARD_BOARD_TOP_INSET,
  width: OG_CARD_ART_RIGHT - OG_CARD_ART_LEFT,
  height: OG_IMAGE_HEIGHT - OG_CARD_BOARD_TOP_INSET * 2,
} as const;

/**
 * Where a rendered board of this size sits on the OG canvas: right-aligned against
 * the column, vertically centred.
 *
 * One definition, because three code paths place it: `composeOgBaseBuffer` for the
 * backend's `/og/climb`, `renderBoardImageBuffer`'s `variant=og` branch, and the
 * family's `full` slot. A disagreement would show as the board and its frame
 * drifting apart.
 */
export function placeOgBoard(boardWidth: number, boardHeight: number): { left: number; top: number } {
  // Clamped, because the scale that sizes the board and the subtraction that
  // places it round independently: a board a fraction wider than its box would
  // otherwise get a negative offset, which sharp clips without complaining.
  return {
    left: Math.max(OG_CARD_ART_LEFT, OG_CARD_ART_RIGHT - boardWidth),
    top: Math.max(0, OG_CARD_BOARD_TOP_INSET + Math.round((OG_CARD_BOARD_BOX.height - boardHeight) / 2)),
  };
}

/**
 * Build the cache + content headers for an OG image response. Three tiers:
 * versioned (a content hash in the URL) gets immutable one-year caching;
 * unversioned gets either the short redirect-grade TTL or the bounded daily one.
 * Emits the Vercel-CDN-Cache-Control variant too — harmless on other CDNs,
 * load-bearing on Vercel.
 */
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

/**
 * Headers for a card that must be re-authorized on every fetch.
 *
 * A card whose subject can go private (a playlist, a profile, a session) cannot be
 * cached by anyone between the origin and the crawler: an old versioned URL would
 * otherwise keep serving the old bytes after the owner closed the door.
 */
export function createPrivateOgImageHeaders(
  options: Parameters<typeof createOgImageHeaders>[0],
): Record<string, string> {
  return {
    ...createOgImageHeaders(options),
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
  };
}
