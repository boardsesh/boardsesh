import { describe, it, expect } from 'vitest';
import { MOBILE_USER_AGENT } from '../posthog-client';

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
