import { mapBetaLinkRow, mapBetaLinksResponse, BETA_THUMBNAIL_REQUEST_SIZE } from '@boardsesh/shared-schema';
import type { BetaLink, BetaLinksGqlRow } from '@boardsesh/shared-schema';
import { BACKEND_URL, WEB_BASE_URL } from './env';

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
 * Cached thumbnails use the backend's `/static/beta-link-thumbnails/...`
 * handler. Development fallback thumbnails use Next's SSRF-guarded
 * `/api/internal/beta-link-thumbnail` proxy, so those paths must use the web
 * origin instead. Request a sized variant for either relative form.
 *
 * Already-absolute URLs (third-party CDNs) are passed through untouched —
 * we can't resize those.
 *
 * Exported for tests; production callers should use `mapBetaLink` /
 * `mapBetaLinks` which thread it into the shared mapper.
 */
export function absolutizeThumbnail(thumbnail: string | null): string | null {
  if (!thumbnail || !thumbnail.startsWith('/')) return thumbnail;
  const origin = thumbnail.startsWith('/api/internal/') ? WEB_BASE_URL : BACKEND_URL;
  const absolute = `${origin.replace(/\/+$/, '')}${thumbnail}`;
  const separator = absolute.includes('?') ? '&' : '?';
  return `${absolute}${separator}size=${BETA_THUMBNAIL_REQUEST_SIZE}`;
}

export function mapBetaLink(row: BetaLinksGqlRow): BetaLink {
  return mapBetaLinkRow(row, absolutizeThumbnail);
}

export function mapBetaLinks(rows: BetaLinksGqlRow[]): BetaLink[] {
  return mapBetaLinksResponse(rows, absolutizeThumbnail);
}
