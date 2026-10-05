import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogClientMocks = vi.hoisted(() => ({
  getPostHogClient: vi.fn(),
  registerAppSuperProperties: vi.fn(),
}));

vi.mock('../posthog-client', () => ({
  getPostHogClient: posthogClientMocks.getPostHogClient,
  registerAppSuperProperties: posthogClientMocks.registerAppSuperProperties,
}));

function fakeClient(ids: { distinctId: string; anonymousId: string }, ready: Promise<void> = Promise.resolve()) {
  return {
    getDistinctId: () => ids.distinctId,
    getAnonymousId: () => ids.anonymousId,
    ready: () => ready,
  };
}

// The readers behind every "should analytics reset?" decision. The answer has
// to come from the SDK's persisted state, and "cannot say yet" must never read
// as "pinned": a reset on an anonymous SDK throws away the anonymous id the
// next sign-in merges on (see reconcile-identity.ts in @boardsesh/analytics).
describe('analytics identity readers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports no identity when there is no client', async () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    const { getAnalyticsIdentity, isAnalyticsPinnedToAPerson } = await import('../analytics');

    expect(getAnalyticsIdentity()).toBeNull();
    expect(isAnalyticsPinnedToAPerson()).toBe(false);
  });

  it('reports no identity while the SDK has not loaded its storage', async () => {
    // @posthog/core returns '' from both getters until it is initialised.
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient({ distinctId: '', anonymousId: '' }));
    const { getAnalyticsIdentity, isAnalyticsPinnedToAPerson } = await import('../analytics');

    expect(getAnalyticsIdentity()).toBeNull();
    expect(isAnalyticsPinnedToAPerson()).toBe(false);
  });

  it('reads an anonymous SDK as not pinned', async () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient({ distinctId: 'anon-1', anonymousId: 'anon-1' }));
    const { getAnalyticsIdentity, isAnalyticsPinnedToAPerson } = await import('../analytics');

    expect(getAnalyticsIdentity()).toEqual({ distinctId: 'anon-1', anonymousId: 'anon-1' });
    expect(isAnalyticsPinnedToAPerson()).toBe(false);
  });

  it('reads an identified SDK as pinned', async () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient({ distinctId: 'user-1', anonymousId: 'anon-1' }));
    const { isAnalyticsPinnedToAPerson } = await import('../analytics');

    expect(isAnalyticsPinnedToAPerson()).toBe(true);
  });
});

describe('onAnalyticsReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the callback only after the SDK is ready', async () => {
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    posthogClientMocks.getPostHogClient.mockReturnValue(
      fakeClient({ distinctId: 'anon-1', anonymousId: 'anon-1' }, ready),
    );
    const { onAnalyticsReady } = await import('../analytics');
    const callback = vi.fn();

    onAnalyticsReady(callback);
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();

    markReady();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  });

  it('does not run a cancelled callback', async () => {
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    posthogClientMocks.getPostHogClient.mockReturnValue(
      fakeClient({ distinctId: 'anon-1', anonymousId: 'anon-1' }, ready),
    );
    const { onAnalyticsReady } = await import('../analytics');
    const callback = vi.fn();

    const cancel = onAnalyticsReady(callback);
    cancel();
    markReady();
    await ready;
    await Promise.resolve();
    await Promise.resolve();

    expect(callback).not.toHaveBeenCalled();
  });

  it('never runs the callback when analytics is disabled', async () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    const { onAnalyticsReady } = await import('../analytics');
    const callback = vi.fn();

    onAnalyticsReady(callback);
    await Promise.resolve();

    expect(callback).not.toHaveBeenCalled();
  });
});
