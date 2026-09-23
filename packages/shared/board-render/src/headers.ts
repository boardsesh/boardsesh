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
export const OG_BOARD_PADDING_X = 24;
export const OG_BOARD_PADDING_Y = 14;

/**
 * Width of the climb-identity column on the right of the OG card, and the gap
 * between it and the board art.
 *
 * A fixed column is safe because every shipped board is height-bound at OG size:
 * the narrowest horizontal gutter in the whole catalogue is Tension 1461×1144 at
 * 518 px, the widest Kilter 1080×2498 at 924 px. `og-geometry.test.ts` walks the
 * catalogue and fails if a board ever arrives that the column would squeeze.
 */
export const OG_CARD_TEXT_COLUMN_WIDTH = 392;
export const OG_CARD_COLUMN_GAP = 24;

/**
 * The box the board art is fitted into, right-aligned inside it.
 *
 * Right-aligned rather than centred because search engines crop a 1200×630 card
 * to a square from the centre, keeping x ∈ [285, 915]. Pushing the board towards
 * the text column puts a portrait board entirely inside that window — MoonBoard
 * and Kilter 1080×2498 both land at 100 % coverage, against 83 % and 64 %
 * centred.
 */
export const OG_CARD_BOARD_BOX = {
  left: OG_BOARD_PADDING_X,
  top: OG_BOARD_PADDING_Y,
  width: OG_IMAGE_WIDTH - OG_BOARD_PADDING_X * 2 - OG_CARD_TEXT_COLUMN_WIDTH - OG_CARD_COLUMN_GAP,
  height: OG_IMAGE_HEIGHT - OG_BOARD_PADDING_Y * 2,
} as const;

/**
 * Where a rendered board of this size sits on the OG canvas.
 *
 * One definition, because two code paths place it: `composeOgBaseBuffer` for the
 * backend's `/og/climb`, and `renderBoardImageBuffer`'s `variant=og` branch for
 * the web fallback. A disagreement between them would show as the board and its
 * frame drifting apart.
 */
export function placeOgBoard(boardWidth: number, boardHeight: number): { left: number; top: number } {
  // Clamped, because the scale that sizes the board and the subtraction that
  // places it round independently: a board a fraction wider than its box would
  // otherwise get a negative offset, which sharp clips without complaining.
  return {
    left: Math.max(OG_CARD_BOARD_BOX.left, OG_CARD_BOARD_BOX.left + OG_CARD_BOARD_BOX.width - boardWidth),
    top: Math.max(
      OG_CARD_BOARD_BOX.top,
      OG_CARD_BOARD_BOX.top + Math.round((OG_CARD_BOARD_BOX.height - boardHeight) / 2),
    ),
  };
}

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
