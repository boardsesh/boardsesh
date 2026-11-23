import { isInstagramUrl, isTikTokUrl } from '@/app/lib/beta-video-url';

export type BetaLinkPlatform = {
  /** The name a card prints. Anything that is not TikTok shows as Instagram, the default source. */
  displayPlatform: 'TikTok' | 'Instagram';
  /** What analytics records: an unrecognised URL stays `Unknown` rather than being counted as Instagram. */
  analyticsPlatform: 'TikTok' | 'Instagram' | 'Unknown';
};

/** Where a beta video lives, for the card's label and its click event. */
export function betaLinkPlatform(url: string): BetaLinkPlatform {
  if (isTikTokUrl(url)) return { displayPlatform: 'TikTok', analyticsPlatform: 'TikTok' };
  return { displayPlatform: 'Instagram', analyticsPlatform: isInstagramUrl(url) ? 'Instagram' : 'Unknown' };
}
