// Platform classification for the home hero + onboarding install card.
// 'unknown' is the pre-detection state before the on-mount UA/native check runs.
export type InstallPlatform = 'unknown' | 'native' | 'android-web' | 'other-web';

export type HeroInstallStore = 'ios' | 'android';
export type HeroInstall = { mode: 'install' | 'update'; store: HeroInstallStore };

/**
 * Maps the detected platform to the home hero CTA.
 *
 * Web visitors get a store install button; the last stragglers still on the
 * retired Capacitor build (we ship a React Native app now) get an "update"
 * nudge to whichever store they came from. The pre-detection 'unknown' state
 * renders the App Store install so the hero CTA is real and clickable on first
 * paint (this is also what a crawler / SSR snapshot sees) — it corrects to Play
 * Store / update once the platform check runs on mount.
 */
export function resolveHeroInstall(platform: InstallPlatform, nativeStore: HeroInstallStore): HeroInstall {
  switch (platform) {
    case 'android-web':
      return { mode: 'install', store: 'android' };
    case 'native':
      return { mode: 'update', store: nativeStore };
    case 'unknown':
    case 'other-web':
    default:
      return { mode: 'install', store: 'ios' };
  }
}
