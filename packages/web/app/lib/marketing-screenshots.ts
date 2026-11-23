import type { Locale } from './i18n/config';
import type { MarketingPlatform } from './marketing-platform';

export type MarketingShot =
  | 'kilter'
  | 'tension'
  | 'moonboard'
  | 'queue'
  | 'wall-status'
  | 'profile'
  | 'spray-wall'
  | 'workouts';
type MarketingCapture = { src: string; width: number; height: number };
type MarketingCaptureSet = Record<MarketingShot, MarketingCapture>;
type LocalizedCaptureSets = { 'en-US': MarketingCaptureSet } & Partial<
  Record<Exclude<Locale, 'en-US'>, MarketingCaptureSet>
>;

/**
 * The workout generator exists only in the Play Store set
 * (`app-stores/google/screenshots/pixel-2/06-workout-generator.png`), so both
 * platforms show the same Android capture: the phone's screen cropped out of
 * that frame at its full resolution, without the store headline.
 */
const WORKOUTS_CAPTURE: MarketingCapture = { src: '/images/app/android/workouts.webp', width: 804, height: 1429 };

function englishCaptures(platform: MarketingPlatform, defaultWidth: number): MarketingCaptureSet {
  const capture = (shot: Exclude<MarketingShot, 'workouts'>, width = defaultWidth): MarketingCapture => ({
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
    'spray-wall': capture('spray-wall', platform === 'android' ? 713 : defaultWidth),
    workouts: WORKOUTS_CAPTURE,
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
