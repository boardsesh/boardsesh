// Platform classification for the home hero + onboarding install card.
// 'unknown' is the pre-detection state before the on-mount UA/native check runs.
export type InstallPlatform = 'unknown' | 'native' | 'android-web' | 'other-web';

export type HeroInstallStore = 'ios' | 'android';
export type HeroInstall = { mode: 'install' | 'update'; store: HeroInstallStore };

// Maps the detected platform to the home hero CTA. 'unknown' (pre-detection
// first paint, also what a crawler / SSR snapshot sees) and 'other-web' both
// get the App Store install; Android web gets Play; a retired native straggler
// (we ship a React Native app now) gets an "update" nudge to the store it came
// from. No `default` case — a new InstallPlatform member should fail the
// typecheck here until it's handled explicitly.
export function resolveHeroInstall(platform: InstallPlatform, nativeStore: HeroInstallStore): HeroInstall {
  switch (platform) {
    case 'android-web':
      return { mode: 'install', store: 'android' };
    case 'native':
      return { mode: 'update', store: nativeStore };
    case 'unknown':
    case 'other-web':
      return { mode: 'install', store: 'ios' };
  }
}
