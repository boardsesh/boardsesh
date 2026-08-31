import { sanitizeHoldColorOverrides, type HoldColorOverrides } from '../hold-color-overrides';
import { getPreference, removePreference, setPreference } from '../preference-store';

/**
 * The climber's own hand-picked hold colours, kept aside from the live overrides.
 *
 * Exactly the job `custom-board-look.ts` does for the render knobs, for the same
 * reason: applying a colour-vision palette overwrites all four role colours, so
 * without a copy kept aside a climber who tuned their colours, tried
 * "Deuteranopia" to compare, and came back to Custom would find their colours
 * gone — silently, with no undo. Palettes are meant to be cheap to try; that
 * only holds if trying one is reversible.
 *
 * Only a MANUAL colour edit writes here. A palette apply deliberately does not:
 * it is the same distinction the board look makes between moving a knob and
 * applying a preset, and mirroring a palette in would overwrite the very colours
 * this exists to give back.
 *
 * Stored beside `holdColorOverrides` in AsyncStorage, and sanitised on the way
 * out for the same reason the live overrides are: a map written by a newer build
 * can carry a role or a colour string this one does not understand.
 */
const STORAGE_KEY = 'holdColorCustomColors';

/** Remember this map as the climber's own colours. */
export async function rememberCustomHoldColors(colors: HoldColorOverrides): Promise<void> {
  await setPreference(STORAGE_KEY, sanitizeHoldColorOverrides(colors));
}

/**
 * The remembered colours, or `null` if they have never picked one by hand.
 *
 * `null` rather than `{}` for "nothing remembered", so a caller can tell "they
 * have no colours of their own to go back to" apart from "their own colours are
 * the board's defaults" — the second is a real state worth restoring to.
 */
export async function loadCustomHoldColors(): Promise<HoldColorOverrides | null> {
  try {
    const stored = await getPreference<unknown>(STORAGE_KEY);
    return stored ? sanitizeHoldColorOverrides(stored) : null;
  } catch {
    return null;
  }
}

export async function clearCustomHoldColors(): Promise<void> {
  await removePreference(STORAGE_KEY);
}
