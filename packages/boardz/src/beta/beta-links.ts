import {
  BETA_THUMBNAIL_REQUEST_SIZE,
  dedupeBetaLinks,
  isBetaVideoUrl,
  mapBetaLinksResponse,
  type BetaLink,
  type BetaLinksGqlRow,
} from '@boardsesh/shared-schema';

/**
 * Cached thumbnails come back as backend paths (`/static/beta-link-thumbnails/…`),
 * which redirect to Boardsesh's media host. Ask for the size a card needs.
 * Absolute URLs (a platform's own CDN) pass through untouched.
 */
export function thumbnailUrl(thumbnail: string | null, backendOrigin: string): string | null {
  if (!thumbnail || !thumbnail.startsWith('/')) return thumbnail;
  const absolute = `${backendOrigin.replace(/\/+$/, '')}${thumbnail}`;
  return `${absolute}${absolute.includes('?') ? '&' : '?'}size=${BETA_THUMBNAIL_REQUEST_SIZE}`;
}

/**
 * The videos worth showing for a climb: listed, from a platform Boardz can
 * open, one card per video, and filmed at the climber's angle first.
 */
export function betaForClimb(rows: BetaLinksGqlRow[], angle: number, backendOrigin: string): BetaLink[] {
  const videos = dedupeBetaLinks(
    mapBetaLinksResponse(rows, (thumbnail) => thumbnailUrl(thumbnail, backendOrigin)).filter(
      (beta) => beta.is_listed && isBetaVideoUrl(beta.link),
    ),
  );
  const rank = (beta: BetaLink) => (beta.angle === angle ? 0 : beta.angle === null ? 1 : 2);
  // A stable sort keeps Boardsesh's order inside each group.
  return videos
    .map((beta, index) => ({ beta, index }))
    .sort((first, second) => rank(first.beta) - rank(second.beta) || first.index - second.index)
    .map((entry) => entry.beta);
}
