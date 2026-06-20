/**
 * Pure types + timeline logic for the "What's New" changelog, free of React Native
 * and the generated-JSON import so it's unit-testable without the RN transform (see
 * __tests__/changelog.test.ts). The app-facing shell that reads `Platform.OS` and
 * the static JSON lives in changelog.ts.
 */
import { tickTimeMs } from '@boardsesh/profile-stats';

export type ChangelogCategory = 'new' | 'improved' | 'fixed';

export type ChangelogEntry = {
  prNumber: number;
  category: ChangelogCategory;
  title: string;
  /** Optional secondary line — the remaining Release Notes copy after the title. */
  body?: string;
  /** ISO timestamp the PR merged at. */
  mergedAt: string;
  prUrl: string;
};

export type NativePlatform = 'ios' | 'android';

/**
 * A native (store) release marker — a commit where a new native fingerprint
 * shipped to the App Store / Play Store. Generated from the
 * `fingerprint-<platform>-<hash>` git tags (see scripts/generate-changelog.ts) and
 * woven into the timeline so the boundary between OTA-delivered and store-delivered
 * changes is visible. The `kind` field discriminates it from a `ChangelogEntry`.
 */
export type NativeRelease = {
  kind: 'native-release';
  /** ISO committer date of the shipping commit. */
  date: string;
  sha: string;
  platforms: NativePlatform[];
  // Required to match the generator's `NativeRelease` (scripts/lib/changelog-transform.ts),
  // which always writes it (possibly `{}`). Kept for an optional runtime-aware highlight.
  fingerprints: { ios?: string; android?: string };
};

export type ChangelogData = {
  generatedAt: string;
  entries: ChangelogEntry[];
  /** Optional so a pre-feature snapshot (no markers yet) still loads — defaults to []. */
  nativeReleases?: NativeRelease[];
};

export type TimelineItem = ChangelogEntry | NativeRelease;

// Sort key. Uses tickTimeMs (the same dayjs-backed parser the rest of the app uses)
// so an unparseable date sorts last rather than poisoning the comparison. tickTimeMs
// throws on an empty string, so guard that before calling it.
export function isoDateMs(iso: string | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const parsed = tickTimeMs(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** True for a native-release marker; narrows the union for `renderItem`/`keyExtractor`. */
export function isNativeRelease(item: TimelineItem): item is NativeRelease {
  return 'kind' in item && item.kind === 'native-release';
}

function timelineMs(item: TimelineItem): number {
  return isNativeRelease(item) ? isoDateMs(item.date) : isoDateMs(item.mergedAt);
}

/** PR entries newest-first by merge time. */
export function sortEntriesNewestFirst(prEntries: ChangelogEntry[]): ChangelogEntry[] {
  return [...prEntries].sort((a, b) => isoDateMs(b.mergedAt) - isoDateMs(a.mergedAt));
}

/**
 * Filters native-release markers to the running platform (a device only cares about
 * store builds that changed *its* binary, not the other platform's) and interleaves
 * them with the PR entries, newest-first by date.
 */
export function composeTimeline(
  prEntries: ChangelogEntry[],
  nativeReleases: NativeRelease[],
  platform: NativePlatform,
): TimelineItem[] {
  const platformReleases = nativeReleases.filter((release) => release.platforms.includes(platform));
  return [...prEntries, ...platformReleases].sort((a, b) => timelineMs(b) - timelineMs(a));
}
