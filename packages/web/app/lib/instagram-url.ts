import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';

export const INSTAGRAM_URL_REGEX = /^https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|tv)\/([\w-]+)(?:[/?#]|$)/i;

export function isInstagramUrl(url: string): boolean {
  return INSTAGRAM_URL_REGEX.test(url);
}

export function getInstagramMediaId(url: string): string | null {
  const match = url.match(INSTAGRAM_URL_REGEX);
  return match?.[1] ?? null;
}

export function getInstagramEmbedUrl(url: string): string | null {
  const mediaId = getInstagramMediaId(url);
  if (mediaId) {
    return `https://www.instagram.com/p/${mediaId}/embed`;
  }
  return null;
}

export function dedupeBetaLinks(betaLinks: BetaLink[]): BetaLink[] {
  const dedupedLinks: BetaLink[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const betaLink of betaLinks) {
    const mediaId = getInstagramMediaId(betaLink.link);
    const identity = mediaId ? `instagram:${mediaId}` : `raw:${betaLink.link}`;
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
    };
  }

  return dedupedLinks;
}
