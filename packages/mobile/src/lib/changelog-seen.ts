// "What's New" unseen-badge persistence. Stores the ISO `mergedAt` of the newest
// changelog entry the user has viewed (set when the changelog screen mounts) in
// SecureStore via the shared key-value adapter — the same backing store as the
// theme / onboarding preferences. The More tab compares the bundled changelog's
// latest entry against this marker to decide whether to show a "New" pill.

import { CHANGELOG_LAST_SEEN_KEY } from '@boardsesh/key-value-storage';
import { secureStorePreferences } from './preferences/secure-store-adapter';

/**
 * The `mergedAt` of the newest changelog entry the user has already seen, or
 * `null` if they've never opened the changelog. Returns `null` on a read error
 * (SecureStore unavailable) — a falsely-shown "New" pill is harmless, whereas
 * suppressing it on every flaky read would hide genuinely new entries.
 */
export async function getLastSeenChangelogDate(): Promise<string | null> {
  try {
    return await secureStorePreferences.get<string>(CHANGELOG_LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Mark the changelog as seen up to (and including) `date` — the newest entry's
 * `mergedAt`. Called fire-and-forget when the changelog screen mounts.
 */
export async function markChangelogSeen(date: string): Promise<void> {
  await secureStorePreferences.set(CHANGELOG_LAST_SEEN_KEY, date);
}

/**
 * Pure: whether there is an unseen changelog entry. Unseen when a latest entry
 * exists and it is strictly newer than what the user last saw (or they've never
 * opened the changelog). Compares ISO strings lexicographically, which is a
 * correct chronological order for the UTC ISO-8601 timestamps the generator emits.
 *
 * Screenshot mode reports "nothing new" so a captured store screen never shows
 * the pill (folds to a dead branch and strips in normal builds).
 */
export function hasUnseenChangelog(latestDate: string | null, lastSeen: string | null): boolean {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  if (!latestDate) return false;
  if (!lastSeen) return true;
  return latestDate > lastSeen;
}
