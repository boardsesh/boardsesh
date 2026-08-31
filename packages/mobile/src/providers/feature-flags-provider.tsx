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
// Multivariate flags (a `variants` list on the definition, e.g.
// `board-glow-falloff`) resolve to one of their declared variant
// strings rather than a boolean — read those with `useFeatureFlagVariant`,
// which additionally narrows away anything outside the declared set.

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
    key: 'offline-discovery-nudges',
    label: 'Offline discovery nudges',
    description:
      "Suggest taking a board offline: the post-session prompt, the no-signal empty states, the board-card download glyph and the What's New spotlight.",
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
    key: 'moonboard-wide-angles',
    label: 'MoonBoard wide angles',
    description:
      'Offer the full 0-70° MoonBoard angle range (matching Kilter/Tension) in angle pickers instead of just the 25°/40° Moon Climbing grades. Nothing server-side enforces the narrow range, so this is purely a UI rollout control.',
  },
  {
    key: 'board-glow-falloff',
    label: 'Boardsesh glow falloff',
    variants: ['soft', 'plateau'],
    description:
      "The Boardsesh drawing's glow-falloff A/B: soft (smooth radial fade) vs plateau (full alpha held over a share of the reach, then fading). Only reaches climbers actually on the Boardsesh drawing. A climber's own Settings choice always wins over this. Unresolved reads as soft.",
  },
] as const satisfies readonly FeatureFlagDefinition[];

// The literal key union (e.g. `'strava-integration'`), preserved via the
// `as const` above so a typo in a catalog key is a compile error instead of
// silently widening to `string`.
export type FeatureFlagKey = (typeof FEATURE_FLAG_DEFINITIONS)[number]['key'];

/** The catalog entries that declare `variants` — i.e. the multivariate flags. */
type VariantFeatureFlagDefinition = Extract<(typeof FEATURE_FLAG_DEFINITIONS)[number], { variants: readonly string[] }>;

/** Just the multivariate flags' keys (`'board-glow-falloff' | ...`). */
export type VariantFeatureFlagKey = VariantFeatureFlagDefinition['key'];

/** The exact variant strings one multivariate flag declares in the catalog. */
export type FeatureFlagVariant<K extends VariantFeatureFlagKey> = Extract<
  VariantFeatureFlagDefinition,
  { key: K }
>['variants'][number];

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
 * Read a multivariate flag, narrowed to one of its declared variants.
 *
 * Both the key AND the variant set come from the catalog above: `key` is
 * restricted to the flags that actually declare `variants` (a typo, or reading
 * a plain boolean flag through here, is a compile error), and `variants` is
 * restricted to that one flag's own strings — so a call site cannot quietly
 * accept a set the catalog disagrees with and then never match a live value.
 *
 * Returns `undefined` — never a boolean, never an arbitrary string — whenever
 * the resolved value isn't a member of `variants`: unresolved (PostHog hasn't
 * answered, or the flag doesn't exist), a stale boolean from before the flag
 * became multivariate, or a variant this build doesn't know about. Every one
 * of those must read as "fall back to the shipped default", the same
 * unresolved-means-default contract every other flag in this file follows.
 */
export function useFeatureFlagVariant<K extends VariantFeatureFlagKey>(
  key: K,
  variants: readonly FeatureFlagVariant<K>[],
): FeatureFlagVariant<K> | undefined {
  const value = useFeatureFlags()[key];
  // `find` rather than `includes` + a cast: it returns the declared variant
  // type directly, so narrowing a live `string` to this flag's own union needs
  // no assertion at all.
  return typeof value === 'string' ? variants.find((variant) => variant === value) : undefined;
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
 * Gate for the offline discovery nudges (issue #4318). Missing/undefined reads
 * as OFF so this ramps from zero — nudging users into a download before the
 * download itself is fast burns the one first impression they get.
 *
 * Callers still pair this with `useOfflineDownloadsEnabled()` for the native vs
 * Expo web platform split.
 */
export function useOfflineNudgesEnabled(): boolean {
  return useFeatureFlag('offline-discovery-nudges') === true;
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
