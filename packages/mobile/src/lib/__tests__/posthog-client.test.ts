import { describe, it, expect, vi } from 'vitest';
import { MOBILE_USER_AGENT, registerMobileUserAgent, buildPostHogOptions } from '../posthog-client';

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
