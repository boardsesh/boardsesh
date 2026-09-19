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
import { useFeatureFlagOverrides, type FeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { isDevBuild } from '../lib/is-dev-build';
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
  /**
   * This flag decides something whose LEGALITY depends on where the device is,
   * not just whether a feature looks finished — so a tester must not be able to
   * force it on in a production build.
   *
   * The on-device override normally wins over PostHog, which is the whole point
   * of the tester screen. For a policy-controlled flag that is a hole: testers
   * ship on the same store binaries as everyone else, so an override travels to
   * a region where the behaviour it unlocks violates store policy, and PostHog
   * — the layer that actually knows the region — is overruled. Marking the flag
   * here makes the override apply in `__DEV__` builds only (QA still exercises
   * the path in a dev client) and be ignored in production, where PostHog stays
   * authoritative. See `donation-links` and docs/feature-flags.md.
   */
  policyControlled?: boolean;
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
    key: 'cross-angle-stats',
    label: 'Cross-angle climb stats',
    description:
      "Show climbs whose grade and sends live at a different angle, ranked on that angle's real send count and marked with it, instead of burying them under every climb set at the angle you are browsing. Woods always does this. KEEP THIS AT 0%: on a large catalogue the query loses its index-ordered early exit and costs ~0.9 s on MoonBoard and ~5.6 s on Kilter, measured on production. It is here to test the behaviour on one device, not to roll out.",
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
    key: 'shared-session-browse',
    label: 'Preview-first shared sessions',
    description:
      'In a session with 2+ climbers, swipes and climb-list taps browse instead of writing the shared queue and lighting the wall; "Put on the wall" becomes the one commit. Off = every gesture drives the wall as it always did.',
  },
  {
    key: 'moonboard-wide-angles',
    label: 'MoonBoard wide angles',
    description:
      'Offer the full 0-70° MoonBoard angle range (matching Kilter/Tension) in angle pickers instead of just the 25°/40° Moon Climbing grades. Nothing server-side enforces the narrow range, so this is purely a UI rollout control.',
  },
  {
    key: 'backend-outage-detection',
    label: 'Backend outage detection',
    description:
      'Probe /health/db when requests fail and fail fast while the server is unreachable. Kill switch: set to false.',
  },
  {
    key: 'interactive-request-deadline',
    label: 'Interactive request deadline',
    description:
      'Abort interactive GraphQL requests after 20 s so a hung server cannot pin a screen. Kill switch for marginal networks: set to false (sync keeps its own 30 s).',
  },
  {
    key: 'spray-walls',
    label: 'Spray walls',
    description:
      'The "Add a spray wall" tile on the boards picker and the /boards/spray/* routes behind it: photograph a wall, mark its corners, let the phone suggest holds, correct them, publish. A POSITIVE rollout flag — unresolved reads as off, so the tile never flickers in for the first frames of a cold open.',
  },
  {
    key: 'donation-links',
    label: 'Donation links',
    policyControlled: true,
    description:
      'POLICY-CONTROLLED: an on-device override is ignored in production builds, so this row does nothing on a store binary — PostHog decides. Turn the Acknowledgements support text into a tappable link to boardsesh.com/support. A POSITIVE rollout flag — unresolved reads as off, which renders the compliant unlinked text. An external donation link is a store-policy violation outside two narrow windows, and ONLY ONE OF THEM IS ENFORCED IN THE APP: iOS additionally requires an App Store storefront of USA, read natively, so an over-broad rollout cannot reach a non-US iPhone. Android has no such client guard — Play exposes no storefront to the app — so the PostHog targeting IS the guard, and it must be exactly: platform = Android AND country = AU AND date >= 2026-09-30. Rolling this out to Android by percentage, or to any other country, ships a policy violation.',
  },
  {
    key: 'climb-moderation-kill',
    label: 'Disable climb reporting + moderation',
    description:
      'Emergency kill switch: hides the Report climb action, the More-tab Moderation row and the community moderation status. Unresolved reads as enabled (kill switches invert the default; see docs/feature-flags.md).',
  },
] as const satisfies readonly FeatureFlagDefinition[];

// The literal key union (e.g. `'strava-integration'`), preserved via the
// `as const` above so a typo in a catalog key is a compile error instead of
// silently widening to `string`.
export type FeatureFlagKey = (typeof FEATURE_FLAG_DEFINITIONS)[number]['key'];

/** Flags whose on-device override must not survive into a production build. */
export const POLICY_CONTROLLED_FLAG_KEYS: ReadonlySet<string> = new Set(
  FEATURE_FLAG_DEFINITIONS.filter(
    (definition): definition is (typeof FEATURE_FLAG_DEFINITIONS)[number] & { policyControlled: true } =>
      'policyControlled' in definition && definition.policyControlled,
  ).map((definition) => definition.key),
);

/**
 * Drop the overrides a production build is not allowed to honour.
 *
 * Returns the SAME object when nothing is stripped — the common case, and the
 * provider's `useMemo` depends on that reference staying stable.
 */
export function applyOverridePolicy(overrides: FeatureFlagOverrides): FeatureFlagOverrides {
  // A dev client is the one place a tester is supposed to be able to force these
  // on: the binary never reaches a store, so there is no policy to violate.
  if (isDevBuild()) return overrides;
  let allowed: FeatureFlagOverrides | null = null;
  for (const key of Object.keys(overrides)) {
    if (!POLICY_CONTROLLED_FLAG_KEYS.has(key)) continue;
    allowed ??= { ...overrides };
    delete allowed[key];
  }
  return allowed ?? overrides;
}

const FeatureFlagsContext = createContext<FeatureFlags>(DEFAULT_FEATURE_FLAGS);

/**
 * Whether the live flag values have had their chance to arrive.
 *
 * Separate from the values themselves, because "off" and "not known yet" are the
 * same bag to a consumer and are very different things to a gate. A screen that
 * REDIRECTS on a flag — rather than just hiding a tile — cannot act on the empty
 * first frame: an enabled climber opening a deep link would be bounced to the
 * picker before PostHog answered, and resolving the flag a moment later cannot
 * bring the discarded route back.
 *
 * A second context rather than a field on the first, so nothing that reads flag
 * VALUES re-renders when this flips.
 */
const FeatureFlagsResolvedContext = createContext<boolean>(false);

/**
 * How long a consumer waits for PostHog before treating the bag as final.
 *
 * There has to be a ceiling. PostHog may be unreachable, disabled in this build,
 * or never initialised at all, and none of those ever fires `onFeatureFlags` —
 * so without a timeout a gated route would spin forever on exactly the fleets
 * where the flag is off anyway. Two seconds is longer than a warm flag read and
 * short enough that a cold, offline deep link is not left staring at nothing.
 */
export const FEATURE_FLAG_RESOLUTION_TIMEOUT_MS = 2000;

export function FeatureFlagsProvider({
  flags = DEFAULT_FEATURE_FLAGS,
  children,
}: {
  flags?: FeatureFlags;
  children: ReactNode;
}) {
  const [posthogFlags, setPosthogFlags] = useState<FeatureFlags>(DEFAULT_FEATURE_FLAGS);
  const [resolved, setResolved] = useState(false);
  const { overrides } = useFeatureFlagOverrides();

  useEffect(() => {
    let mounted = true;
    const refreshFlags = () => {
      const nextFlags = readPosthogFeatureFlags(FEATURE_FLAG_DEFINITIONS);
      if (!mounted) return;
      setPosthogFlags((previousFlags) => (featureFlagsEqual(previousFlags, nextFlags) ? previousFlags : nextFlags));
    };

    refreshFlags();
    const unsubscribe = subscribePosthogFeatureFlags(() => {
      refreshFlags();
      // PostHog has answered. Whatever it said, the bag is now the real one.
      if (mounted) setResolved(true);
    });
    // And the backstop, for every fleet where it never answers at all.
    const timer = setTimeout(() => {
      if (mounted) setResolved(true);
    }, FEATURE_FLAG_RESOLUTION_TIMEOUT_MS);
    return () => {
      mounted = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // A statically supplied bag — the env override, and every test — is already
  // final: there is nothing on its way that could change it.
  const hasStaticFlags = flags !== DEFAULT_FEATURE_FLAGS;

  const value = useMemo<FeatureFlags>(() => {
    // Policy-controlled flags lose their override outside a dev build, so this
    // has to happen BEFORE the empty check: on a store binary a lone
    // donation-links override leaves nothing to merge at all.
    const honouredOverrides = applyOverridePolicy(overrides);
    const hasOverrides = Object.keys(honouredOverrides).length > 0;
    if (posthogFlags === DEFAULT_FEATURE_FLAGS && flags === DEFAULT_FEATURE_FLAGS && !hasOverrides) {
      return DEFAULT_FEATURE_FLAGS;
    }
    // Local tester overrides win over the static env override, which wins over
    // the live PostHog value.
    return { ...posthogFlags, ...flags, ...honouredOverrides };
  }, [posthogFlags, flags, overrides]);

  return (
    <FeatureFlagsContext.Provider value={value}>
      <FeatureFlagsResolvedContext.Provider value={resolved || hasStaticFlags}>
        {children}
      </FeatureFlagsResolvedContext.Provider>
    </FeatureFlagsContext.Provider>
  );
}

/**
 * Whether the flag bag is final.
 *
 * Read this before acting IRREVERSIBLY on a flag — a redirect, a navigation
 * reset. A surface that merely shows or hides something does not need it: the
 * value re-renders when it lands.
 */
export function useFeatureFlagsResolved(): boolean {
  return useContext(FeatureFlagsResolvedContext);
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
 * Kill switch for community climb moderation: the "Report climb" action, the
 * More-tab Moderation row, and the community moderation status on a climb.
 *
 * A KILL switch, not a positive rollout flag, for the same reason as
 * `useAnonymousClimbViewEnabled`: PostHog resolves asynchronously, so a positive
 * flag reads as OFF for the first frames of a cold open — which here would mean
 * the Report row appearing a beat after the menu opens, under the climber's
 * thumb. Missing/undefined reads as "not killed", i.e. reporting is on, and
 * flipping the flag ON in PostHog takes the whole feature down.
 */
export function useClimbModerationEnabled(): boolean {
  return useFeatureFlag('climb-moderation-kill') !== true;
}

/**
 * Gate for the play drawer's "Boardsesh grade" section. Missing/undefined (flags
 * not loaded yet) reads as OFF — the section stays hidden until PostHog resolves.
 */
export function useBoardseshGradeEnabled(): boolean {
  return useFeatureFlag('boardsesh-grade') === true;
}

/**
 * Kill switch for backend outage detection (issue #4862). A KILL switch, and the
 * direction is the whole point: PostHog flags resolve asynchronously, so a
 * positive flag reads as OFF for the first frames of a cold open — which here
 * would mean the app spends the start of every launch unable to tell an outage
 * from a working server. Missing/undefined therefore reads as ON, and setting
 * the flag to `false` in PostHog turns the probe and the fail-fast path off
 * fleet-wide without a store release.
 *
 * Turning it off does NOT strand queued work: the drainer is never gated on
 * this, and the store keeps its device-level offline signal either way. It only
 * stops the app CONCLUDING that our server is down.
 */
export function useBackendOutageDetectionEnabled(): boolean {
  return useFeatureFlag('backend-outage-detection') !== false;
}

/**
 * The 20 s interactive GraphQL deadline (#4862). Same kill-switch shape as the
 * outage detection above — shipped on, and only an explicit `false` turns it
 * off — but a separate flag, because a device on a marginal link (3G, a gym
 * basement) can legitimately see >20 s responses while the server is healthy,
 * and the escape hatch for that must not also disable outage detection.
 */
export function useInteractiveRequestDeadlineEnabled(): boolean {
  return useFeatureFlag('interactive-request-deadline') !== false;
}

/**
 * Gate for preview-first browsing in a shared session (#4281 / #4683).
 *
 * A POSITIVE rollout flag, not a `*-kill` one, and the direction is the whole
 * point: unresolved must mean the behaviour this feature replaced. The off-state
 * here is "your swipe lights the board", which is what the app has always done
 * and what a climber standing at a wall expects — so the first frames of a cold
 * open, a PostHog outage, and a missing key all land on the safe side. Reading
 * it as a kill switch would do the opposite: it would default a whole fleet into
 * a mode where gestures stop driving the wall, which is exactly the regression
 * that took #4683 back out.
 */
export function useSharedSessionBrowseEnabled(): boolean {
  return useFeatureFlag('shared-session-browse') === true;
}

/**
 * Gate for the spray-wall front door (epic #5346, SW-09): the picker tile and
 * every `/boards/spray/*` route behind it.
 *
 * A POSITIVE rollout flag, and `=== true` is the whole contract: PostHog
 * resolves asynchronously, so anything looser (`!== false`) would show the tile
 * for the first frames of every cold open and let a deep link walk into the flow
 * on a fleet the feature is not enabled for. Unresolved, absent and explicitly
 * off all read the same — hidden — which is the only safe reading while a
 * feature is dark.
 */
export function useSprayWallsEnabled(): boolean {
  return useFeatureFlag('spray-walls') === true;
}

function featureFlagsEqual(leftFlags: FeatureFlags, rightFlags: FeatureFlags): boolean {
  const leftKeys = Object.keys(leftFlags);
  const rightKeys = Object.keys(rightFlags);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => leftFlags[key] === rightFlags[key]);
}
