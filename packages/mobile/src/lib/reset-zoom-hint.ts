import { getPreference, removePreference, setPreference } from './preference-store';

/**
 * Whether this device has ever used the board's reset-zoom control.
 *
 * The control is a bare glyph, and a viewfinder is not an established "reset
 * zoom" idiom, so it extends to show its label while zoomed — but only until it
 * has been used once. After that the climber knows what it is and the label is
 * just something covering holds, which is the bug the whole change is about
 * (#5113).
 *
 * AsyncStorage rather than SecureStore, for the same reason as
 * `boardLookStepSeen`: this is a device-local UI marker, and on iOS the keychain
 * survives an uninstall while the app sandbox does not — a marker kept there
 * would silently suppress the hint for a reinstalled app.
 */
const STORAGE_KEY = 'resetZoomHintUsed';

/**
 * Errors read as "already used", matching `hasSeenBoardLookStep`: a flaky store
 * must not turn a one-shot hint into one that reappears on every zoom, which is
 * exactly the nagging the hint exists to avoid.
 */
export async function hasUsedResetZoom(): Promise<boolean> {
  // Screenshot mode reports used, so a captured board is never covered by the
  // extended pill. Mirrors `hasSeenBoardLookStep`.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return true;
  try {
    return (await getPreference<boolean>(STORAGE_KEY)) === true;
  } catch {
    return true;
  }
}

/**
 * Written when the control is PRESSED, never when the label merely appears.
 * Seeing the hint is not learning it — a climber who zooms, reads the label and
 * pans away still has not connected the glyph to the action.
 */
export async function markResetZoomUsed(): Promise<void> {
  await setPreference(STORAGE_KEY, true);
}

export async function clearResetZoomUsed(): Promise<void> {
  await removePreference(STORAGE_KEY);
}
