import { sanitizeBoardseshRenderSettings, type BoardseshRenderSettings } from '../board-render-settings';
import { getPreference, removePreference, setPreference } from '../preference-store';

/**
 * The climber's own hand-tuned board look, kept aside from the live settings.
 *
 * Applying a preset overwrites every Boardsesh field, so without this a climber
 * who tuned a look, tried "Subtle" to compare, and came back to Custom would
 * find their tuning gone — silently, with no undo. Presets are meant to be
 * cheap to try; that only holds if trying one is reversible.
 *
 * Stored beside `boardRenderSettings` in AsyncStorage, and sanitised on the way
 * out for the same reason the live settings are: a bundle written by a newer
 * build can carry a field this one does not understand, and a NaN reach reaching
 * the Rust renderer is a config it silently falls back on.
 */
const STORAGE_KEY = 'boardLookCustomSettings';

/** Remember this bundle as the climber's custom look. */
export async function rememberCustomBoardLook(boardsesh: BoardseshRenderSettings): Promise<void> {
  await setPreference(STORAGE_KEY, boardsesh);
}

/** The remembered custom look, or `null` if they have never tuned one. */
export async function loadCustomBoardLook(): Promise<BoardseshRenderSettings | null> {
  try {
    const stored = await getPreference<unknown>(STORAGE_KEY);
    return stored ? sanitizeBoardseshRenderSettings(stored) : null;
  } catch {
    return null;
  }
}

export async function clearCustomBoardLook(): Promise<void> {
  await removePreference(STORAGE_KEY);
}
