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
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: mocks.captureMessage,
}));

vi.mock('@vercel/analytics', () => ({
  track: mocks.vercelTrack,
}));

vi.mock('posthog-js-lite', () => ({
  PostHog: mocks.PostHog,
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

  it('fails loud once when the PostHog key is missing on a production host', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { track } = await import('../analytics');

    track('Climb Opened');
    track('Climb Opened');

    // PostHog never initializes, but Vercel analytics is unaffected by the key.
    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();
    expect(mocks.vercelTrack).toHaveBeenCalledTimes(2);

    // The missing-key alert is emitted exactly once per page load.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
    expect(mocks.captureMessage).toHaveBeenCalledWith(expect.stringContaining('NEXT_PUBLIC_POSTHOG_KEY'), 'error');

    consoleError.mockRestore();
  });

  it('derives the production backend proxy host when no explicit PostHog host is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', '');
    vi.stubEnv('NEXT_PUBLIC_WS_URL', '');
    const { track } = await import('../analytics');

    track('Climb Opened');

    expect(mocks.PostHog).toHaveBeenCalledWith(
      'ph_test_key',
      expect.objectContaining({
        host: 'https://ws.boardsesh.com/api/posthog',
      }),
    );
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('falls back to direct PostHog ingestion when the proxy URL cannot be derived', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', '');
    vi.stubEnv('NEXT_PUBLIC_WS_URL', '');
    setWindowLocation('https://app.boardsesh.com/b/kilter');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { track } = await import('../analytics');

    track('Climb Opened');

    expect(mocks.PostHog).toHaveBeenCalledWith(
      'ph_test_key',
      expect.objectContaining({
        host: 'https://us.i.posthog.com',
      }),
    );
    expect(mocks.posthog.capture).toHaveBeenCalledWith('Climb Opened', undefined);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('PostHog proxy URL could not be derived'));
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('PostHog proxy URL could not be derived'),
      'warning',
    );

    consoleWarn.mockRestore();
  });

  it('does not warn about a missing key outside production hosts', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    setWindowLocation('https://boardsesh-preview.vercel.app/b/kilter');
    const { track } = await import('../analytics');

    track('Preview Event');

    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.PostHog).not.toHaveBeenCalled();
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
});
