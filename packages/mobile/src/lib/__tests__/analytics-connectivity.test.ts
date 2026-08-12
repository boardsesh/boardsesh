import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';

const posthogClientMocks = vi.hoisted(() => ({ getPostHogClient: vi.fn() }));

vi.mock('../posthog-client', () => ({ getPostHogClient: posthogClientMocks.getPostHogClient }));

import {
  CONNECTIVITY_SUPER_PROPERTY,
  currentConnectivityState,
  registerConnectivitySuperProperty,
  startConnectivityTracking,
} from '../analytics-connectivity';

// Issue #4317: without this property nothing in the app's telemetry says whether
// the network was usable when an event was captured, so "did anyone use the app
// away from signal?" — the whole premise of offline mode — is unanswerable.
describe('analytics connectivity super property', () => {
  let register: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    register = vi.fn();
    posthogClientMocks.getPostHogClient.mockReturnValue({ register });
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('reads the current state from onlineManager', () => {
    expect(currentConnectivityState()).toBe('online');
    onlineManager.setOnline(false);
    expect(currentConnectivityState()).toBe('offline');
  });

  it('registers the resolved client singleton when no client is passed', () => {
    onlineManager.setOnline(false);
    registerConnectivitySuperProperty();
    expect(register).toHaveBeenCalledWith({ [CONNECTIVITY_SUPER_PROPERTY]: 'offline' });
  });

  it('registers on the passed client without resolving the singleton', () => {
    const explicitRegister = vi.fn();
    registerConnectivitySuperProperty({ register: explicitRegister });
    expect(explicitRegister).toHaveBeenCalledWith({ [CONNECTIVITY_SUPER_PROPERTY]: 'online' });
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
    expect(register).toHaveBeenCalledExactlyOnceWith({ [CONNECTIVITY_SUPER_PROPERTY]: 'online' });
    stop();
  });

  it('re-registers on an online → offline transition', () => {
    const stop = startConnectivityTracking();
    register.mockClear();

    onlineManager.setOnline(false);

    expect(register).toHaveBeenCalledExactlyOnceWith({ [CONNECTIVITY_SUPER_PROPERTY]: 'offline' });
    stop();
  });

  // NetInfo's change stream is chatty and onlineManager notifies on every
  // setOnline call, including same-value ones. Each register() is a persisted
  // write, so a repeat must not cost one.
  it('does not re-register when the state has not changed', () => {
    const stop = startConnectivityTracking();
    register.mockClear();

    onlineManager.setOnline(true);
    onlineManager.setOnline(true);

    expect(register).not.toHaveBeenCalled();
    stop();
  });

  it('stops re-registering once unsubscribed', () => {
    const stop = startConnectivityTracking();
    register.mockClear();
    stop();

    onlineManager.setOnline(false);

    expect(register).not.toHaveBeenCalled();
  });
});
