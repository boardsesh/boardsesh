import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  PostHog: vi.fn(),
  posthog: {
    alias: vi.fn(),
    capture: vi.fn(),
    flush: vi.fn(async () => {}),
    identify: vi.fn(),
    register: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    setPersonProperties: vi.fn(),
  },
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: mocks.captureMessage,
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

  it('sends track events to PostHog on production hostnames', async () => {
    const { track } = await import('../analytics');
    const properties = { kept: 'yes', count: 2, skipped: undefined };

    track('Climb Opened', properties);

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

  // #3945: web PostHog events carried no `environment` property, so a
  // dashboard filter of `environment = 'production'` silently dropped 100% of
  // web volume. Registering it as a super property at client construction
  // (mirroring mobile's registerAppEnvironment) fixes that.
  it('registers the environment super property on first PostHog client init', async () => {
    const { track } = await import('../analytics');

    track('Climb Opened');

    expect(mocks.posthog.register).toHaveBeenCalledWith({ environment: 'production' });
  });

  it('never registers an environment super property on a preview hostname', async () => {
    setWindowLocation('https://boardsesh-preview.vercel.app/b/kilter');
    const { track } = await import('../analytics');

    track('Preview Event');

    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.register).not.toHaveBeenCalled();
  });

  it('re-registers the environment super property after reset()', async () => {
    const { reset, track } = await import('../analytics');

    // Constructs the client (and registers environment once).
    track('Climb Opened');
    expect(mocks.posthog.register).toHaveBeenCalledTimes(1);

    expect(reset()).toBe(true);

    expect(mocks.posthog.reset).toHaveBeenCalledTimes(1);
    expect(mocks.posthog.register).toHaveBeenCalledTimes(2);
    expect(mocks.posthog.register).toHaveBeenNthCalledWith(2, { environment: 'production' });
  });

  it('does not throw or block capture when register() rejects', async () => {
    mocks.posthog.register.mockRejectedValueOnce(new Error('storage unavailable'));
    const { track } = await import('../analytics');

    expect(() => track('Climb Opened')).not.toThrow();
    // The rejection is asynchronous; flush microtasks so the swallowed
    // rejection is observed before the test ends.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.posthog.capture).toHaveBeenCalledWith('Climb Opened', undefined);
  });

  it('does not throw or block capture when register() throws synchronously', async () => {
    // register() is `async` in @posthog/core 1.46.1 so it can only reject
    // today, but analytics init must survive an SDK that makes it sync.
    mocks.posthog.register.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    const { track } = await import('../analytics');

    expect(() => track('Climb Opened')).not.toThrow();

    expect(mocks.posthog.capture).toHaveBeenCalledWith('Climb Opened', undefined);
  });

  it('fails loud once when the PostHog key is missing on a production host', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { track } = await import('../analytics');

    track('Climb Opened');
    track('Climb Opened');

    // PostHog never initializes, so both events are dropped on the floor.
    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();

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
    // Every host in the production allowlist (boardsesh.com, www.boardsesh.com)
    // is resolvable by backend-url.ts's deriveWsUrlFromHost, so "production
    // host + no derivable proxy" isn't reachable via a real hostname anymore
    // (it was previously only reachable through app.boardsesh.com, which the
    // old substring-matching gate wrongly treated as production — see #3814).
    // Mock the resolver directly to exercise analytics.ts's own defensive
    // fallback/warning in isolation from backend-url.ts's host table.
    vi.doMock('../backend-url', () => ({ getBackendHttpUrl: () => null }));
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
    vi.doUnmock('../backend-url');
  });

  it('does not warn about a missing key outside production hosts', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    setWindowLocation('https://boardsesh-preview.vercel.app/b/kilter');
    const { track } = await import('../analytics');

    track('Preview Event');

    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.PostHog).not.toHaveBeenCalled();
  });

  it('sends nothing at all from a preview hostname', async () => {
    setWindowLocation('https://boardsesh-preview.vercel.app/b/kilter');
    const { track } = await import('../analytics');

    track('Preview Event');

    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();
  });

  it('regression #3814: does not leak PR-preview sessions into prod PostHog', async () => {
    // <pr>.preview.boardsesh.com (branch-deploy.yml) CONTAINS "boardsesh.com"
    // as a substring — the exact host that leaked into prod PostHog under the
    // old `.includes('boardsesh.com')` gate.
    setWindowLocation('https://123.preview.boardsesh.com/b/kilter');
    const { track } = await import('../analytics');

    track('Preview Event');

    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();
  });

  it('flushes an event that is about to lose its document, and waits for the flush', async () => {
    // posthog-js-lite batches at 20 events / 10s and has no pagehide or
    // sendBeacon transport, so a fire-and-forget capture in the click handler of
    // a cross-origin link never leaves the browser. `trackBeforeNavigation` is
    // what the front-door CTA uses instead; if this stops awaiting the flush,
    // `Climb Handoff Clicked` goes dark and the hand-off funnel reads as broken.
    let flushed = false;
    mocks.posthog.flush.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          // A macrotask, deliberately. A microtask here would run during ANY
          // `await` in this test, so a fire-and-forget flush would still see
          // `flushed === true` and the await-the-flush property would go
          // unpinned. A timer callback only runs before the assertion if
          // `trackBeforeNavigation` genuinely awaits the flush promise.
          setTimeout(() => {
            flushed = true;
            resolve();
          }, 0);
        }),
    );
    const { trackBeforeNavigation } = await import('../analytics');

    await trackBeforeNavigation('Climb Handoff Clicked', { environment: 'production-web' });

    expect(mocks.posthog.capture).toHaveBeenCalledWith('Climb Handoff Clicked', {
      environment: 'production-web',
    });
    expect(mocks.posthog.flush).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(true);
  });

  it('does not strand the reader when the flush rejects', async () => {
    mocks.posthog.flush.mockRejectedValueOnce(new Error('blocked by an extension'));
    const { trackBeforeNavigation } = await import('../analytics');

    await expect(trackBeforeNavigation('Climb Handoff Clicked')).resolves.toBeUndefined();
  });

  it('captures events that bypass track(), like $web_vitals', async () => {
    const { capturePosthog } = await import('../analytics');

    expect(capturePosthog('$web_vitals', { metric: 'LCP', value: 123, rating: 'good' })).toBe(true);

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
    expect(mocks.PostHog).not.toHaveBeenCalled();
    expect(mocks.posthog.capture).not.toHaveBeenCalled();
  });
});
