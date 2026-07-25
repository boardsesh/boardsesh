import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const posthogMocks = vi.hoisted(() => ({
  PostHog: vi.fn(),
  capture: vi.fn(),
  on: vi.fn(),
  shutdown: vi.fn(),
}));
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('posthog-node', () => ({
  PostHog: posthogMocks.PostHog,
}));

vi.mock('../utils/logger', () => ({
  logger: loggerMock,
}));

async function loadPosthogModule(): Promise<typeof import('../services/analytics/posthog')> {
  vi.resetModules();
  return import('../services/analytics/posthog');
}

describe('backend PostHog analytics helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    posthogMocks.PostHog.mockImplementation(function MockPostHog() {
      return {
        capture: posthogMocks.capture,
        on: posthogMocks.on,
        shutdown: posthogMocks.shutdown,
      };
    });
    // vi.clearAllMocks() clears call history but NOT a custom
    // .mockImplementation() — "logs and returns false when capture throws"
    // below sets one that throws, which otherwise leaks into every later test
    // in this file (masked before #3814 because no test after it in file order
    // exercised a successful capture; the new environment-gate tests do).
    posthogMocks.capture.mockImplementation(() => undefined);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('does not initialize or capture without a PostHog project key', async () => {
    const { captureBackendEvent } = await loadPosthogModule();

    const captured = captureBackendEvent('Live Activity Started', {
      distinctId: 'user-1',
      properties: { sessionId: 'session-1' },
    });

    expect(captured).toBe(false);
    expect(posthogMocks.PostHog).not.toHaveBeenCalled();
    expect(posthogMocks.capture).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[PostHog] POSTHOG_PROJECT_KEY/NEXT_PUBLIC_POSTHOG_KEY is not set; backend analytics disabled',
    );
  });

  it('captures sanitized events with backend metadata', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('POSTHOG_HOST', 'https://posthog.example');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    const { captureBackendEvent } = await loadPosthogModule();

    const captured = captureBackendEvent('Live Activity Widget Navigation', {
      distinctId: 'user-1',
      properties: {
        sessionId: 'session-1',
        outcome: 'success',
        targetIndex: 2,
        dropped: undefined,
      },
    });

    expect(captured).toBe(true);
    expect(posthogMocks.PostHog).toHaveBeenCalledWith('ph_project', {
      host: 'https://posthog.example',
      flushAt: 20,
      flushInterval: 10_000,
      disableGeoip: true,
    });
    expect(posthogMocks.capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'Live Activity Widget Navigation',
      properties: {
        sessionId: 'session-1',
        outcome: 'success',
        targetIndex: 2,
        service: 'boardsesh-backend',
        environment: 'production',
      },
    });
    expect(loggerMock.info).toHaveBeenCalledWith(
      '[PostHog] Backend analytics initialized (host=https://posthog.example, environment=production)',
    );
    expect(loggerMock.info).toHaveBeenCalledWith(
      '[PostHog] Queued backend analytics event: Live Activity Widget Navigation',
    );
  });

  it('can initialize if the project key appears after an earlier no-op capture', async () => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    const { captureBackendEvent } = await loadPosthogModule();

    expect(captureBackendEvent('Live Activity Started', { distinctId: 'user-1' })).toBe(false);

    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    expect(captureBackendEvent('Live Activity Started', { distinctId: 'user-1' })).toBe(true);
    expect(posthogMocks.PostHog).toHaveBeenCalledOnce();
  });

  it('can use NEXT_PUBLIC_POSTHOG_KEY when the backend-specific key is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'ph_public_project');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    const { captureBackendEvent } = await loadPosthogModule();

    expect(captureBackendEvent('Live Activity Started', { distinctId: 'user-1' })).toBe(true);

    expect(posthogMocks.PostHog).toHaveBeenCalledWith(
      'ph_public_project',
      expect.objectContaining({
        host: 'https://us.i.posthog.com',
      }),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[PostHog] Using NEXT_PUBLIC_POSTHOG_KEY for backend analytics; prefer POSTHOG_PROJECT_KEY',
    );
  });

  it('can disable PostHog person profiles for aggregate events', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    const { captureBackendEvent } = await loadPosthogModule();

    captureBackendEvent('Live Activity Push Delivery', {
      distinctId: 'live-activity-session:session-1',
      processPersonProfile: false,
      properties: { sentCount: 1 },
    });

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          sentCount: 1,
          $process_person_profile: false,
        }),
      }),
    );
  });

  it('logs and returns false when capture throws', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    posthogMocks.capture.mockImplementation(() => {
      throw new Error('capture exploded');
    });
    const { captureBackendEvent } = await loadPosthogModule();

    const captured = captureBackendEvent('Live Activity Started', {
      distinctId: 'user-1',
    });

    expect(captured).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith('[PostHog] Capture failed:', expect.any(Error));
  });

  it('flushes the client on shutdown', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    const { captureBackendEvent, shutdownPosthog } = await loadPosthogModule();
    captureBackendEvent('Live Activity Started', { distinctId: 'user-1' });

    await shutdownPosthog();

    expect(posthogMocks.shutdown).toHaveBeenCalledOnce();
  });

  // #3814: without this gate, a key present in ANY non-production runtime (a
  // Railway shared variable, a local .env, a future staging service) would
  // silently send to the prod PostHog project — the same class of bug #3808
  // fixed for Sentry. The environment check must win even when a key is present.
  it('does not initialize or capture when the resolved environment is not production, even with a key present', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'preview');
    const { captureBackendEvent } = await loadPosthogModule();

    const captured = captureBackendEvent('Live Activity Started', {
      distinctId: 'user-1',
      properties: { sessionId: 'session-1' },
    });

    expect(captured).toBe(false);
    expect(posthogMocks.PostHog).not.toHaveBeenCalled();
    expect(posthogMocks.capture).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      "[PostHog] Resolved environment 'preview' is not production; backend analytics disabled",
    );
  });

  it('opts out via SENTRY_ENVIRONMENT when POSTHOG_ENVIRONMENT is unset (preview/staging backends set only SENTRY_ENVIRONMENT per #3808)', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('SENTRY_ENVIRONMENT', 'preview');
    vi.stubEnv('NODE_ENV', 'production');
    const { captureBackendEvent } = await loadPosthogModule();

    const captured = captureBackendEvent('Live Activity Started', { distinctId: 'user-1' });

    expect(captured).toBe(false);
    expect(posthogMocks.PostHog).not.toHaveBeenCalled();
  });

  it('POSTHOG_ENVIRONMENT overrides SENTRY_ENVIRONMENT (the pre-existing degree of freedom)', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    vi.stubEnv('SENTRY_ENVIRONMENT', 'preview');
    const { captureBackendEvent } = await loadPosthogModule();

    const captured = captureBackendEvent('Live Activity Started', { distinctId: 'user-1' });

    expect(captured).toBe(true);
    expect(posthogMocks.PostHog).toHaveBeenCalledOnce();
  });

  // getAnalyticsEnvironment()'s fallback is `?? 'development'` — unlike Sentry's
  // resolveSentryEnvironment(), it does NOT special-case "everything unset" to
  // 'production' (see the comment on getAnalyticsEnvironment). Real Railway prod
  // resolves to 'production' via an explicit POSTHOG_ENVIRONMENT or
  // SENTRY_ENVIRONMENT dashboard variable, not this fallback — this test pins
  // that the fallback stays 'development' so nobody "fixes" it into matching
  // Sentry's special-casing and masks a genuinely-unconfigured environment.
  it("falls back to 'development' (not 'production') when every environment var is unset", async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'ph_project');
    vi.stubEnv('NODE_ENV', '');
    vi.stubEnv('SENTRY_ENVIRONMENT', '');
    vi.stubEnv('POSTHOG_ENVIRONMENT', '');
    const { captureBackendEvent } = await loadPosthogModule();

    const captured = captureBackendEvent('Live Activity Started', { distinctId: 'user-1' });

    expect(captured).toBe(false);
    expect(posthogMocks.PostHog).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      "[PostHog] Resolved environment 'development' is not production; backend analytics disabled",
    );
  });
});
