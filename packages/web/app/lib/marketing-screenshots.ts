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
export type MarketingCapture = { src: string; width: number; height: number };

/**
 * The browser app at app.boardsesh.com/climbs on a Kilter Board at 40°: the climb
 * list beside Blue Jeans (V4), ready to put on the board. A real capture of the
 * whole desktop browser window, tabs and address bar included (the account avatar
 * replaced with the neutral placeholder), landscape at about 1.08:1, with the
 * window's rounded corners transparent. It brings its own frame, so pages draw no
 * border or panel around it. It shows a Kilter wall, so only Kilter surfaces and
 * browser-in-general ones use it.
 */
export const BROWSER_KILTER_CAPTURE: MarketingCapture = {
  src: '/images/app/web/kilter.webp',
  width: 2034,
  height: 1881,
};
type MarketingCaptureSet = Record<MarketingShot, MarketingCapture>;
type LocalizedCaptureSets = { 'en-US': MarketingCaptureSet } & Partial<
  Record<Exclude<Locale, 'en-US'>, MarketingCaptureSet>
>;

/**
 * The workout builder, captured directly from today's Session tab on Android
 * (739 x 1600, like the rest of the Android set). There is no iOS capture of it,
 * so both platforms show this one.
 */
const WORKOUTS_CAPTURE: MarketingCapture = { src: '/images/app/android/workouts.webp', width: 739, height: 1600 };

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
    'spray-wall': capture('spray-wall'),
    workouts: WORKOUTS_CAPTURE,
  };
}

/** Add a locale only when a complete, reviewed native capture set exists. */
const CAPTURES: Record<MarketingPlatform, LocalizedCaptureSets> = {
  ios: { 'en-US': englishCaptures('ios', 736) },
  android: { 'en-US': englishCaptures('android', 739) },
};

export function marketingScreenshot(
  platform: MarketingPlatform,
  locale: Locale,
  shot: MarketingShot,
): MarketingCapture {
  const localizedCaptures = CAPTURES[platform];
  return (localizedCaptures[locale] ?? localizedCaptures['en-US'])[shot];
}
