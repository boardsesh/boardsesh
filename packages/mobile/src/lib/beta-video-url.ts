import { mapBetaLinkRow, mapBetaLinksResponse, BETA_THUMBNAIL_REQUEST_SIZE } from '@boardsesh/shared-schema';
import type { BetaLink, BetaLinksGqlRow } from '@boardsesh/shared-schema';
import { BACKEND_URL } from './env';

// Re-export the platform-agnostic helpers so mobile code has a single import.
export {
  betaLinkIdentity,
  dedupeBetaLinks,
  isBetaVideoUrl,
  isInstagramUrl,
  isTikTokUrl,
  BETA_VIDEO_URL_VALIDATION_MESSAGE,
} from '@boardsesh/shared-schema';
export type { BetaLink, BetaLinksGqlRow };

/**
 * Beta thumbnails are served by the backend's `/static/beta-link-thumbnails/...`
 * handler. The GraphQL resolver returns the path as a backend-relative URL;
 * mobile always talks to the backend over `BACKEND_URL`, so prepend it when
 * the value is a path (not already an absolute URL), and request a sized
 * variant via `?size=`.
 *
 * Already-absolute URLs (third-party CDNs) are passed through untouched —
 * we can't resize those.
 *
 * Exported for tests; production callers should use `mapBetaLink` /
 * `mapBetaLinks` which thread it into the shared mapper.
 */
export function absolutizeThumbnail(thumbnail: string | null): string | null {
  if (!thumbnail || !thumbnail.startsWith('/')) return thumbnail;
  const absolute = `${BACKEND_URL.replace(/\/+$/, '')}${thumbnail}`;
  const separator = absolute.includes('?') ? '&' : '?';
  return `${absolute}${separator}size=${BETA_THUMBNAIL_REQUEST_SIZE}`;
}

export function mapBetaLink(row: BetaLinksGqlRow): BetaLink {
  return mapBetaLinkRow(row, absolutizeThumbnail);
}

export function mapBetaLinks(rows: BetaLinksGqlRow[]): BetaLink[] {
  return mapBetaLinksResponse(rows, absolutizeThumbnail);
}
