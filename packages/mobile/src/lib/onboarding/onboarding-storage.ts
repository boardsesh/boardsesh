// First-run onboarding flag, persisted in SecureStore via the shared key-value
// adapter (same backing store as the theme / UI-variant preferences). The flag
// is a single boolean: present-and-true means the user has seen (finished or
// skipped) the welcome walkthrough, so it never shows again. Absent means a
// fresh install — show it once.

import { ONBOARDING_BOARD_TIP_KEY, ONBOARDING_SEEN_KEY } from '@boardsesh/key-value-storage';
import { secureStorePreferences } from '../preferences/secure-store-adapter';

/**
 * Whether the user has already seen the first-run walkthrough. Returns `false`
 * on a read error (SecureStore unavailable) so a brand-new user still gets the
 * tour rather than being silently skipped past it.
 */
export async function hasSeenOnboarding(): Promise<boolean> {
  try {
    const seen = await secureStorePreferences.get<boolean>(ONBOARDING_SEEN_KEY);
    return seen === true;
  } catch {
    return false;
  }
}

/** Mark the walkthrough as seen. Called on finish or skip — never mid-tour. */
export async function markOnboardingSeen(): Promise<void> {
  await secureStorePreferences.set(ONBOARDING_SEEN_KEY, true);
}

/** Clear the flag so the walkthrough shows again. Backs the "Replay" row. */
export async function clearOnboardingSeen(): Promise<void> {
  await secureStorePreferences.remove(ONBOARDING_SEEN_KEY);
}

/**
 * Replay the walkthrough from the "Replay" row: clear the seen flag, THEN
 * navigate. The await is load-bearing — if navigation fired before the clear
 * settled, a quickly finished/skipped replay could write `markOnboardingSeen`
 * first and let a late clear wipe it, leaving the tour "unseen" and re-showing
 * on the next cold start. `navigate` is injected so this stays unit-testable
 * without Expo Router.
 */
export async function replayOnboarding(navigate: () => void): Promise<void> {
  await clearOnboardingSeen();
  navigate();
}

// --- Board-history reveal banner (Climbs) -------------------------------------
// A one-shot flag set when the user binds their first board from the onboarding
// handoff, so the Climbs landing can surface the board-history reveal banner
// exactly once. Read errors fall to `false` (no banner) — a missed banner is far
// less bad than a stuck one.

/** Arm the Climbs reveal banner (called on board-bind from onboarding). */
export async function setBoardRevealTipPending(): Promise<void> {
  await secureStorePreferences.set(ONBOARDING_BOARD_TIP_KEY, true);
}

/** Whether the Climbs reveal banner is still pending. */
export async function hasBoardRevealTipPending(): Promise<boolean> {
  try {
    return (await secureStorePreferences.get<boolean>(ONBOARDING_BOARD_TIP_KEY)) === true;
  } catch {
    return false;
  }
}

/** Clear the Climbs reveal banner flag once it has been shown or dismissed. */
export async function clearBoardRevealTipPending(): Promise<void> {
  await secureStorePreferences.remove(ONBOARDING_BOARD_TIP_KEY);
}

// --- Just-in-time feature tips ------------------------------------------------
// Generic "seen once" flags for the contextual tips (workout / crew / record),
// keyed by the per-tip constants in `@boardsesh/key-value-storage`. A read error
// reports "seen" so a flaky SecureStore never nags the same tip repeatedly.

/** Whether a one-shot just-in-time tip has already been shown. */
export async function hasSeenTip(key: string): Promise<boolean> {
  // Screenshot mode: report every just-in-time tip as already seen so an
  // onboarding banner (accessory bar / progress / workout / crew) never overlays
  // a captured store screen. A fresh screenshot install would otherwise fire them
  // on the first shot. Folds to a dead branch (and strips) in normal builds.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return true;
  try {
    return (await secureStorePreferences.get<boolean>(key)) === true;
  } catch {
    return true;
  }
}

/** Mark a one-shot just-in-time tip as shown so it never fires again. */
export async function markTipSeen(key: string): Promise<void> {
  await secureStorePreferences.set(key, true);
}
