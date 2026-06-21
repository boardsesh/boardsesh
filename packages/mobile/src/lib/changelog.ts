/**
 * App-facing accessors for the "What's New" changelog screen.
 *
 * Entries come from a build-time generated JSON (scripts/generate-changelog.ts)
 * that crawls merged-PR `## Release Notes` sections. The copy is English-only
 * data — like the acknowledgements names, it's not run through i18n; only the
 * surrounding chrome (titles, the current-build chip, category labels) is
 * translated. The file is small and bounded, so it's imported statically rather
 * than lazily loaded.
 */
import { tickTimeMs } from '@boardsesh/profile-stats';
import { Platform } from 'react-native';
import data from '../data/changelog.generated.json';

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
  fingerprints?: { ios?: string; android?: string };
};

export type ChangelogData = {
  generatedAt: string;
  entries: ChangelogEntry[];
  /** Optional so a pre-feature snapshot (no markers yet) still loads — defaults to []. */
  nativeReleases?: NativeRelease[];
};

const rawData = data as ChangelogData;

// The generator already emits newest-first, but sort defensively so a hand-edited
// or differently-ordered snapshot still renders reverse-chronologically. Uses
// tickTimeMs (the same dayjs-backed parser the rest of the app uses) so an
// unparseable date sorts last rather than poisoning the comparison. tickTimeMs
// throws on an empty string, so guard that before calling it.
function isoDateMs(iso: string | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const parsed = tickTimeMs(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export const entries: ChangelogEntry[] = [...rawData.entries].sort(
  (a, b) => isoDateMs(b.mergedAt) - isoDateMs(a.mergedAt),
);

/** The newest entry's `mergedAt`, or `null` when the changelog is empty. */
export const latestEntryDate: string | null = entries.length > 0 ? entries[0].mergedAt : null;

// Only show native-release markers for the running platform: a device cares about
// store builds that changed *its* binary, not the other platform's. Platform.OS is
// 'ios' | 'android' on the app (web/desktop never run this screen).
const runningPlatform: NativePlatform = Platform.OS === 'android' ? 'android' : 'ios';
const platformReleases: NativeRelease[] = (rawData.nativeReleases ?? []).filter((release) =>
  release.platforms.includes(runningPlatform),
);

export type TimelineItem = ChangelogEntry | NativeRelease;

/** True for a native-release marker; narrows the union for `renderItem`/`keyExtractor`. */
export function isNativeRelease(item: TimelineItem): item is NativeRelease {
  return 'kind' in item && item.kind === 'native-release';
}

function timelineMs(item: TimelineItem): number {
  return isNativeRelease(item) ? isoDateMs(item.date) : isoDateMs(item.mergedAt);
}

/** PR entries + platform native-release markers, interleaved newest-first by date. */
export const timeline: TimelineItem[] = [...entries, ...platformReleases].sort((a, b) => timelineMs(b) - timelineMs(a));
