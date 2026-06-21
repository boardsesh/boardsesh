/**
 * Beta-video URL helpers — Instagram and TikTok.
 *
 * Shared across backend resolvers/validation and the web app so we have a
 * single definition of which URLs we accept and how we extract identifiers.
 */

export const INSTAGRAM_URL_REGEX =
  /^https:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|tv)\/([\w-]+)\/?(?:[?#].*)?$/i;

export const TIKTOK_URL_REGEX = /^https:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\//i;

const TIKTOK_LONG_FORM_VIDEO_ID = /^https:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\/@[\w.-]+\/video\/(\d+)/i;

/**
 * Combined accept regex for the attach mutation + tick `videoUrl` validation.
 * The two source patterns are anchored, so the alternation stays anchored.
 */
export const BETA_VIDEO_URL_REGEX = new RegExp(`(?:${INSTAGRAM_URL_REGEX.source})|(?:${TIKTOK_URL_REGEX.source})`, 'i');

export const BETA_VIDEO_URL_VALIDATION_MESSAGE = 'Needs to be an Instagram or TikTok URL';

export function isInstagramUrl(url: string): boolean {
  return INSTAGRAM_URL_REGEX.test(url);
}

export function isTikTokUrl(url: string): boolean {
  return TIKTOK_URL_REGEX.test(url);
}

export function isBetaVideoUrl(url: string): boolean {
  return isInstagramUrl(url) || isTikTokUrl(url);
}

export function getInstagramMediaId(url: string): string | null {
  const match = url.match(INSTAGRAM_URL_REGEX);
  return match?.[1] ?? null;
}

/**
 * Canonical storage/display form for a beta-video URL. Strips the query string
 * and fragment from Instagram URLs so the `?igsh=...` share-attribution param
 * doesn't trigger Instagram's "X shared this reel, follow them?" interstitial.
 * Non-Instagram URLs (TikTok et al.) are returned unchanged. Idempotent.
 */
export function normalizeBetaVideoUrl(url: string): string {
  if (!isInstagramUrl(url)) return url;
  return url.replace(/[?#].*$/, '');
}

/**
 * Numeric video id for long-form `/@user/video/<id>` TikTok URLs. Short links
 * (`vm.tiktok.com/<short>`, `t.tiktok.com/<short>`) return null — we don't
 * unfold them.
 */
export function getTikTokVideoId(url: string): string | null {
  const match = url.match(TIKTOK_LONG_FORM_VIDEO_ID);
  return match?.[1] ?? null;
}

/**
 * Canonical shape used by web and mobile after mapping a GraphQL response.
 * Snake-case is preserved for backwards compatibility with existing call sites
 * — Aurora's sync API uses these names and a lot of UI code already destructures
 * them.
 */
export type BetaLink = {
  climb_uuid: string;
  link: string;
  foreign_username: string | null;
  angle: number | null;
  thumbnail: string | null;
  is_listed: boolean;
  created_at: string;
  tick_uuid: string | null;
  board_id: number | null;
};

/**
 * Raw row shape returned by the `betaLinks` GraphQL query (camelCase).
 */
export type BetaLinksGqlRow = {
  climbUuid: string;
  link: string;
  foreignUsername: string | null;
  angle: number | null;
  thumbnail: string | null;
  isListed: boolean | null;
  createdAt: string | null;
  tickUuid: string | null;
  boardId: number | null;
};

/**
 * Stable identity used to dedupe beta links that point at the same video,
 * even when their URLs differ in tracking params or host. Prefer the platform
 * media id; fall back to the raw URL for unrecognised hosts.
 */
export function betaLinkIdentity(url: string): string {
  const instagramId = getInstagramMediaId(url);
  if (instagramId) return `instagram:${instagramId}`;
  const tiktokId = getTikTokVideoId(url);
  if (tiktokId) return `tiktok:${tiktokId}`;
  return `raw:${url}`;
}

export function dedupeBetaLinks(betaLinks: BetaLink[]): BetaLink[] {
  const dedupedLinks: BetaLink[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const betaLink of betaLinks) {
    const identity = betaLinkIdentity(betaLink.link);
    const existingIndex = indexByIdentity.get(identity);

    if (existingIndex === undefined) {
      indexByIdentity.set(identity, dedupedLinks.length);
      dedupedLinks.push(betaLink);
      continue;
    }

    const existing = dedupedLinks[existingIndex];
    dedupedLinks[existingIndex] = {
      ...existing,
      foreign_username: existing.foreign_username ?? betaLink.foreign_username,
      angle: existing.angle ?? betaLink.angle,
      thumbnail: existing.thumbnail ?? betaLink.thumbnail,
      created_at: existing.created_at || betaLink.created_at,
      tick_uuid: existing.tick_uuid ?? betaLink.tick_uuid,
      board_id: existing.board_id ?? betaLink.board_id,
    };
  }

  return dedupedLinks;
}

type ThumbnailResolver = (thumbnail: string | null) => string | null;
const identityThumbnail: ThumbnailResolver = (thumbnail) => thumbnail;

export function mapBetaLinkRow(
  row: BetaLinksGqlRow,
  absolutizeThumbnail: ThumbnailResolver = identityThumbnail,
): BetaLink {
  return {
    climb_uuid: row.climbUuid,
    link: row.link,
    foreign_username: row.foreignUsername,
    angle: row.angle,
    thumbnail: absolutizeThumbnail(row.thumbnail),
    is_listed: row.isListed ?? false,
    created_at: row.createdAt ?? '',
    tick_uuid: row.tickUuid,
    board_id: row.boardId,
  };
}

export function mapBetaLinksResponse(rows: BetaLinksGqlRow[], absolutizeThumbnail?: ThumbnailResolver): BetaLink[] {
  return rows.map((row) => mapBetaLinkRow(row, absolutizeThumbnail));
}
