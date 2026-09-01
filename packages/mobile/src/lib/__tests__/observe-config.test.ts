import { describe, expect, it } from 'vitest';
import {
  OBSERVE_DEFAULT_SAMPLE_RATE,
  OBSERVE_INTEGRATIONS,
  buildObserveConfig,
  parseObserveSampleRate,
  resolveObserveDispatchEnabled,
} from '../observe-config';

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
  it('treats an unresolved flag as the shipped default, not as off', () => {
    // A device that never reaches PostHog must keep reporting rather than go
    // permanently quiet — the failure mode docs/feature-flags.md calls out.
    expect(resolveObserveDispatchEnabled(undefined)).toBe(true);
  });

  it('disables only on an explicit false', () => {
    expect(resolveObserveDispatchEnabled(false)).toBe(false);
    expect(resolveObserveDispatchEnabled(true)).toBe(true);
  });

  it('treats a stray string as enabled rather than silently disabling', () => {
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
    expect(config.sampleRate).toBe(OBSERVE_DEFAULT_SAMPLE_RATE);
    expect(config.dispatchingEnabled).toBe(true);
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
    expect(OBSERVE_INTEGRATIONS['expo-router']).toBe(true);
  });
});
