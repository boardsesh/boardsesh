/**
 * After Put on board, keep lighting (2.7, preview-first lighting): what a press
 * on Put on board does once its climb is up. Settings › Board holds the two
 * choices, one for every board and one for MoonBoards, plus whether it applies
 * in a crew session.
 *
 * - `off` — the press lights that one climb. The next pick is a preview.
 * - `30` / `45` / `60` — a keep-lighting window: every pick for that many
 *   seconds lights, and each climb that lights restarts the clock.
 * - `until_stopped` — an open-ended drive, the frost: every pick lights until
 *   the climber taps the button or the link drops. The MoonBoard default, since
 *   most MoonBoard controllers don't like phones switching.
 *
 * Pure, so the Settings model, the board control and the drive store read the
 * same rule.
 */

export const KEEP_LIGHTING_CHOICES = ['off', '30', '45', '60', 'until_stopped'] as const;

export type KeepLightingChoice = (typeof KEEP_LIGHTING_CHOICES)[number];

/** Settings › Board's keep-lighting keys. */
export type KeepLightingSettingKey = 'putOnBoardKeepsLighting' | 'moonboardPutOnBoardKeepsLighting';

export const DEFAULT_KEEP_LIGHTING: KeepLightingChoice = '45';
export const DEFAULT_MOONBOARD_KEEP_LIGHTING: KeepLightingChoice = 'until_stopped';

/** A stored value this build doesn't know (an older or newer bundle wrote it) reads as the default. */
export function sanitiseKeepLighting(value: unknown, fallback: KeepLightingChoice): KeepLightingChoice {
  return typeof value === 'string' && (KEEP_LIGHTING_CHOICES as readonly string[]).includes(value)
    ? (value as KeepLightingChoice)
    : fallback;
}

/**
 * How long a window lasts: milliseconds for a timed choice, `null` for Until I
 * stop (no end), `undefined` for Off (no window at all).
 */
export function keepLightingWindowMs(choice: KeepLightingChoice): number | null | undefined {
  switch (choice) {
    case 'off':
      return undefined;
    case 'until_stopped':
      return null;
    case '30':
      return 30_000;
    case '45':
      return 45_000;
    case '60':
      return 60_000;
  }
}

/**
 * The longest a choice keeps lighting, in seconds: 0 for Off, Infinity for
 * Until I stop. For the Bluetooth footer that says auto-disconnect cuts it short.
 */
export function keepLightingSeconds(choice: KeepLightingChoice): number {
  const windowMs = keepLightingWindowMs(choice);
  if (windowMs === undefined) return 0;
  if (windowMs === null) return Number.POSITIVE_INFINITY;
  return windowMs / 1000;
}

/**
 * What Put on board keeps lighting once its climb is up: a window of
 * `windowMs`, or (`windowMs` null) an open-ended drive. `setting` names the
 * choice it came from, so the drive store can end the window when that choice
 * is turned off.
 */
export type KeepLightingPlan = { windowMs: number | null; setting: KeepLightingSettingKey };

/**
 * The plan for one press, or null for one-climb lighting.
 *
 * A MoonBoard takes its own choice, which applies in a crew session too: its
 * controllers don't like phones switching, so the phone that put the climb up
 * keeps the board. Every other board takes the general choice, and in a crew
 * session only while "In a session too" is on.
 */
export function resolveKeepLightingPlan({
  boardIsMoonboard,
  keepLighting,
  moonboardKeepLighting,
  drivesInSession,
  inSession,
}: {
  boardIsMoonboard: boolean;
  keepLighting: KeepLightingChoice;
  moonboardKeepLighting: KeepLightingChoice;
  /** Settings › Board's "In a session too". */
  drivesInSession: boolean;
  /**
   * A crew is in this session (the roster's `useIsCrewSession`). The press and
   * `DriveModeWatcher` both read it, so a window never starts where the watcher
   * would end it.
   */
  inSession: boolean;
}): KeepLightingPlan | null {
  if (boardIsMoonboard) {
    const windowMs = keepLightingWindowMs(moonboardKeepLighting);
    return windowMs === undefined ? null : { windowMs, setting: 'moonboardPutOnBoardKeepsLighting' };
  }
  if (inSession && !drivesInSession) return null;
  const windowMs = keepLightingWindowMs(keepLighting);
  return windowMs === undefined ? null : { windowMs, setting: 'putOnBoardKeepsLighting' };
}

/**
 * Whether a Lock Screen, Dynamic Island or Android notification Next /
 * Previous keeps lighting the way Put on board would (2.7). Not with the swipe
 * flag (keep-lighting's kill switch) off, and not solo with Light the board as
 * I swipe on: every pick lights there already, and a press in the app only
 * drops a stop (`wall-control.ts`).
 */
export function lockScreenPressKeepsLighting({
  swipeToDriveEnabled,
  lightOnSwipe,
  inSession,
}: {
  swipeToDriveEnabled: boolean;
  lightOnSwipe: boolean;
  /** A crew is in this session (the roster's `useIsCrewSession`). */
  inSession: boolean;
}): boolean {
  return swipeToDriveEnabled && !(lightOnSwipe && !inSession);
}
