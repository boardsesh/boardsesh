import type { Locale } from '@/app/lib/i18n/config';
import type { HeroInstallStore } from '@/app/lib/hero-install';

/**
 * The official App Store and Google Play badges, one per shipping locale, as
 * the stores publish them. The files live in `public/images/store-badges/` and
 * are never edited: "Store badges" in docs/web/public-page-design.md says where
 * each came from and the rules both stores set (no recolouring, no cropping,
 * 40px minimum on screen for the App Store, Google Play never smaller than the
 * App Store badge beside it).
 */

/**
 * Apple ships a black badge and a white one. Its guidelines allow the white
 * badge only when it is the one store badge on the layout; next to Google Play
 * (which is black only) it must be black.
 */
export type AppStoreBadgeTone = 'black' | 'white';

/**
 * Width over height of each badge's viewBox. Apple's artwork is 40 units tall
 * and its width follows the localized wording; every Google Play badge shares
 * one 238.96 × 70.87 box. Stored so the `<img>` carries its real width and
 * height in the HTML and the row never shifts while the SVG loads.
 */
const APP_STORE_ASPECT: Record<Locale, number> = {
  'en-US': 119.66407 / 40,
  es: 119.66407 / 40,
  fr: 126.50751 / 40,
  de: 119.66407 / 40,
  it: 119.66407 / 40,
  'zh-CN': 108.85157 / 40,
};
const GOOGLE_PLAY_ASPECT = 238.96 / 70.87;

export type StoreBadgeImage = {
  src: string;
  width: number;
  height: number;
};

/**
 * The badge for one store in the page's language, `height` px tall.
 * `tone` only applies to the App Store badge; Google Play has one.
 */
export function storeBadgeImage(
  store: HeroInstallStore,
  locale: Locale,
  height: number,
  tone: AppStoreBadgeTone = 'black',
): StoreBadgeImage {
  if (store === 'ios') {
    return {
      src: `/images/store-badges/app-store-${tone}-${locale}.svg`,
      width: Math.round(height * APP_STORE_ASPECT[locale]),
      height,
    };
  }
  return {
    src: `/images/store-badges/google-play-${locale}.svg`,
    width: Math.round(height * GOOGLE_PLAY_ASPECT),
    height,
  };
}
