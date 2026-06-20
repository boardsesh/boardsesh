/**
 * App-facing accessors for the "What's New" changelog screen.
 *
 * Entries come from a build-time generated JSON (scripts/generate-changelog.ts)
 * that crawls merged-PR `## Release Notes` sections and reads the native-build
 * fingerprint tags. The copy is English-only data — like the acknowledgements
 * names, it's not run through i18n; only the surrounding chrome (titles, the
 * current-build chip, category labels) is translated. The file is small and
 * bounded, so it's imported statically rather than lazily loaded.
 *
 * The pure types + timeline logic live in changelog-timeline.ts (RN-free, so it's
 * unit-testable); this shell just wires in `Platform.OS` and the static JSON.
 */
import { Platform } from 'react-native';
import data from '../data/changelog.generated.json';
import {
  composeTimeline,
  sortEntriesNewestFirst,
  type ChangelogData,
  type ChangelogEntry,
  type NativePlatform,
  type TimelineItem,
} from './changelog-timeline';

export * from './changelog-timeline';

const rawData = data as ChangelogData;

export const entries: ChangelogEntry[] = sortEntriesNewestFirst(rawData.entries);

/** The newest entry's `mergedAt`, or `null` when the changelog is empty. */
export const latestEntryDate: string | null = entries.length > 0 ? entries[0].mergedAt : null;

// Platform.OS is 'ios' | 'android' on the app (web/desktop never run this screen).
const runningPlatform: NativePlatform = Platform.OS === 'android' ? 'android' : 'ios';

/** PR entries + platform native-release markers, interleaved newest-first by date. */
export const timeline: TimelineItem[] = composeTimeline(rawData.entries, rawData.nativeReleases ?? [], runningPlatform);
