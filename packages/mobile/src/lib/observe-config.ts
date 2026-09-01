import type { ObserveConfig, ObserveIntegrationsConfig } from 'expo-observe';
import { resolveAppEnvironment } from './app-environment';

/**
 * Pure config for expo-observe. Type-only import of the SDK, so this module —
 * and everything that reads it — stays out of the Expo runtime's module graph
 * and importable from the node-env test runner. `observe-bootstrap.ts` is the
 * one place that pulls the real SDK in.
 */

/**
 * The integrations config, defined once as a module constant.
 *
 * `useObserveForRouter` asserts the initialized value never changes for the
 * lifetime of a screen and throws when it does, so every `configure` call — the
 * one at startup and every later one from the feature flags — must pass this
 * same value. Handing back a fresh object literal each time is exactly the bug
 * that assertion exists to catch.
 */
export const OBSERVE_INTEGRATIONS: ObserveIntegrationsConfig = { 'expo-router': true };

/**
 * Shipped defaults, in force until PostHog resolves the flags.
 *
 * Full sampling: the store fleet is the population we want, and the rate can be
 * dialled back from PostHog without a build if the volume proves too high.
 * `docs/railway.md` records the measured growth this trades against.
 */
export const OBSERVE_DEFAULT_SAMPLE_RATE = 1;
export const OBSERVE_DEFAULT_DISPATCHING_ENABLED = true;

export type ObserveRuntimeOverrides = {
  dispatchingEnabled?: boolean;
  sampleRate?: number;
};

/** Build the full config, so startup and the runtime re-apply can't drift. */
export function buildObserveConfig(overrides: ObserveRuntimeOverrides = {}): ObserveConfig {
  return {
    environment: resolveAppEnvironment(),
    // Debug builds mark metrics as sent without dispatching. Left at the
    // default so a Metro dev session never writes into production ClickHouse.
    dispatchInDebug: false,
    dispatchingEnabled: overrides.dispatchingEnabled ?? OBSERVE_DEFAULT_DISPATCHING_ENABLED,
    sampleRate: overrides.sampleRate ?? OBSERVE_DEFAULT_SAMPLE_RATE,
    integrations: OBSERVE_INTEGRATIONS,
  };
}

/**
 * Read a sample rate out of a multivariate flag value.
 *
 * PostHog hands back a string (or nothing at all before it resolves), so this
 * has to survive a typo in the dashboard: anything unparseable or outside
 * [0, 1] falls back to the shipped default rather than reaching the SDK as NaN
 * and silently disabling collection for everyone.
 */
export function parseObserveSampleRate(raw: unknown): number {
  if (typeof raw === 'number') return clampSampleRate(raw);
  if (typeof raw !== 'string') return OBSERVE_DEFAULT_SAMPLE_RATE;

  return clampSampleRate(Number.parseFloat(raw.trim()));
}

function clampSampleRate(value: number): number {
  if (!Number.isFinite(value)) return OBSERVE_DEFAULT_SAMPLE_RATE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Resolve the dispatch flag.
 *
 * Only an explicit off disables dispatch: PostHog leaves a flag `undefined`
 * until it resolves, and a device that never reaches PostHog would otherwise
 * stop reporting permanently — the failure mode docs/feature-flags.md calls out.
 *
 * The string `'false'` counts as off too. A boolean flag resolves to a real
 * boolean, but the same key typed as a multivariate flag in the dashboard would
 * arrive as a string, and a kill switch that silently ignores someone typing
 * "false" into it is the wrong way round for a kill switch to fail.
 */
export function resolveObserveDispatchEnabled(raw: unknown): boolean {
  // `null` alongside `undefined` for the same reason parseObserveSampleRate
  // takes both: the flag bag never holds one today, and the two must not drift
  // apart if the shipped default ever flips to off.
  if (raw === undefined || raw === null) return OBSERVE_DEFAULT_DISPATCHING_ENABLED;
  if (raw === false || raw === 'false') return false;
  return true;
}
