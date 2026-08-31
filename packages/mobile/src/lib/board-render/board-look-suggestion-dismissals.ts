import { getPreference, removePreference, setPreference } from '../preference-store';
import type { BoardLookSuggestionId } from './board-look-suggestions';

/**
 * Which board-look suggestions this device has been offered and turned down.
 *
 * Deliberately in AsyncStorage, NOT SecureStore, for the same reason
 * `board-look-step-seen.ts` is: on iOS the keychain SURVIVES an uninstall while
 * the app sandbox does not, so a dismissal kept there would outlive the setting
 * it refers to. Reinstall, get `boardRenderSettings` back to `default`, and
 * carry a permanent "never suggest Max contrast" flag for a look you no longer
 * have. Same store as the thing it talks about, same lifecycle, no skew.
 *
 * Error posture is copied from `hasSeenBoardLookStep` exactly: a read error
 * reports DISMISSED, and screenshot mode reports DISMISSED. A flaky store or a
 * screenshot run can never produce a banner.
 */
const STORAGE_KEY = 'boardLookSuggestionDismissals';

export type BoardLookSuggestionDismissals = Record<BoardLookSuggestionId, boolean>;

/** Nothing turned down yet — the shape a fresh install loads. */
export const NO_BOARD_LOOK_SUGGESTIONS_DISMISSED: BoardLookSuggestionDismissals = Object.freeze({
  increaseContrast: false,
  grayscale: false,
});

/** Everything turned down — the shape a read error or a screenshot run reports. */
export const ALL_BOARD_LOOK_SUGGESTIONS_DISMISSED: BoardLookSuggestionDismissals = Object.freeze({
  increaseContrast: true,
  grayscale: true,
});

function sanitize(raw: Partial<Record<BoardLookSuggestionId, unknown>> | null): BoardLookSuggestionDismissals {
  return {
    increaseContrast: raw?.increaseContrast === true,
    grayscale: raw?.grayscale === true,
  };
}

export async function loadBoardLookSuggestionDismissals(): Promise<BoardLookSuggestionDismissals> {
  // A captured screen must never carry a suggestion banner, mirroring
  // `hasSeenBoardLookStep`.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return ALL_BOARD_LOOK_SUGGESTIONS_DISMISSED;
  try {
    return sanitize(await getPreference<Partial<Record<BoardLookSuggestionId, unknown>>>(STORAGE_KEY));
  } catch {
    // Fail towards silence: a store that cannot be read must not turn a
    // once-dismissed suggestion into one that returns on every cold start.
    return ALL_BOARD_LOOK_SUGGESTIONS_DISMISSED;
  }
}

/**
 * Record a suggestion as turned down. Called both when the climber dismisses it
 * and when they APPLY it — an applied suggestion is answered, so it can never
 * come back.
 */
export async function dismissBoardLookSuggestion(id: BoardLookSuggestionId): Promise<void> {
  let stored: BoardLookSuggestionDismissals = NO_BOARD_LOOK_SUGGESTIONS_DISMISSED;
  try {
    stored = sanitize(await getPreference<Partial<Record<BoardLookSuggestionId, unknown>>>(STORAGE_KEY));
  } catch {
    // An unreadable store still gets the write: losing the OTHER suggestion's
    // dismissal would at worst re-offer it once, which beats dropping this one.
  }
  const next: BoardLookSuggestionDismissals = { ...stored };
  next[id] = true;
  await setPreference<BoardLookSuggestionDismissals>(STORAGE_KEY, next);
}

export async function clearBoardLookSuggestionDismissals(): Promise<void> {
  await removePreference(STORAGE_KEY);
}
