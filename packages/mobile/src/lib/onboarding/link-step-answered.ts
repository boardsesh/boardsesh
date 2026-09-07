import { getPreference, removePreference, setPreference } from '../preference-store';

/**
 * Whether this climber has answered the first-run "link your board account" step.
 *
 * Deliberately in AsyncStorage, NOT SecureStore, following the rule
 * `board-look-step-seen.ts` spells out: a marker belongs in the same store, with
 * the same lifecycle, as the thing it records. On iOS the keychain SURVIVES an
 * uninstall while the app sandbox does not, so a SecureStore marker here would
 * outlive every other trace of the account — a climber who reinstalled, still
 * hadn't linked, and now had an empty logbook would never be asked again.
 * Re-asking after a reinstall is the right failure; silently never asking is not.
 *
 * Note this is only the anti-nag marker. The real question — "is an account
 * linked?" — is answered server-side by the credentials read, so a climber who
 * says "not now" here and links later in Settings is never re-prompted regardless
 * of this flag.
 */
const STORAGE_KEY = 'onboardingLinkStepAnswered';

/**
 * Errors read as "answered", matching `hasSeenTip` and `hasSeenBoardLookStep`: a
 * flaky store must not turn a one-shot question into one that fires on every cold
 * start.
 */
export async function hasAnsweredLinkStep(): Promise<boolean> {
  // Screenshot mode reports answered so a captured store screen is never covered.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return true;
  try {
    return (await getPreference<boolean>(STORAGE_KEY)) === true;
  } catch {
    return true;
  }
}

/**
 * Written when the climber ANSWERS — both "link" and "not now" — never on arrival.
 * "Asked but walked away" must stay indistinguishable from "never asked", so a
 * force-quit mid-step leaves the question live for the next launch rather than
 * burning it in silence. Same contract as `markBoardLookStepSeen`.
 */
export async function markLinkStepAnswered(): Promise<void> {
  await setPreference(STORAGE_KEY, true);
}

export async function clearLinkStepAnswered(): Promise<void> {
  await removePreference(STORAGE_KEY);
}
