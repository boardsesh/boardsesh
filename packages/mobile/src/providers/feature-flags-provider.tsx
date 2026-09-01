// FeatureFlagsProvider — mirrors `packages/web/app/components/providers/feature-flags-provider.tsx`.
// Mobile reads live PostHog flags when the SDK is available, accepts an
// optional `flags` prop as a local/dev/emergency override, and falls back to an
// empty bag.
//
// Typed as `Record<string, boolean | string | undefined>` (vs web's old
// `Record<string, never>` which made `useFeatureFlag` resolve to `never` and
// was therefore unusable). Consumers can call
// `useFeatureFlag('foo')` and get a `boolean | string` back; the live value is
// undefined when PostHog has no value.
//
// A definition may still declare `variants` — the tester-only Feature Flags
// screen renders those as a select instead of On/Off, and `readPosthogFeatureFlags`
// keeps a declared variant string verbatim. `observe-sample-rate` is the one
// the app reads today (see use-observe-runtime-config.ts); the two before it
// (`board-render-mode-default`, `board-glow-falloff`) were retired for 2.4, when
// the board drawing and its glow falloff became plain user settings rather than
// rollout controls — which is when the `variants` property itself was dropped
// from the definition type and had to be restored here.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readPosthogFeatureFlags, subscribePosthogFeatureFlags } from '../lib/analytics';
import { useFeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { isOfflineDownloadsEnabled } from './offline-downloads-enabled';

export type FeatureFlags = Record<string, boolean | string | undefined>;

const DEFAULT_FEATURE_FLAGS: FeatureFlags = {};
// The catalog of flags the app knows about. It drives the live PostHog read and
// the tester-only Feature Flags settings screen (which lists every entry here).
// Add a flag once, here, and it shows up in both. Labels/descriptions are
// tester-facing English only — this never reaches a non-tester surface.
export type FeatureFlagDefinition = {
  key: string;
  label: string;
  description: string;
  /**
   * Declares this a multivariate flag: PostHog resolves it to one of these
   * strings (or nothing, when unresolved) instead of a boolean. Omit for a
   * plain on/off flag.
   */
  variants?: readonly string[];
};

export const FEATURE_FLAG_DEFINITIONS = [
  {
    key: 'strava-integration',
    label: 'Strava integration',
    description: 'Share sends to Strava and the Strava connect option in Integrations.',
  },
  {
    key: 'logbook-filters',
    label: 'Logbook filters',
    description: 'Search box and filter sheet on the logbook (shipped: 100% rollout since 2026-07-03).',
  },
  {
    key: 'kilter-oauth-linking',
    label: 'Kilter account linking',
    description: 'Show the Kilter username/password sign-in card in Integrations.',
  },
  {
    key: 'logbook-grouping-kill',
    label: 'Disable logbook grouping',
    description: 'Emergency kill switch: fall back to flat logbook entries if day-scoped repeat grouping misbehaves.',
  },
  {
    key: 'garmin-watch',
    label: 'Garmin watch',
    description: 'Show the "Pair a Garmin watch" row in More. Off until the Connect IQ watch app ships.',
  },
  {
    key: 'boardsesh-grade',
    label: 'Boardsesh grade',
    description:
      'Show the data-science "Boardsesh grade" section in the play drawer (cross-board grade, confidence tier, send counts). Off hides the section.',
  },
  {
    key: 'anonymous-climb-view-kill',
    label: 'Disable the anonymous climb view',
    description:
      'Emergency kill switch: send signed-out visitors on app.boardsesh.com climb URLs back to the login wall instead of rendering the read-only climb. Web export only — native never serves those routes signed-out.',
  },
  {
    key: 'observe-dispatch-enabled',
    label: 'Observe telemetry dispatch',
    description:
      'Emergency kill switch for expo-observe. Off stops the app dispatching metrics, logs and error reports to updates.boardsesh.com; pending ones are marked sent and discarded. Manifest polling and OTA updates are unaffected.',
  },
  {
    key: 'observe-sample-rate',
    label: 'Observe sample rate',
    description:
      'Fraction of installations that dispatch Observe telemetry. Deterministic per install, so the sampled cohort is stable across launches. Ships at 1 (everyone); lower it here if ClickHouse volume needs cutting without a store release.',
    variants: ['1', '0.5', '0.25', '0.1', '0'],
  },
  {
    key: 'moonboard-wide-angles',
    label: 'MoonBoard wide angles',
    description:
      'Offer the full 0-70° MoonBoard angle range (matching Kilter/Tension) in angle pickers instead of just the 25°/40° Moon Climbing grades. Nothing server-side enforces the narrow range, so this is purely a UI rollout control.',
  },
] as const satisfies readonly FeatureFlagDefinition[];

// The literal key union (e.g. `'strava-integration'`), preserved via the
// `as const` above so a typo in a catalog key is a compile error instead of
// silently widening to `string`.
export type FeatureFlagKey = (typeof FEATURE_FLAG_DEFINITIONS)[number]['key'];

const FeatureFlagsContext = createContext<FeatureFlags>(DEFAULT_FEATURE_FLAGS);

export function FeatureFlagsProvider({
  flags = DEFAULT_FEATURE_FLAGS,
  children,
}: {
  flags?: FeatureFlags;
  children: ReactNode;
}) {
  const [posthogFlags, setPosthogFlags] = useState<FeatureFlags>(DEFAULT_FEATURE_FLAGS);
  const { overrides } = useFeatureFlagOverrides();

  useEffect(() => {
    let mounted = true;
    const refreshFlags = () => {
      const nextFlags = readPosthogFeatureFlags(FEATURE_FLAG_DEFINITIONS);
      if (!mounted) return;
      setPosthogFlags((previousFlags) => (featureFlagsEqual(previousFlags, nextFlags) ? previousFlags : nextFlags));
    };

    refreshFlags();
    const unsubscribe = subscribePosthogFeatureFlags(refreshFlags);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<FeatureFlags>(() => {
    const hasOverrides = Object.keys(overrides).length > 0;
    if (posthogFlags === DEFAULT_FEATURE_FLAGS && flags === DEFAULT_FEATURE_FLAGS && !hasOverrides) {
      return DEFAULT_FEATURE_FLAGS;
    }
    // Local tester overrides win over the static env override, which wins over
    // the live PostHog value.
    return { ...posthogFlags, ...flags, ...overrides };
  }, [posthogFlags, flags, overrides]);

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}

export function useFeatureFlag<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
  return useFeatureFlags()[key];
}
/**
 * Mobile offline mode is a shipped capability, not a remotely gated rollout.
 * The platform split remains in `isOfflineDownloadsEnabled`: native is always
 * on, while the Expo web fork stays off because it lacks the native SQLite and
 * filesystem stack.
 */
export function useOfflineDownloadsEnabled(): boolean {
  return isOfflineDownloadsEnabled(undefined);
}

/**
 * Snapshot bootstrap is the permanent native download path. Keep this exported
 * hook while call sites migrate away from rollout terminology.
 */
export function useSnapshotBootstrapEnabled(): boolean {
  return true;
}

/**
 * Real byte/percent progress is part of the permanent snapshot path. Keep this
 * exported hook until callers no longer need the compatibility seam.
 */
export function useOfflineDownloadProgressEnabled(): boolean {
  return true;
}

/**
 * Kill switch for the signed-out read-only climb view on app.boardsesh.com.
 *
 * A KILL switch rather than a positive rollout flag, and the direction matters:
 * PostHog flags resolve asynchronously, so a positive flag reads as OFF for the
 * first frames of a cold open — which on this surface means an anonymous visitor
 * watching a login redirect flash before the flag lands. Missing/undefined
 * therefore reads as "not killed", i.e. the feature is on, and flipping the flag
 * ON in PostHog restores the old login-wall behaviour.
 */
export function useAnonymousClimbViewEnabled(): boolean {
  return useFeatureFlag('anonymous-climb-view-kill') !== true;
}

/**
 * Gate for the play drawer's "Boardsesh grade" section. Missing/undefined (flags
 * not loaded yet) reads as OFF — the section stays hidden until PostHog resolves.
 */
export function useBoardseshGradeEnabled(): boolean {
  return useFeatureFlag('boardsesh-grade') === true;
}

function featureFlagsEqual(leftFlags: FeatureFlags, rightFlags: FeatureFlags): boolean {
  const leftKeys = Object.keys(leftFlags);
  const rightKeys = Object.keys(rightFlags);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => leftFlags[key] === rightFlags[key]);
}
