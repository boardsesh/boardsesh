import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  PostHog: vi.fn(),
  posthog: {
    alias: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
  },
  vercelTrack: vi.fn(),
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
        persistence: 'memory',
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

  it('attaches previous-pageview properties to $pageview events when provided', async () => {
    const { pageview } = await import('../analytics');

    pageview('/b/kilter', {
      $prev_pageview_pathname: '/',
      $prev_pageview_max_scroll_percentage: 0.42,
    });

    expect(mocks.posthog.capture).toHaveBeenCalledWith('$pageview', {
      $current_url: '/b/kilter',
      $prev_pageview_pathname: '/',
      $prev_pageview_max_scroll_percentage: 0.42,
    });
  });

  it('captures $pageleave with current URL and previous-pageview properties', async () => {
    const { pageleave } = await import('../analytics');

    pageleave('https://boardsesh.com/b/kilter?sort=popular#top', {
      $prev_pageview_pathname: '/b/kilter',
      $prev_pageview_max_scroll: 1200,
      $prev_pageview_max_scroll_percentage: 0.85,
    });

    expect(mocks.posthog.capture).toHaveBeenCalledWith('$pageleave', {
      $current_url: '/b/kilter',
      $prev_pageview_pathname: '/b/kilter',
      $prev_pageview_max_scroll: 1200,
      $prev_pageview_max_scroll_percentage: 0.85,
    });
  });

  it('skips $pageleave on admin URLs', async () => {
    const { pageleave } = await import('../analytics');

    pageleave('/admin/retention', { $prev_pageview_pathname: '/admin/retention' });
    pageleave('/fr/admin/retention', { $prev_pageview_pathname: '/fr/admin/retention' });

    expect(mocks.posthog.capture).not.toHaveBeenCalled();
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

  it('skips all analytics calls on admin pages', async () => {
    setWindowLocation('https://boardsesh.com/admin/retention');
    const { alias, capturePosthog, identify, pageleave, pageview, reset, track } = await import('../analytics');

    track('Admin Event');
    pageview('/admin/retention');
    pageleave('/admin/retention');

    expect(capturePosthog('Admin PostHog Event')).toBe(false);
    expect(identify('profile-1')).toBe(false);
    expect(alias('user-1')).toBe(false);
    expect(reset()).toBe(false);
    expect(mocks.vercelTrack).not.toHaveBeenCalled();
    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();
  });
});
