import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogClientMocks = vi.hoisted(() => ({
  getPostHogClient: vi.fn(),
  registerAppSuperProperties: vi.fn(),
}));
const sharedAnalyticsMocks = vi.hoisted(() => ({ reset: vi.fn(() => true) }));

vi.mock('../posthog-client', () => ({
  getPostHogClient: posthogClientMocks.getPostHogClient,
  registerAppSuperProperties: posthogClientMocks.registerAppSuperProperties,
}));

vi.mock('@boardsesh/analytics', () => ({
  createAnalytics: () => ({
    track: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    setPersonProperties: vi.fn(),
    alias: vi.fn(),
    reset: sharedAnalyticsMocks.reset,
  }),
}));

// #3814: PostHog's reset() clears every registered super property, and
// getPostHogClient() caches the singleton so its construction-time registrations
// never run again. Sign-out paths (logout, forced sign-out, expiry, account
// switch) all route through auth-provider's resetAnalytics, so without the
// re-register a tester's post-logout events silently lose `environment` and read
// as production — exactly the pollution this PR closes — and lose
// `$raw_user_agent`, which gets them bot-filtered.
describe('analytics reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedAnalyticsMocks.reset.mockReturnValue(true);
  });

  it('re-registers the build-level super properties after resetting the client', async () => {
    const fakeClient = { register: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { reset } = await import('../analytics');

    expect(reset()).toBe(true);

    expect(sharedAnalyticsMocks.reset).toHaveBeenCalledOnce();
    expect(posthogClientMocks.registerAppSuperProperties).toHaveBeenCalledWith(fakeClient);
  });

  it('does not re-register when analytics is disabled (no client)', async () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    const { reset } = await import('../analytics');

    expect(reset()).toBe(true);

    expect(posthogClientMocks.registerAppSuperProperties).not.toHaveBeenCalled();
  });

  it('propagates the underlying reset result', async () => {
    sharedAnalyticsMocks.reset.mockReturnValue(false);
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    const { reset } = await import('../analytics');

    expect(reset()).toBe(false);
  });
});
