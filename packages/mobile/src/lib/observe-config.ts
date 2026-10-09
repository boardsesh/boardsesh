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
// The router supplies normalized route names, but its params and resolved URL
// otherwise include account/resource identifiers and auth links. The public
// filter removes these params and hides the resolved URL whenever one occurs.
export const OBSERVE_FILTERED_ROUTE_PARAMS = [
  'userId',
  'username',
  'email',
  'token',
  'code',
  'sessionId',
  'resourceId',
  'entityId',
  'boardUuid',
  'board_slug',
  'gymUuid',
  'wallUuid',
  'wall',
  'climbUuid',
  'climb_segment',
  'playlist_uuid',
  'link',
  'returnTo',
  'origin',
  'resetOf',
  'reviewCandidate',
  'versionId',
  'board_name',
  'layout_id',
  'size_id',
  'set_ids',
  'angle',
  'type',
];
export const OBSERVE_INTEGRATIONS: ObserveIntegrationsConfig = {
  'expo-router': { filteredParams: OBSERVE_FILTERED_ROUTE_PARAMS },
};

/**
 * First-party performance diagnostics are independent of product analytics.
 * Record startup metrics immediately; dispatch waits for the functional flags.
 */
export const OBSERVE_DEFAULT_SAMPLE_RATE = 1;
export const OBSERVE_DEFAULT_DISPATCHING_ENABLED = false;

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
 * Once flags resolve, only an explicit false (boolean or variant) disables
 * first-party diagnostics. The startup configuration separately waits for flags.
 */
export function resolveObserveDispatchEnabled(raw: unknown): boolean {
  return raw !== false && raw !== 'false';
}

/** Permit JS dispatch only for an explicit first-party endpoint in app configuration. */
export function isFirstPartyObserveEndpointConfigured(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  try {
    const endpoint = new URL(candidate);
    return (
      (endpoint.protocol === 'https:' ||
        (endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) &&
      endpoint.hostname !== 'expo.dev' &&
      !endpoint.hostname.endsWith('.expo.dev') &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      /^\/observe\/[A-Za-z0-9_-]+\/?$/.test(endpoint.pathname)
    );
  } catch {
    return false;
  }
}
