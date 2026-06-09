// First-run onboarding flag, persisted in SecureStore via the shared key-value
// adapter (same backing store as the theme / UI-variant preferences). The flag
// is a single boolean: present-and-true means the user has seen (finished or
// skipped) the welcome walkthrough, so it never shows again. Absent means a
// fresh install — show it once.

import { ONBOARDING_SEEN_KEY } from '@boardsesh/key-value-storage';
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
