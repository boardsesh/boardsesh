import {
  BETA_VIDEO_URL_VALIDATION_MESSAGE,
  betaLinkIdentity as betaLinkIdentityShared,
  dedupeBetaLinks as dedupeBetaLinksShared,
  isBetaVideoUrl,
  isInstagramUrl,
  isTikTokUrl,
  mapBetaLinkRow as mapBetaLinkRowShared,
  mapBetaLinksResponse as mapBetaLinksResponseShared,
  BETA_THUMBNAIL_REQUEST_SIZE,
  type BetaLink,
  type BetaLinksGqlRow,
} from '@boardsesh/shared-schema';
import { getBackendHttpUrl } from '@/app/lib/backend-url';

export {
  BETA_VIDEO_URL_VALIDATION_MESSAGE,
  isBetaVideoUrl,
  isInstagramUrl,
  isTikTokUrl,
  betaLinkIdentityShared as betaLinkIdentity,
  dedupeBetaLinksShared as dedupeBetaLinks,
};
export type { BetaLink, BetaLinksGqlRow };

/**
 * Beta thumbnails are served by the backend's `/static/beta-link-thumbnails/...`
 * handler, which streams the cached image from S3. The GraphQL resolver
 * persists and returns the path as a backend-relative URL so the same value
 * works in same-origin deploys; in split-domain deploys (web + backend on
 * different hosts, see `getBackendHttpUrl`) we need to prepend the backend
 * origin so the browser actually hits the backend instead of 404-ing
 * against the frontend host.
 */
function withThumbnailSize(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}size=${BETA_THUMBNAIL_REQUEST_SIZE}`;
}

function absolutizeThumbnail(thumbnail: string | null): string | null {
  if (!thumbnail || !thumbnail.startsWith('/')) return thumbnail;
  const backendBase = getBackendHttpUrl();
  // Same-origin deploys keep the backend-relative path; split-domain deploys
  // prepend the backend origin. Either way request a sized variant via
  // `?size=` so the browser fetches a small thumbnail, not the full-res
  // social image.
  // Defensive: getBackendHttpUrl strips a trailing slash today, but normalize
  // here too so a future change to its return shape can't produce
  // `https://host//static/...` which would 404.
  const base = backendBase ? `${backendBase.replace(/\/+$/, '')}${thumbnail}` : thumbnail;
  return withThumbnailSize(base);
}

export function mapBetaLinkRow(row: BetaLinksGqlRow): BetaLink {
  return mapBetaLinkRowShared(row, absolutizeThumbnail);
}

export function mapBetaLinksResponse(rows: BetaLinksGqlRow[]): BetaLink[] {
  return mapBetaLinksResponseShared(rows, absolutizeThumbnail);
}
