import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  PostHog: vi.fn(),
  posthog: {
    alias: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    setPersonProperties: vi.fn(),
  },
  vercelTrack: vi.fn(),
  hasAnalyticsConsent: vi.fn(() => true),
}));

vi.mock('@vercel/analytics', () => ({
  track: mocks.vercelTrack,
}));

vi.mock('posthog-js-lite', () => ({
  PostHog: mocks.PostHog,
}));

vi.mock('../consent', () => ({
  hasAnalyticsConsent: mocks.hasAnalyticsConsent,
}));

const originalLocation = window.location;

function setWindowLocation(url: string): void {
  Object.defineProperty(window, 'location', {
    value: new URL(url),
    writable: true,
    configurable: true,
  });
}

describe('analytics wrapper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'ph_test_key');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://posthog.example');
    vi.stubEnv('NEXT_PUBLIC_ANALYTICS_DEBUG', '');
    vi.stubEnv('NODE_ENV', 'production');
    mocks.PostHog.mockImplementation(function MockPostHog() {
      return mocks.posthog;
    });
    // Default to "consent granted" so the existing tests exercise the
    // happy path. Tests that need a denied state override per-case.
    mocks.hasAnalyticsConsent.mockReturnValue(true);
    setWindowLocation('https://boardsesh.com/b/kilter');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('dual-writes track events to Vercel and PostHog on production hostnames', async () => {
    const { track } = await import('../analytics');
    const properties = { kept: 'yes', count: 2, skipped: undefined };

    track('Climb Opened', properties);

    expect(mocks.vercelTrack).toHaveBeenCalledWith('Climb Opened', properties, undefined);
    expect(mocks.PostHog).toHaveBeenCalledWith(
      'ph_test_key',
      expect.objectContaining({
        autocapture: false,
        captureHistoryEvents: false,
        host: 'https://posthog.example',
        persistence: 'localStorage',
      }),
    );
    expect(mocks.posthog.capture).toHaveBeenCalledWith('Climb Opened', { kept: 'yes', count: 2 });
  });

  it('keeps Vercel tracking in previews while PostHog remains production-gated', async () => {
    setWindowLocation('https://boardsesh-preview.vercel.app/b/kilter');
    const { track } = await import('../analytics');

    track('Preview Event');

    expect(mocks.vercelTrack).toHaveBeenCalledWith('Preview Event', undefined, undefined);
    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();
  });

  it('captures PostHog-only events without Vercel fan-out', async () => {
    const { capturePosthog } = await import('../analytics');

    expect(capturePosthog('$web_vitals', { metric: 'LCP', value: 123, rating: 'good' })).toBe(true);

    expect(mocks.vercelTrack).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).toHaveBeenCalledWith('$web_vitals', {
      metric: 'LCP',
      value: 123,
      rating: 'good',
    });
  });

  it('sends path-only PostHog pageviews and skips admin URLs', async () => {
    const { pageview } = await import('../analytics');

    pageview('https://boardsesh.com/b/kilter?sort=popular#top');
    pageview('/fr/admin/retention?range=30');

    expect(mocks.posthog.capture).toHaveBeenCalledTimes(1);
    expect(mocks.posthog.capture).toHaveBeenCalledWith('$pageview', { $current_url: '/b/kilter' });
  });

  it('identifies, aliases, and resets through PostHog', async () => {
    const { alias, identify, reset } = await import('../analytics');

    expect(identify('profile-1', { email: 'one@example.com' })).toBe(true);
    expect(alias('user-1')).toBe(true);
    expect(reset()).toBe(true);

    expect(mocks.posthog.identify).toHaveBeenCalledWith('profile-1', { email: 'one@example.com' });
    expect(mocks.posthog.alias).toHaveBeenCalledWith('user-1');
    expect(mocks.posthog.reset).toHaveBeenCalledTimes(1);
  });

  it('forwards set and setOnce person properties to PostHog', async () => {
    const { setPersonProperties } = await import('../analytics');

    expect(setPersonProperties({ language: 'es' })).toBe(true);
    expect(setPersonProperties(undefined, { signup_at: '2026-05-11T00:00:00.000Z' })).toBe(true);

    expect(mocks.posthog.setPersonProperties).toHaveBeenNthCalledWith(1, { language: 'es' }, undefined);
    expect(mocks.posthog.setPersonProperties).toHaveBeenNthCalledWith(2, undefined, {
      signup_at: '2026-05-11T00:00:00.000Z',
    });
  });

  it('skips setPersonProperties on admin pages and outside production', async () => {
    setWindowLocation('https://boardsesh.com/admin/retention');
    const { setPersonProperties: adminSet } = await import('../analytics');
    expect(adminSet({ language: 'es' })).toBe(false);
    expect(mocks.posthog.setPersonProperties).not.toHaveBeenCalled();

    vi.resetModules();
    setWindowLocation('https://boardsesh-preview.vercel.app/b/kilter');
    const { setPersonProperties: previewSet } = await import('../analytics');
    expect(previewSet({ language: 'es' })).toBe(false);
    expect(mocks.posthog.setPersonProperties).not.toHaveBeenCalled();
  });

  it('skips all analytics calls on admin pages', async () => {
    setWindowLocation('https://boardsesh.com/admin/retention');
    const { alias, capturePosthog, identify, pageview, reset, track } = await import('../analytics');

    track('Admin Event');
    pageview('/admin/retention');

    expect(capturePosthog('Admin PostHog Event')).toBe(false);
    expect(identify('profile-1')).toBe(false);
    expect(alias('user-1')).toBe(false);
    expect(reset()).toBe(false);
    expect(mocks.vercelTrack).not.toHaveBeenCalled();
    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();
  });

  describe('consent gate', () => {
    it('skips track() — both Vercel and PostHog — when analytics consent is denied', async () => {
      mocks.hasAnalyticsConsent.mockReturnValue(false);
      const { track } = await import('../analytics');

      track('Climb Opened', { kept: 'yes' });

      expect(mocks.vercelTrack).not.toHaveBeenCalled();
      expect(mocks.PostHog).not.toHaveBeenCalled();
      expect(mocks.posthog.capture).not.toHaveBeenCalled();
    });

    it('skips capturePosthog when consent is denied', async () => {
      mocks.hasAnalyticsConsent.mockReturnValue(false);
      const { capturePosthog } = await import('../analytics');

      expect(capturePosthog('$web_vitals', { metric: 'LCP' })).toBe(false);
      expect(mocks.PostHog).not.toHaveBeenCalled();
    });

    it('skips identify when consent is denied', async () => {
      mocks.hasAnalyticsConsent.mockReturnValue(false);
      const { identify } = await import('../analytics');

      expect(identify('profile-1')).toBe(false);
      expect(mocks.posthog.identify).not.toHaveBeenCalled();
    });

    it('lets a later opt-in initialize PostHog after an earlier denied call', async () => {
      // First call: consent denied → no init.
      mocks.hasAnalyticsConsent.mockReturnValue(false);
      const { track } = await import('../analytics');
      track('Denied Event');
      expect(mocks.PostHog).not.toHaveBeenCalled();
      expect(mocks.vercelTrack).not.toHaveBeenCalled();

      // Now consent flips to granted; PostHog must lazily construct on the
      // next track() call rather than staying pinned to "no client".
      mocks.hasAnalyticsConsent.mockReturnValue(true);
      track('Granted Event', { value: 1 });

      expect(mocks.vercelTrack).toHaveBeenCalledWith('Granted Event', { value: 1 }, undefined);
      expect(mocks.PostHog).toHaveBeenCalledTimes(1);
      expect(mocks.posthog.capture).toHaveBeenCalledWith('Granted Event', { value: 1 });
    });

    it('initAnalytics warms up PostHog when consent is granted', async () => {
      const { initAnalytics } = await import('../analytics');

      initAnalytics();

      expect(mocks.PostHog).toHaveBeenCalledTimes(1);
    });

    it('initAnalytics is a no-op when consent is denied', async () => {
      mocks.hasAnalyticsConsent.mockReturnValue(false);
      const { initAnalytics } = await import('../analytics');

      initAnalytics();

      expect(mocks.PostHog).not.toHaveBeenCalled();
    });
  });
});
