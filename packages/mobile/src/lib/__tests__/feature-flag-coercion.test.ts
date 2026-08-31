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
      mode: 'boardsesh',
      glowFalloff: 'plateau',
      glowFalloffSource: 'flag',
      glowStyle: 'plain',
    });

    expect(register).toHaveBeenCalledWith({
      render_mode: 'boardsesh',
      glow_falloff: 'plateau',
      glow_falloff_source: 'flag',
      glow_style: 'plain',
    });
  });

  it('is a no-op when analytics is disabled (null client)', () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    expect(() =>
      registerRenderSuperProperties({
        mode: 'classic',
        glowFalloff: 'soft',
        glowFalloffSource: 'default',
        glowStyle: 'plain',
      }),
    ).not.toThrow();
  });
});
