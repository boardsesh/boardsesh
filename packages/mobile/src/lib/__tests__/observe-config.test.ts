import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  OBSERVE_DEFAULT_SAMPLE_RATE,
  OBSERVE_INTEGRATIONS,
  OBSERVE_FILTERED_ROUTE_PARAMS,
  buildObserveConfig,
  parseObserveSampleRate,
  resolveObserveDispatchEnabled,
  isFirstPartyObserveEndpointConfigured,
} from '../observe-config';

// Exercise the installed SDK's pure helpers without importing its internal
// native types into the application TypeScript project.
const observePackageRoot = dirname(createRequire(import.meta.url).resolve('expo-observe/package.json'));
type NavigationConfig = (typeof OBSERVE_INTEGRATIONS)['expo-router'];
type NavigationHelpers = {
  getNavigationMetricParams: (config: NavigationConfig, params: Record<string, unknown>, url: string) => unknown;
  getNavigationRouteParams: (config: NavigationConfig, params: Record<string, unknown>) => unknown;
};
const { getNavigationMetricParams, getNavigationRouteParams } = (await import(
  /* @vite-ignore */ join(observePackageRoot, 'src/integrations/navigationConfig.ts')
)) as NavigationHelpers;
const { buildRoutePattern } = (await import(
  /* @vite-ignore */ join(observePackageRoot, 'src/integrations/expo-router/routeName.ts')
)) as { buildRoutePattern: (segments: string[]) => string };

describe('parseObserveSampleRate', () => {
  // PostHog hands back a string, and the value is typed by hand in a dashboard.
  it('reads the declared variant strings', () => {
    expect(parseObserveSampleRate('1')).toBe(1);
    expect(parseObserveSampleRate('0.25')).toBe(0.25);
    expect(parseObserveSampleRate('0')).toBe(0);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseObserveSampleRate(' 0.5 ')).toBe(0.5);
  });

  it('accepts a number, in case the flag is ever typed as one', () => {
    expect(parseObserveSampleRate(0.25)).toBe(0.25);
  });

  // The important cases: a typo must not reach the SDK as NaN, which would
  // silently stop collection for every device that read the flag.
  it('falls back to the shipped default for unparseable input', () => {
    expect(parseObserveSampleRate('half')).toBe(OBSERVE_DEFAULT_SAMPLE_RATE);
    expect(parseObserveSampleRate('')).toBe(OBSERVE_DEFAULT_SAMPLE_RATE);
    expect(parseObserveSampleRate(Number.NaN)).toBe(OBSERVE_DEFAULT_SAMPLE_RATE);
  });

  it('falls back when the flag has not resolved yet', () => {
    expect(parseObserveSampleRate(undefined)).toBe(OBSERVE_DEFAULT_SAMPLE_RATE);
    expect(parseObserveSampleRate(null)).toBe(OBSERVE_DEFAULT_SAMPLE_RATE);
  });

  it('clamps out-of-range values instead of passing them through', () => {
    expect(parseObserveSampleRate('2')).toBe(1);
    expect(parseObserveSampleRate('-1')).toBe(0);
    expect(parseObserveSampleRate(Number.POSITIVE_INFINITY)).toBe(OBSERVE_DEFAULT_SAMPLE_RATE);
  });
});

describe('resolveObserveDispatchEnabled', () => {
  it('uses enabled diagnostics after the flag bag resolves without a kill', () => {
    expect(resolveObserveDispatchEnabled(undefined)).toBe(true);
    expect(resolveObserveDispatchEnabled(null)).toBe(true);
  });

  it('disables only on an explicit false', () => {
    expect(resolveObserveDispatchEnabled(false)).toBe(false);
    expect(resolveObserveDispatchEnabled(true)).toBe(true);
  });

  it('retains diagnostics for malformed flags rather than hiding errors', () => {
    expect(resolveObserveDispatchEnabled('true')).toBe(true);
    expect(resolveObserveDispatchEnabled('')).toBe(true);
  });

  it("honours the string 'false', so a kill switch typed as text still kills", () => {
    // A boolean flag resolves to a real boolean, but the same key typed as a
    // multivariate flag in the dashboard arrives as a string.
    expect(resolveObserveDispatchEnabled('false')).toBe(false);
  });
});

describe('buildObserveConfig', () => {
  it('never dispatches from a debug build', () => {
    // Without this a Metro dev session writes into production ClickHouse.
    expect(buildObserveConfig().dispatchInDebug).toBe(false);
  });

  it('applies the shipped defaults when given no overrides', () => {
    const config = buildObserveConfig();
    expect(config.sampleRate).toBe(1);
    expect(config.dispatchingEnabled).toBe(false);
  });

  it('applies overrides', () => {
    const config = buildObserveConfig({ dispatchingEnabled: false, sampleRate: 0.1 });
    expect(config.dispatchingEnabled).toBe(false);
    expect(config.sampleRate).toBe(0.1);
  });

  it('hands back the same integrations object every time', () => {
    // Not a micro-optimisation: expo-observe's router integration throws if the
    // initialized value changes for a mounted screen, so the runtime re-apply
    // must pass the identical value the startup call did.
    expect(buildObserveConfig().integrations).toBe(OBSERVE_INTEGRATIONS);
    expect(buildObserveConfig({ sampleRate: 0.5 }).integrations).toBe(OBSERVE_INTEGRATIONS);
  });

  it('enables the expo-router integration, which is what produces the timings', () => {
    expect(OBSERVE_INTEGRATIONS['expo-router']).toEqual({ filteredParams: OBSERVE_FILTERED_ROUTE_PARAMS });
  });
});

describe('Observe router metadata with the pinned public SDK', () => {
  it('retains normalized timing routes without user or session IDs or their resolved URL', () => {
    const integration = OBSERVE_INTEGRATIONS['expo-router'];
    const params = { userId: 'account-secret', sessionId: 'session-secret', mode: 'followers' };
    expect(buildRoutePattern(['users', '[userId]'])).toBe('/users/[userId]');
    expect(getNavigationMetricParams(integration, params, '/users/account-secret')).toEqual({
      routeParams: { mode: 'followers' },
      urlHidden: true,
    });
    expect(getNavigationRouteParams(integration, params)).toEqual({
      routeParams: { mode: 'followers' },
      urlHidden: true,
    });
  });

  it('removes auth reset credentials from navigation metrics', () => {
    expect(
      getNavigationMetricParams(
        OBSERVE_INTEGRATIONS['expo-router'],
        {
          token: 'reset-secret',
          email: 'person@example.com',
        },
        '/auth/reset-password',
      ),
    ).toEqual({ routeParams: {}, urlHidden: true });
  });
});

describe('first-party Observe endpoint', () => {
  it('accepts explicit self-hosted ingest configuration', () => {
    expect(isFirstPartyObserveEndpointConfigured('https://ota.boardsesh.com/observe/app-id')).toBe(true);
    expect(isFirstPartyObserveEndpointConfigured('http://localhost:3000/observe/app-id')).toBe(true);
  });
  it('rejects the SDK fallback and missing or malformed endpoints', () => {
    for (const endpoint of [
      undefined,
      null,
      '',
      'invalid',
      'https://o.expo.dev',
      'https://o.expo.dev/observe/app-id',
      'https://ota.boardsesh.com/manifest',
      'http://ota.boardsesh.com/observe/app-id',
      'https://user:password@ota.boardsesh.com/observe/app-id',
    ])
      expect(isFirstPartyObserveEndpointConfigured(endpoint)).toBe(false);
  });
});
