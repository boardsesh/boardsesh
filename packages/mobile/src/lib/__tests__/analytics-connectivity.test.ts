import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogClientMocks = vi.hoisted(() => ({ getPostHogClient: vi.fn() }));

vi.mock('../posthog-client', () => ({ getPostHogClient: posthogClientMocks.getPostHogClient }));

// The super property reads the connectivity store now (#4862), not React Query's
// onlineManager — that is what lets a dead BACKEND on a healthy phone stamp
// 'offline' instead of 'online'.
const connectivity = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { snapshot: { effectiveOffline: false, reason: null as string | null } };
  return {
    state,
    listeners,
    publish(next: { effectiveOffline: boolean; reason: string | null }) {
      state.snapshot = next;
      for (const listener of listeners) listener();
    },
  };
});
vi.mock('../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => connectivity.state.snapshot,
  subscribeConnectivity: (listener: () => void) => {
    connectivity.listeners.add(listener);
    return () => connectivity.listeners.delete(listener);
  },
}));

import {
  CONNECTIVITY_SUPER_PROPERTY,
  OFFLINE_REASON_SUPER_PROPERTY,
  currentConnectivityState,
  currentOfflineReason,
  registerConnectivitySuperProperty,
  startConnectivityTracking,
} from '../analytics-connectivity';

// Issue #4317: without this property nothing in the app's telemetry says whether
// the network was usable when an event was captured, so "did anyone use the app
// away from signal?" — the whole premise of offline mode — is unanswerable.
// Issue #4862 added the reason, because 'offline' alone cannot tell a climber in
// a tunnel from a climber whose SERVER is down.
describe('analytics connectivity super property', () => {
  let register: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    register = vi.fn();
    posthogClientMocks.getPostHogClient.mockReturnValue({ register });
    connectivity.listeners.clear();
    connectivity.state.snapshot = { effectiveOffline: false, reason: null };
  });

  it('reads the current state from the connectivity store', () => {
    expect(currentConnectivityState()).toBe('online');
    expect(currentOfflineReason()).toBeNull();

    connectivity.state.snapshot = { effectiveOffline: true, reason: 'backend_unreachable' };
    expect(currentConnectivityState()).toBe('offline');
    expect(currentOfflineReason()).toBe('backend_unreachable');
  });

  // Both in ONE register() call: each call is a persisted write, and a state
  // registered without its reason would put a self-contradicting pair on every
  // event captured in between.
  it('registers the state and its reason together', () => {
    connectivity.state.snapshot = { effectiveOffline: true, reason: 'backend_unreachable' };
    registerConnectivitySuperProperty();

    expect(register).toHaveBeenCalledExactlyOnceWith({
      [CONNECTIVITY_SUPER_PROPERTY]: 'offline',
      [OFFLINE_REASON_SUPER_PROPERTY]: 'backend_unreachable',
    });
  });

  it('clears the reason explicitly when the app is online', () => {
    registerConnectivitySuperProperty();

    expect(register).toHaveBeenCalledExactlyOnceWith({
      [CONNECTIVITY_SUPER_PROPERTY]: 'online',
      [OFFLINE_REASON_SUPER_PROPERTY]: null,
    });
  });

  it('registers on the passed client without resolving the singleton', () => {
    const explicitRegister = vi.fn();
    registerConnectivitySuperProperty({ register: explicitRegister });
    expect(explicitRegister).toHaveBeenCalledExactlyOnceWith({
      [CONNECTIVITY_SUPER_PROPERTY]: 'online',
      [OFFLINE_REASON_SUPER_PROPERTY]: null,
    });
    expect(posthogClientMocks.getPostHogClient).not.toHaveBeenCalled();
  });

  it('is a no-op when analytics is disabled (null client)', () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    expect(() => registerConnectivitySuperProperty()).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });

  it('swallows a throwing register so it can never break the caller', () => {
    register.mockImplementation(() => {
      throw new Error('register exploded');
    });
    expect(() => registerConnectivitySuperProperty()).not.toThrow();
  });

  it('swallows a rejecting register promise', async () => {
    register.mockReturnValue(Promise.reject(new Error('register rejected')));
    expect(() => registerConnectivitySuperProperty()).not.toThrow();
    await Promise.resolve();
  });

  it('registers immediately on start', () => {
    const stop = startConnectivityTracking();
    expect(register).toHaveBeenCalledExactlyOnceWith({
      [CONNECTIVITY_SUPER_PROPERTY]: 'online',
      [OFFLINE_REASON_SUPER_PROPERTY]: null,
    });
    stop();
  });

  it('re-registers on an online → offline transition', () => {
    const stop = startConnectivityTracking();
    register.mockClear();

    connectivity.publish({ effectiveOffline: true, reason: 'device_offline' });

    expect(register).toHaveBeenCalledExactlyOnceWith({
      [CONNECTIVITY_SUPER_PROPERTY]: 'offline',
      [OFFLINE_REASON_SUPER_PROPERTY]: 'device_offline',
    });
    stop();
  });

  // Same 'offline' state, different cause: a tunnel that turns out to be our own
  // outage has to re-stamp, or every event in between carries the wrong blame.
  it('re-registers when only the reason changes', () => {
    connectivity.state.snapshot = { effectiveOffline: true, reason: 'device_offline' };
    const stop = startConnectivityTracking();
    register.mockClear();

    connectivity.publish({ effectiveOffline: true, reason: 'backend_unreachable' });

    expect(register).toHaveBeenCalledExactlyOnceWith({
      [CONNECTIVITY_SUPER_PROPERTY]: 'offline',
      [OFFLINE_REASON_SUPER_PROPERTY]: 'backend_unreachable',
    });
    stop();
  });

  // The store notifies on every snapshot change, including ones neither property
  // cares about (a probe starting, a failure counter ticking). Each register() is
  // a persisted write, so a repeat must not cost one.
  it('does not re-register when neither property changed', () => {
    const stop = startConnectivityTracking();
    register.mockClear();

    connectivity.publish({ effectiveOffline: false, reason: null });
    connectivity.publish({ effectiveOffline: false, reason: null });

    expect(register).not.toHaveBeenCalled();
    stop();
  });

  it('stops re-registering once unsubscribed', () => {
    const stop = startConnectivityTracking();
    register.mockClear();
    stop();

    connectivity.publish({ effectiveOffline: true, reason: 'device_offline' });

    expect(register).not.toHaveBeenCalled();
  });

  // analytics.reset() clears every super property, so it re-registers this pair
  // on the client it already holds — otherwise every event after a sign-out
  // would drop both.
  it('re-registers on a client handed in after a reset', () => {
    connectivity.state.snapshot = { effectiveOffline: true, reason: 'offline_mode' };
    const clientAfterReset = vi.fn();

    registerConnectivitySuperProperty({ register: clientAfterReset });

    expect(clientAfterReset).toHaveBeenCalledExactlyOnceWith({
      [CONNECTIVITY_SUPER_PROPERTY]: 'offline',
      [OFFLINE_REASON_SUPER_PROPERTY]: 'offline_mode',
    });
  });
});
