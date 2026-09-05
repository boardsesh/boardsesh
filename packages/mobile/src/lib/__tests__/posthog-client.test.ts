import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  MOBILE_USER_AGENT,
  registerMobileUserAgent,
  registerAppEnvironment,
  buildPostHogOptions,
  NetworkPolicyPostHog,
} from '../posthog-client';
import { NetworkPolicyBlockedError, setNetworkPolicy } from '../network-policy';

afterEach(() => {
  setNetworkPolicy('online');
});

// The whole point of MOBILE_USER_AGENT is to give mobile events a User-Agent that
// PostHog's classifier reads as "Regular" rather than the bot it assigns to an
// empty UA. If a future edit makes it empty or sneaks in a denylisted substring,
// every mobile user silently falls back into the bot bucket — guard against that.
describe('MOBILE_USER_AGENT', () => {
  it('is a non-empty string', () => {
    expect(typeof MOBILE_USER_AGENT).toBe('string');
    expect(MOBILE_USER_AGENT.length).toBeGreaterThan(0);
  });

  it('matches none of PostHog’s bot denylist substrings', () => {
    // Sample of PostHog's DEFAULT_BLOCKED_UA_STRS (substring match, case-insensitive).
    const botPatterns = /bot|crawler|spider|slurp|headless|cypress|prerender|archiver|lighthouse/i;
    expect(botPatterns.test(MOBILE_USER_AGENT)).toBe(false);
  });
});

describe('registerMobileUserAgent', () => {
  it('registers the non-bot UA as a $raw_user_agent super property', () => {
    const register = vi.fn();
    registerMobileUserAgent({ register });
    expect(register).toHaveBeenCalledWith({ $raw_user_agent: MOBILE_USER_AGENT });
  });

  it('never throws and logs when register() fails (must not block analytics init)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const register = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => registerMobileUserAgent({ register })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// #3814: without this, mobile PostHog events carried no environment tag at all,
// so `pr-*` OTA preview traffic was indistinguishable from production in every
// event but the once-per-launch OTA Update Status one.
describe('registerAppEnvironment', () => {
  const previous = process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
  afterEach(() => {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
    else process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = previous;
  });

  it("registers 'production' as the environment super property when unset", () => {
    delete process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
    const register = vi.fn();
    registerAppEnvironment({ register });
    expect(register).toHaveBeenCalledWith({ environment: 'production' });
  });

  it('registers the preview value published onto pr-* OTA bundles', () => {
    process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = 'preview';
    const register = vi.fn();
    registerAppEnvironment({ register });
    expect(register).toHaveBeenCalledWith({ environment: 'preview' });
  });

  it('never throws and logs when register() fails (must not block analytics init)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const register = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => registerAppEnvironment({ register })).not.toThrow();
    // The warn assertion depends on __DEV__ being truthy — mobile vitest freezes it
    // that way (see the mobile test setup). A test that stubs __DEV__ = false without
    // restoring it turns this into a false green; the not-throwing assertion above is
    // the load-bearing one either way.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// Guards the stable anonymous identity used by explicit screen/action events.
describe('buildPostHogOptions', () => {
  it('bootstraps the anonymous distinct_id from a resolved party-profile UUID', () => {
    const options = buildPostHogOptions('https://us.i.posthog.com', 'party-profile-uuid');
    expect(options.bootstrap).toEqual({ distinctId: 'party-profile-uuid', isIdentifiedId: false });
    expect(options.host).toBe('https://us.i.posthog.com');
  });

  it('omits bootstrap when the party-profile UUID could not be resolved', () => {
    const options = buildPostHogOptions('https://us.i.posthog.com', null);
    expect(options.bootstrap).toBeUndefined();
  });

  it('always configures session replay masking regardless of bootstrap', () => {
    const options = buildPostHogOptions('https://us.i.posthog.com', null);
    expect(options.sessionReplayConfig).toEqual({
      maskAllTextInputs: true,
      maskAllImages: true,
      captureLog: true,
    });
  });

  it('disables native lifecycle autocapture', () => {
    const options = buildPostHogOptions('https://us.i.posthog.com', null);
    expect(options.captureAppLifecycleEvents).toBe(false);
  });
});

describe('PostHog transport network policy', () => {
  it.each(['local-catalog-only', 'account-offline'] as const)(
    'does not call the SDK transport in %s mode',
    (policy) => {
      const networkFetch = vi.spyOn(globalThis, 'fetch');
      const policyClient = Object.create(NetworkPolicyPostHog.prototype) as NetworkPolicyPostHog;
      setNetworkPolicy(policy);

      expect(() => policyClient.fetch('https://telemetry.example/batch', { method: 'POST', headers: {} })).toThrow(
        NetworkPolicyBlockedError,
      );
      expect(networkFetch).not.toHaveBeenCalled();
      networkFetch.mockRestore();
    },
  );
});
