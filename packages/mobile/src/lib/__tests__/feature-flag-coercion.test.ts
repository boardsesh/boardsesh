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

  describe('a multivariate flag (variants declared)', () => {
    const definition = { key: 'board-glow-falloff', variants: ['soft', 'plateau'] as const };

    it('keeps a variant string that is a declared member', () => {
      getFeatureFlag.mockReturnValue('plateau');
      expect(readPosthogFeatureFlags([definition])).toEqual({ 'board-glow-falloff': 'plateau' });
    });

    it('drops a string outside the declared variant set', () => {
      getFeatureFlag.mockReturnValue('not-a-real-variant');
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });

    it('drops a boolean read — a multivariate flag never resolves to on/off', () => {
      getFeatureFlag.mockReturnValue(false);
      expect(readPosthogFeatureFlags([definition])).toEqual({});

      getFeatureFlag.mockReturnValue(true);
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });

    it('drops an unresolved read', () => {
      getFeatureFlag.mockReturnValue(undefined);
      expect(readPosthogFeatureFlags([definition])).toEqual({});
    });
  });

  it('reads each definition independently, mixing boolean and variant flags', () => {
    getFeatureFlag.mockImplementation((key: string) => {
      if (key === 'strava-integration') return true;
      if (key === 'board-glow-falloff') return 'plateau';
      return undefined;
    });
    expect(
      readPosthogFeatureFlags([
        { key: 'strava-integration' },
        { key: 'board-glow-falloff', variants: ['soft', 'plateau'] },
        { key: 'garmin-watch' },
      ]),
    ).toEqual({ 'strava-integration': true, 'board-glow-falloff': 'plateau' });
  });
});

describe('registerRenderSuperProperties', () => {
  it('registers render_mode, glow_falloff and glow_falloff_source', () => {
    const register = vi.fn();
    posthogClientMocks.getPostHogClient.mockReturnValue({ register });

    registerRenderSuperProperties({ mode: 'boardsesh', glowFalloff: 'plateau', glowFalloffSource: 'flag' });

    expect(register).toHaveBeenCalledWith({
      render_mode: 'boardsesh',
      glow_falloff: 'plateau',
      glow_falloff_source: 'flag',
    });
  });

  it('is a no-op when analytics is disabled (null client)', () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    expect(() =>
      registerRenderSuperProperties({ mode: 'classic', glowFalloff: 'soft', glowFalloffSource: 'default' }),
    ).not.toThrow();
  });
});
