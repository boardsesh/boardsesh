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

  // #4317: `connectivity` is registered once at startup and then only on a
  // network transition, so a sign-out that dropped it would leave every
  // remaining event of the launch unattributable to online or offline.
  it('re-registers connectivity after resetting the client', async () => {
    const fakeClient = { register: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { reset } = await import('../analytics');

    expect(reset()).toBe(true);

    expect(fakeClient.register).toHaveBeenCalledWith({ connectivity: 'online', offline_reason: null });
  });

  // #4312: `offline_engine_state` is registered once, from a flag effect that
  // will not run again this launch, so a sign-out that dropped it would end the
  // bake measurement there — including for the account signed in next.
  it('re-registers the offline engine state after resetting the client', async () => {
    const fakeClient = { register: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { registerOfflineEngineState, __resetOfflineEngineStateForTests } =
      await import('../analytics-offline-engine-state');
    __resetOfflineEngineStateForTests();
    registerOfflineEngineState('default-on');
    fakeClient.register.mockClear();
    const { reset } = await import('../analytics');

    expect(reset()).toBe(true);

    expect(fakeClient.register).toHaveBeenCalledWith({ offline_engine_state: 'default-on' });
  });

  it('registers no engine state when the flag effect has not decided one yet', async () => {
    const fakeClient = { register: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { __resetOfflineEngineStateForTests } = await import('../analytics-offline-engine-state');
    __resetOfflineEngineStateForTests();
    const { reset } = await import('../analytics');

    expect(reset()).toBe(true);

    expect(fakeClient.register).not.toHaveBeenCalledWith(
      expect.objectContaining({ offline_engine_state: expect.anything() }),
    );
  });

  // The active board does not change on sign-out, so AnalyticsGymProperties'
  // effect will not re-run — without this restore, every event for the rest of
  // the launch loses its venue and the gym leaderboard under-counts whoever
  // signed out mid-session.
  //
  // The property names are spelled out as literals here, deliberately, rather
  // than imported from analytics-gym. `gym_uuid` / `gym_name` are a WIRE
  // contract: PostHog insights and the gym dashboard reference those exact
  // strings, and renaming one silently re-points every saved insight at a
  // property that no longer exists. Asserting through the constant would follow
  // the rename and stay green; the literal is what reds. analytics-gym.test.ts
  // uses the constants to assert behaviour — this one pins the names.
  it('re-registers the active gym after resetting the client', async () => {
    const fakeClient = { register: vi.fn(), unregister: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { registerActiveGym, __resetActiveGymForTests } = await import('../analytics-gym');
    __resetActiveGymForTests();
    registerActiveGym({ uuid: 'gym-1', name: 'Bloclab' });
    fakeClient.register.mockClear();
    const { reset } = await import('../analytics');

    expect(reset()).toBe(true);

    expect(fakeClient.register).toHaveBeenCalledWith({ gym_uuid: 'gym-1', gym_name: 'Bloclab' });
  });

  it('registers no gym when the active board has never carried one', async () => {
    const fakeClient = { register: vi.fn(), unregister: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { __resetActiveGymForTests } = await import('../analytics-gym');
    __resetActiveGymForTests();
    const { reset } = await import('../analytics');

    expect(reset()).toBe(true);

    expect(fakeClient.register).not.toHaveBeenCalledWith(expect.objectContaining({ gym_uuid: expect.anything() }));
    expect(fakeClient.unregister).not.toHaveBeenCalled();
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
