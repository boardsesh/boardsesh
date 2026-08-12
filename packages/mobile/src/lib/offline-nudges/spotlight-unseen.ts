// Whether the What's New row deserves its "New" pill because of the offline
// spotlight, independently of whether the generated changelog has new entries.
//
// Without this the spotlight is unreachable: it lives inside the changelog
// screen, and a user with no unseen changelog entries has no reason to open it.

import { getSetting } from '../../settings';
import { loadNudgeState } from './nudge-storage';

/**
 * True when the offline spotlight would render if the user opened What's New:
 * they have never dismissed it and have no board offline yet.
 *
 * Screenshot mode reports false, matching `hasUnseenChangelog` — a captured
 * store screen must never show the pill.
 */
export async function hasUnseenOfflineSpotlight(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return false;
  // Already downloading something: the spotlight has nothing to tell them.
  if (getSetting('syncEnabledBoards').length > 0) return false;
  if (getSetting('autoOfflineBoards')) return false;
  const state = await loadNudgeState();
  const spotlight = state.surfaces.whats_new;
  return !spotlight.dismissedForever && spotlight.shownCount === 0;
}
