// FeatureFlagsProvider — mirrors `packages/web/app/components/providers/feature-flags-provider.tsx`.
// Mobile reads live PostHog flags when the SDK is available, accepts an
// optional `flags` prop as a local/dev/emergency override, and falls back to an
// empty bag.
//
// Typed as `Record<string, boolean | undefined>` (vs web's old
// `Record<string, never>` which made `useFeatureFlag` resolve to `never` and
// was therefore unusable). Consumers can call
// `useFeatureFlag('foo')` and get a `boolean` back; the live value is
// undefined when PostHog has no value.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readPosthogFeatureFlags, subscribePosthogFeatureFlags } from '../lib/analytics';
import { useFeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { isOfflineDownloadsEnabled } from './offline-downloads-enabled';

export type FeatureFlags = Record<string, boolean | undefined>;

const DEFAULT_FEATURE_FLAGS: FeatureFlags = {};
// The catalog of flags the app knows about. It drives the live PostHog read and
// the tester-only Feature Flags settings screen (which lists every entry here).
// Add a flag once, here, and it shows up in both. Labels/descriptions are
// tester-facing English only — this never reaches a non-tester surface.
export type FeatureFlagDefinition = {
  key: string;
  label: string;
  description: string;
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
    key: 'offline-board-downloads',
    label: 'Offline board downloads',
    description:
      'The whole offline engine: board downloads, local-first climb reads, queued offline ticks/favorites, background sync. On by default — this flag is a kill switch: disable it or set it to 0% to turn the feature off (previously-queued writes still flush). Do not DELETE it; a missing flag reads as on.',
  },
  {
    // v2, deliberately a NEW PostHog key: bundles published before the
    // BOARDSESH-AA connection fix (739d92a3c) read `offline-snapshot-bootstrap`,
    // where bootstrap always failed and burned two artifact downloads per fresh
    // board. That key stays at 0% forever so broken bundles can never re-enter
    // the snapshot path; only fixed bundles know this key.
    key: 'offline-snapshot-bootstrap-v2',
    label: 'Offline snapshot bootstrap',
    description:
      'Warm a freshly-enabled board from the nightly pre-built SQLite snapshot instead of paging the whole catalog over GraphQL. Requires offline-board-downloads to also be on; off falls back to the plain paged crawl.',
  },
  {
    key: 'offline-download-progress',
    label: 'Offline download progress',
    description:
      'DEFAULT: ON — unlike every other flag here, absent/undefined means enabled. Real byte + percent progress on a downloading board instead of a static spinner. Off restores the old caption AND stops passing a progress callback to the native downloader, so it doubles as the kill switch if the progress-enabled download path ever proves slower.',
  },
  {
    key: 'offline-download-task-api',
    label: 'Offline download: DownloadTask transport',
    description:
      "Download board artifacts through expo-file-system's DownloadTask instead of downloadFileAsync. DEFAULT OFF, including unset: the new transports are the #4394 speed experiment and roll out by SETTING this flag after on-device QA, never by shipping a build. On + iOS gives a background URLSession (the only way a transfer survives suspension) unless the background-session flag below is explicitly off. Android ignores the session type and gets a different OkHttp client.",
  },
  {
    key: 'offline-download-background-session',
    label: 'Offline download: background URLSession',
    description:
      'iOS only, and only when the DownloadTask transport is on: use a background URLSession so the transfer keeps running while the app is suspended. Off pins it to a foreground session.',
  },
  {
    key: 'offline-discovery-nudges',
    label: 'Offline discovery nudges',
    description:
      "Suggest taking a board offline: the post-session prompt, the no-signal empty states, the board-card download glyph and the What's New spotlight. Requires offline-board-downloads to also be on.",
  },
  {
    key: 'boardsesh-grade',
    label: 'Boardsesh grade',
    description:
      'Show the data-science "Boardsesh grade" section in the play drawer (cross-board grade, confidence tier, send counts). Off hides the section.',
  },
] as const satisfies readonly FeatureFlagDefinition[];

// The literal key union (e.g. `'strava-integration'`), preserved via the
// `as const` above so a typo in a catalog key is a compile error instead of
// silently widening to `string`.
export type FeatureFlagKey = (typeof FEATURE_FLAG_DEFINITIONS)[number]['key'];

export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = FEATURE_FLAG_DEFINITIONS.map(
  (definition) => definition.key,
);

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
      const nextFlags = readPosthogFeatureFlags(FEATURE_FLAG_KEYS);
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
 * The one expression every offline-engine gate shares. Missing/undefined
 * (flags never loaded) deliberately reads as ON: the users PostHog can't
 * reach are the ones who opened the app with no signal, i.e. this feature's
 * audience (issue #4312). Only an explicit `false` disables it — see
 * `isOfflineDownloadsEnabled` for the full kill-switch contract.
 */
export function useOfflineDownloadsEnabled(): boolean {
  return isOfflineDownloadsEnabled(useFeatureFlag('offline-board-downloads'));
}

/**
 * Gate for the snapshot-bootstrap warm-up (offline-sync Phase 3/4): whether a
 * freshly-enabled board scope should warm from the nightly pre-built SQLite
 * artifact instead of paging the whole catalog. Missing/undefined reads as
 * OFF — deliberately still `=== true`, unlike `useOfflineDownloadsEnabled`:
 * starting a download needs connectivity, and connectivity resolves flags
 * within seconds, so the never-resolved cohort barely overlaps with the
 * fresh-download cohort. Keeping this one default-off keeps the snapshot path
 * remotely killable while #4313 (transport failures burning bootstrap
 * attempts) is open. Nested under `useOfflineDownloadsEnabled` — the nesting
 * is enforced in `useSnapshotSource`, the one place snapshot I/O is handed out.
 */
export function useSnapshotBootstrapEnabled(): boolean {
  return useFeatureFlag('offline-snapshot-bootstrap-v2') === true;
}

/**
 * Gate for real byte/percent download progress on a bootstrapping board
 * (issue #4311). DEFAULTS ON — the inverse of every other gate in this file,
 * and deliberately so: the frozen spinner is the bug, so an unresolved flag
 * must not reproduce it. Only an explicit `false` turns it off, which both
 * restores the old static caption and stops the engine passing a progress
 * callback into `File.downloadFileAsync` (that callback switches expo to a
 * different native download implementation, so this is the throughput kill
 * switch too).
 */
export function useOfflineDownloadProgressEnabled(): boolean {
  return useFeatureFlag('offline-download-progress') !== false;
}

/**
 * Gate for the offline discovery nudges (issue #4318). Missing/undefined reads
 * as OFF so this ramps from zero — nudging users into a download before the
 * download itself is fast burns the one first impression they get.
 *
 * Callers must AND this with `useOfflineDownloadsEnabled()`: a nudge for a
 * feature the kill switch has disabled is a dead end.
 */
export function useOfflineNudgesEnabled(): boolean {
  return useFeatureFlag('offline-discovery-nudges') === true;
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
