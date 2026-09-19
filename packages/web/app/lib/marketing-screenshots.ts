import type { Locale } from './i18n/config';
import type { MarketingPlatform } from './marketing-platform';

export type MarketingShot = 'kilter' | 'tension' | 'moonboard' | 'queue' | 'wall-status' | 'profile';
type MarketingCapture = { src: string; width: number; height: number };
type MarketingCaptureSet = Record<MarketingShot, MarketingCapture>;
type LocalizedCaptureSets = { 'en-US': MarketingCaptureSet } & Partial<
  Record<Exclude<Locale, 'en-US'>, MarketingCaptureSet>
>;

function englishCaptures(platform: MarketingPlatform, width: number): MarketingCaptureSet {
  const capture = (shot: MarketingShot): MarketingCapture => ({
    src: `/images/app/${platform}/${shot === 'profile' ? 'profile-overview' : shot}.webp`,
    width,
    height: 1600,
  });
  return {
    kilter: capture('kilter'),
    tension: capture('tension'),
    moonboard: capture('moonboard'),
    queue: capture('queue'),
    'wall-status': capture('wall-status'),
    profile: capture('profile'),
  };
}

/** Add a locale only when a complete, reviewed native capture set exists. */
const CAPTURES: Record<MarketingPlatform, LocalizedCaptureSets> = {
  ios: { 'en-US': englishCaptures('ios', 736) },
  android: { 'en-US': englishCaptures('android', 900) },
};

export function marketingScreenshot(
  platform: MarketingPlatform,
  locale: Locale,
  shot: MarketingShot,
): MarketingCapture {
  const localizedCaptures = CAPTURES[platform];
  return (localizedCaptures[locale] ?? localizedCaptures['en-US'])[shot];
}
