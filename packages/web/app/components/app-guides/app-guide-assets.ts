import 'server-only';

import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardGalleryLayouts } from '@/app/boards/board-gallery';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { BROWSER_KILTER_CAPTURE, marketingScreenshot, type MarketingShot } from '@/app/lib/marketing-screenshots';
import type { GuideShot } from '@/app/lib/seo/app-guides';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';

export type GuideImage = { src: string; width: number; height: number };

/** Real captures that live with the help pages rather than in the store set. */
const HELP_CAPTURES: Record<Exclude<GuideShot, MarketingShot>, GuideImage> = {
  logbook: { src: '/images/help/logbook.webp', width: 736, height: 1600 },
  'live-sessions': { src: '/images/help/live-sessions.webp', width: 736, height: 1600 },
  // A real home spray wall, photographed: what "Photograph the wall" starts from.
  'spray-photo': { src: '/images/help/spray-wall-photo.webp', width: 1752, height: 2047 },
};

function resolved(image: GuideImage): GuideImage {
  return { ...image, src: resolveStaticAssetUrl(image.src) };
}

/** A real Boardsesh capture. iPhone by default; the Android set for the platform comparison. */
export function guideShot(shot: GuideShot, platform: 'ios' | 'android' = 'ios'): GuideImage {
  if (shot === 'logbook' || shot === 'live-sessions' || shot === 'spray-photo') return resolved(HELP_CAPTURES[shot]);
  return resolved(marketingScreenshot(platform, DEFAULT_LOCALE, shot));
}

/** The board as Boardsesh draws it: the first layout in the board gallery. */
export function boardDrawing(boardType: Exclude<BoardName, 'spray'>): GuideImage & { caption: string } {
  const layout = getBoardGalleryLayouts(boardType)[0];
  if (!layout) throw new Error(`Missing board gallery art for ${boardType}`);
  return {
    src: resolveStaticAssetUrl(layout.src),
    width: layout.width,
    height: layout.height,
    caption: layout.caption,
  };
}

/** The browser app on a Kilter wall (landscape, about 1.19:1). */
export function browserCapture(): GuideImage {
  return resolved(BROWSER_KILTER_CAPTURE);
}

/** A real home spray wall, photographed for the spray wall guide. */
export function sprayWallPhoto(): GuideImage {
  return resolved({ src: '/images/help/spray-wall-photo.webp', width: 1752, height: 2047 });
}

/** The brand mark the site header draws, from the same shell asset. */
export function boardseshMark(): GuideImage {
  return { src: resolveShellStaticAssetUrl('/brand/boardsesh-mark.webp'), width: 1024, height: 1024 };
}
