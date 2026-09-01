import { getPreference, removePreference, setPreference } from '../preference-store';

/**
 * Whether this device has been asked which board look it wants.
 *
 * Deliberately in AsyncStorage, NOT SecureStore, even though it is a one-shot
 * "seen" marker like the onboarding tips. The marker is only meaningful next to
 * the choice it records, and that choice — `boardRenderSettings` — is an
 * AsyncStorage preference. On iOS the keychain SURVIVES an uninstall while the
 * app sandbox does not, so a marker kept there would outlive the setting: a
 * climber who picked Classic, uninstalled and reinstalled would come back with
 * their mode reset to `default` (which is now the Boardsesh drawing) and a
 * surviving marker suppressing the question, silently changing their board and
 * offering no way to be asked again. Same store, same lifecycle, no skew.
 */
const STORAGE_KEY = 'boardLookStepSeen';

/**
 * Errors read as "already seen", matching `hasSeenTip`: a flaky store must not
 * turn a one-shot question into one that fires on every cold start.
 */
export async function hasSeenBoardLookStep(): Promise<boolean> {
  // Screenshot mode reports seen so a captured store screen is never covered,
  // mirroring `hasSeenTip`.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return true;
  try {
    return (await getPreference<boolean>(STORAGE_KEY)) === true;
  } catch {
    return true;
  }
}

export async function markBoardLookStepSeen(): Promise<void> {
  await setPreference(STORAGE_KEY, true);
}

export async function clearBoardLookStepSeen(): Promise<void> {
  await removePreference(STORAGE_KEY);
}
