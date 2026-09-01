import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogClientMocks = vi.hoisted(() => ({ getPostHogClient: vi.fn() }));

vi.mock('../posthog-client', () => ({ getPostHogClient: posthogClientMocks.getPostHogClient }));

import { readPosthogFeatureFlags, registerRenderSuperProperties } from '../analytics';

// readPosthogFeatureFlags is the only exported surface over
// coerceFeatureFlagValue, so these tests exercise the coercion through it:
// plain boolean flags must keep their exact prior behaviour, and multivariate
// flags (a `variants` list on the definition) must only ever surface one of
// their declared members — anything else, including a stale boolean, reads as
// unresolved so callers fall back to the shipped default.
//
// The multivariate path was removed for 2.4 along with the last two variant
// flags and only restored for observe-sample-rate; these tests are what keep it
// from being deleted again while a flag still depends on it.
describe('readPosthogFeatureFlags', () => {
  let getFeatureFlag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getFeatureFlag = vi.fn();
    posthogClientMocks.getPostHogClient.mockReturnValue({ getFeatureFlag });
  });

  it('returns an empty bag when analytics is disabled (null client)', () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    expect(readPosthogFeatureFlags([{ key: 'strava-integration' }])).toEqual({});
  });

  describe('a plain boolean flag (no variants)', () => {
    it('keeps a real boolean unchanged', () => {
      getFeatureFlag.mockReturnValue(true);
      expect(readPosthogFeatureFlags([{ key: 'strava-integration' }])).toEqual({ 'strava-integration': true });

      getFeatureFlag.mockReturnValue(false);
      expect(readPosthogFeatureFlags([{ key: 'strava-integration' }])).toEqual({ 'strava-integration': false });
    });

    it('normalises the SDK string-boolean quirk', () => {
      getFeatureFlag.mockReturnValue('true');
      expect(readPosthogFeatureFlags([{ key: 'strava-integration' }])).toEqual({ 'strava-integration': true });

      getFeatureFlag.mockReturnValue('false');
      expect(readPosthogFeatureFlags([{ key: 'strava-integration' }])).toEqual({ 'strava-integration': false });
    });

    it('drops an unresolved (undefined) read entirely, rather than a false', () => {
      getFeatureFlag.mockReturnValue(undefined);
      expect(readPosthogFeatureFlags([{ key: 'strava-integration' }])).toEqual({});
    });
  });

  describe('a value that is not a boolean', () => {
    const definition = { key: 'strava-integration' };

    it('drops a leftover variant string from when a flag was multivariate', () => {
      // Every flag is a boolean again — the last two multivariate ones were
      // retired for 2.4 — so a string read is stale, not a variant. `'true'` /
      // `'false'` stay normalised; only those two strings mean anything.
      getFeatureFlag.mockReturnValue('plateau');
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });

    it('drops an unresolved read', () => {
      getFeatureFlag.mockReturnValue(undefined);
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });
  });

  describe('a multivariate flag (a variants list on the definition)', () => {
    // observe-sample-rate is the live one. Without this path its value is
    // coerced to a boolean and dropped, so the flag silently does nothing.
    const definition = { key: 'observe-sample-rate', variants: ['1', '0.5', '0.25'] as const };

    it('keeps a declared variant verbatim', () => {
      getFeatureFlag.mockReturnValue('0.25');
      expect(readPosthogFeatureFlags([definition])).toEqual({ 'observe-sample-rate': '0.25' });
    });

    it('drops a string that is not a declared member', () => {
      getFeatureFlag.mockReturnValue('0.42');
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });

    it('drops a boolean, which is what PostHog returns when nothing matched', () => {
      getFeatureFlag.mockReturnValue(false);
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });

    it('drops an unresolved read', () => {
      getFeatureFlag.mockReturnValue(undefined);
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });

    it('does not turn a boolean flag multivariate by accident', () => {
      // An empty variants list must keep the plain boolean behaviour.
      getFeatureFlag.mockReturnValue(true);
      expect(readPosthogFeatureFlags([{ key: 'strava-integration', variants: [] }])).toEqual({
        'strava-integration': true,
      });
    });
  });

  it('reads each definition independently', () => {
    getFeatureFlag.mockImplementation((key: string) => (key === 'strava-integration' ? true : undefined));
    expect(readPosthogFeatureFlags([{ key: 'strava-integration' }, { key: 'garmin-watch' }])).toEqual({
      'strava-integration': true,
    });
  });
});

describe('registerRenderSuperProperties', () => {
  it('registers render_mode, glow_falloff and glow_falloff_source', () => {
    const register = vi.fn();
    posthogClientMocks.getPostHogClient.mockReturnValue({ register });

    registerRenderSuperProperties({
      mode: 'aura',
      glowFalloff: 'plateau',
      glowFalloffSource: 'flag',
    });

    expect(register).toHaveBeenCalledWith({
      render_mode: 'aura',
      glow_falloff: 'plateau',
      glow_falloff_source: 'flag',
    });
  });

  it('is a no-op when analytics is disabled (null client)', () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    expect(() =>
      registerRenderSuperProperties({
        mode: 'classic',
        glowFalloff: 'soft',
        glowFalloffSource: 'default',
      }),
    ).not.toThrow();
  });
});
