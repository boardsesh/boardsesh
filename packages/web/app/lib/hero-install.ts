// Platform classification for the home hero + onboarding install card.
// 'unknown' is the pre-detection state before the on-mount UA/native check runs.
//
// 'desktop-web' is separate from 'other-web' on purpose. A desktop visitor has
// no phone OS for us to infer, so offering them one store is a coin flip — they
// get both. 'other-web' now means a NON-Android mobile browser (iOS Safari and
// friends), where the phone in their hand is the answer.
export type InstallPlatform = 'unknown' | 'native' | 'android-web' | 'other-web' | 'desktop-web';

export type HeroInstallStore = 'ios' | 'android';
/**
 * `stores` is ordered: the first entry is the primary CTA. It holds both stores
 * only on desktop; every other platform resolves to exactly one.
 */
export type HeroInstall = { mode: 'install' | 'update'; stores: HeroInstallStore[] };

// Maps the detected platform to the home hero CTA. 'unknown' (pre-detection
// first paint, also what a crawler / SSR snapshot sees) gets the App Store, so
// the server-rendered HTML carries a real install link. Android web gets Play;
// a retired native straggler (we ship a React Native app now) gets an "update"
// nudge to the store it came from. No `default` case — a new InstallPlatform
// member should fail the typecheck here until it's handled explicitly.
export function resolveHeroInstall(platform: InstallPlatform, nativeStore: HeroInstallStore): HeroInstall {
  switch (platform) {
    case 'android-web':
      return { mode: 'install', stores: ['android'] };
    case 'desktop-web':
      // iOS first: it is the larger store and the first button reads as primary.
      return { mode: 'install', stores: ['ios', 'android'] };
    case 'native':
      return { mode: 'update', stores: [nativeStore] };
    case 'unknown':
    case 'other-web':
      return { mode: 'install', stores: ['ios'] };
  }
}
