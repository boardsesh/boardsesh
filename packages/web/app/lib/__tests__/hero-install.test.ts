import { describe, it, expect } from 'vite-plus/test';
import { resolveHeroInstall } from '../hero-install';

describe('resolveHeroInstall', () => {
  it('renders the App Store install for the pre-detection "unknown" first-paint state', () => {
    // Load-bearing: this is what a crawler / SSR snapshot and the very first
    // client paint see, before the on-mount platform check runs. One store, so
    // the server-rendered HTML carries a real install link rather than two.
    expect(resolveHeroInstall('unknown', 'ios')).toEqual({ mode: 'install', stores: ['ios'] });
    // nativeStore is irrelevant unless the platform is 'native'.
    expect(resolveHeroInstall('unknown', 'android')).toEqual({ mode: 'install', stores: ['ios'] });
  });

  it('renders the App Store install for a non-Android mobile browser', () => {
    expect(resolveHeroInstall('other-web', 'ios')).toEqual({ mode: 'install', stores: ['ios'] });
  });

  it('renders the Google Play install for Android web', () => {
    expect(resolveHeroInstall('android-web', 'ios')).toEqual({ mode: 'install', stores: ['android'] });
  });

  // A desktop visitor has no phone OS to infer, so picking one store is a coin
  // flip that sends half of them to a store they cannot install from.
  it('offers BOTH stores on desktop, App Store first', () => {
    expect(resolveHeroInstall('desktop-web', 'ios')).toEqual({ mode: 'install', stores: ['ios', 'android'] });
    // nativeStore must not leak into the desktop ordering.
    expect(resolveHeroInstall('desktop-web', 'android')).toEqual({ mode: 'install', stores: ['ios', 'android'] });
  });

  it('renders an update CTA for a retired native app, pointed at the store it came from', () => {
    expect(resolveHeroInstall('native', 'ios')).toEqual({ mode: 'update', stores: ['ios'] });
    expect(resolveHeroInstall('native', 'android')).toEqual({ mode: 'update', stores: ['android'] });
  });

  it('never offers two stores anywhere but desktop', () => {
    for (const platform of ['unknown', 'native', 'android-web', 'other-web'] as const) {
      expect(resolveHeroInstall(platform, 'ios').stores).toHaveLength(1);
    }
  });
});
