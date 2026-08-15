import { describe, it, expect } from 'vite-plus/test';
import { APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties } from '../app-install-event';

describe('buildAppInstallClickProperties', () => {
  // These five objects are the payloads the pre-existing call sites emitted
  // before the builder existed: three in app/home-page-content.tsx and two in
  // app/components/capacitor-retirement/capacitor-retirement-screen.tsx. PH-13
  // breaks the install funnel down by `source`, so a changed key or an extra
  // one here silently splits a number someone reads weekly.
  it('reproduces the home onboarding card payloads byte for byte', () => {
    expect(buildAppInstallClickProperties({ platform: 'android', source: 'google-play' })).toEqual({
      platform: 'android',
      source: 'google-play',
    });
    expect(buildAppInstallClickProperties({ platform: 'ios', source: 'app-store' })).toEqual({
      platform: 'ios',
      source: 'app-store',
    });
  });

  it('reproduces the home hero payload byte for byte', () => {
    expect(
      buildAppInstallClickProperties({
        platform: 'android',
        source: 'google-play',
        placement: 'hero',
        mode: 'update',
      }),
    ).toEqual({ platform: 'android', source: 'google-play', placement: 'hero', mode: 'update' });
  });

  it('reproduces the Capacitor retirement payloads byte for byte', () => {
    expect(buildAppInstallClickProperties({ platform: 'ios', source: 'capacitor-retirement' })).toEqual({
      platform: 'ios',
      source: 'capacitor-retirement',
    });
    expect(buildAppInstallClickProperties({ platform: 'ios', source: 'capacitor-retirement-fallback' })).toEqual({
      platform: 'ios',
      source: 'capacitor-retirement-fallback',
    });
  });

  it('omits optional keys rather than emitting them as undefined', () => {
    const properties = buildAppInstallClickProperties({ platform: 'web', source: 'app-store' });
    expect(Object.keys(properties)).toEqual(['platform', 'source']);
    expect('placement' in properties).toBe(false);
    expect('gymSlug' in properties).toBe(false);
    expect('mode' in properties).toBe(false);
  });

  it('carries the gym-page placement and slug the gym CTA will need', () => {
    expect(
      buildAppInstallClickProperties({
        platform: 'ios',
        source: 'app-store',
        placement: 'gym-page',
        gymSlug: 'boulderwelt',
      }),
    ).toEqual({ platform: 'ios', source: 'app-store', placement: 'gym-page', gymSlug: 'boulderwelt' });
  });

  it('keeps the historic event name', () => {
    expect(APP_INSTALL_CLICK_EVENT).toBe('App Install Click');
  });
});
