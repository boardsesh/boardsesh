import { describe, it, expect } from 'vite-plus/test';
import { resolveHeroInstall } from '../hero-install';

describe('resolveHeroInstall', () => {
  it('renders the App Store install for the pre-detection "unknown" first-paint state', () => {
    // Load-bearing: this is what a crawler / SSR snapshot and the very first
    // client paint see, before the on-mount platform check runs.
    expect(resolveHeroInstall('unknown', 'ios')).toEqual({ mode: 'install', store: 'ios' });
    // nativeStore is irrelevant unless the platform is 'native'.
    expect(resolveHeroInstall('unknown', 'android')).toEqual({ mode: 'install', store: 'ios' });
  });

  it('renders the App Store install for iOS / desktop web', () => {
    expect(resolveHeroInstall('other-web', 'ios')).toEqual({ mode: 'install', store: 'ios' });
  });

  it('renders the Google Play install for Android web', () => {
    expect(resolveHeroInstall('android-web', 'ios')).toEqual({ mode: 'install', store: 'android' });
  });

  it('renders an update CTA for a retired native app, pointed at the store it came from', () => {
    expect(resolveHeroInstall('native', 'ios')).toEqual({ mode: 'update', store: 'ios' });
    expect(resolveHeroInstall('native', 'android')).toEqual({ mode: 'update', store: 'android' });
  });
});
